function list(db, query) {
  let sql = 'FROM image_generations WHERE deleted_at IS NULL';
  const params = [];
  if (query.drama_id) {
    sql += ' AND drama_id = ?';
    params.push(query.drama_id);
  }
  if (query.storyboard_id) {
    sql += ' AND storyboard_id = ?';
    params.push(query.storyboard_id);
  }
  if (query.frame_type) {
    sql += ' AND frame_type = ?';
    params.push(query.frame_type);
  }
  if (query.status) {
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

function rowToItem(r) {
  return {
    id: r.id,
    storyboard_id: r.storyboard_id,
    drama_id: r.drama_id,
    scene_id: r.scene_id ?? undefined,
    character_id: r.character_id,
    provider: r.provider,
    prompt: r.prompt,
    model: r.model,
    image_url: r.image_url,
    local_path: r.local_path,
    status: r.status,
    task_id: r.task_id,
    error_msg: r.error_msg,
    frame_type: r.frame_type ?? undefined,
    created_at: r.created_at,
    updated_at: r.updated_at,
    completed_at: r.completed_at,
  };
}

function getById(db, id) {
  const r = db.prepare('SELECT * FROM image_generations WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  return r ? { ...rowToItem(r), input_snapshot: require('./generationInputSnapshot').read(r) } : null;
}

const imageClient = require('./imageClient');
const taskService = require('./taskService');
const { resolveUseFirstFrameLayoutLock } = require('./imageFramePolicy');
const { aspectRatioToSize, getCleanSingleCharacterRef, getCleanSingleSceneRef } = require('./imageProcessing');
const { prepareImageGenerationInput } = require('./imageGenerationInput');
const { saveImageGenerationResult } = require('./imageGenerationResult');

function mergePromptWithStyle(prompt, style) {
  const base = (prompt || '').toString().trim();
  const styleText = (style || '').toString().trim();
  if (!styleText) return base;
  if (!base) return styleText;
  const lowerBase = base.toLowerCase();
  const lowerStyle = styleText.toLowerCase();
  if (lowerBase.includes(lowerStyle)) return base;
  return base + ', ' + styleText;
}

function create(db, log, req) {
  const now = new Date().toISOString();
  const task = taskService.createTask(db, log, 'image_generation', String(req.drama_id || ''));
  const taskId = task.id;
  const frameType = req.frame_type ?? null;
  const sceneId = req.scene_id != null ? Number(req.scene_id) : null;
  const refImagesJson =
    req.reference_images && Array.isArray(req.reference_images)
      ? JSON.stringify(req.reference_images.slice(0, 10))
      : null;
  if (req.reference_images && Array.isArray(req.reference_images)) {
    log.info('reference_images 完整路径（请求入参）', {
      image_gen_create: true,
      count: req.reference_images.length,
      reference_images: req.reference_images,
    });
  }
  const mergedPrompt = mergePromptWithStyle(req.prompt || '', req.style);
  // 优先使用请求中直接传入的 size；其次将 aspect_ratio 转成 size；未提供则存 NULL 留给 processImageGeneration 从 drama 元数据读取
  let reqSize = req.size || null;
  if (!reqSize && req.aspect_ratio) {
    reqSize = aspectRatioToSize(req.aspect_ratio) || null;
  }
  const useFirstFrameLayoutLock = resolveUseFirstFrameLayoutLock(req, frameType);
  const info = db.prepare(
    `INSERT INTO image_generations (storyboard_id, drama_id, scene_id, provider, prompt, negative_prompt, model, frame_type, reference_images, use_first_frame_layout_lock, size, status, task_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
  ).run(
    req.storyboard_id ?? null,
    Number(req.drama_id) || 0,
    sceneId,
    req.provider || 'openai',
    mergedPrompt,
    req.negative_prompt ?? null,
    req.model ?? null,
    frameType,
    refImagesJson,
    useFirstFrameLayoutLock,
    reqSize,
    taskId,
    now,
    now
  );
  const imageGenId = info.lastInsertRowid;
  if (!imageGenId) throw new Error('insert failed');
  setImmediate(() => {
    processImageGeneration(db, log, imageGenId);
  });
  return { id: imageGenId, task_id: taskId, status: 'pending', ...getById(db, imageGenId) };
}

/**
 * 异步处理图片生成：与 Go ProcessImageGeneration 对齐，调用图生 API 并更新记录与任务
 */
async function processImageGeneration(db, log, imageGenId) {
  const t0 = Date.now();
  const elapsed = () => `${Date.now() - t0}ms`;

  const row = db.prepare('SELECT * FROM image_generations WHERE id = ? AND deleted_at IS NULL').get(Number(imageGenId));
  if (!row) {
    log.error('[图生] 记录不存在', { id: imageGenId });
    return;
  }
  if (row.status !== 'pending') {
    log.info('[图生] 已被处理，跳过', { id: imageGenId, status: row.status });
    return;
  }

  log.info('[图生] ▶ 开始', {
    id: imageGenId,
    storyboard_id: row.storyboard_id,
    scene_id: row.scene_id,
    drama_id: row.drama_id,
    model: row.model,
    prompt_preview: (row.prompt || '').slice(0, 80),
  });

  const now = new Date().toISOString();
  try {
    const claim = db.prepare("UPDATE image_generations SET status='processing', updated_at=? WHERE id=? AND status='pending' AND deleted_at IS NULL").run(now, imageGenId);
    if (!claim.changes) return;
    const { request, cfg } = await prepareImageGenerationInput(db, log, row, elapsed);
    const tApi = Date.now();
    const result = await imageClient.callImageApi(db, log, request);
    log.info('[图生] Step4 图生 API 返回', { id: imageGenId, api_ms: Date.now() - tApi, has_error: !!result.error, elapsed: elapsed() });

    if (result.error) throw new Error(result.error);
    await saveImageGenerationResult(db, log, row, result, request.size, cfg, elapsed);

  } catch (err) {
    const now2 = new Date().toISOString();
    db.prepare('UPDATE image_generations SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?').run(
      'failed', (err.message || '').slice(0, 500), now2, imageGenId
    );
    if (row.task_id) taskService.updateTaskError(db, row.task_id, err.message);
    log.error('[图生] ✗ 异常', { id: imageGenId, error: err.message, stack: (err.stack || '').slice(0, 400), total_elapsed: elapsed() });
    if (row.scene_id != null) {
      try { db.prepare('UPDATE scenes SET error_msg = ?, updated_at = ? WHERE id = ?').run(err.message, now2, row.scene_id); } catch (_) {}
    }
    if (row.storyboard_id != null) {
      try { db.prepare('UPDATE storyboards SET error_msg = ?, updated_at = ? WHERE id = ?').run(err.message, now2, row.storyboard_id); } catch (_) {}
    }
  }
}

function deleteById(db, log, id) {
  const numId = Number(id);
  const now = new Date().toISOString();
  // 若该图当前绑定为某分镜的首/尾帧，解除绑定（避免悬空引用）
  try {
    const row = db.prepare('SELECT storyboard_id FROM image_generations WHERE id = ? AND deleted_at IS NULL').get(numId);
    if (row && row.storyboard_id != null) {
      const sid = Number(row.storyboard_id);
      db.prepare(`UPDATE storyboards SET first_frame_image_id = NULL, image_url = NULL, local_path = NULL, updated_at = ? WHERE id = ? AND first_frame_image_id = ?`).run(now, sid, numId);
      db.prepare(`UPDATE storyboards SET last_frame_image_id = NULL, last_frame_image_url = NULL, last_frame_local_path = NULL, updated_at = ? WHERE id = ? AND last_frame_image_id = ?`).run(now, sid, numId);
    }
  } catch (e) {
    try { log?.warn?.('[image delete] 清除分镜绑定失败', { id: numId, err: e.message }); } catch (_) {}
  }
  const result = db.prepare('UPDATE image_generations SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, numId);
  return result.changes > 0;
}

function getBackgroundsForEpisode(db, episodeId) {
  const rows = db.prepare(
    `SELECT s.id as scene_id, s.location, s.time, s.prompt, s.image_url, s.local_path, s.status
     FROM storyboards sb
     JOIN scenes s ON s.id = sb.scene_id AND s.deleted_at IS NULL
     WHERE sb.episode_id = ? AND sb.deleted_at IS NULL
     ORDER BY sb.storyboard_number`
  ).all(episodeId);
  return rows;
}

function upload(db, log, req) {
  const now = new Date().toISOString();
  const frameType = req.frame_type ?? null;
  const info = db.prepare(
    `INSERT INTO image_generations (storyboard_id, drama_id, provider, prompt, image_url, local_path, frame_type, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?)`
  ).run(
    req.storyboard_id ?? null,
    Number(req.drama_id) || 0,
    'upload',
    req.prompt || '',
    req.image_url || '',
    req.local_path ?? null,
    frameType,
    now,
    now
  );
  const row = db.prepare('SELECT * FROM image_generations WHERE id = ?').get(info.lastInsertRowid);
  if (row && row.storyboard_id) {
    try {
      const { bindStoryboardFrameImage } = require('./storyboardFrameBinding');
      bindStoryboardFrameImage(
        db,
        row.storyboard_id,
        row.frame_type,
        row.id,
        row.image_url,
        row.local_path
      );
    } catch (_) {}
  }
  return row ? rowToItem(row) : null;
}

module.exports = {
  list,
  getById,
  create,
  deleteById,
  getBackgroundsForEpisode,
  upload,
  processImageGeneration,
  aspectRatioToSize,
  getCleanSingleCharacterRef,
  getCleanSingleSceneRef,
};
