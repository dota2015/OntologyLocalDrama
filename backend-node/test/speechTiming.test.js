const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const timing = require('../src/utils/speechTiming');
const { enforceStoryboardSpeechTiming, preservesSpeech } = require('../src/services/storyboardSpeechService');
const { validateVideoSpeech } = require('../src/services/videoSpeechService');
const videoClient = require('../src/services/videoClient');
const videoService = require('../src/services/videoService');
const routes = require('../src/routes/videos');
const taskService = require('../src/services/taskService');
const aiClient = require('../src/services/aiClient');
const episodeService = require('../src/services/episodeStoryboardService');
const log = { info() {}, warn() {}, error() {} };
const dialogue = '赵总：“各位，董事会已经下了死命令！这季度必须把大模型自然语言问数系统给我推上线！”';
const source = { shot_number: 2, dialogue, duration: 5, action: '赵总拍桌，镜头推进', scene_id: 3, characters: [{ id: 2, name: '赵总' }], universal_segment_text: '原完整提示词' };
const pieces = [
  { dialogue: '赵总：“各位，董事会已经下了死命令！”', action: '赵总拍桌' },
  { dialogue: '赵总：“这季度必须把大模型”', action: '镜头推进' },
  { dialogue: '赵总：“自然语言问数系统给我推上线！”', action: '赵总收尾' },
];
const h3 = { api_protocol: 'minimax_h3', model: ['MiniMax-H3'], default_model: 'MiniMax-H3' };

test('director drafts and saved video submissions share the natural speech budget', t => {
  const { checkSpeechTiming } = require('../src/ontology/invariants');
  const db = videoDb(t);
  const line = '露娜：\"' + '字'.repeat(34) + '\"';
  db.prepare('UPDATE storyboards SET dialogue=?, duration=6 WHERE id=1').run(line);
  const draft = { shot_number: 2, duration: 6, dialogue: line };
  const violation = checkSpeechTiming([draft])[0];
  assert.equal(violation.rule, 'INVARIANT_SPEECH_OVER_BUDGET');
  assert.deepEqual(violation.assessment, validateVideoSpeech(db, { storyboard_id: 1 }, h3).assessment);
  assert.equal(violation.assessment.requiredSeconds, 6.8);
  assert.equal(checkSpeechTiming([{ ...draft, duration: 8 }]).length, 0);
  assert.equal(checkSpeechTiming([draft], { deliveryOptions: { speechRate: 1.44 } }).length, 0);
});

test('director budgets structured-only speech and ignores compiled prompt turns', () => {
  const { checkSpeechTiming } = require('../src/ontology/invariants');
  const shot = { duration: 6, semantic_slots: { speech_plan: { text: '字'.repeat(32) } } };
  assert.equal(checkSpeechTiming([shot])[0].assessment.requiredSeconds, 6.4);
  assert.equal(checkSpeechTiming({}) .length, 0);
  const delivery = require('../src/services/speechDeliveryService');
  const base = { duration: 5, dialogue: '甲：“你好。”' };
  assert.deepEqual(delivery.resolve({}, base), delivery.resolve({}, { ...base,
    universal_segment_text: '甲：“旧台词。”\n乙：“旧台词。”\n旁白：“旧台词。”' }));
});

test('real 34-character dialogue exceeds five seconds; short dialogue fits', () => {
  const result = timing.assessSpeechTiming(source);
  assert.equal(result.han, 34);
  assert.equal(result.ok, false);
  assert.equal(result.requiredSeconds, 6.8);
  assert.equal(result.hanBudget, 25);
  assert.equal(timing.assessSpeechTiming({ dialogue: '赵总：“各位，马上开始！”', duration: 5 }).ok, true);
  assert.equal(timing.assessSpeechTiming({ dialogue: '无对白', narration: 'none', duration: 5 }).requiredSeconds, 0);
});

test('dialogue and narration share a budget; mixed language, speakers and parentheses count', () => {
  assert.equal(timing.assessSpeechTiming({ dialogue: '甲：“现在出发。”\n乙：“马上回来。”' }, 5).han, 8);
  assert.equal(timing.assessSpeechTiming({ dialogue: 'Hello world', narration: '现在出发' }, 5).speechSeconds, 1.44);
  assert.equal(timing.assessSpeechTiming({ dialogue: '甲：' + '字'.repeat(12), narration: '字'.repeat(8) }, 5).ok, true);
  assert.equal(timing.assessSpeechTiming({ dialogue: '甲：这是（非常重要）的任务' }, 5).han, 9);
});

test('compiled and manually edited prompts never participate in speech timing', () => {
  const classic = `动作：赵总拍桌。对话：${dialogue}。结果：大家沉默。解说旁白：会议开始。时长：5秒`;
  assert.equal(timing.assessVideoSpeech(source, classic, 5).han, 34);
  assert.equal(timing.assessVideoSpeech(source, `对话：${dialogue}`, 5).han, 34);
  assert.equal(timing.assessVideoSpeech({}, `主体：@人物1走近。 台词：第1秒 @人物1："${dialogue}" 音效：环境声`, 5).ok, true);
  assert.equal(timing.assessVideoSpeech({}, `赵总：“${'字'.repeat(20)}”`, 5).han, 0);
  assert.equal(timing.assessVideoSpeech({}, `赵总说：“${'字'.repeat(20)}”`, 5).han, 0);
  assert.equal(timing.assessVideoSpeech({}, '标题：“' + '字'.repeat(40) + '”', 5).ok, true);
});

test('structured H3 speech uses authoritative slots and ignores compiled lip-sync prose', () => {
  const shot = {
    duration: 4,
    dialogue: '押差: "自生自灭。"',
    semantic_slots: JSON.stringify({
      speech_plan: { text: '自生自灭。', is_narration: false },
    }),
    video_slots: JSON.stringify({
      audio_lip_sync: {
        mode: 'in_frame_dialogue',
        dialogue_content: '自生自灭。',
      },
    }),
  };
  const prompt = '对话：押差: "自生自灭。"（押差自然发音并同步口型，画面其余人物双唇自然闭合并保持倾听）';
  const result = timing.assessVideoSpeech(shot, prompt, 4, { speechRate: 1.1 });
  assert.equal(result.ok, true);
  assert.equal(result.han, 4);
  assert.equal(result.requiredSeconds, 1);
});

test('object-form slots are authoritative and narration is not double-counted', () => {
  const shot = {
    dialogue: '',
    narration: '夜幕降临。',
    semantic_slots: { speech_plan: { text: '夜幕降临。', is_narration: true } },
    video_slots: { audio_lip_sync: { mode: 'narration', dialogue_content: '夜幕降临。' } },
  };
  const resolved = timing.authoritativeSpeech(shot);
  assert.equal(resolved.dialogue, '');
  assert.equal(resolved.narration, '夜幕降临。');
  const result = timing.assessVideoSpeech(shot, '对话：这段展示文字绝不能参与计算。', 4);
  assert.equal(result.han, 4);
  assert.equal(result.requiredSeconds, 0.8);
});

test('repair splits without losing dialogue, renumbers shots and rebuilds prompts', async () => {
  const result = await enforceStoryboardSpeechTiming([source, { dialogue: '无', duration: 5 }], {
    targetDuration: 5,
    generate: async () => JSON.stringify(pieces),
  });
  assert.equal(result.length, 4);
  assert.equal(preservesSpeech(source, result.slice(0, 3)), true);
  assert.deepEqual(result.map(s => s.shot_number), [1, 2, 3, 4]);
  for (const shot of result.slice(0, 3)) {
    assert.equal(shot.duration, 5);
    assert.deepEqual(shot.characters, source.characters);
    assert.equal(shot.scene_id, 3);
    assert.equal(shot.universal_segment_text, undefined);
    assert.equal(timing.assessSpeechTiming(shot).ok, true);
  }
});

for (const [name, repair] of [
  ['lost words', [{ dialogue: '赵总：给我推上线！' }]],
  ['still overflowing despite duration inflation', [{ dialogue, duration: 120 }]],
  ['changed speaker', pieces.map(p => ({ dialogue: p.dialogue.replace('赵总', '李总') }))],
  ['duplicate words', [...pieces, pieces[2]]],
]) {
  test(`rejects ${name} after bounded repair attempts`, async () => {
    let calls = 0;
    await assert.rejects(enforceStoryboardSpeechTiming([source], {
      targetDuration: 5, generate: async () => { calls++; return JSON.stringify(repair); },
    }), /拆镜校验失败/);
    assert.equal(calls, 2);
  });
}

test('narration is preserved and empty fragments do not inherit the whole source dialogue', async () => {
  const shot = { dialogue: '甲：字'.replace('字', '字'.repeat(25)), narration: '夜幕降临', duration: 5 };
  const result = await enforceStoryboardSpeechTiming([shot], {
    targetDuration: 5,
    generate: async () => JSON.stringify([{ dialogue: shot.dialogue }, { narration: shot.narration }]),
  });
  assert.equal(result[1].dialogue, '');
  assert.equal(result[0].narration, '');
  assert.equal(preservesSpeech(shot, result), true);
});

function videoDb(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE storyboards (id INTEGER PRIMARY KEY, storyboard_number INTEGER, duration REAL, dialogue TEXT, narration TEXT, creation_mode TEXT, universal_segment_text TEXT, deleted_at TEXT);
    CREATE TABLE video_generations (id INTEGER PRIMARY KEY, storyboard_id INTEGER, duration REAL, model TEXT, prompt TEXT, status TEXT, error_msg TEXT, updated_at TEXT, deleted_at TEXT);
    INSERT INTO storyboards (id, storyboard_number, duration, dialogue) VALUES (1, 2, 5, '');`);
  db.prepare('UPDATE storyboards SET dialogue = ? WHERE id = 1').run(dialogue);
  db.exec("CREATE TABLE dramas (id INTEGER PRIMARY KEY,metadata TEXT,deleted_at TEXT); CREATE TABLE episodes(id INTEGER PRIMARY KEY,drama_id INTEGER,deleted_at TEXT); INSERT INTO dramas VALUES(1,'{}',NULL); INSERT INTO episodes VALUES(1,1,NULL); ALTER TABLE storyboards ADD COLUMN episode_id INTEGER DEFAULT 1");
  return db;
}

test('video route blocks before creating tasks or generation rows; stored duration wins', t => {
  const db = videoDb(t);
  t.mock.method(videoClient, 'getDefaultVideoConfig', () => h3);
  t.mock.method(taskService, 'createTask', () => assert.fail('Should not create a task'));
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  routes(db, log).create({ body: { storyboard_id: 1, duration: 15, model: 'MiniMax-H3' } }, res);
  assert.equal(res.code, 400);
  assert.match(res.body.error.message, /分镜 2.*5 秒.*拆分/);
  assert.equal(db.prepare('SELECT count(*) n FROM video_generations').get().n, 0);
});

test('H3 ignores display prompts while stored speech and maximum duration remain authoritative', t => {
  const db = videoDb(t);
  db.prepare('UPDATE storyboards SET dialogue = ?, creation_mode = ?, universal_segment_text = ? WHERE id = 1')
    .run('你好', 'universal', '台词：“' + '字'.repeat(25) + '”');
  assert.equal(validateVideoSpeech(db, { storyboard_id: 1, prompt: '台词：“' + '字'.repeat(25) + '”' }, h3).error, null);
  db.prepare('UPDATE storyboards SET dialogue = ?, creation_mode = ?, duration = ? WHERE id = 1')
    .run('甲：' + '字'.repeat(60), 'classic', 120);
  const result = validateVideoSpeech(db, { storyboard_id: 1 }, h3);
  assert.equal(result.duration, 120);
  assert.match(result.error, /4～8 秒整数/);
});

test('queued video submission rechecks manual edits before calling model API', async t => {
  const db = videoDb(t);
  db.exec("INSERT INTO video_generations (id, storyboard_id, duration, model, status) VALUES (1, 1, 15, 'MiniMax-H3', 'processing')");
  t.mock.method(videoClient, 'getDefaultVideoConfig', () => h3);
  t.mock.method(videoClient, 'callVideoApi', () => assert.fail('Over-budget shot reached model API'));
  await videoService.processVideoGeneration(db, log, 1);
  const row = db.prepare('SELECT * FROM video_generations').get();
  assert.equal(row.status, 'failed');
  assert.match(row.error_msg, /超出时长预算/);
});

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE dramas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT, style TEXT, metadata TEXT, deleted_at TEXT
    );
    CREATE TABLE episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      drama_id INTEGER, title TEXT, script_content TEXT, description TEXT, deleted_at TEXT
    );
    CREATE TABLE storyboards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      episode_id INTEGER, scene_id INTEGER, storyboard_number INTEGER,
      title TEXT, description TEXT, location TEXT, time TEXT, duration INTEGER,
      dialogue TEXT, narration TEXT, action TEXT, result TEXT, atmosphere TEXT,
      image_prompt TEXT, video_prompt TEXT, characters TEXT,
      shot_type TEXT, angle TEXT, angle_h TEXT, angle_v TEXT, angle_s TEXT,
      movement TEXT, lighting_style TEXT, depth_of_field TEXT,
      segment_index INTEGER, segment_title TEXT, creation_mode TEXT,
      universal_segment_text TEXT, status TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT,
      semantic_slots TEXT, long_take_group_id TEXT, long_take_role TEXT, long_take_sequence INTEGER
    );
    CREATE TABLE characters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      drama_id INTEGER, name TEXT, role TEXT, description TEXT, personality TEXT,
      appearance TEXT, image_url TEXT, local_path TEXT, sort_order INTEGER,
      created_at TEXT, updated_at TEXT, deleted_at TEXT
    );
    CREATE TABLE storyboard_characters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      storyboard_id INTEGER, character_id INTEGER
    );
    CREATE TABLE storyboard_props (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      storyboard_id INTEGER, prop_id INTEGER
    );
  `);
  db.exec('ALTER TABLE episodes ADD COLUMN duration INTEGER; ALTER TABLE episodes ADD COLUMN updated_at TEXT');
  db.exec("INSERT INTO dramas (id,title) VALUES (1,'测试'); INSERT INTO episodes (id,drama_id,title) VALUES (1,1,'测试'); INSERT INTO storyboards (id,episode_id,storyboard_number,title,duration,dialogue) VALUES (1,1,1,'旧分镜',5,'你好')");
  return db;
}

function mockStoryboardTask(t) {
  const state = {};
  t.mock.method(taskService, 'updateTaskStatus', () => {});
  t.mock.method(taskService, 'updateTaskResult', (_db, _id, result) => { state.result = result; });
  t.mock.method(taskService, 'updateTaskError', (_db, _id, error) => { state.error = error; });
  return state;
}

test('streamed generation is not published, and failed repair retains old storyboards', async t => {
  const db = createTestDb();
  t.after(() => db.close());
  const state = mockStoryboardTask(t);
  let calls = 0;
  t.mock.method(aiClient, 'generateText', async (_db, _log, _type, _user, _system, options) => {
    calls++;
    assert.equal(db.prepare('SELECT title FROM storyboards WHERE deleted_at IS NULL').get().title, '旧分镜');
    if (calls === 1) {
      const streamed = JSON.stringify([{ ...source, action: '动作'.repeat(300) }]);
      options.streamCallback(streamed);
      assert.equal(db.prepare('SELECT count(*) n FROM storyboards').get().n, 1);
      return streamed;
    }
    return JSON.stringify([{ dialogue: '赵总：给我推上线！' }]);
  });
  await episodeService.processStoryboardGeneration(db, log, { style: {} }, 'task', 1, null, '', 'script', 'system', false, false, 5);
  assert.equal(calls, 3);
  assert.match(state.error, /拆镜校验失败/);
  assert.equal(state.result, undefined);
  assert.equal(db.prepare('SELECT title FROM storyboards WHERE deleted_at IS NULL').get().title, '旧分镜');
});

test('valid repaired generation publishes complete shots and rebuilds universal speech', async t => {
  const db = createTestDb();
  t.after(() => db.close());
  const state = mockStoryboardTask(t);
  let calls = 0;
  t.mock.method(aiClient, 'generateText', async () => JSON.stringify(++calls === 1 ? [source] : pieces));
  await episodeService.processStoryboardGeneration(db, log, { style: {} }, 'task', 1, null, '', 'script', 'system', false, true, 5);
  assert.equal(state.error, undefined);
  assert.equal(state.result.total, 3);
  assert.equal(state.result.total_duration, 15);
  const rows = db.prepare('SELECT * FROM storyboards WHERE deleted_at IS NULL ORDER BY storyboard_number').all();
  assert.equal(rows.length, 3);
  assert.equal(preservesSpeech(source, rows), true);
  assert.ok(db.prepare('SELECT deleted_at FROM storyboards WHERE id = 1').get().deleted_at);
  for (const row of rows) {
    assert.equal(timing.assessVideoSpeech(row, row.universal_segment_text, row.duration).ok, true);
    assert.ok(!row.universal_segment_text.includes('原完整提示词'));
  }
  assert.deepEqual(rows.map((row) => row.long_take_role), [null, null, null]);
  assert.deepEqual(rows.map((row) => row.long_take_group_id), [null, null, null]);
  assert.equal(JSON.parse(rows[1].semantic_slots).h3_mode, 'ref2va');
  assert.equal(JSON.parse(rows[1].semantic_slots).first_frame_policy, 'none');
});

test('failed insert rolls back deletion of old storyboards and all replacement inserts', async t => {
  const db = createTestDb();
  t.after(() => db.close());
  const state = mockStoryboardTask(t);
  db.exec("CREATE TRIGGER reject_new BEFORE INSERT ON storyboards WHEN NEW.storyboard_number = 2 BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END");
  t.mock.method(aiClient, 'generateText', async () => JSON.stringify([{ dialogue: '你好', duration: 5 }, { dialogue: '再见', duration: 5 }]));
  await episodeService.processStoryboardGeneration(db, log, { style: {} }, 'task', 1, null, '', 'script', 'system', false, false, 5);
  assert.match(state.error, /simulated storage failure/);
  assert.equal(db.prepare('SELECT count(*) n FROM storyboards').get().n, 1);
  assert.equal(db.prepare('SELECT title FROM storyboards WHERE deleted_at IS NULL').get().title, '旧分镜');
});

test('mixed manual dialogue and stored narration share one budget, and English words cannot be merged', () => {
  assert.equal(timing.assessVideoSpeech({ narration: '字'.repeat(12) }, '台词：“' + '字'.repeat(12) + '”', 5).ok, true);
  assert.equal(preservesSpeech({ dialogue: 'ice cream' }, [{ dialogue: 'icecream' }]), false);
  assert.equal(preservesSpeech({ dialogue: 'Hello world' }, [{ dialogue: 'Hello' }, { dialogue: 'world' }]), true);
  assert.equal(preservesSpeech({ dialogue: '甲：你好！乙：再见！' }, [{ dialogue: '乙：你好！甲：再见！' }]), false);
});

test('custom prompts, narration mode and requested shot count cannot override timing contract', async t => {
  const db = createTestDb();
  t.after(() => db.close());
  db.exec(`CREATE TABLE scenes (id INTEGER PRIMARY KEY, drama_id INTEGER, location TEXT, time TEXT, deleted_at TEXT);
    CREATE TABLE props (id INTEGER PRIMARY KEY, drama_id INTEGER, name TEXT, type TEXT, deleted_at TEXT);
    UPDATE episodes SET script_content = '赵总：现在开始。' WHERE id = 1;
    UPDATE dramas SET metadata = '{"video_clip_duration":5}' WHERE id = 1;`);
  const i18n = require('../src/services/promptI18n');
  t.mock.method(i18n, 'getStoryboardSystemPrompt', () => 'CUSTOM SYSTEM');
  t.mock.method(i18n, 'getStoryboardUserPromptSuffix', () => 'CUSTOM SUFFIX');
  t.mock.method(i18n, 'getStoryboardUniversalOmniModeSuffix', () => 'CUSTOM UNIVERSAL');
  t.mock.method(taskService, 'createTask', () => ({ id: 'test-task' }));
  const state = mockStoryboardTask(t);
  let scheduled;
  t.mock.method(global, 'setImmediate', callback => { scheduled = callback; });
  const finished = new Promise((resolve, reject) => {
    taskService.updateTaskResult.mock.mockImplementation((_db, _id, result) => { state.result = result; resolve(); });
    taskService.updateTaskError.mock.mockImplementation((_db, _id, error) => reject(new Error(error)));
  });
  t.mock.method(aiClient, 'generateText', async (_db, _log, _type, user, system) => {
    assert.ok(user.includes('CUSTOM SUFFIX'));
    assert.ok(system.indexOf('强制对白时长预算') > system.indexOf('CUSTOM UNIVERSAL'));
    assert.match(system, /实际 TTS speed=1.25x/);
    assert.match(system, /实际 TTS 速度/);
    assert.match(system, /允许增加镜头数/);
    assert.match(system, /目标分镜数量/);
    return JSON.stringify([{ dialogue: '赵总：现在开始。', duration: 5, narration: '会议开始。' }]);
  });
  episodeService.generateStoryboard(db, log, 1, null, '', 1, 5, null, true, true);
  scheduled();
  await finished;
  assert.equal(state.result.total, 1);
});

test('mixed-language repair preserves token boundaries and clamps legacy durations to the H3 eight-second ceiling', async () => {
  assert.equal(preservesSpeech({ dialogue: '这是AI系统' }, [{ dialogue: '这是AI' }, { dialogue: '系统' }]), true);
  const result = await enforceStoryboardSpeechTiming([{ dialogue: '字'.repeat(25), duration: '10s' }], {
    generate: () => assert.fail('The dialogue fits after normalizing the legacy duration to eight seconds'),
  });
  assert.equal(result[0].duration, 8);
});

test('speechFromPrompt accurately delimits dialogue when followed by quote closing and next section without period', () => {
  const prompt = '动作：红狼压低身体挪到右边货箱后。对话：红狼：「左边通向出口吗？还是右边？我根本没看地图……」结果：红狼已经接近新的掩体，却因没看地图再次停滞。景别：中景。';
  const parsed = timing.speechFromPrompt(prompt);
  assert.equal(parsed.dialogue.includes('结果：'), false);
  assert.equal(parsed.dialogue.includes('掩体'), false);
  const shot = { dialogue: '红狼："左边通向出口吗？还是右边？我根本没看地图"' };
  const res = timing.assessVideoSpeech(shot, prompt, 6, { speechRate: 1.15 });
  assert.equal(res.ok, true);
  assert.equal(res.han, 18);
});
