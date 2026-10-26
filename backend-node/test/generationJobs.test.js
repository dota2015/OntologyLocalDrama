const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('fs'), os = require('os'), path = require('path');
const jobs = require('../src/services/generationJobService');
const {createExecutor} = require('../src/services/generationJobActions');
const tasks = require('../src/services/taskService');
const log={info(){},warn(){},error(){}};
function setup(t,filename=':memory:') {
  const db=new Database(filename);
  t.after(()=>{if(db.open)db.close()});
  t.mock.method(console,'log',()=>{});t.mock.method(console,'warn',()=>{});
  require('../src/db/migrate').runMigrationsAndEnsure(db);
  db.exec(`INSERT INTO dramas(id,title) VALUES(1,'本剧'),(2,'外剧');
    INSERT INTO episodes(id,drama_id,episode_number,script_content) VALUES(7,1,1,'本集剧本'),(8,2,1,'外剧');
    INSERT INTO storyboards(id,episode_id,storyboard_number,duration,description) VALUES(80,7,1,5,'first shot'),(81,7,2,5,'second shot'),(90,8,1,5,'foreign');
    INSERT INTO frame_prompts(storyboard_id,frame_type,prompt) VALUES(80,'first','first prompt'),(80,'last','last prompt'),(81,'first','first prompt'),(81,'last','last prompt');`);
  return db;
}
function finishFrame(db,id,slot,taskId) {
  const image=require('../src/services/imageService').upload(db,log,{storyboard_id:id,drama_id:1,frame_type:'storyboard_'+slot,image_url:`/static/${id}-${slot}.png`,local_path:`${id}-${slot}.png`});
  if(taskId)tasks.updateTaskResult(db,taskId,{image_generation_id:image.id});
  return image;
}
async function drive(worker,count=16){for(let n=0;n<count;n++)await worker.tick()}

test('whole frame plan survives database reopen and two simultaneous observers never dispatch a duplicate',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lmd-jobs-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const filename=path.join(dir,'queue.db');let db=setup(t,filename);
  const body={kind:'storyboard_images',episode_id:7,options:{use_first_last:true,storyboard_ids:[80,81]}};
  const job=jobs.create(db,log,1,body);
  assert.equal(jobs.create(db,log,1,body).id,job.id,'lost POST reply is safe to retry');
  const calls=[];
  t.mock.method(require('../src/services/imageService'),'create',(database,logger,body)=>{
    calls.push(body);const task=tasks.createTask(database,logger,'image_generation','1');return {task_id:task.id};
  });
  let worker=jobs.createWorker(db,log,createExecutor(db,{},log));
  await drive(worker,3); // expand; prompt skip; first submitted
  assert.equal(calls.length,1);
  const child=jobs.get(db,job.id).items.find(i=>i.status==='running').child_id;
  db.close();db=new Database(filename);t.after(()=>{if(db.open)db.close()});
  worker=jobs.createWorker(db,log,createExecutor(db,{},log));worker.recover();
  await Promise.all([worker.tick(),worker.tick()]);
  assert.equal(calls.length,1,'existing backend task is observed, not resubmitted');
  finishFrame(db,80,'first',child);
  await drive(worker,2);
  assert.equal(calls.length,2);
  assert.equal(calls[1].frame_type,'storyboard_last');
  assert.deepEqual(calls[1].reference_images,['/static/80-first.png']);
  const next=jobs.get(db,job.id).items.find(i=>i.status==='running').child_id;
  finishFrame(db,80,'last',next);
  await drive(worker,3);
  assert.equal(calls.length,3,'second shot starts without any browser');
});

test('only missing tails are submitted and a repeated batch preserves existing firsts',async t=>{
  const db=setup(t);finishFrame(db,80,'first');finishFrame(db,81,'first');
  const calls=[];
  t.mock.method(require('../src/services/imageService'),'create',(db,log,body)=>{calls.push(body);const task=tasks.createTask(db,log,'image_generation','1');finishFrame(db,body.storyboard_id,'last',task.id);return {task_id:task.id}});
  const options={use_first_last:true};
  const one=jobs.create(db,log,1,{kind:'storyboard_images',episode_id:7,options});
  const worker=jobs.createWorker(db,log,createExecutor(db,{},log));await drive(worker);
  assert.equal(jobs.get(db,one.id).status,'completed');
  assert.deepEqual(calls.map(c=>c.frame_type),['storyboard_last','storyboard_last']);
  jobs.create(db,log,1,{kind:'storyboard_images',episode_id:7,options});await drive(worker);
  assert.equal(calls.length,2);
});

test('failed firsts block their tails, independent shots still proceed, failures survive refresh',async t=>{
  const db=setup(t), calls=[];
  t.mock.method(require('../src/services/imageService'),'create',(db,log,body)=>{calls.push(body);const task=tasks.createTask(db,log,'image_generation','1');tasks.updateTaskError(db,task.id,'上游显存不足');return {task_id:task.id}});
  const job=jobs.create(db,log,1,{kind:'storyboard_images',episode_id:7,options:{use_first_last:true}});
  await drive(jobs.createWorker(db,log,createExecutor(db,{},log)));
  assert.equal(calls.length,2);assert.ok(calls.every(c=>c.frame_type==='storyboard_first'));
  const state=jobs.get(db,job.id);assert.equal(state.status,'completed_with_errors');assert.ok(state.items.some(i=>/首帧尚未成功/.test(i.error)));
});

test('pause, resume and stop preserve the running child and cancel unsent tail and subsequent shots',async t=>{
  const db=setup(t), calls=[];
  t.mock.method(require('../src/services/imageService'),'create',(db,log,body)=>{calls.push(body);return {task_id:tasks.createTask(db,log,'image_generation','1').id}});
  const job=jobs.create(db,log,1,{kind:'storyboard_images',episode_id:7,options:{use_first_last:true}});
  const worker=jobs.createWorker(db,log,createExecutor(db,{},log));await drive(worker,3);
  jobs.control(db,1,job.id,'pause');
  const child=jobs.get(db,job.id).items.find(i=>i.status==='running').child_id;finishFrame(db,80,'first',child);
  await drive(worker,3);assert.equal(calls.length,1);assert.equal(jobs.get(db,job.id).status,'paused');
  jobs.control(db,1,job.id,'resume');await worker.tick();
  jobs.control(db,1,job.id,'stop');await drive(worker,3);
  assert.equal(calls.length,1);assert.equal(jobs.get(db,job.id).status,'stopped');
});

test('stop while expanding a plan cannot enqueue its discovered work',async t=>{
  const db=setup(t);const job=jobs.create(db,log,1,{kind:'storyboard_images',episode_id:7});
  let release;const waiting=new Promise(resolve=>release=resolve);
  const worker=jobs.createWorker(db,log,{observe:async()=>({}),execute:async()=>{await waiting;return {steps:[jobs.step('image','must not run')]}}});
  const running=worker.tick();jobs.control(db,1,job.id,'stop');release();await running;await worker.tick();
  assert.equal(jobs.get(db,job.id).items.length,1);assert.equal(jobs.get(db,job.id).status,'stopped');
});

test('cross-project IDs, invalid workflow and conflicting jobs are rejected without creating partial plans',t=>{
  const db=setup(t);
  assert.throws(()=>jobs.create(db,log,1,{kind:'storyboard_images',episode_id:8}),/不属于/);
  assert.throws(()=>jobs.create(db,log,1,{kind:'canvas_workflow',options:{storyboard_ids:[90]}}),/不属于/);
  assert.throws(()=>jobs.create(db,log,1,{kind:'canvas_workflow',options:{storyboard_ids:[80],pipeline:['delete']}}),/无效/);
  const one=jobs.create(db,log,1,{kind:'reference_images',episode_id:7});
  assert.throws(()=>jobs.create(db,log,1,{kind:'pipeline',episode_id:7}),/已有后台任务/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM generation_jobs').get().n,1);
  assert.throws(()=>jobs.control(db,2,one.id,'stop'),/不存在/);
});

test('a failed pipeline prerequisite cancels later stages and never submits video or merge',async t=>{
  const db=setup(t);const job=jobs.create(db,log,1,{kind:'pipeline',episode_id:7});const calls=[];
  const worker=jobs.createWorker(db,log,{observe:async()=>({}),execute:async(job,item)=>{calls.push(item.action);throw new Error('角色提取失败')}});
  await drive(worker,6);assert.deepEqual(calls,['extract']);assert.equal(jobs.get(db,job.id).status,'failed');
  assert.ok(jobs.get(db,job.id).items.slice(1).every(i=>i.status==='cancelled'));
});

test('restart with an unlinked in-flight model call reports interruption without automatic paid retries',async t=>{
  const db=setup(t);const job=jobs.create(db,log,1,{kind:'storyboard_images',episode_id:7});
  db.prepare("UPDATE generation_job_items SET status='running' WHERE job_id=?").run(job.id);
  let calls=0;const worker=jobs.createWorker(db,log,{execute:async()=>{calls++},observe:async()=>({})});worker.recover();await drive(worker,2);
  assert.equal(calls,0);assert.equal(jobs.get(db,job.id).status,'completed_with_errors');assert.match(jobs.get(db,job.id).items[0].error,/未自动重复提交/);
});

test('reference batch uses only this episode, adopts a submitted resource task and retains four-view choices',async t=>{
  const db=setup(t);
  db.exec(`INSERT INTO characters(id,drama_id,name,polished_prompt) VALUES(10,1,'本集','prompt'),(11,1,'他集','prompt');
    INSERT INTO episode_characters(episode_id,character_id) VALUES(7,10);
    INSERT INTO scenes(id,drama_id,episode_id,location,reference_image_mode) VALUES(20,1,7,'房间','quad_grid');`);
  const existing=tasks.createTask(db,log,'image_generation','character_10');
  const sceneCalls=[];
  t.mock.method(require('../src/services/sceneService'),'generateSceneFourViewImage',async()=>{sceneCalls.push('quad_grid');return {ok:true,image_generation:{task_id:tasks.createTask(db,log,'image_generation','scene_20').id}}});
  const job=jobs.create(db,log,1,{kind:'reference_images',episode_id:7});const worker=jobs.createWorker(db,log,createExecutor(db,{storage:{}},log));await drive(worker,2);
  assert.equal(jobs.get(db,job.id).items.find(i=>i.status==='running').child_id,existing.id);
  tasks.updateTaskResult(db,existing.id,{});db.prepare("UPDATE characters SET image_url='/static/character.png' WHERE id=10").run();
  await worker.tick();assert.deepEqual(sceneCalls,['quad_grid']);
  assert.equal(jobs.get(db,job.id).items.some(i=>i.label.includes('他集')),false);
});

test('one-click pipeline runs through frame preparation, videos and final merge without a browser dispatcher',async t=>{
  const db=setup(t), calls=[];
  db.exec(`INSERT INTO characters(id,drama_id,name,image_url) VALUES(10,1,'人物','/static/character.png');
    INSERT INTO episode_characters(episode_id,character_id) VALUES(7,10);
    INSERT INTO scenes(id,drama_id,episode_id,location,image_url) VALUES(20,1,7,'房间','/static/scene.png');
    INSERT INTO props(id,drama_id,episode_id,name,image_url) VALUES(30,1,7,'笔','/static/prop.png');
    UPDATE storyboards SET video_prompt='A boy sits at a desk.';`);
  t.mock.method(require('../src/services/aiConfigService'),'listConfigs',()=>[{id:1,is_active:true,is_default:true,provider:'minimax_h3',api_protocol:'minimax_h3',model:['minimax_h3'],default_model:'minimax_h3'}]);
  t.mock.method(require('../src/services/imageService'),'create',(db,log,body)=>{
    calls.push(body.frame_type);const task=tasks.createTask(db,log,'image_generation','1');finishFrame(db,body.storyboard_id,body.frame_type==='storyboard_last'?'last':'first',task.id);return {task_id:task.id};
  });
  t.mock.method(require('../src/services/videoService'),'processVideoGeneration',async(db,log,id)=>{
    calls.push('video');const row=db.prepare('SELECT task_id FROM video_generations WHERE id=?').get(id);
    db.prepare("UPDATE video_generations SET status='completed',local_path=? WHERE id=?").run('videos/test.mp4',id);tasks.updateTaskResult(db,row.task_id,{});
  });
  t.mock.method(require('../src/services/dramaService'),'finalizeEpisode',(db,log,eid,base,options)=>{
    assert.equal(eid,7);assert.equal(db.prepare("SELECT COUNT(*) n FROM video_generations WHERE status='completed'").get().n,2);
    calls.push('merge');const task=tasks.createTask(db,log,'video_merge','7');tasks.updateTaskResult(db,task.id,{});return {task_id:task.id};
  });
  const job=jobs.create(db,log,1,{kind:'pipeline',episode_id:7,options:{use_first_last:true}});
  const worker=jobs.createWorker(db,log,createExecutor(db,{storage:{}},log));
  for(let n=0;n<60 && jobs.get(db,job.id).status==='running';n++) {
    jobs.control(db,1,job.id,'skip_wait');await worker.tick();await new Promise(setImmediate);
  }
  assert.equal(jobs.get(db,job.id).status,'completed',JSON.stringify(jobs.get(db,job.id).items.filter(i=>i.error)));
  assert.deepEqual(calls,['storyboard_first','storyboard_last','storyboard_first','storyboard_last','video','video','merge']);
});

test('HTTP submission acknowledges a persisted plan; a new client recovers it without the original page',async t=>{
  const db=setup(t);const express=require('express');const app=express();app.use(express.json());
  app.use('/api/v1',require('../src/routes').setupRouter({storage:{},style:{}},db,log));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}));
  const base=`http://127.0.0.1:${server.address().port}/api/v1/dramas/1/generation-jobs`;
  const response=await fetch(base,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'storyboard_images',episode_id:7,options:{use_first_last:true}})});
  const accepted=await response.json();assert.equal(response.status,200);assert.ok(db.prepare('SELECT id FROM generation_jobs WHERE id=?').get(accepted.data.id));
  const recovered=await (await fetch(base)).json();assert.equal(recovered.data[0].id,accepted.data.id);
  const stopped=await (await fetch(base+'/'+accepted.data.id+'/stop',{method:'POST'})).json();assert.equal(stopped.data.status,'stopping');
});

test('canvas audio preserves dialogue-only semantics and skips a shot containing only narration',async t=>{
  const db=setup(t);db.exec("UPDATE storyboards SET narration='只有旁白' WHERE id=80");
  const executor=createExecutor(db,{storage:{local_path:'/tmp'}},log),job={drama_id:1,episode_id:7};
  let request,child;
  t.mock.method(require('../src/services/dialogueDubbingService'),'startBatch',(db,log,id,body)=>{request=body;return {id:'voice-task'}});
  const skipped=await executor.execute(job,{action:'audio'},{},{storyboard_id:80},()=>assert.fail('narration should not dispatch dialogue'));
  assert.equal(skipped.skipped,true);assert.equal(request,undefined);
  db.exec(`UPDATE storyboards SET dialogue='人物：你好' WHERE id=80`);
  await executor.execute(job,{action:'audio'},{},{storyboard_id:80},(type,id)=>child={type,id});
  assert.equal(request.tts_kind,'dialogue');assert.deepEqual(request.storyboard_ids,[80]);assert.deepEqual(child,{type:'task',id:'voice-task'});
});

test('multiple shot image jobs queue behind an active job and execute sequentially', async t => {
  const db = setup(t);
  const calls = [];
  t.mock.method(require('../src/services/imageService'), 'create', (db, log, body) => {
    calls.push(body);
    return { task_id: tasks.createTask(db, log, 'image_generation', '1').id };
  });
  const job1 = jobs.create(db, log, 1, { kind: 'storyboard_images', episode_id: 7, options: { storyboard_ids: [80], slots: ['first'] } });
  assert.equal(job1.status, 'running');
  const job2 = jobs.create(db, log, 1, { kind: 'storyboard_images', episode_id: 7, options: { storyboard_ids: [80], slots: ['last'] } });
  assert.equal(job2.status, 'queued');

  const worker = jobs.createWorker(db, log, createExecutor(db, {}, log));
  await drive(worker, 3);
  const child1 = jobs.get(db, job1.id).items.find(i => i.status === 'running')?.child_id;
  assert.ok(child1);
  finishFrame(db, 80, 'first', child1);
  await drive(worker, 3);
  assert.equal(jobs.get(db, job1.id).status, 'completed');

  // Job 2 promoted to running
  await worker.tick();
  assert.equal(jobs.get(db, job2.id).status, 'running');
  await drive(worker, 3);
  const child2 = jobs.get(db, job2.id).items.find(i => i.status === 'running')?.child_id;
  assert.ok(child2);
  finishFrame(db, 80, 'last', child2);
  await drive(worker, 3);
  assert.equal(jobs.get(db, job2.id).status, 'completed');
  assert.equal(calls.length, 2);
});
