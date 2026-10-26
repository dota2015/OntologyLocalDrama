const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const ai = require('../src/services/aiClient');
const tasks = require('../src/services/taskService');
const characters = require('../src/services/characterGenerationService');
const props = require('../src/services/propExtractionService');
const reuse = require('../src/services/extractionReuseService');
const log = { info() {}, warn() {}, error() {} };
const cfg = { app: { language: 'zh' }, style: {} };

function setup(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE dramas (id INTEGER PRIMARY KEY, title TEXT, description TEXT, genre TEXT, style TEXT, metadata TEXT, deleted_at TEXT);
    CREATE TABLE episodes (id INTEGER PRIMARY KEY, drama_id INTEGER, script_content TEXT, deleted_at TEXT);
    CREATE TABLE episode_characters (episode_id INTEGER, character_id INTEGER, UNIQUE(episode_id, character_id));
    CREATE TABLE characters (id INTEGER PRIMARY KEY AUTOINCREMENT, drama_id INTEGER, name TEXT, role TEXT,
      description TEXT, personality TEXT, appearance TEXT, voice_style TEXT, sort_order INTEGER,
      image_url TEXT, local_path TEXT, identity_anchors TEXT, style_tokens TEXT, color_palette TEXT,
      four_view_image_url TEXT, polished_prompt TEXT, extra_images TEXT, ref_image TEXT,
      created_at TEXT, updated_at TEXT, deleted_at TEXT);
    CREATE TABLE props (id INTEGER PRIMARY KEY AUTOINCREMENT, drama_id INTEGER, episode_id INTEGER, name TEXT,
      type TEXT, description TEXT, prompt TEXT, negative_prompt TEXT, image_url TEXT, local_path TEXT,
      extra_images TEXT, ref_image TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT);
    CREATE TABLE character_libraries (id INTEGER PRIMARY KEY, drama_id INTEGER, name TEXT, description TEXT,
      appearance TEXT, category TEXT, tags TEXT, image_url TEXT, local_path TEXT, identity_anchors TEXT,
      style_tokens TEXT, color_palette TEXT, four_view_image_url TEXT, source_type TEXT, source_id TEXT, deleted_at TEXT);
    CREATE TABLE prop_libraries (id INTEGER PRIMARY KEY, drama_id INTEGER, name TEXT, description TEXT,
      prompt TEXT, category TEXT, tags TEXT, image_url TEXT, local_path TEXT, source_type TEXT, source_id TEXT, deleted_at TEXT);
    INSERT INTO dramas VALUES (1,'本剧','故事',NULL,NULL,'{"dubbing":{"character_voices":{"5":"voice-A"}},"h3_voices":{"5":"reference.wav"}}',NULL),
      (2,'其他剧','禁止混入',NULL,NULL,'{}',NULL);
    INSERT INTO episodes VALUES (6,1,'王奕宸回到基地。',NULL),(7,1,'奕宸拿起训练卡。',NULL),(8,2,'其他剧',NULL);
    INSERT INTO characters (id,drama_id,name,appearance,voice_style,image_url,local_path,identity_anchors,polished_prompt,extra_images,updated_at)
      VALUES (5,1,'王奕宸','原有外貌','原有音色','/original.png','original.png','{"face":"fixed"}','saved prompt','["side.png"]','before'),
        (6,1,'林教官','原有教官',NULL,NULL,NULL,NULL,NULL,NULL,'before'),
        (90,2,'外剧角色','禁止混入',NULL,NULL,NULL,NULL,NULL,NULL,'before');
    INSERT INTO episode_characters VALUES (6,5),(7,5),(7,6);
    INSERT INTO props (id,drama_id,episode_id,name,description,prompt,image_url,local_path,updated_at)
      VALUES (10,1,7,'训练任务卡','原有形状','original prompt','/card.png','card.png','before'),
        (11,1,6,'徽章','原有徽章','badge prompt',NULL,NULL,'before'),
        (90,2,8,'外剧道具','禁止混入','foreign',NULL,NULL,'before');
    INSERT INTO character_libraries (id,drama_id,name,source_type,source_id) VALUES (20,1,'奕宸人物卡','character','5'),(90,2,'外剧库人物',NULL,NULL),(91,NULL,'全局人物',NULL,NULL);
    INSERT INTO character_libraries (id,drama_id,name,appearance,image_url,local_path,identity_anchors,four_view_image_url)
      VALUES (21,1,'妈妈','原有妈妈外貌','/mother.png','mother.png','{"face":"mother"}','/mother-views.png');
    INSERT INTO prop_libraries (id,drama_id,name,source_type,source_id) VALUES (30,1,'训练卡素材','prop','10'),(90,2,'外剧库道具',NULL,NULL),(91,NULL,'全局道具',NULL,NULL);
    INSERT INTO prop_libraries (id,drama_id,name,description,prompt,image_url,local_path)
      VALUES (31,1,'平板','银色平板','tablet prompt','/tablet.png','tablet.png');`);
  for (const table of ['props', 'scenes'].filter(table => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))) {
    for (const field of ['reference_image_mode','reference_image_recommendation','reference_image_reason']) db.exec(`ALTER TABLE ${table} ADD COLUMN ${field} TEXT`);
  }
  const state = {};
  t.mock.method(tasks, 'updateTaskStatus', () => {});
  t.mock.method(tasks, 'updateTaskResult', (db, id, result) => { state.result = result; });
  t.mock.method(tasks, 'updateTaskError', (db, id, error) => { state.error = error; });
  t.mock.method(console, 'log', () => {});
  return { db, state };
}

function snapshot(db) {
  return ['dramas', 'episodes', 'characters', 'props', 'episode_characters', 'character_libraries', 'prop_libraries']
    .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

async function run(db, kind, config = cfg) {
  if (kind === 'character') await characters.processCharacterGeneration(db, config, log, 'test', { drama_id: 1, episode_id: 7, outline: '奕宸拿起训练卡。' });
  else await props.processPropExtraction(db, log, 'test', 7, config);
}

for (const kind of ['character', 'prop']) {
  test(`${kind} extraction supplies only this drama's resources/library, in both language modes`, async t => {
    const { db, state } = setup(t);
    const before = snapshot(db);
    let calls = 0;
    t.mock.method(ai, 'generateText', async (db, log, type, user, system, opts) => {
      calls++;
      assert.match(user, /Existing resources/);
      assert.match(user, /existing_id/);
      assert.match(user, /library_id/);
      assert.doesNotMatch(user, /外剧|全局|禁止混入/);
      assert.match(system, /canonical name/);
      assert.match(system, /nicknames/);
      assert.equal(opts.scene_key, kind === 'character' ? 'role_extraction' : 'prop_extraction');
      return JSON.stringify(kind === 'character' ? [{ name: '王奕宸', existing_id: 5 }, { name: '林教官', existing_id: 6 }]
        : [{ name: '训练任务卡', existing_id: 10 }]);
    });
    for (const language of ['zh', 'en']) await run(db, kind, { ...cfg, app: { language } });
    assert.equal(calls, 2);
    assert.equal(state.error, undefined);
    assert.deepEqual(snapshot(db), before, 're-extraction preserves existing identities, voices, images and descriptions');
  });

  test(`${kind} resolves a short name through an explicit ID and deduplicates repeated mentions`, async t => {
    const { db, state } = setup(t);
    const id = kind === 'character' ? 5 : 10;
    const before = snapshot(db);
    t.mock.method(ai, 'generateText', async () => JSON.stringify([{ name: '简称', existing_id: id, appearance: 'do not overwrite', description: 'do not overwrite' }, { existing_id: id }]));
    await run(db, kind);
    assert.equal(state.error, undefined);
    assert.equal(state.result.count, 1);
    assert.equal(state.result[kind === 'character' ? 'characters' : 'props'][0].id, id);
    const after = snapshot(db);
    assert.deepEqual(after.slice(0, 4), before.slice(0, 4));
    if (kind === 'character') assert.deepEqual(db.prepare('SELECT * FROM episode_characters WHERE episode_id=6').all(), [{episode_id: 6, character_id: 5}]);
  });

  test(`${kind} library source reuses the existing resource, library-only entries keep their images`, async t => {
    const { db, state } = setup(t);
    const sourceId = kind === 'character' ? 20 : 30;
    const importedId = sourceId + 1;
    t.mock.method(ai, 'generateText', async () => JSON.stringify([{ library_id: sourceId }, { library_id: importedId }, { library_id: importedId }]));
    await run(db, kind);
    assert.equal(state.error, undefined);
    assert.equal(state.result.count, 2);
    const rows = state.result[kind === 'character' ? 'characters' : 'props'];
    assert.equal(rows[0].id, kind === 'character' ? 5 : 10);
    assert.equal(rows[1].local_path, kind === 'character' ? 'mother.png' : 'tablet.png');
    if (kind === 'character') assert.equal(rows[1].identity_anchors, '{"face":"mother"}');
    const count = db.prepare(`SELECT count(*) n FROM ${kind === 'character' ? 'characters' : 'props'}`).get().n;
    await run(db, kind);
    assert.equal(db.prepare(`SELECT count(*) n FROM ${kind === 'character' ? 'characters' : 'props'}`).get().n, count);
  });

  test(`${kind} invalid, cross-drama and deleted references fail atomically`, async t => {
    const { db, state } = setup(t);
    const table = kind === 'character' ? 'characters' : 'props';
    const libraryTable = kind === 'character' ? 'character_libraries' : 'prop_libraries';
    db.prepare(`INSERT INTO ${table} (id,drama_id,name,deleted_at) VALUES (95,1,'已删除','deleted')`).run();
    db.prepare(`INSERT INTO ${libraryTable} (id,drama_id,name,deleted_at) VALUES (95,1,'已删除库项','deleted')`).run();
    for (const bad of [{ existing_id: 90 }, { library_id: 90 }, { library_id: 91 }, { existing_id: 999 }, { existing_id: 95 }, { library_id: 95 }, { existing_id: true }, { existing_id: 5, library_id: 20 }]) {
      const before = snapshot(db);
      const mock = t.mock.method(ai, 'generateText', async () => JSON.stringify([{ name: '全新资源', image_prompt: 'new prompt' }, bad]));
      await run(db, kind);
      assert.match(state.error, /原有资源未修改/);
      assert.deepEqual(snapshot(db), before);
      mock.mock.restore();
    }
  });

  test(`${kind} exact names fall back to reuse; genuinely new resources are created once`, async t => {
    const { db, state } = setup(t);
    const name = kind === 'character' ? '王奕宸' : '训练任务卡';
    t.mock.method(ai, 'generateText', async () => JSON.stringify([{name}, {name: '新资源', image_prompt: 'new prompt'}, {name: '新资源', image_prompt: 'duplicate'}]));
    await run(db, kind);
    assert.equal(state.error, undefined);
    assert.equal(state.result.count, 2);
    assert.equal(db.prepare(`SELECT count(*) n FROM ${kind === 'character' ? 'characters' : 'props'} WHERE name='新资源'`).get().n, 1);
  });

  test(`${kind} malformed model output preserves episode links and every resource`, async t => {
    const { db, state } = setup(t);
    const before = snapshot(db);
    t.mock.method(ai, 'generateText', async () => '{"message":"cannot extract"}');
    await run(db, kind);
    assert.deepEqual(snapshot(db), before);
    // Character parsing uses the legacy status updater; neither path completes.
    assert.equal(state.result, undefined);
  });

  test(`${kind} extraction leaves unused resources available for other episodes`, async t => {
    const { db, state } = setup(t);
    const before = snapshot(db);
    t.mock.method(ai, 'generateText', async () => '[]');
    await run(db, kind);
    assert.equal(state.error, undefined);
    assert.equal(state.result.count, 0);
    assert.deepEqual(snapshot(db).slice(0, 4), before.slice(0, 4));
    if (kind === 'character') {
      assert.equal(db.prepare('SELECT count(*) n FROM episode_characters WHERE episode_id=7').get().n, 0);
      assert.equal(db.prepare('SELECT count(*) n FROM episode_characters WHERE episode_id=6').get().n, 1);
    }
  });

  test(`${kind} ambiguous exact names require a resource ID`, t => {
    const { db } = setup(t);
    const name = kind === 'character' ? '王奕宸' : '训练任务卡';
    const table = kind === 'character' ? 'characters' : 'props';
    db.prepare(`INSERT INTO ${table} (drama_id,name) VALUES (1,?)`).run(name);
    assert.throws(() => reuse.resolve(reuse.catalog(db, 1, kind), {name}), /多个同名/);
    assert.equal(reuse.resolve(reuse.catalog(db, 1, kind), {existing_id: kind === 'character' ? 5 : 10}).existing.name, name);
  });
}

test('nickname matching does not silently merge unrelated people or similar props', t => {
  const { db } = setup(t);
  assert.equal(reuse.resolve(reuse.catalog(db, 1, 'character'), {name: '奕宸'}).existing, undefined);
  assert.equal(reuse.resolve(reuse.catalog(db, 1, 'prop'), {name: '别人的训练卡'}).existing, undefined);
});

test('an episode from another drama cannot have its character links replaced', async t => {
  const { db, state } = setup(t);
  const before = snapshot(db);
  t.mock.method(ai, 'generateText', async () => '[{"existing_id":5}]');
  await characters.processCharacterGeneration(db, cfg, log, 'test', { drama_id: 1, episode_id: 8 });
  assert.match(state.error, /分集不属于当前剧/);
  assert.deepEqual(snapshot(db), before);
});

test('prop extraction persists AI image advice without replacing a reviewed choice', async t => {
  const {db,state}=setup(t);
  db.prepare("UPDATE props SET reference_image_mode='quad_grid' WHERE id=10").run();
  t.mock.method(ai,'generateText',async (db,log,type,user,system)=>{
    assert.match(system,/reference_image_reason/);
    return '[{"existing_id":10,"reference_image_mode":"single","reference_image_reason":"任务卡细节适合单图。"}]';
  });
  await run(db,'prop');
  assert.equal(state.error,undefined);
  assert.equal(state.result.props[0].reference_image_mode,'quad_grid');
  assert.equal(state.result.props[0].reference_image_recommendation,'single');
  assert.equal(state.result.props[0].local_path,'card.png');
});
