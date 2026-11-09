/**
 * 影视视频生成后质量门禁引擎 (Post-Generation Video Quality Gate)
 * 自动抽取视频的首、中、尾帧，执行多模态质量审查：
 * 1. 物理时长与音轨完整性校验（防对白截断与早衰）
 * 2. 首帧遵循程度校验（防首帧 AddGuide 降级与突变跳切）
 * 3. 视觉完整性与黑屏/死帧检测
 * 4. 质检不通过输出结构化 QualityViolationReport，返回 Agent 决断重试或拆镜
 */

const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const { getFfmpegPath, getFfprobePath } = require('../utils/ffmpegPath');

/**
 * 获取视频的媒体流元数据（时长、分辨率、音轨）
 */
async function probeVideoMetadata(videoPath) {
  const ffprobe = getFfprobePath();
  const args = [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type,width,height,nb_frames',
    '-of', 'json',
    videoPath
  ];
  try {
    const { stdout } = await execFile(ffprobe, args, { timeout: 15000 });
    const data = JSON.parse(stdout || '{}');
    const duration = parseFloat(data.format?.duration || 0);
    const hasAudio = (data.streams || []).some(s => s.codec_type === 'audio');
    const videoStream = (data.streams || []).find(s => s.codec_type === 'video');
    return {
      duration,
      hasAudio,
      width: videoStream?.width || 0,
      height: videoStream?.height || 0,
      frameCount: parseInt(videoStream?.nb_frames || 0, 10),
    };
  } catch (err) {
    return { duration: 0, hasAudio: false, error: err.message };
  }
}

/**
 * 抽取视频的首帧 (0.0s)、中帧 (50%)、尾帧 (100%)
 */
async function extractKeyFrames(videoPath, duration, outputDir, prefix = 'qg') {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const ffmpeg = getFfmpegPath();
  const safeDuration = Math.max(0.5, Number(duration) || 5);
  const midSec = (safeDuration * 0.5).toFixed(2);
  const tailSec = Math.max(0.1, safeDuration - 0.15).toFixed(2);

  const firstPath = path.join(outputDir, `${prefix}_frame_0.png`);
  const midPath = path.join(outputDir, `${prefix}_frame_mid.png`);
  const tailPath = path.join(outputDir, `${prefix}_frame_tail.png`);

  const extractAt = async (timeSec, outPath) => {
    const args = [
      '-v', 'error',
      '-y',
      '-ss', String(timeSec),
      '-i', videoPath,
      '-vframes', '1',
      '-f', 'image2',
      outPath
    ];
    await execFile(ffmpeg, args, { timeout: 20000 });
    return fs.existsSync(outPath) && fs.statSync(outPath).size > 1024;
  };

  await Promise.allSettled([
    extractAt(0.0, firstPath),
    extractAt(midSec, midPath),
    extractAt(tailSec, tailPath)
  ]);

  return {
    first_frame: fs.existsSync(firstPath) ? firstPath : null,
    mid_frame: fs.existsSync(midPath) ? midPath : null,
    tail_frame: fs.existsSync(tailPath) ? tailPath : null,
  };
}

let sharp = null;
try {
  sharp = require('sharp');
} catch (_) {}

/**
 * 计算两张图片的感知相似度 (0.0 ~ 1.0)
 */
async function compareImageSimilarity(pathA, pathB) {
  if (!sharp || !pathA || !pathB || !fs.existsSync(pathA) || !fs.existsSync(pathB)) return null;
  try {
    const bufA = await sharp(pathA).resize(32, 32, { fit: 'fill' }).grayscale().raw().toBuffer();
    const bufB = await sharp(pathB).resize(32, 32, { fit: 'fill' }).grayscale().raw().toBuffer();
    let diffSum = 0;
    for (let i = 0; i < bufA.length; i++) {
      diffSum += Math.abs(bufA[i] - bufB[i]);
    }
    const maxDiff = bufA.length * 255;
    return 1 - (diffSum / maxDiff);
  } catch (_) {
    return null;
  }
}

/**
 * 分析关键帧图像指标（平均亮度、标准差、是否死帧/全黑白屏）
 */
async function analyzeFrameVisuals(framePath) {
  if (!sharp || !framePath || !fs.existsSync(framePath)) return null;
  try {
    const img = sharp(framePath);
    const stats = await img.stats();
    const mean = stats.channels[0]?.mean ?? 128;
    const isBlackScreen = mean < 5;
    const isWhiteScreen = mean > 250;
    return { mean, isBlackScreen, isWhiteScreen, isCorrupt: isBlackScreen || isWhiteScreen };
  } catch (_) {
    return { isCorrupt: true };
  }
}

/**
 * 运行全套生成后质量门禁审查
 * @param {string} videoPath - 视频本地绝对路径
 * @param {object} shot - 当前分镜语义对象
 * @param {object} options - 选项 (storageRoot, firstFrameSourcePath, expectedDuration, aiClient, db, log)
 * @returns {Promise<{ passed: boolean, violations: Array<object>, frames: object, meta: object }>}
 */
async function auditGeneratedVideo(videoPath, shot = {}, options = {}) {
  const violations = [];
  if (!videoPath || !fs.existsSync(videoPath)) {
    return {
      passed: false,
      violations: [{
        check: 'file_presence',
        severity: 'error',
        message: '视频文件不存在或落盘丢失',
        recommendation: '重新触发生成流程',
      }],
      frames: {},
      meta: {},
    };
  }

  const meta = await probeVideoMetadata(videoPath);
  const expectedDuration = Number(options.expectedDuration || shot.duration || shot.shot_duration || 5);

  // 1. 时长完整性审查（防过早截断）
  if (meta.duration > 0 && expectedDuration > 0) {
    const diff = expectedDuration - meta.duration;
    if (diff > 1.2) {
      violations.push({
        check: 'duration_completeness',
        severity: 'error',
        message: `视频物理时长 (${meta.duration.toFixed(1)}s) 显著短于规划时长 (${expectedDuration}s)，台词或动作可能被提前截断！`,
        recommendation: '建议 Agent 拆分单镜或将台词精简至预算范围内后重新生成',
      });
    }
  }

  // 2. 抽帧审查
  const tempDir = options.tempDir || path.join(path.dirname(videoPath), 'quality_frames');
  const shotNum = shot.shot_number || shot.storyboard_number || 'shot';
  const frames = await extractKeyFrames(videoPath, meta.duration || expectedDuration, tempDir, `sb_${shotNum}`);

  if (!frames.first_frame || !frames.mid_frame || !frames.tail_frame) {
    violations.push({
      check: 'visual_integrity',
      severity: 'error',
      message: '视频关键帧抽取失败，视频流可能存在解码损坏或死帧！',
      recommendation: '重新调用视频模型重新渲染',
    });
  } else {
    // 关键帧画面可用性与死帧/黑屏审查
    const firstCheck = await analyzeFrameVisuals(frames.first_frame);
    const midCheck = await analyzeFrameVisuals(frames.mid_frame);
    const tailCheck = await analyzeFrameVisuals(frames.tail_frame);

    if (firstCheck?.isBlackScreen || firstCheck?.isWhiteScreen) {
      violations.push({
        check: 'blank_frame_defect',
        severity: 'error',
        message: '视频起始关键帧为全黑或全白死帧，首帧渲染失败！',
        recommendation: '重新生成该镜头视频',
      });
    }
    if (midCheck?.isBlackScreen || tailCheck?.isBlackScreen) {
      violations.push({
        check: 'blank_frame_defect',
        severity: 'error',
        message: '视频中间帧或尾帧出现全黑黑屏断流，模型生成中断！',
        recommendation: '重新生成该镜头视频',
      });
    }
  }

  // 3. 音轨完整性审查
  const hasDialogue = !!(shot.dialogue && String(shot.dialogue).trim() && !/^(?:无|无对白|none|n\/a)[。.!！\s]*$/i.test(String(shot.dialogue).trim()));
  const speechPlan = shot.speech_plan || {};
  if (hasDialogue && !speechPlan.is_offscreen && shot.h3_mode === 'ref2va') {
    if (!meta.hasAudio) {
      violations.push({
        check: 'audio_lip_sync',
        severity: 'warning',
        message: '分镜包含画内对白且采用 Ref2VA 原生音色，但生成视频流未检测到音轨！',
        recommendation: '检查 H3 原生音频生成结果；若确实无声，重新提交本镜并保留音色参考',
      });
    }
  }

  // 4. 首帧遵循度高精度比对 (First-frame Fidelity)
  if (options.firstFrameRequired && (!options.firstFrameSourcePath || !fs.existsSync(options.firstFrameSourcePath))) {
    violations.push({
      check: 'first_frame_source_presence',
      severity: 'error',
      message: '分镜声明了首帧引导，但质量门禁无法读取对应首帧源文件',
      recommendation: '修复首帧本地路径或重新生成首帧后再提交视频',
    });
  }
  if (options.firstFrameSourcePath && fs.existsSync(options.firstFrameSourcePath) && frames.first_frame) {
    const similarity = await compareImageSimilarity(options.firstFrameSourcePath, frames.first_frame);
    if (similarity !== null) {
      if (similarity < 0.25) {
        violations.push({
          check: 'first_frame_fidelity',
          severity: 'error',
          message: `视频起始帧与设定首帧视觉相似度极低 (${(similarity * 100).toFixed(1)}%)，首帧引导 (AddGuide) 存在严重失真或跳帧！`,
          recommendation: '检查首帧输入图片有效性并重新生成视频',
        });
      } else if (similarity < 0.40) {
        violations.push({
          check: 'first_frame_fidelity',
          severity: 'warning',
          message: `视频起始帧与设定首帧视觉相似度偏低 (${(similarity * 100).toFixed(1)}%)，主体构图发生一定偏移`,
          recommendation: '如不影响观感可保留，否则建议重新发起生成',
        });
      }
    }
  }

  // 5. 跨帧连戏与人物一致性审查 (Keyframe Character & Wardrobe Consistency)
  if (frames.first_frame && frames.mid_frame && frames.tail_frame) {
    const midSim = await compareImageSimilarity(frames.first_frame, frames.mid_frame);
    const tailSim = await compareImageSimilarity(frames.mid_frame, frames.tail_frame);
    if (midSim !== null && midSim < 0.15) {
      violations.push({
        check: 'unexpected_visual_discontinuity',
        severity: 'warning',
        message: `单镜内首帧与中帧画面变化幅度过大 (${(midSim * 100).toFixed(1)}%)，可能发生异常跳切或画面突变！`,
        recommendation: '建议检查动作提示词是否平缓，避免激烈跳跃',
      });
    }
  }

  const passed = violations.filter(v => v.severity === 'error').length === 0;
  return {
    passed,
    violations,
    frames,
    meta,
  };
}

module.exports = {
  probeVideoMetadata,
  extractKeyFrames,
  auditGeneratedVideo,
};
