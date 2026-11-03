const { validateVideoSpeech } = require('./videoSpeechService');
/** 轮询/同步返回的 video_url 须为 http(s)，避免中转 FAILURE 时 result_url 为错误文案 */
function resolveRemoteVideoUrl(videoUrl, fallbackError) {
  if (videoUrl && videoClient.isPlausibleHttpVideoUrl(videoUrl)) {
    return { ok: true, video_url: String(videoUrl).trim() };
  }
  if (videoUrl) {
    return { ok: false, error: (fallbackError || String(videoUrl)).slice(0, 500) };
  }
  return { ok: false, error: (fallbackError || '超时或失败').slice(0, 500) };
}

/** 将 video_generations 标为失败；若无 error_msg 列则只更新 status/updated_at */
function setVideoGenFailed(db, videoGenId, errorMsg, now) {
  try {
    db.prepare('UPDATE video_generations SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?').run(
      'failed', (errorMsg || '').slice(0, 500), now, videoGenId
    );
  } catch (e) {
    if ((e.message || '').includes('error_msg')) {
      db.prepare('UPDATE video_generations SET status = ?, updated_at = ? WHERE id = ?').run('failed', now, videoGenId);
    } else throw e;
  }
}

function list(db, query) {
  let sql = 'FROM video_generations WHERE deleted_at IS NULL';
  const params = [];
  if (query.drama_id) {
    sql += ' AND drama_id = ?';
    params.push(query.drama_id);
  }
  if (query.storyboard_id) {
    sql += ' AND storyboard_id = ?';
    params.push(query.storyboard_id);
  }
  // 与 Go 前端行为对齐：请求 status=processing 时，同时包含“刚结束”的记录（5 分钟内变为 completed/failed），
  // 这样轮询刷新后任务不会从列表消失，无需改 Vue
  if (query.status === 'processing') {
    sql += " AND (status = 'processing' OR (status IN ('completed','failed') AND updated_at >= datetime('now', '-5 minutes')))";
  } else if (query.status) {
    sql += ' AND status = ?';
    params.push(query.status);
  }
  const countRow = db.prepare('SELECT COUNT(*) as total ' + sql).get(...params);
  const total = countRow.total || 0;
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(query.page_size, 10) || 20));
  const offset = (page - 1) * pageSize;
  const rows = db.prepare('SELECT * ' + sql + ' ORDER BY created_at DESC LIMIT ? OFFSET ?').all(...params, pageSize, offset);
  return { items: rows.map(rowToItem), total, page, pageSize };
}

function hasProviderTaskId(r) {
  return !!(r && r.provider_task_id && String(r.provider_task_id).trim());
}

function rowToItem(r) {
  let qualityAudit = null;
  if (r.quality_audit) {
    try {
      qualityAudit = typeof r.quality_audit === 'string' ? JSON.parse(r.quality_audit) : r.quality_audit;
    } catch (_) {}
  }
  let resolutionPlan = null;
  if (r.resolution_plan) {
    try {
      resolutionPlan = typeof r.resolution_plan === 'string' ? JSON.parse(r.resolution_plan) : r.resolution_plan;
    } catch (_) {}
  }
  return {
    id: r.id,
    storyboard_id: r.storyboard_id,
    drama_id: r.drama_id,
    provider: r.provider,
    prompt: r.prompt,
    model: r.model,
    h3_mode: r.h3_mode || null,
    resolution_plan: resolutionPlan,
    quality_audit: qualityAudit,
    image_gen_id: r.image_gen_id,
    image_url: r.image_url,
    video_url: r.video_url,
    local_path: r.local_path,
    status: r.status,
    task_id: r.task_id,
    error_msg: r.error_msg,
    created_at: r.created_at,
    updated_at: r.updated_at,
    completed_at: r.completed_at,
    /** 失败且已有上游任务 ID 时可「继续查询」，不暴露原始 provider_task_id */
    can_resume_poll: r.status === 'failed' && hasProviderTaskId(r),
  };
}

function getById(db, id) {
  const r = db.prepare('SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  return r ? { ...rowToItem(r), input_snapshot: require('./generationInputSnapshot').read(r) } : null;
}

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { randomUUID } = require('crypto');
const videoClient = require('./videoClient');
const taskService = require('./taskService');
const storageLayout = require('./storageLayout');
const { getFfmpegPath, hasLocalFfmpeg } = require('../utils/ffmpegPath');
const h3SerialQueue = require('./h3SerialQueue');

/** @returns {{ dir: string, relPrefix: string }} 与图片 uploads 一致的工程子目录规则 */
function resolveVideosDir(storagePath, projectSubdir) {
  const sub = projectSubdir && String(projectSubdir).trim();
  if (sub) {
    const relPrefix = `${sub.replace(/\\/g, '/')}/videos`;
    return { dir: path.join(storagePath, sub, 'videos'), relPrefix };
  }
  return { dir: path.join(storagePath, 'videos'), relPrefix: 'videos' };
}

/**
 * 将远程 video_url 下载到本地
 * @returns {string|null} 相对 storage 根的路径，如 projects/.../videos/vg_1_xxx.mp4；无工程时为 videos/...
 */
async function downloadVideoToLocal(storagePath, videoUrl, videoGenId, log, projectSubdir = null) {
  if (!videoUrl || typeof videoUrl !== 'string') return null;
  const { dir, relPrefix } = resolveVideosDir(storagePath, projectSubdir);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const ext = (videoUrl.split('?')[0].match(/\.(mp4|webm|mov)$/i) || [])[1] || 'mp4';
    const name = `vg_${videoGenId}_${randomUUID().slice(0, 8)}.${ext}`;
    const filePath = path.join(dir, name);
    const res = await fetch(videoUrl, { method: 'GET' });
    if (!res.ok) {
      log.warn('Download video failed', { status: res.status, videoGenId });
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(filePath, buf);
    const relativePath = `${relPrefix}/${name}`.replace(/\\/g, '/');
    log.info('Video saved to local', { videoGenId, local_path: relativePath, projectSubdir: projectSubdir || '(root)' });
    return relativePath;
  } catch (e) {
    log.warn('Download video error', { videoGenId, error: e.message });
    return null;
  }
}

/** 与图生 aspectRatioToSize 对齐的归一化分辨率（偶数像素，便于 H.264） */
function targetVideoPixelsForAspect(aspectRatio) {
  const r = String(aspectRatio || '16:9').trim();
  const map = {
    '16:9': { w: 2560, h: 1440 },
    '9:16': { w: 1440, h: 2560 },
    '1:1': { w: 1920, h: 1920 },
    '4:3': { w: 1920, h: 1440 },
    '3:4': { w: 1440, h: 1920 },
    '3:2': { w: 2560, h: 1708 },
    '2:3': { w: 1708, h: 2560 },
    '21:9': { w: 2560, h: 1080 },
  };
  if (map[r]) return map[r];
  const m = r.match(/^(\d+)\s*:\s*(\d+)$/);
  if (m) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (a > 0 && b > 0 && a !== b) {
      if (a > b) {
        const w = 2560;
        const h = Math.max(2, Math.round((w * b) / a / 2) * 2);
        return { w, h };
      }
      const h = 2560;
      const w = Math.max(2, Math.round((h * a) / b / 2) * 2);
      return { w, h };
    }
  }
  return { w: 1280, h: 720 };
}

/**
 * 用 ffmpeg 将视频缩放并加黑边到固定分辨率，避免不同生成节点的像素差异导致连播时画面跳动。
 */
function normalizeVideoFileToTargetPixels(absPath, tw, th, log, videoGenId) {
  if (!absPath || !tw || !th || !fs.existsSync(absPath)) return false;
  if (!hasLocalFfmpeg()) {
    log.info('[视频] 未找到 ffmpeg，跳过画幅归一化', { videoGenId });
    return false;
  }
  const ffmpeg = getFfmpegPath();
  const vf = `scale=${tw}:${th}:force_original_aspect_ratio=decrease,pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2:black`;
  const tmpOut = absPath + '.norm-' + randomUUID().slice(0, 8) + (path.extname(absPath) || '.mp4');
  const baseArgs = ['-y', '-i', absPath, '-vf', vf, '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
  let r = spawnSync(ffmpeg, [...baseArgs, '-c:a', 'copy', tmpOut], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) {
    r = spawnSync(ffmpeg, [...baseArgs, '-an', tmpOut], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  }
  if (r.status !== 0) {
    log.warn('[视频] 画幅归一化失败（保留原文件）', {
      videoGenId,
      stderr: (r.stderr || '').slice(-500),
    });
    try {
      fs.unlinkSync(tmpOut);
    } catch (_) {}
    return false;
  }
  try {
    fs.unlinkSync(absPath);
    fs.renameSync(tmpOut, absPath);
    log.info('[视频] 已统一画幅尺寸', { videoGenId, w: tw, h: th });
    return true;
  } catch (e) {
    log.warn('[视频] 替换归一化文件失败', { videoGenId, error: e.message });
    try {
      fs.unlinkSync(tmpOut);
    } catch (_) {}
    return false;
  }
}

function maybeNormalizeVideoAfterDownload(storagePath, localPath, row, videoGenId, log) {
  if (!localPath) return;
  const abs = path.join(storagePath, localPath);
  const dim = targetVideoPixelsForAspect(row.aspect_ratio);
  normalizeVideoFileToTargetPixels(abs, dim.w, dim.h, log, videoGenId);
}

/** 防止同一 videoGenId 重复发起 poll（含重启恢复） */
const activeVideoPolls = new Set();

function resolveStoragePath(cfg) {
  return path.isAbsolute(cfg.storage?.local_path)
    ? cfg.storage.local_path
    : path.join(process.cwd(), cfg.storage?.local_path || './data/storage');
}

function resolveLocalMediaPath(storagePath, source) {
  if (!source || typeof source !== 'string' || /^data:/i.test(source)) return null;
  let value = source.trim();
  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      if (!parsed.pathname.startsWith('/static/')) return null;
      value = decodeURIComponent(parsed.pathname.slice('/static/'.length));
    } catch (_) { return null; }
  } else {
    value = value.replace(/^\/static\//, '');
  }
  const candidate = path.isAbsolute(value) ? value : path.join(storagePath, value);
  return fs.existsSync(candidate) ? candidate : null;
}

async function finalizeSuccessfulVideo(db, log, videoGenId, row, rowForAspect, videoUrl, logLabel, aiConfig = null) {
  const now = new Date().toISOString();
  let localPath = null;
  let localFinalizationError = null;
  try {
    const cfg = require('../config').loadConfig();
    const storagePath = resolveStoragePath(cfg);
    const projectSubdir = storageLayout.getProjectStorageSubdir(db, row.drama_id);
    localPath = await downloadVideoToLocal(
      storagePath,
      videoUrl,
      videoGenId,
      log,
      projectSubdir,
      null
    );
    maybeNormalizeVideoAfterDownload(storagePath, localPath, rowForAspect, videoGenId, log);
  } catch (error) {
    localFinalizationError = error;
    log.error('[视频] 下载或本地整理失败', { video_gen_id: videoGenId, error: error.message });
  }

  // 关键防复活拦截：若任务已被用户取消或标记失败，严禁写入完成状态，严禁绑定到分镜
  try {
    const cur = db.prepare('SELECT status, error_msg FROM video_generations WHERE id = ?').get(videoGenId);
    if (!cur || cur.status === 'failed' || cur.status === 'cancelled') {
      log.info('Video generation cancelled/failed by user, aborting finalize' + (logLabel ? ` (${logLabel})` : ''), { id: videoGenId });
      return { ok: false, error: '任务已被取消' };
    }
  } catch (_) {}

  // 1. 生成后质量硬门禁审查（Quality Gate）：在标记完成与绑定分镜前严格质检
  let qualityAudit = null;
  if (localFinalizationError) {
    qualityAudit = {
      passed: false,
      violations: [{
        check: 'local_video_finalization',
        severity: 'error',
        message: localFinalizationError.message,
        recommendation: '检查视频下载与本地存储后重新查询或生成',
      }],
      frames: {},
      meta: {},
    };
  } else if (localPath) {
    try {
      const { auditGeneratedVideo } = require('./videoQualityGate');
      const cfg = require('../config').loadConfig();
      const storagePath = resolveStoragePath(cfg);
      const absPath = path.isAbsolute(localPath) ? localPath : path.join(storagePath, localPath);
      const shotRow = row.storyboard_id ? db.prepare('SELECT * FROM storyboards WHERE id=?').get(row.storyboard_id) : {};
      const firstFramePath = row.first_frame_url || row.image_url;
      const firstFrameAbs = resolveLocalMediaPath(storagePath, firstFramePath);
      qualityAudit = await auditGeneratedVideo(absPath, shotRow, {
        expectedDuration: row.duration,
        firstFrameSourcePath: firstFrameAbs,
        firstFrameRequired: !!firstFramePath,
      });
    } catch (qErr) {
      qualityAudit = {
        passed: false,
        violations: [{
          check: 'quality_gate_execution',
          severity: 'error',
          message: `视频质量门禁执行失败：${qErr.message}`,
          recommendation: '修复质量门禁运行环境后重新审查或重新生成',
        }],
        frames: {},
        meta: {},
      };
      log.error('[QualityGate] Post-gen audit execution failed closed', { error: qErr.message });
    }
  } else {
    qualityAudit = {
      passed: false,
      violations: [{
        check: 'local_audit_source',
        severity: 'error',
        message: '视频未成功下载到本地，无法执行生成后质量门禁',
        recommendation: '检查视频下载与存储配置后重新查询或生成',
      }],
      frames: {},
      meta: {},
    };
  }

  // 2. 门禁阻断判定：若存在致命质检缺陷，标记失败，严禁落入完成态与绑定分镜！
  if (qualityAudit && !qualityAudit.passed) {
    const errorViolations = qualityAudit.violations.filter(v => v.severity === 'error');
    const errMsg = `视频质量门禁拦截未通过（共 ${errorViolations.length} 处致命缺陷）：${errorViolations.map(v => v.message).join('；')}`;
    log.error('[QualityGate] Video quality gate rejected output', { videoGenId, violations: qualityAudit.violations });
    const auditJson = JSON.stringify(qualityAudit);
    db.prepare(`UPDATE video_generations SET status = 'failed', error_msg = ?, quality_audit = ?, updated_at = ? WHERE id = ?`).run(
      errMsg,
      auditJson,
      now,
      videoGenId
    );
    if (row.task_id) {
      taskService.updateTaskError(db, row.task_id, errMsg);
    }
    return { ok: false, error: errMsg, quality_audit: qualityAudit };
  }

  // 3. 质量门禁通过：原子写入完成状态、持久化 quality_audit 并绑定至分镜
  const qualityAuditJson = qualityAudit ? JSON.stringify(qualityAudit) : null;
  let updateRes;
  try {
    updateRes = db.prepare(
      "UPDATE video_generations SET status = ?, video_url = ?, local_path = ?, quality_audit = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status NOT IN ('failed', 'cancelled')"
    ).run('completed', videoUrl, localPath, qualityAuditJson, now, now, videoGenId);
  } catch (e) {
    updateRes = db.prepare(
      "UPDATE video_generations SET status = ?, video_url = ?, local_path = ?, quality_audit = ?, updated_at = ? WHERE id = ? AND status NOT IN ('failed', 'cancelled')"
    ).run('completed', videoUrl, localPath, qualityAuditJson, now, videoGenId);
  }
  if (!updateRes || updateRes.changes === 0) {
    log.info('Video generation was cancelled/failed concurrently, skip storyboard binding', { id: videoGenId });
    return { ok: false, error: '任务已被取消' };
  }
  if (row.storyboard_id) {
    try {
      db.prepare('UPDATE storyboards SET video_url = ?, selected_video_id = ?, updated_at = ? WHERE id = ?').run(
        videoUrl, videoGenId, now, row.storyboard_id
      );
      log.info('Updated storyboard video' + (logLabel ? ` (${logLabel})` : ''), {
        storyboard_id: row.storyboard_id,
        video_url: videoUrl,
        selected_video_id: videoGenId,
      });
    } catch (_) {}
  }
  if (row.task_id) {
    taskService.updateTaskResult(db, row.task_id, {
      video_generation_id: videoGenId,
      video_url: videoUrl,
      status: 'completed',
      quality_audit: qualityAudit,
    });
  }
  log.info('Video generation completed' + (logLabel ? ` (${logLabel})` : ''), {
    id: videoGenId,
    video_url: videoUrl,
    local_path: localPath,
    quality_passed: true,
  });
  return { ok: true, local_path: localPath, quality_audit: qualityAudit };
}

async function pollProviderTaskAndFinalize(db, log, videoGenId, row, rowForAspect, providerTaskId, config) {
  const cfg = require('../config').loadConfig();
  const POLL_INTERVAL_MS = 10000;
  const { resolveVideoGenerationTimeoutMinutes } = require('../config/videoGeneration');
  const generationTimeoutMinutes = resolveVideoGenerationTimeoutMinutes(cfg);
  const pollMaxAttempts = Math.max(
    1,
    Math.ceil((generationTimeoutMinutes * 60 * 1000) / POLL_INTERVAL_MS)
  );
  const pollResult = await videoClient.pollVideoTask(
    db,
    log,
    videoGenId,
    providerTaskId,
    config,
    pollMaxAttempts,
    POLL_INTERVAL_MS
  );
  const now = new Date().toISOString();
  try {
    const current = db.prepare('SELECT status, error_msg FROM video_generations WHERE id = ?').get(videoGenId);
    if (!current || current.status === 'failed' || current.status === 'cancelled') {
      log.info('Video generation already failed/cancelled, skipping finalization', { id: videoGenId });
      return;
    }
  } catch (_) {}
  const polledVideo = resolveRemoteVideoUrl(pollResult.video_url, pollResult.error);
  if (polledVideo.ok) {
    await finalizeSuccessfulVideo(db, log, videoGenId, row, rowForAspect, polledVideo.video_url, 'after poll', config);
  } else {
    setVideoGenFailed(db, videoGenId, polledVideo.error, now);
    if (row.task_id) taskService.updateTaskError(db, row.task_id, polledVideo.error);
    log.error('Video generation failed (after poll)', { id: videoGenId, error: polledVideo.error });
  }
}

/**
 * 恢复对厂商异步任务的轮询（需已持久化 provider_task_id；调用方须先将记录置为 processing）
 */
function startVideoHeartbeat(db, taskId) {
  if (!taskId) return () => {};
  db.prepare(`UPDATE async_tasks SET status='processing', progress=MAX(COALESCE(progress,0),1),
    message=CASE WHEN COALESCE(message,'')='' THEN '视频任务已开始，正在准备输入或等待模型完成' ELSE message END,
    updated_at=? WHERE id=? AND status='pending'`).run(new Date().toISOString(), taskId);
  const timer = setInterval(() => {
    try {
      db.prepare("UPDATE async_tasks SET updated_at=? WHERE id=? AND status IN ('pending','processing')")
        .run(new Date().toISOString(), taskId);
    } catch (_) { /* Shutdown may close the database while a poll is finishing. */ }
  }, 30000);
  timer.unref();
  return () => clearInterval(timer);
}

async function resumePollForVideoGenerationUnlocked(db, log, videoGenId) {
  if (activeVideoPolls.has(videoGenId)) {
    log.info('Video poll already active, skip resume', { videoGenId });
    return;
  }
  const row = db.prepare('SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(Number(videoGenId));
  if (!row || row.status !== 'processing') return;
  const providerTaskId = row.provider_task_id && String(row.provider_task_id).trim();
  if (!providerTaskId) return;

  const config = videoClient.getDefaultVideoConfig(db, row.model);
  if (!config) {
    const now = new Date().toISOString();
    setVideoGenFailed(db, videoGenId, '未配置视频模型', now);
    if (row.task_id) taskService.updateTaskError(db, row.task_id, '未配置视频模型');
    return;
  }

  const stopHeartbeat = startVideoHeartbeat(db, row.task_id);
  activeVideoPolls.add(videoGenId);
  log.info('Resuming video generation poll', {
    videoGenId,
    provider_task_id: providerTaskId,
  });
  try {
    let aspectForVideo = row.aspect_ratio;
    if (aspectForVideo) {
      const n = videoClient.normalizeAspectRatioForApi(aspectForVideo);
      if (n) aspectForVideo = n;
    }
    const rowForAspect = { ...row, aspect_ratio: aspectForVideo || row.aspect_ratio };
    await pollProviderTaskAndFinalize(db, log, videoGenId, row, rowForAspect, providerTaskId, config);
  } catch (err) {
    const now = new Date().toISOString();
    setVideoGenFailed(db, videoGenId, err.message, now);
    if (row.task_id) taskService.updateTaskError(db, row.task_id, err.message);
    log.error('Video generation resume poll error', { id: videoGenId, error: err.message });
  } finally {
    stopHeartbeat();
    activeVideoPolls.delete(videoGenId);
  }
}

// Restored provider tasks use the same FIFO as newly submitted jobs.  This is
// primarily a GPU safety rule; polling/finalization stays attached to the
// queue item until the remote H3 task reaches a terminal state.
async function resumePollForVideoGeneration(db, log, videoGenId) {
  return h3SerialQueue.enqueue(`resume_video_generation:${videoGenId}`, () => resumePollForVideoGenerationUnlocked(db, log, videoGenId));
}

/**
 * 失败记录「继续查询」：复用 provider_task_id 再轮询，不重新提交上游任务。
 * @returns {{ ok: true, item: object } | { ok: false, status: number, error: string }}
 */
function resumeFailedVideoPoll(db, log, videoGenId) {
  const id = Number(videoGenId);
  const row = db.prepare('SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!row) return { ok: false, status: 404, error: '记录不存在' };
  if (row.status === 'processing' && hasProviderTaskId(row)) {
    if (!activeVideoPolls.has(id)) {
      setImmediate(() => {
        resumePollForVideoGeneration(db, log, id).catch((e) => {
          log.error('resumeFailedVideoPoll reattach unhandled', { videoGenId: id, error: e.message });
        });
      });
    }
    return { ok: true, item: getById(db, id) };
  }
  if (row.status !== 'failed') {
    return { ok: false, status: 400, error: '仅失败的视频任务可继续查询' };
  }
  if (!hasProviderTaskId(row)) {
    return { ok: false, status: 400, error: '缺少厂商任务 ID，无法继续查询，请重新生成' };
  }

  const now = new Date().toISOString();
  try {
    db.prepare(
      'UPDATE video_generations SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?'
    ).run('processing', '', now, id);
  } catch (e) {
    if ((e.message || '').includes('error_msg')) {
      db.prepare('UPDATE video_generations SET status = ?, updated_at = ? WHERE id = ?').run(
        'processing',
        now,
        id
      );
    } else throw e;
  }

  let taskId = row.task_id;
  if (!taskId) {
    const task = taskService.createTask(db, log, 'video_generation', String(row.drama_id || ''));
    taskId = task.id;
    db.prepare('UPDATE video_generations SET task_id = ?, updated_at = ? WHERE id = ?').run(taskId, now, id);
  }
  taskService.updateTaskStatus(db, taskId, 'processing', 10, '继续查询上游任务…');
  try {
    db.prepare('UPDATE async_tasks SET error = NULL WHERE id = ?').run(taskId);
  } catch (_) {}

  log.info('Resume failed video poll requested', {
    videoGenId: id,
    provider_task_id: String(row.provider_task_id).trim(),
    task_id: taskId,
  });
  setImmediate(() => {
    resumePollForVideoGeneration(db, log, id).catch((e) => {
      log.error('resumeFailedVideoPoll unhandled', { videoGenId: id, error: e.message });
    });
  });
  return { ok: true, item: getById(db, id) };
}

/** 启动时恢复 processing 视频任务；无 provider_task_id 的视为中断 */
function resumeProcessingVideoGenerations(db, log) {
  const stuck = db
    .prepare(
      `SELECT id, task_id FROM video_generations
       WHERE status = 'processing' AND deleted_at IS NULL
         AND (provider_task_id IS NULL OR TRIM(provider_task_id) = '')
       ORDER BY id`
    )
    .all();
  const stuckMsg = '服务重启后无法恢复轮询（缺少厂商任务 ID），请重新生成';
  for (const s of stuck) {
    const now = new Date().toISOString();
    setVideoGenFailed(db, s.id, stuckMsg, now);
    if (s.task_id) taskService.updateTaskError(db, s.task_id, stuckMsg);
    log.warn('Marked interrupted video generation as failed', { videoGenId: s.id });
  }

  const resumable = db
    .prepare(
      `SELECT id, task_id FROM video_generations
       WHERE status = 'processing' AND deleted_at IS NULL
         AND provider_task_id IS NOT NULL AND TRIM(provider_task_id) != ''
       ORDER BY id`
    )
    .all();
  if (resumable.length) {
    log.info('Resuming video generation polls', { count: resumable.length });
  }
  for (const r of resumable) {
    if (r.task_id) {
      try {
        db.prepare("UPDATE async_tasks SET status = 'processing', error = NULL, message = '正在生成视频...' WHERE id = ?").run(r.task_id);
      } catch (_) {}
    }
    setImmediate(() => {
      resumePollForVideoGeneration(db, log, r.id).catch((e) => {
        log.error('resumePollForVideoGeneration unhandled', { videoGenId: r.id, error: e.message });
      });
    });
  }
}

async function processVideoGenerationUnlocked(db, log, videoGenId) {
  if (activeVideoPolls.has(videoGenId)) {
    log.info('Video generation already in progress, skip duplicate', { videoGenId });
    return;
  }
  activeVideoPolls.add(videoGenId);
  log.info('processVideoGeneration started', { videoGenId });
  const row = db.prepare('SELECT * FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(Number(videoGenId));
  if (!row) {
    activeVideoPolls.delete(videoGenId);
    log.error('Video generation not found', { id: videoGenId });
    return;
  }
  const stopHeartbeat = startVideoHeartbeat(db, row.task_id);
  const now = new Date().toISOString();
  try {
    db.prepare('UPDATE video_generations SET status = ?, updated_at = ? WHERE id = ?').run('processing', now, videoGenId);
    const loadConfig = require('../config').loadConfig;
    const cfg = loadConfig();
    const filesBaseUrl = (cfg.storage && cfg.storage.base_url) ? String(cfg.storage.base_url).replace(/\/$/, '') : '';
    const storageLocalPath = path.isAbsolute(cfg.storage?.local_path)
      ? cfg.storage.local_path
      : path.join(process.cwd(), cfg.storage?.local_path || './data/storage');
    const config = videoClient.getDefaultVideoConfig(db, row.model);
    if (!config) {
      setVideoGenFailed(db, videoGenId, '未配置视频模型', now);
      if (row.task_id) taskService.updateTaskError(db, row.task_id, '未配置视频模型');
      return;
    }
    // 默认持久化为当前配置的视频模型（MiniMax H3）
    if (!row.model) {
      row.model = config.default_model || (Array.isArray(config.model) ? config.model[0] : config.model) || 'minimax_h3';
      row.provider = config.provider || 'minimax_h3';
      db.prepare('UPDATE video_generations SET model = ?, provider = ? WHERE id = ?')
        .run(row.model, row.provider, videoGenId);
    }
    let reference_urls = null;
    if (row.reference_image_urls) {
      try {
        reference_urls = JSON.parse(row.reference_image_urls);
        if (!Array.isArray(reference_urls)) reference_urls = null;
      } catch (_) {}
    }
    // Revalidate queued/manual submissions with the actual model duration before GPU work.
    const timing = validateVideoSpeech(db, row, config);
    if (timing.error) throw new Error(timing.error);
    const effectiveDuration = timing.duration;
    let aspectForVideo = row.aspect_ratio;
    if (aspectForVideo) {
      const n = videoClient.normalizeAspectRatioForApi(aspectForVideo);
      if (n) aspectForVideo = n;
    }
    if (!aspectForVideo && row.drama_id) {
      try {
        const dramaRow = db.prepare('SELECT metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(row.drama_id);
        if (dramaRow && dramaRow.metadata) {
          const meta =
            typeof dramaRow.metadata === 'string' ? JSON.parse(dramaRow.metadata) : dramaRow.metadata;
          if (meta && meta.aspect_ratio) {
            aspectForVideo = videoClient.normalizeAspectRatioForApi(meta.aspect_ratio);
          }
        }
      } catch (_) {}
    }
    const rowForAspect = { ...row, aspect_ratio: aspectForVideo || row.aspect_ratio };
    const hasOmniRefs = !!(reference_urls && reference_urls.length > 0);
    // H3 distinguishes explicit frame anchors from reference assets.
    const omitFrameFields = hasOmniRefs && videoClient.resolveVideoProtocol(config, row.model) !== 'minimax_h3';
    if (row.task_id && hasOmniRefs) {
      taskService.updateTaskStatus(
        db,
        row.task_id,
        'processing',
        5,
        omitFrameFields ? `正在上传 ${reference_urls.length} 张参考图到图床…` : '正在准备视频输入图片…'
      );
    }
    const result = await videoClient.callVideoApi(db, log, {
      prompt: row.prompt,
      model: row.model,
      duration: effectiveDuration,
      aspect_ratio: rowForAspect.aspect_ratio,
      resolution: row.resolution,
      seed: row.seed,
      camera_fixed: row.camera_fixed,
      watermark: row.watermark,
      provider: row.provider,
      drama_id: row.drama_id,
      storyboard_id: row.storyboard_id || undefined,
      image_url: omitFrameFields ? undefined : row.image_url,
      first_frame_url: omitFrameFields ? undefined : row.first_frame_url,
      last_frame_url: omitFrameFields ? undefined : row.last_frame_url,
      reference_urls,
      h3_mode: row.h3_mode || undefined,
      execution_backend: row.execution_backend || undefined,
      continuum_plan: row.continuum_plan || undefined,
      files_base_url: filesBaseUrl,
      storage_local_path: storageLocalPath,
      video_gen_id: videoGenId,
    });
    const now2 = new Date().toISOString();
    if (result.error) {
      setVideoGenFailed(db, videoGenId, result.error, now2);
      if (row.task_id) taskService.updateTaskError(db, row.task_id, result.error);
      log.error('Video generation failed', { id: videoGenId, error: result.error });
      return;
    }
    const directVideo = resolveRemoteVideoUrl(result.video_url, result.error);
    if (directVideo.ok) {
      try {
        const current = db.prepare('SELECT status, error_msg FROM video_generations WHERE id = ?').get(videoGenId);
        if (!current || current.status === 'failed' || current.status === 'cancelled') {
          log.info('Video generation already failed/cancelled, skipping direct finalization', { id: videoGenId });
          return;
        }
      } catch (_) {}
      await finalizeSuccessfulVideo(db, log, videoGenId, row, rowForAspect, directVideo.video_url, '', config);
      return;
    }
    if (result.video_url) {
      setVideoGenFailed(db, videoGenId, directVideo.error, now2);
      if (row.task_id) taskService.updateTaskError(db, row.task_id, directVideo.error);
      log.error('Video generation failed', { id: videoGenId, error: directVideo.error });
      return;
    }
    if (result.task_id) {
      // 关键防复活拦截：若在 callVideoApi 等待期间用户已取消任务，不可重置为 processing，直接退出
      const cur = db.prepare('SELECT status, error_msg FROM video_generations WHERE id = ?').get(videoGenId);
      if (!cur || cur.status === 'failed' || cur.status === 'cancelled') {
        log.info('Video generation cancelled by user during API call, aborting poll', { id: videoGenId });
        return;
      }
      const upd = db.prepare(
        "UPDATE video_generations SET status = ?, provider_task_id = ?, updated_at = ? WHERE id = ? AND status NOT IN ('failed', 'cancelled')"
      ).run('processing', result.task_id, now2, videoGenId);
      if (upd.changes === 0) {
        log.info('Video generation status changed to failed/cancelled concurrently, aborting poll', { id: videoGenId });
        return;
      }
      await pollProviderTaskAndFinalize(db, log, videoGenId, row, rowForAspect, result.task_id, config);
      return;
    }
    setVideoGenFailed(db, videoGenId, '未返回 task_id 或 video_url', now2);
    if (row.task_id) taskService.updateTaskError(db, row.task_id, '未返回 task_id 或 video_url');
  } catch (err) {
    const now2 = new Date().toISOString();
    setVideoGenFailed(db, videoGenId, err.message, now2);
    if (row && row.task_id) taskService.updateTaskError(db, row.task_id, err.message);
    log.error('Video generation error', { id: videoGenId, error: err.message });
  } finally {
    stopHeartbeat();
    activeVideoPolls.delete(videoGenId);
  }
}

/**
 * Public entry point for new H3 generation.  The lock covers submission and
 * provider polling/finalization, so a second shot cannot start on another H3
 * instance while the first one is still using the GPU.
 */
async function processVideoGeneration(db, log, videoGenId) {
  return h3SerialQueue.enqueue(`video_generation:${videoGenId}`, () => processVideoGenerationUnlocked(db, log, videoGenId));
}

function deleteById(db, log, id) {
  const now = new Date().toISOString();
  const numId = Number(id);
  const result = db.prepare('UPDATE video_generations SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, numId);
  if (result.changes > 0) {
    try {
      db.prepare('UPDATE storyboards SET selected_video_id = NULL WHERE selected_video_id = ?').run(numId);
    } catch (_) {}
  }
  return result.changes > 0;
}

module.exports = {
  list,
  getById,
  deleteById,
  processVideoGeneration,
  resumeProcessingVideoGenerations,
  resumeFailedVideoPoll,
  resumePollForVideoGeneration,
};
