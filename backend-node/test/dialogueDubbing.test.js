const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const service = require('../src/services/dialogueDubbingService');
const tasks = require('../src/services/taskService');
const tts = require('../src/services/ttsService');
const log = { info() {}, warn() {}, error() {} };

function setup(t) {
  const db = new Database(':memory:');
  db.exec([
    'CREATE TABLE dramas (id INTEGER PRIMARY KEY, metadata TEXT, updated_at TEXT, deleted_at TEXT)',
    'CREATE TABLE episodes (id INTEGER PRIMARY KEY, drama_id INTEGER, episode_number INTEGER, deleted_at TEXT)',
    'CREATE TABLE characters (id INTEGER PRIMARY KEY, drama_id INTEGER, name TEXT, description TEXT, appearance TEXT, voice_style TEXT, sort_order INTEGER, deleted_at TEXT)',
    'CREATE TABLE storyboards (id INTEGER PRIMARY KEY, episode_id INTEGER, storyboard_number INTEGER, dialogue TEXT, narration TEXT, audio_local_path TEXT, narration_audio_local_path TEXT, duration REAL, updated_at TEXT, deleted_at TEXT)',
    'CREATE TABLE async_tasks (id TEXT PRIMARY KEY, type TEXT, status TEXT, progress INTEGER, message TEXT, error TEXT, result TEXT, resource_id TEXT, created_at TEXT, updated_at TEXT, completed_at TEXT, deleted_at TEXT)',
    'CREATE TABLE ai_service_configs (id INTEGER PRIMARY KEY, service_type TEXT, provider TEXT, name TEXT, model TEXT, default_model TEXT, base_url TEXT, api_key TEXT, settings TEXT, priority INTEGER, is_default INTEGER, is_active INTEGER, created_at TEXT, deleted_at TEXT)',
  ].join(';'));
  db.exec("INSERT INTO dramas VALUES (1, '{\"aspect_ratio\":\"16:9\"}', '', NULL), (2, '{}', '', NULL)");
  db.exec('INSERT INTO episodes VALUES (11,1,1,NULL),(12,1,2,NULL),(21,2,1,NULL)');
  db.prepare('INSERT INTO characters VALUES (1,1,?,?,?,?,0,NULL)').run('小明', '十岁男孩', '', '');
  db.prepare('INSERT INTO characters VALUES (2,1,?,?,?,?,1,NULL)').run('教官', '成年男子', '', '');
  db.prepare("INSERT INTO ai_service_configs VALUES (4,'tts','edge-tts','Edge', '[]', '', '', 'secret-value', '{}',0,1,1,'',NULL)").run();
  const insert = db.prepare('INSERT INTO storyboards VALUES (?,?,?,?,?,?,?,5,?,NULL)');
  insert.run(1,11,1,'小明：“你好。”','太阳升起。','audio/old.mp3','audio/old-narr.mp3','');
  insert.run(2,12,1,'教官：“继续。”','无',null,null,'');
  insert.run(3,21,1,'其他人：“别改我。”',null,'foreign.mp3',null,'');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dubbing-test-'));
  fs.mkdirSync(path.join(root, 'audio'));
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { db, root };
}
function task(db) { return tasks.createTask(db, log, 'dialogue_dubbing', 'dubbing:1'); }
function items(db) {
  return db.prepare('SELECT s.*, e.episode_number FROM storyboards s JOIN episodes e ON e.id=s.episode_id WHERE e.drama_id=1 ORDER BY s.id').all();
}
function mockSpeech(t, root, calls, fn) {
  t.mock.method(tts, 'synthesize', async (db, logger, opts) => {
    calls.push(opts);
    if (fn) return fn(db, opts, calls.length);
    const rel = 'audio/new-' + calls.length + '.mp3';
    fs.writeFileSync(path.join(root, rel), 'test');
    return { local_path: rel };
  });
}

test('actual TTS requests follow per-shot automatic pace for dialogue and narration', async t => {
  const { db, root } = setup(t);
  db.prepare('UPDATE dramas SET metadata=? WHERE id=1').run(JSON.stringify({
    narrative_style: { preset: 'dialogue_fast', speech_mode: 'auto', speech_rate: 1.25 },
  }));
  db.prepare('UPDATE storyboards SET dialogue=?,narration=? WHERE id=1').run('小明："你好。"', '他笑了。');
  db.prepare('UPDATE storyboards SET dialogue=? WHERE id=2').run('教官："' + '好'.repeat(18) + '。"');
  const calls = [];
  mockSpeech(t, root, calls);
  await service.single(db, log, 1, root, 'dialogue');
  await service.single(db, log, 1, root, 'narration');
  await service.single(db, log, 2, root, 'dialogue');
  assert.deepEqual(calls.map(c => c.speed), [1.2, 1.2, 1.3]);
  assert.deepEqual(calls.map(c => c.text), ['你好。', '他笑了。', '好'.repeat(18) + '。']);
});

test('speaker labels and delivery notes are not read; speaker changes retain all words', () => {
  assert.deepEqual(service.dialogueSegments('小明（低声）：“你好：朋友。” 教官：“继续！”'), [
    { speaker: '小明', text: '你好：朋友。' }, { speaker: '教官', text: '继续！' },
  ]);
  assert.deepEqual(service.dialogueSegments('王奕宸："我玩三角洲可熟了！'), [{ speaker: '王奕宸', text: '我玩三角洲可熟了！' }]);
  assert.deepEqual(service.dialogueSegments('无对白'), []);
  assert.deepEqual(service.dialogueSegments('未标注人物的台词。'), [{ speaker: '', text: '未标注人物的台词。' }]);
});

test('Edge voices are automatically allocated, narration is distinct, and settings survive reload', t => {
  const { db } = setup(t);
  const panel = service.panel(db, 1);
  assert.equal(panel.profile.voices['小明'], 'zh-CN-YunxiaNeural');
  assert.notEqual(panel.profile.voices['小明'], panel.profile.voices['教官']);
  assert.ok(Object.values(panel.profile.voices).every(v => v !== panel.profile.narrator_voice));
  assert.equal(JSON.stringify(panel).includes('secret-value'), false);
  panel.profile.voices['小明'] = 'zh-CN-XiaoyiNeural';
  service.saveProfile(db, 1, panel.profile);
  assert.equal(service.panel(db, 1).profile.voices['小明'], 'zh-CN-XiaoyiNeural');
  assert.equal(JSON.parse(db.prepare('SELECT metadata FROM dramas WHERE id=1').get().metadata).aspect_ratio, '16:9');
  assert.throws(() => service.saveProfile(db, 1, { ...panel.profile, narrator_voice: 'zh-CN-XiaoyiNeural' }), /不能与人物/);
});

test('whole-project batch uses fixed per-person voices and isolates other projects', async t => {
  const { db, root } = setup(t);
  const calls = [];
  mockSpeech(t, root, calls);
  const p = service.panel(db, 1).profile;
  const job = task(db);
  await service.runBatch(db, log, job.id, items(db), root, p, service.configFor(db, 4), true);
  assert.deepEqual(calls.map(c => c.text), ['你好。', '继续。']);
  assert.deepEqual(calls.map(c => c.voice_id), [p.voices['小明'], p.voices['教官']]);
  assert.equal(db.prepare('SELECT audio_local_path FROM storyboards WHERE id=3').get().audio_local_path, 'foreign.mp3');
  assert.equal(JSON.parse(tasks.getTask(db, job.id).result).succeeded, 2);
  assert.equal(db.prepare('SELECT narration_audio_local_path FROM storyboards WHERE id=1').get().narration_audio_local_path, 'audio/old-narr.mp3');
});

test('narration updates a separate path and uses a separate voice', async t => {
  const { db, root } = setup(t);
  const calls = [];
  mockSpeech(t, root, calls);
  const p = service.panel(db, 1).profile;
  await service.single(db, log, 1, root, 'narration');
  assert.equal(calls[0].text, '太阳升起。');
  assert.equal(calls[0].voice_id, p.narrator_voice);
  const row = db.prepare('SELECT * FROM storyboards WHERE id=1').get();
  assert.equal(row.audio_local_path, 'audio/old.mp3');
  assert.equal(row.narration_audio_local_path, 'audio/new-1.mp3');
});

test('failed replacement preserves previous audio and does not stop the next shot', async t => {
  const { db, root } = setup(t);
  const calls = [];
  mockSpeech(t, root, calls, async (_, opts, n) => {
    if (n === 1) throw new Error('provider unavailable');
    return { local_path: 'audio/recovered.mp3' };
  });
  const job = task(db);
  await service.runBatch(db, log, job.id, items(db), root, service.panel(db, 1).profile, service.configFor(db, 4), true);
  const result = JSON.parse(tasks.getTask(db, job.id).result);
  assert.equal(result.failed, 1);
  assert.equal(result.results[0].tts_kind, 'dialogue');
  assert.equal(db.prepare('SELECT audio_local_path FROM storyboards WHERE id=1').get().audio_local_path, 'audio/old.mp3');
  assert.equal(db.prepare('SELECT audio_local_path FROM storyboards WHERE id=2').get().audio_local_path, 'audio/recovered.mp3');
});

test('cancellation during synthesis prevents replacement and further provider calls', async t => {
  const { db, root } = setup(t);
  const calls = [];
  const job = task(db);
  mockSpeech(t, root, calls, async () => {
    tasks.cancelTask(db, log, job.id);
    return { local_path: 'audio/do-not-save.mp3' };
  });
  await service.runBatch(db, log, job.id, items(db), root, service.panel(db, 1).profile, service.configFor(db, 4), true);
  assert.equal(calls.length, 1);
  assert.equal(db.prepare('SELECT audio_local_path FROM storyboards WHERE id=1').get().audio_local_path, 'audio/old.mp3');
  assert.equal(tasks.getTask(db, job.id).status, 'failed');
});

test('changed dialogue during synthesis cannot receive audio for the old text', async t => {
  const { db, root } = setup(t);
  const calls = [];
  mockSpeech(t, root, calls, async db => {
    db.prepare('UPDATE storyboards SET dialogue=? WHERE id=1').run('已经修改');
    return { local_path: 'audio/stale.mp3' };
  });
  await assert.rejects(service.single(db, log, 1, root), /文案已变更/);
  assert.equal(db.prepare('SELECT audio_local_path FROM storyboards WHERE id=1').get().audio_local_path, 'audio/old.mp3');
});

test('missing-only mode skips existing files and rebuilds dangling paths', async t => {
  const { db, root } = setup(t);
  const calls = [];
  fs.writeFileSync(path.join(root, 'audio/old.mp3'), 'old');
  mockSpeech(t, root, calls);
  const job = task(db);
  await service.runBatch(db, log, job.id, items(db), root, service.panel(db, 1).profile, service.configFor(db, 4), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, '继续。');
  assert.equal(JSON.parse(tasks.getTask(db, job.id).result).results[0].skipped, true);
});

test('batch scope rejects foreign episodes and foreign retry items before creating a job', t => {
  const { db, root } = setup(t);
  assert.throws(() => service.startBatch(db, log, 1, { episode_id: 21 }, root), /不属于当前项目/);
  assert.throws(() => service.startBatch(db, log, 1, { storyboard_ids: [3] }, root), /不属于所选范围/);
  assert.throws(() => service.startBatch(db, log, 1, { tts_kind: 'both', retry_items: [{ storyboard_id: 3, tts_kind: 'narration' }] }, root), /不属于所选范围/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM async_tasks').get().n, 0);
});

test('both-channel retry regenerates only the requested failed channel', async t => {
  const { db, root } = setup(t);
  const calls = [];
  mockSpeech(t, root, calls);
  const job = service.startBatch(db, log, 1, { tts_kind: 'both', retry_items: [{ storyboard_id: 1, tts_kind: 'narration' }] }, root);
  assert.throws(() => service.startBatch(db, log, 1, {}, root), /已有批量配音/);
  for (let n = 0; n < 100 && tasks.getTask(db, job.id).status !== 'completed'; n++) await new Promise(r => setTimeout(r, 5));
  assert.equal(tasks.getTask(db, job.id).status, 'completed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, '太阳升起。');
});

test('multiple speakers are concatenated into playable audio in dialogue order', async t => {
  const { db, root } = setup(t);
  const tone = path.join(root, 'tone.mp3');
  assert.equal(spawnSync('ffmpeg', ['-v','error','-f','lavfi','-i','sine=frequency=440:duration=0.25','-y',tone]).status, 0);
  const calls = [];
  mockSpeech(t, root, calls, async (_, opts, n) => {
    const rel = 'audio/tone-' + n + '.mp3';
    fs.copyFileSync(tone, path.join(root, rel));
    return { local_path: rel };
  });
  const p = service.panel(db, 1).profile;
  const result = await service.synthesizeShot(db, log, { id:1, dialogue:'小明：“先说。”\n教官：“后说。”' }, root, p, service.configFor(db, 4));
  assert.deepEqual(calls.map(c => c.text), ['先说。','后说。']);
  const probe = spawnSync('ffprobe', ['-v','error','-show_entries','format=duration','-of','csv=p=0',path.join(root,result.local_path)], { encoding:'utf8' });
  assert.equal(probe.status, 0);
  assert.ok(Number(probe.stdout) >= 0.49);
});

test('inline narrator is routed separately and speaker names never reach the synthesizer', async t => {
  const { db, root } = setup(t);
  db.prepare('UPDATE storyboards SET dialogue=?, narration=? WHERE id=1').run('小明：“你好。”教官：“我很好。”旁白：“他们都很友好。”', '');
  const calls = [];
  const tone = path.join(root, 'tone.mp3');
  spawnSync('ffmpeg', ['-v','error','-f','lavfi','-i','sine=duration=0.25','-y',tone]);
  mockSpeech(t, root, calls, async (_, opts, n) => {
    const rel = 'audio/voice-' + n + '.mp3';
    fs.copyFileSync(tone, path.join(root,rel));
    return { local_path: rel };
  });
  await service.single(db, log, 1, root, 'dialogue');
  await service.single(db, log, 1, root, 'narration');
  assert.deepEqual(calls.map(c => c.text), ['你好。','我很好。','他们都很友好。']);
  assert.equal(new Set(calls.map(c => c.voice_id)).size, 3);
  const extraction = require('../src/services/speechExtractionService');
  const row = db.prepare('SELECT * FROM storyboards WHERE id=1').get();
  const ordered = extraction.orderedAudioFiles(db, 1, row);
  assert.deepEqual(ordered, ['audio/voice-1.mp3','audio/voice-2.mp3','audio/voice-3.mp3']);
  assert.equal(service.planForId(db,1).segments[2].kind, 'narration');
  const video = path.join(root, 'input.mp4');
  assert.equal(spawnSync('ffmpeg', ['-v','error','-f','lavfi','-i','color=blue:size=160x96:duration=2','-c:v','libx264','-y',video]).status,0);
  const post = require('../src/services/mergedEpisodePostProcess');
  const output = await post.runMergedEpisodePostProcess(db, log, {
    mergedAbsPath:video, storageRoot:root, scenes:[{scene_id:1,duration:2}], episodeId:11,
    mergeOpts:{burn_dialogue_audio:true,burn_narration_subtitles:true},
  });
  assert.equal(output.ok,true,output.error);
  assert.ok(fs.existsSync(path.join(root,output.relativePath)));
  assert.match(fs.readFileSync(path.join(root,'input_narration.srt'),'utf8'), /他们都很友好/);
});

test('ambiguous prose is extracted by the model, cached, and invalidated when the shot changes', async t => {
  const { db } = setup(t);
  const extraction = require('../src/services/speechExtractionService');
  const ai = require('../src/services/aiClient');
  db.prepare('UPDATE storyboards SET dialogue=?, narration=? WHERE id=1').run('小明说：“你好。”教官回答：“我很好。”旁白：“他们都很友好。”','');
  let calls = 0;
  t.mock.method(ai, 'generateText', async () => {
    calls++;
    return JSON.stringify({segments:[
      {kind:'dialogue',speaker:'小明',text:'你好。'},
      {kind:'dialogue',speaker:'教官',text:'我很好。'},
      {kind:'narration',speaker:'',text:'他们都很友好。'},
    ]});
  });
  let shot = db.prepare('SELECT * FROM storyboards WHERE id=1').get();
  const plan = await extraction.ensurePlan(db,log,1,shot,service.dialogueSegments,true);
  assert.equal(plan.method,'model');
  assert.equal(plan.segments[0].text,'你好。');
  await extraction.ensurePlan(db,log,1,shot,service.dialogueSegments);
  assert.equal(calls,1);
  db.prepare('UPDATE storyboards SET dialogue=? WHERE id=1').run('小明：“修改后的台词。”');
  shot = db.prepare('SELECT * FROM storyboards WHERE id=1').get();
  assert.equal(extraction.automaticPlan(db,1,shot,service.dialogueSegments).method,'labels');
});

test('model-invented dialogue is rejected without saving an extraction', async t => {
  const { db } = setup(t);
  const extraction = require('../src/services/speechExtractionService');
  t.mock.method(require('../src/services/aiClient'), 'generateText', async () => JSON.stringify({segments:[{kind:'dialogue',speaker:'小明',text:'完全不存在的新台词'}]}));
  const shot = db.prepare('SELECT * FROM storyboards WHERE id=1').get();
  await assert.rejects(extraction.ensurePlan(db,log,1,shot,service.dialogueSegments,true), /与分镜原文不符/);
  assert.equal(JSON.parse(db.prepare('SELECT metadata FROM dramas WHERE id=1').get().metadata).tts_speech_plans,undefined);
});

test('unquoted same-line speaker labels require AI rather than reading the remaining labels aloud', t => {
  const { db } = setup(t);
  const extraction = require('../src/services/speechExtractionService');
  const shot = {id:1,dialogue:'小明：你好 教官：我很好 旁白：他们都很友好'};
  const plan = extraction.automaticPlan(db,1,shot,service.dialogueSegments);
  assert.equal(extraction.needsModel(shot,plan),true);
});

test('speaker labels bind to real character IDs and aliases can explicitly select the same character', async t => {
  const { db, root } = setup(t);
  let panel = service.panel(db,1);
  assert.equal(panel.shots[0].segments[0].character_id,1);
  assert.equal(panel.shots[0].segments[0].character_name,'小明');
  assert.equal(panel.profile.speaker_characters['小明'],1);
  db.prepare('UPDATE storyboards SET dialogue=? WHERE id=1').run('小名：“你好。”');
  panel = service.panel(db,1);
  panel.profile.speaker_characters['小名']=1;
  panel.profile.voices['小明']='zh-CN-XiaoyiNeural';
  service.saveProfile(db,1,panel.profile);
  const calls=[];
  mockSpeech(t,root,calls);
  await service.single(db,log,1,root);
  assert.equal(calls[0].text,'你好。');
  assert.equal(calls[0].voice_id,'zh-CN-XiaoyiNeural');
  assert.equal(service.panel(db,1).shots[0].segments[0].character_id,1);
  assert.throws(()=>service.saveProfile(db,1,{...panel.profile,speaker_characters:{'小名':999}}),/不属于当前项目/);
});

test('renaming a character preserves its ID-bound voice', t => {
  const { db }=setup(t);
  const profile=service.panel(db,1).profile;
  profile.voices['小明']='zh-CN-XiaoyiNeural';
  service.saveProfile(db,1,profile);
  db.prepare('UPDATE characters SET name=? WHERE id=1').run('明明');
  db.prepare('UPDATE storyboards SET dialogue=? WHERE id=1').run('明明：“你好。”');
  const panel=service.panel(db,1);
  assert.equal(panel.profile.voices['明明'],'zh-CN-XiaoyiNeural');
  assert.equal(panel.shots[0].segments[0].character_id,1);
});

test('editable speech plans persist order and TTS reads edited words with the selected character voice', async t => {
  const { db, root } = setup(t);
  const before = service.speechEditor(db, 1, 1);
  const saved = service.saveSpeech(db, 1, 1, { source_hash: before.source_hash, segments: [
    { kind: 'dialogue', speaker: '小明', text: '你好。' },
    { kind: 'narration', speaker: 'ignored', text: '他们都很友好。' },
    { kind: 'dialogue', speaker: '教官', text: '我很好。' },
  ] });
  assert.equal(saved.segments[1].speaker, '');
  assert.equal(saved.narration, '他们都很友好。');
  assert.match(saved.dialogue, /小明/);
  assert.equal(service.planForId(db, 1).method, 'edited');
  const extraction = require('../src/services/speechExtractionService');
  const ai = require('../src/services/aiClient');
  t.mock.method(ai, 'generateText', () => assert.fail('Manual text must not be re-extracted'));
  const shot = db.prepare('SELECT * FROM storyboards WHERE id=1').get();
  assert.deepEqual((await extraction.ensurePlan(db, log, 1, shot, service.dialogueSegments)).segments, saved.segments);
  assert.throws(() => service.saveSpeech(db, 1, 1, { source_hash: before.source_hash, segments: [] }), /其他页面修改/);
  assert.throws(() => service.speechEditor(db, 1, 3), /不属于/);
  assert.equal(shot.audio_local_path, 'audio/old.mp3');
  const calls = [];
  // Real ffmpeg inputs for multi-speaker concatenation.
  t.mock.method(tts, 'synthesize', async (_, logger, options) => {
    calls.push(options);
    const rel = 'audio/edit-' + calls.length + '.mp3';
    const result = spawnSync('ffmpeg', ['-y','-f','lavfi','-i','sine=frequency=440:duration=0.15',path.join(root, rel)], { encoding:'utf8' });
    assert.equal(result.status, 0);
    return { local_path: rel };
  });
  await service.single(db, log, 1, root, 'dialogue');
  assert.deepEqual(calls.map(c => c.text), ['你好。', '我很好。']);
  assert.notEqual(calls[0].voice_id, calls[1].voice_id);
});

test('batch speech extraction is episode scoped, preserves edited plans and old audio, and can recover its task', async t => {
  const { db } = setup(t);
  const before = service.speechEditor(db, 1, 1);
  service.saveSpeech(db, 1, 1, { source_hash: before.source_hash, segments: [{ kind:'dialogue', speaker:'小明', text:'手工确认。' }] });
  const other = db.prepare('SELECT dialogue FROM storyboards WHERE id=2').get().dialogue;
  const job = service.startSpeechBatch(db, log, 1, { episode_id:11 });
  assert.throws(() => service.startSpeechBatch(db, log, 1, { episode_id:11 }), /正在批量生成/);
  for (let i=0;i<30 && ['pending','processing'].includes(tasks.getTask(db,job.id).status);i++) await new Promise(resolve => setTimeout(resolve,10));
  const finished = service.latestSpeechTask(db,1);
  assert.equal(finished.id, job.id);
  assert.equal(finished.status, 'completed');
  assert.equal(JSON.parse(finished.result).succeeded, 1);
  assert.equal(service.planForId(db,1).segments[0].text, '手工确认。');
  assert.equal(db.prepare('SELECT dialogue FROM storyboards WHERE id=2').get().dialogue, other);
  assert.equal(db.prepare('SELECT audio_local_path FROM storyboards WHERE id=1').get().audio_local_path, 'audio/old.mp3');
});

test('cancelled speech batch does not replace source text', async t => {
  const { db } = setup(t);
  const original = db.prepare('SELECT dialogue FROM storyboards WHERE id=1').get().dialogue;
  const job = service.startSpeechBatch(db, log, 1, { episode_id:11 });
  tasks.cancelTask(db, log, job.id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(db.prepare('SELECT dialogue FROM storyboards WHERE id=1').get().dialogue, original);
});

test('automatic model routing reads saved shot text and manual overrides survive reloading', t => {
  const { db } = setup(t);
  db.exec('ALTER TABLE storyboards ADD COLUMN video_model TEXT');
  const insert=db.prepare("INSERT INTO ai_service_configs (id,service_type,provider,name,model,default_model,base_url,settings,is_default,is_active) VALUES (?,'video',?,?,?,?,?,'{}',?,1)");
  insert.run(5,'minimax_h3','H3','["minimax_h3"]','minimax_h3','http://127.0.0.1:5689',0);
  insert.run(7,'comfyui_wan22','Wan','["Wan2.2"]','Wan2.2','http://127.0.0.1:5688',1);
  const models=require('../src/services/storyboardVideoModelService');
  const shotService=require('../src/services/storyboardService');
  assert.equal(models.resolveStoryboardModel(db,{drama_id:1,storyboard_id:1}).model,'minimax_h3');
  db.prepare('UPDATE storyboards SET dialogue=?,narration=? WHERE id=1').run('无对白','无旁白');
  assert.equal(models.resolveStoryboardModel(db,{drama_id:1,storyboard_id:1}).model,'minimax_h3');
  shotService.updateStoryboard(db,log,1,{video_model:'Wan2.2'});
  assert.equal(shotService.getStoryboardById(db,1).video_model,'Wan2.2');
  assert.equal(models.resolveStoryboardModel(db,{drama_id:1,storyboard_id:1}).model,'Wan2.2');
  shotService.updateStoryboard(db,log,1,{video_model:null});
  assert.equal(models.resolveStoryboardModel(db,{drama_id:1,storyboard_id:1}).model,'minimax_h3');
  assert.throws(()=>models.resolveStoryboardModel(db,{drama_id:2,storyboard_id:1}),/不属于/);
  assert.throws(()=>models.resolveStoryboardModel(db,{drama_id:1,storyboard_id:1,model:'deleted-model'}),/未启用/);
});

test('indextts profile normalizes voices and avoids collisions', t => {
  const { db } = setup(t);
  db.prepare("INSERT INTO ai_service_configs VALUES (10,'tts','indextts','IndexTTS', '[]', '', 'http://127.0.0.1:7860', 'local', '{\"voice_id\":\"voice_03.wav\"}',0,0,1,'',NULL)").run();
  const profile = service.normalizedProfile(db, 1, { config_id: 10 });
  assert.equal(profile.config_id, 10);
  assert.equal(profile.default_voice, 'voice_03.wav');
  assert.equal(profile.narrator_voice, 'voice_08.wav');
  assert.ok(profile.voices['小明']);
  assert.ok(profile.voices['教官']);
  assert.notEqual(profile.voices['小明'], profile.narrator_voice);
});
