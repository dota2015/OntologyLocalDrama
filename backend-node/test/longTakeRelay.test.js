const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const migrate = require('../src/db/migrate');
const generationJobActions = require('../src/services/generationJobActions');
const videoBatchService = require('../src/services/videoBatchService');
const ai = require('../src/services/aiConfigService');
const { previousStoryboard } = require('../src/services/h3ModeResolver');
const log = { info() {}, warn() {}, error() {} };

function agentPlan(firstFramePolicy) {
  return JSON.stringify({
    h3_mode: 'fl2va',
    h3_mode_reason: firstFramePolicy === 'inherit_tail'
      ? '长镜头接力必须承接上镜真实尾帧'
      : '独立起幅需要新生成首帧锁定构图',
    first_frame_policy: firstFramePolicy,
    first_frame_reason: firstFramePolicy === 'inherit_tail'
      ? '通过 ffmpeg 提取上镜真实尾帧作为本镜首帧'
      : '由 Qwen-Image 生成本镜独立首帧',
    last_frame_policy: 'none',
    last_frame_reason: '让动作自然收束，下镜直接继承生成视频的真实尾帧',
    required_references: [],
    speech_plan: { audio_references: [] },
  });
}

function setupDb(t) {
  const db = new Database(':memory:');
  t.after(() => { if (db.open) db.close(); });
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  migrate.runMigrationsAndEnsure(db);

  db.exec(`
    INSERT INTO dramas(id, title) VALUES (1, '长镜头测试剧');
    INSERT INTO episodes(id, drama_id, episode_number) VALUES (10, 1, 1);
    -- 镜头1: 独立镜头
    INSERT INTO storyboards(id, episode_id, storyboard_number, duration, title, long_take_group_id, long_take_role, long_take_sequence)
      VALUES (101, 10, 1, 5, '镜头1', NULL, NULL, NULL);
    -- 镜头2~4: 同一个长镜头组 ltg_1
    INSERT INTO storyboards(id, episode_id, storyboard_number, duration, title, long_take_group_id, long_take_role, long_take_sequence)
      VALUES (102, 10, 2, 5, '长镜2_起始', 'ltg_1', 'head', 1);
    INSERT INTO storyboards(id, episode_id, storyboard_number, duration, title, long_take_group_id, long_take_role, long_take_sequence)
      VALUES (103, 10, 3, 5, '长镜3_续镜', 'ltg_1', 'continuation', 2);
    INSERT INTO storyboards(id, episode_id, storyboard_number, duration, title, long_take_group_id, long_take_role, long_take_sequence)
      VALUES (104, 10, 4, 5, '长镜4_收束', 'ltg_1', 'tail', 3);
  `);
  const savePlan = db.prepare('UPDATE storyboards SET semantic_slots=? WHERE id=?');
  savePlan.run(agentPlan('generate_new'), 101);
  savePlan.run(agentPlan('generate_new'), 102);
  savePlan.run(agentPlan('inherit_tail'), 103);
  savePlan.run(agentPlan('inherit_tail'), 104);
  return db;
}

test('imagePlan skips continuation and tail shots in long take group during batch image generation', async (t) => {
  const db = setupDb(t);
  const executor = generationJobActions.createExecutor(db, {}, log, {});
  const job = { id: 'job_img_1', drama_id: 1, episode_id: 10, kind: 'storyboard_images' };
  const options = { use_first_last: false };

  const res = await executor.execute(job, { action: 'expand_images' }, options, {}, () => {});
  const plannedSbIds = res.steps.filter(s => s.action === 'image').map(s => s.payload.storyboard_id);
  assert.deepEqual(plannedSbIds, [101, 102], 'Only independent shot 101 and head shot 102 generate images; continuation shots 103 and 104 are skipped');
});

test('video batch serializes long take group and prepares predecessor tail frame for continuation shots', async (t) => {
  const db = setupDb(t);
  t.mock.method(ai, 'listConfigs', () => [{ id:1, is_active:true, is_default:true, provider:'minimax_h3', api_protocol:'minimax_h3', model:['minimax_h3'], default_model:'minimax_h3' }]);

  const videos = require('../src/services/videoService');
  t.mock.method(videos, 'processVideoGeneration', async () => {});

  // This immediately preceding shot is outside the continuation group.
  db.exec('UPDATE storyboards SET storyboard_number=13 WHERE id=103; UPDATE storyboards SET storyboard_number=14 WHERE id=104; UPDATE storyboards SET storyboard_number=12 WHERE id=101');
  const relay = db.prepare('SELECT * FROM storyboards WHERE id=103').get();
  assert.equal(previousStoryboard(db, relay).id, 102);

  const body = {
    drama_id: 1,
    continuity: false, // global continuity is OFF, but long take group MUST still be serial!
    shots: [
      { storyboard_id: 102, model: 'minimax_h3', prompt: 'Shot 2 head', first_frame_url: 'http://example/s2.png', duration: 5 },
      { storyboard_id: 103, model: 'minimax_h3', prompt: 'Shot 3 continuation', first_frame_url: '', duration: 5 },
      { storyboard_id: 104, model: 'minimax_h3', prompt: 'Shot 4 tail', first_frame_url: '', duration: 5 },
    ]
  };

  const batch = videoBatchService.createBatch(db, log, 10, body);
  const worker = videoBatchService.createWorker(db, log);

  // 1. First tick: only Shot 102 (head) should be dispatched to running!
  await worker.tick();
  let items = db.prepare('SELECT storyboard_id, status FROM video_batch_items WHERE batch_id = ? ORDER BY position').all(batch.id);
  assert.equal(items[0].status, 'running', 'Shot 102 is running');
  assert.equal(items[1].status, 'pending', 'Shot 103 is pending (must wait for 102)');
  assert.equal(items[2].status, 'pending', 'Shot 104 is pending (must wait for 103)');

  // 2. Second tick while 102 is running: 103 still pending!
  await worker.tick();
  items = db.prepare('SELECT storyboard_id, status FROM video_batch_items WHERE batch_id = ? ORDER BY position').all(batch.id);
  assert.equal(items[1].status, 'pending', 'Shot 103 is still pending while 102 is running');

  // 3. Mark 102 as completed
  const vg102 = db.prepare('SELECT id FROM video_generations WHERE storyboard_id = 102').get();
  db.prepare("UPDATE video_generations SET status = 'completed', local_path = 'videos/v102.mp4' WHERE id = ?").run(vg102.id);
  db.prepare("UPDATE video_batch_items SET status = 'completed' WHERE storyboard_id = 102").run();

  // 4. Next tick: Shot 103 is dispatched, and tailFrame is extracted from 102!
  await worker.tick();
  items = db.prepare('SELECT storyboard_id, status, payload FROM video_batch_items WHERE batch_id = ? ORDER BY position').all(batch.id);
  assert.equal(items[1].status, 'running', 'Shot 103 is now running after 102 completed');
  const plan = JSON.parse(items[1].payload).resolution_plan;
  assert.equal(plan.first_frame_policy, 'inherit_tail');
  assert.equal(db.prepare("SELECT count(*) AS n FROM image_generations WHERE storyboard_id=103").get().n, 0);
});

test('batch and canvas pass the same manual inheritance policy to H3 for a universal shot', async t => {
  const db = setupDb(t);
  const config = { is_active:true, is_default:true, provider:'minimax_h3', api_protocol:'minimax_h3', model:['minimax_h3'] };
  t.mock.method(ai, 'listConfigs', () => [config]);
  db.prepare("UPDATE storyboards SET creation_mode='universal',semantic_slots=? WHERE id=103").run(agentPlan('generate_new'));
  db.prepare('UPDATE dramas SET metadata=? WHERE id=1').run(JSON.stringify({
    h3_shots: { 103: { engine_mode: 'fl2va', first_frame_policy: 'inherit_tail' } },
  }));
  const job = {id:'manual-policy', drama_id:1, episode_id:10};
  const calls = [];
  t.mock.method(require('../src/services/videoService'), 'processVideoGeneration', async (_db, _log, id) => calls.push(id));
  await generationJobActions.createExecutor(db, {}, log, {}).execute(job, { action:'video' }, {}, {storyboard_id:103}, () => {});
  await new Promise(setImmediate);
  db.prepare("UPDATE video_generations SET status='failed' WHERE id=?").run(calls[0]);
  videoBatchService.createBatch(db, log, 10, {drama_id:1, shots:[{storyboard_id:103,universal:true}]});
  await videoBatchService.createWorker(db, log).tick();
  await new Promise(setImmediate);
  assert.equal(calls.length, 2);
  for (const id of calls) {
    const row = db.prepare('SELECT resolution_plan FROM video_generations WHERE id=?').get(id);
    const plan = JSON.parse(row.resolution_plan);
    assert.equal(plan.mode, 'fl2va');
    assert.equal(plan.first_frame_policy, 'inherit_tail');
    assert.equal(plan.agent_first_frame_policy, 'generate_new');
  }
});
