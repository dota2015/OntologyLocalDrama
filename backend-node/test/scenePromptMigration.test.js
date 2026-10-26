const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const migrate = require('../src/db/migrate');
const scenes = require('../src/services/sceneService');
const ai = require('../src/services/aiClient');
const images = require('../src/services/imageClient');
const sceneRoutes = require('../src/routes/scenes');
const log = { info() {}, warn() {}, error() {} };
const cfg = { app: { language: 'zh' }, style: {} };

function setup(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  db.exec(`CREATE TABLE scenes (id INTEGER PRIMARY KEY, drama_id INTEGER, location TEXT,
    polished_prompt TEXT, image_url TEXT, local_path TEXT, deleted_at TEXT);
    INSERT INTO scenes VALUES (10, 1, '训练基地', 'existing four-view prompt', '/scene.png', 'scene.png', NULL)`);
  migrate.runMigrationsAndEnsure(db);
  db.exec("INSERT INTO dramas (id,title,metadata) VALUES (1,'本剧','{}')");
  return db;
}

test('startup upgrades legacy scenes idempotently while preserving images and four-view prompts', t => {
  const db = setup(t);
  const before = db.prepare('SELECT * FROM scenes WHERE id = 10').get();
  assert.equal(before.polished_prompt_single, null);
  assert.equal(before.local_path, 'scene.png');
  assert.equal(before.polished_prompt, 'existing four-view prompt');
  migrate.runMigrationsAndEnsure(db);
  assert.deepEqual(db.prepare('SELECT * FROM scenes WHERE id = 10').get(), before);
});

test('real single-image route on upgraded scenes saves its prompt and submits the image request', async t => {
  const db = setup(t);
  t.mock.method(ai, 'generateText', async () => 'A clean training room with a task board.');
  const requests = [];
  t.mock.method(images, 'createAndGenerateImage', (db, log, request) => {
    requests.push(request);
    return { id: 123 };
  });
  const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await sceneRoutes(db, log, cfg).generateImage({ body: { scene_id: 10, use_quad_grid: false } }, res);
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.image_generation.id, 123);
  assert.equal(requests.length, 1);
  const row = db.prepare('SELECT * FROM scenes WHERE id = 10').get();
  assert.equal(row.polished_prompt_single, requests[0].prompt);
  assert.match(row.polished_prompt_single, /clean training room/);
  assert.equal(row.polished_prompt, 'existing four-view prompt');
  assert.equal(row.local_path, 'scene.png');
});

test('single and four-view generation reuse their own saved prompts without text AI', async t => {
  const db = setup(t);
  scenes.updateScene(db, log, 10, { polished_prompt_single: 'saved single-view prompt' });
  t.mock.method(ai, 'generateText', async () => { assert.fail('saved prompts should skip text AI'); });
  const prompts = [];
  t.mock.method(images, 'createAndGenerateImage', (db, log, request) => {
    prompts.push(request.prompt);
    return { id: prompts.length };
  });
  assert.equal((await scenes.generateSceneSingleImage(db, log, cfg, 10)).ok, true);
  assert.equal((await scenes.generateSceneFourViewImage(db, log, cfg, 10)).ok, true);
  assert.deepEqual(prompts, ['saved single-view prompt', 'existing four-view prompt']);
});
