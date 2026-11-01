const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { runMergedEpisodePostProcess } = require('../src/services/mergedEpisodePostProcess');
const tts = require('../src/services/ttsService');
const log = { info() {}, warn() {} };

function ffmpeg(args, binary = false) {
  const result = spawnSync('ffmpeg', ['-v', 'error', ...args], { encoding: binary ? null : 'utf8', maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, String(result.stderr));
  return result.stdout;
}
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subtitle-test-'));
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE dramas(id INTEGER, metadata TEXT, deleted_at TEXT);
    CREATE TABLE episodes(id INTEGER, drama_id INTEGER);
    CREATE TABLE storyboards(id INTEGER, episode_id INTEGER, dialogue TEXT, narration TEXT,
      audio_local_path TEXT, narration_audio_local_path TEXT, deleted_at TEXT);
    INSERT INTO dramas VALUES(1, '{}', NULL);
    INSERT INTO episodes VALUES(1, 1);
    INSERT INTO storyboards VALUES(1,1,'小明：你好。','',NULL,NULL,NULL),
      (2,1,'教官：继续前进。','他们走进院子。',NULL,NULL,NULL);`);
  t.mock.method(tts, 'synthesize', async () => { throw new Error('字幕不应调用 TTS'); });
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  function video(name, duration, audio = true) {
    const file = path.join(root, name + '.mp4');
    const args = ['-y', '-f', 'lavfi', '-i', `color=black:s=640x360:r=24:d=${duration}`];
    if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${duration}`, '-c:a', 'aac');
    ffmpeg([...args, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
    return file;
  }
  return { root, db, video };
}

test('subtitle-only burns dialogue and narration, uses actual clip durations and preserves encoded audio', async t => {
  const { root, db, video } = setup(t);
  const input = video('input', 3);
  const sources = [video('first', 1), video('second', 2)];
  const audioHash = file => ffmpeg(['-i', file, '-map', '0:a:0', '-c:a', 'copy', '-f', 'hash', '-hash', 'sha256', '-']);
  const before = audioHash(input);
  const result = await runMergedEpisodePostProcess(db, log, { mergedAbsPath: input, storageRoot: root,
    sceneSourcePaths: sources, scenes: [{ scene_id: 1, duration: 8 }, { scene_id: 2, duration: 8 }],
    episodeId: 1, mergeOpts: { burn_subtitles: true } });
  assert.equal(result.ok, true, result.error);
  const output = path.join(root, result.relativePath);
  assert.equal(audioHash(output), before, 'original encoded audio remains unchanged');
  const srt = fs.readFileSync(path.join(root, 'input_subtitles.srt'), 'utf8');
  assert.match(srt, /00:00:00,000 --> 00:00:01,000\n你好。/);
  assert.match(srt, /00:00:01,000 --> 00:00:03,000\n继续前进。\n他们走进院子。/);
  assert.doesNotMatch(srt, /小明|教官/);
  const pixels = ffmpeg(['-ss', '0.5', '-i', output, '-frames:v', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', '-'], true);
  assert.ok(pixels.filter(value => value > 180).length > 20, 'subtitle pixels are actually burned into the black frame');
  assert.equal(tts.synthesize.mock.callCount(), 0);
});

test('subtitle-only also works on silent video and combines with watermark', async t => {
  const { root, db, video } = setup(t);
  const result = await runMergedEpisodePostProcess(db, log, { mergedAbsPath: video('silent', 1, false),
    storageRoot: root, scenes: [{ scene_id: 1, duration: 1 }], episodeId: 1,
    mergeOpts: { burn_subtitles: true, watermark_text: 'Test' } });
  assert.equal(result.ok, true, result.error);
  assert.equal(tts.synthesize.mock.callCount(), 0);
});

test('empty speech reports an actionable error instead of a successful unsubtitled export', async t => {
  const { root, db, video } = setup(t);
  db.exec("UPDATE storyboards SET dialogue='无对白', narration='无旁白'");
  const input = video('empty', 1);
  const result = await runMergedEpisodePostProcess(db, log, { mergedAbsPath: input, storageRoot: root,
    scenes: [{ scene_id: 1, duration: 1 }], episodeId: 1, mergeOpts: { burn_subtitles: true } });
  assert.equal(result.ok, false);
  assert.match(result.error, /没有可用的对白或旁白/);
  assert.ok(fs.existsSync(input));
});

test('explicit dialogue replacement requires an audio file instead of silently muting original speech', async t => {
  const { root, db, video } = setup(t);
  const result = await runMergedEpisodePostProcess(db, log, { mergedAbsPath: video('missing', 1), storageRoot: root,
    scenes: [{ scene_id: 1, duration: 1 }], episodeId: 1, mergeOpts: { burn_dialogue_audio: true } });
  assert.equal(result.ok, false);
  assert.match(result.error, /缺少对白配音文件/);
});

test('merge pipeline fails visibly if subtitles cannot be processed instead of returning first-clip success', async t => {
  const { db } = setup(t);
  db.exec(`CREATE TABLE video_merges(id INTEGER, episode_id INTEGER, drama_id INTEGER, task_id TEXT,
    scenes TEXT, merge_options TEXT, status TEXT, error_msg TEXT, deleted_at TEXT);`);
  db.prepare('INSERT INTO video_merges VALUES(1,1,1,NULL,?,?,\'pending\',NULL,NULL)').run(
    JSON.stringify([{ scene_id: 1, duration: 4, video_url: 'missing-test-video.mp4' }]),
    JSON.stringify({ burn_subtitles: true }),
  );
  await require('../src/services/videoMergeService').processVideoMerge(db, log, 1, '');
  const row = db.prepare('SELECT status, error_msg FROM video_merges').get();
  assert.equal(row.status, 'failed');
  assert.match(row.error_msg, /字幕\/配音后处理/);
});
