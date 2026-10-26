const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const mode = require('../src/services/referenceImageModeService');
const ai = require('../src/services/aiClient');
const sceneService = require('../src/services/sceneService');
const propService = require('../src/services/propService');
const backgrounds = require('../src/services/backgroundExtractionService');
const propImages = require('../src/services/propImageGenerationService');
const images = require('../src/services/imageClient');
const tasks = require('../src/services/taskService');
const sceneRoutes = require('../src/routes/scenes');
const migrate = require('../src/db/migrate');
const log = {info(){},warn(){},error(){}};
const cfg = {app:{language:'zh'},style:{}};

function setup(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  migrate.runMigrationsAndEnsure(db);
  db.exec(`INSERT INTO dramas (id,title,metadata) VALUES (1,'本剧','{}'),(2,'其他剧','{}');
    INSERT INTO episodes (id,drama_id,episode_number,title,script_content) VALUES (7,1,2,'第二集','王奕宸在训练基地使用任务卡。'),(8,2,1,'其他集','另一个剧本');
    INSERT INTO scenes (id,drama_id,episode_id,location,time,prompt,image_url,local_path,polished_prompt) VALUES (10,1,7,'训练基地','白天','固定训练场空间','/scene.png','scene.png','原有四视图提示词'),(90,2,8,'外剧场景','白天','其他剧',NULL,NULL,NULL);
    INSERT INTO props (id,drama_id,episode_id,name,prompt,image_url,local_path) VALUES (20,1,7,'任务卡','single prop catalog photo','/card.png','card.png'),(90,2,8,'外剧道具','foreign',NULL,NULL);`);
  t.mock.method(tasks, 'updateTaskStatus', () => {});
  t.mock.method(tasks, 'updateTaskError', () => {});
  return db;
}
function response() {
  return {code:200,status(code){this.code=code;return this},json(body){this.body=body;return this}};
}

test('startup migrates legacy resources without changing their images or setting an explicit user choice', t => {
  const db = setup(t);
  for (const table of ['props','scenes']) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    for (const field of ['reference_image_mode','reference_image_recommendation','reference_image_reason']) assert.ok(columns.includes(field));
    assert.equal(db.prepare(`SELECT reference_image_mode FROM ${table} LIMIT 1`).get().reference_image_mode, null);
  }
  assert.equal(sceneService.getSceneById(db,10).local_path,'scene.png');
  assert.equal(propService.getById(db,20).local_path,'card.png');
});

test('per-resource choices persist independently, validate modes and survive unrelated edits', t => {
  const db = setup(t);
  assert.equal(sceneService.updateScene(db,log,10,{reference_image_mode:'quad_grid'}).ok,true);
  propService.update(db,log,20,{reference_image_mode:'single'});
  sceneService.updateScene(db,log,10,{prompt:'编辑后的描述'});
  assert.equal(sceneService.getSceneById(db,10).reference_image_mode,'quad_grid');
  assert.equal(sceneService.listByDramaId(db,1)[0].reference_image_mode,'quad_grid');
  assert.equal(propService.listByDramaId(db,1)[0].reference_image_mode,'single');
  assert.equal(sceneService.updateScene(db,log,10,{reference_image_mode:'invalid'}).ok,false);
  assert.throws(() => propService.update(db,log,20,{reference_image_mode:'invalid'}),/参考图模式/);
  assert.equal(sceneService.getSceneById(db,10).reference_image_mode,'quad_grid');
});

test('AI recommendations apply to unset modes and preserve an explicit user choice and all images', async t => {
  const db = setup(t);
  propService.update(db,log,20,{reference_image_mode:'quad_grid'});
  t.mock.method(ai,'generateText',async (db,log,type,user,system) => {
    const data=JSON.parse(user);
    assert.equal(data.resources.length,2);
    assert.ok(data.resources.every(resource => !Object.hasOwn(resource, 'selected_mode')), 'defaults must not bias the independent AI recommendation');
    assert.doesNotMatch(user,/外剧/);
    assert.match(system,/reference_image_reason/);
    return JSON.stringify([{kind:'scene',id:10,reference_image_mode:'quad_grid',reference_image_reason:'固定基地多次出镜，需要保持空间布局。'},
      {kind:'prop',id:20,reference_image_mode:'single',reference_image_reason:'任务卡需要清晰细节。'}]);
  });
  const result=await mode.recommendEpisode(db,log,7);
  assert.equal(result.count,2);
  assert.equal(sceneService.getSceneById(db,10).reference_image_mode,'quad_grid');
  assert.equal(propService.getById(db,20).reference_image_mode,'quad_grid');
  assert.equal(propService.getById(db,20).reference_image_recommendation,'single');
  assert.equal(sceneService.getSceneById(db,10).local_path,'scene.png');
  assert.equal(propService.getById(db,20).local_path,'card.png');
});

test('invalid, incomplete, duplicate or foreign AI recommendation lists cause no writes', async t => {
  const db=setup(t);
  const valid={kind:'scene',id:10,reference_image_mode:'quad_grid'};
  const before=['scenes','props'].map(table=>db.prepare(`SELECT * FROM ${table}`).all());
  for (const output of [[valid], [valid,valid], [valid,{kind:'prop',id:90,reference_image_mode:'single'}], [valid,{kind:'prop',id:20,reference_image_mode:'bad'}]]) {
    const mock=t.mock.method(ai,'generateText',async()=>JSON.stringify(output));
    await assert.rejects(mode.recommendEpisode(db,log,7),/原有设置未修改/);
    assert.deepEqual(['scenes','props'].map(table=>db.prepare(`SELECT * FROM ${table}`).all()),before);
    mock.mock.restore();
  }
});

test('scene extraction includes mode advice and re-extraction keeps the existing scene/image/user choice', async t => {
  const db=setup(t);
  sceneService.updateScene(db,log,10,{reference_image_mode:'single'});
  t.mock.method(ai,'generateText',async(db,log,type,user,system)=>{
    assert.match(system,/reference_image_mode/);
    return '[{"location":"训练基地","time":"白天","prompt":"固定基地环境","reference_image_mode":"quad_grid","reference_image_reason":"反复出现的空间需要多个角度。"}]';
  });
  let result;
  t.mock.method(tasks,'updateTaskResult',(db,id,value)=>{result=value});
  await backgrounds.processBackgroundExtraction(db,cfg,log,'test',7);
  assert.equal(result.scenes[0].id,10);
  assert.equal(result.scenes[0].reference_image_mode,'single');
  assert.equal(result.scenes[0].reference_image_recommendation,'quad_grid');
  assert.equal(sceneService.getSceneById(db,10).local_path,'scene.png');
  assert.equal(sceneService.getSceneById(db,10).polished_prompt,'原有四视图提示词');
});

test('scene image endpoint dispatches using each saved mode, with explicit legacy override support', async t => {
  const db=setup(t);
  const called=[];
  t.mock.method(sceneService,'generateSceneSingleImage',async()=>{called.push('single');return {ok:true,image_generation:{task_id:'single'}}});
  t.mock.method(sceneService,'generateSceneFourViewImage',async()=>{called.push('quad_grid');return {ok:true,image_generation:{task_id:'quad'}}});
  const routes=sceneRoutes(db,log,cfg);
  sceneService.updateScene(db,log,10,{reference_image_mode:'quad_grid'});
  await routes.generateImage({body:{scene_id:10}},response());
  await routes.generateImage({body:{scene_id:10,use_quad_grid:false}},response());
  sceneService.updateScene(db,log,10,{reference_image_mode:'single'});
  await routes.generateImage({body:{scene_id:10}},response());
  assert.deepEqual(called,['quad_grid','single','single']);
  const res=response();await routes.generateImage({body:{scene_id:10,use_quad_grid:'invalid'}},res);assert.equal(res.code,400);
});

test('prop generation actually sends four-view layout only when the selected mode requires it', async t => {
  const db=setup(t);
  const prompts=[];
  t.mock.method(images,'callImageApi',async(db,log,request)=>{prompts.push(request.prompt);return {error:'stop before creating any image'}});
  propService.update(db,log,20,{reference_image_mode:'quad_grid'});
  await propImages.processPropImageGeneration(db,log,'test',20,{});
  propService.update(db,log,20,{reference_image_mode:'single'});
  await propImages.processPropImageGeneration(db,log,'test',20,{});
  assert.match(prompts[0],/2x2.*SAME prop/);
  assert.match(prompts[0],/front view, left side view, back view, top view/);
  assert.doesNotMatch(prompts[1],/2x2/);
});
