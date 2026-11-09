// 分镜：create, update, delete；帧提示词 get/save
const { linkEpisodeCharacters } = require('./episodeCharacterLinks');

/**
 * 将分镜勾选的角色（dramas.characters 表 id）同步到 storyboard_characters（角色库 id），
 * 便于帧提示词与图生参考图与 UI 一致；按角色名匹配本剧或全局角色库。
 */
function parseDramaCharacterIds(charactersValue) {
  if (charactersValue === undefined || charactersValue === null) return null;
  if (Array.isArray(charactersValue)) {
    return charactersValue
      .map((x) => Number(typeof x === 'object' && x != null ? x.id : x))
      .filter((n) => Number.isFinite(n));
  }
  if (typeof charactersValue === 'string') {
    try {
      const arr = JSON.parse(charactersValue);
      if (!Array.isArray(arr)) return [];
      return arr
        .map((x) => Number(typeof x === 'object' && x != null ? x.id : x))
        .filter((n) => Number.isFinite(n));
    } catch (_) {
      return [];
    }
  }
  return [];
}

function syncStoryboardCharacterLinks(db, storyboardId, dramaCharacterIds) {
  const sid = Number(storyboardId);
  const ids = Array.isArray(dramaCharacterIds) ? dramaCharacterIds.map((n) => Number(n)).filter((n) => Number.isFinite(n)) : [];
  if (ids.length > 20) throw new Error(`单镜关联角色数量 ${ids.length} 超过 20，禁止静默截断`);
  db.prepare('DELETE FROM storyboard_characters WHERE storyboard_id = ?').run(sid);
  if (ids.length === 0) return;
  const sb = db.prepare(
    `SELECT e.drama_id FROM storyboards s JOIN episodes e ON e.id = s.episode_id WHERE s.id = ? AND s.deleted_at IS NULL`
  ).get(sid);
  const dramaId = sb?.drama_id != null ? Number(sb.drama_id) : null;
  const now = new Date().toISOString();
  const ins = db.prepare('INSERT OR IGNORE INTO storyboard_characters (storyboard_id, character_id, created_at) VALUES (?, ?, ?)');
  for (const cid of ids) {
    const crow = db.prepare('SELECT name FROM characters WHERE id = ? AND deleted_at IS NULL').get(cid);
    const name = (crow?.name || '').trim();
    if (!name) continue;
    let lib = null;
    if (dramaId) {
      lib = db.prepare(
        'SELECT id FROM character_libraries WHERE deleted_at IS NULL AND drama_id = ? AND TRIM(name) = ? LIMIT 1'
      ).get(dramaId, name);
    }
    if (!lib) {
      lib = db.prepare(
        'SELECT id FROM character_libraries WHERE deleted_at IS NULL AND drama_id IS NULL AND TRIM(name) = ? LIMIT 1'
      ).get(name);
    }
    if (lib) ins.run(sid, lib.id, now);
  }
}

function createStoryboard(db, log, req) {
  const now = new Date().toISOString();
  const episodeId = Number(req.episode_id);
  const num = Number(req.storyboard_number ?? 0) || 0;
  const charVis = req.character_visuals ? (typeof req.character_visuals === 'object' ? JSON.stringify(req.character_visuals) : req.character_visuals) : null;
  const lastVis = req.last_frame_visuals ? (typeof req.last_frame_visuals === 'object' ? JSON.stringify(req.last_frame_visuals) : req.last_frame_visuals) : null;
  const vidSlots = req.video_slots ? (typeof req.video_slots === 'object' ? JSON.stringify(req.video_slots) : req.video_slots) : null;
  const dialogueFraming = req.dialogue_framing ?? null;
  const info = db.prepare(
    `INSERT INTO storyboards (episode_id, scene_id, storyboard_number, title, description, location, time, duration, dialogue, action, result, atmosphere, image_prompt, video_prompt, dialogue_framing, character_visuals, last_frame_visuals, video_slots, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).run(
    episodeId,
    req.scene_id ?? null,
    num,
    req.title ?? null,
    req.description ?? null,
    req.location ?? null,
    req.time ?? null,
    req.duration ?? 0,
    req.dialogue ?? null,
    req.action ?? null,
    req.result ?? null,
    req.atmosphere ?? null,
    req.image_prompt ?? null,
    null,
    dialogueFraming,
    charVis,
    lastVis,
    vidSlots,
    now,
    now
  );
  log.info('Storyboard created', { id: info.lastInsertRowid, episode_id: episodeId });
  return getStoryboardById(db, info.lastInsertRowid);
}

function updateStoryboard(db, log, id, req) {
  const row = db.prepare('SELECT * FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!row) return null;
  const allowed = ['title', 'description', 'location', 'time', 'duration', 'dialogue', 'narration', 'action', 'result', 'atmosphere', 'image_prompt', 'polished_prompt', 'video_model', 'scene_id', 'characters', 'character_visuals', 'last_frame_visuals', 'video_slots', 'composed_image', 'image_url', 'local_path', 'main_panel_idx', 'video_url', 'selected_video_id', 'audio_local_path', 'narration_audio_local_path', 'status', 'shot_type', 'angle', 'angle_h', 'angle_v', 'angle_s', 'dialogue_framing', 'movement', 'lighting_style', 'depth_of_field', 'bgm_prompt', 'sound_effect', 'segment_index', 'segment_title', 'creation_mode', 'universal_segment_text', 'layout_description', 'start_framing', 'end_framing', 'transition_to_next', 'background_characters', 'continuity_snapshot', 'first_frame_image_id', 'last_frame_image_id', 'last_frame_image_url', 'last_frame_local_path', 'long_take_group_id', 'long_take_role', 'long_take_sequence'];
  if (req.video_model != null && req.video_model !== '') {
    const configs = require('./aiConfigService').listConfigs(db, 'video');
    if (!configs.some(c => c.is_active && (Array.isArray(c.model) ? c.model : [c.model]).includes(req.video_model))) throw new Error('所选视频模型未启用或已删除');
  }

  const parseSemanticSlots = (value) => {
    if (value == null || value === '') return null;
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch (_) {}
    }
    throw Object.assign(new Error('semantic_slots 必须是合法 JSON 对象'), { status: 400 });
  };

  // 门禁审查：更新前构造候选实体，保留 Agent 已确认的语义槽位并校验全集上下文。
  const candidate = { ...row, ...req };
  if (req.character_ids !== undefined) candidate.characters = req.character_ids;
  if (req.prop_ids !== undefined) candidate.prop_ids = req.prop_ids;
  candidate.semantic_slots = req.semantic_slots !== undefined
    ? parseSemanticSlots(req.semantic_slots)
    : parseSemanticSlots(row.semantic_slots);
  const semanticFields = new Set([
    'scene_id', 'characters', 'character_ids', 'prop_ids', 'character_visuals', 'last_frame_visuals',
    'video_slots', 'semantic_slots', 'duration', 'dialogue', 'narration', 'action', 'result', 'atmosphere',
    'shot_type', 'angle', 'angle_h', 'angle_v', 'angle_s', 'dialogue_framing', 'movement',
    'lighting_style', 'depth_of_field', 'bgm_prompt', 'sound_effect', 'layout_description',
    'long_take_group_id', 'long_take_role', 'long_take_sequence',
  ]);
  const changesSemantics = Object.keys(req).some((field) => semanticFields.has(field));
  if (changesSemantics) {
    const episodeShots = db.prepare('SELECT * FROM storyboards WHERE episode_id=? AND deleted_at IS NULL ORDER BY storyboard_number,id').all(row.episode_id)
      .map(s => {
        const merged = Number(s.id) === Number(row.id) ? candidate : s;
        return { ...merged, semantic_slots: parseSemanticSlots(merged.semantic_slots) };
      });
    const { validateAllInvariants } = require('../ontology/invariants');
    const audit = validateAllInvariants(episodeShots, { db });
    const fatalErrors = audit.violations || [];
    if (fatalErrors.length > 0) {
      const err = new Error(`分镜修改未通过视听本体门禁审查：${fatalErrors.map(v => v.message).join('；')}`);
      err.status = 400;
      err.violations = fatalErrors;
      throw err;
    }
  }

  const updates = [];
  const params = [];
  // 前端可能传 character_ids，与 characters 统一：存为 JSON 字符串
  const charactersValue = req.character_ids !== undefined ? req.character_ids : req.characters;
  let parsedDramaCharIdsForSync = null;
  if (charactersValue !== undefined) {
    updates.push('characters = ?');
    const jsonStr = Array.isArray(charactersValue) ? JSON.stringify(charactersValue) : (typeof charactersValue === 'string' ? charactersValue : '[]');
    params.push(jsonStr);
    parsedDramaCharIdsForSync = parseDramaCharacterIds(charactersValue) ?? [];
  }
  for (const key of allowed) {
    if (key === 'characters') continue;
    if (req[key] !== undefined) {
      updates.push(key + ' = ?');
      const val = req[key];
      const jsonColumns = new Set(['character_visuals', 'last_frame_visuals', 'video_slots', 'background_characters', 'continuity_snapshot']);
      params.push(jsonColumns.has(key) && val != null && typeof val === 'object' ? JSON.stringify(val) : val);
    }
  }

  // 只有 Agent/用户明确提交 semantic_slots 时才更新；普通字段编辑绝不重建或覆盖语义决策。
  if ('semantic_slots' in row && req.semantic_slots !== undefined) {
    updates.push('semantic_slots = ?');
    params.push(JSON.stringify(candidate.semantic_slots));
  }
  if (updates.length === 0 && req.prop_ids === undefined) return getStoryboardById(db, id);
  db.transaction(() => {
    if (changesSemantics) linkEpisodeCharacters(db, row.episode_id, [candidate]);
    if (updates.length > 0) {
      params.push(new Date().toISOString(), id);
      db.prepare('UPDATE storyboards SET ' + updates.join(', ') + ', updated_at = ? WHERE id = ?').run(...params);
    }
    // 角色勾选变更：只同步 storyboard_characters，不删除 frame_prompts。
    // 用户手动保存的首/尾帧提示词应保留；图生时 framePromptSanitize 会按当前勾选剔除未出场角色名。
    if (parsedDramaCharIdsForSync !== null) {
      try {
        syncStoryboardCharacterLinks(db, id, parsedDramaCharIdsForSync);
      } catch (e) {
        log.warn('syncStoryboardCharacterLinks failed', { id, message: e.message });
      }
    }
    // 道具关联：写入 storyboard_props 表
    if (req.prop_ids !== undefined) {
      const propIds = Array.isArray(req.prop_ids) ? req.prop_ids : [];
      db.prepare('DELETE FROM storyboard_props WHERE storyboard_id = ?').run(Number(id));
      const ins = db.prepare('INSERT OR IGNORE INTO storyboard_props (storyboard_id, prop_id) VALUES (?, ?)');
      for (const pid of propIds) ins.run(Number(id), Number(pid));
    }
  })();
  log.info('Storyboard updated', { id });
  return getStoryboardById(db, id);
}

function deleteStoryboard(db, log, id) {
  const now = new Date().toISOString();
  const result = db.prepare('UPDATE storyboards SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, Number(id));
  if (result.changes === 0) return false;
  log.info('Storyboard deleted', { id });
  return true;
}

function getStoryboardById(db, id) {
  const r = db.prepare('SELECT * FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!r) return null;
  let characters = [];
  if (r.characters) {
    if (typeof r.characters === 'string') {
      try { characters = JSON.parse(r.characters); } catch (_) {}
    } else if (Array.isArray(r.characters)) characters = r.characters;
  }
  let propIds = [];
  try {
    const propLinks = db.prepare('SELECT prop_id FROM storyboard_props WHERE storyboard_id = ?').all(Number(id));
    propIds = propLinks.map((p) => p.prop_id);
  } catch (_) {}
  return {
    id: r.id,
    episode_id: r.episode_id,
    scene_id: r.scene_id,
    storyboard_number: r.storyboard_number,
    title: r.title,
    description: r.description,
    location: r.location,
    time: r.time,
    duration: r.duration ?? 0,
    dialogue: r.dialogue,
    narration: r.narration ?? null,
    action: r.action,
    result: r.result ?? null,
    atmosphere: r.atmosphere,
    image_prompt: r.image_prompt,
    polished_prompt: r.polished_prompt ?? null,
    video_prompt: r.video_prompt,
    video_model: r.video_model ?? null,
    shot_type: r.shot_type,
    angle: r.angle,
    angle_h: r.angle_h ?? null,
    angle_v: r.angle_v ?? null,
    angle_s: r.angle_s ?? null,
    dialogue_framing: r.dialogue_framing ?? null,
    movement: r.movement,
    lighting_style: r.lighting_style ?? null,
    depth_of_field: r.depth_of_field ?? null,
    bgm_prompt: r.bgm_prompt ?? null,
    sound_effect: r.sound_effect ?? null,
    segment_index: r.segment_index ?? 0,
    segment_title: r.segment_title ?? null,
    creation_mode: r.creation_mode === 'universal' ? 'universal' : 'classic',
    universal_segment_text: r.universal_segment_text ?? null,
    layout_description: r.layout_description ?? null,
    start_framing: r.start_framing ?? null,
    end_framing: r.end_framing ?? null,
    transition_to_next: r.transition_to_next ?? null,
    first_frame_image_id: r.first_frame_image_id ?? null,
    last_frame_image_id: r.last_frame_image_id ?? null,
    last_frame_image_url: r.last_frame_image_url ?? null,
    last_frame_local_path: r.last_frame_local_path ?? null,
    character_visuals: (() => { try { return r.character_visuals ? (typeof r.character_visuals === 'string' ? JSON.parse(r.character_visuals) : r.character_visuals) : null; } catch (_) { return null; } })(),
    last_frame_visuals: (() => { try { return r.last_frame_visuals ? (typeof r.last_frame_visuals === 'string' ? JSON.parse(r.last_frame_visuals) : r.last_frame_visuals) : null; } catch (_) { return null; } })(),
    video_slots: (() => { try { return r.video_slots ? (typeof r.video_slots === 'string' ? JSON.parse(r.video_slots) : r.video_slots) : null; } catch (_) { return null; } })(),
    semantic_slots: (() => { try { return r.semantic_slots ? (typeof r.semantic_slots === 'string' ? JSON.parse(r.semantic_slots) : r.semantic_slots) : null; } catch (_) { return null; } })(),
    h3_contract: (() => { try { return r.h3_contract_json ? (typeof r.h3_contract_json === 'string' ? JSON.parse(r.h3_contract_json) : r.h3_contract_json) : null; } catch (_) { return null; } })(),
    h3_contract_version: r.h3_contract_version ?? null,
    h3_contract_status: r.h3_contract_status ?? null,
    h3_prompt_snapshot: r.h3_prompt_snapshot ?? null,
    h3_quality_audit: (() => { try { return r.h3_quality_audit ? (typeof r.h3_quality_audit === 'string' ? JSON.parse(r.h3_quality_audit) : r.h3_quality_audit) : null; } catch (_) { return null; } })(),
    background_characters: (() => { try { return r.background_characters ? (typeof r.background_characters === 'string' ? JSON.parse(r.background_characters) : r.background_characters) : []; } catch (_) { return []; } })(),
    continuity_snapshot: (() => { try { return r.continuity_snapshot ? (typeof r.continuity_snapshot === 'string' ? JSON.parse(r.continuity_snapshot) : r.continuity_snapshot) : null; } catch (_) { return null; } })(),
    characters,
    prop_ids: propIds,
    composed_image: r.composed_image,
    image_url: r.image_url ?? null,
    local_path: r.local_path ?? null,
    main_panel_idx: r.main_panel_idx != null ? Number(r.main_panel_idx) : null,
    video_url: r.video_url,
    selected_video_id: r.selected_video_id != null ? Number(r.selected_video_id) : null,
    audio_local_path: r.audio_local_path ?? null,
    narration_audio_local_path: r.narration_audio_local_path ?? null,
    long_take_group_id: r.long_take_group_id ?? null,
    long_take_role: r.long_take_role ?? null,
    long_take_sequence: r.long_take_sequence != null ? Number(r.long_take_sequence) : null,
    status: r.status || 'pending',
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function getFramePrompts(db, storyboardId) {
  const rows = db.prepare(
    'SELECT * FROM frame_prompts WHERE storyboard_id = ? ORDER BY created_at ASC'
  ).all(Number(storyboardId));
  return rows.map((r) => ({
    id: r.id,
    storyboard_id: r.storyboard_id,
    frame_type: r.frame_type,
    prompt: r.prompt,
    description: r.description,
    layout: r.layout,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
}

function saveFramePrompt(db, log, storyboardId, frameType, prompt, description, layout) {
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT id FROM frame_prompts WHERE storyboard_id = ? AND frame_type = ?').get(Number(storyboardId), frameType);
  if (existing) {
    db.prepare('UPDATE frame_prompts SET prompt = ?, description = ?, layout = ?, updated_at = ? WHERE id = ?').run(
      prompt,
      description ?? null,
      layout ?? null,
      now,
      existing.id
    );
    return getFramePrompts(db, storyboardId);
  }
  db.prepare(
    `INSERT INTO frame_prompts (storyboard_id, frame_type, prompt, description, layout, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(Number(storyboardId), frameType, prompt, description ?? null, layout ?? null, now, now);
  log.info('Frame prompt saved', { storyboard_id: storyboardId, frame_type: frameType });
  return getFramePrompts(db, storyboardId);
}

/** 在指定分镜前插入一个空白分镜：先把同 episode 中 number >= target 的全部 +1，再创建新分镜 */
function insertBeforeStoryboard(db, log, targetId) {
  const target = db.prepare(
    'SELECT id, episode_id, storyboard_number, segment_index, segment_title FROM storyboards WHERE id = ? AND deleted_at IS NULL'
  ).get(Number(targetId));
  if (!target) return null;

  db.prepare(
    'UPDATE storyboards SET storyboard_number = storyboard_number + 1, updated_at = ? WHERE episode_id = ? AND storyboard_number >= ? AND deleted_at IS NULL'
  ).run(new Date().toISOString(), target.episode_id, target.storyboard_number);

  const now = new Date().toISOString();
  const info = db.prepare(
    `INSERT INTO storyboards (episode_id, storyboard_number, segment_index, segment_title, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)`
  ).run(target.episode_id, target.storyboard_number, target.segment_index ?? null, target.segment_title ?? null, now, now);

  log.info('Storyboard inserted before', { new_id: info.lastInsertRowid, before_id: targetId });
  return getStoryboardById(db, info.lastInsertRowid);
}

module.exports = {
  createStoryboard,
  insertBeforeStoryboard,
  updateStoryboard,
  deleteStoryboard,
  getStoryboardById,
  getFramePrompts,
  saveFramePrompt,
};
