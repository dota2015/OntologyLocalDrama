const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const migrate = require('../src/db/migrate');
const ontologyRoutes = require('../src/routes/ontology');

const log = { info() {}, warn() {}, error() {}, errorw() {} };

test('director refuses duplicate execution and legacy resume before creating a new task', async t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  migrate.runMigrationsAndEnsure(db);
  db.exec(`INSERT INTO dramas(id,title) VALUES(1,'测试');
    INSERT INTO episodes(id,drama_id,episode_number,script_content) VALUES(10,1,1,'同镜完成多个动作。');
    INSERT INTO async_tasks(id,type,resource_id,status) VALUES('existing','director_storyboard_generation','10','processing');`);
  const routes = ontologyRoutes(db, log);
  let payload;
  const res = { statusCode: 0, status(code) { this.statusCode=code; return this; }, json(body) { payload=body; } };
  await routes.directorGenerate({params:{episode_id:'10'},body:{}},res);
  assert.equal(res.statusCode,409);
  assert.equal(payload.error.details.task_id,'existing');
  db.prepare("UPDATE async_tasks SET status='failed' WHERE id='existing'").run();
  await routes.directorGenerate({params:{episode_id:'10'},body:{resume_task_id:'existing'}},res);
  assert.equal(res.statusCode,400);
  assert.match(payload.error.message,/没有断点记录/);
  assert.equal(db.prepare('SELECT count(*) n FROM async_tasks').get().n,1);
});

test('single-shot Director refinement returns a durable async task before inference completes', async (t) => {
  const db = new Database(':memory:');
  t.after(() => { if (db.open) db.close(); });
  migrate.runMigrationsAndEnsure(db);
  db.exec(`
    INSERT INTO dramas(id, title) VALUES(1, '后台微调测试');
    INSERT INTO episodes(id, drama_id, episode_number, script_content) VALUES(10, 1, 1, '角色在房间内交谈。');
    INSERT INTO storyboards(id, episode_id, storyboard_number, title, duration, action)
    VALUES(100, 10, 16, '第十六镜', 5, '两人交谈');
  `);

  let payload = null;
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { payload = body; return body; },
  };
  const routes = ontologyRoutes(db, log);
  await routes.refineStoryboard({
    params: { id: '100' },
    body: { instruction: '让姐姐听到咳嗽后立刻转头看向弟弟' },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(payload.success, true);
  assert.equal(payload.data.status, 'pending');
  assert.equal(payload.data.storyboard_id, 100);
  assert.ok(payload.data.task_id);
  const row = db.prepare('SELECT type, resource_id, status FROM async_tasks WHERE id=?').get(payload.data.task_id);
  assert.equal(row.type, 'director_storyboard_refinement');
  assert.equal(row.resource_id, '100');
  assert.ok(['pending', 'processing', 'failed'].includes(row.status));
});
