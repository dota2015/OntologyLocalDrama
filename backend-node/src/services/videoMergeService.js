const path = require('path');
const fs = require('fs');
const { getFfmpegPath, getFfprobePath, hasLocalFfmpeg } = require('../utils/ffmpegPath');
const storageLayout = require('./storageLayout');

function list(db, query) {
  let sql = 'FROM video_merges WHERE deleted_at IS NULL';
  const params = [];
  if (query.episode_id) {
    sql += ' AND episode_id = ?';
    params.push(query.episode_id);
  }
  if (query.drama_id) {
    sql += ' AND drama_id = ?';
    params.push(query.drama_id);
  }
  const rows = db.prepare('SELECT * ' + sql + ' ORDER BY created_at DESC').all(...params);
  return rows.map(rowToItem);
}

function rowToItem(r) {
  return {
    id: r.id,
    episode_id: r.episode_id,
    drama_id: r.drama_id,
    title: r.title,
    provider: r.provider,
    status: r.status,
    merged_url: r.merged_url,
    duration: r.duration ?? undefined,
    task_id: r.task_id,
    error_msg: r.error_msg ?? undefined,
    created_at: r.created_at,
    completed_at: r.completed_at,
  };
}

function getById(db, id) {
  const r = db.prepare('SELECT * FROM video_merges WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  return r ? rowToItem(r) : null;
}

function create(db, log, req) {
  const now = new Date().toISOString();
  const mergeOptions = req.merge_options && typeof req.merge_options === 'object' ? { ...req.merge_options } : {};
  // Read episode settings on the server; freeze them for this merge job.
  delete mergeOptions.background_music;
  if (req.episode_id) {
    const music = require('./backgroundMusicService').snapshot(db, req.episode_id, getStorageRoot());
    if (music) mergeOptions.background_music = music;
  }
  const taskService = require('./taskService');
  const task = taskService.createTask(db, log, 'video_merge', String(req.episode_id || ''));
  const mergeOptionsJson = (() => {
    const o = mergeOptions;
    if (o && typeof o === 'object') return JSON.stringify(o);
    return '{}';
  })();
  const info = db.prepare(
    `INSERT INTO video_merges (episode_id, drama_id, title, provider, model, status, scenes, merge_options, task_id, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
  ).run(
    Number(req.episode_id) || 0,
    Number(req.drama_id) || 0,
    req.title ?? null,
    req.provider || 'ffmpeg',
    req.model ?? null,
    req.scenes ? JSON.stringify(req.scenes) : '[]',
    mergeOptionsJson,
    task.id,
    now
  );
  return { merge_id: info.lastInsertRowid, task_id: task.id, ...getById(db, info.lastInsertRowid) };
}

function deleteById(db, log, id) {
  const now = new Date().toISOString();
  const result = db.prepare('UPDATE video_merges SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, Number(id));
  return result.changes > 0;
}

/** 获取 storage 根目录（绝对路径） */
function getStorageRoot() {
  const loadConfig = require('../config').loadConfig;
  const cfg = loadConfig();
  const p = cfg.storage?.local_path || './data/storage';
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

function isVideoFile(p) {
  if (!p || typeof p !== 'string') return false;
  const clean = p.split('?')[0].toLowerCase();
  return clean.endsWith('.mp4') || clean.endsWith('.webm') || clean.endsWith('.mov') || clean.endsWith('.mkv') || clean.endsWith('.m4v');
}

/** 将 video_url 解析为本地文件路径，或下载到 temp 返回路径 */
async function resolveVideoToLocalPath(videoUrl, baseUrl, storageRoot, tempDir, index, log) {
  if (!videoUrl || typeof videoUrl !== 'string') return null;
  const u = videoUrl.trim();
  // 严格过滤：若 URL 本身是图片文件（如 tailframe_xxx.jpg），拒绝加入视频合成
  const cleanUrl = u.split('?')[0].toLowerCase();
  if (cleanUrl.endsWith('.jpg') || cleanUrl.endsWith('.jpeg') || cleanUrl.endsWith('.png') || cleanUrl.endsWith('.webp') || cleanUrl.endsWith('.gif')) {
    log.warn('Video merge: skipped non-video image input', { index, url: u });
    return null;
  }

  // 1) URL 以 baseUrl 开头（如 http://localhost:5679/static）-> 对应 storageRoot 下相对路径
  if (baseUrl && (u.startsWith(baseUrl) || u.startsWith(baseUrl.replace(/\/$/, '')))) {
    const base = baseUrl.replace(/\/$/, '');
    const rel = u.startsWith(base + '/') ? u.slice(base.length + 1) : u.slice(base.length).replace(/^\//, '');
    if (rel && !rel.startsWith('http')) {
      const localPath = path.join(storageRoot, rel.replace(/\//g, path.sep));
      if (fs.existsSync(localPath) && isVideoFile(localPath)) {
        log.info('Video merge: using local static file', { index, path: localPath });
        return localPath;
      }
    }
  }
  // 2) 已是本地绝对路径且存在
  if (path.isAbsolute(u) && fs.existsSync(u) && isVideoFile(u)) {
    log.info('Video merge: using absolute path', { index, path: u });
    return u;
  }
  // 3) 相对路径（相对 storageRoot）
  if (!u.startsWith('http://') && !u.startsWith('https://')) {
    const localPath = path.join(storageRoot, u.replace(/^\//, '').replace(/\//g, path.sep));
    if (fs.existsSync(localPath) && isVideoFile(localPath)) {
      log.info('Video merge: using relative path', { index, path: localPath });
      return localPath;
    }
  }
  // 4) 远程 URL：下载到 temp
  const ext = u.includes('.mp4') ? '.mp4' : u.includes('.webm') ? '.webm' : '.mp4';
  const destPath = path.join(tempDir, `dl_${Date.now()}_${index}${ext}`);
  try {
    const res = await fetch(u, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(destPath, buf);
    log.info('Video merge: downloaded to temp', { index, dest: destPath });
    return destPath;
  } catch (e) {
    log.warn('Video merge: download failed', { index, url: u, error: e.message });
    return null;
  }
}

/**
 * ffmpeg concat 参数构造：
 * - 默认 `-c copy` 流拷贝：快且无损，但要求各片段编码参数一致；
 * - transcode：重编码兜底。AI 分镜片段常出现编码/分辨率/采样率不一致，
 *   流拷贝 concat 会直接失败，整集退化成只有首段（issue #21 / #14）。
 */
function buildConcatArgs(listFile, outputPath, transcode = false) {
  if (!transcode) {
    return ['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-y', outputPath];
  }
  return [
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '44100', '-ac', '2',
    '-movflags', '+faststart',
    '-y', outputPath,
  ];
}

function runFfmpegConcatOnce(listFile, outputPath, transcode, log) {
  const ffmpegBin = getFfmpegPath();
  const { spawnSync } = require('child_process');
  const result = spawnSync(ffmpegBin, buildConcatArgs(listFile, outputPath, transcode), {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) {
    log.warn('Video merge: ffmpeg spawn error', { error: result.error.message, transcode: !!transcode });
    return false;
  }
  if (result.status !== 0) {
    log.warn('Video merge: ffmpeg failed', {
      transcode: !!transcode,
      stderr: result.stderr?.slice(-500),
    });
    return false;
  }
  return true;
}

// Wan is silent; H3 includes audio. Match streams/time bases before concat so
// a silent first clip cannot cause all subsequent H3 audio to disappear.
function normalizeMixedAudio(localPaths, directory, log) {
  const { spawnSync } = require('child_process');
  const probes = localPaths.map(file => {
    const result = spawnSync(getFfprobePath(), ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file], { encoding: 'utf8' });
    try { const parsed = JSON.parse(result.stdout); return { audio: parsed.streams.some(s => s.codec_type === 'audio'), duration: Number(parsed.format.duration) }; } catch (_) { return null; }
  });
  if (probes.some(p => !p || !(p.duration > 0))) return null;
  if (probes.every(p => p.audio) || probes.every(p => !p.audio)) return localPaths;
  const files = [];
  for (let i = 0; i < localPaths.length; i++) {
    const output = path.join(directory, `mixed_audio_${Date.now()}_${i}.mp4`);
    const inputs = probes[i].audio ? ['-i', localPaths[i], '-map', '0:v:0', '-map', '0:a:0']
      : ['-i', localPaths[i], '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-map', '0:v:0', '-map', '1:a:0'];
    const result = spawnSync(getFfmpegPath(), ['-y', ...inputs, '-c:v', 'copy', '-video_track_timescale', '90000', '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-af', 'apad', '-t', String(probes[i].duration), output], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    if (result.status !== 0) {
      log.warn('Video merge: mixed audio normalization failed', { index: i, stderr: result.stderr?.slice(-500) });
      for (const file of [...files, output]) { try { fs.unlinkSync(file); } catch (_) {} }
      return null;
    }
    files.push(output);
  }
  return files;
}

/** 使用 ffmpeg concat 合并多个视频文件：先流拷贝，失败再重编码兜底 */
function runFfmpegConcat(localPaths, outputPath, log) {
  const listFile = path.join(path.dirname(outputPath), `concat_list_${Date.now()}.txt`);
  let normalizedPaths = [];
  try {
    const pathsForConcat = normalizeMixedAudio(localPaths, path.dirname(outputPath), log);
    if (!pathsForConcat) return false;
    normalizedPaths = pathsForConcat.filter(p => !localPaths.includes(p));
    const lines = pathsForConcat.map((p) => {
      const normalized = p.replace(/\\/g, '/');
      return `file '${normalized.replace(/'/g, "'\\''")}'`;
    });
    fs.writeFileSync(listFile, lines.join('\n'), 'utf8');
    if (runFfmpegConcatOnce(listFile, outputPath, false, log)) return true;
    log.warn('Video merge: stream copy concat failed, retrying with re-encode', {
      clip_count: localPaths.length,
    });
    return runFfmpegConcatOnce(listFile, outputPath, true, log);
  } finally {
    try { if (fs.existsSync(listFile)) fs.unlinkSync(listFile); } catch (_) {}
    for (const file of normalizedPaths) { try { fs.unlinkSync(file); } catch (_) {} }
  }
}

/**
 * 为合成视频末尾追加指定秒数的纯黑屏（默认 1 秒）与静音缓冲，
 * 解决上传至社交平台（抖音、微信视频号、快手、小红书等）时因平台播放器提前循环或截断导致结尾画面/对白被吞的问题。
 */
function appendBlackTail(videoPath, tailSec = 1.0, log) {
  if (!fs.existsSync(videoPath) || tailSec <= 0) return false;
  const ffmpeg = getFfmpegPath();
  const ffprobe = getFfprobePath();
  if (!ffmpeg || !ffprobe) return false;

  const { spawnSync } = require('child_process');
  const probe = spawnSync(
    ffprobe,
    ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', videoPath],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 }
  );
  if (probe.status !== 0) {
    if (log && log.warn) log.warn('appendBlackTail: ffprobe failed', { videoPath });
    return false;
  }

  let duration = 0;
  let hasAudio = false;
  try {
    const meta = JSON.parse(probe.stdout);
    duration = parseFloat(meta.format?.duration) || 0;
    hasAudio = Array.isArray(meta.streams) && meta.streams.some(s => s.codec_type === 'audio');
  } catch (_) {
    return false;
  }

  if (duration <= 0.05) return false;
  const targetDuration = (duration + tailSec).toFixed(3);
  const outPath = path.join(path.dirname(videoPath), `tailpad_${Date.now()}_${path.basename(videoPath)}`);

  const filterComplex = hasAudio
    ? `[0:v]tpad=stop_mode=add:stop_duration=${tailSec}:color=black[v];[0:a]apad,atrim=0:${targetDuration}[a]`
    : `[0:v]tpad=stop_mode=add:stop_duration=${tailSec}:color=black[v]`;

  const args = [
    '-y',
    '-i', videoPath,
    '-filter_complex', filterComplex,
    '-map', '[v]',
  ];

  if (hasAudio) {
    args.push('-map', '[a]', '-c:a', 'aac', '-b:a', '192k', '-ar', '44100');
  } else {
    args.push('-an');
  }

  args.push(
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outPath
  );

  const res = spawnSync(ffmpeg, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (res.status !== 0 || !fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
    if (log && log.warn) log.warn('appendBlackTail: ffmpeg failed', { stderr: res.stderr?.slice(-500) });
    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (_) {}
    return false;
  }

  try {
    fs.copyFileSync(outPath, videoPath);
    fs.unlinkSync(outPath);
    return true;
  } catch (e) {
    if (log && log.warn) log.warn('appendBlackTail: replace file failed', { error: e.message });
    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (_) {}
    return false;
  }
}

/**
 * 异步处理视频合成：优先使用 ffmpeg 真正合并多段视频；失败或无 ffmpeg 时用首段作为 merged_url。
 */
async function processVideoMerge(db, log, mergeId, baseUrl) {
  const r = db.prepare('SELECT * FROM video_merges WHERE id = ? AND deleted_at IS NULL').get(mergeId);
  if (!r) return;
  const taskId = r.task_id;
  const episodeId = r.episode_id;
  let scenes = [];
  try {
    scenes = JSON.parse(r.scenes || '[]');
  } catch (_) {
    log.warn('video merge parse scenes failed', { merge_id: mergeId });
  }
  const now = new Date().toISOString();
  db.prepare('UPDATE video_merges SET status = ? WHERE id = ?').run('processing', mergeId);
  const taskService = require('./taskService');
  if (scenes.length === 0) {
    db.prepare('UPDATE video_merges SET status = ?, error_msg = ? WHERE id = ?').run('failed', '无有效视频片段', mergeId);
    if (taskId) taskService.updateTaskError(db, taskId, '无有效视频片段');
    return;
  }
  const first = scenes[0];
  const mergedUrlFallback = first && first.video_url ? first.video_url : null;
  if (!mergedUrlFallback) {
    db.prepare('UPDATE video_merges SET status = ?, error_msg = ? WHERE id = ?').run('failed', '首段无视频地址', mergeId);
    if (taskId) taskService.updateTaskError(db, taskId, '首段无视频地址');
    return;
  }

  const totalDuration = scenes.reduce((sum, s) => sum + (Number(s.duration) || 0), 0);
  const storageRoot = getStorageRoot();
  const tempDir = path.join(require('os').tmpdir(), 'drama-video-merge');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const localPaths = [];
  const toCleanup = [];
  for (let i = 0; i < scenes.length; i++) {
    const p = await resolveVideoToLocalPath(
      scenes[i].video_url,
      baseUrl,
      storageRoot,
      tempDir,
      i,
      log
    );
    if (p) {
      localPaths.push(p);
      if (p.startsWith(tempDir)) toCleanup.push(p);
    }
  }

  const ffmpegAvailable = hasLocalFfmpeg();
  log.info('Video merge: ffmpeg check', {
    merge_id: mergeId,
    has_ffmpeg: ffmpegAvailable,
    ffmpeg_path: getFfmpegPath(),
    local_video_count: localPaths.length,
    cwd: process.cwd(),
  });

  let mergedRelativePath = null;
  if (localPaths.length > 0 && ffmpegAvailable && localPaths.length <= 100) {
    const projectSubdir = storageLayout.getProjectStorageSubdir(db, r.drama_id);
    const sub = projectSubdir && String(projectSubdir).trim();
    const mergedDir = sub
      ? path.join(storageRoot, sub, 'videos', 'merged')
      : path.join(storageRoot, 'videos', 'merged');
    if (!fs.existsSync(mergedDir)) fs.mkdirSync(mergedDir, { recursive: true });
    const outputFileName = `merged_${Date.now()}.mp4`;
    const outputPath = path.join(mergedDir, outputFileName);
    const ok = runFfmpegConcat(localPaths, outputPath, log);
    if (ok && fs.existsSync(outputPath)) {
      mergedRelativePath = sub
        ? path.join(sub, 'videos', 'merged', outputFileName).replace(/\\/g, '/')
        : path.join('videos', 'merged', outputFileName).replace(/\\/g, '/');
      log.info('Video merge completed (ffmpeg)', { merge_id: mergeId, episode_id: episodeId, output: mergedRelativePath });
    }
  }

  let mergeOpts = {};
  try {
    mergeOpts = JSON.parse(r.merge_options || '{}');
  } catch (_) {
    mergeOpts = {};
  }
  const postNeed =
    !!mergeOpts.burn_narration_subtitles
    || !!mergeOpts.burn_dialogue_audio
    || !!mergeOpts.background_music?.enabled
    || !!(mergeOpts.watermark_text && String(mergeOpts.watermark_text).trim());
  if (mergedRelativePath && ffmpegAvailable && postNeed) {
    const mergedAbsPath = path.join(storageRoot, mergedRelativePath.replace(/\//g, path.sep));
    if (fs.existsSync(mergedAbsPath)) {
      const mergedPP = require('./mergedEpisodePostProcess');
      const post = await mergedPP.runMergedEpisodePostProcess(db, log, {
        mergedAbsPath,
        sceneSourcePaths: localPaths.length === scenes.length ? localPaths : undefined,
        storageRoot,
        scenes,
        episodeId,
        mergeOpts,
      });
      if (post.ok && post.relativePath) {
        mergedRelativePath = post.relativePath;
        log.info('Video merge: merged episode post-process', { merge_id: mergeId, out: mergedRelativePath });
      } else if (post.error && post.error !== 'NO_POST_OPTS') {
        log.warn('Video merge: post-process failed', { merge_id: mergeId, err: post.error });
        db.prepare('UPDATE video_merges SET status = ?, error_msg = ? WHERE id = ?').run('failed', post.error, mergeId);
        if (taskId) taskService.updateTaskError(db, taskId, post.error);
        for (const file of toCleanup) { try { fs.unlinkSync(file); } catch (_) {} }
        return;
      }
    }
  }

  // 末尾追加防裁切的 1 秒黑屏画面（默认开启 1.0 秒，支持 merge_options.tail_black_seconds 配置）
  const tailBlackSec = mergeOpts.tail_black_seconds !== undefined
    ? Math.max(0, Number(mergeOpts.tail_black_seconds) || 0)
    : 1.0;
  if (mergedRelativePath && ffmpegAvailable && tailBlackSec > 0) {
    const finalAbs = path.join(storageRoot, mergedRelativePath.replace(/\//g, path.sep));
    if (fs.existsSync(finalAbs)) {
      const padded = appendBlackTail(finalAbs, tailBlackSec, log);
      if (padded) {
        log.info('Video merge: appended black screen tail', { merge_id: mergeId, episode_id: episodeId, tail_seconds: tailBlackSec });
      }
    }
  }

  for (const p of toCleanup) {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
  }

  const finalMergedUrl = mergedRelativePath || mergedUrlFallback;
  let finalDuration = Math.round(totalDuration) || null;
  if (mergedRelativePath) {
    const finalAbs = path.join(storageRoot, mergedRelativePath.replace(/\//g, path.sep));
    const probe = getFfprobePath();
    if (probe && fs.existsSync(finalAbs)) {
      try {
        const { spawnSync } = require('child_process');
        const rprobe = spawnSync(
          probe,
          ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', finalAbs],
          { encoding: 'utf8' }
        );
        const actualD = parseFloat(String(rprobe.stdout || '').trim());
        if (Number.isFinite(actualD) && actualD > 0) {
          finalDuration = Math.round(actualD);
        }
      } catch (_) {}
    }
  }

  db.prepare(
    'UPDATE video_merges SET status = ?, merged_url = ?, duration = ?, completed_at = ?, error_msg = ? WHERE id = ?'
  ).run('completed', finalMergedUrl, finalDuration, now, null, mergeId);
  db.prepare('UPDATE episodes SET video_url = ?, status = ?, updated_at = ? WHERE id = ?').run(finalMergedUrl, 'completed', now, episodeId);
  if (taskId) {
    taskService.updateTaskResult(db, taskId, { merge_id: mergeId, video_url: finalMergedUrl, duration: finalDuration });
  }
  if (!mergedRelativePath) {
    log.info('Video merge completed (first-clip fallback)', { merge_id: mergeId, episode_id: episodeId });
  }
}

module.exports = {
  list,
  getById,
  create,
  deleteById,
  processVideoMerge,
  buildConcatArgs,
  runFfmpegConcat,
  appendBlackTail,
};
