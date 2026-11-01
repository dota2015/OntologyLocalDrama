const videoService = require('./videoService');
const taskService = require('./taskService');
const { validateVideoSpeech } = require('./videoSpeechService');
const { resolveStoryboardModel } = require('./storyboardVideoModelService');
const { normalizeAspectRatioForApi, resolveVideoProtocol } = require('./videoClient');
const { assertSupportedVideoConfig } = require('./videoModelSupport');

// Insert task and video together, allowing the queue to link the record in the same transaction.
function submitVideo(db, log, requested) {
  return db.transaction(() => {
    const selected = resolveStoryboardModel(db, requested);
    assertSupportedVideoConfig(selected.config, selected.model);
    const body = { ...requested, model: selected.model, provider: selected.provider };
    const timing = validateVideoSpeech(db, body, selected.config);
    if (timing.error) throw Object.assign(new Error(timing.error), { status: 400 });
    const task = taskService.createTask(db, log, 'video_generation', String(body.drama_id || ''));
    const now = new Date().toISOString();
    const dramaId = Number(body.drama_id) || 0;
    const storyboardId = body.storyboard_id != null ? Number(body.storyboard_id) : null;
    const provider = body.provider || 'chatfire';
    // Storyboard H3 requests compile their final prompt from authoritative slots
    // immediately before submission. Keep prompt only for standalone API calls.
    let prompt = body.storyboard_id ? '' : String(body.prompt || '').trim();
    const style = (body.style || '').toString().trim();
    if (style) {
      const baseLower = String(prompt || '').toLowerCase();
      const styleLower = style.toLowerCase();
      if (!baseLower.includes(styleLower)) {
        prompt = prompt ? `${prompt}. Style: ${style}` : `Style: ${style}`;
      }
    }
    const model = body.model ?? null;
    const isH3Request = resolveVideoProtocol(selected.config || {}, model) === 'minimax_h3';
    const duration = body.duration ?? null;
    // 画幅：请求体归一化（全角冒号等）后写入 DB；未传则从 drama.metadata 读取并同样归一化
    let aspectRatio = null;
    if (body.aspect_ratio != null && String(body.aspect_ratio).trim() !== '') {
      aspectRatio = normalizeAspectRatioForApi(body.aspect_ratio);
    }
    if (!aspectRatio && dramaId) {
      try {
        const dramaRow = db.prepare('SELECT metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(dramaId);
        if (dramaRow && dramaRow.metadata) {
          const meta = typeof dramaRow.metadata === 'string' ? JSON.parse(dramaRow.metadata) : dramaRow.metadata;
          if (meta && meta.aspect_ratio) aspectRatio = normalizeAspectRatioForApi(meta.aspect_ratio);
        }
      } catch (_) {}
    }
    const resolution = body.resolution ?? null;
    const seed = body.seed != null ? Number(body.seed) : null;
    const cameraFixed = body.camera_fixed != null ? (body.camera_fixed ? 1 : 0) : null;
    const watermark = body.watermark != null ? (body.watermark ? 1 : 0) : 0;
    const imageUrl = body.image_url ?? null;
    // 首尾帧：支持 URL 或本地路径（sxy，存到 first_frame_url / last_frame_url）
    const firstFrameUrl = body.first_frame_url ?? body.first_frame_local_path ?? null;
    const lastFrameUrl = body.last_frame_url ?? body.last_frame_local_path ?? null;
    // 多图模式：sxy，存 JSON 数组到 reference_image_urls（严禁静默截断）
    if (isH3Request && body.reference_image_urls && Array.isArray(body.reference_image_urls)) {
      if (body.reference_image_urls.length > 9) {
        throw Object.assign(new Error(`参考图片数量 (${body.reference_image_urls.length}) 超过上限 (9 张)，后端禁止静默截断，请拆分分镜或精简参考素材`), { status: 400 });
      }
    }
    const refImagesJson =
      body.reference_image_urls && Array.isArray(body.reference_image_urls)
        ? JSON.stringify(body.reference_image_urls)
        : null;

    let h3Mode = null;
    let resolutionPlanJson = null;
    if (storyboardId && isH3Request) {
      const shotRow = db.prepare('SELECT * FROM storyboards WHERE id=? AND deleted_at IS NULL').get(storyboardId);
      if (!shotRow) throw Object.assign(new Error('分镜不存在或已删除'), { status: 400 });
      const { resolveH3SubmissionPlan } = require('./h3ModeResolver');
      const plan = resolveH3SubmissionPlan(db, dramaId, shotRow, body);
      h3Mode = plan.mode;
      resolutionPlanJson = JSON.stringify(plan);
      try {
        db.prepare('UPDATE storyboards SET h3_generation_plan=? WHERE id=?').run(resolutionPlanJson, storyboardId);
      } catch (_) {}
    }

    db.prepare(
      `INSERT INTO video_generations (drama_id, storyboard_id, provider, prompt, model, duration, aspect_ratio, resolution, seed, camera_fixed, watermark, image_url, first_frame_url, last_frame_url, reference_image_urls, h3_mode, resolution_plan, status, task_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?, ?)`
    ).run(dramaId, storyboardId, provider, prompt, model, duration, aspectRatio, resolution, seed, cameraFixed, watermark, imageUrl, firstFrameUrl, lastFrameUrl, refImagesJson, h3Mode, resolutionPlanJson, task.id, now, now);
    const videoGenId = db.prepare('SELECT last_insert_rowid() as id').get().id;
    const item = videoService.getById(db, videoGenId);
    return item || { id: videoGenId, task_id: task.id, status: 'processing' };
  })();
}
module.exports = { submitVideo };
