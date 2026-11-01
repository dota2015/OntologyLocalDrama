// One projection of Director-owned state into image conditioning. No LLM repair.
const { compileImagePromptFromSlots, compileLastFramePromptFromSlots } = require('../ontology/visualSlots');

function parse(value, fallback) {
  if (value == null || value === '') return fallback;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function isStructuredShot(shot) {
  return !!shot?.semantic_slots;
}

function compileFrame(shot, scene, kind, style = '') {
  const semantic = parse(shot.semantic_slots, {});
  const last = kind === 'last';
  if (!['first', 'last'].includes(kind)) throw new Error('结构化分镜关键帧尚无独立定格规划，请使用导演规划的首帧或尾帧');
  const visuals = parse(last ? shot.last_frame_visuals : shot.character_visuals, []);
  const ids = (semantic.visible_characters || []).map(c => Number(c.id ?? c.character_id ?? c));
  if (!Array.isArray(visuals) || ids.some(id => !visuals.some(v => Number(v.character_id ?? v.id) === id))) {
    throw new Error(`${last ? '尾帧' : '首帧'}人物槽位缺失，请让导演 Agent 补全后生成`);
  }
  const backgrounds = semantic.background_characters || [];
  const visualIds = visuals.map(v => Number(v.character_id ?? v.id));
  if (visualIds.some(id => !ids.includes(id)) || new Set(visualIds).size !== visualIds.length || backgrounds.some(v => ids.includes(Number(v.id ?? v.character_id ?? v)))) {
    throw new Error('人物定格与画内人物清单冲突，请让导演 Agent 修复，未自动删减人物');
  }
  const allVisuals = [...visuals, ...backgrounds.filter(c => !visuals.some(v => Number(v.character_id ?? v.id) === Number(c.id ?? c.character_id)))];
  const resolved = { ...shot, location: shot.location || scene?.location, time: shot.time || scene?.time };
  const compiler = last ? compileLastFramePromptFromSlots : compileImagePromptFromSlots;
  return compiler(resolved, allVisuals, { style });
}

function resolveReferences(db, shot, row, looks, limits) {
  const semantic = parse(shot.semantic_slots, {});
  const refs = [];
  const key = source => String(source).replace(/^https?:\/\/[^/]+\/static\//, '').replace(/^\/static\//, '');
  const add = (source, role, name, id) => {
    if (!source) throw new Error(`参考素材缺少图片：${name || role}，请补齐后生成`);
    const existing = refs.find(r => key(r.source) === key(source));
    if (existing && role === 'character' && existing.role === 'character' && Number(existing.asset_id) !== Number(id)) {
      throw new Error(`不同人物共用同一张参考图片：${existing.name}、${name}，请确认人物引用`);
    }
    if (!existing) refs.push({ source, role, name, asset_id: id ?? null });
  };
  const tail = ['last', 'storyboard_last', 'tail', 'last_frame'].includes(row.frame_type);
  const lock = tail && row.use_first_frame_layout_lock !== 0;
  if (tail) {
    const first = shot.first_frame_image_id
      ? db.prepare('SELECT * FROM image_generations WHERE id=? AND deleted_at IS NULL').get(shot.first_frame_image_id) : null;
    add(first?.local_path || first?.image_url || shot.local_path || shot.image_url, 'first_frame', '本镜首帧', first?.id);
  }
  if (!lock) {
    for (const c of [...(semantic.visible_characters || []), ...(semantic.background_characters || [])]) {
      const id = Number(c.id ?? c.character_id ?? c);
      const character = db.prepare('SELECT * FROM characters WHERE id=? AND deleted_at IS NULL').get(id);
      if (!character) throw new Error(`参考人物 ${id} 不存在，请让导演 Agent 修复`);
      const look = looks.find(l => Number(l.id) === id);
      add(look?.reference_image || character.local_path || character.image_url, 'character', character.name, id);
    }
    if (shot.scene_id) {
      const scene = db.prepare('SELECT * FROM scenes WHERE id=? AND deleted_at IS NULL').get(shot.scene_id);
      add(scene?.local_path || scene?.image_url, 'scene', scene?.location || `场景 ${shot.scene_id}`, shot.scene_id);
    }
  }
  const props = db.prepare('SELECT sp.prop_id AS requested_id, p.* FROM storyboard_props sp LEFT JOIN props p ON sp.prop_id=p.id AND p.deleted_at IS NULL WHERE sp.storyboard_id=? ORDER BY sp.prop_id').all(shot.id);
  for (const p of props) {
    if (!p.id) throw new Error(`参考道具 ${p.requested_id} 不存在，请让导演 Agent 修复`);
    add(p.ref_image || p.local_path || p.image_url, 'prop', p.name, p.id);
  }
  for (const source of parse(row.reference_images, [])) add(source, 'reference', '指定参考');
  if (refs.length > limits.total || refs.filter(r => r.role === 'character').length > limits.maxCharacters || refs.filter(r => ['scene','prop'].includes(r.role)).length > limits.maxObjects) {
    throw new Error(`本镜需要 ${refs.length} 张参考图，超出图片模型容量；请让导演 Agent 调整引用，未自动删减`);
  }
  const label = r => r.role === 'character' ? `character appearance reference for "${r.name}"`
    : r.role === 'scene' ? `scene background reference for "${r.name}"`
    : r.role === 'prop' ? `prop reference for "${r.name}"`
    : r.role === 'first_frame' ? 'FIRST_FRAME reference; identity and established clothing' : 'supplied visual reference';
  return { refs, lock, note: refs.map((r, i) => `Image ${i + 1}: ${label(r)}`).join('\n') };
}

module.exports = { isStructuredShot, compileFrame, resolveReferences };
