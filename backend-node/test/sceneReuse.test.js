const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const migrate = require('../src/db/migrate');
const backgrounds = require('../src/services/backgroundExtractionService');
const scenes = require('../src/services/sceneService');
const episodeScenes = require('../src/services/episodeSceneService');
const drama = require('../src/services/dramaService');
const reuse = require('../src/services/extractionReuseService');
const advice = require('../src/services/referenceImageModeService');
const ai = require('../src/services/aiClient');
const tasks = require('../src/services/taskService');
const log = { info() {}, warn() {}, error() {} };
const cfg = { app: { language: 'zh' }, style: {} };

function setup(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  migrate.runMigrationsAndEnsure(db);
  db.exec(`INSERT INTO dramas (id,title,metadata) VALUES (1,'本剧','{}'),(2,'外剧','{}');
    INSERT INTO episodes (id,drama_id,episode_number,title,script_content) VALUES
      (6,1,1,'第一集','王奕宸坐在书桌前。'),(7,1,2,'第二集','奕宸回到家中书桌所在的学习空间。'),(8,2,1,'外剧','外剧');
    INSERT INTO scenes (id,drama_id,episode_id,location,time,prompt,polished_prompt,polished_prompt_single,image_url,local_path,extra_images,ref_image,reference_image_mode) VALUES
      (2,1,6,'王奕宸房间·书桌区','午后','木质书桌，儿童房','saved quad','saved single','/desk.png','desk.png','["side.png"]','uploaded.png','quad_grid'),
      (90,2,8,'外剧场景','白天','禁止混入',NULL,NULL,NULL,NULL,NULL,NULL,NULL);
    INSERT INTO scene_libraries (id,drama_id,location,prompt,local_path,source_type,source_id) VALUES
      (20,1,'书桌场景素材','不要覆盖','desk.png','scene','2'),
      (21,1,'客厅','固定沙发与收纳柜','living.png',NULL,NULL),
      (90,2,'外剧库场景','禁止混入',NULL,NULL,NULL),
      (91,NULL,'全局库场景','禁止混入',NULL,NULL,NULL);
    INSERT INTO storyboards (id,episode_id,scene_id,storyboard_number,title) VALUES (50,6,2,1,'第一集镜头')`);
  const state = {};
  t.mock.method(tasks, 'updateTaskStatus', (db,id,status,progress,message) => { state.status = status; state.message = message; });
  t.mock.method(tasks, 'updateTaskError', (db,id,error) => { state.error = error; });
  t.mock.method(tasks, 'updateTaskResult', (db,id,result) => { state.result = result; });
  t.mock.method(scenes, 'generateScenePromptOnly', async () => ({ok:true}));
  t.mock.method(scenes, 'generateSceneSinglePromptOnly', async () => ({ok:true}));
  return {db,state};
}

async function run(db, config = cfg) {
  await backgrounds.processBackgroundExtraction(db, config, log, 'test', 7);
  await new Promise(setImmediate);
}

function snapshot(db) {
  return ['scenes','episodes','episode_scenes','storyboards','scene_libraries'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

test('scene extraction includes only this drama catalog in both languages and links renamed places without redesigning them', async t => {
  const {db,state} = setup(t);
  const before = db.prepare('SELECT * FROM scenes WHERE id=2').get();
  t.mock.method(ai, 'generateText', async (db,log,type,user,system) => {
    assert.match(user,/Existing resources/);
    assert.match(user,/王奕宸房间·书桌区/);
    assert.match(user,/木质书桌/);
    assert.match(user,/library_id/);
    assert.doesNotMatch(user,/外剧|全局库|禁止混入/);
    assert.match(system,/same physical space/);
    assert.match(system,/does not justify redesigning/);
    return JSON.stringify([{existing_id:2,location:'家中书桌所在的学习空间',prompt:'不应替换成科幻房间',reference_image_mode:'single',reference_image_reason:'建议仅供审核'}]);
  });
  for (const language of ['zh','en']) await run(db,{...cfg,app:{language}});
  assert.equal(state.error,undefined);
  assert.equal(state.result.count,1);
  assert.equal(state.result.scenes[0].id,2);
  const after = db.prepare('SELECT * FROM scenes WHERE id=2').get();
  for (const key of Object.keys(before).filter(key => !['reference_image_recommendation','reference_image_reason'].includes(key))) assert.deepEqual(after[key],before[key],key);
  assert.deepEqual(db.prepare('SELECT * FROM episode_scenes').all(),[{episode_id:7,scene_id:2}]);
  for (const episodeId of [6,7]) assert.equal(episodeScenes.list(db,1,episodeId)[0].id,2);
  const loaded = drama.getDrama(db,1);
  assert.equal(loaded.episodes.find(ep=>ep.id===7).scenes[0].local_path,'desk.png');
  assert.equal(loaded.episodes.find(ep=>ep.id===6).scenes[0].local_path,'desk.png');
});

test('scene library sources reuse existing identities; library-only resources retain images and import once', async t => {
  const {db,state} = setup(t);
  t.mock.method(ai,'generateText',async()=>JSON.stringify([{library_id:20},{library_id:21},{library_id:21}]));
  await run(db);
  assert.equal(state.error,undefined);
  assert.equal(state.result.count,2);
  assert.equal(state.result.scenes[0].id,2);
  assert.equal(state.result.scenes[1].local_path,'living.png');
  const count = db.prepare('SELECT count(*) n FROM scenes').get().n;
  await run(db);
  assert.equal(db.prepare('SELECT count(*) n FROM scenes').get().n,count);
  assert.equal(db.prepare('SELECT count(*) n FROM episode_scenes WHERE episode_id=7').get().n,2);
});

test('cross-drama, missing, deleted and conflicting scene references fail without changing any resources or links', async t => {
  const {db,state} = setup(t);
  db.exec("INSERT INTO scenes (id,drama_id,location,deleted_at) VALUES (95,1,'删除场景','deleted')");
  for (const bad of [{existing_id:90},{library_id:90},{library_id:91},{existing_id:999},{existing_id:95},{existing_id:true},{existing_id:2,library_id:20}]) {
    const before = snapshot(db);
    const mocked = t.mock.method(ai,'generateText',async()=>JSON.stringify([{location:'新场景',prompt:'新的房间'},bad]));
    await run(db);
    assert.match(state.error,/原有资源未修改/);
    assert.deepEqual(snapshot(db),before);
    mocked.mock.restore();
  }
});

test('exact scene names reuse across episodes and times; similar room names never auto-merge', async t => {
  const {db,state} = setup(t);
  t.mock.method(ai,'generateText',async()=>JSON.stringify([{location:'王奕宸房间·书桌区',time:'晚上'},{location:'另一人的房间·书桌区',prompt:'另一间普通卧室'},{location:'另一人的房间·书桌区'}]));
  await run(db);
  assert.equal(state.error,undefined);
  assert.equal(state.result.count,2);
  assert.equal(state.result.scenes[0].id,2);
  assert.equal(db.prepare("SELECT count(*) n FROM scenes WHERE location='另一人的房间·书桌区'").get().n,1);
  assert.equal(reuse.resolve(reuse.catalog(db,1,'scene'),{location:'家中书桌所在的学习空间'}).existing,undefined);
});

test('ambiguous scene names require explicit IDs and malformed output leaves existing scenes intact', async t => {
  const {db,state} = setup(t);
  db.exec("INSERT INTO scenes (drama_id,episode_id,location) VALUES (1,6,'王奕宸房间·书桌区')");
  const before = snapshot(db);
  const mocked = t.mock.method(ai,'generateText',async()=>JSON.stringify([{location:'王奕宸房间·书桌区'}]));
  await run(db);
  assert.match(state.error,/多个同名/);
  assert.deepEqual(snapshot(db),before);
  mocked.mock.restore();
  t.mock.method(ai,'generateText',async()=>' {"message":"无法解析"} ');
  await run(db);
  assert.equal(state.status,'failed');
  assert.deepEqual(snapshot(db),before);
});

test('shared scenes participate in current episode reference image recommendations', async t => {
  const {db} = setup(t);
  episodeScenes.link(db,1,7,2);
  assert.throws(()=>episodeScenes.link(db,1,8,2),/不属于当前剧/);
  assert.throws(()=>episodeScenes.link(db,1,7,90),/不属于当前剧/);
  t.mock.method(ai,'generateText',async(db,log,type,user)=>{
    const input = JSON.parse(user);
    assert.deepEqual(input.resources.map(r=>r.id),[2]);
    return JSON.stringify([{kind:'scene',id:2,reference_image_mode:'quad_grid',reference_image_reason:'跨集重复使用同一房间。'}]);
  });
  assert.equal((await advice.recommendEpisode(db,log,7)).count,1);
  assert.equal(scenes.getSceneById(db,2).local_path,'desk.png');
});
