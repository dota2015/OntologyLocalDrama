const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const migrate = require('../src/db/migrate');
const generationJobActions = require('../src/services/generationJobActions');
const videoBatchService = require('../src/services/videoBatchService');
const ai = require('../src/services/aiConfigService');
const h3NativeService = require('../src/services/h3NativeService');
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

  let extractedTails = [];
  t.mock.method(h3NativeService, 'tailFrame', async (d, dramaId, prevShot) => {
    extractedTails.push(prevShot.id);
    return `images/h3-inputs/tail-shot-${prevShot.id}.png`;
  });

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
  assert.deepEqual(extractedTails, [102], 'tailFrame was extracted from shot 102');

  const payload103 = JSON.parse(items[1].payload);
  assert.ok(payload103.first_frame_url.includes('tail-shot-102.png'), 'Shot 103 received tail frame of 102 as its first frame');

  // Tail inheritance is an execution artifact and must not overwrite Agent-owned storyboard media.
  const sb103 = db.prepare('SELECT image_url, local_path FROM storyboards WHERE id = 103').get();
  assert.equal(sb103.image_url, null);
  assert.equal(sb103.local_path, null);
  const inherited = db.prepare("SELECT local_path FROM image_generations WHERE storyboard_id = 103 AND frame_type = 'inherited_tail_frame'").get();
  assert.ok(inherited.local_path.includes('tail-shot-102.png'), 'Inherited tail was recorded as an execution artifact');
});
