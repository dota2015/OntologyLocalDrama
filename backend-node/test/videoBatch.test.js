const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const path = require('path');
const batches = require('../src/services/videoBatchService');
const ai = require('../src/services/aiConfigService');
const submissions = require('../src/services/videoSubmissionService');
const videos = require('../src/services/videoService');
const videoClient = require('../src/services/videoClient');
const tasks = require('../src/services/taskService');
const routes = require('../src/routes/videos');
const migrate = require('../src/db/migrate');
const log = { info() {}, warn() {}, error() {} };

function setup(t, file = ':memory:') {
  const db = new Database(file);
  t.after(() => { if (db.open) db.close(); });
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  migrate.runMigrationsAndEnsure(db);
  db.exec(`INSERT INTO dramas(id,title) VALUES(1,'测试剧'),(2,'外剧');
    INSERT INTO episodes(id,drama_id,episode_number) VALUES(7,1,2),(8,2,1);
    INSERT INTO storyboards(id,episode_id,storyboard_number,duration,title) VALUES(80,7,7,8,'当前'),(81,7,8,8,'下一镜'),(82,7,9,8,'最后'),(90,8,1,8,'外剧');`);
  t.mock.method(ai, 'listConfigs', () => [{ id:1, is_active:true, is_default:true, provider:'minimax_h3', api_protocol:'minimax_h3', model:['minimax_h3'], default_model:'minimax_h3' }]);
  const body = { drama_id:1, shots:[82,80,81].map(storyboard_id => ({storyboard_id,model:'minimax_h3',prompt:'A boy walks.',first_frame_url:'http://example/first.png',last_frame_url:'http://example/last.png',duration:8})) };
  return {db,body};
}
const flush = () => new Promise(setImmediate);
function finish(db, id, success = true) {
  db.prepare('UPDATE video_generations SET status=?,local_path=?,error_msg=? WHERE id=?').run(success ? 'completed':'failed', success ? `videos/${id}.mp4` : null, success ? null:'模拟上游失败',id);
}

test('batch survives database reopen, attaches an already-running H3, and dispatches each remaining shot exactly once', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'lmd-batch-'));
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  const file = path.join(dir,'queue.db');
  let {db,body} = setup(t,file);
  const existing = submissions.submitVideo(db,log,{...body.shots[1],drama_id:1});
  db.prepare('UPDATE video_generations SET provider_task_id=? WHERE id=?').run('preserve-comfy-prompt-id',existing.id);
  const batch = batches.createBatch(db,log,7,body);
  assert.deepEqual(batch.items.map(i=>i.storyboard_id),[80,81,82]);
  assert.equal(batches.createBatch(db,log,7,body).id,batch.id);
  let calls = [];
  let worker = batches.createWorker(db,log,{process:async (_db,_log,id)=>calls.push(id)});
  await worker.tick(); await worker.tick(); await flush();
  assert.deepEqual(calls,[]);
  assert.equal(batches.latestBatch(db,7).items[0].video_gen_id,existing.id);
  db.close();
  db = new Database(file); t.after(()=>db.close());
  worker = batches.createWorker(db,log,{process:async (_db,_log,id)=>calls.push(id)});
  await worker.tick();
  assert.equal(db.prepare('SELECT provider_task_id FROM video_generations WHERE id=?').get(existing.id).provider_task_id,'preserve-comfy-prompt-id');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM video_generations').get().n,1);
  finish(db,existing.id);
  await Promise.all([worker.tick(),worker.tick()]); await flush();
  assert.equal(calls.length,1);
  assert.equal(db.prepare('SELECT storyboard_id FROM video_generations WHERE id=?').get(calls[0]).storyboard_id,81);
  await worker.tick(); assert.equal(calls.length,1);
  finish(db,calls[0]); await worker.tick(); await flush();
  assert.equal(calls.length,2);
  finish(db,calls[1]); await worker.tick();
  assert.equal(batches.latestBatch(db,7).status,'completed');
  assert.equal(batches.latestBatch(db,7).current,3);
});

test('stop persists and cancels only pending shots; a running shot finishes after worker restart', async t => {
  const {db,body} = setup(t);
  const batch = batches.createBatch(db,log,7,body);
  let count=0;
  const dependencies={process:async()=>{count++;}};
  await batches.createWorker(db,log,dependencies).tick(); await flush();
  const id=batches.latestBatch(db,7).items[0].video_gen_id;
  batches.stopBatch(db,7,batch.id);
  const worker=batches.createWorker(db,log,dependencies);
  await worker.tick(); await flush();
  assert.equal(count,1);
  assert.equal(batches.latestBatch(db,7).status,'stopping');
  finish(db,id); await worker.tick();
  assert.equal(batches.latestBatch(db,7).status,'stopped');
  assert.deepEqual(batches.latestBatch(db,7).items.map(i=>i.status),['completed','cancelled','cancelled']);
});

test('skip completed shots, keep failed errors and continue the rest; retry queues only missing work', async t => {
  const {db,body}=setup(t);
  const old=submissions.submitVideo(db,log,{...body.shots[1],drama_id:1}); finish(db,old.id);
  batches.createBatch(db,log,7,body);
  const calls=[];
  const worker=batches.createWorker(db,log,{process:async(_db,_log,id)=>calls.push(id)});
  await worker.tick(); await worker.tick(); await flush();
  assert.equal(batches.latestBatch(db,7).items[0].status,'skipped');
  finish(db,calls[0],false); await worker.tick(); await flush();
  finish(db,calls[1]); await worker.tick();
  let batch=batches.latestBatch(db,7);
  assert.equal(batch.status,'completed_with_errors');
  assert.equal(batch.failed,1); assert.match(batch.items[1].error,/上游失败/);
  batches.createBatch(db,log,7,body);
  await worker.tick(); await worker.tick(); await flush();
  assert.equal(calls.length,3);
  assert.equal(db.prepare('SELECT storyboard_id FROM video_generations WHERE id=?').get(calls[2]).storyboard_id,81);
});

test('invalid/cross-episode/duplicate batches fail atomically and cannot alter the active queue', t => {
  const {db,body}=setup(t);
  for (const invalid of [ {...body,drama_id:2}, {...body,shots:[{storyboard_id:90}]}, {...body,shots:[body.shots[0],body.shots[0]]} ]) {
    assert.throws(()=>batches.createBatch(db,log,7,invalid));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM video_batches').get().n,0);
  }
  const batch=batches.createBatch(db,log,7,body);
  assert.throws(()=>batches.stopBatch(db,8,batch.id));
  assert.equal(batches.latestBatch(db,7).status,'running');
});

test('deleting a queued shot fails that item without generating it or losing subsequent items', async t => {
  const {db,body}=setup(t);
  batches.createBatch(db,log,7,body);
  db.prepare('UPDATE storyboards SET deleted_at=? WHERE id=80').run(new Date().toISOString());
  let calls=0;
  const worker=batches.createWorker(db,log,{process:async()=>calls++});
  await worker.tick(); await worker.tick(); await flush();
  assert.equal(calls,1);
  assert.equal(batches.latestBatch(db,7).items[0].status,'failed');
  assert.equal(batches.latestBatch(db,7).items[1].status,'running');
});

test('old browsers and second tabs cannot submit duplicates of running or queued shots', async t => {
  const {db,body}=setup(t);
  const current=submissions.submitVideo(db,log,{...body.shots[1],drama_id:1});
  batches.createBatch(db,log,7,body);
  const res=()=>({status(code){this.code=code;return this;},json(body){this.body=body;}});
  const active=res();
  routes(db,log).create({body:{...body.shots[1],drama_id:1}},active);
  assert.equal(active.code,200); assert.equal(active.body.data.id,current.id);
  const queued=res();
  routes(db,log).create({body:{...body.shots[0],drama_id:1}},queued);
  assert.equal(queued.code,400); assert.match(queued.body.error.message,/后台视频队列/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM video_generations').get().n,1);
});

test('startup restores polling for an existing provider prompt and queue never resubmits it', async t => {
  const {db,body}=setup(t);
  const current=submissions.submitVideo(db,log,{...body.shots[1],drama_id:1});
  db.prepare('UPDATE video_generations SET provider_task_id=? WHERE id=?').run('original-comfy-id',current.id);
  batches.createBatch(db,log,7,body);
  tasks.failOrphanedAsyncTasksOnStartup(db,log);
  let release; const polled=[];
  t.mock.method(videoClient,'callVideoApi',()=>assert.fail('Recovered job resubmitted'));
  t.mock.method(videoClient,'pollVideoTask',async (_db,_log,id,providerId)=>{
    polled.push([id,providerId]); return new Promise(resolve=>{release=()=>resolve({error:'Test ends recovery poll'});});
  });
  videos.resumeProcessingVideoGenerations(db,log);
  const worker=batches.createWorker(db,log,{process:async()=>assert.fail('Active task resubmitted')});
  await worker.tick(); await flush();
  assert.deepEqual(polled,[[current.id,'original-comfy-id']]);
  assert.equal(tasks.getTask(db,current.task_id).status,'processing');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM video_generations').get().n,1);
  release(); await flush();
});

test('video heartbeat refreshes activity during long model calls and stops on completion without reviving cancellation', async t => {
  const {db,body}=setup(t);
  const row=submissions.submitVideo(db,log,{...body.shots[1],drama_id:1});
  let heartbeat; let clearCount=0; let release;
  t.mock.method(global,'setInterval',(fn,ms)=>{assert.equal(ms,30000);heartbeat=fn;return {unref(){}};});
  t.mock.method(global,'clearInterval',()=>clearCount++);
  t.mock.method(videoClient,'callVideoApi',async()=>new Promise(resolve=>{release=()=>resolve({error:'Test ends call'});}));
  const pending=videos.processVideoGeneration(db,log,row.id);
  await flush();
  db.prepare("UPDATE async_tasks SET updated_at='2000-01-01T00:00:00Z' WHERE id=?").run(row.task_id);
  heartbeat();
  assert.ok(Date.now()-Date.parse(tasks.getTask(db,row.task_id).updated_at)<1000);
  tasks.cancelTask(db,log,row.task_id); heartbeat();
  assert.equal(tasks.getTask(db,row.task_id).status,'failed');
  release(); await pending;
  assert.equal(clearCount,1);
});

test('mixed-model continuity prepares the previous completed tail on the server and retains the selected last frame', async t => {
  const {db,body}=setup(t);
  const wan='Wan2.2-I2V-A14B-FP8-4steps';
  t.mock.method(ai,'listConfigs',()=>[
    {is_active:true,is_default:true,provider:'minimax_h3',api_protocol:'minimax_h3',model:['minimax_h3']},
    {is_active:true,provider:'comfyui_wan22',api_protocol:'comfyui_wan22',model:[wan]},
  ]);
  body.continuity=true;
  body.shots=body.shots.filter(s=>s.storyboard_id!==82).map(s=>s.storyboard_id===81?{...s,model:wan}:s);
  batches.createBatch(db,log,7,body);
  t.mock.method(require('../src/config'),'loadConfig',()=>({storage:{local_path:'/tmp/no-actual-files',base_url:'http://app/static'}}));
  let tailCalls=0;
  t.mock.method(require('../src/services/h3NativeService'),'tailFrame',async(_db,dramaId,previous)=>{
    tailCalls++; assert.equal(dramaId,1); assert.equal(previous.id,80);
    assert.equal(db.prepare('SELECT status FROM video_batch_items WHERE storyboard_id=80').get().status,'completed');
    return 'projects/test/tail.png';
  });
  const calls=[];
  const worker=batches.createWorker(db,log,{process:async(_db,_log,id)=>calls.push(id)});
  await worker.tick(); await flush();
  await worker.tick(); assert.equal(tailCalls,0);
  finish(db,calls[0]); await worker.tick(); await flush();
  const video=db.prepare('SELECT * FROM video_generations WHERE id=?').get(calls[1]);
  assert.equal(tailCalls,1); assert.equal(video.first_frame_url,'http://app/static/projects/test/tail.png');
  assert.equal(video.last_frame_url,'http://example/last.png');
  assert.deepEqual(JSON.parse(video.reference_image_urls),['http://app/static/projects/test/tail.png','http://example/last.png']);
});
test('a Wan shot with a new outfit retains its own opening frame instead of the previous old outfit', async t => {
  const {db,body}=setup(t);
  const wan='Wan2.2-I2V-A14B-FP8-4steps';
  db.exec("INSERT INTO characters(id,drama_id,name) VALUES(5,1,'王奕宸'); UPDATE storyboards SET characters='[5]' WHERE id IN (80,81);");
  require('../src/services/wardrobeService').saveShot(db,81,{change:{reason:'进入三角洲',characters:[{character_id:5,description:'白色训练服'}]}});
  t.mock.method(ai,'listConfigs',()=>[
    {is_active:true,is_default:true,provider:'minimax_h3',api_protocol:'minimax_h3',model:['minimax_h3']},
    {is_active:true,provider:'comfyui_wan22',api_protocol:'comfyui_wan22',model:[wan]},
  ]);
  body.continuity=true;
  body.shots=body.shots.filter(s=>s.storyboard_id!==82).map(s=>s.storyboard_id===81?{...s,model:wan}:s);
  batches.createBatch(db,log,7,body);
  t.mock.method(require('../src/services/h3NativeService'),'tailFrame',async()=>assert.fail('Old outfit tail must not be reused'));
  const calls=[];
  const worker=batches.createWorker(db,log,{process:async(_db,_log,id)=>calls.push(id)});
  await worker.tick();await flush();finish(db,calls[0]);await worker.tick();await flush();
  assert.equal(calls.length,2);
  const video=db.prepare('SELECT * FROM video_generations WHERE id=?').get(calls[1]);
  assert.equal(video.first_frame_url,'http://example/first.png');
});

test('stopping batch can be force-stopped on second stop invocation', async t => {
  const {db,body} = setup(t);
  const batch = batches.createBatch(db,log,7,body);
  await batches.createWorker(db,log,{process:async()=>{}}).tick(); await flush();
  assert.equal(batches.latestBatch(db,7).status,'running');
  batches.stopBatch(db,7,batch.id);
  assert.equal(batches.latestBatch(db,7).status,'stopping');
  batches.stopBatch(db,7,batch.id);
  assert.equal(batches.latestBatch(db,7).status,'stopped');
  assert.deepEqual(batches.latestBatch(db,7).items.map(i=>i.status),['cancelled','cancelled','cancelled']);
});

test('clearBatch marks finished batch cleared and latestBatch ignores it', t => {
  const { db } = setup(t);
  const batch = batches.createBatch(db, log, 7, { drama_id: 1, continuity: false, shots: [
    { storyboard_id: 80, duration: 4, prompt: 'A' },
  ] });
  batches.stopBatch(db, 7, batch.id);
  batches.stopBatch(db, 7, batch.id);
  assert.equal(batches.latestBatch(db, 7).status, 'stopped');
  batches.clearBatch(db, 7, batch.id);
  assert.equal(batches.latestBatch(db, 7), null);
});
