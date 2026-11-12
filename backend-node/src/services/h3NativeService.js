const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const layout = require('./storageLayout');
const voices = require('./h3VoiceReferenceService');
const narrative = require('./narrativeStyleService');
const wardrobe = require('./wardrobeService');
const angleService = require('./angleService');
const { getFfmpegPath } = require('../utils/ffmpegPath');
const { normalizeExecutionPlan } = require('./continuumPlan');
const stage3 = require('./h3Stage3PromptService');

const MODES = ['auto', 'off', 'previous_tail'];
const H3_STEPS = 23;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function parse(value, fallback) { try { return typeof value === 'string' ? JSON.parse(value) : value ?? fallback; } catch { return fallback; } }
// Only fields that can alter the prepared H3 request belong in the concurrency
// fingerprint. Output/status columns are written by generation jobs and must not
// make an otherwise immutable input look stale while the prompt is translated.
function shotInputSnapshot(shot) {
  const fields = [
    'id', 'episode_id', 'storyboard_number', 'scene_id', 'description', 'location',
    'time', 'duration', 'dialogue', 'narration', 'action', 'atmosphere',
    'characters', 'background_characters', 'character_visuals',
    'video_slots', 'semantic_slots', 'shot_type', 'angle', 'angle_h', 'angle_v',
    'angle_s', 'movement', 'lighting_style', 'depth_of_field', 'sound_effect',
    'bgm_prompt', 'first_frame_image_id', 'last_frame_image_id',
    'last_frame_image_url', 'last_frame_local_path',
  ];
  return Object.fromEntries(fields.map(field => [field, shot?.[field] ?? null]));
}
function h3SettingsSnapshot(loaded) {
  return {
    continuity: loaded.continuity,
    engine_mode: loaded.engine_mode,
    first_frame_policy: loaded.first_frame_policy,
    last_frame_policy: loaded.last_frame_policy,
  };
}
function plannedVideoTimeline(shot) {
  const raw = parse(shot?.video_slots, null);
  if (!raw || typeof raw !== 'object') return [];
  const normalized = require('../ontology/videoSlots').createVideoSemanticSlots(raw);
  const timeline = Array.isArray(normalized.shots_timeline) ? normalized.shots_timeline : [];
  let elapsed = 0;
  return timeline.map((segment, index) => {
    const duration = Number(segment.duration || 0);
    const timestamp = index === 0 ? null : require('../ontology/videoSlots').formatH3Timestamp(elapsed);
    elapsed += duration;
    return { ...segment, shot_number: index + 1, timestamp, duration };
  });
}
function load(db, dramaId, shotId) {
  const project = db.prepare('SELECT * FROM dramas WHERE id=? AND deleted_at IS NULL').get(Number(dramaId));
  const shot = db.prepare(`SELECT s.* FROM storyboards s JOIN episodes e ON e.id=s.episode_id
    WHERE s.id=? AND e.drama_id=? AND s.deleted_at IS NULL AND e.deleted_at IS NULL`).get(Number(shotId), Number(dramaId));
  if (!project || !shot) throw new Error('H3 分镜不属于当前项目或已删除');
  const metadata = layout.parseMetadata(project.metadata);
  const shotMeta = metadata.h3_shots?.[shot.id] || {};
  const continuity = shotMeta.continuity || metadata.h3_default_continuity || 'off';
  const engine_mode = shotMeta.engine_mode || metadata.h3_default_engine_mode || 'ref2va';
  const first_frame_policy = shotMeta.first_frame_policy || null;
  const last_frame_policy = shotMeta.last_frame_policy || null;
  return { project, shot, continuity, engine_mode, first_frame_policy, last_frame_policy };
}
function sameScene(a, b) {
  if (!a || !b) return false;
  if (a.scene_id && b.scene_id) return Number(a.scene_id) === Number(b.scene_id);
  return !!a.location?.trim() && a.location.trim() === b.location?.trim();
}
function previous(db, shot) {
  return db.prepare(`SELECT * FROM storyboards WHERE episode_id=? AND deleted_at IS NULL
    AND (storyboard_number<? OR (storyboard_number=? AND id<?)) ORDER BY storyboard_number DESC,id DESC LIMIT 1`)
    .get(shot.episode_id, shot.storyboard_number, shot.storyboard_number, shot.id);
}
function selectedVideo(db, dramaId, shot) {
  if (!shot) return null;
  if (/\.(mp4|webm|mov|mkv)$/i.test(shot.local_path || '')) return { local_path: shot.local_path, storyboard_id: shot.id };
  return db.prepare(`SELECT * FROM video_generations WHERE drama_id=? AND storyboard_id=? AND deleted_at IS NULL
    AND status='completed' AND local_path IS NOT NULL AND local_path<>'' ORDER BY id DESC LIMIT 1`).get(Number(dramaId), shot.id);
}
function localFile(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\') || relative.includes('\0')) throw new Error('H3 素材路径无效');
  const realRoot = fs.realpathSync(root);
  const file = fs.realpathSync(path.resolve(realRoot, relative));
  if (!file.startsWith(realRoot + path.sep) || !fs.statSync(file).isFile()) throw new Error('H3 素材路径无效');
  return file;
}
// Reconcile browser /static URLs with database-relative paths before assigning Picture indices.
function canonicalSource(root, source) {
  if (typeof source !== 'string') return '';
  source = source.trim();
  let relative = source;
  if (/^https?:\/\//i.test(source)) {
    try {
      const url = new URL(source);
      if (!url.pathname.startsWith('/static/')) return source;
      relative = decodeURIComponent(url.pathname.slice(8));
    } catch { return source; }
  } else relative = source.replace(/^\/static\//, '');
  if (root) {
    try { return path.relative(fs.realpathSync(root), localFile(root, relative)).split(path.sep).join('/'); }
    catch { /* Keep external URLs and report missing local files when preparing inputs. */ }
  }
  return /^https?:/i.test(source) ? source : relative;
}
function imageSource(entity) { return entity?.local_path || entity?.ref_image || entity?.image_url || ''; }
function characterIds(db, shot) {
  const parsed = parse(shot.characters, []);
  let ids = Array.isArray(parsed) ? parsed.map(c => Number(c && typeof c === 'object' ? c.id : c)).filter(id => id > 0) : [];
  if (!ids.length) ids = db.prepare('SELECT character_id FROM storyboard_characters WHERE storyboard_id=? ORDER BY id').all(shot.id).map(r => Number(r.character_id));
  return [...new Set(ids)];
}
function assetReferences(db, dramaId, shot, speakerIds = [], root, maxSlots = 7) {
  const refs = [];
  const add = (source, details) => {
    source = canonicalSource(root, source);
    if (!source || refs.some(r => r.source === source)) return;
    refs.push({ source, ...details });
  };
  const looks = wardrobe.getShot(db, shot.id).characters;
  const ids = [...new Set([...characterIds(db, shot), ...speakerIds])];

  // 多人镜头（>1 人）或槽位紧张时，跳过补充生活照（extra_images），避免单镜素材爆炸
  const allowExtras = ids.length <= 1;

  for (const id of ids) {
    if (refs.length >= maxSlots) {
      throw new Error(`MiniMax-H3 角色参考素材数量已达上限 (${maxSlots})，后端禁止静默忽略多余角色，请拆分分镜！`);
    }
    const c = db.prepare('SELECT * FROM characters WHERE id=? AND drama_id=? AND deleted_at IS NULL').get(id, Number(dramaId));
    if (!c) throw new Error('H3 分镜包含不属于当前项目的人物，请重新选择人物');
    const generated = c.local_path && db.prepare('SELECT prompt FROM image_generations WHERE character_id=? AND local_path=? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1').get(c.id, c.local_path);
    const sheet = /reference sheet|四视图|四格|角色参考表/i.test(generated?.prompt || '');
    add(imageSource(c), { kind: sheet ? 'character_sheet' : 'character', character_id: c.id, name: c.name, appearance: c.appearance || c.description || '' });
    const look = looks.find(p => p.id === id);
    if (look?.reference_image) {
      if (refs.length >= maxSlots) {
        throw new Error(`MiniMax-H3 角色服装参考素材数量已达上限 (${maxSlots})，后端禁止静默忽略，请拆分分镜！`);
      }
      add(look.reference_image, { kind: 'character_outfit', character_id: c.id, name: c.name + ' · ' + look.stage_name, appearance: look.description });
    }
    if (allowExtras) {
      const extras = parse(c.extra_images, []);
      for (const source of Array.isArray(extras) ? extras : []) {
        if (refs.length >= maxSlots) {
          throw new Error(`MiniMax-H3 角色生活照参考素材数量已达上限 (${maxSlots})，后端禁止静默忽略，请拆分分镜！`);
        }
        add(source, { kind: 'character', character_id: c.id, name: c.name, appearance: c.appearance || c.description || '' });
      }
    }
  }

  // 场景背景图
  if (shot.scene_id) {
    if (refs.length >= maxSlots) {
      throw new Error(`MiniMax-H3 包含场景背景后参考素材数量已达上限 (${maxSlots})，后端禁止静默忽略，请拆分分镜！`);
    }
    const scene = db.prepare('SELECT * FROM scenes WHERE id=? AND drama_id=? AND deleted_at IS NULL').get(shot.scene_id, Number(dramaId));
    if (scene) add(imageSource(scene), { kind: 'scene', name: scene.name || '场景' });
  }

  // 道具：严禁静默 break 截断
  const propRows = db.prepare(`SELECT p.* FROM props p JOIN storyboard_props sp ON sp.prop_id=p.id WHERE sp.storyboard_id=? AND p.drama_id=? AND p.deleted_at IS NULL ORDER BY p.id`).all(shot.id, Number(dramaId));
  for (const prop of propRows) {
    if (refs.length >= maxSlots) {
      throw new Error(`MiniMax-H3 挂载道具后参考素材数量已达上限 (${maxSlots})，后端禁止静默忽略道具，请拆分分镜！`);
    }
    add(imageSource(prop), { kind: 'prop', name: prop.name || '道具', appearance: prop.description || '' });
  }

  return refs;
}

function resolveRequiredReference(db, dramaId, shot, ref, root) {
  const explicit = ref?.url || ref?.image_url || ref?.local_path || '';
  if (explicit) return canonicalSource(root, explicit);
  const type = ref?.type || 'character';
  const id = Number(ref?.id ?? ref?.character_id);
  let entity = null;
  if (type === 'character' && id > 0) {
    entity = db.prepare('SELECT * FROM characters WHERE id=? AND drama_id=? AND deleted_at IS NULL').get(id, Number(dramaId));
  } else if (type === 'scene' && id > 0) {
    entity = db.prepare('SELECT * FROM scenes WHERE id=? AND drama_id=? AND deleted_at IS NULL').get(id, Number(dramaId));
  } else if (type === 'prop' && id > 0) {
    entity = db.prepare('SELECT * FROM props WHERE id=? AND drama_id=? AND deleted_at IS NULL').get(id, Number(dramaId));
  } else if (type === 'costume' || type === 'wardrobe') {
    const characterId = Number(ref?.character_id ?? ref?.id);
    const state = wardrobe.getShot(db, shot.id).characters.find(c => Number(c.id) === characterId);
    if (!state) throw new Error(`H3 必要服装参考对应的人物不存在（角色 ID:${characterId || '空'}）`);
    if (ref?.stage_id && state.stage_id !== ref.stage_id) {
      const stage = state.stages?.find(s => s.id === ref.stage_id);
      if (!stage) throw new Error(`H3 必要服装参考阶段不存在（角色 ID:${characterId}，阶段:${ref.stage_id}）`);
      const source = canonicalSource(root, stage.reference_image || '');
      if (!source) throw new Error(`H3 必要服装参考「${ref.name || stage.name}」尚未生成或上传图片`);
      return source;
    }
    const source = canonicalSource(root, state.reference_image || '');
    if (!source) throw new Error(`H3 必要服装参考「${ref.name || state.stage_name || characterId}」尚未生成或上传图片`);
    return source;
  }
  if (!entity) throw new Error(`H3 必要参考素材不存在或不属于当前项目（${type}:${ref?.id ?? '空'}）`);
  const source = canonicalSource(root, imageSource(entity));
  if (!source) throw new Error(`H3 必要参考素材「${ref?.name || entity.name || `${type}:${id}`}」尚未生成或上传图片`);
  return source;
}
function nativeCanvas(ratio) {
  const presets = { '16:9': [1344, 768], '9:16': [768, 1344], '1:1': [992, 992], '4:3': [1152, 864], '3:4': [864, 1152], '21:9': [1536, 672] };
  return presets[ratio] || presets['16:9'];
}
function getSettings(db, dramaId, shotId) {
  const { shot, continuity, engine_mode, first_frame_policy, last_frame_policy } = load(db, dramaId, shotId);
  const prev = previous(db, shot);
  const video = selectedVideo(db, dramaId, prev);
  const { resolveH3Mode, deriveManualRef2vaReferences } = require('./h3ModeResolver');
  const generationPlan = resolveH3Mode(shot, {
    manualModeOverride: engine_mode === 'auto' ? null : engine_mode,
    manualFirstFramePolicy: first_frame_policy,
    manualLastFramePolicy: last_frame_policy,
    manualReferences: engine_mode === 'ref2va' ? deriveManualRef2vaReferences(db, dramaId, shot) : [],
  });
  const rawRefs = generationPlan.mode === 'ref2va'
    ? generationPlan.references.map(ref => ({
        source: resolveRequiredReference(db, dramaId, shot, ref),
        kind: ref.kind || (['wardrobe', 'costume'].includes(ref.type) ? 'character_outfit' : (ref.type || 'character')),
        character_id: ref.character_id ?? (ref.type === 'character' ? ref.id : null),
        name: ref.name || '未命名参考',
        appearance: ref.description || '',
      }))
    : [];

  // Map Subject IDs for character references
  const subjectsMap = new Map();
  const references = rawRefs.map((r, i) => {
    let subject_index = null;
    let retention_role = 'fully_preserved';
    if (r.character_id) {
      if (!subjectsMap.has(r.character_id)) {
        subjectsMap.set(r.character_id, subjectsMap.size + 1);
      }
      subject_index = subjectsMap.get(r.character_id);
      retention_role = r.kind === 'character_sheet' ? 'partially_preserved' : 'fully_preserved';
    }
    return {
      ...r,
      index: i + 1,
      tag: `<Picture ${i + 1}>`,
      subject_index,
      subject_tag: subject_index ? `<Subject ${subject_index}>` : null,
      retention_role,
      url: /^https?:/i.test(r.source) ? r.source : '/static/' + r.source.replace(/^\/static\//, '')
    };
  });

  // Include opening anchor frame if available
  const openingAnchorSource = generationPlan.mode === 'fl2va' ? (shot.first_frame_url || shot.local_path || shot.image_url) : '';
  let opening_anchor = null;
  if (openingAnchorSource) {
    const openingIndex = references.length + 1;
    opening_anchor = {
      index: openingIndex,
      tag: `<Picture ${openingIndex}>`,
      kind: 'opening_frame',
      name: '开场首帧构图锚点',
      url: /^https?:/i.test(openingAnchorSource) ? openingAnchorSource : '/static/' + openingAnchorSource.replace(/^\/static\//, ''),
      retention_role: 'fully_preserved'
    };
  }

  // Voice & Speech Extraction
  const dubbing = require('./dialogueDubbingService');
  const extraction = require('./speechExtractionService');
  let plan = { segments: [] };
  try {
    plan = extraction.automaticPlan(db, dramaId, shot, dubbing.dialogueSegments);
  } catch (_) {}
  const p = dubbing.getProfile(db, dramaId);
  const characters = db.prepare('SELECT id, name FROM characters WHERE drama_id = ? AND deleted_at IS NULL').all(Number(dramaId));
  const voice_references = [];
  const voiceMap = new Map();

  for (const line of (plan && plan.segments) || []) {
    const charId = Object.hasOwn(p.speaker_characters || {}, line.speaker)
      ? p.speaker_characters[line.speaker]
      : characters.find(c => c.name === line.speaker)?.id;
    const targetKey = line.kind === 'narration' ? 'narrator' : (charId ? `char_${charId}` : `speaker_${line.speaker || 'unknown'}`);
    const speakerName = line.kind === 'narration' ? '旁白' : (line.speaker || '未命名人物');

    if (!voiceMap.has(targetKey)) {
      const idx = voice_references.length + 1;
      const subIdx = charId ? subjectsMap.get(charId) : null;
      const voiceId = line.kind === 'narration'
        ? p.narrator_voice
        : (p.character_voices?.[charId] || p.voices?.[line.speaker] || p.default_voice);

      const voiceItem = {
        index: idx,
        tag: `<Audio ${idx}>`,
        speaker: speakerName,
        speaker_id: `S${idx}`,
        speaker_tag: `(S${idx})`,
        subject_tag: subIdx ? `<Subject ${subIdx}>` : null,
        kind: line.kind,
        voice_id: voiceId || '默认音色',
        retention_marker: 'reference',
        text: line.text,
        formatted_line: `${line.kind === 'narration' ? 'The narrator' : (subIdx ? `<Subject ${subIdx}>` : speakerName)} (S${idx}), using the vocal timbre referenced from <Audio ${idx}>, ${line.kind === 'narration' ? 'says in an off-screen voiceover' : 'says'}, <d>[Chinese] ${line.text}</d>`
      };
      voiceMap.set(targetKey, voiceItem);
      voice_references.push(voiceItem);
    }
  }

  let quality_audit = null;
  try {
    const latestVideo = db.prepare('SELECT id, quality_audit, status, video_url, local_path FROM video_generations WHERE storyboard_id=? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1').get(shotId);
    if (latestVideo?.quality_audit) {
      quality_audit = JSON.parse(latestVideo.quality_audit);
      const cfg = require('../config').loadConfig();
      const storageRoot = path.resolve(cfg.storage?.local_path || './data/storage');
      const positions = { first_frame: 'start', mid_frame: 'mid', tail_frame: 'end' };
      quality_audit.key_frames = Object.entries(quality_audit.frames || {}).flatMap(([key, file]) => {
        if (!file || !positions[key]) return [];
        const absolute = path.resolve(file);
        if (!absolute.startsWith(storageRoot + path.sep)) return [];
        const relative = path.relative(storageRoot, absolute).split(path.sep).join('/');
        return [{ position: positions[key], url: `/static/${relative}` }];
      });
    }
  } catch (_) {}

  return {
    wardrobe_change: wardrobe.getShot(db, shotId).change,
    continuity_reset: wardrobe.hasChange(db, shotId),
    continuity,
    engine_mode,
    first_frame_policy_override: first_frame_policy || 'agent',
    last_frame_policy_override: last_frame_policy || 'agent',
    agent_mode: generationPlan?.agent_mode || null,
    resolved_mode: generationPlan?.mode || null,
    resolution_reason: generationPlan?.resolution_reason || '',
    h3_generation_plan: generationPlan,
    quality_audit,
    references,
    opening_anchor,
    voice_references,
    previous_storyboard: prev ? { id: prev.id, number: prev.storyboard_number, same_scene: sameScene(shot, prev), video_ready: !!video } : null,
    max_images: 9,
    max_voices: 3,
    steps: H3_STEPS
  };
}
function saveSettings(db, dramaId, shotId, body) {
  if (body.continuity && !MODES.includes(body.continuity)) throw new Error('请选择自动衔接、关闭衔接或使用上一镜实际尾帧');
  if (body.engine_mode && !['auto', 'fl2va', 'ref2va'].includes(body.engine_mode)) throw new Error('请选择有效的 H3 引擎模式（auto、fl2va 或 ref2va）');
  if (body.first_frame_policy && !['agent', 'none', 'generate_new', 'inherit_tail', 'layout_lock'].includes(body.first_frame_policy)) throw new Error('请选择有效的首帧策略');
  if (body.last_frame_policy && !['agent', 'none', 'generate_tail'].includes(body.last_frame_policy)) throw new Error('请选择有效的尾帧策略');
  const loaded = load(db, dramaId, shotId);
  const nextEngineMode = body.engine_mode || loaded.engine_mode;
  let firstChoice = body.first_frame_policy || loaded.first_frame_policy || 'agent';
  let lastChoice = body.last_frame_policy || loaded.last_frame_policy || 'agent';

  // 旧客户端 continuity 字段只做显式兼容映射；新流程直接保存完整首帧策略。
  if (body.first_frame_policy == null && body.continuity) {
    if (body.continuity === 'previous_tail') firstChoice = 'inherit_tail';
    else if (body.continuity === 'off') firstChoice = 'agent';
    else {
      const prev = previous(db, loaded.shot);
      firstChoice = prev && sameScene(loaded.shot, prev) ? 'inherit_tail' : 'agent';
    }
  }

  const manualFirst = firstChoice === 'agent' ? null : firstChoice;
  const manualLast = lastChoice === 'agent' ? null : lastChoice;
  const { resolveH3Mode, deriveManualRef2vaReferences } = require('./h3ModeResolver');
  const nextPlan = resolveH3Mode(loaded.shot, {
    manualModeOverride: nextEngineMode === 'auto' ? null : nextEngineMode,
    manualFirstFramePolicy: manualFirst,
    manualLastFramePolicy: manualLast,
    manualReferences: nextEngineMode === 'ref2va' ? deriveManualRef2vaReferences(db, dramaId, loaded.shot) : [],
    throwOnViolation: true,
  });
  const nextContinuity = nextPlan.first_frame_policy === 'inherit_tail' ? 'previous_tail' : 'off';
  db.transaction(() => {
    const current = db.prepare('SELECT metadata FROM dramas WHERE id=? AND deleted_at IS NULL').get(Number(dramaId));
    const metadata = layout.parseMetadata(current.metadata);
    const existing = metadata.h3_shots?.[shotId] || {};
    const next = { ...existing, continuity: nextContinuity };
    if (body.engine_mode) next.engine_mode = body.engine_mode;
    if (manualFirst) next.first_frame_policy = manualFirst;
    else delete next.first_frame_policy;
    if (manualLast) next.last_frame_policy = manualLast;
    else delete next.last_frame_policy;
    metadata.h3_shots = { ...(metadata.h3_shots || {}), [shotId]: next };
    db.prepare('UPDATE dramas SET metadata=?,updated_at=? WHERE id=?').run(JSON.stringify(metadata), new Date().toISOString(), Number(dramaId));
  })();
  return getSettings(db, dramaId, shotId);
}
async function tailFrame(db, dramaId, previousShot, root) {
  const video = selectedVideo(db, dramaId, previousShot);
  if (!video) throw new Error('上一镜尚无已完成的本地视频，请先生成上一镜或关闭尾帧衔接');
  const file = localFile(root, video.local_path);
  const stat = fs.statSync(file);
  const rel = layout.getProjectStorageSubdir(db, dramaId) + '/images/h3-inputs/tail-' + hash([video.local_path, stat.size, stat.mtimeMs]).slice(0, 24) + '.png';
  const dest = path.join(root, rel);
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.' + randomUUID() + '.part.png';
    try {
      // Decode the final second and overwrite the PNG so its last write is the actual last frame.
      await execFile(getFfmpegPath(), ['-v', 'error', '-y', '-sseof', '-1', '-i', file, '-map', '0:v:0', '-an', '-vsync', '0', '-update', '1', tmp], { timeout: 45000 });
      if (!fs.existsSync(tmp) || !fs.statSync(tmp).size) throw new Error('无法提取上一镜的实际尾帧');
      fs.renameSync(tmp, dest);
    } finally { try { fs.unlinkSync(tmp); } catch { /* atomic output */ } }
  }
  return rel;
}
function wireImage(root, source) {
  if (/^https?:\/\//i.test(source) || /^data:image\//i.test(source)) return source;
  const bytes = fs.readFileSync(localFile(root, source));
  if (bytes.length > 20 * 1024 * 1024) throw new Error('H3 单张参考图不可超过 20MB');
  const mime = /\.jpe?g$/i.test(source) ? 'image/jpeg' : /\.webp$/i.test(source) ? 'image/webp' : 'image/png';
  return 'data:' + mime + ';base64,' + bytes.toString('base64');
}

function assertTightFramingReferences(refs = [], options = {}, speech = {}) {
  const framing = String(options.dialogueFraming || options.shot?.dialogue_framing || options.framing || "").toLowerCase();
  const shotType = String(options.shotType || options.shot?.shot_type || options.shot?.camera?.shot_type || "").toLowerCase();
  const framingNorm = framing.replace(/[-\s]/g, "_");
  const isTightFraming = /(?:over_the_shoulder|two_shot_close|single_close|ots_reverse|two_shot_face_to_face|single_reaction|close_up|extreme_close_up|ots)/i.test(framingNorm)
    || /(?:近景|特写|大特写|过肩|正反打|反打|双人对话)/i.test(`${framing} ${shotType}`);
  if (!isTightFraming) return;

  const isTwoShotFraming = /(?:over_the_shoulder|two_shot_close|ots_reverse|two_shot_face_to_face|ots|过肩|正反打|反打|双人)/i.test(`${framingNorm} ${shotType}`);
  const isSingleFraming = !isTwoShotFraming && (
    /(?:single_close|single_reaction|close_up|extreme_close_up|solo_action|single_focus)/i.test(framingNorm)
      || /(?:特写|大特写)/i.test(`${framing} ${shotType}`)
  );
  const maxFocalSubjects = isSingleFraming ? 1 : (isTwoShotFraming ? 2 : 3);

  const bgIds = new Set();
  const rawBg = options.backgroundCharacters
    || options.shot?.background_characters
    || (typeof options.shot?.semantic_slots === "object" ? options.shot?.semantic_slots?.background_characters : null)
    || (typeof options.semanticSlots === "object" ? options.semanticSlots?.background_characters : null);
  (Array.isArray(rawBg) ? rawBg : (typeof rawBg === "string" ? parse(rawBg, []) : [])).forEach(c => {
    const id = Number(c?.character_id ?? c?.id ?? c);
    if (Number.isFinite(id) && id > 0) bgIds.add(id);
  });
  const charVisuals = options.shot?.character_visuals
    || (typeof options.shot?.character_visuals === "string" ? parse(options.shot.character_visuals, []) : []);
  if (Array.isArray(charVisuals)) {
    charVisuals.forEach(cv => {
      if (cv && cv.depth_layer === "background" && cv.character_id != null) {
        const id = Number(cv.character_id);
        if (Number.isFinite(id) && id > 0) bgIds.add(id);
      }
    });
  }
  refs.forEach(r => {
    if ((r.depth_layer === "background" || r.is_background) && r.character_id != null) {
      const id = Number(r.character_id);
      if (Number.isFinite(id) && id > 0) bgIds.add(id);
    }
  });

  const visibleIds = new Set();
  const rawVisible = options.visibleCharacters
    || options.shot?.visible_characters
    || (typeof options.shot?.semantic_slots === "object" ? options.shot?.semantic_slots?.visible_characters : null)
    || (typeof options.semanticSlots === "object" ? options.semanticSlots?.visible_characters : null);
  if (rawVisible) {
    (Array.isArray(rawVisible) ? rawVisible : (typeof rawVisible === "string" ? parse(rawVisible, []) : [])).forEach(c => {
      const id = Number(c?.character_id ?? c?.id ?? c);
      if (Number.isFinite(id) && id > 0) visibleIds.add(id);
    });
    for (const line of speech?.lines || []) {
      const match = /^character:(\d+)$/.exec(line?.key || "");
      if (match) visibleIds.add(Number(match[1]));
    }
  }

  const subjects = new Set();
  for (const ref of refs) {
    const refCharId = ref.character_id != null ? Number(ref.character_id) : null;
    const isKnownSubject = refCharId && subjects.has(refCharId);
    const isBackgroundInTight = Boolean(
      refCharId && !isKnownSubject &&
      (bgIds.has(refCharId) || (visibleIds.size > 0 && !visibleIds.has(refCharId)) || subjects.size >= maxFocalSubjects)
    );
    if (isBackgroundInTight) {
      throw new Error(`H3 近景/正反打包含未规划的背景人物 ${ref.name || refCharId}；请由导演移出本镜或改为宽景，后端不静默降级人物参考`);
    }
    if (refCharId) subjects.add(refCharId);
  }
}
async function prepare(db, log, opts) {
  const { drama_id: dramaId, storyboard_id: shotId, storage_local_path: root } = opts;
  const initial = load(db, dramaId, shotId);
  const speech = await voices.forShot(db, log, dramaId, shotId, root);
  speech.narrative_style = narrative.fromMetadata(initial.project.metadata);
  const clothing = wardrobe.getShot(db, shotId);
  const afterVoices = load(db, dramaId, shotId);
  if (hash([shotInputSnapshot(afterVoices.shot), h3SettingsSnapshot(afterVoices), narrative.fromMetadata(afterVoices.project.metadata)]) !== hash([shotInputSnapshot(initial.shot), h3SettingsSnapshot(initial), speech.narrative_style])) throw new Error('准备 H3 参考声音期间分镜内容或叙事设置已变化，请重试');
  const delivery=require('./speechDeliveryService').forShot(db,initial.shot,{segments:speech.lines,duration:opts.duration});
  if(delivery.has_speech && !delivery.fits)throw new Error(`本镜提取后的对白与旁白约需 ${delivery.estimated_seconds} 秒，超过 ${delivery.duration} 秒，请延长镜头或按语义拆镜`);
  speech.narrative_style={...speech.narrative_style,speech_rate:delivery.speech_rate};
  const videoTimeline = plannedVideoTimeline(initial.shot);
  const voiceMap = {};
  for (const ref of speech.references) {
    const match = /^character:(\d+)$/.exec(ref.key);
    if (match) voiceMap[Number(match[1])] = ref.url;
  }
  const { resolveH3Mode, deriveManualRef2vaReferences } = require('./h3ModeResolver');
  const requestedEngineMode = opts.h3_engine_mode || opts.h3_mode || initial.engine_mode || 'auto';
  const explicitManualReferences = Array.isArray(opts.reference_urls)
    ? opts.reference_urls.filter(Boolean).map((url, index) => ({ type: 'context', url, name: `人工参考 ${index + 1}` }))
    : [];
  const executionPlan = resolveH3Mode(initial.shot, {
    manualModeOverride: requestedEngineMode === 'auto' ? null : requestedEngineMode,
    manualFirstFramePolicy: initial.first_frame_policy,
    manualLastFramePolicy: initial.last_frame_policy,
    manualReferences: requestedEngineMode === 'ref2va'
      ? (explicitManualReferences.length
        ? explicitManualReferences
        : deriveManualRef2vaReferences(db, dramaId, initial.shot))
      : [],
    characterVoices: voiceMap,
    throwOnViolation: true,
  });

  // H3 receives voice-timbre references only. The authoritative dialogue is
  // written verbatim into the prompt and H3 produces the native soundtrack.
  // Submitting a complete TTS waveform alongside the same dialogue creates
  // duplicate or unintelligible speech, so that path is deliberately removed.
  speech.references = (speech.references || []).filter(ref => ref.kind !== 'soundtrack');
  delete speech.soundtrack;

  const prev = previous(db, initial.shot);
  const wardrobeChanged = !!clothing.change || clothing.continuity_reset;
  if (wardrobeChanged && executionPlan.first_frame_policy === 'inherit_tail') throw new Error('本镜已设置换装或时间线变化，不能继承上一镜尾帧，请让导演 Agent 重新规划或人工选择新首帧');
  const agentInheritTail = executionPlan.first_frame_policy === 'inherit_tail';
  const usePrevious = executionPlan.mode === 'fl2va' && !wardrobeChanged && agentInheritTail;

  let first = canonicalSource(root, opts.first_frame_url || opts.image_url || '');
  const last = canonicalSource(root, opts.last_frame_url || '');

  const refs = [];
  const add = (source, kind, details = {}) => {
    source = canonicalSource(root, source);
    if (source && !refs.some(r => r.source === source)) {
      refs.push({ source, kind, name: kind === 'first_frame' ? '首帧锚点' : kind === 'last_frame' ? '尾帧锚点' : (details.name || '补充参考'), ...details });
    }
  };

  if (usePrevious) {
    if (!prev) throw new Error('当前是本集第一镜，无法使用上一镜尾帧');
    const currentFirst = first;
    first = await tailFrame(db, dramaId, prev, root);
    if (currentFirst && currentFirst !== first) add(currentFirst, 'shot_context');
  }

  // FL2VA 只接收首帧及可选尾帧；Ref2VA 只接收 Agent 规划的多参考素材。
  if (executionPlan.mode === 'fl2va') add(first, 'first_frame');

  // 2. 确定后续参考图：Agent 方案使用 required_references；人工从 FL2VA
  // 切换为 Ref2VA 时，使用编译器从已落库镜头合同展开并公开展示的参考清单。
  const plannedReferences = Array.isArray(executionPlan.references) ? executionPlan.references : [];

  if (executionPlan.mode === 'ref2va' && plannedReferences.length > 0) {
    for (const r of plannedReferences) {
      const src = resolveRequiredReference(db, dramaId, initial.shot, r, root);
      add(src, r.kind || (['wardrobe', 'costume'].includes(r.type) ? 'character_outfit' : (r.type || 'character')), {
        character_id: r.character_id ?? (['character', 'costume', 'wardrobe'].includes(r.type) ? r.id : null),
        name: r.name,
        appearance: r.description || '',
      });
    }
  } else if (executionPlan.mode === 'ref2va' && Array.isArray(opts.reference_urls) && opts.reference_urls.length > 0) {
    for (const source of opts.reference_urls) {
      add(source, 'context');
    }
  }

  // 3. 尾帧锚点（若存在且不同于首帧）
  if (executionPlan.mode === 'fl2va' && executionPlan.last_frame_policy === 'generate_tail' && last && last !== first) {
    add(last, 'last_frame');
  }

  // 4. 硬门禁：超过 9 张直接阻断，杜绝后端静默裁剪
  if (refs.length > 9) {
    throw new Error(`MiniMax-H3 单镜最多支持 9 张参考图（当前 ${refs.length} 张），后端禁止静默裁剪与删除人物/道具/参考图，请退回 Agent 拆镜或精简参考素材！`);
  }

  const relevantCharacterIds = new Set([
    ...characterIds(db, initial.shot),
    ...refs.map(ref => Number(ref.character_id)).filter(id => id > 0),
    ...((parse(initial.shot.semantic_slots, {})?.visible_characters || []).map(item => Number(item?.id ?? item)).filter(id => id > 0)),
    ...((parse(initial.shot.semantic_slots, {})?.background_characters || []).map(item => Number(item?.id ?? item)).filter(id => id > 0)),
  ]);
  for (const line of speech.lines || []) {
    const match = /^character:(\d+)$/.exec(line.key || '');
    if (match) relevantCharacterIds.add(Number(match[1]));
  }
  const getCharactersSnapshot = () => {
    try {
      if (!relevantCharacterIds.size) return [];
      const placeholders = [...relevantCharacterIds].map(() => '?').join(',');
      return db.prepare(`SELECT * FROM characters WHERE drama_id=? AND id IN (${placeholders}) ORDER BY id`).all(dramaId, ...relevantCharacterIds)
        .map(row => ({
          id: row.id,
          name: row.name,
          local_path: row.local_path || '',
          ref_image_hash: row.ref_image ? hash(row.ref_image) : '',
          image_url_hash: row.image_url ? hash(row.image_url) : '',
          extra_images: row.extra_images || '',
          appearance: row.appearance || '',
          description: row.description || '',
          stages: row.stages || '',
          identity_anchors: row.identity_anchors || '',
          style_tokens: row.style_tokens || '',
          color_palette: row.color_palette || '',
          deleted_at: row.deleted_at || null,
        }));
    } catch (_) { return []; }
  };

  const fingerprintParts = () => {
    const current = load(db, dramaId, shotId);
    const p = previous(db, current.shot);
    const assets = refs.map(r => ({ ...r, version: sourceVersion(root, r.source) }));
    const currentClothing = wardrobe.getShot(db,shotId);
    const usesPrev = usePrevious && !currentClothing.change && !currentClothing.continuity_reset;
    const video = usesPrev ? selectedVideo(db, dramaId, p) : null;
    return {
      shot: shotInputSnapshot(current.shot),
      h3_settings: h3SettingsSnapshot(current),
      wardrobe: currentClothing,
      narrative_style: narrative.fromMetadata(current.project.metadata),
      speech_delivery: narrative.parse(current.project.metadata).speech_delivery?.shots?.[shotId] || null,
      speech: {
        lines: speech.lines || [],
        references: (speech.references || []).map(ref => ({ ...ref, url: ref.url ? hash(ref.url) : '' })),
      },
      assets,
      characters: getCharactersSnapshot(),
      previous_video: usesPrev ? {
        storyboard_id: p?.id || null,
        local_path: video?.local_path || null,
        version: video?.local_path ? sourceVersion(root, video.local_path) : null,
      } : null,
    };
  };
  const startFingerprintParts = fingerprintParts();
  const startFingerprint = hash(startFingerprintParts);
  const assertFingerprintUnchanged = stage => {
    const current = fingerprintParts();
    const changed = Object.keys(startFingerprintParts).filter(key => hash(startFingerprintParts[key]) !== hash(current[key]));
    if (!changed.length) return;
    log.warn?.('[H3] Input changed while preparing request', {
      storyboard_id: shotId,
      stage,
      changed,
      before: Object.fromEntries(changed.map(key => [key, hash(startFingerprintParts[key])])),
      after: Object.fromEntries(changed.map(key => [key, hash(current[key])])),
    });
    throw new Error(`${stage}期间 H3 输入已变化（${changed.join('、')}），请重试`);
  };
  const anchors = executionPlan.mode === 'fl2va'
    ? { first, last: executionPlan.last_frame_policy === 'generate_tail' && last !== first ? last : '' }
    : { first: '', last: '' };

  assertFingerprintUnchanged('准备 H3 素材');
  const lightingDesc = angleService.lightingToPrompt(initial.shot.lighting_style) || '';
  const targetMode = executionPlan.mode;
  const execution = normalizeExecutionPlan(opts.duration, parse(initial.shot.semantic_slots, {}) || {});
  if (execution.execution_backend === 'h3_continuum' && targetMode !== 'ref2va') {
    throw new Error('H3 Continuum 当前只支持 Ref2VA 多参考执行；请恢复 Ref2VA 或让导演按语义拆镜');
  }
  if (targetMode === 'fl2va' && !anchors.first) {
    throw new Error('FL2VA 执行方案缺少首帧输入，禁止静默降级为 Ref2VA');
  }
  const isFl2va = targetMode === 'fl2va';

  if (!isFl2va) {
    assertTightFramingReferences(refs, {
      shot: initial.shot,
      dialogueFraming: initial.shot.dialogue_framing,
      shotType: initial.shot.shot_type,
      visibleCharacters: initial.shot.characters || parse(initial.shot.semantic_slots, {})?.visible_characters,
      backgroundCharacters: initial.shot.background_characters,
      semanticSlots: parse(initial.shot.semantic_slots, {}),
    }, speech);
  }

  const compiled = await stage3.ensureShotH3PromptCompiled(db, log, initial.shot, {
    dramaId,
    project: initial.project,
    clothing,
    lightingDesc,
    aspectRatio: opts.aspect_ratio,
    duration: opts.duration,
    executionPlan,
    refs: isFl2va ? [] : refs,
    anchors,
    speech,
    firstFramePresent: isFl2va && Boolean(anchors.first),
    lastFramePresent: isFl2va && Boolean(anchors.last),
  });
  const prompt = compiled.prompt;
  const images = isFl2va ? [] : refs.map(r => wireImage(root, r.source));
  const mixedReferences = !isFl2va;
  const audioReferences = isFl2va ? [] : speech.references;

  const cacheKey = hash(['h3-native-stage3-v1', H3_STEPS, compiled.fingerprint, anchors, speech.references.map(r => [r.key, hash(r.url)])]);
  const relative = layout.getProjectStorageSubdir(db, dramaId) + '/h3-prompts/' + shotId + '-' + cacheKey + '.json';
  const destination = path.join(root, relative);

  assertFingerprintUnchanged('编译 H3 提示词');
  const [width, height] = nativeCanvas(opts.aspect_ratio);
  const result = {
    input_storyboard: initial.shot,
    input_references: isFl2va ? [{ source: anchors.first, role: 'first_frame' }, ...(anchors.last ? [{ source: anchors.last, role: 'last_frame' }] : [])] : refs.map(r => ({ ...r, role: 'reference_image' })),
    input_fingerprint: startFingerprint,
    prompt,
    reference_urls: images,
    first_frame_url: anchors.first ? wireImage(root, anchors.first) : undefined,
    last_frame_url: anchors.last ? wireImage(root, anchors.last) : undefined,
    image_url: undefined,
    h3_audio_references: audioReferences,
    h3_native: { width, height, steps: H3_STEPS },
    h3_mixed_references: mixedReferences,
    h3_mode: isFl2va ? 'fl2va' : 'ref2va',
    execution_backend: execution.execution_backend,
    continuum_plan: execution.continuum_plan,
  };
  if (compiled.source === 'manual_locked' || compiled.source === 'cache_hit') {
    try {
      db.prepare('UPDATE storyboards SET h3_contract_status=?, updated_at=? WHERE id=?')
        .run('prepared', new Date().toISOString(), Number(shotId));
    } catch (_) {}
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, JSON.stringify({ prompt, fingerprint: compiled.fingerprint, prompt_source: compiled.source, references: refs, previous_storyboard_id: usePrevious ? prev.id : null,
    width, height, steps: H3_STEPS, duration: opts.duration, speech_delivery: delivery, voices: speech.references.map(({ url, ...r }) => r) }, null, 2));
  log.info('[H3] Native reference inputs prepared', { storyboard_id: shotId, mode: isFl2va ? 'fl2va' : 'ref2va', prompt_source: compiled.source, pictures: images.length, voices: audioReferences.length, previous_storyboard_id: usePrevious ? prev.id : null, width, height, prompt_record: relative });
  return result;
}

function sourceVersion(root, source) {
  if (/^(https?:|data:)/i.test(source)) return hash(source);
  const stat = fs.statSync(localFile(root, source));
  return [stat.size, stat.mtimeMs];
}

module.exports = {
  canonicalSource,
  getSettings,
  saveSettings,
  prepare,
  assetReferences,
  sameScene,
  nativeCanvas,
  tailFrame,
  localFile,
  assertTightFramingReferences,
};
