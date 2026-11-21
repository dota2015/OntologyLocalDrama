const path = require('path');
const imageClient = require('./imageClient');
const aiClient = require('./aiClient');
const promptI18n = require('./promptI18n');
const { resolveImageGenerationReferences } = require('./imageGenerationReferences');
const { isLastFrameType, rowUseFirstFrameLayoutLock } = require('./imageFramePolicy');
const { aspectRatioToSize } = require('./imageProcessing');

/**
 * 四宫格模式：用 AI 生成 4 个帧提示词，拼成四宫格格式的单张图片提示词
 * 让 AI 图片生成模型直接输出一张 2×2 四格序列图
 */
async function buildQuadGridPrompt(db, log, cfg, storyboardId, model) {
  // 在函数内部 require，避免循环依赖
  const framePromptService = require('./framePromptService');
  const sb = framePromptService.loadStoryboard(db, storyboardId);
  if (!sb) return null;
  const scene = framePromptService.loadScene(db, sb.scene_id);
  const characterNames = framePromptService.loadStoryboardCharacterNames(db, storyboardId);

  // 四个面板使用差异明显的相机角度，方便用户挑选最佳构图
  const QUAD_PANEL_ANGLES = ['平视', '仰拍', '俯拍', '侧面'];
  const QUAD_PANEL_ANGLE_LABELS_EN = [
    'eye-level shot',
    'low-angle upward shot',
    'high-angle downward shot (bird\'s eye)',
    'side-angle profile shot',
  ];
  const [sbFirst, sbKey1, sbKey2, sbLast] = QUAD_PANEL_ANGLES.map((a) => ({ ...sb, angle: a }));

  log.info('[四宫格] 开始生成4帧提示词（四种相机角度）', {
    storyboard_id: storyboardId,
    angles: QUAD_PANEL_ANGLES,
  });
  const [first, key1, key2, last] = await Promise.all([
    framePromptService.generateSingleFrameExported(db, log, cfg, sbFirst, scene, characterNames, model || undefined, 'first'),
    framePromptService.generateSingleFrameExported(db, log, cfg, sbKey1, scene, characterNames, model || undefined, 'key'),
    framePromptService.generateSingleFrameExported(db, log, cfg, sbKey2, scene, characterNames, model || undefined, 'key'),
    framePromptService.generateSingleFrameExported(db, log, cfg, sbLast, scene, characterNames, model || undefined, 'last'),
  ]);
  log.info('[四宫格] 4帧提示词生成完成', { storyboard_id: storyboardId });
  log.info('[四宫格] first.prompt:\n' + first.prompt);
  log.info('[四宫格] key1.prompt:\n' + key1.prompt);
  log.info('[四宫格] key2.prompt:\n' + key2.prompt);
  log.info('[四宫格] last.prompt:\n' + last.prompt);

  const rawStyle = (cfg?.style?.default_style_en || cfg?.style?.default_style || '').toString().trim();
  const styleZhGrid = (cfg?.style?.default_style_zh || '').toString().trim();
  const styleHeadGrid = [
    styleZhGrid ? `【画风·最高优先级】${styleZhGrid}` : '',
    rawStyle && rawStyle !== styleZhGrid ? `MANDATORY ART STYLE: ${rawStyle}.` : rawStyle ? `MANDATORY ART STYLE: ${rawStyle}.` : '',
  ].filter(Boolean).join('\n');
  const styleNote = !styleHeadGrid && rawStyle ? `. Art style: ${rawStyle}` : '';
  const quadCore = `Create a 2x2 grid storyboard image with EXACTLY 4 equal-sized panels arranged in 2 rows and 2 columns (like a coordinate quadrant layout). Each panel occupies exactly one quadrant of the image. NO borders of any color (black, white, gray), NO dividing lines, NO frames between panels — the 4 panels must be seamlessly adjacent with no gaps or separators${styleNote}.

Each panel uses a DIFFERENT camera angle to show the same scene from varied perspectives — this is intentional and required.

TOP ROW (left to right):
[Panel 1 - top-left quadrant, ${QUAD_PANEL_ANGLE_LABELS_EN[0]}, initial state]: ${first.prompt}
[Panel 2 - top-right quadrant, ${QUAD_PANEL_ANGLE_LABELS_EN[1]}, key action moment]: ${key1.prompt}

BOTTOM ROW (left to right):
[Panel 3 - bottom-left quadrant, ${QUAD_PANEL_ANGLE_LABELS_EN[2]}, action continuation]: ${key2.prompt}
[Panel 4 - bottom-right quadrant, ${QUAD_PANEL_ANGLE_LABELS_EN[3]}, final state]: ${last.prompt}

CRITICAL LAYOUT RULES: The image MUST be divided into 4 equal quadrants in a 2x2 grid. Do NOT arrange panels in a single strip. Do NOT add any black or dark borders/frames around the panels. Each panel is self-contained with consistent character appearance and art style. The camera angle MUST visually differ between panels as specified above.`;
  const quadPrompt = (styleHeadGrid ? `${styleHeadGrid}\n\n` : '') + quadCore;
  log.info('[四宫格] FINAL IMAGE PROMPT (发送给图片AI):\n' + quadPrompt);
  return quadPrompt;
}

/**
 * 九宫格模式：用 AI 生成 9 个帧提示词，拼成 3×3 格序列图提示词
 * 9 个面板各用一种不同相机角度，覆盖常见电影视角，供用户挑选最佳构图
 */
async function buildNineGridPrompt(db, log, cfg, storyboardId, model) {
  const framePromptService = require('./framePromptService');
  const sb = framePromptService.loadStoryboard(db, storyboardId);
  if (!sb) return null;
  const scene = framePromptService.loadScene(db, sb.scene_id);
  const characterNames = framePromptService.loadStoryboardCharacterNames(db, storyboardId);

  // 9 种差异明显的相机角度
  const NINE_PANEL_ANGLES = ['平视', '仰拍', '俯拍', '侧面左', '侧面右', '背面', '极端仰拍', '极端俯拍', '斜侧45度'];
  const NINE_PANEL_ANGLE_LABELS_EN = [
    'eye-level shot',
    'low-angle upward shot',
    'high-angle downward shot (bird\'s eye)',
    'left profile side shot',
    'right profile side shot',
    'rear shot from behind the character',
    'extreme low angle (worm\'s eye view)',
    'extreme high angle (aerial top-down view)',
    'diagonal 45-degree angle shot',
  ];
  // 时间线分布：首帧 × 1、关键帧 × 7、尾帧 × 1
  const frameKinds = ['first', 'key', 'key', 'key', 'key', 'key', 'key', 'key', 'last'];
  const sbVariants = NINE_PANEL_ANGLES.map((a) => ({ ...sb, angle: a }));

  log.info('[九宫格] 开始生成9帧提示词（九种相机角度）', { storyboard_id: storyboardId, angles: NINE_PANEL_ANGLES });
  const frames = await Promise.all(
    sbVariants.map((sbv, i) =>
      framePromptService.generateSingleFrameExported(db, log, cfg, sbv, scene, characterNames, model || undefined, frameKinds[i])
    )
  );
  log.info('[九宫格] 9帧提示词生成完成', { storyboard_id: storyboardId });
  frames.forEach((f, i) => log.info(`[九宫格] panel${i}.prompt:\n` + f.prompt));

  const rawStyle = (cfg?.style?.default_style_en || cfg?.style?.default_style || '').toString().trim();
  const styleZhGrid = (cfg?.style?.default_style_zh || '').toString().trim();
  const styleHeadGrid = [
    styleZhGrid ? `【画风·最高优先级】${styleZhGrid}` : '',
    rawStyle && rawStyle !== styleZhGrid ? `MANDATORY ART STYLE: ${rawStyle}.` : rawStyle ? `MANDATORY ART STYLE: ${rawStyle}.` : '',
  ].filter(Boolean).join('\n');
  const styleNote = !styleHeadGrid && rawStyle ? `. Art style: ${rawStyle}` : '';
  const ROWS = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
  ];
  const rowNames = ['TOP ROW', 'MIDDLE ROW', 'BOTTOM ROW'];
  const colNames = ['left', 'center', 'right'];
  const panelDescs = frames.map((f, i) => `[Panel ${i + 1} - ${colNames[i % 3]}, ${NINE_PANEL_ANGLE_LABELS_EN[i]}]: ${f.prompt}`);

  const rowBlocks = ROWS.map((cols, r) =>
    `${rowNames[r]} (left to right):\n` + cols.map((c) => panelDescs[c]).join('\n')
  ).join('\n\n');

  const nineCore = `Create a 3x3 grid storyboard image with EXACTLY 9 equal-sized panels arranged in 3 rows and 3 columns. Each panel occupies exactly one cell of the 3×3 grid. NO borders of any color (black, white, gray), NO dividing lines, NO frames between panels — all 9 panels must be seamlessly adjacent with no gaps or separators${styleNote}.

Each panel uses a DIFFERENT camera angle to show the same scene from varied cinematic perspectives — this is intentional and required.

${rowBlocks}

CRITICAL LAYOUT RULES: The image MUST be divided into 9 equal cells in a 3×3 grid. Do NOT arrange panels in a single strip. Do NOT add any borders or frames. Each panel is self-contained with consistent character appearance and art style. The camera angle MUST visually differ between panels as specified above.`;
  const ninePrompt = (styleHeadGrid ? `${styleHeadGrid}\n\n` : '') + nineCore;
  log.info('[九宫格] FINAL IMAGE PROMPT (发送给图片AI):\n' + ninePrompt);
  return ninePrompt;
}

async function prepareImageGenerationInput(db, log, row, elapsed) {
  const imageGenId = row.id;
  const imageServiceType = row.storyboard_id ? 'storyboard_image' : 'image';

  // ── 四宫格模式：先生成4帧提示词，再拼装组合提示词 ──────────────────
  if (row.frame_type === 'quad_grid' && row.storyboard_id) {
    try {
      const loadConfig = require('../config').loadConfig;
      const cfg = loadConfig();

      // 先检查同一分镜是否已有已完成的四宫格提示词缓存
      const cachedRow = db.prepare(
        `SELECT prompt FROM image_generations
          WHERE storyboard_id = ? AND frame_type = 'quad_grid'
            AND prompt IS NOT NULL AND prompt != ''
            AND status = 'completed'
            AND id != ?
          ORDER BY created_at DESC LIMIT 1`
      ).get(Number(row.storyboard_id), imageGenId);

      // 只复用包含多角度标记的新版缓存提示词，旧版单一角度缓存自动作废
      const QUAD_CACHE_MARKER = 'eye-level shot';
      let quadPrompt = null;
      if (cachedRow?.prompt && cachedRow.prompt.includes(QUAD_CACHE_MARKER)) {
        quadPrompt = cachedRow.prompt;
        log.info('[图生] 使用缓存的四宫格提示词（跳过 AI 生成）', { id: imageGenId, prompt_len: quadPrompt.length });
      } else {
        if (cachedRow?.prompt) {
          log.info('[图生] 旧版单一角度缓存已作废，重新生成多角度提示词', { id: imageGenId });
        }
        quadPrompt = await buildQuadGridPrompt(db, log, cfg, row.storyboard_id, row.model);
        if (quadPrompt) {
          log.info('[图生] 四宫格提示词已生成（新）', { id: imageGenId, prompt_len: quadPrompt.length });
        }
      }

      if (quadPrompt) {
        db.prepare('UPDATE image_generations SET prompt = ?, updated_at = ? WHERE id = ?')
          .run(quadPrompt, new Date().toISOString(), imageGenId);
        row.prompt = quadPrompt;
      }
    } catch (quadErr) {
      log.warn('[图生] 四宫格提示词生成失败，使用原始提示词', { id: imageGenId, error: quadErr.message });
    }
  }

  // ── 九宫格模式：先生成9帧提示词，再拼装组合提示词 ──────────────────
  if (row.frame_type === 'nine_grid' && row.storyboard_id) {
    try {
      const loadConfig = require('../config').loadConfig;
      const cfg = loadConfig();

      const NINE_CACHE_MARKER = 'worm\'s eye view';
      const cachedRow = db.prepare(
        `SELECT prompt FROM image_generations
          WHERE storyboard_id = ? AND frame_type = 'nine_grid'
            AND prompt IS NOT NULL AND prompt != ''
            AND status = 'completed'
            AND id != ?
          ORDER BY created_at DESC LIMIT 1`
      ).get(Number(row.storyboard_id), imageGenId);

      let ninePrompt = null;
      if (cachedRow?.prompt && cachedRow.prompt.includes(NINE_CACHE_MARKER)) {
        ninePrompt = cachedRow.prompt;
        log.info('[图生] 使用缓存的九宫格提示词（跳过 AI 生成）', { id: imageGenId, prompt_len: ninePrompt.length });
      } else {
        if (cachedRow?.prompt) {
          log.info('[图生] 旧版九宫格缓存已作废，重新生成多角度提示词', { id: imageGenId });
        }
        ninePrompt = await buildNineGridPrompt(db, log, cfg, row.storyboard_id, row.model);
        if (ninePrompt) {
          log.info('[图生] 九宫格提示词已生成（新）', { id: imageGenId, prompt_len: ninePrompt.length });
        }
      }

      if (ninePrompt) {
        db.prepare('UPDATE image_generations SET prompt = ?, updated_at = ? WHERE id = ?')
          .run(ninePrompt, new Date().toISOString(), imageGenId);
        row.prompt = ninePrompt;
      }
    } catch (nineErr) {
      log.warn('[图生] 九宫格提示词生成失败，使用原始提示词', { id: imageGenId, error: nineErr.message });
    }
  }

  // ── Step 1: 获取 AI 配置 ──────────────────────────────────────────
  const config = imageClient.getDefaultImageConfig(db, row.model, null, imageServiceType);
  if (!config) {
    log.error('[图生] ✗ 未找到图片 AI 配置', { id: imageGenId, imageServiceType, elapsed: elapsed() });
    throw new Error('未配置图片模型');
  }
  log.info('[图生] Step1 AI配置', {
    id: imageGenId,
    provider: config.provider,
    model: config.model,
    api_protocol: config.api_protocol || '(auto)',
    elapsed: elapsed(),
  });

  const { reference_image_urls, reference_context_note, shotLooks, directorShot, sourceShot, plannedReferences } =
    await resolveImageGenerationReferences(db, log, row, config, elapsed);

  // ── Step 3: 计算尺寸 ────────────────────────────────────────────
  const loadConfig = require('../config').loadConfig;
  const { mergeCfgStyleWithDrama } = require('../utils/dramaStyleMerge');
  let cfg = loadConfig();
  if (row.drama_id) {
    try {
      const dr = db.prepare('SELECT style, metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(row.drama_id);
      cfg = mergeCfgStyleWithDrama(cfg, dr || {});
    } catch (_) {}
  }
  const filesBaseUrl = (cfg.storage && cfg.storage.base_url) ? String(cfg.storage.base_url).replace(/\/$/, '') : '';
  const storageLocalPath = path.isAbsolute(cfg.storage?.local_path)
    ? cfg.storage.local_path
    : path.join(process.cwd(), cfg.storage?.local_path || './data/storage');

  let imageSize = row.size || null;
  if (!imageSize && row.drama_id) {
    try {
      const dramaRow = db.prepare('SELECT metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(row.drama_id);
      if (dramaRow && dramaRow.metadata) {
        const meta = typeof dramaRow.metadata === 'string' ? JSON.parse(dramaRow.metadata) : dramaRow.metadata;
        if (meta && meta.aspect_ratio) imageSize = aspectRatioToSize(meta.aspect_ratio);
      }
    } catch (_) {}
  }
  if (!imageSize) {
    const cfgRatio = cfg?.style?.default_image_ratio;
    if (cfgRatio) imageSize = aspectRatioToSize(cfgRatio);
  }
  log.info('[图生] Step3 尺寸', { id: imageGenId, size: imageSize, elapsed: elapsed() });

  // ── Step 3.5: 分镜 prompt 文本AI二次优化（单帧分镜；优先用 image_polish 模型，无则 fallback 默认文本模型）──
  let finalPrompt = row.prompt;
  const isSingleStoryboard = row.storyboard_id && row.frame_type !== 'quad_grid' && row.frame_type !== 'nine_grid';
  if (isSingleStoryboard && row.prompt && !directorShot) {
    try {
      // 若分镜已有 polished_prompt（手动编辑或上次优化结果），直接使用，不再重复调 AI
      // 但**首帧/尾帧/关键帧专用提示词优先**：这些是用户通过“生成首/尾帧提示词”+“生成图片”流程明确批准的干净 prompt，
      // 不能被通用的 storyboards.polished_prompt（可能来自旧的整体润色，含错误服装描述）覆盖。
      let alreadyPolished = false;
      const isFrameSpecial = row.frame_type && ['first', 'last', 'key', 'storyboard_first', 'storyboard_last'].includes(String(row.frame_type));
      if (row.storyboard_id && !isFrameSpecial) {
        const sbPolished = db.prepare(
          'SELECT polished_prompt FROM storyboards WHERE id = ? AND deleted_at IS NULL'
        ).get(Number(row.storyboard_id));
        if (sbPolished?.polished_prompt?.trim().length > 10) {
          finalPrompt = sbPolished.polished_prompt.trim();
          alreadyPolished = true;
          log.info('[图生] Step3.5 已有 polished_prompt，跳过重复优化', { id: imageGenId, len: finalPrompt.length, elapsed: elapsed() });
        }
      } else if (isFrameSpecial) {
        log.info('[图生] Step3.5 首/尾/关键帧专用提示词优先，忽略 storyboards.polished_prompt', { id: imageGenId, frame_type: row.frame_type, elapsed: elapsed() });
      }
      const skipAIPolishForFrame = isFrameSpecial;

      // 只要系统中有任意可用的文本模型配置，均执行优化（image_polish 专用映射为可选增强）
      const anyTextConfig = !alreadyPolished && !skipAIPolishForFrame && db.prepare(
        "SELECT id FROM ai_service_configs WHERE service_type = 'text' AND deleted_at IS NULL LIMIT 1"
      ).get();
      if (anyTextConfig) {
        log.info('[图生] Step3.5 文本AI优化 prompt 开始', { id: imageGenId, elapsed: elapsed() });
        const rawSt = (cfg?.style?.default_style_en || cfg?.style?.default_style || '').toString().trim();
        const styleZh = (cfg?.style?.default_style_zh || '').toString().trim();
        const style = rawSt || styleZh || 'cinematic movie still, anamorphic lens, film grain, dramatic lighting, shallow depth of field, professional cinematography';
        const styleBlockLines = [];
        if (styleZh) styleBlockLines.push(`【画风·最高优先级】${styleZh}`);
        if (rawSt && rawSt !== styleZh) styleBlockLines.push(`MANDATORY ART STYLE: ${rawSt}.`);
        else if (rawSt && !styleZh) styleBlockLines.push(`MANDATORY ART STYLE: ${rawSt}.`);
        else if (!styleZh && !rawSt) styleBlockLines.push(`MANDATORY ART STYLE: ${style}.`);
        const assetNames = (reference_context_note || '').split('\n')
          .map((l) => l.replace(/^Image \d+: [^"]*"([^"]+)".*/, '$1'))
          .filter(Boolean).join(', ');

        // 获取分镜详细字段（action / dialogue / result / atmosphere / shot_type）
        let sbDetail = null;
        try {
          sbDetail = db.prepare(
            'SELECT action, dialogue, result, atmosphere, shot_type, episode_id, storyboard_number FROM storyboards WHERE id = ? AND deleted_at IS NULL'
          ).get(Number(row.storyboard_id));
        } catch (_) {}

        // 查询前后镜头，用于连续性控制
        let prevDesc = '(first shot)';
        let nextDesc = '(last shot)';
        let prevContinuityState = null; // 上一镜头的连戏状态快照
        if (sbDetail?.episode_id != null && sbDetail?.storyboard_number != null) {
          try {
            const prevShot = db.prepare(
              'SELECT action, location, time, continuity_snapshot FROM storyboards WHERE episode_id = ? AND storyboard_number < ? AND deleted_at IS NULL ORDER BY storyboard_number DESC LIMIT 1'
            ).get(sbDetail.episode_id, sbDetail.storyboard_number);
            const nextShot = db.prepare(
              'SELECT action, location, time FROM storyboards WHERE episode_id = ? AND storyboard_number > ? AND deleted_at IS NULL ORDER BY storyboard_number ASC LIMIT 1'
            ).get(sbDetail.episode_id, sbDetail.storyboard_number);
            if (prevShot) {
              prevDesc = (prevShot.action || [prevShot.location, prevShot.time].filter(Boolean).join(' ')).slice(0, 120).trim() || '(first shot)';
              if (prevShot.continuity_snapshot) {
                try { prevContinuityState = JSON.parse(prevShot.continuity_snapshot); } catch (_) {}
              }
            }
            if (nextShot) {
              nextDesc = (nextShot.action || [nextShot.location, nextShot.time].filter(Boolean).join(' ')).slice(0, 120).trim() || '(last shot)';
            }
          } catch (_) {}
        }

        const userPromptLines = [
          ...styleBlockLines,
          `PROMPT: ${row.prompt}`,
          sbDetail?.action     ? `ACTION: ${sbDetail.action}`        : null,
          sbDetail?.dialogue   ? `DIALOGUE: ${sbDetail.dialogue}`    : null,
          sbDetail?.result     ? `RESULT: ${sbDetail.result}`        : null,
          sbDetail?.atmosphere ? `ATMOSPHERE: ${sbDetail.atmosphere}`: null,
          sbDetail?.shot_type  ? `SHOT_TYPE: ${sbDetail.shot_type}`  : null,
          `STYLE_TOKENS (repeat in output): ${style}`,
          `ASSETS: ${assetNames || 'none'}`,
          prevContinuityState  ? `PREV_CONTINUITY_STATE: ${JSON.stringify(prevContinuityState)}` : null,
          `CONTEXT_PREV: ${prevDesc}`,
          `CONTEXT_NEXT: ${nextDesc}`,
          `REMINDER: Output a STATIC SINGLE-FRAME image prompt only. No camera motion, no transitions, no split panels.`,
        ].filter(Boolean);
        const userPrompt = userPromptLines.join('\n');
        const systemPrompt = promptI18n.getImagePolishPrompt(cfg);
        const polishedPrompt = await aiClient.generateText(db, log, 'text', userPrompt, systemPrompt, {
          scene_key: 'image_polish',
          max_tokens: 300,
          temperature: 0.3,
        });
        if (polishedPrompt && polishedPrompt.trim().length > 10) {
          finalPrompt = polishedPrompt.trim();
          const nowIso = new Date().toISOString();
          db.prepare('UPDATE image_generations SET prompt = ?, updated_at = ? WHERE id = ?').run(
            finalPrompt, nowIso, imageGenId
          );
          // 回写到 storyboards.polished_prompt（原始 image_prompt 保持不变，供对比查看）
          try {
            db.prepare('UPDATE storyboards SET polished_prompt = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').run(
              finalPrompt, nowIso, Number(row.storyboard_id)
            );
          } catch (_) {}
          log.info('[图生] Step3.5 prompt 优化完成', {
            id: imageGenId,
            original_len: row.prompt.length,
            polished_len: finalPrompt.length,
            has_prev_continuity: !!prevContinuityState,
            prev_ctx: prevDesc.slice(0, 60),
            next_ctx: nextDesc.slice(0, 60),
            preview: finalPrompt.slice(0, 100),
            elapsed: elapsed(),
          });

          // 异步提取本镜头连戏状态快照，存入 continuity_snapshot（不阻塞图生主流程）
          if (row.storyboard_id) {
            const sbIdForCont = Number(row.storyboard_id);
            const snapshotPrompt = promptI18n.getContinuitySnapshotPrompt();
            const snapshotUserPrompt = [`PROMPT: ${finalPrompt}`, `ASSETS: ${assetNames || 'none'}`].join('\n');
            aiClient.generateText(db, log, 'text', snapshotUserPrompt, snapshotPrompt, {
              scene_key: 'image_polish',
              max_tokens: 200,
              temperature: 0.1,
            }).then((snapshotJson) => {
              if (!snapshotJson?.trim()) return;
              // 清理可能的 markdown 代码块包裹
              const cleaned = snapshotJson.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
              try {
                JSON.parse(cleaned); // 验证合法 JSON
                db.prepare('UPDATE storyboards SET continuity_snapshot = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').run(
                  cleaned, new Date().toISOString(), sbIdForCont
                );
                log.info('[图生] Step3.5 连戏快照已保存', { id: imageGenId, storyboard_id: sbIdForCont });
              } catch (_) {
                log.warn('[图生] Step3.5 连戏快照 JSON 解析失败，跳过', { id: imageGenId, preview: cleaned.slice(0, 100) });
              }
            }).catch(() => {});
          }
        }
      }
    } catch (polishErr) {
      log.warn('[图生] Step3.5 prompt 优化失败，使用原始 prompt', { id: imageGenId, error: polishErr.message });
    }
  }

  if (directorShot) {
    const outfits = shotLooks.filter(c => c.description).map(c => `${c.name}：${c.description}`);
    if (outfits.length) finalPrompt += '\n本镜服装：' + outfits.join('；');
  } else if (row.storyboard_id) finalPrompt += require('./wardrobeService').promptContext(db, row.storyboard_id, isLastFrameType(row.frame_type) ? 'last' : 'first');

  // ── Step 3.8: 单帧分镜注入防分割指令 ──────────────────────────────
  // 当有多张参考图时，部分模型（如 Doubao）会生成左右分栏/对比布局，加入负面约束抑制该行为
  if (!directorShot && isSingleStoryboard && reference_image_urls && reference_image_urls.length > 1) {
    const antiSplitSuffix = ', single continuous scene, no split panels, no side-by-side layout, no collage';
    if (!finalPrompt.includes('no split')) {
      finalPrompt = finalPrompt.trimEnd() + antiSplitSuffix;
    }
  }

  // ── Step 3.9: 尾帧站位锁强制文本指令（与视觉参考图双保险）────────────────
  // 无论是否成功注入参考图，都给尾帧 prompt 追加强约束，防止模型脑补新布局或克隆重复人物
  const isLastFrameForLock = isLastFrameType(row.frame_type) && rowUseFirstFrameLayoutLock(row);
  if (!directorShot && isLastFrameForLock && row.storyboard_id) {
    let characterNames = [];
    try {
      const framePromptService = require('./framePromptService');
      const anchors = framePromptService.loadStoryboardCharacterNames(db, row.storyboard_id);
      const { parseNamesFromAnchorLines } = require('../utils/framePromptSanitize');
      characterNames = parseNamesFromAnchorLines(anchors);
    } catch (_) {}
    if (!characterNames.length && Array.isArray(shotLooks)) {
      characterNames = shotLooks.map(c => c.name).filter(Boolean);
    }
    const charCount = characterNames.length;
    const countDescZh = charCount > 0
      ? `画面总人数严格为 ${charCount} 人（出场角色：${characterNames.join('、')}），继承首帧既有角色，按演化结果改变姿态、表情与动作。`
      : '继承首帧既有角色，按演化结果改变姿态、表情与动作。';
    const countDescEn = charCount > 0
      ? ` Maintain identical character composition from Image 1 (${characterNames.join(', ')}). Evolve postures and actions naturally.`
      : ' Maintain identical character composition from Image 1. Evolve postures and actions naturally.';

    const layoutLockSuffix = `。【人物站位与动作演化】与本分镜首帧图片保持一致的构图、人物左右站位（相对位置、朝向）、相机取景和空间布局，按演化结果改变既有角色的姿态、表情和动作。${countDescZh}${countDescEn}`;
    if (!finalPrompt.includes('人物站位与动作演化') && !finalPrompt.includes('人物站位与防重复最高铁律') && !finalPrompt.includes('人物站位最高铁律') && !finalPrompt.includes('CHARACTER POSITION LOCK')) {
      finalPrompt = finalPrompt.trimEnd() + layoutLockSuffix;
    }
  }

  // ── Step 3.95: 分镜图出场人数严格约束（适用于所有含角色参考的分镜图生成，纯自然语言正面表达）──
  if (!directorShot && row.storyboard_id && !isLastFrameForLock && reference_image_urls && reference_image_urls.length > 0) {
    const charRefNames = [];
    const charMappings = [];
    const noteLines = (reference_context_note || '').split('\n');
    for (const line of noteLines) {
      const m = line.match(/^Image\s+(\d+):\s*character appearance reference for "([^"]+)"/i);
      if (m && m[2] && !charRefNames.includes(m[2].trim())) {
        const cName = m[2].trim();
        charRefNames.push(cName);
        let gender = '';
        try {
          const cRow = db.prepare('SELECT appearance, description FROM characters WHERE name = ? AND drama_id = ? AND deleted_at IS NULL').get(cName, row.drama_id);
          const descText = [cRow?.appearance || '', cRow?.description || ''].join(' ');
          if (/女性|女|female/i.test(descText)) gender = '女性';
          else if (/男性|男|male/i.test(descText)) gender = '男性';
        } catch (_) {}
        charMappings.push({ imgNum: m[1], name: cName, gender });
      }
    }
    if (charRefNames.length > 0) {
      const charCount = charRefNames.length;
      const countZh = charCount === 1
        ? `【出场人数铁律】画面中出场人物严格且仅有 1 人（${charRefNames[0]}）。`
        : `【出场人数铁律】画面中出场人物严格为 ${charCount} 人（出场角色：${charRefNames.join('、')}）。`;
      const countEn = charCount === 1
        ? ` The frame contains exactly 1 person: ${charRefNames[0]}.`
        : ` The frame contains exactly ${charCount} people: ${charRefNames.join(', ')}.`;

      let mappingClause = '';
      if (charMappings.length > 0) {
        const mapZh = charMappings.map(m => `角色「${m.name}」${m.gender ? `（${m.gender}）` : ''}的外观特征对应参考图 ${m.imgNum}`).join('；');
        const mapEn = charMappings.map(m => `"${m.name}"${m.gender ? ` (${m.gender})` : ''} uses the identity and appearance from reference image ${m.imgNum}`).join('; ');
        mappingClause = `【人物特征与参考图对应】${mapZh}。每张参考图提供对应角色的外观特征，人物姿态与动作符合剧情设定。 CHARACTER CORRESPONDENCE: ${mapEn}.`;
      }

      const charCountSuffix = `。${countZh}${countEn}${mappingClause ? '。' + mappingClause : ''}`;
      if (!finalPrompt.includes('出场人数铁律') && !finalPrompt.includes('STRICT RULE: Exactly')) {
        finalPrompt = finalPrompt.trimEnd() + charCountSuffix;
      }
    }
  }

  // ── Step 4: 调用图生 API ─────────────────────────────────────────
  // 单张分镜图时，把参考图标签（reference_context_note）传给 Gemini，
  // 在 callGeminiImageApi 里解析为 per-image 标签，交替插入 parts 结构
  const apiSystemPrompt = (isSingleStoryboard && reference_context_note) ? reference_context_note : undefined;

  const isFrameIdentityLock =
    row.frame_type &&
    ['first', 'last', 'key', 'storyboard_first', 'storyboard_last'].includes(String(row.frame_type).toLowerCase());
  const shouldSanitizePrompt = (isFrameIdentityLock || (row.storyboard_id && reference_image_urls?.length > 0)) && row.storyboard_id && finalPrompt;
  if (shouldSanitizePrompt && !directorShot) {
    try {
      const framePromptService = require('./framePromptService');
      const { sanitizeFramePrompt, parseNamesFromAnchorLines } = require('../utils/framePromptSanitize');
      const anchors = framePromptService.loadStoryboardCharacterNames(db, row.storyboard_id);
      let allowed = parseNamesFromAnchorLines(anchors);
      const charImageMap = {};
      if (reference_context_note) {
        const refCharNames = [];
        for (const line of reference_context_note.split('\n')) {
          const m = line.match(/^Image\s+(\d+):\s*character appearance reference for "([^"]+)"/i);
          if (m && m[2]) {
            const cName = m[2].trim();
            refCharNames.push(cName);
            let gender = '';
            try {
              const cRow = db.prepare('SELECT appearance, description FROM characters WHERE name = ? AND drama_id = ? AND deleted_at IS NULL').get(cName, row.drama_id);
              const descText = [cRow?.appearance || '', cRow?.description || ''].join(' ');
              if (/女性|女|female/i.test(descText)) gender = '女性';
              else if (/男性|男|male/i.test(descText)) gender = '男性';
            } catch (_) {}
            charImageMap[cName] = { index: m[1], gender };
          }
        }
        if (refCharNames.length > 0) {
          allowed = refCharNames;
        }
      }
      const allDrama = framePromptService.loadDramaCharacterNamesForStoryboard(db, row.storyboard_id);
      const sanitized = sanitizeFramePrompt(finalPrompt, allowed, allDrama, {
        log,
        source: 'image_generation',
        storyboard_id: row.storyboard_id,
        frame_kind: row.frame_type || 'image',
        image_gen_id: imageGenId,
        charImageMap,
      });
      if (sanitized !== finalPrompt) {
        finalPrompt = sanitized;
      }
    } catch (sanitizeErr) {
      log.warn('[图生] 分镜 prompt 清洗跳过', { id: imageGenId, error: sanitizeErr.message });
    }
  }
  if (isFrameIdentityLock) {
    log.info('[图生] 首尾帧/关键帧：启用身份锁定负面提示词', {
      id: imageGenId,
      frame_type: row.frame_type,
      elapsed: elapsed(),
    });
  }

  if(row.storyboard_id && JSON.stringify(require('./wardrobeService').getShot(db,row.storyboard_id).characters)!==JSON.stringify(shotLooks))throw new Error('准备图片期间人物造型已变化，请按新造型重新生成');
  const request = {
    prompt: finalPrompt,
    storyboard_id: row.storyboard_id,
    structured_storyboard: directorShot,
    input_storyboard: sourceShot,
    input_references: plannedReferences?.refs,
    model: row.model,
    size: imageSize,
    quality: row.quality,
    drama_id: row.drama_id,
    character_id: row.character_id,
    image_gen_id: imageGenId,
    imageServiceType,
    reference_image_urls: reference_image_urls || undefined,
    files_base_url: filesBaseUrl,
    storage_local_path: storageLocalPath,
    system_prompt: apiSystemPrompt,
    negative_prompt: row.negative_prompt || undefined,
    frame_identity_lock: isFrameIdentityLock,
  };
  return { request, cfg };
}

module.exports = { prepareImageGenerationInput };
