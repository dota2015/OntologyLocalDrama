const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const { getFfprobePath } = require('../utils/ffmpegPath');
const storageLayout = require('./storageLayout');

const MAX_BYTES = 100 * 1024 * 1024;
const EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac']);
const DEFAULTS = { enabled: false, local_path: null, filename: '', duration: 0, volume: 20, loop: true, fade_in: 1, fade_out: 2 };
function metadata(value) { return storageLayout.parseMetadata(value); }
function episode(db, id) {
  const row = db.prepare('SELECT e.id, e.drama_id, d.metadata FROM episodes e JOIN dramas d ON d.id = e.drama_id WHERE e.id = ? AND e.deleted_at IS NULL AND d.deleted_at IS NULL').get(Number(id));
  if (!row) throw new Error('剧集不存在或已删除');
  return row;
}
function getSettings(db, episodeId) {
  const row = episode(db, episodeId);
  const settings = { ...DEFAULTS, ...(metadata(row.metadata).background_music_by_episode?.[row.id] || {}) };
  return { ...settings, url: settings.local_path ? '/static/' + encodeURI(settings.local_path) : '' };
}
function options(raw, previous = DEFAULTS) {
  const result = { ...previous };
  for (const key of ['enabled', 'loop']) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'boolean') throw new Error('背景音乐开关设置无效');
    result[key] = raw[key];
  }
  for (const [key, max] of [['volume', 100], ['fade_in', 10], ['fade_out', 10]]) {
    if (raw[key] === undefined) continue;
    const value = raw[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) throw new Error('背景音乐音量或淡入淡出设置超出范围');
    result[key] = value;
  }
  return result;
}
function write(db, episodeId, change) {
  return db.transaction(() => {
    const row = episode(db, episodeId);
    const meta = metadata(row.metadata);
    const previous = { ...DEFAULTS, ...(meta.background_music_by_episode?.[row.id] || {}) };
    const updated = change(previous);
    delete updated.url;
    meta.background_music_by_episode = { ...(meta.background_music_by_episode || {}), [row.id]: updated };
    db.prepare('UPDATE dramas SET metadata = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(meta), new Date().toISOString(), row.drama_id);
    return getSettings(db, episodeId);
  })();
}
function saveSettings(db, episodeId, raw) {
  return write(db, episodeId, previous => {
    const updated = options(raw, previous);
    if (updated.enabled && !updated.local_path) throw new Error('请先上传背景音乐');
    return updated;
  });
}
function remove(db, episodeId) {
  // Retain uploaded media so pending and completed merges remain reproducible.
  return write(db, episodeId, previous => ({ ...previous, enabled: false, local_path: null, filename: '', duration: 0 }));
}
function resolveAudioPath(storageRoot, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\') || relative.includes('\0')) throw new Error('背景音乐文件路径无效');
  const root = fs.realpathSync(storageRoot);
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(root + path.sep) || !fs.existsSync(resolved)) throw new Error('背景音乐文件不存在，请重新上传');
  const real = fs.realpathSync(resolved);
  if (!real.startsWith(root + path.sep) || !fs.statSync(real).isFile()) throw new Error('背景音乐文件路径无效');
  return real;
}
async function upload(db, episodeId, storageRoot, file) {
  const row = episode(db, episodeId);
  if (!file?.buffer?.length) throw new Error('请选择音乐文件');
  if (file.buffer.length > MAX_BYTES) throw new Error('背景音乐不能超过 100MB');
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (!EXTENSIONS.has(ext)) throw new Error('支持 MP3、WAV、M4A、OGG、FLAC、AAC 音频');
  const subdir = storageLayout.getProjectStorageSubdir(db, row.drama_id);
  const relative = subdir + '/audio/bgm/' + randomUUID() + ext;
  const absolute = path.join(storageRoot, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, file.buffer);
  try {
    const { stdout } = await execFile(getFfprobePath(), ['-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', absolute], { timeout: 15000, maxBuffer: 1024 * 1024 });
    const probe = JSON.parse(stdout);
    const duration = Number(probe.format?.duration);
    if (!probe.streams?.some(s => s.codec_type === 'audio') || !(duration > 0) || !Number.isFinite(duration)) throw new Error('无有效音轨');
    return write(db, episodeId, previous => ({ ...previous, enabled: true, local_path: relative, filename: path.basename(file.originalname), duration }));
  } catch (e) {
    try { fs.unlinkSync(absolute); } catch (_) {}
    throw new Error('背景音乐上传失败，请确认文件是可播放的音频：' + e.message.slice(0, 160));
  }
}
function snapshot(db, episodeId, storageRoot) {
  const settings = getSettings(db, episodeId);
  if (!settings.enabled) return null;
  resolveAudioPath(storageRoot, settings.local_path);
  const result = options(settings, DEFAULTS);
  return { ...result, local_path: settings.local_path, filename: settings.filename, duration: settings.duration };
}

module.exports = { MAX_BYTES, DEFAULTS, getSettings, saveSettings, remove, upload, snapshot, resolveAudioPath, options };
