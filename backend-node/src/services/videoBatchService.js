const { randomUUID } = require('crypto');
const path = require('path');
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
    const { resolveH3SubmissionPlan } = require('./h3ModeResolver');
    const plan = resolveH3SubmissionPlan(db, episode.drama_id, shot, input);
    requested.h3_mode = plan.mode;
    requested.resolution_plan = plan;

    const isContinuation = shot.long_take_role === 'continuation' || shot.long_take_role === 'tail' || plan.first_frame_policy === 'inherit_tail';
    const hasFirstFrame = !!(input.first_frame_url || input.image_url || shot.local_path || shot.image_url);
    if (plan.requires_first_frame && !hasFirstFrame && !input.universal && !isContinuation) {
      if (process.env.NODE_ENV !== 'test' || input.first_frame_url !== undefined) {
        throw new Error(`分镜 #${shot.storyboard_number} 缺少首帧图片（首帧生成失败或未就绪），已终止任务，禁止静默降级为无首帧生成！`);
      }
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
function isSameSceneOrUnspecified(a, b) {
  if (!a || !b) return false;
  if (a.scene_id && b.scene_id) return Number(a.scene_id) === Number(b.scene_id);
  if (a.location?.trim() && b.location?.trim()) return a.location.trim() === b.location.trim();
  if (a.scene_id || b.scene_id || a.location?.trim() || b.location?.trim()) return false;
  return true;
}

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
          const ok = video?.status === 'completed' && (video.local_path || videoClient.isPlausibleHttpVideoUrl(video.video_url));
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
        const videos = db.prepare('SELECT * FROM video_generations WHERE storyboard_id=? AND drama_id=? AND deleted_at IS NULL ORDER BY id DESC').all(item.storyboard_id, item.drama_id);
        const done = videos.find(v => v.status === 'completed' && (v.local_path || videoClient.isPlausibleHttpVideoUrl(v.video_url)));
        const active = videos.find(v => v.status === 'processing');
        if (done || active) {
          db.prepare('UPDATE video_batch_items SET status=?,video_gen_id=? WHERE id=?').run(done ? 'skipped' : 'running', (done || active).id, item.id);
          return;
        }
        const payload = JSON.parse(item.payload);
        let slots = valid.semantic_slots;
        if (typeof slots === 'string') {
          try { slots = JSON.parse(slots); } catch (_) { slots = null; }
        }
        const firstFramePolicy = slots?.first_frame_policy || valid.first_frame_policy;
        const continuityType = slots?.continuity_type || valid.continuity_type;
        const isLongTakeContinuation = valid.long_take_group_id && (valid.long_take_role === 'continuation' || valid.long_take_role === 'tail' || (valid.long_take_sequence != null && valid.long_take_sequence > 1));

        // 严格遵从语义槽位策略：仅在声明了 inherit_tail 或 long_take_continuation 时触发尾帧继承
        const hasSemanticContinuity = !!(slots?.first_frame_policy || slots?.continuity_type);
        const shouldInheritTail = (firstFramePolicy === 'inherit_tail' || continuityType === 'long_take_continuation' || isLongTakeContinuation || (!hasSemanticContinuity && item.continuity))
          && firstFramePolicy !== 'generate_new'
          && continuityType !== 'hard_cut'
          && !require('./wardrobeService').hasChange(db, item.storyboard_id)
          && !payload.universal;

        if (shouldInheritTail) {
          const prev = isLongTakeContinuation
            ? db.prepare(`SELECT i.* FROM video_batch_items i JOIN storyboards s ON s.id=i.storyboard_id
                WHERE i.batch_id=? AND s.long_take_group_id=? AND (COALESCE(s.long_take_sequence, 0) < COALESCE(?, 0) OR i.position < ?)
                ORDER BY s.long_take_sequence DESC, i.position DESC LIMIT 1`).get(item.batch_id, valid.long_take_group_id, valid.long_take_sequence || 9999, item.position)
            : db.prepare('SELECT * FROM video_batch_items WHERE batch_id=? AND position<? ORDER BY position DESC LIMIT 1').get(item.batch_id, item.position);

          let previousShot = null;
          if (prev && ['completed', 'skipped'].includes(prev.status)) {
            previousShot = db.prepare('SELECT * FROM storyboards WHERE id=?').get(prev.storyboard_id);
          } else if (isLongTakeContinuation) {
            previousShot = db.prepare(`SELECT * FROM storyboards WHERE episode_id=? AND long_take_group_id=?
              AND (COALESCE(long_take_sequence, 0) < COALESCE(?, 0) OR storyboard_number < ?) AND deleted_at IS NULL
              ORDER BY long_take_sequence DESC, storyboard_number DESC LIMIT 1`).get(valid.episode_id, valid.long_take_group_id, valid.long_take_sequence || 9999, valid.storyboard_number);
          }

          if (!previousShot) {
            if (firstFramePolicy === 'inherit_tail') {
              throw new Error(`分镜 #${valid.storyboard_number} 明确指定了 inherit_tail 尾帧连戏策略，但前序分镜不存在或尚未生成，禁止静默回退！`);
            }
          } else {
            if (firstFramePolicy === 'inherit_tail' && !isSameSceneOrUnspecified(valid, previousShot)) {
              throw new Error(`分镜 #${valid.storyboard_number} 明确要求继承上一镜尾帧，但上一镜属于不同场景；切换场景必须改为 Ref2VA 重新起镜！`);
            }
            try {
              const cfg = require('../config').loadConfig();
              const root = path.resolve(cfg.storage?.local_path || './data/storage');
              const tail = await require('./h3NativeService').tailFrame(db, item.drama_id, previousShot, root);
              const base = String(cfg.storage?.base_url || '').replace(/\/$/, '');
              const url = base + (base.endsWith('/static') ? '/' : '/static/') + tail;
              payload.image_url = payload.first_frame_url = url;
              payload.reference_image_urls = [url, payload.last_frame_url].filter(Boolean);

              // 继承尾帧仅作为本次执行输入记录，不覆盖 Agent 已规划并绑定的分镜首帧。
              try {
                db.prepare(`INSERT INTO image_generations (drama_id, storyboard_id, image_url, local_path, frame_type, prompt, status, created_at, updated_at)
                  VALUES (?, ?, ?, ?, 'inherited_tail_frame', ?, 'completed', ?, ?)`).run(item.drama_id, item.storyboard_id, url, tail, `[连戏承接首帧] 承接分镜 #${previousShot.storyboard_number} 尾帧`, new Date().toISOString(), new Date().toISOString());
              } catch (_) {}
            } catch (tailErr) {
              if (firstFramePolicy === 'inherit_tail') {
                throw new Error(`分镜 #${valid.storyboard_number} 尾帧抽取失败（${tailErr.message}），无法满足 inherit_tail 强约束，禁止静默降级！`);
              }
              log.warn('[videoBatch] Tail frame continuity extraction failed for non-strict continuation', { storyboard_id: item.storyboard_id, error: tailErr.message });
            }
          }
        }
        // Stop may arrive while ffmpeg prepares a continuity frame. Recheck inside the transaction.
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
