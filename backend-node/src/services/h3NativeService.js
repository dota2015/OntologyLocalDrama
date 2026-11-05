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
const { normalizeExecutionPlan, timelinePrompt } = require('./continuumPlan');

const MODES = ['auto', 'off', 'previous_tail'];
const H3_STEPS = 23;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function parse(value, fallback) { try { return typeof value === 'string' ? JSON.parse(value) : value ?? fallback; } catch { return fallback; } }
function parseH3TimestampSeconds(value) {
  if (value == null || value === '') return NaN;
  const text = String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(text);
  if (!match) return NaN;
  return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}
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
  const engine_mode = shotMeta.engine_mode || metadata.h3_default_engine_mode || 'auto';
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
function sanitizeH3NegativeProse(text, field) {
  if (typeof text !== 'string') return text;
  let out = text.trim();
  if (field === '配乐') {
    if (/\b(no|not|without|avoid|never|none|silence|silent)\b/i.test(out) && !/\b(strings|orchestra|synth|piano|drum|guitar|percussion|melody|theme|track|cue)\b/i.test(out)) {
      return 'N/A';
    }
  }

  // Preserve double-quoted lettering so quoted text is never altered
  const quotes = [];
  out = out.replace(/"[^"\n]{1,300}"/g, (match) => {
    quotes.push(match);
    return `__H3_QUOTE_${quotes.length - 1}__`;
  });

  // 1. Remove whole sentences that state negative existence / absence
  out = out.replace(/(?:^|[.!?]\s*)(?:There\s+(?:is|are)\s+no|No)\s+[^.!?\n]+(?:appears?|is\s+(?:visible|shown|present)|can\s+be\s+seen)?[.!?]*/gi, '. ');

  // 2. Remove comma-separated or parenthetical negative clauses
  out = out.replace(/,\s*(?:strictly\s+)?(?:with\s+no|without|avoiding|avoid|do\s+not|does\s+not|did\s+not|cannot|no)\s+[^,.;:!?\n]+/gi, '');
  out = out.replace(/\s*\([^)]*\b(no|not|without|avoid|never)\b[^)]*\)/gi, '');

  // 3. Common phrase replacements to positive equivalents
  out = out.replace(/\bwithout\s+(?:a\s+)?sound\b/gi, 'silently');
  out = out.replace(/\bwithout\s+hesitation\b/gi, 'decisively');
  out = out.replace(/\bwithout\s+moving\b/gi, 'motionless');
  out = out.replace(/\bwithout\s+stopping\b/gi, 'continuously');
  out = out.replace(/\bnot\s+moving\b/gi, 'motionless');
  out = out.replace(/\bnot\s+sure\b/gi, 'unsure');
  out = out.replace(/\bnot\s+visible\b/gi, 'unseen');
  out = out.replace(/\bcannot\b/gi, 'hardly can');
  out = out.replace(/\b(?:does|do|did)\s+not\b/gi, 'barely');
  out = out.replace(/\b(?:is|are|was|were)\s+not\b/gi, 'is barely');

  // 4. Neutralize residual occurrences of forbidden words
  out = out.replace(/\bwithout\b/gi, 'free of');
  out = out.replace(/\bnever\b/gi, 'rarely');
  out = out.replace(/\bavoiding\b/gi, 'bypassing');
  out = out.replace(/\bavoid\b/gi, 'bypass');
  out = out.replace(/\bno\b/gi, 'zero');
  out = out.replace(/\bnot\b/gi, '');

  // 5. Restore quotes
  out = out.replace(/__H3_QUOTE_(\d+)__/g, (_, idx) => quotes[Number(idx)] || '');

  // 6. Cleanup punctuation and spaces
  out = out.replace(/\s{2,}/g, ' ')
           .replace(/\s*,\s*,+/g, ',')
           .replace(/\s*\.\s*\.+/g, '.')
           .replace(/,\s*\./g, '.')
           .replace(/^\s*[,.]\s*/, '')
           .trim();

  return out;
}

const { stripChineseExclusions } = require('../utils/framePromptSanitize');

function english(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > 12000 || /<\/?d\b|<Audio|<Picture|<Subject|\[Shot/iu.test(value)) {
    throw new Error('H3 英文提示词整理失败（' + field + '），已停止提交，请重试');
  }
  let cleaned = sanitizeH3NegativeProse(value, field);
  if (!cleaned.trim()) {
    if (field === '配乐') return 'N/A';
    cleaned = 'A cinematic continuous shot following the referenced visual context.';
  }
  // Official H3 permits original-language on-screen lettering inside English double quotes.
  const prose = field === '画面' ? cleaned.replace(/"[^"\n]{1,300}"/g, '') : cleaned;
  if (/\p{Script=Han}/u.test(prose)) throw new Error('H3 英文提示词整理失败（' + field + '），已停止提交，请重试');
  if (/\b(no|not|without|avoid|never)\b/i.test(prose)) {
    cleaned = cleaned.replace(/\b(no|not|without|avoid|never)\b/gi, '').replace(/\s{2,}/g, ' ').trim();
  }
  return cleaned.trim();
}

function translatedTimelineDirectionViolations(translated, timeline = []) {
  if (!timeline.length) return [];
  const descriptions = Array.isArray(translated?.shot_descriptions) ? translated.shot_descriptions : [];
  const violations = [];
  timeline.forEach((segment, index) => {
    const expected = (Array.isArray(segment.visible_characters) && segment.visible_characters.length
      ? segment.visible_characters
      : (segment.character_trajectories || []))
      .map(item => Number(item?.character_id ?? item?.id ?? item))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    const directions = Array.isArray(descriptions[index]?.character_directions)
      ? descriptions[index].character_directions
      : [];
    const actual = directions
      .filter(item => String(item?.direction || '').trim())
      .map(item => Number(item?.character_id))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    if (expected.length !== actual.length || expected.some((id, position) => id !== actual[position])) {
      violations.push(`shot_descriptions[${index}].character_directions 必须精确覆盖角色 ID [${expected.join(', ')}]`);
    }
  });
  return violations;
}

function cleanContractText(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function labelledContractText(entries) {
  return entries
    .map(([label, value]) => {
      const text = cleanContractText(value);
      return text ? `${label}：${text}` : '';
    })
    .filter(Boolean)
    .join('；');
}

function trajectoryContractText(item = {}) {
  return labelledContractText([
    ['人物', item.name || (item.character_id != null ? `角色${item.character_id}` : '')],
    ['画面位置', item.screen_position || item.start_anchor],
    ['动作', item.trajectory || item.action],
    ['终态', item.terminal_pose || item.end_action],
    ['表情', item.facial_expression || item.expression_change],
    ['姿态', item.posture],
    ['双手', item.hands],
    ['身体朝向', item.facing],
    ['头部姿态', item.head_pose],
    ['视线', item.gaze],
    ['注意目标', item.attention_target],
    ['视线动机', item.gaze_motivation],
    ['反应触发', item.reaction_trigger],
    ['口型状态', item.mouth_state],
  ]);
}

/**
 * Deterministically projects the authoritative Chinese slots into the fixed text
 * fields consumed by the H3 compiler. No model is allowed to add/remove shots,
 * characters, directions, or timing structure at video-submission time.
 */
function buildDirectH3TextContract(shot, timeline = [], clothing = {}, lightingDesc = '') {
  const semantic = parse(shot?.semantic_slots, {}) || {};
  const persistedVideo = parse(shot?.video_slots, {}) || {};
  const visuals = parse(shot?.character_visuals, []) || [];
  const backgrounds = Array.isArray(semantic.background_characters) ? semantic.background_characters : [];
  const wardrobeCharacters = Array.isArray(clothing?.characters) ? clothing.characters : [];
  const knownCharacters = new Map(
    [...(Array.isArray(semantic.visible_characters) ? semantic.visible_characters : []),
      ...(Array.isArray(semantic.background_characters) ? semantic.background_characters : [])]
      .map((item) => [Number(item?.id ?? item?.character_id), String(item?.name || '').trim()])
      .filter(([id, name]) => Number.isInteger(id) && id > 0 && name)
  );
  const lipMode = String(semantic.audio_lip_sync || persistedVideo.audio_lip_sync?.mode || '').trim();
  const soundPlan = semantic.sound_plan && typeof semantic.sound_plan === 'object' ? semantic.sound_plan : {};
  const incomingContinuity = semantic.continuity_from_previous && typeof semantic.continuity_from_previous === 'object'
    ? semantic.continuity_from_previous
    : null;
  const completeSilence = soundPlan.is_silent === true || shot?.is_silent === true;
  const ambientOnly = lipMode === 'silent_ambient';
  const bgmOnly = lipMode === 'bgm_only';
  const noSpeech = completeSilence || ambientOnly || bgmOnly;
  const noSpeechVisualContract = noSpeech
    ? '画内所有人物全程保持双唇自然闭合，以视线、手势、姿态和面部表情完成交流'
    : '';
  const visualDescription = [
    noSpeechVisualContract,
    labelledContractText([
      ['场景', shot?.location],
      ['时间', shot?.time],
      ['画面事件', shot?.description],

      ['构图关系', shot?.dialogue_framing],
      ['起幅', shot?.start_framing],
      ['落幅', shot?.end_framing],
      ['转场', shot?.transition_to_next],
      ['承接上一镜', incomingContinuity ? [
        incomingContinuity.relationship,
        `上一镜结束：${incomingContinuity.previous_end_state || ''}`,
        `本镜进入：${incomingContinuity.entry_state || ''}`,
        `因果：${incomingContinuity.causal_link || ''}`,
        incomingContinuity.sound_bridge ? `声音延续：${incomingContinuity.sound_bridge}` : '',
      ].filter(Boolean).join('；') : '首镜开场或未规划上一镜承接'],
      ['布局', shot?.layout_description],
      ['光影', lightingDesc || shot?.lighting_style],
      ['氛围', shot?.atmosphere],
    ]),
    ...visuals.map(v => `初始状态：${trajectoryContractText(v)}`),
    ...backgrounds.map(v => `初始后景：${trajectoryContractText(v)}`),
    ...wardrobeCharacters.map(item => labelledContractText([
      ['人物造型', item.name || (item.id != null ? `角色${item.id}` : '')],
      ['服装', item.description || item.appearance],
    ])),
  ].filter(Boolean).join('。');

  const shotDescriptions = timeline.map((segment, index) => ({
    shot_number: Number(segment.shot_number || index + 1),
    description: labelledContractText([
      ['本段画内人物', (Array.isArray(segment.visible_characters) ? segment.visible_characters : [])
        .map((item) => String(item?.name || knownCharacters.get(Number(item?.character_id ?? item?.id)) || '').trim())
        .filter(Boolean).join('、')],
      ['镜内节拍', segment.beat || segment.visual_action || segment.action],
      ['动作结果', segment.result],
      ['景别', segment.shot_size || segment.camera?.shot_type],
      ['运镜', segment.camera_move || segment.camera?.movement || segment.camera?.movement_description],
    ]) || `按第${index + 1}个既定镜头节拍执行`,
    character_directions: (segment.character_trajectories || []).map(item => ({
      character_id: Number(item.character_id),
      direction: trajectoryContractText(item),
    })),
  }));

  const soundEffects = Array.isArray(soundPlan.sound_effects) ? soundPlan.sound_effects.filter(Boolean).join('；') : '';
  const naturalSounds = labelledContractText([
    ['环境声', soundPlan.acoustic_env],
    ['音效', soundEffects || shot?.sound_effect],
  ]) || '符合场景空间的自然环境声和物理动作音效';
  const requestedMusic = cleanContractText(soundPlan.bgm_prompt || shot?.bgm_prompt);
  return {
    visual_description: visualDescription || '按已规划的分镜构图、人物动作和场景连续性执行',
    shot_descriptions: shotDescriptions,
    overall_soundscape: completeSilence || bgmOnly
      ? 'N/A'
      : (ambientOnly ? `场景声轨采用环境声和物理动作音效：${naturalSounds}` : naturalSounds),
    non_diegetic_music: completeSilence || ambientOnly
      ? 'N/A'
      : (bgmOnly && requestedMusic ? `纯器乐配乐：${requestedMusic}` : (requestedMusic || 'N/A')),
  };
}

function directH3Text(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > 24000 || /<\/?d\b|<Audio|<Picture|<Subject|\[Shot/iu.test(value)) {
    throw new Error(`H3 中文提示词编译失败（${field}）`);
  }
  return value.trim();
}

function compileFl2vaPrompt(translated, timeline = [], options = {}) {
  if (!translated || typeof translated !== 'object' || Array.isArray(translated)) {
    throw new Error('H3 英文提示词整理未返回有效内容，请重试');
  }
  const text = options.allowChinese ? directH3Text : english;
  const visual = text(translated.visual_description, '画面');
  const ambience = text(translated.overall_soundscape, '环境音');
  const music = text(translated.non_diegetic_music, '配乐');
  const descriptions = Array.isArray(translated.shot_descriptions) ? translated.shot_descriptions : [];
  const speechLines = Array.isArray(options.speech?.lines) ? options.speech.lines : [];
  const speakerIds = new Map();
  const seenSpeech = new Set();
  const speechKey = (kind, speaker, content) => [kind || 'dialogue', speaker || '', String(content || '').replace(/\s+/gu, '')].join('|');
  const renderSpeech = (kind, speaker, content) => {
    const value = String(content || '').trim();
    if (!value) return '';
    if (/<\/?d\b|<Audio|<Subject|<Picture/iu.test(value)) throw new Error('台词含 H3 控制标签，请在编辑文本中移除');
    const key = kind === 'narration' ? 'narrator' : `speaker:${speaker || '未标注人物'}`;
    if (!speakerIds.has(key)) speakerIds.set(key, speakerIds.size + 1);
    const id = speakerIds.get(key);
    const language = /\p{Script=Han}/u.test(value) ? 'Chinese' : 'English';
    if (kind === 'narration') {
      return `The narrator (S${id}) says in an off-screen voiceover: <d>[${language}] ${value}</d> while every visible character keeps their lips naturally closed.`;
    }
    return `The on-screen character ${JSON.stringify(speaker || 'the speaker')} (S${id}) says: <d>[${language}] ${value}</d> and closes their lips after the final word.`;
  };
  const segmentSpeech = (segment, index) => {
    const lip = segment?.audio_lip_sync && typeof segment.audio_lip_sync === 'object' ? segment.audio_lip_sync : {};
    const content = String(lip.dialogue_content || '').trim();
    let candidates = [];
    if (content) {
      const match = speechLines.find((line) => String(line.text || '').replace(/\s+/gu, '') === content.replace(/\s+/gu, ''));
      candidates = [match || {
        kind: lip.mode === 'narration' ? 'narration' : 'dialogue',
        speaker: lip.speaker_name || '',
        text: content,
      }];
    } else if (index === 0) {
      candidates = speechLines;
    }
    return candidates.map((line) => {
      const key = speechKey(line.kind, line.speaker, line.text);
      if (seenSpeech.has(key)) return '';
      seenSpeech.add(key);
      return renderSpeech(line.kind, line.speaker, line.text);
    }).filter(Boolean).join(' ');
  };
  let picture;
  if (timeline.length) {
    if (descriptions.length !== timeline.length) throw new Error('H3 英文提示词整理未完整返回短剧镜内剪辑段，请重试');
    picture = timeline.map((segment, index) => {
      const translatedSegment = descriptions[index];
      const description = text(
        typeof translatedSegment === 'string' ? translatedSegment : translatedSegment?.description,
        `镜内剪辑段${index + 1}`
      );
      const directions = Array.isArray(translatedSegment?.character_directions)
        ? translatedSegment.character_directions.map((item, directionIndex) => text(
            item?.direction,
            `镜内剪辑段${index + 1}角色视线${directionIndex + 1}`
          )).join(' ')
        : '';
      const spoken = segmentSpeech(segment, index);
      const beatDescription = [spoken, description, directions].filter(Boolean).join(' ');
      return index === 0
        ? `[Shot 1] ${beatDescription}`
        : `[Shot ${index + 1}] At ${segment.timestamp}, the camera cuts to the next short-drama beat. ${beatDescription}`;
    }).join('\n');
  } else {
    const spoken = speechLines.map((line) => {
      const key = speechKey(line.kind, line.speaker, line.text);
      if (seenSpeech.has(key)) return '';
      seenSpeech.add(key);
      return renderSpeech(line.kind, line.speaker, line.text);
    }).filter(Boolean).join(' ');
    picture = `[Shot 1] ${spoken} ${visual}`.trim();
  }
  return `integrated_multimodal_description: ${visual}\n${picture}\n\noverall_soundscape:\n${ambience}\n\nnon_diegetic_music:\n${music}`;
}

function compilePrompt(refs, speech, translated, anchors = {}, options = {}) {
  if (!translated || typeof translated !== 'object' || Array.isArray(translated)) throw new Error('H3 英文提示词整理未返回有效内容，请重试');
  const lightingDesc = options.lightingDesc || (options.lightingStyle ? angleService.lightingToPrompt(options.lightingStyle) : '') || '';

  const framing = String(options.dialogueFraming || options.shot?.dialogue_framing || options.framing || '').toLowerCase();
  const shotType = String(options.shotType || options.shot?.shot_type || options.shot?.camera?.shot_type || '').toLowerCase();
  const framingNorm = framing.replace(/[-\s]/g, '_');
  const isTightFraming = /(?:over_the_shoulder|two_shot_close|single_close|ots_reverse|two_shot_face_to_face|single_reaction|close_up|extreme_close_up|ots)/i.test(framingNorm)
    || /(?:近景|特写|大特写|过肩|正反打|反打|双人对话)/i.test(`${framing} ${shotType}`);

  const isSingleFraming = /(?:single_close|single_reaction|close_up|extreme_close_up|solo_action|single_focus)/i.test(framingNorm)
    || /(?:特写|大特写)/i.test(`${framing} ${shotType}`);
  const isTwoShotFraming = /(?:over_the_shoulder|two_shot_close|ots_reverse|two_shot_face_to_face|ots|过肩|正反打|反打|双人)/i.test(`${framingNorm} ${shotType}`);
  const maxFocalSubjects = isSingleFraming ? 1 : (isTwoShotFraming ? 2 : 3);

  const rawBg = options.backgroundCharacters
    || options.backgroundCharacterIds
    || options.shot?.background_characters
    || (typeof options.shot?.semantic_slots === 'object' ? options.shot?.semantic_slots?.background_characters : null)
    || (typeof options.semanticSlots === 'object' ? options.semanticSlots?.background_characters : null);
  const bgIds = new Set();
  (Array.isArray(rawBg) ? rawBg : (typeof rawBg === 'string' ? parse(rawBg, []) : []))
    .forEach(c => {
      const id = Number(c?.character_id ?? c?.id ?? c);
      if (Number.isFinite(id) && id > 0) bgIds.add(id);
    });
  const charVisuals = options.shot?.character_visuals
    || (typeof options.shot?.character_visuals === 'string' ? parse(options.shot.character_visuals, []) : []);
  if (Array.isArray(charVisuals)) {
    charVisuals.forEach(cv => {
      if (cv && cv.depth_layer === 'background' && cv.character_id != null) {
        const id = Number(cv.character_id);
        if (Number.isFinite(id) && id > 0) bgIds.add(id);
      }
    });
  }
  refs.forEach(r => {
    if ((r.depth_layer === 'background' || r.is_background) && r.character_id != null) {
      const id = Number(r.character_id);
      if (Number.isFinite(id) && id > 0) bgIds.add(id);
    }
  });

  const rawVisible = options.visibleCharacters
    || options.shot?.visible_characters
    || (typeof options.shot?.semantic_slots === 'object' ? options.shot?.semantic_slots?.visible_characters : null)
    || (typeof options.semanticSlots === 'object' ? options.semanticSlots?.visible_characters : null);
  const visibleIds = new Set();
  if (rawVisible) {
    (Array.isArray(rawVisible) ? rawVisible : (typeof rawVisible === 'string' ? parse(rawVisible, []) : []))
      .forEach(c => {
        const id = Number(c?.character_id ?? c?.id ?? c);
        if (Number.isFinite(id) && id > 0) visibleIds.add(id);
      });
    for (const line of speech?.lines || []) {
      const match = /^character:(\d+)$/.exec(line?.key || '');
      if (match) visibleIds.add(Number(match[1]));
    }
  }

  const subjects = new Map();
  const definitions = [];
  const retention = [];
  for (const [i, ref] of refs.entries()) {
    const pic = `<Picture ${i+1}>`;
    const refCharId = ref.character_id != null ? Number(ref.character_id) : null;
    const isKnownSubject = refCharId && subjects.has(refCharId);
    const isBackgroundInTight = Boolean(
      isTightFraming &&
      refCharId &&
      !isKnownSubject &&
      (
        bgIds.has(refCharId) ||
        (visibleIds.size > 0 && !visibleIds.has(refCharId)) ||
        subjects.size >= maxFocalSubjects
      )
    );
    if (refCharId && !isBackgroundInTight && !subjects.has(refCharId)) {
      subjects.set(refCharId, subjects.size + 1);
    }
    if (isBackgroundInTight) {
      definitions.push(`${pic} supplies secondary context for a background character in [Shot 1].`);
      retention.push(`${pic} (background character context): secondary - provide general appearance context only; do not cast as a primary foreground subject.`);
    } else if (ref.kind === 'character_outfit') {
      definitions.push(`${pic} supplies the selected outfit for this character in [Shot 1]. The same character's portrait and profile references define facial identity.`);
      retention.push(`${pic} (selected outfit in [Shot 1]): fully_preserved - retain garment colors, shape, layers and accessories consistently throughout this shot.`);
    } else if (ref.kind === 'character_sheet' || ref.kind === 'character') {
      definitions.push(`${pic} is a multi-panel character reference sheet: its face portrait and side-profile panels define identity; its full-front view supplies base clothing when an opening-frame wardrobe anchor is absent. The sheet is reference material for one person.`);
      retention.push(`${pic} (character sheet in [Shot 1]): partially_preserved - transfer the facial identity from the face and profile panels; clothing follows the opening-frame wardrobe anchor when present, otherwise the established current costume.`);
    } else if (!ref.character_id && ref.source !== anchors.first && ref.source !== anchors.last) {
      definitions.push(`${pic} supplies ${ref.kind === 'scene' ? 'the environment and lighting' : 'additional scene, prop, or composition context'} for [Shot 1].`);
      retention.push(`${pic} (context in [Shot 1]): fully_preserved - retain its assigned scene or prop role.`);
    }
    if (ref.source === anchors.first || ref.source === anchors.last) {
      const role = ref.source === anchors.first ? 'opening' : 'ending';
      definitions.push(`${pic} is the ${role} frame composition anchor of [Shot 1]. At ${role === 'opening' ? 'second 0.0' : 'the conclusion'}, the video matches this composition.`);
      const lightingNote = role === 'opening' && lightingDesc
        ? ` strictly retain the supplied opening frame composition, exact character staging, lighting scheme (${lightingDesc}), and shadow depth at the start of the shot.`
        : ` strictly retain the supplied ${role} frame composition and visual staging at its timeline anchor.`;
      retention.push(`${pic} ([Shot 1] ${role}): fully_preserved -${lightingNote}`);
    }
  }
  for (const [id, index] of subjects) {
    const pictures = refs.flatMap((r, i) => r.character_id === id ? [`<Picture ${i+1}>`] : []);
    definitions.push(`<Subject ${index}> is the same person across ${pictures.join(', ')}. Follow the referenced facial features, face shape, age and hair; portrait/profile panels define identity. ${anchors.first ? 'The supplied opening frame defines' : 'The selected costume reference and planned clothing define'} the current outfit, preserved throughout the video.`);
    retention.push(`<Subject ${index}> (appears in [Shot 1]): fully_preserved - preserve the referenced identity, age and hairstyle; preserve the selected outfit and accessories throughout this video.`);
  }
  const soundtrackIndex = speech.references.findIndex(ref => ref.kind === 'soundtrack');
  const uniqueSpeakerKeys = [...new Set(speech.lines.map(line => line.key))];
  const speakerIds = new Map(uniqueSpeakerKeys.map((key, index) => [key, index + 1]));
  for (const [i, ref] of speech.references.entries()) {
    if (ref.kind === 'soundtrack') {
      definitions.push(`<Audio ${i+1}> is the exact complete speech soundtrack for [Shot 1], with every spoken word, speaker turn, timing, pace, and silence already fixed.`);
      retention.push(`<Audio ${i+1}>: fully_copy - reuse <Audio ${i+1}> 1:1 as the target video's complete final audio track, preserving every word and its exact timing.`);
      continue;
    }
    const characterId = /^character:(\d+)$/.exec(ref.key)?.[1];
    const subject = subjects.get(Number(characterId));
    const who = ref.kind === 'narration' ? 'the off-screen narrator' : subject ? `<Subject ${subject}>` : 'an off-screen speaker';
    definitions.push(`<Audio ${i+1}> is the voice-timbre reference for ${who} (S${i+1}).`);
    retention.push(`<Audio ${i+1}>: reference - use its vocal timbre for the new dialogue; the project delivery instructions below govern speech pace.`);
  }
  const events = speech.lines.map((line, lineIndex) => {
    const speaker = speakerIds.get(line.key);
    const matchingAudio = speech.references.findIndex(ref => ref.key === line.key);
    const audio = matchingAudio >= 0 ? matchingAudio + 1 : soundtrackIndex >= 0 ? soundtrackIndex + 1 : 0;
    if (!speaker || !audio) throw new Error('H3 说话人与参考声音编号不一致');
    if (/<\/?d\b|<Audio|<Subject|<Picture/iu.test(line.text)) throw new Error('台词含 H3 控制标签，请在编辑文本中移除');
    const subject = subjects.get(Number(/^character:(\d+)$/.exec(line.key)?.[1]));
    const actor = line.kind === 'narration' ? 'The narrator' : subject ? `<Subject ${subject}>` : 'The off-screen speaker';
    const offScreen = line.kind === 'narration' || !subject;
    const exactEvent = speech.soundtrack?.events?.[lineIndex];
    const exactStart = Number(exactEvent?.start_seconds);
    const exactEnd = Number(exactEvent?.end_seconds);
    const hasExactTiming = Number.isFinite(exactStart) && Number.isFinite(exactEnd) && exactStart >= 0 && exactEnd > exactStart;
    const timing = hasExactTiming ? `from second ${exactStart.toFixed(2)} through second ${exactEnd.toFixed(2)}` : 'from the opening beat';
    const action = offScreen ? `says in an off-screen voiceover ${timing}` : `speaks ${timing} following the planned character direction`;
    const closing = offScreen
      ? 'During this voiceover, visible characters continue their planned actions and reactions; their lips stay closed except during their own explicitly planned spoken lines.'
      : 'After this line completes, the speaker stops speaking until their next planned line and continues the planned actions and reactions.';
    const language = /\p{Script=Han}/u.test(line.text) ? 'Chinese' : 'English';
    const audioInstruction = soundtrackIndex >= 0
      ? `synchronized exactly to the copied waveform in <Audio ${audio}>`
      : `using the vocal timbre referenced from <Audio ${audio}>`;
    return {
      prompt: `${actor} (S${speaker}), ${audioInstruction}, ${action}, <d>[${language}] ${line.text}</d> ${closing}`,
      start_seconds: hasExactTiming ? exactStart : null,
      end_seconds: hasExactTiming ? exactEnd : null,
      has_exact_timing: hasExactTiming,
    };
  });
  const text = options.allowChinese ? directH3Text : english;
  const visual = text(translated.visual_description, '画面');
  const ambience = text(translated.overall_soundscape, '环境音');
  const music = text(translated.non_diegetic_music, '配乐');
  const openingIdx = anchors.first ? refs.findIndex(r => r.source === anchors.first) : -1;
  const opening = openingIdx >= 0
    ? `The shot begins strictly from <Picture ${openingIdx + 1}> at second 0.0, faithfully preserving the visual composition, framing, camera angle, character placement, attire, and lighting shown in <Picture ${openingIdx + 1}>. All physical action and dialogue emerge progressively from this established initial state.`
    : '';
  const endingIdx = anchors.last ? refs.findIndex(r => r.source === anchors.last) : -1;
  const ending = endingIdx >= 0 ? `The shot ends on <Picture ${endingIdx + 1}>.` : '';
  const countRule = subjects.size > 0
    ? `[Subject Count] The scene features exactly ${subjects.size} character${subjects.size > 1 ? 's' : ''}: ${[...subjects.values()].map(n => `<Subject ${n}>`).join(' and ')} in focused cinematic composition.`
    : '';
  const lightingSentence = lightingDesc ? ` The scene consistently maintains ${lightingDesc}.` : '';
  const timeline = Array.isArray(options.timeline) ? options.timeline : [];
  const rawShotDescriptions = Array.isArray(translated.shot_descriptions) ? translated.shot_descriptions : [];
  let detailedTimeline = '';
  if (timeline.length) {
    if (rawShotDescriptions.length !== timeline.length) throw new Error('H3 英文提示词整理未完整返回短剧镜内剪辑段，请重试');
    const hasDuration = Number(options.duration) > 0;
    const deadline = hasDuration ? Number(options.duration) : null;
    let segmentStart = 0;
    const timedSegments = timeline.map((segment) => {
      const explicitStart = parseH3TimestampSeconds(segment.timestamp);
      const start = Number.isFinite(explicitStart) ? explicitStart : segmentStart;
      const duration = Number(segment.duration || 0);
      const end = start + (Number.isFinite(duration) && duration > 0 ? duration : 0);
      segmentStart = end;
      return { start, end };
    });
    const hasExactEventTiming = events.length > 0 && events.every(event => event.has_exact_timing);
    detailedTimeline = timeline.map((segment, index) => {
      const translatedSegment = rawShotDescriptions[index];
      const description = text(
        typeof translatedSegment === 'string' ? translatedSegment : translatedSegment?.description,
        `镜内剪辑段${index + 1}`
      );
      const activeSubjects = (Array.isArray(segment.visible_characters) && segment.visible_characters.length
        ? segment.visible_characters
        : (segment.character_trajectories || [])).map(t => subjects.get(Number(t?.character_id ?? t?.id ?? t)))
        .filter(Boolean).filter((value, position, all) => all.indexOf(value) === position)
        .map(value => `<Subject ${value}>`).join(' and ');
      const subjectCue = activeSubjects ? `${activeSubjects} are the visible subjects in this shot segment and follow only their individually specified action progression, reactions, eyelines, and end states. ` : 'This shot segment contains no visible character; keep the declared environment and camera composition. ';
      const directionById = new Map(
        (Array.isArray(translatedSegment?.character_directions) ? translatedSegment.character_directions : [])
          .map(item => [Number(item?.character_id), item])
          .filter(([id]) => Number.isFinite(id))
      );
      const directionCue = (segment.character_trajectories || []).map((trajectory, directionIndex) => {
        const id = Number(trajectory?.character_id);
        const subject = subjects.get(id);
        const translatedDirection = directionById.get(id);
        if (!subject || !translatedDirection?.direction) return '';
        const direction = text(translatedDirection.direction, `镜内剪辑段${index + 1}角色视线${directionIndex + 1}`);
        return `<Subject ${subject}> ${direction}`;
      }).filter(Boolean).join(' ');
      const boundDirectionCue = directionCue ? `Character direction: ${directionCue} ` : '';
      const segmentTiming = timedSegments[index];
      const startsHere = hasExactEventTiming
        ? events.filter((event) => event.start_seconds >= segmentTiming.start - 0.001 && event.start_seconds < segmentTiming.end - 0.001)
        : (index === 0 ? events : []);
      const crossesInto = hasExactEventTiming && index > 0
        ? events.some((event) => event.start_seconds < segmentTiming.start - 0.001 && event.end_seconds > segmentTiming.start + 0.001)
        : false;
      const crossesOut = hasExactEventTiming && index < timeline.length - 1
        ? events.some((event) => event.start_seconds < segmentTiming.end - 0.001 && event.end_seconds > segmentTiming.end + 0.001)
        : false;
      const transitionIn = crossesInto ? '<scenetrans> The utterance already in progress continues seamlessly across this cut, preserving its current vocal position and exact remaining word order. ' : '';
      const transitionOut = crossesOut ? ' <scenetrans>' : '';
      const speechAtBeat = startsHere.map(event => event.prompt).join(' ');
      if (index === 0) {
        const speechDeadline = events.length
          ? `CRITICAL SPEECH DEADLINE: follow every stated utterance time and ${deadline == null ? 'complete every final word within the declared shot duration' : `complete every final word by second ${deadline.toFixed(1)}; use all remaining planned time for the ongoing action or reaction`}. ${speechAtBeat}${transitionOut} `
          : '';
        return `[Shot 1] ${opening} ${speechDeadline}${subjectCue}${boundDirectionCue}${description}`;
      }
      const spokenCue = speechAtBeat ? `${speechAtBeat} ` : '';
      return `[Shot ${index + 1}] At ${segment.timestamp}, the camera cuts to the next short-drama beat. ${transitionIn}${spokenCue}${subjectCue}${boundDirectionCue}${description}${transitionOut}`;
    }).join('\n');
  } else {
    const hasDuration = Number(options.duration) > 0;
    const deadline = hasDuration ? Number(options.duration) : null;
    const speechDeadline = events.length
      ? `CRITICAL SPEECH DEADLINE: Dialogue follows the stated timing and ${deadline == null ? 'completes every final word within the declared shot duration' : `completes every final word by second ${deadline.toFixed(1)}`}. The planned action and reaction continue in sync with speech, and the shot ends at the declared boundary. ${events.map(event => event.prompt).join(' ')}`
      : '';
    detailedTimeline = `[Shot 1] ${opening} ${speechDeadline} ${visual}`;
  }
  if (timeline.length) detailedTimeline = `${visual}\n${detailedTimeline}`;
  const editSummary = timeline.length > 1 ? `A ${timeline.length}-shot edit` : 'A single continuous shot';
  const audioTask = soundtrackIndex >= 0 ? ' + audio reuse' : speech.references.length ? ' + audio reference' : '';
  const soundscape = soundtrackIndex >= 0
    ? `<Audio ${soundtrackIndex + 1}> is directly reused as the complete final audio track; preserve its speech and silence exactly.`
    : ambience;
  const finalMusic = soundtrackIndex >= 0 ? 'N/A' : music;
  return `subject_definitions:\n${definitions.join('\n') || 'The scene is described in [Shot 1].'}\n\nsummary:\n[${anchors.first || anchors.last ? 'keyframe completion + ' : ''}reference generation${audioTask}] ${editSummary} follows the supplied visual references and the spoken timeline below.\n\nretention_analysis:\n${retention.join('\n') || 'The visual scene follows the description below.'}\n\ndetailed_description:\nThe video uses a natural cinematic style with consistent identity, lighting, and spatial continuity.${lightingSentence} One outfit per character is established before the shot starts. Clothing stays consistent through every cut and the ending frame.\n${countRule ? countRule + '\n' : ''}${narrative.h3Delivery(speech.narrative_style)}\n${detailedTimeline}\n${ending} The planned action progression reaches its specified end state at the end of the shot.\n\noverall_soundscape:\n${soundscape}\n\nnon_diegetic_music:\n${finalMusic}`;
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

  // A timbre sample cannot tell H3 the exact utterance timing. For production
  // Ref2VA jobs, synthesize the authoritative lines first and provide that
  // complete track to H3 as its audio input. The generated H3 audio remains the
  // final soundtrack; this reference is never remuxed over the downloaded video.
  let exactSpeechTrack = null;
  if (executionPlan.mode === 'ref2va' && opts.video_gen_id && speech.lines.length) {
    exactSpeechTrack = await require('./h3SpeechTrackService').prepare(
      db, log, dramaId, shotId, root, speech.lines, opts.duration, delivery
    );
    if (exactSpeechTrack) {
      speech.references = [{
        key: 'soundtrack',
        kind: 'soundtrack',
        speaker: '完整台词音轨',
        url: exactSpeechTrack.url,
      }];
      speech.soundtrack = exactSpeechTrack;
      const record = db.prepare('SELECT resolution_plan FROM video_generations WHERE id=?').get(Number(opts.video_gen_id));
      let savedPlan = {};
      try { savedPlan = JSON.parse(record?.resolution_plan || '{}'); } catch {}
      savedPlan.h3_speech_reference = {
        local_path: exactSpeechTrack.local_path,
        source_hash: exactSpeechTrack.source_hash,
        speech_end_seconds: exactSpeechTrack.speech_end_seconds,
        speech_rate: exactSpeechTrack.speech_rate,
        events: exactSpeechTrack.events,
      };
      db.prepare('UPDATE video_generations SET resolution_plan=? WHERE id=?')
        .run(JSON.stringify(savedPlan), Number(opts.video_gen_id));
    }
  }

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
  // The Director-owned JSON structure is already authoritative. At submission time
  // we only project its text leaves into H3's fixed prompt sections; no second LLM
  // may rewrite shots, character directions, timing, or eyeline contracts.
  const translated = buildDirectH3TextContract(initial.shot, videoTimeline, clothing, lightingDesc);
  const translationViolations = translatedTimelineDirectionViolations(translated, videoTimeline);
  if (translationViolations.length) {
    throw new Error(`H3 中文提示词未完整保留角色视线合同：${translationViolations.join('；')}`);
  }
  const cacheKey = hash(['h3-native-v14-speech-independent-actions', H3_STEPS, speech.narrative_style, translated, startFingerprint, anchors, speech.references.map(r => [r.key, hash(r.url)])]);
  const relative = layout.getProjectStorageSubdir(db, dramaId) + '/h3-prompts/' + shotId + '-' + cacheKey + '.json';
  const destination = path.join(root, relative);
  const targetMode = executionPlan.mode;
  const execution = normalizeExecutionPlan(opts.duration, parse(initial.shot.semantic_slots, {}) || {});
  if (execution.execution_backend === 'h3_continuum' && targetMode !== 'ref2va') {
    throw new Error('H3 Continuum 当前只支持 Ref2VA 多参考执行；请恢复 Ref2VA 或让导演按语义拆镜');
  }
  if (targetMode === 'fl2va' && !anchors.first) {
    throw new Error('FL2VA 执行方案缺少首帧输入，禁止静默降级为 Ref2VA');
  }
  const isFl2va = targetMode === 'fl2va';

  let prompt;
  let images = [];
  let mixedReferences = false;
  let audioReferences = [];

  if (isFl2va) {
    // 纯血首帧强绑定模式 (FL2VA)：
    // 仅以首帧（及可选尾帧）为绝对视觉基准，不传入人物卡与场景卡（避免特征争抢导致的跳脸漂移）
    // 台词由结构化 speech_plan 编译为 <d> 交给 H3 原生生成；FL2VA 不附加参考音频，
    // 成片下载后也不会用外部音轨替换 H3 音轨。
    prompt = compileFl2vaPrompt(translated, videoTimeline, { allowChinese: true, speech });
    images = [];
    mixedReferences = false;
    audioReferences = [];
  } else {
    // 多参考角色一致性模式 (Ref2VA)：
    // 只使用 Agent 规划的人物、场景、道具和声音参考；不混入首帧、尾帧或 AddGuide。
    prompt = compilePrompt(refs, speech, translated, anchors, {
      lightingDesc,
      lightingStyle: initial.shot.lighting_style,
      timeline: videoTimeline,
      delivery,
      duration: opts.duration,
      allowChinese: true,
      shot: initial.shot,
      dialogueFraming: initial.shot.dialogue_framing,
      shotType: initial.shot.shot_type,
      visibleCharacters: initial.shot.characters || parse(initial.shot.semantic_slots, {})?.visible_characters,
      backgroundCharacters: initial.shot.background_characters,
      semanticSlots: parse(initial.shot.semantic_slots, {}),
    });
    images = refs.map(r => wireImage(root, r.source));
    mixedReferences = true;
    audioReferences = speech.references;
  }

  if (execution.execution_backend === 'h3_continuum') {
    const continuumTimeline = timelinePrompt(videoTimeline, opts.duration);
    if (continuumTimeline) {
      prompt += `\n\nContinuum timeline (the chunks must preserve this causal progression):\n${continuumTimeline}`;
    }
  }

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
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, JSON.stringify({ prompt, translation: translated, references: refs, previous_storyboard_id: usePrevious ? prev.id : null,
    width, height, steps: H3_STEPS, duration: opts.duration, speech_delivery: delivery, voices: speech.references.map(({ url, ...r }) => r) }, null, 2));
  log.info('[H3] Native reference inputs prepared', { storyboard_id: shotId, mode: isFl2va ? 'fl2va' : 'ref2va', pictures: images.length, voices: audioReferences.length, previous_storyboard_id: usePrevious ? prev.id : null, width, height, prompt_record: relative });
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
  compilePrompt,
  compileFl2vaPrompt,
  buildDirectH3TextContract,
  assetReferences,
  sameScene,
  nativeCanvas,
  tailFrame,
  localFile,
  sanitizeH3NegativeProse,
  stripChineseExclusions,
  english,
};
