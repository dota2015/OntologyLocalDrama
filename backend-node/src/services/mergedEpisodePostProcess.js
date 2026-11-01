/**
 * 整集合并后的后处理：独立字幕、可选 TTS 替换音轨、右下角文字水印。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getFfmpegPath, getFfprobePath } = require('../utils/ffmpegPath');

function ffprobeDurationSec(filePath) {
  const probe = getFfprobePath();
  const r = spawnSync(
    probe,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 }
  );
  if (r.status !== 0) return null;
  const d = parseFloat(String(r.stdout || '').trim());
  return Number.isFinite(d) && d > 0 ? d : null;
}

function ffprobeVideoStreamDurationSec(filePath) {
  const probe = getFfprobePath();
  if (!probe) return ffprobeDurationSec(filePath);
  const r = spawnSync(
    probe,
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration,nb_frames,r_frame_rate', '-of', 'json', filePath],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 }
  );
  if (r.status === 0) {
    try {
      const data = JSON.parse(r.stdout);
      const vs = data.streams?.[0];
      if (vs) {
        if (vs.nb_frames && vs.r_frame_rate) {
          const [num, den] = vs.r_frame_rate.split('/').map(Number);
          if (num > 0 && den > 0) {
            const d = parseInt(vs.nb_frames, 10) / (num / den);
            if (d > 0.05) return d;
          }
        }
        const d = parseFloat(vs.duration);
        if (Number.isFinite(d) && d > 0.05) return d;
      }
    } catch (_) {}
  }
  return ffprobeDurationSec(filePath);
}

function formatSrtTimestamp(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const z = Math.floor(ms % 1000);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(h)}:${p2(m)}:${p2(s)},${String(z).padStart(3, '0')}`;
}

function buildAtempoChain(factor) {
  if (!Number.isFinite(factor) || factor <= 0) return null;
  if (Math.abs(factor - 1) < 0.002) return null;
  const parts = [];
  let f = factor;
  while (f > 2.001) {
    parts.push('atempo=2');
    f /= 2;
  }
  while (f < 0.499) {
    parts.push('atempo=0.5');
    f /= 0.5;
  }
  parts.push(`atempo=${Math.min(2, Math.max(0.5, f))}`);
  return parts.join(',');
}

function escapeFfmpegPath(absPath) {
  let s = path.resolve(absPath).replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(s)) s = s.replace(/^([A-Za-z]):/, '$1\\:');
  return s.replace(/'/g, "\\'");
}

function runFfmpeg(args, log, tag) {
  const bin = getFfmpegPath();
  const r = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.error) {
    log.warn('merged post: ffmpeg spawn', { tag, error: r.error.message });
    return false;
  }
  if (r.status !== 0) {
    log.warn('merged post: ffmpeg failed', { tag, stderr: r.stderr?.slice(-1000) });
    return false;
  }
  return true;
}

function writeSilenceMp3(slotSec, outPath, log) {
  return runFfmpeg(
    ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', String(slotSec), '-c:a', 'libmp3lame', '-q:a', '6', outPath],
    log,
    'silence'
  );
}

function fitAudioToSlot(inputPath, slotSec, outPath, log) {
  const d = ffprobeDurationSec(inputPath);
  if (d == null || d <= 0.01) return false;
  const eps = 0.06;
  if (d > slotSec + eps) {
    const factor = d / slotSec;
    const chain = buildAtempoChain(factor);
    const af = chain || 'anull';
    return runFfmpeg(
      ['-y', '-i', inputPath, '-af', af, '-t', String(slotSec), '-c:a', 'libmp3lame', '-q:a', '4', outPath],
      log,
      'fit_speed'
    );
  }
  if (d < slotSec - eps) {
    const pad = slotSec - d;
    return runFfmpeg(
      ['-y', '-i', inputPath, '-af', `apad=pad_dur=${pad}`, '-t', String(slotSec), '-c:a', 'libmp3lame', '-q:a', '4', outPath],
      log,
      'fit_pad'
    );
  }
  try {
    fs.copyFileSync(inputPath, outPath);
    return true;
  } catch (_) {
    return runFfmpeg(
      ['-y', '-i', inputPath, '-t', String(slotSec), '-c:a', 'libmp3lame', '-q:a', '4', outPath],
      log,
      'fit_copy'
    );
  }
}

function concatMp3List(segmentPaths, outPath, log) {
  const listFile = path.join(path.dirname(outPath), `mix_concat_${Date.now()}.txt`);
  try {
    const lines = segmentPaths.map((p) => {
      const normalized = path.resolve(p).replace(/\\/g, '/');
      return `file '${normalized.replace(/'/g, "'\\''")}'`;
    });
    fs.writeFileSync(listFile, lines.join('\n'), 'utf8');
    return runFfmpeg(
      ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:a', 'libmp3lame', '-q:a', '4', outPath],
      log,
      'concat_mix'
    );
  } finally {
    try {
      if (fs.existsSync(listFile)) fs.unlinkSync(listFile);
    } catch (_) {}
  }
}

function alignAudioToVideoDuration(inMp3, videoDur, outPath, log) {
  const n = ffprobeDurationSec(inMp3);
  if (n == null || !Number.isFinite(videoDur) || videoDur <= 0.1) return false;
  const eps = 0.08;
  if (n > videoDur + eps) {
    const factor = n / videoDur;
    const chain = buildAtempoChain(factor);
    if (!chain) {
      try {
        fs.copyFileSync(inMp3, outPath);
        return true;
      } catch (_) {
        return false;
      }
    }
    return runFfmpeg(
      ['-y', '-i', inMp3, '-af', chain, '-t', String(videoDur), '-c:a', 'libmp3lame', '-q:a', '4', outPath],
      log,
      'align_speed'
    );
  }
  if (n < videoDur - eps) {
    const pad = videoDur - n;
    return runFfmpeg(
      ['-y', '-i', inMp3, '-af', `apad=pad_dur=${pad}`, '-t', String(videoDur), '-c:a', 'libmp3lame', '-q:a', '4', outPath],
      log,
      'align_pad'
    );
  }
  try {
    fs.copyFileSync(inMp3, outPath);
    return true;
  } catch (_) {
    return false;
  }
}

function amixTwoTracks(pathA, pathB, slotSec, outPath, log) {
  return runFfmpeg(
    [
      '-y', '-i', pathA, '-i', pathB,
      '-filter_complex', `[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=2[aout]`,
      '-map', '[aout]',
      '-t', String(slotSec),
      '-c:a', 'libmp3lame', '-q:a', '4',
      outPath,
    ],
    log,
    'amix_seg'
  );
}

function getDrawtextFontOption() {
  const candidates = [];
  if (process.platform === 'win32') {
    const root = process.env.SystemRoot || 'C:\\Windows';
    candidates.push(
      path.join(root, 'Fonts', 'msyh.ttc'),
      path.join(root, 'Fonts', 'msyhbd.ttc'),
      path.join(root, 'Fonts', 'simhei.ttf')
    );
  }
  candidates.push('/System/Library/Fonts/PingFang.ttc', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf');
  for (const p of candidates) {
    if (p && fs.existsSync(p)) {
      return `:fontfile='${escapeFfmpegPath(p)}'`;
    }
  }
  return '';
}

/**
 * @param {object} mergeOpts — burn_subtitles, burn_dialogue_audio, burn_narration_audio, watermark_text
 */
async function runMergedEpisodePostProcess(db, log, opts) {
  const { mergedAbsPath, storageRoot, scenes, episodeId, mergeOpts = {} } = opts;
  const wantDial = !!mergeOpts.burn_dialogue_audio;
  const wantNarr = !!mergeOpts.burn_narration_audio;
  const wantSubs = !!mergeOpts.burn_subtitles;
  const wantMusic = mergeOpts.background_music?.enabled === true;
  const watermarkText = (mergeOpts.watermark_text && String(mergeOpts.watermark_text).trim())
    ? String(mergeOpts.watermark_text).trim().slice(0, 200)
    : '';

  if (!mergedAbsPath || !fs.existsSync(mergedAbsPath) || !Array.isArray(scenes) || scenes.length === 0) {
    return { ok: false, error: '无效合成参数' };
  }

  const needAudio = wantDial || wantNarr;
  if (!needAudio && !wantSubs && !watermarkText && !wantMusic) {
    return { ok: false, error: 'NO_POST_OPTS' };
  }

  const videoDur = ffprobeDurationSec(mergedAbsPath);
  if (videoDur == null) {
    return { ok: false, error: '无法读取合成视频时长' };
  }

  const tempRoot = path.join(require('os').tmpdir(), 'drama-merged-post', String(episodeId || 0), String(Date.now()));
  fs.mkdirSync(tempRoot, { recursive: true });

  try {
    let alignedAudioPath = null;
    let srtPath = null;
    let srtLines = [];

    if (needAudio || wantSubs) {
      let tMs = 0;
      let srtIdx = 1;
      const segmentFiles = [];

      for (let i = 0; i < scenes.length; i++) {
        const sc = scenes[i];
        const sbId = Number(sc.scene_id);
        const actualVideoFile = opts.sceneSourcePaths?.[i];
        let slotSec = Math.max(0.2, Number(sc.duration) || 5);
        if (actualVideoFile && fs.existsSync(actualVideoFile)) {
          const probedDur = ffprobeVideoStreamDurationSec(actualVideoFile);
          if (probedDur != null && probedDur > 0.05) {
            slotSec = probedDur;
          }
        }
        const row = db.prepare(
          'SELECT dialogue, narration, audio_local_path, narration_audio_local_path FROM storyboards WHERE id = ? AND deleted_at IS NULL'
        ).get(sbId);
        if (!row) return { ok: false, error: `分镜 ${sbId} 不存在，无法生成字幕或配音` };

        const speechPlan = require('./dialogueDubbingService').planForId(db, sbId);
        const narrText = speechPlan ? speechPlan.segments.filter(l => l.kind === 'narration').map(l => l.text).join('\n')
          : ((row?.narration && String(row.narration).trim()) ? String(row.narration).trim() : '');
        const subtitleText = (speechPlan?.segments || []).map(line => line.text).filter(Boolean).join('\n');
        if (wantSubs && subtitleText) {
          const durMs = Math.round(slotSec * 1000);
          srtLines.push(String(srtIdx++), `${formatSrtTimestamp(tMs)} --> ${formatSrtTimestamp(tMs + durMs)}`, subtitleText, '');
        }
        tMs += Math.round(slotSec * 1000);
        // Subtitles never require TTS and never replace H3's original audio.
        if (!needAudio) continue;

        const hasDialogue = speechPlan ? speechPlan.segments.some(line => line.kind === 'dialogue') : require('./speechExtractionService').meaningful(row?.dialogue);
        const hasNarration = require('./speechExtractionService').meaningful(narrText);
        if (!(wantDial && hasDialogue) && !(wantNarr && hasNarration)) {
          // Keep H3 music/effects in shots which do not use speech replacement.
          const original = opts.sceneSourcePaths?.[i] || mergedAbsPath;
          const originalSlot = path.join(tempRoot, `original_${i}.mp3`);
          const seek = opts.sceneSourcePaths?.[i] ? 0 : Math.max(0, tMs / 1000 - slotSec);
          if (ffprobeHasAudio(original)) {
            if (!runFfmpeg(['-y', '-ss', String(seek), '-i', original, '-map', '0:a:0', '-af', 'apad', '-t', String(slotSec), '-ar', '44100', '-ac', '1', '-c:a', 'libmp3lame', '-q:a', '4', originalSlot], log, 'preserve_original')) return { ok: false, error: '无对白镜头原声保留失败 #' + i };
          } else if (!writeSilenceMp3(slotSec, originalSlot, log)) return { ok: false, error: '无对白镜头静音片段失败 #' + i };
          segmentFiles.push(originalSlot);
          continue;
        }

        const diaFit = path.join(tempRoot, `dia_fit_${i}.mp3`);
        const narrFit = path.join(tempRoot, `narr_fit_${i}.mp3`);
        const segOut = path.join(tempRoot, `seg_mix_${i}.mp3`);

        if (wantDial) {
          const rel = row?.audio_local_path && String(row.audio_local_path).trim();
          const srcAbs = rel ? path.join(storageRoot, rel.replace(/\//g, path.sep)) : null;
          if (srcAbs && fs.existsSync(srcAbs)) {
            if (!fitAudioToSlot(srcAbs, slotSec, diaFit, log)) {
              return { ok: false, error: `对白配音时长对齐失败 #${i}` };
            }
          } else if (hasDialogue) {
            return { ok: false, error: `分镜 ${sbId} 缺少对白配音文件，请先生成配音，或关闭「替换对白配音」保留原声。` };
          } else if (!writeSilenceMp3(slotSec, diaFit, log)) {
            return { ok: false, error: `对白静音片段失败 #${i}` };
          }
        }

        if (wantNarr) {
          if (!narrText) {
            if (!writeSilenceMp3(slotSec, narrFit, log)) {
              return { ok: false, error: `旁白静音片段失败 #${i}` };
            }
          } else {
            let narrAbs = row?.narration_audio_local_path
              ? path.join(storageRoot, row.narration_audio_local_path.replace(/\//g, path.sep)) : null;
            if (!narrAbs || !fs.existsSync(narrAbs)) {
              try {
                const synth = await require('./dialogueDubbingService').single(db, log, sbId, storageRoot, 'narration');
                narrAbs = path.join(storageRoot, synth.local_path.replace(/\//g, path.sep));
                if (row) row.narration_audio_local_path = synth.local_path;
              } catch (e) {
                return { ok: false, error: '解说旁白 TTS 失败：' + e.message };
              }
            }
            const segRaw = narrAbs;
            if (!fitAudioToSlot(segRaw, slotSec, narrFit, log)) {
              return { ok: false, error: `旁白时长对齐失败 #${i}` };
            }
          }
        }

        if (wantDial && wantNarr) {
          const ordered = require('./speechExtractionService').orderedAudioFiles(db, sbId, row);
          if (ordered && ordered.every(rel => fs.existsSync(path.join(storageRoot, rel)))) {
            const raw = path.join(tempRoot, 'ordered_' + i + '.mp3');
            if (!concatMp3List(ordered.map(rel => path.join(storageRoot, rel)), raw, log) || !fitAudioToSlot(raw, slotSec, segOut, log)) {
              return { ok: false, error: '分镜对白与旁白顺序合成失败 #' + i };
            }
            segmentFiles.push(segOut);
            continue;
          }
          if (!amixTwoTracks(diaFit, narrFit, slotSec, segOut, log)) {
            return { ok: false, error: `对白与旁白混音失败 #${i}` };
          }
        } else if (wantDial) {
          try {
            fs.copyFileSync(diaFit, segOut);
          } catch (_) {
            return { ok: false, error: `对白片段复制失败 #${i}` };
          }
        } else if (wantNarr) {
          try {
            fs.copyFileSync(narrFit, segOut);
          } catch (_) {
            return { ok: false, error: `旁白片段复制失败 #${i}` };
          }
        }

        segmentFiles.push(segOut);
      }

      if (needAudio) {
        const concatOut = path.join(tempRoot, 'full_mix.mp3');
        if (!concatMp3List(segmentFiles, concatOut, log)) {
          return { ok: false, error: '音轨拼接失败' };
        }

        alignedAudioPath = path.join(tempRoot, 'aligned_mix.mp3');
        if (!alignAudioToVideoDuration(concatOut, videoDur, alignedAudioPath, log)) {
          return { ok: false, error: '音轨与视频总时长对齐失败' };
        }
      }

      if (wantSubs && !srtLines.length) {
        return { ok: false, error: '已开启字幕，但所选分镜没有可用的对白或旁白文本。请补全台词，或关闭字幕后重新合成。' };
      }
      if (wantSubs && srtLines.length > 0) {
        const baseName = path.basename(mergedAbsPath, path.extname(mergedAbsPath));
        srtPath = path.join(path.dirname(mergedAbsPath), `${baseName}_subtitles.srt`);
        fs.writeFileSync(srtPath, `\uFEFF${srtLines.join('\n')}\n`, 'utf8');
      }
    }

    const baseName = path.basename(mergedAbsPath, path.extname(mergedAbsPath));
    let outAbs = path.join(path.dirname(mergedAbsPath), `${baseName}_post.mp4`);

    const hasSubs = !!(srtPath && fs.existsSync(srtPath));
    const hasWm = !!watermarkText;

    const vfParts = [];
    if (hasSubs) {
      const subEsc = escapeFfmpegPath(srtPath);
      vfParts.push(`subtitles='${subEsc}':charenc=UTF-8`);
    }
    if (hasWm) {
      const wmFile = path.join(tempRoot, 'watermark.txt');
      fs.writeFileSync(wmFile, watermarkText, 'utf8');
      const wmEsc = escapeFfmpegPath(wmFile);
      const fontOpt = getDrawtextFontOption();
      vfParts.push(
        `drawtext=textfile='${wmEsc}':reload=1${fontOpt}:x=w-tw-16:y=h-th-16:fontsize=22:fontcolor=white@0.82:borderw=2:bordercolor=black@0.55`
      );
    }
    let filterComplex = '';
    if (vfParts.length === 1) {
      filterComplex = `[0:v]${vfParts[0]}[vout]`;
    } else if (vfParts.length === 2) {
      filterComplex = `[0:v]${vfParts[0]}[vx];[vx]${vfParts[1]}[vout]`;
    }

    if (needAudio) {
      if (!alignedAudioPath || !fs.existsSync(alignedAudioPath)) {
        return { ok: false, error: '内部错误：缺少对齐音轨' };
      }
      const args = ['-y', '-i', mergedAbsPath, '-i', alignedAudioPath];
      if (filterComplex) {
        args.push('-filter_complex', filterComplex, '-map', '[vout]', '-map', '1:a');
      } else {
        args.push('-map', '0:v', '-map', '1:a');
      }
      args.push(
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest', outAbs
      );
      if (!runFfmpeg(args, log, 'mux_av')) {
        return { ok: false, error: '烧录字幕/水印或混音失败（请确认 ffmpeg 含 libx264）' };
      }
    } else if (hasSubs || hasWm) {
      if (!filterComplex) {
        return { ok: false, error: '内部错误：字幕/水印缺少滤镜链' };
      }
      const args = ['-y', '-i', mergedAbsPath, '-filter_complex', filterComplex, '-map', '[vout]'];
      if (ffprobeHasAudio(mergedAbsPath)) {
        args.push('-map', '0:a', '-c:a', 'copy');
      } else {
        args.push('-an');
      }
      args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-movflags', '+faststart', outAbs);
      if (!runFfmpeg(args, log, 'subtitles_watermark')) {
        return { ok: false, error: '字幕/水印烧录失败，请检查 FFmpeg 的 subtitles、drawtext 滤镜及中文字体' };
      }
    } else {
      outAbs = mergedAbsPath;
    }

    if (wantMusic) {
      const music = require('./backgroundMusicService');
      const settings = music.options(mergeOpts.background_music, music.DEFAULTS);
      const source = music.resolveAudioPath(storageRoot, mergeOpts.background_music.local_path);
      const mixed = path.join(path.dirname(mergedAbsPath), `${baseName}_bgm.mp4`);
      const args = ['-y', '-i', outAbs];
      if (settings.loop) args.push('-stream_loop', '-1');
      args.push('-i', source);
      const musicFilters = ['aresample=44100', 'volume=' + settings.volume / 100, 'apad', 'atrim=duration=' + videoDur];
      const fadeIn = Math.min(settings.fade_in, videoDur);
      const fadeOut = Math.min(settings.fade_out, videoDur);
      if (fadeIn > 0) musicFilters.push(`afade=t=in:st=0:d=${fadeIn}`);
      if (fadeOut > 0) musicFilters.push(`afade=t=out:st=${Math.max(0, videoDur - fadeOut)}:d=${fadeOut}`);
      let filter = '[1:a:0]' + musicFilters.join(',') + '[music]';
      if (ffprobeHasAudio(outAbs)) {
        filter += ';[0:a:0]aresample=44100[original];[original][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=false[mixed]';
      } else {
        filter += ';[music]alimiter=limit=0.95:level=false[mixed]';
      }
      args.push('-filter_complex', filter, '-map', '0:v:0', '-map', '[mixed]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2', '-t', String(videoDur), '-movflags', '+faststart', mixed);
      if (!runFfmpeg(args, log, 'background_music')) return { ok: false, error: '背景音乐混音失败，请确认音乐文件可播放' };
      if (outAbs !== mergedAbsPath) { try { fs.unlinkSync(outAbs); } catch (_) {} }
      outAbs = mixed;
    }

    if (!fs.existsSync(outAbs)) {
      return { ok: false, error: '输出文件未生成' };
    }

    const relFromRoot = path.relative(storageRoot, outAbs).replace(/\\/g, '/');

    try {
      if (fs.existsSync(mergedAbsPath) && outAbs !== mergedAbsPath) {
        fs.unlinkSync(mergedAbsPath);
      }
    } catch (e) {
      log.warn('merged post: could not remove intermediate', { error: e.message });
    }

    log.info('merged post: done', { episode_id: episodeId, video: relFromRoot });
    return { ok: true, relativePath: relFromRoot };
  } catch (e) {
    log.warn('merged post: exception', { error: e.message });
    return { ok: false, error: e.message || String(e) };
  } finally {
    try {
      for (const p of fs.readdirSync(tempRoot)) {
        try {
          fs.unlinkSync(path.join(tempRoot, p));
        } catch (_) {}
      }
      fs.rmdirSync(tempRoot);
    } catch (_) {}
  }
}

function ffprobeHasAudio(filePath) {
  const probe = getFfprobePath();
  const r = spawnSync(
    probe,
    ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', filePath],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 }
  );
  return r.status === 0 && String(r.stdout || '').trim().length > 0;
}

module.exports = {
  runMergedEpisodePostProcess,
  ffprobeDurationSec,
};
