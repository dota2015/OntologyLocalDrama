const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const native = require('../src/services/h3NativeService');
const voices = require('../src/services/h3VoiceReferenceService');
const configs = require('../src/services/aiConfigService');
const client = require('../src/services/videoClient');
const log = { info() {}, warn() {}, error() {} };
const translation = { visual_description: 'A boy with short black hair sits at a wooden desk. He turns toward the door as the camera moves slowly closer.', overall_soundscape: 'Quiet room tone and soft clothing rustle.', non_diegetic_music: 'N/A' };
function setup(t) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE dramas(id INTEGER PRIMARY KEY,title TEXT,metadata TEXT,created_at TEXT,updated_at TEXT,deleted_at TEXT);
    CREATE TABLE episodes(id INTEGER PRIMARY KEY,drama_id INTEGER,deleted_at TEXT,episode_number INTEGER DEFAULT 1);
    CREATE TABLE storyboards(id INTEGER PRIMARY KEY,episode_id INTEGER,storyboard_number INTEGER,characters TEXT,scene_id INTEGER,location TEXT,description TEXT,action TEXT,atmosphere TEXT,local_path TEXT,deleted_at TEXT,semantic_slots TEXT);
    CREATE TABLE characters(id INTEGER PRIMARY KEY,drama_id INTEGER,name TEXT,local_path TEXT,ref_image TEXT,image_url TEXT,extra_images TEXT,appearance TEXT,description TEXT,deleted_at TEXT);
    CREATE TABLE scenes(id INTEGER PRIMARY KEY,drama_id INTEGER,name TEXT,local_path TEXT,deleted_at TEXT);
    CREATE TABLE storyboard_characters(id INTEGER PRIMARY KEY,storyboard_id INTEGER,character_id INTEGER);
    CREATE TABLE props(id INTEGER PRIMARY KEY,drama_id INTEGER,name TEXT,local_path TEXT,description TEXT,deleted_at TEXT);
    CREATE TABLE storyboard_props(storyboard_id INTEGER,prop_id INTEGER);
    CREATE TABLE image_generations(id INTEGER PRIMARY KEY,character_id INTEGER,local_path TEXT,prompt TEXT,deleted_at TEXT);
    CREATE TABLE video_generations(id INTEGER PRIMARY KEY,drama_id INTEGER,storyboard_id INTEGER,status TEXT,local_path TEXT,deleted_at TEXT);
    INSERT INTO dramas VALUES(1,'测试','{"keep":true,"storage_folder_label":"test"}','2026-10-22','',NULL),(2,'其他','{}','2026-10-22','',NULL);
    INSERT INTO episodes(id,drama_id,deleted_at) VALUES(10,1,NULL),(20,2,NULL);
    INSERT INTO storyboards VALUES(1,10,1,'[5]',2,'房间','少年转身','','',NULL,NULL,NULL),(2,10,2,'[5]',2,'房间','少年开口','','',NULL,NULL,NULL),(3,10,3,'[5]',3,'操场','','','',NULL,NULL,NULL),(4,20,1,'[]',NULL,'','','','',NULL,NULL,NULL);
    INSERT INTO characters VALUES(5,1,'王奕宸','card.png',NULL,NULL,'["profile.png"]','少年，黑色短发','',NULL);
    INSERT INTO scenes VALUES(2,1,'房间','room.png',NULL),(3,1,'操场','field.png',NULL);
    INSERT INTO image_generations VALUES(1,5,'card.png','character reference sheet',NULL);`);
  const flPlan = JSON.stringify({ h3_mode:'fl2va', h3_mode_reason:'精确起幅优先', first_frame_policy:'generate_new', first_frame_reason:'锁定开场', last_frame_policy:'generate_tail', last_frame_reason:'锁定落幅', required_references:[], speech_plan:{ audio_references:[] } });
  db.prepare('UPDATE storyboards SET semantic_slots=? WHERE episode_id=10').run(flPlan);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-native-'));
  for (const file of ['card.png', 'profile.png', 'room.png', 'field.png', 'first.png', 'last.png']) fs.writeFileSync(path.join(root, file), 'image bytes ' + file);
  t.mock.method(voices, 'forShot', async () => ({ references: [], lines: [] }));
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

test('exact speech soundtrack is fully copied with fixed line timing', () => {
  const refs = [{ source: 'card', kind: 'character', character_id: 5 }];
  const speech = {
    references: [{ key: 'soundtrack', kind: 'soundtrack', url: 'data:audio/wav;base64,AAAA' }],
    lines: [{ key: 'character:5', kind: 'dialogue', speaker: '王奕宸', text: '一句也不能少。' }],
    soundtrack: { events: [{ start_seconds: 0, end_seconds: 1.8 }] },
  };
  const prompt = native.compilePrompt(refs, speech, translation, {}, { duration: 5, delivery: { end_reserve_seconds: 1.5 } });
  assert.match(prompt, /\[reference generation \+ audio reuse\]/);
  assert.match(prompt, /<Audio 1>: fully_copy/);
  assert.match(prompt, /from second 0\.00 through second 1\.80/);
  assert.match(prompt, /<d>\[Chinese\] 一句也不能少。<\/d>/);
  assert.match(prompt, /complete final audio track/);
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
test('H3 ignores saved per-shot pace and records the natural-speed budget', async t => {
  const { db, root, opts } = setup(t);
  db.exec('ALTER TABLE storyboards ADD COLUMN dialogue TEXT; ALTER TABLE storyboards ADD COLUMN duration REAL;');
  db.prepare('UPDATE dramas SET metadata=? WHERE id=1').run(JSON.stringify({
    narrative_style: { preset: 'dialogue_fast', speech_mode: 'auto', speech_rate: 1.25 },
    storage_folder_label: 'test',
  }));
  db.prepare('UPDATE storyboards SET dialogue=?,duration=5 WHERE id=2').run('王奕宸："开始行动。"');
  db.prepare('UPDATE storyboards SET semantic_slots=? WHERE id=2').run(JSON.stringify({ h3_mode:'ref2va', h3_mode_reason:'声音与人物一致性优先', first_frame_policy:'none', first_frame_reason:'多参考已足够', last_frame_policy:'none', last_frame_reason:'自然收束', required_references:[{type:'character',id:5,character_id:5,name:'王奕宸'}], speech_plan:{speaker_id:5,text:'开始行动。',audio_references:[]} }));
  require('../src/services/speechDeliveryService').recordAiPlan(db, 10, 2, {
    speech_rate: 1.4, speech_rate_reason: '急促短句', emotion: '急促争吵',
  });
  voices.forShot.mock.mockImplementation(async () => ({
    references: [{ key: 'character:5', kind: 'dialogue', url: 'data:audio/wav;base64,AAAA' }],
    lines: [{ key: 'character:5', kind: 'dialogue', speaker: '王奕宸', text: '开始行动。' }],
  }));
  const result = await native.prepare(db, log, opts);
  assert.match(result.prompt, /configured TTS speed/);
  assert.doesNotMatch(result.prompt, /approximately 1.4 times/);
  assert.equal(native.getSettings(db, 1, 2).steps, 23);
  const directory = path.join(root, 'projects/0001_20261022_test/h3-prompts');
  const record = JSON.parse(fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0])));
  assert.equal(record.speech_delivery.speech_rate, 1.25);
  assert.equal(record.speech_delivery.han_budget, 25);
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
  db.prepare('UPDATE storyboards SET semantic_slots=? WHERE id=2').run(JSON.stringify({
    h3_mode:'ref2va', h3_mode_reason:'新造型一致性优先',
    first_frame_policy:'none', first_frame_reason:'服装卡承担视觉约束',
    last_frame_policy:'none', last_frame_reason:'自然收束',
    required_references:[{type:'wardrobe',character_id:5,stage_id:'training',name:'王奕宸训练装'}],
    speech_plan:{audio_references:[]},
  }));
  const result = await native.prepare(db, log, { ...opts, h3_engine_mode: 'ref2va', first_frame_url: 'first.png', last_frame_url: 'last.png' });
  assert.match(result.prompt, /supplies the selected outfit/);
  assert.match(result.prompt, /One outfit per character/);
  assert.ok(result.reference_urls.some(url => url.includes(Buffer.from('stage image').toString('base64'))));
  assert.equal(native.getSettings(db, 1, 2).continuity_reset, true);
  native.saveSettings(db, 1, 2, { engine_mode: 'fl2va', continuity: 'previous_tail' });
  await assert.rejects(native.prepare(db, log, opts), /新首帧/);
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
  const overridden = native.saveSettings(db, 1, 2, { first_frame_policy: 'inherit_tail', last_frame_policy: 'none' });
  assert.equal(overridden.h3_generation_plan.first_frame_policy, 'inherit_tail');
  assert.equal(overridden.h3_generation_plan.last_frame_policy, 'none');
  assert.equal(overridden.h3_generation_plan.agent_first_frame_policy, 'generate_new');
  const restored = native.saveSettings(db, 1, 2, { first_frame_policy: 'agent', last_frame_policy: 'agent' });
  assert.equal(restored.h3_generation_plan.first_frame_policy, 'generate_new');
  assert.equal(restored.h3_generation_plan.last_frame_policy, 'generate_tail');
});
test('backend assembles deduplicated ordered images, first/last guides, voice and native size in a single H3 request', async t => {
  const { db, root, opts } = setup(t);
  voices.forShot.mock.mockImplementation(async () => ({ references: [{ key: 'character:5', kind: 'dialogue', url: 'data:audio/wav;base64,AAAA' }], lines: [{ key: 'character:5', kind: 'dialogue', text: '开始行动。' }] }));
  const configuration = { is_active: true, is_default: true, provider: 'minimax_h3', api_protocol: 'minimax_h3', model: ['MiniMax-H3'], default_model: 'MiniMax-H3', base_url: 'http://bridge.example', endpoint: '/v1/videos', settings: { h3_native_references: true } };
  t.mock.method(configs, 'listConfigs', () => [configuration]);
  let body;
  t.mock.method(global, 'fetch', async (_url, options) => { body = JSON.parse(options.body); return { ok: true, status: 200, text: async () => '{"id":"native-task"}' }; });

  // 1. 默认 FL2VA 纯血首帧模式测试：首帧/尾帧独占，零 reference_image 污染，零参考音频污染
  const flResult = await client.callVideoApi(db, log, { ...opts, model: 'MiniMax-H3', first_frame_url: 'http://host/static/first.png', last_frame_url: '/static/last.png', reference_urls: ['http://host/static/room.png', 'http://host/static/card.png', 'first.png', 'last.png'] });
  assert.equal(flResult.task_id, 'native-task');
  assert.deepEqual(body.h3_native, { width: 1344, height: 768, steps: 23 });
  const flImages = body.content.filter(i => i.type === 'image_url');
  assert.deepEqual(flImages.map(i => i.role), ['first_frame', 'last_frame']);
  const flAudios = body.content.filter(i => i.type === 'audio_url');
  assert.equal(flAudios.length, 0); // FL2VA 不向 DiT 塞音频以防桥接层被动降级为 ref2va
  assert.doesNotMatch(body.content[0].text, /<Picture|<Subject|<Audio/);

  // 2. Ref2VA 纯多参考模式：显式首尾帧输入也不会进入请求
  const refResult = await client.callVideoApi(db, log, { ...opts, h3_engine_mode: 'ref2va', model: 'MiniMax-H3', first_frame_url: 'http://host/static/first.png', last_frame_url: '/static/last.png', reference_urls: ['http://host/static/room.png', 'http://host/static/card.png', 'first.png', 'last.png'] });
  assert.equal(refResult.task_id, 'native-task');
  const refImages = body.content.filter(i => i.type === 'image_url');
  assert.equal(refImages.filter(i => i.role === 'first_frame').length, 0);
  assert.equal(refImages.filter(i => i.role === 'last_frame').length, 0);
  assert.equal(refImages.filter(i => i.role === 'reference_image').length, 4);
  assert.match(body.content[0].text, /<d>\[Chinese\] 开始行动。<\/d>/);
});
test('FL2VA rejects missing first frames and Ref2VA rejects oversized reference lists', async t => {
  const { db, opts } = setup(t);
  await assert.rejects(native.prepare(db, log, { ...opts, storyboard_id: 3 }), /缺少首帧/);
  native.saveSettings(db, 1, 2, { continuity: 'previous_tail' });
  await assert.rejects(native.prepare(db, log, opts), /上一镜尚无/);
  native.saveSettings(db, 1, 2, { continuity: 'off' });
  await assert.rejects(
    () => native.prepare(db, log, { ...opts, h3_engine_mode:'ref2va', reference_urls: Array.from({ length: 10 }, (_, i) => `https://example.com/${i}.png`) }),
    /最多支持 9 张参考图/
  );
});
test('direct Chinese compilation needs no text-model round trip and all canvas presets respect the native pixel limit', async t => {
  const { db, opts } = setup(t);
  const prepared = await native.prepare(db, log, { ...opts, first_frame_url:'first.png' });
  assert.equal(prepared.h3_mode, 'fl2va');
  assert.match(prepared.prompt, /房间中的男孩|少年开口|按已规划的分镜构图/);
  for (const ratio of ['16:9','9:16','1:1','4:3','3:4','21:9']) {
    const [w,h] = native.nativeCanvas(ratio);
    assert.ok(w % 32 === 0 && h % 32 === 0 && w*h <= 1344*768);
  }
});

test('unrelated project character edits do not invalidate an H3 shot being prepared', async t => {
  const { db, opts } = setup(t);
  db.prepare(`INSERT INTO characters(id,drama_id,name,local_path,extra_images,deleted_at)
    VALUES(6,1,'未出镜人物','profile.png','[]',NULL)`).run();
  voices.forShot.mock.mockImplementation(async () => {
    db.prepare('UPDATE characters SET extra_images=? WHERE id=6').run('["card.png"]');
    return { references: [], lines: [] };
  });
  const result = await native.prepare(db, log, { ...opts, first_frame_url:'first.png' });
  assert.equal(result.h3_mode, 'fl2va');
});

test('generation output bookkeeping does not invalidate immutable H3 inputs', async t => {
  const { db, opts } = setup(t);
  db.exec('ALTER TABLE storyboards ADD COLUMN selected_video_id INTEGER; ALTER TABLE storyboards ADD COLUMN video_url TEXT; ALTER TABLE storyboards ADD COLUMN status TEXT;');
  voices.forShot.mock.mockImplementation(async () => {
    db.prepare("UPDATE storyboards SET selected_video_id=99,video_url='new.mp4',status='processing' WHERE id=2").run();
    return { references: [], lines: [] };
  });
  const result = await native.prepare(db, log, { ...opts, first_frame_url:'first.png' });
  assert.equal(result.h3_mode, 'fl2va');
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

test('ID-only Agent-required character and scene references resolve to their project files', async t => {
  const { db, root, opts } = setup(t);
  db.prepare('UPDATE storyboards SET semantic_slots=? WHERE id=2').run(JSON.stringify({
    h3_mode: 'ref2va',
    h3_mode_reason: '角色与场景多参考一致性优先',
    first_frame_policy: 'none',
    first_frame_reason: '多参考已足够',
    last_frame_policy: 'none',
    last_frame_reason: '自然收束',
    required_references: [
      { type: 'character', id: 5, character_id: 5, name: '王奕宸' },
      { type: 'scene', id: 2, name: '房间' },
    ],
    speech_plan: {},
  }));
  const prepared = await native.prepare(db, log, {
    ...opts,
    h3_engine_mode: 'ref2va',
    first_frame_url: 'first.png',
  });
  assert.ok(prepared.reference_urls.some((url) => url.includes(fs.readFileSync(path.join(root, 'card.png')).toString('base64'))));
  assert.ok(prepared.reference_urls.some((url) => url.includes(fs.readFileSync(path.join(root, 'room.png')).toString('base64'))));
});
test('manual Ref2VA override expands the persisted shot entities into references and removes frame guides', async t => {
  const { db, root, opts } = setup(t);
  const settings = native.saveSettings(db, 1, 2, { engine_mode: 'ref2va' });
  assert.equal(settings.resolved_mode, 'ref2va');
  assert.equal(settings.opening_anchor, null);
  assert.equal(settings.h3_generation_plan.reference_source, 'manual_ref2va_shot_contract');
  assert.deepEqual(settings.references.map(ref => ref.kind), ['scene', 'character_sheet']);
  assert.ok(settings.references[0].url.includes('room.png'));
  assert.ok(settings.references[1].url.includes('card.png'));

  const prepared = await native.prepare(db, log, { ...opts, first_frame_url: 'first.png' });
  assert.equal(prepared.h3_mode, 'ref2va');
  assert.equal(prepared.first_frame_url, undefined);
  assert.equal(prepared.last_frame_url, undefined);
  assert.equal(prepared.reference_urls.length, 2);
  assert.ok(prepared.reference_urls.some(url => url.includes(fs.readFileSync(path.join(root, 'room.png')).toString('base64'))));
  assert.ok(prepared.reference_urls.some(url => url.includes(fs.readFileSync(path.join(root, 'card.png')).toString('base64'))));
});
test('manual Ref2VA override is rejected when the shot has no referenceable entities', t => {
  const { db } = setup(t);
  assert.throws(
    () => native.saveSettings(db, 2, 4, { engine_mode: 'ref2va' }),
    /禁止以空参考冒充 Ref2VA/
  );
});
test('shot edits while voice references are prepared abort before visual translation', async t => {
  const { db, opts } = setup(t);
  voices.forShot.mock.mockImplementation(async () => {
    db.exec("UPDATE storyboards SET characters='[]' WHERE id=2");
    return { references: [], lines: [] };
  });
  await assert.rejects(native.prepare(db, log, opts), /已变化/);
});
test('FL2VA continuity can inherit the prior video tail while Ref2VA ignores all frame guides', async t => {
  const { db, root, opts } = setup(t);
  const { promisify } = require('util');
  const run = promisify(require('child_process').execFile);
  const ffmpeg = require('../src/utils/ffmpegPath').getFfmpegPath();
  await run(ffmpeg, ['-v','error','-y','-f','lavfi','-i','testsrc2=s=128x96:r=24:d=1','-c:v','libx264','-pix_fmt','yuv420p',path.join(root,'previous.mp4')]);
  db.prepare('UPDATE storyboards SET local_path=? WHERE id=1').run('previous.mp4');
  // Default is 'off' (uses own first frame)
  assert.equal(native.getSettings(db, 1, 2).continuity, 'off');
  const defaultOff = await native.prepare(db, log, { ...opts, first_frame_url: 'first.png' });
  assert.equal(defaultOff.first_frame_url, 'data:image/png;base64,' + fs.readFileSync(path.join(root,'first.png')).toString('base64'));

  // When explicitly enabled to 'auto', uses previous video tail
  native.saveSettings(db, 1, 2, { continuity: 'auto' });
  const result = await native.prepare(db, log, { ...opts, first_frame_url: 'first.png' });
  assert.ok(result.first_frame_url.startsWith('data:image/png;base64,'));
  assert.equal(result.reference_urls.length, 0); // FL2VA 模式下纯首帧输入，无额外 reference_url

  // Ref2VA 只使用多参考素材，不继承上一镜尾帧，也不使用当前首帧。
  native.saveSettings(db, 1, 2, { continuity: 'off' });
  const refResult = await native.prepare(db, log, { ...opts, h3_engine_mode: 'ref2va', first_frame_url: 'first.png', reference_urls: ['card.png', 'profile.png', 'room.png'] });
  assert.equal(refResult.first_frame_url, undefined);
  assert.equal(refResult.last_frame_url, undefined);
  assert.equal(refResult.reference_urls.length, 3); // card、profile、room
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
  assert.match(prepared.prompt,/银色训练服，黑色靴子/);
  native.saveSettings(db,1,2,{continuity:'previous_tail'});
  await assert.rejects(native.prepare(db,log,opts),/换装或时间线变化/);
});

test('changing narrative settings while reference audio is prepared aborts stale H3 submission',async t=>{
  const {db,opts}=setup(t);
  voices.forShot.mock.mockImplementation(async()=>{
    const metadata=JSON.parse(db.prepare('SELECT metadata FROM dramas WHERE id=1').get().metadata);
    metadata.narrative_style={preset:'narration',speech_rate:1.5};
    db.prepare('UPDATE dramas SET metadata=? WHERE id=1').run(JSON.stringify(metadata));
    return {references:[],lines:[]};
  });
  await assert.rejects(native.prepare(db,log,opts),/叙事设置已变化/);
});

test('H3 rejects when total reference images exceed 9 without silent slicing', async t => {
  const { db, root, opts } = setup(t);
  const extraUrls = [];
  for (let i = 1; i <= 10; i++) {
    const file = `extra_${i}.png`;
    fs.writeFileSync(path.join(root, file), 'image ' + i);
    extraUrls.push(file);
  }
  await assert.rejects(
    () => native.prepare(db, log, {
      ...opts,
      h3_engine_mode: 'ref2va',
      reference_urls: extraUrls,
    }),
    /最多支持 9 张参考图/
  );
});
