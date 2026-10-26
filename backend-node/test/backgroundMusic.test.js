const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const express = require('express');
const music = require('../src/services/backgroundMusicService');
const routes = require('../src/routes/backgroundMusic');
const post = require('../src/services/mergedEpisodePostProcess');
const log = { info() {}, warn() {}, error() {} };
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-bgm-'));
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE dramas(id INTEGER PRIMARY KEY,title TEXT,metadata TEXT,created_at TEXT,updated_at TEXT,deleted_at TEXT);
    CREATE TABLE episodes(id INTEGER PRIMARY KEY,drama_id INTEGER,deleted_at TEXT);
    CREATE TABLE storyboards(id INTEGER PRIMARY KEY,episode_id INTEGER,dialogue TEXT,narration TEXT,audio_local_path TEXT,narration_audio_local_path TEXT,deleted_at TEXT);
    INSERT INTO dramas VALUES(1,'Test','{"tts_dubbing":{"narrator_voice":"keep"}}','2026-10-22','',NULL),(2,'Other','{}','2026-10-22','',NULL);
    INSERT INTO episodes VALUES(1,1,NULL),(2,1,NULL),(3,2,NULL);
    INSERT INTO storyboards VALUES(1,1,'甲：你好','', 'speech.mp3',NULL,NULL);`);
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { db, root };
}
function sample(root, filename = 'music.wav', frequency = 880, duration = 0.4) {
  const file = path.join(root, filename);
  run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${duration}`, file]);
  return file;
}
function video(root, filename, audio = false) {
  const file = path.join(root, filename);
  const inputs = ['-f', 'lavfi', '-i', 'color=black:s=64x64:r=20:d=1.5'];
  if (audio) inputs.push('-f', 'lavfi', '-i', 'sine=frequency=330:duration=1.5');
  run('ffmpeg', ['-v', 'error', '-y', ...inputs, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...(audio ? ['-c:a', 'aac'] : []), file]);
  return file;
}
function amplitude(file, start, frequency, duration = 0.2) {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(start), '-i', file, '-t', String(duration), '-map', '0:a:0', '-f', 'f32le', '-ac', '1', '-ar', '8000', '-'], { maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, String(result.stderr));
  const n = result.stdout.length / 4;
  let real = 0, imaginary = 0;
  for (let i = 0; i < n; i++) {
    const value = result.stdout.readFloatLE(i * 4), angle = 2 * Math.PI * frequency * i / 8000;
    real += value * Math.cos(angle); imaginary += value * Math.sin(angle);
  }
  return 2 * Math.hypot(real, imaginary) / n;
}
test('episode music upload is playable, isolated and preserves voice metadata; removal retains referenced files', async t => {
  const { db, root } = setup(t);
  const source = sample(root);
  const settings = await music.upload(db, 1, root, { originalname: 'theme.wav', buffer: fs.readFileSync(source) });
  assert.equal(settings.enabled, true);
  assert.equal(settings.volume, 20);
  assert.ok(settings.duration > 0);
  assert.ok(settings.local_path.startsWith('projects/0001_20261022_Test/audio/bgm/'));
  assert.ok(fs.existsSync(music.resolveAudioPath(root, settings.local_path)));
  assert.equal(music.getSettings(db, 2).local_path, null);
  assert.equal(music.getSettings(db, 3).local_path, null);
  assert.equal(JSON.parse(db.prepare('SELECT metadata FROM dramas WHERE id=1').get().metadata).tts_dubbing.narrator_voice, 'keep');
  music.saveSettings(db, 1, { volume: 12, fade_in: 0, loop: false, local_path: '../outside.mp3' });
  const snapshot = music.snapshot(db, 1, root);
  assert.equal(snapshot.volume, 12);
  assert.equal(snapshot.local_path, settings.local_path, 'settings cannot substitute an arbitrary file');
  music.saveSettings(db, 1, { volume: 30 });
  assert.equal(snapshot.volume, 12, 'a queued merge keeps its own settings');
  assert.equal(music.remove(db, 1).local_path, null);
  assert.ok(fs.existsSync(path.join(root, snapshot.local_path)), 'old merge sources are retained');
  assert.equal(music.snapshot(db, 1, root), null);
});
test('invalid music, settings, foreign paths and symlinks are rejected', async t => {
  const { db, root } = setup(t);
  assert.throws(() => music.getSettings(db, 999), /不存在/);
  assert.throws(() => music.saveSettings(db, 1, { enabled: true }), /上传/);
  assert.throws(() => music.saveSettings(db, 1, { volume: -1 }), /范围/);
  assert.throws(() => music.saveSettings(db, 1, { fade_out: 11 }), /范围/);
  assert.throws(() => music.saveSettings(db, 1, { volume: '20' }), /范围/);
  await assert.rejects(music.upload(db, 1, root, { originalname: 'bad.wav', buffer: Buffer.from('not audio') }), /可播放/);
  await assert.rejects(music.upload(db, 1, root, { originalname: 'bad.html', buffer: Buffer.from('not audio') }), /支持/);
  assert.equal(music.getSettings(db, 1).local_path, null);
  assert.throws(() => music.resolveAudioPath(root, '../outside.mp3'), /不存在|路径/);
  assert.throws(() => music.resolveAudioPath(root, '/etc/passwd'), /路径/);
  fs.symlinkSync('/etc/passwd', path.join(root, 'link.mp3'));
  assert.throws(() => music.resolveAudioPath(root, 'link.mp3'), /路径/);
});
test('music upload and settings APIs persist through reload and return useful errors', async t => {
  const { db, root } = setup(t);
  const app = express();
  app.use(express.json());
  app.use('/music', routes(db, { storage: { local_path: root } }, log));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port + '/music/1';
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(sample(root))], { type: 'audio/wav' }), 'theme.wav');
  let result = await fetch(base + '/upload', { method: 'POST', body: form });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).data.enabled, true);
  result = await fetch(base, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ volume: 10 }) });
  assert.equal(result.status, 200);
  assert.equal((await (await fetch(base)).json()).data.volume, 10);
  result = await fetch(base, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ volume: 200 }) });
  assert.equal(result.status, 400);
  assert.equal((await (await fetch(base, { method: 'DELETE' })).json()).data.enabled, false);
});
test('BGM preserves original H3 audio and loops without extending the picture', async t => {
  const { db, root } = setup(t);
  sample(root);
  const input = video(root, 'original.mp4', true);
  const result = await post.runMergedEpisodePostProcess(db, log, { mergedAbsPath: input, storageRoot: root, scenes: [{ scene_id: 1, duration: 1.5 }], episodeId: 1, mergeOpts: { background_music: { enabled: true, local_path: 'music.wav', volume: 20, loop: true, fade_in: 0, fade_out: 0 } } });
  assert.equal(result.ok, true, result.error);
  const final = path.join(root, result.relativePath);
  assert.ok(amplitude(final, 0.8, 330) > 0.08, 'original voice/music remains audible');
  const level = amplitude(final, 0.8, 880);
  assert.ok(level > 0.015 && level < 0.04, 'music is mixed at the requested 20% volume: ' + level);
  const duration = Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', final]).trim());
  assert.ok(Math.abs(duration - 1.5) < 0.1, String(duration));
});
test('silent videos accept BGM; non-looping music stops, and fade-out decreases volume', async t => {
  const { db, root } = setup(t);
  sample(root);
  for (const loop of [false, true]) {
    const input = video(root, 'silent-' + loop + '.mp4');
    const result = await post.runMergedEpisodePostProcess(db, log, { mergedAbsPath: input, storageRoot: root, scenes: [{ scene_id: 1, duration: 1.5 }], episodeId: 1, mergeOpts: { background_music: { enabled: true, local_path: 'music.wav', volume: 20, loop, fade_in: 0, fade_out: 0.5 } } });
    assert.equal(result.ok, true, result.error);
    const final = path.join(root, result.relativePath);
    if (!loop) assert.ok(amplitude(final, 0.8, 880) < 0.001, 'music stops when looping is off');
    else {
      const middle = amplitude(final, 0.8, 880);
      assert.ok(middle > 0.015, 'short music loops until the end');
      assert.ok(amplitude(final, 1.4, 880, 0.05) < middle * 0.4, 'ending fades out');
    }
  }
});
test('BGM mixes after TTS replacement and preserves both speech and music', async t => {
  const { db, root } = setup(t);
  sample(root);
  sample(root, 'speech.mp3', 440, 1.3);
  const input = video(root, 'tts.mp4', true);
  const result = await post.runMergedEpisodePostProcess(db, log, { mergedAbsPath: input, storageRoot: root, scenes: [{ scene_id: 1, duration: 1.5 }], episodeId: 1, mergeOpts: { burn_dialogue_audio: true, background_music: { enabled: true, local_path: 'music.wav', volume: 20, loop: true, fade_in: 0, fade_out: 0 } } });
  assert.equal(result.ok, true, result.error);
  const final = path.join(root, result.relativePath);
  assert.ok(amplitude(final, 0.6, 440) > 0.07, 'TTS dialogue survives');
  assert.ok(amplitude(final, 0.6, 880) > 0.015, 'background music survives');
  assert.ok(amplitude(final, 0.6, 330) < 0.003, 'replaced original speech is not reintroduced');
});

test('the real merge worker applies the episode music snapshot and completes its task', async t => {
  const { db, root } = setup(t);
  db.exec(`ALTER TABLE episodes ADD COLUMN video_url TEXT;ALTER TABLE episodes ADD COLUMN status TEXT;ALTER TABLE episodes ADD COLUMN updated_at TEXT;
    CREATE TABLE async_tasks(id TEXT PRIMARY KEY,type TEXT,status TEXT,progress INTEGER,message TEXT,error TEXT,result TEXT,resource_id TEXT,created_at TEXT,updated_at TEXT,completed_at TEXT,deleted_at TEXT);
    CREATE TABLE video_merges(id INTEGER PRIMARY KEY,episode_id INTEGER,drama_id INTEGER,title TEXT,provider TEXT,model TEXT,status TEXT,scenes TEXT,merge_options TEXT,task_id TEXT,created_at TEXT,deleted_at TEXT,duration REAL,merged_url TEXT,error_msg TEXT,completed_at TEXT);`);
  t.mock.method(require('../src/config'), 'loadConfig', () => ({ storage: { local_path: root } }));
  await music.upload(db, 1, root, { originalname: 'theme.wav', buffer: fs.readFileSync(sample(root)) });
  music.saveSettings(db, 1, { fade_in: 0, fade_out: 0 });
  const input = video(root, 'worker-input.mp4', true);
  const merge = require('../src/services/videoMergeService');
  const created = merge.create(db, log, { episode_id: 1, drama_id: 1, scenes: [{ scene_id: 1, video_url: input, duration: 1.5 }], merge_options: {} });
  music.saveSettings(db, 1, { volume: 80 });
  await merge.processVideoMerge(db, log, created.merge_id, '');
  const result = merge.getById(db, created.merge_id);
  assert.equal(result.status, 'completed', result.error_msg);
  const final = path.join(root, result.merged_url);
  assert.ok(fs.existsSync(final));
  const level = amplitude(final, 0.8, 880);
  assert.ok(level > 0.015 && level < 0.04, 'merge uses its original 20% setting, not the later 80% setting: ' + level);
  assert.equal(db.prepare('SELECT status FROM async_tasks WHERE id=?').get(created.task_id).status, 'completed');
  assert.equal(db.prepare('SELECT video_url FROM episodes WHERE id=1').get().video_url, result.merged_url);
});
