const path = require('path');
const taskService = require('./taskService');
const uploadService = require('./uploadService');
const storageLayout = require('./storageLayout');
const { splitQuadGridToImages, splitNineGridToImages, normalizeLocalImageToTargetSize, normalizeSavedImageToTargetPixels } = require('./imageProcessing');

async function saveImageGenerationResult(db, log, row, result, imageSize, cfg, elapsed) {
  const imageGenId = row.id;
  const now2 = new Date().toISOString();
  // Unsloth can reduce the output after its memory preflight refuses a large
  // canvas. Preserve that real resolution instead of upscaling it back here.
  if (result.size && result.width && result.height) imageSize = result.size;

  // ── Step 5: 保存图片到本地 ───────────────────────────────────────
  log.info('[图生] Step5 保存到本地 →', { id: imageGenId, elapsed: elapsed() });
  const tSave = Date.now();
  let localPath = null;
  try {
    const storagePath = path.isAbsolute(cfg.storage?.local_path)
      ? cfg.storage.local_path
      : path.join(process.cwd(), cfg.storage?.local_path || './data/storage');
    const category =
      row.scene_id != null ? 'scenes' : row.character_id != null ? 'characters' : 'images';
    const projectSubdir = storageLayout.getProjectStorageSubdir(db, row.drama_id);
    localPath = await uploadService.downloadImageToLocal(
      storagePath,
      result.image_url,
      category,
      log,
      'ig',
      projectSubdir
    );
    if (localPath && imageSize) {
      const absImg = path.join(storagePath, localPath);
      await normalizeLocalImageToTargetSize(absImg, imageSize, log, { id: imageGenId });
    }
    log.info('[图生] Step5 保存完成', { id: imageGenId, local_path: localPath, save_ms: Date.now() - tSave, elapsed: elapsed() });

    // Step5.1：单帧/场景图等若 API 返回像素与 Step3 目标不一致，则 letterbox 到目标画布（Gemini 常见）
    if (
      localPath &&
      imageSize &&
      row.frame_type !== 'quad_grid' &&
      row.frame_type !== 'nine_grid'
    ) {
      const absNorm = path.join(storagePath, localPath);
      await normalizeSavedImageToTargetPixels(absNorm, imageSize, log, { id: imageGenId, size: imageSize });
    }
  } catch (saveErr) {
    log.warn('[图生] Step5 保存失败（不影响结果）', { id: imageGenId, err: saveErr.message, elapsed: elapsed() });
  }

  // 入库的 image_url：优先指向本地静态路径，避免前端仍用 Gemini 返回的 data URL
  let persistedImageUrl = result.image_url;
  if (localPath) {
    persistedImageUrl = '/static/' + String(localPath).replace(/^\//, '');
  }

  // ── Step 6: 写库 & 任务完成 ──────────────────────────────────────
  // 关键防复活拦截：若任务已被用户取消或标记失败，跳过写库与关联更新
  const curImg = db.prepare('SELECT status, error_msg FROM image_generations WHERE id = ?').get(imageGenId);
  if (!curImg || curImg.status === 'failed' || curImg.status === 'cancelled') {
    log.info('[图生] 任务已被用户取消或标记失败，跳过完成写库', { id: imageGenId });
    return;
  }
  const updateRes = db.prepare(
    "UPDATE image_generations SET status = ?, image_url = ?, local_path = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status NOT IN ('failed', 'cancelled')"
  ).run('completed', persistedImageUrl, localPath, now2, now2, imageGenId);
  if (!updateRes || updateRes.changes === 0) {
    log.info('[图生] 记录已被取消，跳过关联更新', { id: imageGenId });
    return;
  }
  if (row.storyboard_id) {
    db.prepare("UPDATE storyboards SET error_msg = NULL WHERE id = ? AND error_msg LIKE 'Unsloth 图片生成失败%'")
      .run(row.storyboard_id);
  }
  if (row.task_id) {
    taskService.updateTaskResult(db, row.task_id, {
      image_generation_id: imageGenId,
      image_url: persistedImageUrl,
      status: 'completed',
    });
  }

  if (row.scene_id != null && row.storyboard_id == null) {
    // 旧图追加到 extra_images，与上传逻辑保持一致
    const oldScene = db.prepare('SELECT local_path, image_url, extra_images FROM scenes WHERE id = ?').get(row.scene_id);
    const oldPath = oldScene?.local_path || oldScene?.image_url || '';
    let sceneExtras = [];
    try { sceneExtras = oldScene?.extra_images ? JSON.parse(oldScene.extra_images) : []; } catch (_) {}
    if (!Array.isArray(sceneExtras)) sceneExtras = [];
    if (oldPath && !sceneExtras.includes(oldPath)) sceneExtras.push(oldPath);
    const sceneExtraJson = sceneExtras.length ? JSON.stringify(sceneExtras) : null;
    try {
      db.prepare("UPDATE scenes SET image_url = ?, local_path = ?, extra_images = ?, status = 'generated', updated_at = ? WHERE id = ?").run(
        persistedImageUrl, localPath, sceneExtraJson, now2, row.scene_id
      );
    } catch (e) {
      if ((e.message || '').includes('extra_images')) {
        db.prepare("UPDATE scenes SET image_url = ?, local_path = ?, status = 'generated', updated_at = ? WHERE id = ?").run(
          persistedImageUrl, localPath, now2, row.scene_id
        );
      } else {
        throw e;
      }
    }
  }
  log.info('[图生] ✓ 完成', { id: imageGenId, local_path: localPath, total_elapsed: elapsed() });

  // ── 首尾帧绑定决策 ─────────────────────────────────────────────
  // 优先信任 image_generations 行自身保存的 frame_type（前端点击“尾帧生成”会正确传 'storyboard_last'）。
  // 仅当该记录的 frame_type 为空或非首/尾帧特型时，才回退到“最近一次 frame_prompts”作为推断（兼容旧数据/历史创建路径）。
  let effectiveFrameTypeForBind = row.frame_type;
  const rowFt = String(row.frame_type || '').toLowerCase();
  const rowIsSpecificFirstLast = ['first', 'last', 'storyboard_first', 'storyboard_last'].includes(rowFt);
  if (row.storyboard_id && !rowIsSpecificFirstLast) {
    try {
      const fp = db.prepare(
        'SELECT frame_type FROM frame_prompts WHERE storyboard_id = ? ORDER BY updated_at DESC, created_at DESC LIMIT 1'
      ).get(Number(row.storyboard_id));
      if (fp && fp.frame_type && ['first', 'last', 'storyboard_first', 'storyboard_last'].includes(String(fp.frame_type))) {
        effectiveFrameTypeForBind = fp.frame_type;
        log.info('[图生] 绑定决策：image 自身无明确首/尾帧类型，回退使用最近的 frame_prompts', {
          id: imageGenId,
          inferred: effectiveFrameTypeForBind
        });
      }
    } catch (_) {}
  }

  if (row.storyboard_id && effectiveFrameTypeForBind !== 'quad_grid' && effectiveFrameTypeForBind !== 'nine_grid') {
    try {
      const { bindStoryboardFrameImage } = require('./storyboardFrameBinding');
      bindStoryboardFrameImage(
        db,
        row.storyboard_id,
        effectiveFrameTypeForBind,
        imageGenId,
        persistedImageUrl,
        localPath
      );
    } catch (bindErr) {
      log.warn('[图生] 分镜首尾帧绑定失败', { id: imageGenId, error: bindErr.message });
    }
  }

  // ── Step 7（四宫格）：自动拆分为 4 张子图，创建独立记录 ────────────
  if (row.frame_type === 'quad_grid' && localPath) {
    const storagePath2 = path.isAbsolute(cfg.storage?.local_path)
      ? cfg.storage.local_path
      : path.join(process.cwd(), cfg.storage?.local_path || './data/storage');
    const absLocalPath = path.join(storagePath2, localPath);
    splitQuadGridToImages(db, log, row, absLocalPath, storagePath2, persistedImageUrl).catch((e) => {
      log.warn('[图生] Step7 四宫格拆分异常', { id: imageGenId, error: e.message });
    });
  }

  // ── Step 7（九宫格）：自动拆分为 9 张子图，创建独立记录 ────────────
  if (row.frame_type === 'nine_grid' && localPath) {
    const storagePath2 = path.isAbsolute(cfg.storage?.local_path)
      ? cfg.storage.local_path
      : path.join(process.cwd(), cfg.storage?.local_path || './data/storage');
    const absLocalPath = path.join(storagePath2, localPath);
    splitNineGridToImages(db, log, row, absLocalPath, storagePath2, persistedImageUrl).catch((e) => {
      log.warn('[图生] Step7 九宫格拆分异常', { id: imageGenId, error: e.message });
    });
  }

}

module.exports = { saveImageGenerationResult };
