const aiClient = require('./aiClient');
const { safeParseAIJSON, extractFirstArray } = require('../utils/safeJson');
const modes = new Set(['single', 'quad_grid']);

function selectedMode(row) { return modes.has(row?.reference_image_mode) ? row.reference_image_mode : 'single'; }
function validateMode(mode) {
  if (!modes.has(mode)) throw new Error('参考图模式只能是 single 或 quad_grid');
  return mode;
}
function generationMode(row, override) {
  if (override == null) return selectedMode(row);
  if ([true, 1, 'true'].includes(override)) return 'quad_grid';
  if ([false, 0, 'false'].includes(override)) return 'single';
  throw new Error('use_quad_grid 必须为布尔值');
}
function fields(row) {
  return { reference_image_mode: selectedMode(row), reference_image_recommendation: row?.reference_image_recommendation || null,
    reference_image_reason: row?.reference_image_reason || null };
}
function advice(item, kind) {
  const mode = modes.has(item?.reference_image_mode) ? item.reference_image_mode : 'single';
  const reason = typeof item?.reference_image_reason === 'string' ? item.reference_image_reason.trim().slice(0, 300) : '';
  return { mode, reason: reason || (kind === 'prop' ? '默认单图，优先保证道具细节清晰；可自行调整。' : '默认单图，可按空间布局和镜头需要调整。') };
}
function extractionInstructions(kind) {
  return `\n\n[Reference image recommendation / 参考图模式建议]
For EVERY extracted ${kind}, including reused resources, add reference_image_mode ("single" or "quad_grid") and reference_image_reason (one concise Chinese sentence explaining the choice based on this script).
Recommend single for most props, readable small items, simple objects and one-off scenes. Recommend quad_grid for recurring complex spaces needing consistent entrances/furniture/camera directions, or a complex prop whose front/back/side geometry matters to the plot. Recurring main rooms and multi-zone bases/training grounds normally benefit from quad_grid when scenes alternate between entrances, furniture and different action areas. A single-angle detail or a simple one-off storage spot normally uses single. Do not recommend quad_grid for everything. Four views divide the available image resolution.
These two recommendation fields must also be added to reused objects even if an earlier reuse format says to return just name and ID.
Keep the usual image description about the object/place itself; do not embed a grid layout there. The image generation stage applies the selected layout. Existing user choices will be preserved.`;
}
function saveAdvice(db, kind, id, item) {
  const table = kind === 'scene' ? 'scenes' : kind === 'prop' ? 'props' : null;
  if (!table) throw new Error('无效资源类型');
  const { mode, reason } = advice(item, kind);
  db.prepare(`UPDATE ${table} SET reference_image_mode = COALESCE(reference_image_mode, ?),
    reference_image_recommendation = ?, reference_image_reason = ? WHERE id = ? AND deleted_at IS NULL`).run(mode, mode, reason, id);
}
function propImagePrompt(base, mode) {
  if (mode !== 'quad_grid') return base;
  return `Create one coherent 2x2 reference sheet of the SAME prop: front view, left side view, back view, top view. Exactly four panels, one complete object per panel. Preserve identical shape, proportions, materials, colors and details across all four views. Use a plain seamless background and even studio lighting in each panel. No people, hands, captions, panel labels, extra objects or scenery. The following description specifies the object INSIDE EACH PANEL; its single-object wording applies per panel. The overall image must remain a 2x2 sheet.\n\n${base}`;
}

async function recommendEpisode(db, log, episodeId) {
  const episode = db.prepare('SELECT id,drama_id,script_content FROM episodes WHERE id=? AND deleted_at IS NULL').get(Number(episodeId));
  if (!episode) throw new Error('分集不存在');
  const scenes = require('./episodeSceneService').list(db, episode.drama_id, episode.id);
  const props = db.prepare(`SELECT DISTINCT p.* FROM props p WHERE p.drama_id=? AND p.deleted_at IS NULL AND
    (p.episode_id=? OR p.id IN (SELECT sp.prop_id FROM storyboard_props sp JOIN storyboards sb ON sb.id=sp.storyboard_id WHERE sb.episode_id=? AND sb.deleted_at IS NULL)) ORDER BY p.id`).all(episode.drama_id, episode.id, episode.id);
  const resources = [...scenes.map(r => ({kind:'scene', ...r})), ...props.map(r => ({kind:'prop', ...r}))];
  if (!resources.length) return { count: 0 };
  const context = { script: episode.script_content || '', resources: resources.map(r => ({ kind: r.kind, id: r.id, name: r.location || r.name,
    description: r.description || r.prompt || '' })) };
  const system = '你是短剧参考图规划师。只建议参考图模式，不修改剧本、资源名称、外观或图片。返回纯JSON数组，每项包含kind、id、reference_image_mode、reference_image_reason，必须完整覆盖输入资源且每项仅一次。只使用输入的kind和id。根据剧情和空间复用需求独立判断，禁止猜测或声称用户已选某个模式；人工选择由后端保存逻辑保护。'
    + extractionInstructions('scene and prop');
  const raw = await aiClient.generateText(db, log, 'text', JSON.stringify(context), system, { scene_key: 'scene_extraction', temperature: 0.2, max_tokens: Math.max(2000, resources.length * 160) });
  const results = extractFirstArray(safeParseAIJSON(raw, log));
  const expected = new Set(resources.map(r => `${r.kind}:${r.id}`));
  if (!Array.isArray(results) || results.length !== expected.size) throw new Error('AI建议未完整覆盖资源，原有设置未修改，请重试');
  for (const item of results) {
    const key = `${item.kind}:${item.id}`;
    if (!expected.delete(key) || !modes.has(item.reference_image_mode)) throw new Error('AI建议包含无效或重复资源，原有设置未修改，请重试');
  }
  db.transaction(() => {
    for (const item of results) {
      const table = item.kind === 'scene' ? 'scenes' : 'props';
      if (!db.prepare(`SELECT id FROM ${table} WHERE id=? AND drama_id=? AND deleted_at IS NULL`).get(Number(item.id), episode.drama_id)) throw new Error('资源已变化，请刷新后重试');
      saveAdvice(db, item.kind, Number(item.id), item);
    }
  })();
  return { count: results.length };
}

module.exports = { selectedMode, validateMode, generationMode, fields, advice, extractionInstructions, saveAdvice, propImagePrompt, recommendEpisode };
