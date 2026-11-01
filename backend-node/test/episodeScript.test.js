const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const aiClient = require('../src/services/aiClient');
const service = require('../src/services/episodeScriptService');
const prompts = require('../src/services/promptI18n');
const log = { info() {}, warn() {}, error() {} };

function setup(t) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE dramas (id INTEGER PRIMARY KEY, description TEXT, metadata TEXT, updated_at TEXT, deleted_at TEXT);
    CREATE TABLE episodes (id INTEGER PRIMARY KEY, drama_id INTEGER, episode_number INTEGER, title TEXT,
      script_content TEXT, description TEXT, duration REAL, updated_at TEXT, deleted_at TEXT);
    CREATE TABLE characters (id INTEGER PRIMARY KEY, drama_id INTEGER, name TEXT, description TEXT, deleted_at TEXT);
    CREATE TABLE storyboards (id INTEGER PRIMARY KEY, episode_id INTEGER, dialogue TEXT);
    INSERT INTO dramas VALUES (1,'六集学习成长故事','{"shot_duration_range":{"min":4,"max":6}}','before',NULL),
      (2,'其他项目','{}','before',NULL);
    INSERT INTO episodes VALUES (6,1,1,'第一集','第一集结尾：新兵决定主动学习。','已保存简介',120,'before',NULL),
      (7,1,2,'夺回时间','作业超时，教官帮助新兵战胜拖延。','本集说明',100,'before',NULL),
      (8,1,3,'粗心裂缝','后续集：解决粗心问题。','下一集说明',110,'before',NULL),
      (9,2,1,'别的故事','另一个工程的正文',NULL,10,'before',NULL),
      (10,1,4,'已删除','隐藏正文',NULL,0,'before','deleted');
    INSERT INTO characters VALUES (5,1,'王奕宸','少年新兵',NULL),(6,1,'林教官','教官',NULL),
      (7,2,'其他项目人物','不要混入',NULL);
    INSERT INTO storyboards VALUES (53,6,'王奕宸：你好。'),(74,7,'原有分镜');`);
  t.after(() => db.close());
  return db;
}

function snapshot(db) {
  return ['dramas', 'episodes', 'storyboards'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
}

test('current-episode draft includes continuity and timing context without changing any saved content', async t => {
  const db = setup(t);
  const before = snapshot(db);
  t.mock.method(aiClient, 'generateText', async (database, logger, kind, user, system, opts) => {
    const context = JSON.parse(user.slice(user.indexOf('{')));
    assert.equal(context.target_episode, 2);
    assert.equal(context.total_episodes, 3);
    assert.equal(context.current_episode.title, '夺回时间');
    assert.match(context.previous_episode.ending, /新兵决定主动学习/);
    assert.match(context.next_episode.opening, /粗心问题/);
    assert.deepEqual(context.characters.map(c => c.name), ['王奕宸', '林教官']);
    assert.deepEqual(context.shot_duration_range, { min: 4, max: 6 });
    assert.equal(context.premise, '正在编辑的新梗概');
    assert.match(system, /episode.*2|episode必须为2/);
    assert.match(system, /4–6/);
    assert.equal(opts.scene_key, 'story_generation');
    return JSON.stringify([{ episode: 2, title: '主动开始', content: '王奕宸："先写第一题。"\n旁白："这一次，他决定不再等人催。"' }]);
  });
  const result = await service.generateEpisodeDraft(db, log, 7, { premise: '正在编辑的新梗概' });
  assert.equal(result.episode_id, 7);
  assert.match(result.script_content, /不再等人催/);
  assert.deepEqual(snapshot(db), before);
});

test('wrong-episode and multi-episode AI output are rejected with no writes', async t => {
  const db = setup(t);
  const before = snapshot(db);
  for (const output of [[{ episode: 1, content: '错误集' }], [{ episode: 2, content: '本集' }, { episode: 3, content: '多余' }], [{ episode: 2, content: '' }]]) {
    const mock = t.mock.method(aiClient, 'generateText', async () => JSON.stringify(output));
    await assert.rejects(service.generateEpisodeDraft(db, log, 7), /原剧本未修改/);
    mock.mock.restore();
    assert.deepEqual(snapshot(db), before);
  }
});

test('saving one episode preserves other episodes, target metadata and every storyboard', t => {
  const db = setup(t);
  const before = snapshot(db);
  service.saveEpisodeScript(db, 7, { title: '新标题', script_content: '新的对白与旁白' });
  const after = snapshot(db);
  assert.deepEqual(after[1].filter(e => e.id !== 7), before[1].filter(e => e.id !== 7));
  assert.deepEqual(after[2], before[2]);
  const target = after[1].find(e => e.id === 7);
  assert.equal(target.script_content, '新的对白与旁白');
  assert.equal(target.description, '本集说明');
  assert.equal(target.duration, 100);
  assert.deepEqual(after[0].find(d => d.id === 2), before[0].find(d => d.id === 2));
  for (const id of [0, 10, 100, 'NaN']) assert.throws(() => service.saveEpisodeScript(db, id, {script_content:'test'}), /不存在/);
  assert.throws(() => service.saveEpisodeScript(db, 7, {script_content:' '}), /必填/);
});

test('custom prompts retain comprehension policy, separate speech fields and allow necessary silence', t => {
  t.after(() => {
    for (const key of ['story_expansion_system', 'storyboard_system', 'storyboard_user_suffix']) prompts.clearOverrideInMemory(key);
  });
  prompts.setOverrideInMemory('story_expansion_system', 'CUSTOM_STORY');
  prompts.setOverrideInMemory('storyboard_system', 'CUSTOM_SHOTS');
  prompts.setOverrideInMemory('storyboard_user_suffix', 'CUSTOM_FORMAT');
  for (const language of ['zh', 'en']) {
    const cfg = { app: { language } };
    const story = prompts.getStoryExpansionSystemPrompt(cfg, 6);
    const shots = prompts.getStoryboardSystemPrompt(cfg);
    assert.match(story, /关键动机|essential motives/);
    assert.match(shots, /narration/);
    assert.match(shots, /固定镜头|static/i);
    const on = prompts.getStoryboardNarrationModeInstructions(cfg, true);
    const off = prompts.getStoryboardNarrationModeInstructions(cfg, false);
    assert.match(on, /可为空|silent transitions/);
    assert.match(off, /保留原剧本明确写出的旁白|Preserve explicit narration/);
    assert.doesNotMatch(on + shots, /narration.*MUST be a non-empty|每个分镜的 narration 必须为非空/);
    assert.match(prompts.getStoryboardUserPromptSuffix(cfg, 6), /dialogue, narration/);
    const universal = prompts.getStoryboardUniversalOmniModeSuffix(cfg);
    assert.doesNotMatch(universal, /至少两步运镜/);
    assert.match(universal, /M=1/);
  }
  assert.match(prompts.getStoryExpansionSystemPrompt({}, 6), /CUSTOM_STORY/);
  assert.match(prompts.getStoryboardSystemPrompt({}), /CUSTOM_SHOTS/);
  assert.match(prompts.getLockedSuffix('storyboard_system'), /dialogue, narration/);
});
