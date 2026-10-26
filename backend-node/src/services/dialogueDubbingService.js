const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const { getFfmpegPath } = require('../utils/ffmpegPath');
const tts = require('./ttsService');
const tasks = require('./taskService');
const extraction = require('./speechExtractionService');

function parseJson(value, fallback = {}) {
  try { return typeof value === 'string' ? JSON.parse(value) : (value || fallback); } catch (_) { return fallback; }
}
function speakerName(value) {
  return String(value || '').replace(/[（(][^）)]*[）)]/gu, '').trim();
}
function cleanText(value) {
  const s = String(value || '').trim();
  if (/^(?:无|无对白|无对话|无台词|none|null|n\/a|silent)[。.!！\s]*$/iu.test(s)) return '';
  return s.replace(/^[“”"「」『』']+|[“”"「」『』']+$/gu, '').trim();
}
// Split explicit speaker labels while keeping quoted punctuation/colons inside speech.
function dialogueSegments(value) {
  const text = String(value || '').trim();
  if (!cleanText(text)) return [];
  const label = /(?:^|[\n\r；;]|(?<=[”"」』]))\s*([\p{L}\p{N}_· @（）() .-]{1,40})[：:]\s*/gu;
  const matches = Array.from(text.matchAll(label));
  if (!matches.length) return [{ speaker: '', text: cleanText(text) }];
  const result = [];
  const prefix = cleanText(text.slice(0, matches[0].index));
  if (prefix) result.push({ speaker: '', text: prefix });
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const line = cleanText(text.slice(m.index + m[0].length, matches[i + 1]?.index ?? text.length));
    if (line) result.push({ speaker: speakerName(m[1]), text: line });
  }
  return result;
}
function dramaRow(db, id) {
  const row = db.prepare('SELECT id, metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!row) throw new Error('剧集不存在');
  return row;
}
function getProfile(db, id) {
  const metadata = parseJson(dramaRow(db, id).metadata);
  const raw = metadata.tts_dubbing || {};
  return metadata.narrative_style ? { ...raw, speed: require('./narrativeStyleService').fromMetadata(metadata).speech_rate } : raw;
}
function configFor(db, configId) {
  const service = require('./aiConfigService');
  const configs = service.listConfigs(db, 'tts').filter(c => c.is_active);
  const config = configId ? configs.find(c => Number(c.id) === Number(configId)) : (configs.find(c => c.is_default) || configs[0]);
  if (!config) throw new Error('请先在 AI 配置中启用 TTS 服务');
  return config;
}
const EDGE_VOICES = ['zh-CN-YunjianNeural', 'zh-CN-YunxiNeural', 'zh-CN-YunxiaNeural', 'zh-CN-XiaoyiNeural', 'zh-CN-XiaoxiaoNeural', 'zh-CN-YunyangNeural'];
const INDEXTTS_VOICES = ['voice_01.wav', 'voice_02.wav', 'voice_03.wav', 'voice_04.wav', 'voice_05.wav', 'voice_06.wav', 'voice_07.wav', 'voice_08.wav', 'voice_09.wav', 'voice_11.wav', 'voice_12.wav'];
function normalizedProfile(db, id, raw = {}) {
  dramaRow(db, id);
  const config = configFor(db, raw.config_id);
  const speed = Number(raw.speed ?? getProfile(db, id).speed ?? 1);
  if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) throw new Error('语速需在 0.5–2 之间');
  const voices = Object.create(null);
  for (const [name, voice] of Object.entries(raw.voices || {})) {
    if (name.length > 80 || typeof voice !== 'string' || voice.length > 200) throw new Error('角色音色设置无效');
    voices[speakerName(name)] = voice.trim();
  }
  const edge = /^(edge-tts|edgetts|edge)$/i.test(config.provider);
  const indextts = /^(indextts|indextts2|indextts25)$/i.test(config.provider) || (config.base_url && /7860/i.test(config.base_url));
  const defaultVoice = String(raw.default_voice || (edge ? 'zh-CN-YunjianNeural' : (indextts ? 'voice_03.wav' : ''))).trim();
  const narrator = String(raw.narrator_voice || (edge ? 'zh-CN-YunyangNeural' : (indextts ? 'voice_08.wav' : ''))).trim();
  if (defaultVoice.length > 200 || narrator.length > 200) throw new Error('音色 ID 过长');
  const characters = db.prepare('SELECT id, name, description, appearance, voice_style FROM characters WHERE drama_id = ? AND deleted_at IS NULL ORDER BY sort_order, id').all(Number(id));
  const characterVoices = Object.create(null);
  const bindings = Object.create(null);
  for (const [key, value] of Object.entries(raw.character_voices || {})) {
    if (!characters.some(c => c.id === Number(key)) || typeof value !== 'string' || value.length > 200) throw new Error('人物音色关联无效');
    characterVoices[key] = value.trim();
  }
  for (const [key, value] of Object.entries(raw.speaker_characters || {})) {
    if (Number(value) !== 0 && !characters.some(c => c.id === Number(value))) throw new Error('说话人关联的角色不属于当前项目');
    bindings[speakerName(key)] = Number(value);
  }
  for (const c of characters) {
    if (!voices[c.name] && characterVoices[c.id]) voices[c.name] = characterVoices[c.id];
  }
  const names = new Map(characters.map(c => [c.name, c]));
  for (const shot of shotsFor(db, id)) for (const line of extraction.automaticPlan(db, id, shot, dialogueSegments).segments) if (line.kind === 'dialogue' && line.speaker && !names.has(line.speaker)) names.set(line.speaker, {});
  if (edge) {
    const used = new Set(Object.values(voices).filter(Boolean));
    for (const [name, c] of names) {
      if (!Object.hasOwn(bindings, name)) bindings[name] = c.id || 0;
      const target = characters.find(c => c.id === bindings[name]);
      if (target && voices[target.name]) { voices[name] = voices[target.name]; continue; }
      if (voices[name]) continue;
      const description = [name, c.description, c.appearance, c.voice_style].filter(Boolean).join(' ');
      let preferred = ['zh-CN-YunjianNeural', 'zh-CN-YunxiNeural'];
      if (/女性|女孩|少女|女人|女声|母亲|妈妈|女士|姑娘|女主/u.test(description)) preferred = ['zh-CN-XiaoyiNeural', 'zh-CN-XiaoxiaoNeural'];
      else if (/男孩|少年|男童|小学生|十岁|小男/u.test(description)) preferred = ['zh-CN-YunxiaNeural', 'zh-CN-YunxiNeural'];
      const pool = [...preferred, ...EDGE_VOICES].filter(v => v !== narrator);
      const selected = pool.find(v => !used.has(v)) || pool[0];
      voices[name] = selected;
      used.add(selected);
    }
  } else if (indextts) {
    const used = new Set(Object.values(voices).filter(Boolean));
    for (const [name, c] of names) {
      if (!Object.hasOwn(bindings, name)) bindings[name] = c.id || 0;
      const target = characters.find(c => c.id === bindings[name]);
      if (target && voices[target.name]) { voices[name] = voices[target.name]; continue; }
      if (voices[name]) continue;
      const description = [name, c.description, c.appearance, c.voice_style].filter(Boolean).join(' ');
      let preferred = ['voice_01.wav', 'voice_03.wav', 'voice_04.wav'];
      if (/女性|女孩|少女|女人|女声|母亲|妈妈|女士|姑娘|女主/u.test(description)) preferred = ['voice_07.wav', 'voice_08.wav', 'voice_09.wav', 'voice_11.wav', 'voice_12.wav'];
      else if (/男孩|少年|男童|小学生|十岁|小男/u.test(description)) preferred = ['voice_02.wav', 'voice_06.wav'];
      const pool = [...preferred, ...INDEXTTS_VOICES].filter(v => v !== narrator);
      const selected = pool.find(v => !used.has(v)) || pool[0];
      voices[name] = selected;
      used.add(selected);
    }
  }
  for (const [name, c] of names) {
    if (!Object.hasOwn(bindings, name)) bindings[name] = c.id || 0;
    const target = characters.find(c => c.id === bindings[name]);
    if (target && voices[target.name]) voices[name] = voices[target.name];
  }
  for (const c of characters) characterVoices[c.id] = voices[c.name] || defaultVoice;
  if (narrator && (narrator === defaultVoice || Object.values(voices).some(v => v === narrator))) {
    throw new Error('旁白音色不能与人物或默认音色相同，请选择独立音色');
  }
  return { config_id: config.id, default_voice: defaultVoice, narrator_voice: narrator, speed, voices, character_voices: characterVoices, speaker_characters: bindings };
}
function saveProfile(db, id, raw) {
  const profile = normalizedProfile(db, id, raw);
  const metadata = parseJson(dramaRow(db, id).metadata);
  metadata.tts_dubbing = profile;
  if (metadata.narrative_style) {
    const previous=require('./narrativeStyleService').fromMetadata(metadata);
    metadata.narrative_style = require('./narrativeStyleService').normalize({ ...previous, speech_rate: profile.speed, speech_mode: profile.speed!==previous.speech_rate?'fixed':previous.speech_mode });
  }
  db.prepare('UPDATE dramas SET metadata = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
    .run(JSON.stringify(metadata), new Date().toISOString(), Number(id));
  return profile;
}
function shotsFor(db, id, episodeId) {
  dramaRow(db, id);
  if (episodeId != null && !db.prepare('SELECT id FROM episodes WHERE id = ? AND drama_id = ? AND deleted_at IS NULL').get(Number(episodeId), Number(id))) {
    throw new Error('所选集不属于当前项目');
  }
  return db.prepare('SELECT s.*, e.episode_number FROM storyboards s JOIN episodes e ON e.id = s.episode_id WHERE e.drama_id = ? AND e.deleted_at IS NULL AND s.deleted_at IS NULL' +
    (episodeId != null ? ' AND e.id = ?' : '') + ' ORDER BY e.episode_number, s.storyboard_number, s.id')
    .all(...(episodeId != null ? [Number(id), Number(episodeId)] : [Number(id)]));
}
function latestTask(db, id) {
  const row = db.prepare("SELECT id FROM async_tasks WHERE type = 'dialogue_dubbing' AND resource_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1")
    .get('dubbing:' + Number(id));
  return row ? tasks.getTask(db, row.id) : null;
}
function panel(db, id) {
  let profile = getProfile(db, id);
  const configs = require('./aiConfigService').listConfigs(db, 'tts').filter(c => c.is_active).map(c => {
    const settings = parseJson(c.settings);
    const edge = /^(edge-tts|edgetts|edge)$/i.test(c.provider);
    return { id: c.id, name: c.name, provider: c.provider, is_default: c.is_default,
      default_voice: c.voice_id || settings.voice_id || (edge ? 'zh-CN-YunjianNeural' : '') };
  });
  if (configs.length) profile = normalizedProfile(db, id, profile);
  const characters = db.prepare('SELECT id, name FROM characters WHERE drama_id = ? AND deleted_at IS NULL ORDER BY sort_order, id').all(Number(id));
  const shots = shotsFor(db, id).map(s => {
    const plan = extraction.automaticPlan(db, id, s, dialogueSegments);
    return { ...s, segments: plan.segments.filter(l => l.kind === 'dialogue').map(l => {
        const characterId = Object.hasOwn(profile.speaker_characters || {}, l.speaker) ? (profile.speaker_characters[l.speaker] || null) : (characters.find(c => c.name === l.speaker)?.id || null);
        return { ...l, character_id: characterId, character_name: characters.find(c => c.id === characterId)?.name || null,
          voice_id: profile.character_voices?.[characterId] || profile.voices?.[l.speaker] || profile.default_voice || '' };
      }),
      narration: plan.segments.filter(l => l.kind === 'narration').map(l => l.text).join('\n'),
      extraction_pending: extraction.needsModel(s, plan), extraction_method: plan.method };
  });
  const names = new Set(db.prepare('SELECT name FROM characters WHERE drama_id = ? AND deleted_at IS NULL ORDER BY sort_order, id')
    .all(Number(id)).map(c => c.name));
  for (const s of shots) for (const line of s.segments) if (line.speaker) names.add(line.speaker);
  return { profile, configs, characters, speakers: [...names], shots, task: latestTask(db, id) };
}
async function synthesizeShot(db, log, shot, storageRoot, profile, config, kind = 'dialogue') {
  const plan = shot.speech_plan || extraction.automaticPlan(db, shot.drama_id, shot, dialogueSegments);
  if (kind === 'narration' && !profile.narrator_voice) throw new Error('请为旁白指定独立音色');
  const selected = plan.segments.map((line, index) => ({ ...line, index })).filter(line => line.kind === kind);
  const segments = selected;
  if (!segments.length) throw new Error(kind === 'narration' ? '分镜旁白为空' : '分镜对白为空');
  const delivery=require('./speechDeliveryService').forShot(db,shot,{segments:plan.segments,baseSpeed:profile.speed});
  const generated = [];
  for (const segment of segments) {
    const characterId = profile.speaker_characters?.[segment.speaker];
    const voice = kind === 'narration' ? profile.narrator_voice : (profile.character_voices?.[characterId] || (Object.hasOwn(profile.voices || {}, segment.speaker) ? profile.voices[segment.speaker] : ''));
    const result = await tts.synthesize(db, log, { text: segment.text, storyboard_id: shot.id,
      storage_base: storageRoot, config, voice_id: voice || profile.default_voice || undefined, speed: delivery.speech_rate });
    if (!result.local_path) throw new Error('TTS 未返回音频');
    generated.push(result.local_path);
  }
  const parts = selected.map((line, i) => ({ index: line.index, local_path: generated[i] }));
  if (generated.length === 1) return { local_path: generated[0], segments, parts, speech_plan: plan, speech_delivery: delivery };
  const inputs = generated.flatMap(rel => ['-i', path.join(storageRoot, rel)]);
  const filter = generated.map((_, i) => '[' + i + ':a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=mono[a' + i + ']').join(';') + ';' +
    generated.map((_, i) => '[a' + i + ']').join('') + 'concat=n=' + generated.length + ':v=0:a=1[out]';
  const relative = 'audio/tts_sb' + shot.id + '_' + randomUUID().slice(0, 8) + '.mp3';
  fs.mkdirSync(path.join(storageRoot, 'audio'), { recursive: true });
  await execFile(getFfmpegPath(), ['-y', ...inputs, '-filter_complex', filter, '-map', '[out]', '-c:a', 'libmp3lame', '-q:a', '4', path.join(storageRoot, relative)], { timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
  return { local_path: relative, segments, parts, speech_plan: plan, speech_delivery: delivery };
}
function activeTask(db, id) {
  const t = latestTask(db, id);
  return t && ['pending', 'processing'].includes(t.status) ? t : null;
}
function latestSpeechTask(db, id) {
  const row = db.prepare("SELECT id FROM async_tasks WHERE type = 'speech_extraction' AND resource_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1").get('speech:' + Number(id));
  return row ? tasks.getTask(db, row.id) : null;
}
function assertSpeechIdle(db, id, allowedTask) {
  const job = latestSpeechTask(db, id);
  if (job && ['pending', 'processing'].includes(job.status) && job.id !== allowedTask) throw new Error('当前项目正在批量生成对话和旁白，请等待完成后操作');
}
function audioColumn(kind) { return kind === 'narration' ? 'narration_audio_local_path' : 'audio_local_path'; }
function commitAudio(db, shot, result, kind) {
  const current = db.prepare('SELECT * FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(shot.id);
  if (!current || (result.speech_plan && extraction.sourceHash(current) !== result.speech_plan.source_hash)) throw new Error('配音期间文案已变更，请重新生成');
  const textColumn = kind === 'narration' ? 'narration' : 'dialogue';
  const update = db.prepare('UPDATE storyboards SET ' + audioColumn(kind) + ' = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL AND ' + textColumn + ' IS ?')
    .run(result.local_path, new Date().toISOString(), shot.id, shot[textColumn]);
  if (!update.changes) throw new Error('配音期间文案已变更，请重新生成');
  extraction.recordAudio(db, shot.drama_id, shot, result, kind);
}
async function single(db, log, shotId, storageRoot, kind = 'dialogue') {
  const shot = db.prepare('SELECT s.*, e.drama_id FROM storyboards s JOIN episodes e ON e.id = s.episode_id WHERE s.id = ? AND s.deleted_at IS NULL AND e.deleted_at IS NULL')
    .get(Number(shotId));
  if (!shot) throw new Error('分镜不存在');
  assertSpeechIdle(db, shot.drama_id);
  if (activeTask(db, shot.drama_id)) throw new Error('当前项目正在批量配音，请等待完成');
  shot.speech_plan = await extraction.ensurePlan(db, log, shot.drama_id, shot, dialogueSegments);
  const profile = normalizedProfile(db, shot.drama_id, getProfile(db, shot.drama_id));
  const result = await synthesizeShot(db, log, shot, storageRoot, profile, configFor(db, profile.config_id), kind);
  commitAudio(db, shot, result, kind);
  return result;
}
async function runBatch(db, log, taskId, shots, storageRoot, profile, config, overwrite, initialErrors = []) {
  const results = [...initialErrors];
  const alive = () => ['pending', 'processing'].includes(tasks.getTask(db, taskId)?.status);
  for (const shot of shots) {
    if (!alive()) return;
    const kind = shot.tts_kind || 'dialogue';
    tasks.updateTaskStatus(db, taskId, 'processing', Math.min(99, Math.floor(results.length / Math.max(1, shots.length + initialErrors.length) * 100)),
      '第' + shot.episode_number + '集 · 分镜' + shot.storyboard_number + (kind === 'narration' ? '旁白' : '对白') + '（' + (results.length + 1) + '/' + shots.length + '）');
    try {
      const existing = shot[audioColumn(kind)];
      if (!overwrite && existing && fs.existsSync(path.join(storageRoot, existing))) {
        results.push({ storyboard_id: shot.id, tts_kind: kind, skipped: true, local_path: existing });
      } else {
        const result = await synthesizeShot(db, log, shot, storageRoot, profile, config, kind);
        if (!alive()) return;
        commitAudio(db, shot, result, kind);
        results.push({ storyboard_id: shot.id, tts_kind: kind, local_path: result.local_path });
      }
    } catch (err) {
      results.push({ storyboard_id: shot.id, tts_kind: kind, episode_number: shot.episode_number, storyboard_number: shot.storyboard_number, error: err.message });
    }
    if (!alive()) return;
    db.prepare('UPDATE async_tasks SET result = ? WHERE id = ?').run(JSON.stringify({ results, total: shots.length }), taskId);
  }
  const failed = results.filter(r => r.error).length;
  tasks.updateTaskResult(db, taskId, { results, total: shots.length, failed, succeeded: results.filter(r => !r.error && !r.skipped).length });
}
function startBatch(db, log, id, body, storageRoot) {
  assertSpeechIdle(db, id);
  if (activeTask(db, id)) throw new Error('当前项目已有批量配音任务，请等待完成或先停止');
  const profile = normalizedProfile(db, id, body.profile || getProfile(db, id));
  const config = configFor(db, profile.config_id);
  const kind = body.tts_kind || 'dialogue';
  if (!['dialogue', 'narration', 'both'].includes(kind)) throw new Error('配音内容无效');
  let sourceShots = shotsFor(db, id, body.episode_id);
  if (body.storyboard_ids != null) {
    if (!Array.isArray(body.storyboard_ids) || !body.storyboard_ids.length) throw new Error('重试分镜不能为空');
    const ids = new Set(body.storyboard_ids.map(Number));
    if ([...ids].some(n => !sourceShots.some(s => s.id === n))) throw new Error('重试分镜不属于所选范围');
    sourceShots = sourceShots.filter(s => ids.has(s.id));
  }
  if (body.retry_items != null) {
    if (!Array.isArray(body.retry_items) || !body.retry_items.length) throw new Error('重试列表不能为空');
    if (body.retry_items.some(r => !['dialogue', 'narration'].includes(r.tts_kind) || !sourceShots.some(s => s.id === Number(r.storyboard_id)))) throw new Error('重试配音不属于所选范围');
    sourceShots = sourceShots.filter(s => body.retry_items.some(r => Number(r.storyboard_id) === s.id));
  }
  sourceShots = sourceShots.filter(s => {
    const plan = extraction.automaticPlan(db, id, s, dialogueSegments);
    return extraction.needsModel(s, plan) || plan.segments.some(l => kind === 'both' || kind === l.kind);
  });
  if (!sourceShots.length) throw new Error('所选范围没有可配音的文案');
  saveProfile(db, id, profile);
  const task = tasks.createTask(db, log, 'dialogue_dubbing', 'dubbing:' + Number(id));
  setImmediate(async () => {
    try {
      const planned = [];
      const errors = [];
      for (const shot of sourceShots) {
        if (!['pending', 'processing'].includes(tasks.getTask(db, task.id)?.status)) return;
        tasks.updateTaskStatus(db, task.id, 'processing', 0, '提取第' + shot.episode_number + '集分镜' + shot.storyboard_number + '台词');
        try {
          const plan = await extraction.ensurePlan(db, log, id, shot, dialogueSegments, body.force_extract === true);
          for (const k of ['dialogue', 'narration']) {
            if (kind !== 'both' && k !== kind) continue;
            if (body.retry_items && !body.retry_items.some(r => Number(r.storyboard_id) === shot.id && r.tts_kind === k)) continue;
            if (plan.segments.some(l => l.kind === k)) planned.push({ ...shot, drama_id: Number(id), tts_kind: k, speech_plan: plan });
          }
        } catch (err) {
          errors.push({ storyboard_id: shot.id, episode_number: shot.episode_number, storyboard_number: shot.storyboard_number, tts_kind: kind === 'narration' ? 'narration' : 'dialogue', error: '台词提取失败：' + err.message });
        }
      }
      if (!['pending', 'processing'].includes(tasks.getTask(db, task.id)?.status)) return;
      const resolved = normalizedProfile(db, id, profile);
      saveProfile(db, id, resolved);
      await runBatch(db, log, task.id, planned, storageRoot, resolved, config, body.overwrite !== false, errors);
    } catch (err) {
      if (['pending', 'processing'].includes(tasks.getTask(db, task.id)?.status)) tasks.updateTaskError(db, task.id, err.message);
    }
  });
  return task;
}
function planForId(db, id) {
  const shot = db.prepare('SELECT s.*, e.drama_id FROM storyboards s JOIN episodes e ON e.id=s.episode_id WHERE s.id=? AND s.deleted_at IS NULL').get(Number(id));
  return shot ? extraction.automaticPlan(db, shot.drama_id, shot, dialogueSegments) : null;
}
function speechShot(db, dramaId, shotId) {
  dramaRow(db, dramaId);
  const shot = db.prepare('SELECT s.*, e.drama_id FROM storyboards s JOIN episodes e ON e.id = s.episode_id WHERE s.id = ? AND e.drama_id = ? AND s.deleted_at IS NULL AND e.deleted_at IS NULL').get(Number(shotId), Number(dramaId));
  if (!shot) throw new Error('分镜不属于当前项目或已删除');
  return shot;
}
function speechEditor(db, dramaId, shotId) {
  const shot = speechShot(db, dramaId, shotId);
  const plan = extraction.automaticPlan(db, dramaId, shot, dialogueSegments);
  return { storyboard_id: shot.id, source_hash: plan.source_hash, segments: plan.segments,
    dialogue: shot.dialogue || '', narration: shot.narration || '',
    characters: db.prepare('SELECT id, name FROM characters WHERE drama_id = ? AND deleted_at IS NULL ORDER BY sort_order, id').all(Number(dramaId)) };
}
async function extractSpeech(db, log, dramaId, shotId, force = false, allowedTask) {
  assertSpeechIdle(db, dramaId, allowedTask);
  if (activeTask(db, dramaId)) throw new Error('当前项目正在批量配音，请等待完成');
  const shot = speechShot(db, dramaId, shotId);
  const plan = await extraction.ensurePlan(db, log, dramaId, shot, dialogueSegments, force);
  if (extraction.sourceHash(speechShot(db, dramaId, shotId)) !== plan.source_hash) throw new Error('提取期间分镜文案已变更，请重新打开');
  return { ...speechEditor(db, dramaId, shotId), segments: plan.segments };
}
function saveSpeech(db, dramaId, shotId, body, allowedTask) {
  assertSpeechIdle(db, dramaId, allowedTask);
  if (activeTask(db, dramaId)) throw new Error('当前项目正在批量配音，请等待完成后编辑');
  if (!Array.isArray(body.segments) || body.segments.length > 200) throw new Error('对话清单格式无效');
  const segments = body.segments.map(item => {
    if (!item || !['dialogue', 'narration'].includes(item.kind) || typeof item.text !== 'string' || typeof item.speaker !== 'string') throw new Error('对话清单格式无效');
    const text = item.text.trim();
    const kind = item.kind === 'narration' || extraction.isNarrator(item.speaker.trim()) ? 'narration' : 'dialogue';
    const speaker = kind === 'narration' ? '' : item.speaker.trim();
    if (!text || text.length > 5000 || speaker.length > 80 || /[\r\n：:]/u.test(speaker)) throw new Error('请输入有效的说话者和台词正文');
    return { kind, speaker, text };
  });
  return db.transaction(() => {
    const shot = speechShot(db, dramaId, shotId);
    if (!body.source_hash || body.source_hash !== extraction.sourceHash(shot)) throw new Error('分镜文案已在其他页面修改，请重新打开后编辑');
    const dialogue = segments.filter(s => s.kind === 'dialogue').map(s => s.speaker ? s.speaker + '：' + JSON.stringify(s.text) : s.text).join('\n');
    const narration = segments.filter(s => s.kind === 'narration').map(s => s.text).join('\n');
    db.prepare('UPDATE storyboards SET dialogue = ?, narration = ?, updated_at = ? WHERE id = ?').run(dialogue, narration, new Date().toISOString(), shot.id);
    const updated = { ...shot, dialogue, narration };
    const metadata = parseJson(dramaRow(db, dramaId).metadata);
    const previous = metadata.tts_speech_plans?.[shot.id];
    const unchanged = previous?.source_hash === extraction.sourceHash(updated) && JSON.stringify(previous.segments) === JSON.stringify(segments);
    metadata.tts_speech_plans = { ...(metadata.tts_speech_plans || {}), [shot.id]: {
      ...(unchanged ? previous : {}), source_hash: extraction.sourceHash(updated), segments, method: 'edited',
    } };
    db.prepare('UPDATE dramas SET metadata = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(metadata), new Date().toISOString(), Number(dramaId));
    return speechEditor(db, dramaId, shotId);
  })();
}
function startSpeechBatch(db, log, dramaId, body) {
  assertSpeechIdle(db, dramaId);
  if (activeTask(db, dramaId)) throw new Error('当前项目正在批量配音，请等待完成');
  const shots = shotsFor(db, dramaId, body.episode_id);
  if (!shots.length) throw new Error('当前范围没有分镜');
  const task = tasks.createTask(db, log, 'speech_extraction', 'speech:' + Number(dramaId));
  setImmediate(async () => {
    const results = [];
    const alive = () => ['pending', 'processing'].includes(tasks.getTask(db, task.id)?.status);
    try {
      for (const shot of shots) {
        if (!alive()) return;
        tasks.updateTaskStatus(db, task.id, 'processing', Math.floor(results.length / shots.length * 100), '提取第' + shot.episode_number + '集 · 分镜' + shot.storyboard_number);
        try {
          const plan = await extractSpeech(db, log, dramaId, shot.id, false, task.id);
          if (!alive()) return;
          // Keep the original snapshot check: edits made before processing this shot are preserved.
          if (plan.source_hash !== extraction.sourceHash(shot)) throw new Error('分镜文案已修改，已跳过，请单独重新生成');
          if (plan.segments.length) {
            saveSpeech(db, dramaId, shot.id, plan, task.id);
            results.push({ storyboard_id: shot.id, episode_number: shot.episode_number, storyboard_number: shot.storyboard_number, segments: plan.segments.length });
          } else {
            results.push({ storyboard_id: shot.id, episode_number: shot.episode_number, storyboard_number: shot.storyboard_number, skipped: true });
          }
        } catch (e) {
          results.push({ storyboard_id: shot.id, episode_number: shot.episode_number, storyboard_number: shot.storyboard_number, error: e.message });
        }
        if (!alive()) return;
        db.prepare('UPDATE async_tasks SET result = ? WHERE id = ?').run(JSON.stringify({ results, total: shots.length }), task.id);
      }
      tasks.updateTaskResult(db, task.id, { results, total: shots.length, succeeded: results.filter(r => !r.error && !r.skipped).length, failed: results.filter(r => r.error).length });
    } catch (e) { if (alive()) tasks.updateTaskError(db, task.id, e.message); }
  });
  return task;
}
module.exports = { latestSpeechTask, startSpeechBatch, speechEditor, extractSpeech, saveSpeech, planForId, dialogueSegments, panel, getProfile, saveProfile, normalizedProfile, configFor, synthesizeShot, single, startBatch, runBatch };
