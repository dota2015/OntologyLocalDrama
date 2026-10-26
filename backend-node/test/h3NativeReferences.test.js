const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const native = require('../src/services/h3NativeService');
const voices = require('../src/services/h3VoiceReferenceService');
const ai = require('../src/services/aiClient');
const configs = require('../src/services/aiConfigService');
const client = require('../src/services/videoClient');
const log = { info() {}, warn() {}, error() {} };
const translation = { visual_description: 'A boy with short black hair sits at a wooden desk. He turns toward the door as the camera moves slowly closer.', overall_soundscape: 'Quiet room tone and soft clothing rustle.', non_diegetic_music: 'N/A' };
function setup(t) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE dramas(id INTEGER PRIMARY KEY,title TEXT,metadata TEXT,created_at TEXT,updated_at TEXT,deleted_at TEXT);
    CREATE TABLE episodes(id INTEGER PRIMARY KEY,drama_id INTEGER,deleted_at TEXT,episode_number INTEGER DEFAULT 1);
    CREATE TABLE storyboards(id INTEGER PRIMARY KEY,episode_id INTEGER,storyboard_number INTEGER,characters TEXT,scene_id INTEGER,location TEXT,description TEXT,action TEXT,atmosphere TEXT,local_path TEXT,deleted_at TEXT);
    CREATE TABLE characters(id INTEGER PRIMARY KEY,drama_id INTEGER,name TEXT,local_path TEXT,ref_image TEXT,image_url TEXT,extra_images TEXT,appearance TEXT,description TEXT,deleted_at TEXT);
    CREATE TABLE scenes(id INTEGER PRIMARY KEY,drama_id INTEGER,name TEXT,local_path TEXT,deleted_at TEXT);
    CREATE TABLE storyboard_characters(id INTEGER PRIMARY KEY,storyboard_id INTEGER,character_id INTEGER);
    CREATE TABLE props(id INTEGER PRIMARY KEY,drama_id INTEGER,name TEXT,local_path TEXT,description TEXT,deleted_at TEXT);
    CREATE TABLE storyboard_props(storyboard_id INTEGER,prop_id INTEGER);
    CREATE TABLE image_generations(id INTEGER PRIMARY KEY,character_id INTEGER,local_path TEXT,prompt TEXT,deleted_at TEXT);
    CREATE TABLE video_generations(id INTEGER PRIMARY KEY,drama_id INTEGER,storyboard_id INTEGER,status TEXT,local_path TEXT,deleted_at TEXT);
    INSERT INTO dramas VALUES(1,'测试','{"keep":true,"storage_folder_label":"test"}','2026-10-22','',NULL),(2,'其他','{}','2026-10-22','',NULL);
    INSERT INTO episodes(id,drama_id,deleted_at) VALUES(10,1,NULL),(20,2,NULL);
    INSERT INTO storyboards VALUES(1,10,1,'[5]',2,'房间','少年转身','','',NULL,NULL),(2,10,2,'[5]',2,'房间','少年开口','','',NULL,NULL),(3,10,3,'[5]',3,'操场','','','',NULL,NULL),(4,20,1,'[]',NULL,'','','','',NULL,NULL);
    INSERT INTO characters VALUES(5,1,'王奕宸','card.png',NULL,NULL,'["profile.png"]','少年，黑色短发','',NULL);
    INSERT INTO scenes VALUES(2,1,'房间','room.png',NULL),(3,1,'操场','field.png',NULL);
    INSERT INTO image_generations VALUES(1,5,'card.png','character reference sheet',NULL);`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-native-'));
  for (const file of ['card.png', 'profile.png', 'room.png', 'field.png', 'first.png', 'last.png']) fs.writeFileSync(path.join(root, file), 'image bytes ' + file);
  t.mock.method(voices, 'forShot', async () => ({ references: [], lines: [] }));
  t.mock.method(ai, 'generateText', async () => JSON.stringify(translation));
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { db, root, opts: { drama_id: 1, storyboard_id: 2, storage_local_path: root, prompt: '@图片1 房间中的男孩转身', aspect_ratio: '16:9', duration: 5 } };
}
test('official R2V compiler binds multiple pictures to one identity and preserves only exact speech in dialogue tags', () => {
  const refs = [{ source: 'card', kind: 'character_sheet', character_id: 5 }, { source: 'side', kind: 'character', character_id: 5 }, { source: 'frame', kind: 'first_frame' }];
  const speech = { references: [{ key: 'character:5', kind: 'dialogue' }, { key: 'narrator', kind: 'narration' }], lines: [
    { key: 'character:5', kind: 'dialogue', text: '先想清楚，再开始行动。' }, { key: 'narrator', kind: 'narration', text: '他终于下定决心。' },
  ] };
  const prompt = native.compilePrompt(refs, speech, translation, { first: 'frame' });
  assert.match(prompt, /<Subject 1> is the same person across <Picture 1>, <Picture 2>/);
  assert.match(prompt, /<Audio 1> is the voice-timbre reference for <Subject 1> \(S1\)/);
  assert.match(prompt, /<Audio 2> is the voice-timbre reference for the off-screen narrator \(S2\)/);
  assert.match(prompt, /<Audio 1>: reference/);
  assert.match(prompt, /<Picture 3> is the opening frame/);
  assert.deepEqual([...prompt.matchAll(/<d>\[Chinese\] (.*?)<\/d>/g)].map(m => m[1]), speech.lines.map(l => l.text));
  assert.doesNotMatch(prompt.replace(/<d>.*?<\/d>/g, ''), /\p{Script=Han}/u);
  assert.deepEqual([...prompt.matchAll(/^(\w+):$/gm)].map(m => m[1]), ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music']);
  assert.match(native.compilePrompt(refs, speech, { ...translation, visual_description: 'A handwritten heading reads "解" on the page.' }), /reads "解"/);
  assert.throws(() => native.compilePrompt(refs, speech, null), /有效/);
  assert.throws(() => native.compilePrompt(refs, speech, { ...translation, visual_description: 'No speech. 避免变形' }), /失败/);

  // Negative words auto-sanitized without throwing
  const cleanPrompt = native.compilePrompt(refs, speech, {
    ...translation,
    visual_description: 'A boy crouches quietly. No text interface or countdown appears.',
    overall_soundscape: 'Ambient room tone, without dialogue.',
    non_diegetic_music: 'No background music is played.'
  });
  assert.doesNotMatch(cleanPrompt, /\b(no|not|without|avoid|never)\b/i);
  assert.match(cleanPrompt, /A boy crouches quietly/);
  assert.match(cleanPrompt, /Ambient room tone/);
  assert.match(cleanPrompt, /non_diegetic_music:\s*N\/A/);
});

test('H3 sanitizers clean Chinese exclusion noise and English negative words', () => {
  const strippedZh = native.stripChineseExclusions('仓储深处一只低调封闭的情报箱静置，不出现任何文字界面或倒计时。镜头标题：岔路失措。');
  assert.equal(strippedZh, '仓储深处一只低调封闭的情报箱静置。镜头标题：岔路失措。');

  const strippedZh2 = native.stripChineseExclusions('仓库内部货箱区，无UI界面或倒计时，黄昏光线');
  assert.equal(strippedZh2, '仓库内部货箱区，黄昏光线');

  const cleanedEnVisual = native.sanitizeH3NegativeProse('Man crouches behind crates. No text interface or countdown appears.', '画面');
  assert.equal(cleanedEnVisual, 'Man crouches behind crates.');

  const cleanedEnVisual2 = native.sanitizeH3NegativeProse('A low-profile sealed intel case rests deep in the storage area, without any text interface or countdown.', '画面');
  assert.equal(cleanedEnVisual2, 'A low-profile sealed intel case rests deep in the storage area.');

  const cleanedEnMusic = native.sanitizeH3NegativeProse('No background music is played.', '配乐');
  assert.equal(cleanedEnMusic, 'N/A');
});
test('H3 consumes the saved per-shot pace and records the same conservative budget', async t => {
  const { db, root, opts } = setup(t);
  db.exec('ALTER TABLE storyboards ADD COLUMN dialogue TEXT; ALTER TABLE storyboards ADD COLUMN duration REAL;');
  db.prepare('UPDATE dramas SET metadata=? WHERE id=1').run(JSON.stringify({
    narrative_style: { preset: 'dialogue_fast', speech_mode: 'auto', speech_rate: 1.25 },
    storage_folder_label: 'test',
  }));
  db.prepare('UPDATE storyboards SET dialogue=?,duration=5 WHERE id=2').run('王奕宸："开始行动。"');
  require('../src/services/speechDeliveryService').recordAiPlan(db, 10, 2, {
    speech_rate: 1.4, speech_rate_reason: '急促短句', emotion: '急促争吵',
  });
  voices.forShot.mock.mockImplementation(async () => ({
    references: [{ key: 'character:5', kind: 'dialogue', url: 'data:audio/wav;base64,AAAA' }],
    lines: [{ key: 'character:5', kind: 'dialogue', speaker: '王奕宸', text: '开始行动。' }],
  }));
  const result = await native.prepare(db, log, opts);
  assert.match(result.prompt, /approximately 1.4 times/);
  const input = JSON.parse(ai.generateText.mock.calls[0].arguments[3]);
  assert.equal(input.speech_delivery.speech_rate, 1.4);
  assert.equal(input.speech_delivery.han_budget, 19);
  assert.equal(native.getSettings(db, 1, 2).steps, 23);
  const directory = path.join(root, 'projects/0001_20261022_test/h3-prompts');
  const record = JSON.parse(fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0])));
  assert.deepEqual(record.speech_delivery, input.speech_delivery);
  assert.equal(record.steps, 23);
});
test('selected stage reference reaches H3 and a new outfit starts from its own frame', async t => {
  const { db, root, opts } = setup(t);
  db.exec('ALTER TABLE characters ADD COLUMN stages TEXT;');
  db.prepare('UPDATE characters SET stages=? WHERE id=5').run(JSON.stringify([
    { id: 'training', name: '训练装', appearance: '白色训练服', reference_image: 'training.png' },
  ]));
  fs.writeFileSync(path.join(root, 'training.png'), 'stage image');
  require('../src/services/wardrobeService').saveShot(db, 2, { change: {
    boundary: 'before_shot', reason: '进入三角洲', characters: [{ character_id: 5, stage_id: 'training' }],
  } });
  const result = await native.prepare(db, log, { ...opts, first_frame_url: 'first.png', last_frame_url: 'last.png' });
  assert.match(result.prompt, /supplies the selected outfit/);
  assert.match(result.prompt, /One outfit per character/);
  assert.ok(result.reference_urls.some(url => url.includes(Buffer.from('stage image').toString('base64'))));
  assert.equal(native.getSettings(db, 1, 2).continuity_reset, true);
  native.saveSettings(db, 1, 2, { continuity: 'previous_tail' });
  await assert.rejects(native.prepare(db, log, opts), /新造型首帧/);
});
test('settings are project-scoped, merge only the shot setting, and report actual immediate predecessor', t => {
  const { db } = setup(t);
  assert.throws(() => native.getSettings(db, 1, 4), /不属于/);
  assert.throws(() => native.saveSettings(db, 1, 2, { continuity: 'anything' }), /请选择/);
  native.saveSettings(db, 1, 2, { continuity: 'off' });
  const metadata = JSON.parse(db.prepare('SELECT metadata FROM dramas WHERE id=1').get().metadata);
  assert.equal(metadata.keep, true);
  assert.equal(metadata.h3_shots[2].continuity, 'off');
  assert.equal(native.getSettings(db, 1, 2).previous_storyboard.id, 1);
  assert.equal(native.getSettings(db, 1, 3).previous_storyboard.same_scene, false);
});
test('backend assembles deduplicated ordered images, first/last guides, voice and native size in a single H3 request', async t => {
  const { db, root, opts } = setup(t);
  voices.forShot.mock.mockImplementation(async () => ({ references: [{ key: 'character:5', kind: 'dialogue', url: 'data:audio/wav;base64,AAAA' }], lines: [{ key: 'character:5', kind: 'dialogue', text: '开始行动。' }] }));
  const configuration = { is_active: true, is_default: true, provider: 'minimax_h3', api_protocol: 'minimax_h3', model: ['MiniMax-H3'], default_model: 'MiniMax-H3', base_url: 'http://bridge.example', endpoint: '/v1/videos', settings: { h3_native_references: true } };
  t.mock.method(configs, 'listConfigs', () => [configuration]);
  let body;
  t.mock.method(global, 'fetch', async (_url, options) => { body = JSON.parse(options.body); return { ok: true, status: 200, text: async () => '{"id":"native-task"}' }; });
  const result = await client.callVideoApi(db, log, { ...opts, model: 'MiniMax-H3', first_frame_url: 'http://host/static/first.png', last_frame_url: '/static/last.png', reference_urls: ['http://host/static/room.png', 'http://host/static/card.png', 'first.png', 'last.png'] });
  assert.equal(result.task_id, 'native-task');
  assert.deepEqual(body.h3_native, { width: 1344, height: 768, steps: 23 });
  const images = body.content.filter(i => i.type === 'image_url');
  assert.deepEqual(images.map(i => i.role), ['first_frame', 'last_frame', ...Array(5).fill('reference_image')]);
  assert.equal(images[0].image_url.url, images[5].image_url.url);
  assert.equal(images[1].image_url.url, images[6].image_url.url);
  const prompt = body.content[0].text;
  assert.match(prompt, /<Picture 4> is the opening/);
  assert.match(prompt, /<d>\[Chinese\] 开始行动。<\/d>/);
  assert.doesNotMatch(prompt, /本镜声音绑定|不复读|音色/);
  const input = JSON.parse(ai.generateText.mock.calls[0].arguments[3]);
  assert.deepEqual(input.source_reference_order.map(r => r.target_picture), [3, 1, 4, 5]);
  assert.equal(fs.readdirSync(path.join(root, 'projects/0001_20261022_test/h3-prompts')).length, 1);
});
test('scene changes skip preceding tails, explicit unavailable tails and oversized lists are auto-capped to 9', async t => {
  const { db, opts } = setup(t);
  const sceneChange = await native.prepare(db, log, { ...opts, storyboard_id: 3 });
  assert.equal(sceneChange.first_frame_url, undefined);
  native.saveSettings(db, 1, 2, { continuity: 'previous_tail' });
  await assert.rejects(native.prepare(db, log, opts), /上一镜尚无/);
  native.saveSettings(db, 1, 2, { continuity: 'off' });
  const capped = await native.prepare(db, log, { ...opts, reference_urls: Array.from({ length: 10 }, (_, i) => `https://example.com/${i}.png`) });
  assert.ok(capped.reference_urls.length <= 9);
});
test('asset edits during translation abort submission and all canvas presets respect the native pixel limit', async t => {
  const { db, opts } = setup(t);
  ai.generateText.mock.mockImplementation(async () => { db.prepare('UPDATE characters SET extra_images=? WHERE id=5').run('[]'); return JSON.stringify(translation); });
  await assert.rejects(native.prepare(db, log, opts), /已变化/);
  for (const ratio of ['16:9','9:16','1:1','4:3','3:4','21:9']) {
    const [w,h] = native.nativeCanvas(ratio);
    assert.ok(w % 32 === 0 && h % 32 === 0 && w*h <= 1344*768);
  }
});

test('legacy character links and scoped props join the same reference registry; malformed extras do not crash', t => {
  const { db } = setup(t);
  db.exec(`UPDATE storyboards SET characters='[]' WHERE id=2;
    INSERT INTO storyboard_characters VALUES(1,2,5);
    UPDATE characters SET extra_images='{}' WHERE id=5;
    INSERT INTO props VALUES(8,1,'书包','bag.png','blue bag',NULL),(9,2,'其他','other.png','',NULL);
    INSERT INTO storyboard_props VALUES(2,8),(2,9);`);
  assert.deepEqual(native.assetReferences(db, 1, db.prepare('SELECT * FROM storyboards WHERE id=2').get()).map(r => r.source), ['card.png','room.png','bag.png']);
});
test('shot edits while voice references are prepared abort before visual translation', async t => {
  const { db, opts } = setup(t);
  voices.forShot.mock.mockImplementation(async () => {
    db.exec("UPDATE storyboards SET characters='[]' WHERE id=2");
    return { references: [], lines: [] };
  });
  await assert.rejects(native.prepare(db, log, opts), /已变化/);
  assert.equal(ai.generateText.mock.callCount(), 0);
});
test('automatic continuity extracts the selected previous video final decoded frame and retains this shot first frame as context', async t => {
  const { db, root, opts } = setup(t);
  const { promisify } = require('util');
  const run = promisify(require('child_process').execFile);
  const ffmpeg = require('../src/utils/ffmpegPath').getFfmpegPath();
  await run(ffmpeg, ['-v','error','-y','-f','lavfi','-i','testsrc2=s=128x96:r=24:d=1','-c:v','libx264','-pix_fmt','yuv420p',path.join(root,'previous.mp4')]);
  db.prepare('UPDATE storyboards SET local_path=? WHERE id=1').run('previous.mp4');
  const result = await native.prepare(db, log, { ...opts, first_frame_url: 'first.png' });
  assert.ok(result.first_frame_url.startsWith('data:image/png;base64,'));
  assert.notEqual(result.first_frame_url, result.reference_urls[3]);
  assert.equal(result.reference_urls.length, 5);
  const tail = await native.tailFrame(db, 1, db.prepare('SELECT * FROM storyboards WHERE id=1').get(), root);
  const expected = await run(ffmpeg, ['-v','error','-i',path.join(root,'previous.mp4'),'-vf',"select='eq(n,23)'",'-vsync','0','-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'], { encoding:'buffer' });
  const actual = await run(ffmpeg, ['-v','error','-i',path.join(root,tail),'-f','rawvideo','-pix_fmt','rgb24','pipe:1'], { encoding:'buffer' });
  assert.deepEqual(actual.stdout, expected.stdout);
  native.saveSettings(db, 1, 2, { continuity: 'off' });
  const off = await native.prepare(db, log, { ...opts, first_frame_url: 'first.png' });
  assert.equal(off.first_frame_url, 'data:image/png;base64,' + fs.readFileSync(path.join(root,'first.png')).toString('base64'));
});

test('native project opt-in preserves standalone H3 requests which have no storyboard context', async t => {
  t.mock.method(configs, 'listConfigs', () => [{ is_active: true, is_default: true, provider: 'minimax_h3', model: ['minimax_h3'], base_url: 'http://bridge.example', endpoint: '/v1/videos', settings: { h3_native_references: true } }]);
  let body;
  t.mock.method(global, 'fetch', async (_url, options) => { body=JSON.parse(options.body); return { ok:true,status:200,text:async ()=>' {"id":"generic"}' }; });
  const result = await client.callVideoApi(null, log, { model:'minimax_h3', prompt:'A calm landscape',duration:5 });
  assert.equal(result.task_id,'generic');
  assert.equal(body.content[0].text,'A calm landscape');
  assert.equal(body.h3_native,undefined);
});

test('an explicit wardrobe transition skips previous-tail selection and rejects forced continuity',async t=>{
  const {db,root,opts}=setup(t);
  const wardrobe=require('../src/services/wardrobeService');
  wardrobe.saveShot(db,2,{change:{reason:'进入梦境，更换训练服',characters:[{character_id:5,description:'银色训练服，黑色靴子'}]}});
  // A completed predecessor exists but its local file is deliberately unavailable.
  db.prepare("INSERT INTO video_generations VALUES(1,1,1,'completed','prior-outfit.mp4',NULL)").run();
  const prepared=await native.prepare(db,log,{...opts,first_frame_url:'first.png'});
  assert.ok(prepared.first_frame_url);
  const input=JSON.parse(ai.generateText.mock.calls[0].arguments[3]);
  assert.equal(input.current_wardrobe.characters[0].description,'银色训练服，黑色靴子');
  native.saveSettings(db,1,2,{continuity:'previous_tail'});
  await assert.rejects(native.prepare(db,log,opts),/换装或时间线变化/);
});

test('changing narrative settings while reference audio is prepared aborts stale H3 submission',async t=>{
  const {db,opts}=setup(t);
  voices.forShot.mock.mockImplementation(async()=>{
    const metadata=JSON.parse(db.prepare('SELECT metadata FROM dramas WHERE id=1').get().metadata);
    metadata.narrative_style={preset:'dialogue_fast',speech_rate:1.5};
    db.prepare('UPDATE dramas SET metadata=? WHERE id=1').run(JSON.stringify(metadata));
    return {references:[],lines:[]};
  });
  await assert.rejects(native.prepare(db,log,opts),/叙事设置已变化/);
  assert.equal(ai.generateText.mock.callCount(),0);
});

test('H3 auto-caps references to <= 9 when total reference images exceed 9 without throwing', async t => {
  const { db, root, opts } = setup(t);
  const extraUrls = [];
  for (let i = 1; i <= 10; i++) {
    const file = `extra_${i}.png`;
    fs.writeFileSync(path.join(root, file), 'image ' + i);
    extraUrls.push(file);
  }
  const prepared = await native.prepare(db, log, {
    ...opts,
    first_frame_url: 'first.png',
    last_frame_url: 'last.png',
    reference_urls: extraUrls,
  });
  assert.ok(prepared.reference_urls.length <= 9, `Expected <= 9 reference images, got ${prepared.reference_urls.length}`);
  assert.ok(prepared.first_frame_url, 'First frame anchor must be preserved');
  assert.ok(prepared.last_frame_url, 'Last frame anchor must be preserved');
});
