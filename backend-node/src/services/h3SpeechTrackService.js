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

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function durationOf(file) {
  const { stdout } = await execFile(getFfprobePath(), [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
  ], { timeout: 15000 });
  const duration = Number(String(stdout).trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('TTS 音频时长无效');
  return duration;
}

function voiceForLine(db, dramaId, profile, line) {
  if (line.kind === 'narration') return profile.narrator_voice;
  const explicit = Object.hasOwn(profile.speaker_characters || {}, line.speaker)
    ? Number(profile.speaker_characters[line.speaker]) : null;
  const character = explicit
    ? db.prepare('SELECT id FROM characters WHERE id=? AND drama_id=? AND deleted_at IS NULL').get(explicit, dramaId)
    : db.prepare('SELECT id FROM characters WHERE name=? AND drama_id=? AND deleted_at IS NULL ORDER BY id LIMIT 1').get(line.speaker, dramaId);
  return profile.character_voices?.[character?.id]
    || profile.voices?.[line.speaker]
    || profile.default_voice;
}

async function prepare(db, log, dramaId, shotId, root, lines, duration, delivery) {
  const shot = db.prepare(`SELECT s.*,e.drama_id FROM storyboards s JOIN episodes e ON e.id=s.episode_id
    WHERE s.id=? AND e.drama_id=? AND s.deleted_at IS NULL AND e.deleted_at IS NULL`).get(Number(shotId), Number(dramaId));
  if (!shot) throw new Error('H3 精确台词音轨对应的分镜不存在');
  if (!Array.isArray(lines) || !lines.length) return null;
  const profile = dubbing.normalizedProfile(db, dramaId, dubbing.getProfile(db, dramaId));
  const config = dubbing.configFor(db, profile.config_id);
  const speechRate = tts.isIndexTts(config) ? tts.defaultSpeed(config) : Number(delivery?.speech_rate || profile.speed || 1);
  const totalDuration = Number(duration);
  // The complete TTS track may use the full shot duration.  A fixed 1.5s
  // silent tail clips valid final words and is no longer part of the contract.
  const reserve = 0;
  const lineSpecs = lines.map(line => ({
    kind: line.kind,
    speaker: line.speaker || '',
    text: line.text,
    voice: voiceForLine(db, Number(dramaId), profile, line),
  }));
  if (lineSpecs.some(line => !line.voice)) throw new Error('H3 精确台词音轨缺少人物或旁白音色');
  const signature = digest(['h3-exact-speech-v1', extraction.sourceHash(shot), lineSpecs, speechRate, totalDuration, config.id, config.provider]);
  const relative = `${layout.getProjectStorageSubdir(db, dramaId)}/audio/h3-speech/${shotId}-${signature.slice(0, 24)}.wav`;
  const destination = path.join(root, relative);
  const metaPath = destination + '.json';
  if (fs.existsSync(destination) && fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    return { ...meta, local_path: relative, url: 'data:audio/wav;base64,' + fs.readFileSync(destination).toString('base64') };
  }

  const generated = [];
  try {
    for (const line of lineSpecs) {
      const result = await tts.synthesize(db, log, {
        text: line.text,
        storyboard_id: shotId,
        storage_base: root,
        config,
        voice_id: line.voice,
        speed: speechRate,
      });
      const absolute = path.join(root, result.local_path);
      generated.push({ ...line, local_path: result.local_path, absolute, duration: await durationOf(absolute) });
    }
    const pause = generated.length > 1 ? 0.12 : 0;
    let cursor = 0;
    const events = generated.map((line, index) => {
      const event = { index, kind: line.kind, speaker: line.speaker, text: line.text,
        start_seconds: Number(cursor.toFixed(3)), end_seconds: Number((cursor + line.duration).toFixed(3)) };
      cursor += line.duration + (index < generated.length - 1 ? pause : 0);
      return event;
    });
    const deadline = Math.max(0.5, totalDuration - reserve);
    if (cursor > deadline + 0.02) {
      throw new Error(`本镜实际 TTS 音轨需 ${cursor.toFixed(1)} 秒，超过 ${deadline.toFixed(1)} 秒台词截止点，请让导演 Agent 拆镜或延长镜头`);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const temp = destination + '.' + randomUUID() + '.part.wav';
    const inputs = generated.flatMap(item => ['-i', item.absolute]);
    const prepared = generated.map((_, index) => `[${index}:a]aresample=32000,aformat=sample_fmts=fltp:channel_layouts=mono[a${index}]`);
    const sequence = [];
    for (let index = 0; index < generated.length; index++) {
      sequence.push(`[a${index}]`);
      if (index < generated.length - 1) {
        prepared.push(`anullsrc=r=32000:cl=mono:d=${pause}[p${index}]`);
        sequence.push(`[p${index}]`);
      }
    }
    const count = sequence.length;
    const filter = `${prepared.join(';')};${sequence.join('')}concat=n=${count}:v=0:a=1,apad=whole_dur=${totalDuration},atrim=0:${totalDuration}[out]`;
    await execFile(getFfmpegPath(), ['-v', 'error', '-y', ...inputs, '-filter_complex', filter, '-map', '[out]', '-ar', '32000', '-ac', '1', '-c:a', 'pcm_s16le', temp], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    const latest = db.prepare('SELECT * FROM storyboards WHERE id=? AND deleted_at IS NULL').get(Number(shotId));
    if (!latest || extraction.sourceHash(latest) !== extraction.sourceHash(shot)) throw new Error('生成精确台词音轨期间分镜文案已变化，请重试');
    fs.renameSync(temp, destination);
    const meta = { duration: totalDuration, speech_end_seconds: Number(cursor.toFixed(3)), speech_rate: speechRate, events, source_hash: extraction.sourceHash(shot) };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    return { ...meta, local_path: relative, url: 'data:audio/wav;base64,' + fs.readFileSync(destination).toString('base64') };
  } finally {
    for (const item of generated) try { fs.unlinkSync(item.absolute); } catch {}
  }
}

module.exports = { prepare };
