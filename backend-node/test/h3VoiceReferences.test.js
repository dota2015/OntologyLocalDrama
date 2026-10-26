const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');
const voices = require('../src/services/h3VoiceReferenceService');
const tts = require('../src/services/ttsService');
const client = require('../src/services/videoClient');
const configs = require('../src/services/aiConfigService');
const log = { info() {}, warn() {}, error() {} };

function wav(seconds = 3) {
  const data = Buffer.alloc(44 + 32000 * seconds * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(32000, 24); data.writeUInt32LE(64000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(data.length - 44, 40);
  return data;
}
function setup(t) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE dramas (id INTEGER PRIMARY KEY, title TEXT, created_at TEXT, metadata TEXT, updated_at TEXT, deleted_at TEXT);
    CREATE TABLE episodes (id INTEGER PRIMARY KEY, drama_id INTEGER, episode_number INTEGER, deleted_at TEXT);
    CREATE TABLE characters (id INTEGER PRIMARY KEY, drama_id INTEGER, name TEXT, description TEXT, appearance TEXT, voice_style TEXT, sort_order INTEGER, deleted_at TEXT);
    CREATE TABLE storyboards (id INTEGER PRIMARY KEY, episode_id INTEGER, storyboard_number INTEGER, dialogue TEXT, narration TEXT, action TEXT, description TEXT, title TEXT, universal_segment_text TEXT, deleted_at TEXT);
    INSERT INTO dramas VALUES(1,'故事','2026-10-22','{"keep":"unchanged","tts_dubbing":{"config_id":4,"default_voice":"zh-CN-YunjianNeural","narrator_voice":"zh-CN-YunyangNeural","voices":{"王奕宸":"zh-CN-YunxiaNeural","林教官":"zh-CN-YunxiNeural"},"character_voices":{"5":"zh-CN-YunxiaNeural","6":"zh-CN-YunxiNeural"}}}','',NULL),
      (2,'其他项目','2026-10-22','{}','',NULL);
    INSERT INTO episodes VALUES(11,1,1,NULL),(21,2,1,NULL);
    INSERT INTO characters VALUES(5,1,'王奕宸','少年','','',0,NULL),(6,1,'林教官','成年男子','','',1,NULL),(7,2,'外人','','','',0,NULL);
    INSERT INTO storyboards VALUES(1,11,1,'王奕宸："你好。" 林教官："继续。"','他们准备出发。','','','','',NULL),
      (2,11,2,'','无旁白','','','','',NULL);`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-voice-test-'));
  const calls = [];
  t.mock.method(configs, 'listConfigs', () => [{ id: 4, is_active: true, is_default: true, provider: 'edge-tts', model: [] }]);
  t.mock.method(tts, 'synthesize', async (_db, _log, options) => {
    calls.push(options);
    const rel = 'audio/test-' + calls.length + '.wav';
    fs.mkdirSync(path.join(root, 'audio'), { recursive: true });
    fs.writeFileSync(path.join(root, rel), wav());
    return { local_path: rel };
  });
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { db, root, calls };
}

test('Edge samples are cached, concurrent preparation deduplicates and voice changes invalidate only that sample', async t => {
  const { db, root, calls } = setup(t);
  const initialShots = db.prepare('SELECT * FROM storyboards').all();
  const [a, b] = await Promise.all([voices.prepare(db, log, 1, 5, root), voices.prepare(db, log, 1, 5, root)]);
  assert.equal(calls.length, 1);
  assert.equal(a.automatic.local_path, b.automatic.local_path);
  assert.equal(calls[0].voice_id, 'zh-CN-YunxiaNeural');
  assert.equal(calls[0].text, voices.SAMPLE_TEXT);
  const narrator = await voices.prepare(db, log, 1, 'narrator', root);
  assert.equal(calls[1].voice_id, 'zh-CN-YunyangNeural');
  assert.notEqual(narrator.automatic.local_path, a.automatic.local_path);
  const metadata = JSON.parse(db.prepare('SELECT metadata FROM dramas WHERE id=1').get().metadata);
  metadata.tts_dubbing.voices['王奕宸'] = metadata.tts_dubbing.character_voices['5'] = 'zh-CN-XiaoyiNeural';
  db.prepare('UPDATE dramas SET metadata=? WHERE id=1').run(JSON.stringify(metadata));
  assert.equal(voices.getSettings(db, 1, 5, root).automatic, null);
  const updated = await voices.prepare(db, log, 1, 5, root);
  assert.equal(calls.length, 3);
  assert.notEqual(updated.automatic.local_path, a.automatic.local_path);
  assert.ok(fs.existsSync(path.join(root, a.automatic.local_path)));
  assert.equal(JSON.parse(db.prepare('SELECT metadata FROM dramas WHERE id=1').get().metadata).keep, 'unchanged');
  assert.deepEqual(db.prepare('SELECT * FROM storyboards').all(), initialShots);
});

test('uploaded audio takes precedence, removal restores auto voice; invalid uploads preserve current selection', async t => {
  const { db, root, calls } = setup(t);
  const automatic = await voices.prepare(db, log, 1, 5, root);
  const uploaded = await voices.upload(db, 1, 5, root, { originalname: 'my-voice.wav', buffer: wav(4) });
  assert.equal(uploaded.source, 'uploaded');
  const prepared = await voices.prepare(db, log, 1, 5, root);
  assert.equal(prepared.uploaded.local_path, uploaded.uploaded.local_path);
  assert.equal(calls.length, 1);
  await assert.rejects(voices.upload(db, 1, 5, root, { originalname: 'bad.wav', buffer: wav(1) }), /2～15/);
  assert.equal(voices.getSettings(db, 1, 5, root).uploaded.local_path, uploaded.uploaded.local_path);
  const restored = voices.removeUpload(db, 1, 5, root);
  assert.equal(restored.source, 'edge-tts');
  assert.equal(restored.automatic.local_path, automatic.automatic.local_path);
  assert.ok(fs.existsSync(path.join(root, uploaded.uploaded.local_path)));
  assert.throws(() => voices.getSettings(db, 1, 7, root), /不属于/);
  assert.throws(() => voices.resolveAudio(root, '../outside.wav'));
});

test('only actual speakers and narrator are bound in order, silence uses no TTS and four voices fail before synthesis', async t => {
  const { db, root, calls } = setup(t);
  const result = await voices.forShot(db, log, 1, 1, root);
  assert.deepEqual(result.references.map(r => r.speaker), ['王奕宸', '林教官', '旁白']);
  assert.match(result.instructions, /人物"王奕宸"，使用 <Audio 1> 的音色，说："你好。"/);
  assert.match(result.instructions, /画外旁白（人物不张嘴），使用 <Audio 3>/);
  assert.ok(result.references.every(r => r.url.startsWith('data:audio/wav;base64,')));
  const silent = await voices.forShot(db, log, 1, 2, root);
  assert.equal(silent.references.length, 0);
  assert.equal(calls.length, 3);
  db.prepare('UPDATE storyboards SET dialogue=?, narration=? WHERE id=1').run('王奕宸："甲。" 林教官："乙。" 邀请函播报："丙。"', '丁。');
  await assert.rejects(voices.forShot(db, log, 1, 1, root), /最多支持 3/);
  assert.equal(calls.length, 3);
});

test('H3 client passes audio references and original frame roles; other model configurations are untouched', async t => {
  const config = { is_active: true, is_default: true, provider: 'minimax_h3', model: ['minimax_h3'], default_model: 'minimax_h3', base_url: 'http://bridge.example', endpoint: '/v1/videos', settings: '{"supports_voice_reference":true}' };
  t.mock.method(configs, 'listConfigs', () => [config]);
  let generated = 0;
  t.mock.method(voices, 'forShot', async (_db, _log, dramaId, shotId) => {
    generated++; assert.equal(dramaId, 1); assert.equal(shotId, 1);
    return { references: [{ speaker: '王奕宸', url: 'data:audio/wav;base64,AAAA' }], instructions: '\nVoice binding <Audio 1>' };
  });
  const submitted = [];
  t.mock.method(global, 'fetch', async (_url, opts) => {
    submitted.push(JSON.parse(opts.body));
    return { ok: true, status: 200, text: async () => '{"id":"test-task"}' };
  });
  const opts = { model: 'minimax_h3', drama_id: 1, storyboard_id: 1, prompt: 'Original shot', first_frame_url: 'https://cdn/first.png', last_frame_url: 'https://cdn/last.png' };
  await client.callVideoApi({}, log, opts);
  assert.equal(generated, 1);
  assert.deepEqual(submitted[0].content.map(c => c.role).filter(Boolean), ['first_frame', 'last_frame', 'reference_audio']);
  assert.match(submitted[0].content[0].text, /Original shot\nVoice binding/);
  config.settings = '{}';
  await client.callVideoApi({}, log, opts);
  assert.equal(generated, 1);
  assert.equal(submitted[1].content.some(c => c.type === 'audio_url'), false);
});

test('project speed changes regenerate automatic references at 1.5x and preserve uploaded audio and history', async t => {
  const {db,root,calls}=setup(t);
  const slow=await voices.prepare(db,log,1,5,root);
  const uploaded=await voices.upload(db,1,'narrator',root,{originalname:'narrator.wav',buffer:wav(3)});
  const metadata=JSON.parse(db.prepare('SELECT metadata FROM dramas WHERE id=1').get().metadata);
  metadata.narrative_style={preset:'dialogue_fast',speech_rate:1.5};
  db.prepare('UPDATE dramas SET metadata=? WHERE id=1').run(JSON.stringify(metadata));
  assert.equal(voices.getSettings(db,1,5,root).automatic,null);
  const fast=await voices.prepare(db,log,1,5,root);
  assert.equal(calls.length,2);
  assert.equal(calls[1].speed,1.5);
  assert.equal(fast.automatic.speed,1.5);
  assert.notEqual(fast.automatic.local_path,slow.automatic.local_path);
  assert.ok(fs.existsSync(path.join(root,slow.automatic.local_path)));
  const narrator=await voices.prepare(db,log,1,'narrator',root);
  assert.equal(narrator.uploaded.local_path,uploaded.uploaded.local_path);
  assert.equal(calls.length,2);
});
