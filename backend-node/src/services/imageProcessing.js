const path = require('path');
const fs = require('fs');

/**
 * 将四宫格整图拆成 4 张子图，保存到本地，并在 image_generations 表中分别建立记录。
 * @param {string} absLocalPath  图片的绝对路径（sharp 读取用）
 * @param {string} storagePath   存储根目录的绝对路径（用于计算写入 DB 的相对路径）
 * @param {string} imageUrl_     原图的远端 URL（用于推导子图 URL）
 * frame_type 分别为 quad_panel_0~3，对应左上/右上/左下/右下。
 */
async function splitQuadGridToImages(db, log, originalRow, absLocalPath, storagePath, imageUrl_) {
  if (!absLocalPath) {
    log.warn('[四宫格拆分] 缺少本地文件路径，跳过拆分', { id: originalRow.id });
    return;
  }
  let sharp;
  try {
    sharp = require('sharp');
  } catch (e) {
    log.warn('[四宫格拆分] sharp 未安装，跳过拆分', { error: e.message });
    return;
  }
  try {
    // Windows：避免 libvips 直接 open 含中文路径；读入 Buffer，写出用 fs.writeFileSync
    const inputBuf = fs.readFileSync(absLocalPath);
    const meta = await sharp(inputBuf).metadata();
    const w = meta.width;
    const h = meta.height;
    const hw = Math.floor(w / 2);
    const hh = Math.floor(h / 2);
    // 4 象限：左上(0)、右上(1)、左下(2)、右下(3)
    const quadrants = [
      { left: 0,  top: 0,  width: hw,     height: hh,     idx: 0 },
      { left: hw, top: 0,  width: w - hw, height: hh,     idx: 1 },
      { left: 0,  top: hh, width: hw,     height: h - hh, idx: 2 },
      { left: hw, top: hh, width: w - hw, height: h - hh, idx: 3 },
    ];
    const labels = ['左上', '右上', '左下', '右下'];
    const absDir = path.dirname(absLocalPath);
    const ext = path.extname(absLocalPath) || '.jpg';
    const base = path.basename(absLocalPath, ext);
    const now = new Date().toISOString();
    for (const q of quadrants) {
      try {
        const panelFilename = `${base}_panel${q.idx}${ext}`;
        // 绝对路径（文件写入）
        const absPanelPath = path.join(absDir, panelFilename);
        // 相对路径（存 DB，与原图同格式：images/ig_xxx_panel0.jpg）
        const relPanelPath = path.relative(storagePath, absPanelPath).replace(/\\/g, '/');
        // 用 sharp 裁剪并添加文字标签 SVG 角标
        const labelSvg = `<svg width="${q.width}" height="${q.height}">
  <rect x="4" y="4" width="42" height="24" rx="4" fill="rgba(0,0,0,0.55)"/>
  <text x="25" y="21" font-size="14" fill="white" font-family="sans-serif" text-anchor="middle">${labels[q.idx]}</text>
</svg>`;
        const panelBuf = await sharp(inputBuf)
          .extract({ left: q.left, top: q.top, width: q.width, height: q.height })
          .composite([{ input: Buffer.from(labelSvg, 'utf8'), top: 0, left: 0 }])
          .jpeg({ quality: 92 })
          .toBuffer();
        fs.writeFileSync(absPanelPath, panelBuf);
        // 推导远端 URL（与原图同目录，只替换文件名）
        const panelImageUrl = imageUrl_
          ? imageUrl_.replace(/[^/\\]+$/, panelFilename)
          : null;
        // 插入 image_generation 记录（status=completed，直接可用）
        db.prepare(
          `INSERT INTO image_generations (storyboard_id, drama_id, scene_id, character_id, provider, prompt, model, frame_type, image_url, local_path, status, created_at, updated_at, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)`
        ).run(
          originalRow.storyboard_id ?? null,
          originalRow.drama_id ?? 0,
          originalRow.scene_id ?? null,
          originalRow.character_id ?? null,
          originalRow.provider || 'system',
          `[${labels[q.idx]}] ${originalRow.prompt || ''}`.slice(0, 1000),
          originalRow.model ?? null,
          `quad_panel_${q.idx}`,
          panelImageUrl,
          relPanelPath,
          now, now, now
        );
        log.info(`[四宫格拆分] 面板 ${q.idx}(${labels[q.idx]}) 已保存`, { rel_path: relPanelPath });
      } catch (panelErr) {
        log.warn(`[四宫格拆分] 面板 ${q.idx} 失败`, { error: panelErr.message });
      }
    }
    log.info('[四宫格拆分] 完成', { original_id: originalRow.id, storyboard_id: originalRow.storyboard_id });
  } catch (err) {
    log.warn('[四宫格拆分] 整体失败', { error: err.message });
  }
}
/**
 * 九宫格拆分：将一张 3×3 合成图拆成 9 张独立图，写入 image_generations
 * frame_type 分别为 nine_panel_0~8，对应 3×3 从左上到右下排列。
 */
async function splitNineGridToImages(db, log, originalRow, absLocalPath, storagePath, imageUrl_) {
  if (!absLocalPath) {
    log.warn('[九宫格拆分] 缺少本地文件路径，跳过拆分', { id: originalRow.id });
    return;
  }
  let sharp;
  try {
    sharp = require('sharp');
  } catch (e) {
    log.warn('[九宫格拆分] sharp 未安装，跳过拆分', { error: e.message });
    return;
  }
  const labels = ['左上', '中上', '右上', '左中', '中间', '右中', '左下', '中下', '右下'];
  try {
    const inputBuf = fs.readFileSync(absLocalPath);
    const meta = await sharp(inputBuf).metadata();
    const w = meta.width;
    const h = meta.height;
    const cw = Math.floor(w / 3);
    const ch = Math.floor(h / 3);
    // 9 格：行×列，处理余数保证无缝覆盖
    const cells = [];
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        const left = col * cw;
        const top  = row * ch;
        const width  = col === 2 ? w - left : cw;
        const height = row === 2 ? h - top  : ch;
        cells.push({ left, top, width, height, idx: row * 3 + col });
      }
    }
    const absDir = path.dirname(absLocalPath);
    const ext = path.extname(absLocalPath) || '.jpg';
    const base = path.basename(absLocalPath, ext);
    const now = new Date().toISOString();
    for (const c of cells) {
      try {
        const panelFilename = `${base}_panel${c.idx}${ext}`;
        const absPanelPath = path.join(absDir, panelFilename);
        const relPanelPath = path.relative(storagePath, absPanelPath).replace(/\\/g, '/');
        const labelSvg = `<svg width="${c.width}" height="${c.height}">
  <rect x="4" y="4" width="42" height="24" rx="4" fill="rgba(0,0,0,0.55)"/>
  <text x="25" y="21" font-size="14" fill="white" font-family="sans-serif" text-anchor="middle">${labels[c.idx]}</text>
</svg>`;
        const panelBuf = await sharp(inputBuf)
          .extract({ left: c.left, top: c.top, width: c.width, height: c.height })
          .composite([{ input: Buffer.from(labelSvg, 'utf8'), top: 0, left: 0 }])
          .jpeg({ quality: 92 })
          .toBuffer();
        fs.writeFileSync(absPanelPath, panelBuf);
        const panelImageUrl = imageUrl_ ? imageUrl_.replace(/[^/\\]+$/, panelFilename) : null;
        db.prepare(
          `INSERT INTO image_generations (storyboard_id, drama_id, scene_id, provider, prompt, model, frame_type, image_url, local_path, status, created_at, updated_at, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)`
        ).run(
          originalRow.storyboard_id ?? null,
          originalRow.drama_id ?? 0,
          originalRow.scene_id ?? null,
          originalRow.provider || 'system',
          `[${labels[c.idx]}] ${originalRow.prompt || ''}`.slice(0, 1000),
          originalRow.model ?? null,
          `nine_panel_${c.idx}`,
          panelImageUrl,
          relPanelPath,
          now, now, now
        );
        log.info(`[九宫格拆分] 面板 ${c.idx}(${labels[c.idx]}) 已保存`, { rel_path: relPanelPath });
      } catch (panelErr) {
        log.warn(`[九宫格拆分] 面板 ${c.idx} 失败`, { error: panelErr.message });
      }
    }
    log.info('[九宫格拆分] 完成', { original_id: originalRow.id, storyboard_id: originalRow.storyboard_id });
  } catch (err) {
    log.warn('[九宫格拆分] 整体失败', { error: err.message });
  }
}

/**
 * 将 aspect_ratio（如 "9:16"）转换为图片生成 size 字符串（如 "1152x2048"）
 * 宽与高均不超过 2048 且为 16 的倍数，全面兼容 OpenAI 协议接口（如 Qwen-Image、DALL-E、SD 等）
 * 火山引擎 Seedream 需要 >= 3,686,400 像素时在 imageClient.fixSeedreamSize 中自动按比例放大
 */
function aspectRatioToSize(aspectRatio) {
  const map = {
    '16:9':  '2048x1152',
    '9:16':  '1152x2048',
    '1:1':   '1024x1024',
    '4:3':   '1024x768',
    '3:4':   '768x1024',
    '21:9':  '1920x832',
  };
  return map[aspectRatio] || null;
}

/** 解析 image_generations.size / aspectRatioToSize 结果，如 2560x1440 */
function parseTargetPixelsFromSizeString(sizeStr) {
  if (!sizeStr || typeof sizeStr !== 'string') return null;
  const m = String(sizeStr).trim().toLowerCase().replace(/\s/g, '').match(/^(\d+)[x*](\d+)$/);
  if (!m) return null;
  const w = parseInt(m[1], 10);
  const h = parseInt(m[2], 10);
  if (!w || !h) return null;
  return { w, h };
}

/**
 * 将已落盘的生成图缩放到与 Step3 目标尺寸一致（contain + 黑底留边，不裁切主体），避免模型实际输出像素漂移导致分镜/视频参考不一致。
 * Windows：经路径打开含中文/非 ASCII 目录时 libvips 常失败，改由 Node 读入 Buffer 再交给 sharp。
 */
async function normalizeLocalImageToTargetSize(absPath, sizeStr, log, meta) {
  const dim = parseTargetPixelsFromSizeString(sizeStr);
  if (!dim || !absPath || !fs.existsSync(absPath)) return;
  let sharpLib;
  try {
    sharpLib = require('sharp');
  } catch (_) {
    log.warn('[图生] sharp 不可用，跳过尺寸对齐', meta || {});
    return;
  }
  try {
    const inputBuf = fs.readFileSync(absPath);
    const metaIn = await sharpLib(inputBuf).metadata();
    if (metaIn.width === dim.w && metaIn.height === dim.h) {
      log.info('[图生] 输出尺寸已与目标一致', { ...meta, size: `${dim.w}x${dim.h}` });
      return;
    }
    const ext = path.extname(absPath).toLowerCase();
    const containBg = { r: 0, g: 0, b: 0, alpha: 1 };
    const pipeline = sharpLib(inputBuf).resize(dim.w, dim.h, {
      fit: 'contain',
      position: 'centre',
      background: containBg,
    });
    let buf;
    if (ext === '.png') {
      buf = await pipeline.png({ compressionLevel: 6 }).toBuffer();
    } else if (ext === '.webp') {
      buf = await pipeline.webp({ quality: 90 }).toBuffer();
    } else {
      buf = await pipeline.jpeg({ quality: 92 }).toBuffer();
    }
    fs.writeFileSync(absPath, buf);
    log.info('[图生] 已对齐输出尺寸', {
      ...meta,
      target: `${dim.w}x${dim.h}`,
      before: `${metaIn.width}x${metaIn.height}`,
    });
  } catch (e) {
    log.warn('[图生] 尺寸对齐失败（保留原图）', { ...meta, error: e.message });
  }
}

/**
 * Gemini/部分中转返回的像素与请求的 size 不一致时，二次 letterbox（容差内跳过）；在 normalizeLocalImageToTargetSize 之后调用。
 */
async function normalizeSavedImageToTargetPixels(absPath, sizeStr, log, ctx) {
  const dim = parseTargetPixelsFromSizeString(sizeStr);
  if (!dim) return;
  let sharpLib;
  try { sharpLib = require('sharp'); } catch { return; }
  if (!absPath || !fs.existsSync(absPath)) return;
  const tw = dim.w;
  const th = dim.h;
  const tmp = absPath + '.__norm_tmp__';
  try {
    const meta = await sharpLib(absPath).metadata();
    const ow = meta.width;
    const oh = meta.height;
    if (!ow || !oh) return;
    const targetR = tw / th;
    const outR = ow / oh;
    const ratioClose = Math.abs(outR - targetR) / Math.max(targetR, outR, 0.01) <= 0.02;
    const pixelClose = Math.abs(ow - tw) / tw <= 0.06 && Math.abs(oh - th) / th <= 0.06;
    if (ratioClose && pixelClose) {
      log.info('[图生] 输出像素已匹配目标（跳过校正）', { ...ctx, px: `${ow}x${oh}`, target: `${tw}x${th}` });
      return;
    }
    log.info('[图生] 输出像素与目标不一致，letterbox 校正', {
      ...ctx,
      before: `${ow}x${oh}`,
      target: `${tw}x${th}`,
    });
    const fmt = (meta.format || '').toLowerCase();
    let pipeline = sharpLib(absPath).rotate().resize(tw, th, {
      fit: 'contain',
      position: 'centre',
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    });
    if (fmt === 'png') {
      await pipeline.png({ compressionLevel: 6 }).toFile(tmp);
    } else if (fmt === 'webp') {
      await pipeline.webp({ quality: 90 }).toFile(tmp);
    } else {
      await pipeline.jpeg({ quality: 92, mozjpeg: true }).toFile(tmp);
    }
    fs.unlinkSync(absPath);
    fs.renameSync(tmp, absPath);
    log.info('[图生] letterbox 校正完成', { ...ctx });
  } catch (e) {
    log.warn('[图生] 输出尺寸校正失败（保留原图）', { ...ctx, error: e.message });
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch (_) {}
  }
}

/**
 * 提取单人正面全身参考图：
 * 若角色参考图是工业四视图/多视图板式（宽屏 16:9，比例 >= 1.45），
 * 扩散模型（如 Qwen-Image / Flux）会因图像包含多姿态（正/背/侧/特写大头/道具特写）而发生注意力串扰，
 * 导致分镜生图中出现多重克隆人、悬浮人头、背向坐姿或重复道具（如双耳机）。
 * 保留角色完整的多角度参考图（原图）：
 * 多角度视图（正面、背面、侧面、面部特写）是模型还原人物 360° 立体特征与服装细节的关键。
 * 不进行破坏性裁切，保证下游视频（MiniMax H3）与图片模型（Qwen-Image-Edit-2511 / FLUX 等）
 * 能够获取完整的多角度参考信息。若历史路径传入了旧缓存的 _front_crop，自动还原为原始大图。
 *
 * @param {string} storageRoot 存储根目录
 * @param {string} charRef 原始参考图路径（相对路径、/static/、绝对路径或 data: URL）
 * @param {object} [log] 日志器
 * @returns {Promise<string>} 原始多角度参考图路径
 */
async function getCleanSingleCharacterRef(storageRoot, charRef, log) {
  if (!charRef || typeof charRef !== 'string') return charRef;
  // 若传入的是历史旧缓存 _front_crop，自动还原为原始多角度参考图
  if (charRef.includes('_front_crop') || charRef.includes('_front_clean')) {
    const orig = charRef.replace(/_front_(?:crop|clean)/g, '');
    return orig;
  }
  return charRef;
}

/**
 * 从场景参考图中提取清爽的单图参考（默认全景远景/establishing wide shot）。
 *
 * 当场景图是通过「场景四视图」生成时，整图是 2×2 四宫格基板（左上=全景远景，右上=中景，左下=特写，右下=备选角度）。
 * 扩散模型（如 Qwen-Image / Flux）会因输入图包含 4 格画面而发生空间布局模仿与注意力串扰，
 * 误以为分镜画面也必须画成四宫格分屏或画中画。
 * 本函数自动识别 2×2 四宫格场景参考图，将左上角（Top-Left：Establishing Wide Shot）
 * 精确裁剪为独立的 16:9 场景主图并缓存到磁盘。
 * 若图片本身已是单图场景，或已裁剪，则直接返回原图。
 *
 * @param {string} storageRoot 存储根目录
 * @param {string} sceneRef 原始参考图路径（相对路径、/static/、绝对路径或 data: URL）
 * @param {number|string} [sceneId] 场景 ID（可选，用于辅助判断四宫格类型）
 * @param {object} [db] 数据库实例（可选）
 * @param {object} [log] 日志器
 * @returns {Promise<string>} 清爽的单图场景参考路径
 */
async function getCleanSingleSceneRef(storageRoot, sceneRef, sceneId, db, log) {
  if (!sceneRef || typeof sceneRef !== 'string') return sceneRef;
  if (sceneRef.includes('_establishing_crop') || sceneRef.includes('_panel0')) {
    return sceneRef;
  }

  let sharpLib;
  try {
    sharpLib = require('sharp');
  } catch (_) {
    return sceneRef;
  }

  try {
    // 1. 判断是否为四宫格场景图
    let isQuadGrid = false;
    if (db) {
      try {
        if (sceneId) {
          const sRow = db.prepare('SELECT reference_image_mode, polished_prompt, prompt FROM scenes WHERE id = ?').get(Number(sceneId));
          if (sRow) {
            if (sRow.reference_image_mode === 'quad_grid') {
              isQuadGrid = true;
            } else if (sRow.reference_image_mode !== 'single') {
              const pText = [sRow.polished_prompt || '', sRow.prompt || ''].join(' ');
              if (/2[×x]2\s*grid|establishing\s+wide|scene\s+environment\s+reference\s+sheet|MANDATORY ART STYLE \(all 4 panels\)|四格统一|四视图/i.test(pText)) {
                isQuadGrid = true;
              }
            }
          }
        }
        if (!isQuadGrid) {
          const staticRel = sceneRef.replace(/^https?:\/\/[^/]+/i, '').replace(/^\/static\//, '');
          const igRow = db.prepare(`
            SELECT prompt, frame_type FROM image_generations
            WHERE local_path = ? OR local_path = ? OR image_url = ?
            ORDER BY id DESC LIMIT 1
          `).get(sceneRef, staticRel, sceneRef);
          if (igRow) {
            if (igRow.frame_type === 'quad_grid') {
              isQuadGrid = true;
            } else if (igRow.prompt && /2[×x]2\s*grid|establishing\s+wide|scene\s+environment\s+reference\s+sheet|MANDATORY ART STYLE \(all 4 panels\)|四格统一|四视图/i.test(igRow.prompt)) {
              isQuadGrid = true;
            }
          }
        }
      } catch (dbErr) {
        if (log) log.warn('[场景参考图] 查询DB四视图标记异常', { error: dbErr.message });
      }
    }

    if (!isQuadGrid) {
      return sceneRef;
    }

    // 2. 如果是 base64 / data:image
    if (sceneRef.startsWith('data:image/')) {
      const parts = sceneRef.split(',');
      if (parts.length < 2) return sceneRef;
      const buf = Buffer.from(parts[1], 'base64');
      const meta = await sharpLib(buf).metadata();
      if (!meta.width || !meta.height) return sceneRef;
      const hw = Math.round(meta.width / 2);
      const hh = Math.round(meta.height / 2);
      const croppedBuf = await sharpLib(buf).extract({ left: 0, top: 0, width: hw, height: hh }).toBuffer();
      if (log) log.info('[场景参考图] 自动从2×2四宫格裁剪左上全景主视图 (data URL)', { orig: `${meta.width}x${meta.height}`, crop: `${hw}x${hh}` });
      return `data:image/png;base64,${croppedBuf.toString('base64')}`;
    }

    // 3. 处理本地文件 / static URL / 绝对路径
    let urlObj = null;
    let effectiveRef = sceneRef;
    if (/^https?:\/\//i.test(sceneRef)) {
      try {
        urlObj = new URL(sceneRef);
        if (urlObj.pathname.startsWith('/static/')) {
          effectiveRef = urlObj.pathname;
        } else {
          return sceneRef;
        }
      } catch (_) {
        return sceneRef;
      }
    }

    const isStatic = effectiveRef.startsWith('/static/');
    const relOrAbs = isStatic ? effectiveRef.replace(/^\/static\//, '') : effectiveRef;
    const absPath = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(storageRoot, decodeURIComponent(relOrAbs));

    if (!fs.existsSync(absPath)) return sceneRef;

    const fileBuf = fs.readFileSync(absPath);
    const meta = await sharpLib(fileBuf).metadata();
    if (!meta.width || !meta.height) return sceneRef;

    const hw = Math.round(meta.width / 2);
    const hh = Math.round(meta.height / 2);

    const ext = path.extname(absPath) || '.png';
    const cropFileName = path.basename(absPath, ext) + '_establishing_crop' + ext;
    const cropAbsPath = path.join(path.dirname(absPath), cropFileName);

    if (!fs.existsSync(cropAbsPath)) {
      await sharpLib(fileBuf).extract({ left: 0, top: 0, width: hw, height: hh }).toFile(cropAbsPath);
      if (log) log.info('[场景参考图] 已从2×2四宫格场景参考图精确提取左上角全景主视图', {
        src: path.basename(absPath),
        crop: cropFileName,
        orig: `${meta.width}x${meta.height}`,
        cropSize: `${hw}x${hh}`,
      });
    }

    if (urlObj) {
      urlObj.pathname = path.posix.join(path.posix.dirname(urlObj.pathname), cropFileName);
      return urlObj.toString();
    } else if (isStatic) {
      return path.posix.join(path.posix.dirname(effectiveRef), cropFileName);
    } else if (path.isAbsolute(sceneRef)) {
      return cropAbsPath;
    } else {
      return path.join(path.dirname(sceneRef), cropFileName).replace(/\\/g, '/');
    }
  } catch (err) {
    if (log) log.warn('[场景参考图] 提取全景主视图失败，使用原图', { error: err.message, ref: sceneRef });
    return sceneRef;
  }
}

module.exports = { splitQuadGridToImages, splitNineGridToImages, normalizeLocalImageToTargetSize, normalizeSavedImageToTargetPixels, getCleanSingleCharacterRef, getCleanSingleSceneRef, aspectRatioToSize };
