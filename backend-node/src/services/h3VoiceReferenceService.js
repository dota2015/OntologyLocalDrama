const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const { getFfmpegPath, getFfprobePath } = require('../utils/ffmpegPath');
const layout = require('./storageLayout');
const dubbing = require('./dialogueDubbingService');
const extraction = require('./speechExtractionService');
const tts = require('./ttsService');

const MAX_BYTES = 20 * 1024 * 1024;
const SAMPLE_TEXT = '你好，今天我们一起分享一个故事。遇到困难时，先想清楚，再一步一步向前走。';
const pending = new Map();
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function drama(db, id) {
  const row = db.prepare('SELECT id, title, created_at, metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!row) throw new Error('项目不存在');
  return row;
}
function targetFor(db, dramaId, target) {
  if (target === 'narrator') return { key: 'narrator', name: '旁白', kind: 'narration' };
  // Internal speaker targets cover explicit voices which are not bound to a character.
  if (typeof target === 'object' && target?.speaker) return { key: 'speaker:' + target.speaker, name: target.speaker, kind: 'dialogue' };
  const row = db.prepare('SELECT id, name FROM characters WHERE id = ? AND drama_id = ? AND deleted_at IS NULL').get(Number(target), Number(dramaId));
  if (!row) throw new Error('人物不属于当前项目或已删除');
  return { key: 'character:' + row.id, id: row.id, name: row.name, kind: 'dialogue' };
}
function profile(db, dramaId) {
  const raw = dubbing.getProfile(db, dramaId);
  const configs = require('./aiConfigService').listConfigs(db, 'tts').filter(c => c.is_active);
  return configs.length ? dubbing.normalizedProfile(db, dramaId, raw) : raw;
}
function voiceFor(p, target) {
  return target.kind === 'narration' ? p.narrator_voice : (p.character_voices?.[target.id] || p.voices?.[target.name] || p.default_voice);
}
function state(db, dramaId, target) {
  return layout.parseMetadata(drama(db, dramaId).metadata).h3_voice_references?.[target.key] || {};
}
function write(db, dramaId, target, update) {
  db.transaction(() => {
    const metadata = layout.parseMetadata(drama(db, dramaId).metadata);
    metadata.h3_voice_references = { ...(metadata.h3_voice_references || {}) };
    metadata.h3_voice_references[target.key] = update(metadata.h3_voice_references[target.key] || {});
    db.prepare('UPDATE dramas SET metadata = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(metadata), new Date().toISOString(), Number(dramaId));
  })();
}
function resolveAudio(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\') || relative.includes('\0')) throw new Error('参考音频路径无效');
  const realRoot = fs.realpathSync(root);
  const absolute = fs.realpathSync(path.resolve(realRoot, relative));
  if (!absolute.startsWith(realRoot + path.sep) || !fs.statSync(absolute).isFile()) throw new Error('参考音频路径无效');
  return absolute;
}
function exists(root, item) {
  if (!item?.local_path) return false;
  try { resolveAudio(root, item.local_path); return true; } catch { return false; }
}
function signature(voice, speed) { return hash(JSON.stringify(['edge-h3-reference-v2', voice, speed, SAMPLE_TEXT])); }
function present(item) { return item ? { ...item, url: '/static/' + encodeURI(item.local_path) } : null; }
function getSettings(db, dramaId, targetValue, root) {
  drama(db, dramaId);
  const target = targetFor(db, dramaId, targetValue);
  const saved = state(db, dramaId, target);
  const p = profile(db, dramaId);
  const speed = Number(p.speed) || 1;
  const voice = voiceFor(p, target) || '';
  const uploaded = exists(root, saved.uploaded) ? saved.uploaded : null;
  const automatic = exists(root, saved.automatic) && saved.automatic.signature === signature(voice, speed) ? saved.automatic : null;
  return { speed, target: target.key, speaker: target.name, voice_id: voice, uploaded: present(uploaded), automatic: present(automatic),
    source: uploaded ? 'uploaded' : automatic ? 'edge-tts' : 'pending', sample_text: SAMPLE_TEXT };
}
async function normalizeAudio(source, destination, validateDuration = true) {
  const { stdout } = await execFile(getFfprobePath(), ['-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', source], { timeout: 15000 });
  const data = JSON.parse(stdout);
  const duration = Number(data.format?.duration);
  if (!data.streams?.some(s => s.codec_type === 'audio') || !Number.isFinite(duration) || duration < 2 || (validateDuration && duration > 15.05)) {
    throw new Error('请使用 2～15 秒的清晰单人音频');
  }
  const temp = destination + '.' + randomUUID() + '.part.wav';
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    await execFile(getFfmpegPath(), ['-v', 'error', '-y', '-i', source, '-vn', '-t', '15', '-ac', '1', '-ar', '32000', '-c:a', 'pcm_s16le', temp], { timeout: 30000, maxBuffer: 1024 * 1024 });
    fs.renameSync(temp, destination);
  } finally { try { fs.unlinkSync(temp); } catch { /* atomic conversion */ } }
  return Math.min(duration, 15);
}
async function upload(db, dramaId, targetValue, root, file) {
  drama(db, dramaId);
  const target = targetFor(db, dramaId, targetValue);
  if (!file?.buffer?.length || file.buffer.length > MAX_BYTES) throw new Error('请选择不超过 20MB 的音频');
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (!['.wav', '.mp3', '.m4a', '.flac', '.ogg', '.aac'].includes(ext)) throw new Error('支持 WAV、MP3、M4A、FLAC、OGG、AAC');
  const relative = layout.getProjectStorageSubdir(db, dramaId) + '/audio/h3-voices/' + randomUUID() + '.wav';
  const destination = path.join(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const source = destination + ext;
  fs.writeFileSync(source, file.buffer);
  try {
    const duration = await normalizeAudio(source, destination);
    write(db, dramaId, target, old => ({ ...old, uploaded: { local_path: relative, filename: path.basename(file.originalname), duration, source: 'uploaded' } }));
  } catch (e) {
    try { fs.unlinkSync(destination); } catch { /* failed upload */ }
    throw e;
  } finally { try { fs.unlinkSync(source); } catch { /* upload temp */ } }
  return getSettings(db, dramaId, targetValue, root);
}
function removeUpload(db, dramaId, targetValue, root) {
  const target = targetFor(db, dramaId, targetValue);
  write(db, dramaId, target, old => ({ ...old, uploaded: null }));
  // Retain old files for queued work/history; they are no longer selected.
  return getSettings(db, dramaId, targetValue, root);
}
async function prepare(db, log, dramaId, targetValue, root) {
  const current = getSettings(db, dramaId, targetValue, root);
  if (current.uploaded || current.automatic) return current;
  const voice = current.voice_id;
  const isEdge = /Neural$/i.test(voice);
  const isIndex = /wav$/i.test(voice) || /^voice_\d+/i.test(voice);
  if (!voice || (!isEdge && !isIndex)) throw new Error('请先给该人物或旁白分配 Edge-TTS 音色，或上传参考音频');
  const target = targetFor(db, dramaId, targetValue);
  const sig = signature(voice, current.speed);
  const key = [root, Number(dramaId), target.key, sig].join('|');
  if (!pending.has(key)) pending.set(key, (async () => {
    const allConfigs = require('./aiConfigService').listConfigs(db, 'tts').filter(c => c.is_active);
    const configs = allConfigs.filter(c => isEdge ? /^(edge-tts|edgetts|edge)$/i.test(c.provider) : /^(indextts|indextts2|indextts25)$/i.test(c.provider) || (c.base_url && /7860/i.test(c.base_url)));
    const config = configs.find(c => c.is_default) || configs[0] || allConfigs.find(c => c.is_default) || allConfigs[0];
    if (!config) throw new Error('请在 AI 配置启用 Edge-TTS，或上传参考音频');
    const relative = layout.getProjectStorageSubdir(db, dramaId) + '/audio/h3-voices/' + hash(target.key).slice(0, 12) + '-' + sig.slice(0, 20) + '.wav';
    const result = await tts.synthesize(db, log, { text: SAMPLE_TEXT, config, voice_id: voice, speed: current.speed, storage_base: root });
    const source = resolveAudio(root, result.local_path);
    try {
      const duration = await normalizeAudio(source, path.join(root, relative), false);
      if (voiceFor(profile(db, dramaId), target) !== voice || Number(profile(db, dramaId).speed || 1) !== current.speed) throw new Error('准备期间音色已变化，请重试');
      const sourceLabel = isEdge ? 'Edge-TTS' : 'IndexTTS';
      const sourceKey = isEdge ? 'edge-tts' : 'indextts';
      write(db, dramaId, target, old => ({ ...old, automatic: { local_path: relative, filename: sourceLabel + ' · ' + voice, duration, voice_id: voice, speed: current.speed, signature: sig, source: sourceKey } }));
    } finally { try { fs.unlinkSync(source); } catch { /* temporary synthesized sample */ } }
  })());
  const job = pending.get(key);
  try { await job; } finally { if (pending.get(key) === job) pending.delete(key); }
  return getSettings(db, dramaId, targetValue, root);
}

async function forShot(db, log, dramaId, shotId, root) {
  const shot = db.prepare(`SELECT s.* FROM storyboards s JOIN episodes e ON e.id=s.episode_id
    WHERE s.id=? AND e.drama_id=? AND e.deleted_at IS NULL AND s.deleted_at IS NULL`).get(Number(shotId), Number(dramaId));
  if (!shot) throw new Error('H3 分镜不属于当前项目或已删除');
  const plan = await extraction.ensurePlan(db, log, dramaId, shot, dubbing.dialogueSegments);
  if (!plan.segments.length) return { references: [], lines: [], instructions: '' };
  const p = profile(db, dramaId);
  const characters = db.prepare('SELECT id,name FROM characters WHERE drama_id=? AND deleted_at IS NULL').all(Number(dramaId));
  const voices = new Map();
  const lines = [];
  for (const line of plan.segments) {
    const characterId = Object.hasOwn(p.speaker_characters || {}, line.speaker)
      ? p.speaker_characters[line.speaker] : characters.find(c => c.name === line.speaker)?.id;
    const targetValue = line.kind === 'narration' ? 'narrator' : characterId || { speaker: line.speaker || '未标注人物' };
    const target = targetFor(db, dramaId, targetValue);
    if (!voices.has(target.key)) voices.set(target.key, { targetValue, target });
    lines.push({ ...line, key: target.key });
  }
  if (voices.size > 3) throw new Error('H3 每镜最多支持 3 个参考声音（旁白也占一个），请拆分该镜头');
  const references = [];
  for (const { targetValue, target } of voices.values()) {
    const settings = await prepare(db, log, dramaId, targetValue, root);
    const selected = settings.uploaded || settings.automatic;
    if (!selected) throw new Error('参考声音未准备好，请重试');
    const bytes = fs.readFileSync(resolveAudio(root, selected.local_path));
    references.push({ speaker: target.name, kind: target.kind, key: target.key, url: 'data:audio/wav;base64,' + bytes.toString('base64') });
  }
  const latest = db.prepare('SELECT * FROM storyboards WHERE id=? AND deleted_at IS NULL').get(shot.id);
  if (!latest || extraction.sourceHash(latest) !== extraction.sourceHash(shot)) throw new Error('准备参考声音期间分镜台词已修改，请重新生成');
  const bindings = references.map((r, i) => `${r.kind === 'narration' ? '画外旁白' : '人物' + JSON.stringify(r.speaker)}的音色模仿 <Audio ${i + 1}>，只参考音色，不复读样音内容。`);
  const speech = lines.map(line => {
    const index = references.findIndex(r => r.key === line.key) + 1;
    return `${line.kind === 'narration' ? '画外旁白（人物不张嘴）' : '人物' + JSON.stringify(line.speaker)}，使用 <Audio ${index}> 的音色，说：${JSON.stringify(line.text)}`;
  });
  const style=require('./narrativeStyleService').fromMetadata(drama(db, dramaId).metadata);
  const delivery=require('./speechDeliveryService').forShot(db,shot,{segments:lines});
  const narrativeStyle={...style,speech_rate:delivery.speech_rate};
  return { narrative_style: narrativeStyle, speech_delivery: delivery, references, lines, instructions: '\n【本镜声音绑定与台词顺序】\n' + bindings.concat(speech).join('\n') + '\n' + require('./narrativeStyleService').h3Delivery(narrativeStyle) + '\n角色名和参考编号不朗读，不增添其他台词。' };
}

module.exports = { MAX_BYTES, SAMPLE_TEXT, getSettings, prepare, upload, removeUpload, forShot, resolveAudio };
