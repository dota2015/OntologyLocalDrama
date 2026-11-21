const { usableVideo, shotRevision } = require('./videoAcceptance');
const { randomUUID } = require('crypto');
const { previousStoryboard, resolveH3SubmissionPlan } = require('./h3ModeResolver');
const videoService = require('./videoService');
const submission = require('./videoSubmissionService');
const { resolveStoryboardModel } = require('./storyboardVideoModelService');
const { validateVideoSpeech } = require('./videoSpeechService');
const videoClient = require('./videoClient');

function getBatch(db, id) {
  const batch = db.prepare('SELECT * FROM video_batches WHERE id=?').get(id);
  if (!batch) return null;
  const items = db.prepare(`SELECT i.id,i.storyboard_id,s.storyboard_number,i.status,i.video_gen_id,i.error
    FROM video_batch_items i LEFT JOIN storyboards s ON s.id=i.storyboard_id WHERE batch_id=? ORDER BY position`).all(id);
  return { ...batch, items, total: items.length,
    current: items.filter(i => ['completed', 'failed', 'skipped', 'cancelled'].includes(i.status)).length,
    failed: items.filter(i => i.status === 'failed').length };
}
function latestBatch(db, episodeId) {
  const row = db.prepare("SELECT id FROM video_batches WHERE episode_id=? AND status NOT IN ('cleared', 'dismissed') ORDER BY created_at DESC,rowid DESC LIMIT 1").get(Number(episodeId));
  return row ? getBatch(db, row.id) : null;
}

function createBatch(db, log, episodeId, body) {
  const episode = db.prepare('SELECT * FROM episodes WHERE id=? AND deleted_at IS NULL').get(Number(episodeId));
  if (!episode || Number(body.drama_id) !== episode.drama_id) throw new Error('分集不属于当前项目或已删除');
  const active = db.prepare("SELECT id FROM video_batches WHERE episode_id=? AND status IN ('running','stopping')").get(episode.id);
  if (active) return getBatch(db, active.id);
  if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='generation_jobs'").get()
    && db.prepare("SELECT id FROM generation_jobs WHERE drama_id=? AND (episode_id=? OR episode_id IS NULL) AND status IN ('running','paused','stopping')").get(episode.drama_id, episode.id))
    throw new Error('本集已有后台生成流程，请等待完成或先停止，避免重复生成');
  if (!Array.isArray(body.shots) || !body.shots.length || body.shots.length > 300) throw new Error('请选择 1～300 个分镜');
  const ids = new Set();
  const shots = body.shots.map(input => {
    const shot = db.prepare('SELECT * FROM storyboards WHERE id=? AND episode_id=? AND deleted_at IS NULL').get(Number(input.storyboard_id), episode.id);
    if (!shot || ids.has(shot.id)) throw new Error('分镜重复、不属于当前集或已删除');
    ids.add(shot.id);
    // Use the same model/speech validation as individual generation, before persisting anything.
    const requested = { ...input, drama_id: episode.drama_id, storyboard_id: shot.id };
    const selected = resolveStoryboardModel(db, requested);
    requested.model = selected.model;
    const timing = validateVideoSpeech(db, requested, selected.config);
    if (timing.error) throw new Error(timing.error);

    // 编译 Agent 完整 H3 方案并叠加人工覆盖；执行层不再按素材反向猜模式。
    const plan = resolveH3SubmissionPlan(db, episode.drama_id, shot, input);
    requested.resolution_plan = plan;

    if (plan.requires_first_frame && plan.first_frame_policy !== 'inherit_tail') {
      requested.first_frame_url ||= (!input.universal && input.image_url) || shot.local_path || shot.image_url;
      if (!requested.first_frame_url) throw new Error(`分镜 #${shot.storyboard_number} 缺少首帧图片，请先生成或上传首帧`);
    }

    return { shot, requested, plan };
  }).sort((a, b) => a.shot.storyboard_number - b.shot.storyboard_number || a.shot.id - b.shot.id);
  const requiresOrderedContinuity = shots.some(({ shot, plan }) =>
    plan.first_frame_policy === 'inherit_tail'
    || shot.long_take_role === 'continuation'
    || shot.long_take_role === 'tail'
    || (shot.long_take_sequence != null && Number(shot.long_take_sequence) > 1)
  );
  const id = randomUUID();
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare('INSERT INTO video_batches(id,episode_id,drama_id,continuity,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run(id, episode.id, episode.drama_id, requiresOrderedContinuity ? 1 : 0, now, now);
    shots.forEach(({ shot, requested }, position) => db.prepare('INSERT INTO video_batch_items(batch_id,storyboard_id,position,payload) VALUES(?,?,?,?)')
      .run(id, shot.id, position, JSON.stringify(requested)));
  })();
  log.info('Persistent video batch created', { batch_id: id, episode_id: episode.id, count: shots.length });
  return getBatch(db, id);
}

function stopBatch(db, episodeId, batchId) {
  if (!batchId) throw new Error('缺少批量任务 ID');
  const batch = db.prepare('SELECT * FROM video_batches WHERE id=? AND episode_id=?').get(batchId, Number(episodeId));
  if (!batch) throw new Error('批量任务不存在');
  db.transaction(() => {
    if (batch.status === 'stopping') {
      // 再次点击强制停止：取消正在运行的项目并立即置为 stopped
      db.prepare("UPDATE video_batch_items SET status='cancelled' WHERE batch_id=? AND status IN ('pending','running')").run(batch.id);
      db.prepare("UPDATE video_batches SET status='stopped',updated_at=? WHERE id=?").run(new Date().toISOString(), batch.id);
    } else {
      db.prepare("UPDATE video_batch_items SET status='cancelled' WHERE batch_id=? AND status='pending'").run(batch.id);
      const remaining = db.prepare("SELECT COUNT(*) AS n FROM video_batch_items WHERE batch_id=? AND status IN ('pending','running')").get(batch.id).n;
      const nextStatus = remaining === 0 ? 'stopped' : 'stopping';
      db.prepare("UPDATE video_batches SET status=?,updated_at=? WHERE id=? AND status='running'").run(nextStatus, new Date().toISOString(), batch.id);
    }
  })();
  return getBatch(db, batch.id);
}

function clearBatch(db, episodeId, batchId) {
  const where = batchId ? 'id=?' : '1=1';
  const params = batchId ? [Number(episodeId), batchId] : [Number(episodeId)];
  db.prepare(`UPDATE video_batches SET status='cleared',updated_at=? WHERE episode_id=? AND status NOT IN ('running','stopping') AND ${where}`)
    .run(new Date().toISOString(), ...params);
  return { ok: true };
}

// Only one dispatcher per process. Persisted video IDs are attached, never re-submitted on refresh/restart.
function createWorker(db, log, dependencies = {}) {
  const submit = dependencies.submit || submission.submitVideo;
  const process = dependencies.process || videoService.processVideoGeneration;
  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const batches = db.prepare("SELECT * FROM video_batches WHERE status IN ('running','stopping') ORDER BY created_at,rowid").all();
      for (const batch of batches) {
        const running = db.prepare("SELECT * FROM video_batch_items WHERE batch_id=? AND status='running'").all(batch.id);
        for (const item of running) {
          const video = db.prepare('SELECT * FROM video_generations WHERE id=? AND deleted_at IS NULL').get(item.video_gen_id);
          if (video?.status === 'processing') continue;
          const shot = db.prepare('SELECT * FROM storyboards WHERE id=? AND deleted_at IS NULL').get(item.storyboard_id);
          const ok = shot && video?.status === 'completed' && video.shot_revision === shotRevision(db, shot) && (video.local_path || videoClient.isPlausibleHttpVideoUrl(video.video_url));
          db.prepare('UPDATE video_batch_items SET status=?,error=? WHERE id=?').run(ok ? 'completed' : 'failed', ok ? null : (video?.error_msg || '视频任务不存在或生成失败'), item.id);
        }
        const remaining = db.prepare("SELECT COUNT(*) AS n FROM video_batch_items WHERE batch_id=? AND status IN ('pending','running')").get(batch.id).n;
        if (!remaining) {
          const failed = db.prepare("SELECT COUNT(*) AS n FROM video_batch_items WHERE batch_id=? AND status='failed'").get(batch.id).n;
          db.prepare('UPDATE video_batches SET status=?,updated_at=? WHERE id=?').run(batch.status === 'stopping' ? 'stopped' : failed ? 'completed_with_errors' : 'completed', new Date().toISOString(), batch.id);
        }
      }
      // H3 is intentionally serial.  Multiple ComfyUI instances are kept as
      // failover/queue targets, but running more than one long H3 generation
      // at once causes VRAM pressure and breaks temporal continuity.
      const maxConcurrency = 1;
      const runningCount = db.prepare("SELECT COUNT(*) AS n FROM video_batch_items WHERE status='running'").get()?.n || 0;
      if (runningCount >= maxConcurrency) return;

      // When continuity is enabled, previous shot must finish before next shot dispatches so tail frame is available.
      // When continuity is disabled, independent shots can dispatch up to maxConcurrency.
      const item = db.prepare(`
        SELECT i.*, b.drama_id, b.continuity
        FROM video_batch_items i
        JOIN video_batches b ON b.id = i.batch_id
        LEFT JOIN storyboards s ON s.id = i.storyboard_id
        WHERE b.status = 'running' AND i.status = 'pending'
          AND (
            b.continuity = 0
            OR (
              NOT EXISTS (
                SELECT 1 FROM video_batch_items r WHERE r.batch_id = b.id AND r.status = 'running'
              )
              AND NOT EXISTS (
                SELECT 1 FROM video_batch_items p WHERE p.batch_id = b.id AND p.status = 'pending' AND p.position < i.position
              )
            )
          )
          AND (
            s.long_take_group_id IS NULL
            OR (
              NOT EXISTS (
                SELECT 1 FROM video_batch_items r2
                JOIN storyboards s2 ON s2.id = r2.storyboard_id
                WHERE r2.batch_id = b.id AND r2.status = 'running'
                  AND s2.long_take_group_id = s.long_take_group_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM video_batch_items p2
                JOIN storyboards s3 ON s3.id = p2.storyboard_id
                WHERE p2.batch_id = b.id AND p2.status = 'pending'
                  AND s3.long_take_group_id = s.long_take_group_id
                  AND (COALESCE(s3.long_take_sequence, 0) < COALESCE(s.long_take_sequence, 0) OR p2.position < i.position)
              )
            )
          )
        ORDER BY b.created_at, b.rowid, i.position
        LIMIT 1
      `).get();
      if (!item) return;
      try {
        const valid = db.prepare(`SELECT s.* FROM storyboards s JOIN episodes e ON e.id=s.episode_id JOIN video_batches b ON b.episode_id=e.id
          WHERE b.id=? AND s.id=? AND e.drama_id=b.drama_id AND s.deleted_at IS NULL AND e.deleted_at IS NULL`).get(item.batch_id, item.storyboard_id);
        if (!valid) throw new Error('分镜或分集已删除/移动');
        const done = usableVideo(db, valid);
        const active = db.prepare("SELECT id FROM video_generations WHERE storyboard_id=? AND status='processing' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1").get(item.storyboard_id);
        if (done || active) {
          db.prepare('UPDATE video_batch_items SET status=?,video_gen_id=? WHERE id=?').run(done ? 'skipped' : 'running', (done || active).id, item.id);
          return;
        }
        const payload = JSON.parse(item.payload);
        const plan = resolveH3SubmissionPlan(db, item.drama_id, valid, payload);
        payload.resolution_plan = plan;
        if (plan.first_frame_policy === 'inherit_tail') {
          const previous = previousStoryboard(db, valid);
          const dependency = previous && db.prepare('SELECT status FROM video_batch_items WHERE batch_id=? AND storyboard_id=?').get(item.batch_id, previous.id);
          if (dependency && !['skipped', 'completed'].includes(dependency.status)) {
            throw new Error(`依赖的分镜 #${previous.storyboard_number} 尚无本轮可采用的成片，选择或重新生成后重试`);
          }
        }
        const video = db.transaction(() => {
          if (db.prepare('SELECT status FROM video_batch_items WHERE id=?').get(item.id)?.status !== 'pending') return null;
          const row = submit(db, log, payload);
          db.prepare("UPDATE video_batch_items SET status='running',video_gen_id=?,payload=? WHERE id=?").run(row.id, JSON.stringify(payload), item.id);
          return row;
        })();
        if (video) Promise.resolve().then(() => process(db, log, video.id)).catch(err => {
          log.error('Video batch process error', { id: video.id, error: err.message });
          db.prepare("UPDATE video_generations SET status='failed',error_msg=? WHERE id=? AND status='processing'").run(err.message, video.id);
        });
      } catch (err) {
        db.prepare("UPDATE video_batch_items SET status='failed',error=? WHERE id=? AND status='pending'").run(err.message, item.id);
        log.error('Video batch item failed', { item_id: item.id, error: err.message });
      }
    } finally { busy = false; }
  }
  return { tick };
}
function startWorker(db, log) {
  const worker = createWorker(db, log);
  const run = () => worker.tick().catch(err => log.error('Video batch dispatcher error', { error: err.message }));
  const timer = setInterval(run, 3000);
  timer.unref();
  setImmediate(run);
  return () => clearInterval(timer);
}
module.exports = { createBatch, latestBatch, getBatch, stopBatch, clearBatch, createWorker, startWorker };
