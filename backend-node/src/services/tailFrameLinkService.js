const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getFfmpegPath, hasLocalFfmpeg, getFfprobePath } = require('../utils/ffmpegPath');
const { bindStoryboardFrameImage } = require('./storyboardFrameBinding');

function resolveVideoAbsPath(videoLocalPath, cfg) {
  const rawStorage = cfg?.storage?.local_path || './data/storage';
  const storageBase = path.isAbsolute(rawStorage)
    ? rawStorage
    : path.join(process.cwd(), rawStorage);
  let videoAbsPath = path.isAbsolute(videoLocalPath)
    ? videoLocalPath
    : path.join(storageBase, videoLocalPath.replace(/^\/+/, ''));

  if (!fs.existsSync(videoAbsPath)) {
    const cwdPath = path.join(process.cwd(), videoLocalPath.replace(/^\/+/, ''));
    if (fs.existsSync(cwdPath)) {
      videoAbsPath = cwdPath;
    }
  }
  return { videoAbsPath, storageBase };
}

function probeImageDimensions(outputAbsPath) {
  let width = null, height = null;
  try {
    const ffprobe = getFfprobePath && getFfprobePath();
    if (ffprobe) {
      const probe = spawnSync(ffprobe, [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height',
        '-of', 'csv=s=x:p=0',
        outputAbsPath
      ], { encoding: 'utf8' });
      if (probe.stdout) {
        const [w, h] = probe.stdout.trim().split('x');
        width = w ? parseInt(w, 10) : null;
        height = h ? parseInt(h, 10) : null;
      }
    }
  } catch (_) {}
  return { width, height };
}

function extractFrameFromVideo(ffmpeg, videoAbsPath, outputAbsPath, frameKind, log) {
  if (frameKind === 'first') {
    log.info('[首帧衔接] 截取视频首帧', { from: videoAbsPath, to: outputAbsPath });
    const result = spawnSync(ffmpeg, [
      '-ss', '0',
      '-i', videoAbsPath,
      '-frames:v', '1',
      '-q:v', '2',
      '-y',
      outputAbsPath
    ], { encoding: 'utf8', timeout: 30000 });
    return result;
  }

  // 尾帧提取逻辑
  log.info('[尾帧衔接] 开始提取真正的视频最后一帧', { from: videoAbsPath, to: outputAbsPath });
  let result = spawnSync(ffmpeg, [
    '-sseof', '-1',
    '-i', videoAbsPath,
    '-update', '1',
    '-q:v', '2',
    '-y',
    outputAbsPath
  ], { encoding: 'utf8', timeout: 60000 });

  if (result.error || result.status !== 0 || !fs.existsSync(outputAbsPath) || fs.statSync(outputAbsPath).size === 0) {
    log.warn('[尾帧衔接] sseof 方式提取未成功，回退到全视频流解码尾帧', {
      stderr: result.stderr?.slice(-300),
      error: result.error?.message
    });
    result = spawnSync(ffmpeg, [
      '-i', videoAbsPath,
      '-update', '1',
      '-q:v', '2',
      '-y',
      outputAbsPath
    ], { encoding: 'utf8', timeout: 60000 });
  }
  return result;
}

/**
 * 分镜帧衔接服务：
 * - linkTailFrame: 提取当前分镜视频的尾帧，设为下一个分镜的首帧
 * - linkFirstFrame: 提取当前分镜视频的首帧，设为上一个分镜的尾帧
 */
function routes(db, cfg, log) {
  return {
    /**
     * 尾帧衔接：提取当前分镜视频的尾帧，设为下一个分镜的首帧
     */
    linkTailFrame: async (req, res) => {
      try {
        const storyboardId = parseInt(req.params.id, 10);
        const body = req.body || {};
        const dramaId = body.drama_id;

        if (!storyboardId || !dramaId) {
          return res.status(400).json({ error: '缺少必要参数' });
        }

        const video = db.prepare(`
          SELECT id, local_path, video_url FROM video_generations
          WHERE storyboard_id = ? AND status = 'completed' AND deleted_at IS NULL
          ORDER BY created_at DESC LIMIT 1
        `).get(storyboardId);

        if (!video || !video.local_path) {
          return res.status(400).json({ error: '当前分镜没有可用的本地视频文件' });
        }

        const currentSb = db.prepare('SELECT episode_id, storyboard_number FROM storyboards WHERE id = ?').get(storyboardId);
        if (!currentSb) {
          return res.status(404).json({ error: '分镜不存在' });
        }

        const nextSb = db.prepare(`
          SELECT id, storyboard_number FROM storyboards
          WHERE episode_id = ? AND storyboard_number > ? AND deleted_at IS NULL
          ORDER BY storyboard_number ASC LIMIT 1
        `).get(currentSb.episode_id, currentSb.storyboard_number || 0);

        if (!nextSb) {
          return res.status(400).json({ error: '没有下一个分镜可供衔接' });
        }

        if (!hasLocalFfmpeg()) {
          return res.status(500).json({ error: '服务器未安装 ffmpeg，无法提取视频帧' });
        }

        const ffmpeg = getFfmpegPath();
        const { videoAbsPath, storageBase } = resolveVideoAbsPath(video.local_path, cfg);

        if (!fs.existsSync(videoAbsPath)) {
          return res.status(400).json({ error: '视频文件不存在: ' + video.local_path });
        }

        const timestamp = Date.now();
        const outputFileName = `tailframe_${storyboardId}_to_${nextSb.id}_${timestamp}.jpg`;
        const imagesDir = path.join(storageBase, 'media', 'images');
        if (!fs.existsSync(imagesDir)) {
          fs.mkdirSync(imagesDir, { recursive: true });
        }
        const outputAbsPath = path.join(imagesDir, outputFileName);
        const outputRelPath = `media/images/${outputFileName}`;

        const result = extractFrameFromVideo(ffmpeg, videoAbsPath, outputAbsPath, 'last', log);

        if (result.error || result.status !== 0) {
          log.error('[尾帧衔接] ffmpeg 提取失败', { stderr: result.stderr?.slice(-500) });
          return res.status(500).json({ error: 'ffmpeg 提取帧失败: ' + (result.stderr || result.error?.message || '未知错误') });
        }

        if (!fs.existsSync(outputAbsPath) || fs.statSync(outputAbsPath).size === 0) {
          return res.status(500).json({ error: '提取帧后文件未生成或为空' });
        }

        const { width, height } = probeImageDimensions(outputAbsPath);

        const now = new Date().toISOString();
        const prompt = `尾帧衔接：从分镜 #${currentSb.storyboard_number ?? storyboardId} 视频提取的最后一帧`;

        const insert = db.prepare(`
          INSERT INTO image_generations (
            drama_id, episode_id, storyboard_id, prompt, provider, model, status,
            image_url, local_path, width, height,
            created_at, updated_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const filesBase = cfg?.storage?.base_url || cfg?.files?.base_url || '';
        const imageUrl = filesBase ? `${filesBase.replace(/\/$/, '')}/${outputRelPath}` : `/static/${outputRelPath}`;

        const info = insert.run(
          dramaId,
          currentSb.episode_id,
          nextSb.id,
          prompt,
          'tail-frame',
          'tail-frame-extract',
          'completed',
          imageUrl,
          outputRelPath,
          width,
          height,
          now,
          now,
          now
        );

        const newImageId = info.lastInsertRowid;

        // 绑定为下一个分镜的首帧
        bindStoryboardFrameImage(db, nextSb.id, 'first', newImageId, imageUrl, outputRelPath);

        log.info('[尾帧衔接] 完成', {
          from_storyboard: storyboardId,
          to_storyboard: nextSb.id,
          new_image_id: newImageId
        });

        res.json({
          success: true,
          message: '尾帧衔接成功',
          next_storyboard_id: nextSb.id,
          new_first_frame_image_id: newImageId,
          image_url: imageUrl,
          local_path: outputRelPath
        });

      } catch (err) {
        log.error('storyboards link-tail-frame', { error: err.message, stack: err.stack });
        res.status(500).json({ error: err.message || '尾帧衔接失败' });
      }
    },

    /**
     * 首帧衔接：提取当前分镜视频的首帧，设为上一个分镜的尾帧
     */
    linkFirstFrame: async (req, res) => {
      try {
        const storyboardId = parseInt(req.params.id, 10);
        const body = req.body || {};
        const dramaId = body.drama_id;

        if (!storyboardId || !dramaId) {
          return res.status(400).json({ error: '缺少必要参数' });
        }

        const video = db.prepare(`
          SELECT id, local_path, video_url FROM video_generations
          WHERE storyboard_id = ? AND status = 'completed' AND deleted_at IS NULL
          ORDER BY created_at DESC LIMIT 1
        `).get(storyboardId);

        if (!video || !video.local_path) {
          return res.status(400).json({ error: '当前分镜没有可用的本地视频文件' });
        }

        const currentSb = db.prepare('SELECT episode_id, storyboard_number FROM storyboards WHERE id = ?').get(storyboardId);
        if (!currentSb) {
          return res.status(404).json({ error: '分镜不存在' });
        }

        const prevSb = db.prepare(`
          SELECT id, storyboard_number FROM storyboards
          WHERE episode_id = ? AND storyboard_number < ? AND deleted_at IS NULL
          ORDER BY storyboard_number DESC LIMIT 1
        `).get(currentSb.episode_id, currentSb.storyboard_number || 0);

        if (!prevSb) {
          return res.status(400).json({ error: '没有上一个分镜可供衔接' });
        }

        if (!hasLocalFfmpeg()) {
          return res.status(500).json({ error: '服务器未安装 ffmpeg，无法提取视频帧' });
        }

        const ffmpeg = getFfmpegPath();
        const { videoAbsPath, storageBase } = resolveVideoAbsPath(video.local_path, cfg);

        if (!fs.existsSync(videoAbsPath)) {
          return res.status(400).json({ error: '视频文件不存在: ' + video.local_path });
        }

        const timestamp = Date.now();
        const outputFileName = `firstframe_${storyboardId}_to_${prevSb.id}_${timestamp}.jpg`;
        const imagesDir = path.join(storageBase, 'media', 'images');
        if (!fs.existsSync(imagesDir)) {
          fs.mkdirSync(imagesDir, { recursive: true });
        }
        const outputAbsPath = path.join(imagesDir, outputFileName);
        const outputRelPath = `media/images/${outputFileName}`;

        const result = extractFrameFromVideo(ffmpeg, videoAbsPath, outputAbsPath, 'first', log);

        if (result.error || result.status !== 0) {
          log.error('[首帧衔接] ffmpeg 提取失败', { stderr: result.stderr?.slice(-500) });
          return res.status(500).json({ error: 'ffmpeg 提取帧失败: ' + (result.stderr || result.error?.message || '未知错误') });
        }

        if (!fs.existsSync(outputAbsPath) || fs.statSync(outputAbsPath).size === 0) {
          return res.status(500).json({ error: '提取帧后文件未生成或为空' });
        }

        const { width, height } = probeImageDimensions(outputAbsPath);

        const now = new Date().toISOString();
        const prompt = `首帧衔接：从分镜 #${currentSb.storyboard_number ?? storyboardId} 视频提取的第一帧`;

        const insert = db.prepare(`
          INSERT INTO image_generations (
            drama_id, episode_id, storyboard_id, prompt, provider, model, status,
            image_url, local_path, width, height,
            created_at, updated_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const filesBase = cfg?.storage?.base_url || cfg?.files?.base_url || '';
        const imageUrl = filesBase ? `${filesBase.replace(/\/$/, '')}/${outputRelPath}` : `/static/${outputRelPath}`;

        const info = insert.run(
          dramaId,
          currentSb.episode_id,
          prevSb.id,
          prompt,
          'first-frame',
          'first-frame-extract',
          'completed',
          imageUrl,
          outputRelPath,
          width,
          height,
          now,
          now,
          now
        );

        const newImageId = info.lastInsertRowid;

        // 绑定为上一个分镜的尾帧 (frameType = 'last')
        bindStoryboardFrameImage(db, prevSb.id, 'last', newImageId, imageUrl, outputRelPath);

        log.info('[首帧衔接] 完成', {
          from_storyboard: storyboardId,
          to_storyboard: prevSb.id,
          new_image_id: newImageId
        });

        res.json({
          success: true,
          message: '首帧衔接成功',
          prev_storyboard_id: prevSb.id,
          new_last_frame_image_id: newImageId,
          image_url: imageUrl,
          local_path: outputRelPath
        });

      } catch (err) {
        log.error('storyboards link-first-frame', { error: err.message, stack: err.stack });
        res.status(500).json({ error: err.message || '首帧衔接失败' });
      }
    }
  };
}

module.exports = routes;
