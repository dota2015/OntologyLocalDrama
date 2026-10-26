const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const ai = require('../src/services/aiClient');
const stories = require('../src/services/storyGenerationService');
const prompts = require('../src/services/promptI18n');
const { storyExpansionRules, storyboardRules } = require('../src/services/storytellingPrompts');
const log = { info() {}, warn() {}, error() {} };

test('script naming applies across narrative styles, languages and custom prompts without renaming approved storyboards', t => {
  for (const language of ['zh', 'en']) {
    for (const preset of ['dialogue_fast', 'balanced', 'narration', 'atmosphere']) {
      const cfg = { app: { language }, narrative_style: { preset } };
      const rule = storyExpansionRules(cfg);
      assert.match(rule, language === 'zh' ? /首次出场以/ : /first appearance/);
      assert.match(rule, language === 'zh' ? /未个体化的群体/ : /anonymous enemy forces/);
      assert.match(rule, language === 'zh' ? /已有确定姓名的角色不得重新起名/ : /Never change a name that is already established/);
      assert.doesNotMatch(storyboardRules(cfg), /固定人物姓名|STABLE CHARACTER NAMES/);
    }
  }
  prompts.setOverrideInMemory('story_expansion_system', '自定义创作要求');
  t.after(() => prompts.clearOverrideInMemory('story_expansion_system'));
  assert.match(prompts.getStoryExpansionSystemPrompt({}, 3), /固定人物姓名/);
  assert.match(prompts.getLockedSuffix('story_expansion_system'), /固定人物姓名/);
});

test('actual story generation receives this drama cast and library, without media or cross-project identities, and leaves saved scripts untouched', async t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE dramas (id INTEGER PRIMARY KEY, metadata TEXT, deleted_at TEXT);
    CREATE TABLE characters (id INTEGER PRIMARY KEY, drama_id INTEGER, name TEXT, description TEXT, image_url TEXT, deleted_at TEXT);
    CREATE TABLE character_libraries (id INTEGER PRIMARY KEY, drama_id INTEGER, name TEXT, description TEXT, deleted_at TEXT);
    CREATE TABLE episodes (id INTEGER PRIMARY KEY, script_content TEXT);
    INSERT INTO dramas VALUES(1,'{}',NULL);
    INSERT INTO characters VALUES(1,1,'王奕宸','操控红狼','media-secret',NULL),(2,2,'外剧角色','外剧设定',NULL,NULL),(3,1,'已删除角色','隐藏',NULL,'deleted');
    INSERT INTO character_libraries VALUES(1,1,'林教官','原有教官',NULL),(2,2,'外剧库角色','禁止混入',NULL),(3,NULL,'全局库角色','禁止混入',NULL);
    INSERT INTO episodes VALUES(1,'已审核原稿');`);
  const before = db.prepare('SELECT * FROM episodes').all();
  const calls = [];
  t.mock.method(ai, 'generateText', async (_db, _log, _type, user, system) => {
    calls.push({ user, system });
    return JSON.stringify([{ episode: 1, title: '草稿', content: '王奕宸："先写作业。"' }]);
  });
  await stories.generateStory(db, log, { drama_id: 1, premise: '少年与妈妈和妹妹的故事', episode_count: 3 });
  assert.match(calls[0].user, /王奕宸/);
  assert.match(calls[0].user, /林教官/);
  assert.match(calls[0].user, /do not force every catalog entry/);
  assert.doesNotMatch(calls[0].user, /media-secret|外剧|全局库角色|已删除角色/);
  assert.match(calls[0].system, /固定人物姓名|STABLE CHARACTER NAMES/);
  await stories.generateStory(db, log, { premise: '一个全新故事' });
  assert.doesNotMatch(calls[1].user, /Existing character identities|王奕宸|林教官/);
  assert.deepEqual(db.prepare('SELECT * FROM episodes').all(), before);
});
