const { normalizeDurationRange, planShotDuration, rangeTimingInstructions } = require('../utils/shotDurationRange');
// 与 Go StoryboardService.GenerateStoryboard + processStoryboardGeneration 对齐
const taskService = require('./taskService');
const aiClient = require('./aiClient');
const promptI18n = require('./promptI18n');
const { syncStoryboardCharacters } = require('./imageService');
const safeJson = require('../utils/safeJson');
const { safeParseAIJSON, extractJsonCandidate, repairTruncatedJsonArray, extractFirstArray } = safeJson;
const loadConfig = require('../config').loadConfig;
const angleService = require('./angleService');
const { timingInstructions, assessSpeechTiming } = require('../utils/speechTiming');
const { shotSpeechTurns } = require('./dialogueDubbingService');
const { enforceStoryboardSpeechTiming } = require('./storyboardSpeechService');
const { planningFeasibilityViolations, SpeechTimingRule } = require('../ontology/invariants');

function stageOnePlanningViolations(storyboards, { catalogs, narrativeStyle, durationRange } = {}) {
  const violations = [...planningFeasibilityViolations(storyboards, { catalogs })];
  const speechTimingRule = new SpeechTimingRule();
  const delivery = require('./speechDeliveryService');
  for (let idx = 0; idx < (Array.isArray(storyboards) ? storyboards.length : 0); idx++) {
    const shot = storyboards[idx];
    const shotNum = Number(shot?.shot_number || shot?.storyboard_number || idx + 1);
    const turns = shotSpeechTurns(shot);
    if (turns.length > 1) {
      const speakers = turns.map((t) => t.speaker || (t.kind === 'narration' ? '旁白' : '对白')).join('、');
      violations.push({
        rule: 'INVARIANT_MULTI_SPEAKER_SHOT',
        shot_number: shotNum,
        severity: 'error',
        conflict_slots: ['dialogue', 'narration'],
        message: `分镜 #${shotNum} 包含 ${turns.length} 个发言段（${speakers}）；阶段一必须按说话轮次拆成至少 ${turns.length} 个连续镜头，保证每镜最多 1 个说话人的单轮对白或 1 段旁白，并逐字保留全部台词。`,
      });
    }
    const rawDur = Number(shot?.duration) > 0 ? Number(shot.duration) : 5;
    if (durationRange && (rawDur < durationRange.min || rawDur > durationRange.max)) {
      violations.push({
        rule: 'INVARIANT_SHOT_DURATION_RANGE',
        shot_number: shotNum,
        severity: 'error',
        conflict_slots: ['duration'],
        message: `分镜 #${shotNum} 的 duration=${rawDur}s 超出配置范围 ${durationRange.min}～${durationRange.max} 秒；必须通过拆镜解决超长台词，禁止拉长单镜 duration！`,
      });
    }
    const dur = durationRange ? Math.max(durationRange.min, Math.min(durationRange.max, rawDur)) : rawDur;
    const deliveryOptions = delivery.budgetOptions(delivery.resolve(narrativeStyle, shot, { duration: dur }));
    violations.push(...speechTimingRule.evaluate({ shots: [{ ...shot, shot_number: shotNum, duration: dur }], options: { deliveryOptions } }));
  }
  return violations;
}

/**
 * 分镜专用 generateText 包装：
 * 1. 默认请求 max_tokens:65536，给整集基础分镜和续写保留足够的输出预算。
 * 2. 若 API 因 max_tokens 超上限报参数错误，由 aiClient 统一降级重试
 *    （有上限值则按上限重试，否则去掉 max_tokens），此处的包装不再需要自己处理。
 * 3. 所有尝试均记录日志。
 */
// 这是请求上限而不是强制的厂商上限。aiClient 会在供应商返回参数上限时
// 自动按错误中的最大值重试，或移除该参数使用模型默认值。
const DEFAULT_STORYBOARD_MAX_TOKENS = 65536;

/** 统一镜号（AI 可能返回字符串 "1"，须与 Set 去重键一致） */
function normalizeStoryboardShotNumber(rawOrSb) {
  const raw =
    rawOrSb != null && typeof rawOrSb === 'object'
      ? rawOrSb.shot_number ?? rawOrSb.storyboard_number
      : rawOrSb;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** 同集相同 storyboard_number 多行时保留 id 最大的一条（通常为最新入库） */
function dedupeStoryboardRowsByNumber(rows) {
  const byNum = new Map();
  const extras = [];
  for (const r of rows || []) {
    const num = normalizeStoryboardShotNumber(r.storyboard_number ?? r);
    if (num > 0) {
      const prev = byNum.get(num);
      if (!prev || Number(r.id) > Number(prev.id)) byNum.set(num, r);
    } else {
      extras.push(r);
    }
  }
  return [...byNum.values(), ...extras].sort(
    (a, b) =>
      normalizeStoryboardShotNumber(a.storyboard_number) - normalizeStoryboardShotNumber(b.storyboard_number) ||
      Number(a.id) - Number(b.id)
  );
}

async function generateTextForStoryboard(db, log, userPrompt, systemPrompt, options = {}) {
  const { model, streamCallback, temperature = 0.7 } = options;

  // max_tokens 超厂商上限时的降级重试由 aiClient.generateText 内部统一处理
  log.info('Storyboard generateText', { model: model || '(default)', max_tokens: DEFAULT_STORYBOARD_MAX_TOKENS });
  return aiClient.generateText(db, log, 'text', userPrompt, systemPrompt, {
    scene_key: 'storyboard_extraction',
    model: model || undefined,
    temperature,
    // 阶段一只生成基础剧情分镜，不做隐藏推理；把输出预算留给完整 JSON。
    // 阶段二由 Agents SDK 的执行合同 Agent 独立决定并保留 thinking。
    thinking: 'disabled',
    max_tokens: DEFAULT_STORYBOARD_MAX_TOKENS,
    // 即使 AI 配置里残留了旧的 8192/16384 上限，导演分镜仍按当前任务
    // 的最高输出预算请求；供应商实际上限由 aiClient 的重试逻辑决定。
    min_max_tokens: DEFAULT_STORYBOARD_MAX_TOKENS,
    streamCallback,
  });
}

function rowToScene(r) {
  if (!r) return null;
  return {
    id: r.id,
    drama_id: r.drama_id,
    location: r.location,
    time: r.time,
    prompt: r.prompt,
    storyboard_count: r.storyboard_count ?? 1,
    image_url: r.image_url,
    local_path: r.local_path,
    status: r.status || 'pending',
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/** 规范为数字秒：前端左侧用 {{ shot.duration }}s，右侧用 Math.round(duration)；避免 "5s" 导致 5ss，或非数字导致 NaN */
function normalizeDuration(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  const s = String(v).trim().replace(/s$/i, '');
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

const _SB_PROMPT_LOG_CHUNK = 14000;

/**
 * 调试：完整打印分镜 system / user 提示词（可能很长，按块写入日志）。
 * 启动后端前设置环境变量：DEBUG_STORYBOARD_PROMPTS=1
 */
function logDebugStoryboardPrompts(log, tag, userPrompt, systemPrompt) {
  const on = String(process.env.DEBUG_STORYBOARD_PROMPTS || '').trim();
  if (on !== '1' && on.toLowerCase() !== 'true') return;
  const sp = systemPrompt != null ? String(systemPrompt) : '';
  const up = userPrompt != null ? String(userPrompt) : '';
  log.info(`[StoryboardPrompt:${tag}] system_prompt_bytes=${sp.length} user_prompt_bytes=${up.length}`);
  for (let i = 0; i < sp.length; i += _SB_PROMPT_LOG_CHUNK) {
    log.info(`[StoryboardPrompt:${tag}] system_part_${Math.floor(i / _SB_PROMPT_LOG_CHUNK) + 1}\n${sp.slice(i, i + _SB_PROMPT_LOG_CHUNK)}`);
  }
  for (let i = 0; i < up.length; i += _SB_PROMPT_LOG_CHUNK) {
    log.info(`[StoryboardPrompt:${tag}] user_part_${Math.floor(i / _SB_PROMPT_LOG_CHUNK) + 1}\n${up.slice(i, i + _SB_PROMPT_LOG_CHUNK)}`);
  }
}

/** 将 lighting_style 枚举转为中文布光提示（兜底用） */
function lightingStyleHintZh(code) {
  const m = {
    natural: '自然窗光或环境散射光',
    front: '正面柔光面部受光均匀',
    side: '侧光约45°勾勒轮廓',
    backlit: '逆光轮廓光发丝边缘发亮',
    top: '顶光压暗眼窝',
    under: '底光或脚光非常规氛围',
    soft: '软光低反差过渡柔和',
    dramatic: '戏剧高反差主辅分明',
    golden_hour: '金色时刻暖斜阳',
    blue_hour: '蓝调时刻冷环境光',
    night: '夜景人工点光源',
    neon: '霓虹混合色温',
  };
  return m[String(code || '').trim()] || '主光方向明确侧光或窗光';
}

/** 按时长与已有运镜字段拼灵境式「运镜链」（强调摄影机动态流动，严格少用定镜） */
function buildCameraMotionChain(movement, shotType, durationSec) {
  const dur = Math.max(1, Number(durationSec) || 5);
  const mv = String(movement || '').trim();
  const st = String(shotType || '').trim();
  const parts = [];
  if (dur >= 12) {
    if (/跟|追随|尾随|track/.test(mv)) parts.push('侧后方平稳跟拍主体位移');
    else if (/摇|pan/.test(mv)) parts.push('轻摇镜头拓展环境纵深画幅');
    else if (/手持|handheld/.test(mv)) parts.push('手持呼吸感微晃记录现场动态');
    else if (/拉|pull/.test(mv)) parts.push('由主体向外缓拉后退展开全景');
    else parts.push('缓推轨贴近动作与神态核心');
    parts.push('横移从前景遮挡或门框一侧滑出拓宽视野带出纵深与环境细节');
  } else if (dur >= 8) {
    if (/跟|track/.test(mv)) parts.push('跟拍主体动线');
    else if (/手持|handheld/.test(mv)) parts.push('微手持呼吸感运镜');
    else if (/拉|pull/.test(mv)) parts.push('缓拉镜头拓宽画幅');
    else if (/摇|pan/.test(mv)) parts.push('水平横移扫过空间');
    else parts.push('缓推轨由远及近');
    parts.push('微横移让背景纵深与环境细节可读');
  } else if (dur >= 5) {
    if (/跟|track/.test(mv)) parts.push('短跟拍强化主体动线');
    else if (/手持|handheld/.test(mv)) parts.push('手持临场呼吸感');
    else if (/拉|pull/.test(mv)) parts.push('缓拉带出空间关系');
    else if (/摇|pan/.test(mv)) parts.push('轻摇展现动作延伸');
    else parts.push('缓推轨贴近动作');
  } else {
    if (/跟|track/.test(mv)) parts.push('短跟拍');
    else if (/手持|handheld/.test(mv)) parts.push('微手持动感');
    else if (/拉|pull/.test(mv)) parts.push('微拉');
    else if (/摇|pan/.test(mv)) parts.push('微摇');
    else parts.push('微推');
  }
  if ((st.includes('远') || st.includes('全景')) && !parts.some((p) => /推|移|跟|摇|拉/.test(p))) {
    parts.push('缓推轨或轻摇向事件中心');
  }
  const chain = [...new Set(parts)].filter(Boolean).join('，');
  return chain || '缓推轨贴近动作核心';
}

/** H3 多参考分镜：模型未返回 universal_segment_text 时的高密度单行（视频时间轴 + 运镜链） */
function buildFallbackUniversalH3Line(sb, d, styleHint) {
  const act = (d.action || '').replace(/\s+/g, ' ').trim().slice(0, 220);
  const res = (d.result || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const emo = (d.emotion || sb.emotion || '').replace(/\s+/g, ' ').trim().slice(0, 24);
  const atm = (sb.atmosphere || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  const shotBits = [d.shotType, d.angle].filter(Boolean).join('，').trim();
  const loc = [sb.location, sb.time].filter(Boolean).join('，').trim() || '叙事空间';
  const dur = Math.max(1, Number(d.durationSec) || normalizeDuration(sb.duration) || 5);
  const lightZh = lightingStyleHintZh(d.lightingStyle);
  const dof = d.depthOfField === 'extreme_shallow' ? '浅景深前景虚化明显' : d.depthOfField === 'shallow' ? '浅景深背景柔化' : d.depthOfField === 'deep' ? '深焦前后景均清晰' : d.depthOfField === 'medium' ? '景深适中' : '景深随景别可感';
  const shotNum = Math.max(1, Number(d.shotNumber) || 1);
  const link = shotNum <= 1 ? '开篇情绪奠基' : '延续上一镜动势与视线';
  const motionCore =
    act ||
    '在镜内时长里完成一段可感知的动作阶段变化，含走位或身体重心的转移，避免单姿势摆拍';
  const emoParen = emo ? `（${emo}）` : '（专注投入）';
  const fg = atm ? `${atm.slice(0, 42)}与主体相关的虚化层次` : '与动作相关的近景细节或桌面器物';
  const mg = act ? '主体动作与表情核心区' : '主体占据画面叙事中心';
  const bg = loc ? `${loc}的环境延展与氛围层次` : '环境纵深与空间气氛';
  const lightBlock = `[${lightZh}；结合${loc}，建议色温具象化如4500K-5600K区间择一；明暗比约2:1至3:1；${dof}]`;
  const camChain = buildCameraMotionChain(d.movement, d.shotType, dur);
  const narrDyn = `约${dur}秒内——在${loc}，@人物1${act ? `先后：${act}` : '持续推进戏内动作'}，${res ? `阶段收束为：${res}` : '动作与视线随时间有阶段推进'}；镜头以「${camChain}」配合人物动线，读出空间纵深与时间流逝`;
  const lensBlock = `运镜链：${camChain}；景别机位：${shotBits || '中景，平视'}，三分法或对角线择一（结尾动势：[${res || '视线或身体动线指向下一个节拍，动势渐收可衔接下镜'}]）`;
  const sfx = `环境层-[与${loc}一致的环境声底与远处细节] 动作层-[与动作同步的物理接触声] 情绪层-[无旋律仅以空间混响与材质细微声烘托情绪张力]`;
  const styleTail = (styleHint && String(styleHint).trim()) || '电影感叙事光色';
  const dia = (d.dialogue || '').trim().replace(/"/g, "'");
  let line = `主体：@人物1${emoParen}[朝向：依轴线面向戏中对象或画左/画右择一并保持统一] 正在 ${motionCore}（与上镜衔接：${link}） 叙事动态：${narrDyn} 空间：前景-[${fg}] 中景-[${mg}] 背景-[${bg}] 光影：${lightBlock} 镜头：${lensBlock}`;
  if (dia) line += ` 台词：第1秒 @人物1："${dia}"`;
  if (sb.narration) line += ` 旁白：“${String(sb.narration)}”`;
  line += ` 音效：${sfx} ${styleTail} [禁BGM][禁字幕]`;
  return line.replace(/\r?\n/g, ' ');
}

function getStoryboardsForEpisode(db, episodeId) {
  const rows = dedupeStoryboardRowsByNumber(
    db.prepare(
      'SELECT * FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL ORDER BY storyboard_number ASC, id ASC'
    ).all(episodeId)
  );
  const sbIds = rows.map((r) => r.id);
  const spMap = {};
  if (sbIds.length > 0) {
    try {
      const placeholders = sbIds.map(() => '?').join(',');
      const spRows = db.prepare(`SELECT storyboard_id, prop_id FROM storyboard_props WHERE storyboard_id IN (${placeholders})`).all(...sbIds);
      for (const row of spRows) {
        if (!spMap[row.storyboard_id]) spMap[row.storyboard_id] = [];
        spMap[row.storyboard_id].push(row.prop_id);
      }
    } catch (_) {}
  }
  return rows.map((r) => {
    let background = null;
    if (r.scene_id != null) {
      const sceneRow = db.prepare('SELECT * FROM scenes WHERE id = ? AND deleted_at IS NULL').get(r.scene_id);
      if (sceneRow) background = rowToScene(sceneRow);
    }
    return {
      id: r.id,
      episode_id: r.episode_id,
      scene_id: r.scene_id,
      storyboard_number: r.storyboard_number,
      title: r.title,
      description: r.description,
      location: r.location,
      time: r.time,
      duration: normalizeDuration(r.duration),
      dialogue: r.dialogue,
      narration: r.narration ?? null,
      action: r.action,
      result: r.result,
      atmosphere: r.atmosphere,
      image_prompt: r.image_prompt,
      video_prompt: r.video_prompt,
      video_model: r.video_model ?? null,
      shot_type: r.shot_type,
      angle: r.angle,
      angle_h: r.angle_h ?? null,
      angle_v: r.angle_v ?? null,
      angle_s: r.angle_s ?? null,
      movement: r.movement,
      lighting_style: r.lighting_style ?? null,
      depth_of_field: r.depth_of_field ?? null,
      bgm_prompt: r.bgm_prompt ?? null,
      sound_effect: r.sound_effect ?? null,
      segment_index: r.segment_index ?? 0,
      segment_title: r.segment_title ?? null,
      creation_mode: r.creation_mode === 'universal' ? 'universal' : 'classic',
      universal_segment_text: r.universal_segment_text ?? null,
      layout_description: r.layout_description ?? null,
      semantic_slots: (() => { try { return r.semantic_slots ? (typeof r.semantic_slots === 'string' ? JSON.parse(r.semantic_slots) : r.semantic_slots) : null; } catch (_) { return null; } })(),
      character_visuals: (() => { try { return r.character_visuals ? (typeof r.character_visuals === 'string' ? JSON.parse(r.character_visuals) : r.character_visuals) : null; } catch (_) { return null; } })(),
      last_frame_visuals: (() => { try { return r.last_frame_visuals ? (typeof r.last_frame_visuals === 'string' ? JSON.parse(r.last_frame_visuals) : r.last_frame_visuals) : null; } catch (_) { return null; } })(),
      video_slots: (() => { try { return r.video_slots ? (typeof r.video_slots === 'string' ? JSON.parse(r.video_slots) : r.video_slots) : null; } catch (_) { return null; } })(),
      dialogue_framing: r.dialogue_framing ?? null,
      start_framing: r.start_framing ?? null,
      end_framing: r.end_framing ?? null,
      transition_to_next: r.transition_to_next ?? null,
      characters: (() => {
        let parsed = [];
        if (r.characters) {
          if (typeof r.characters !== 'string') parsed = Array.isArray(r.characters) ? r.characters : [];
          else {
            try { parsed = JSON.parse(r.characters); } catch (_) { parsed = []; }
          }
        }
        let charIds = (Array.isArray(parsed) ? parsed : [parsed])
          .map((c) => (typeof c === 'object' && c != null && c.id != null ? Number(c.id) : Number(c)))
          .filter(Number.isFinite);

        if (!charIds.length && r.semantic_slots) {
          try {
            const sem = typeof r.semantic_slots === 'string' ? JSON.parse(r.semantic_slots) : r.semantic_slots;
            if (Array.isArray(sem?.visible_characters)) {
              charIds = sem.visible_characters.map((c) => Number(c.id)).filter(Number.isFinite);
            }
          } catch (_) {}
        }
        if (!charIds.length && r.character_visuals) {
          try {
            const vis = typeof r.character_visuals === 'string' ? JSON.parse(r.character_visuals) : r.character_visuals;
            if (Array.isArray(vis)) {
              charIds = vis.map((c) => Number(c.character_id)).filter(Number.isFinite);
            }
          } catch (_) {}
        }
        if (!charIds.length && Array.isArray(parsed) && parsed.length > 0) {
          try {
            const ep = db.prepare('SELECT drama_id FROM episodes WHERE id = ?').get(r.episode_id);
            if (ep?.drama_id) {
              const nameRows = db.prepare('SELECT id, name FROM characters WHERE drama_id = ? AND deleted_at IS NULL').all(ep.drama_id);
              const nameMap = new Map(nameRows.map((c) => [c.name.trim(), Number(c.id)]));
              charIds = parsed.map((name) => (typeof name === 'string' ? nameMap.get(name.trim()) : null)).filter(Number.isFinite);
            }
          } catch (_) {}
        }
        return Array.from(new Set(charIds));
      })(),
      prop_ids: (() => {
        let pids = spMap[r.id] || [];
        if (!pids.length && r.semantic_slots) {
          try {
            const sem = typeof r.semantic_slots === 'string' ? JSON.parse(r.semantic_slots) : r.semantic_slots;
            if (Array.isArray(sem?.required_references)) {
              pids = sem.required_references
                .filter((ref) => ref.type === 'prop')
                .map((ref) => Number(ref.id || ref.prop_id))
                .filter(Number.isFinite);
            }
          } catch (_) {}
        }
        return Array.from(new Set(pids));
      })(),
      composed_image: r.composed_image,
      video_url: r.video_url,
      selected_video_id: r.selected_video_id != null ? Number(r.selected_video_id) : null,
      audio_local_path: r.audio_local_path ?? null,
      narration_audio_local_path: r.narration_audio_local_path ?? null,
      long_take_group_id: r.long_take_group_id ?? null,
      long_take_role: r.long_take_role ?? null,
      long_take_sequence: r.long_take_sequence != null ? Number(r.long_take_sequence) : null,
      status: r.status || 'pending',
      created_at: r.created_at,
      updated_at: r.updated_at,
      background,
    };
  });
}

// 生图提示词由结构化槽位直接编译；不做正则补写或静默改写导演动作文本。

function generateImagePrompt(sb, style) {
  const { stripChineseExclusions } = require('../utils/framePromptSanitize');

  // 若包含预置槽位（character_visuals），优先使用确定性槽位编译器
  let visuals = sb.character_visuals;
  if (typeof visuals === 'string') {
    try { visuals = JSON.parse(visuals); } catch (_) { visuals = null; }
  }
  if (Array.isArray(visuals) && visuals.length > 0) {
    const { compileImagePromptFromSlots } = require('../ontology/visualSlots');
    return compileImagePromptFromSlots(sb, visuals, { style });
  }

  const parts = [];
  // 场景位置与时间
  if (sb.location) {
    let locationDesc = stripChineseExclusions(sb.location);
    if (sb.time) locationDesc += '（' + stripChineseExclusions(sb.time) + '）';
    parts.push(`【场景空间】${locationDesc}`);
  }
  // 镜头视角：优先结构化三元组（中文标签），降级到旧文本
  let angleLabel = '';
  if (sb.angle_h && sb.angle_v && sb.angle_s) {
    angleLabel = angleService.toChineseLabel(sb.angle_h, sb.angle_v, sb.angle_s);
  } else if (sb.angle || sb.shot_type) {
    const { h, v, s } = angleService.parseFromLegacyText(sb.angle || '', sb.shot_type || '');
    angleLabel = angleService.toChineseLabel(h, v, s);
  }
  if (angleLabel) {
    parts.push(`【机位景别】${angleLabel}`);
  }
  // 画面动作（直接保留去噪后的导演描述，不做自由文本补写）
  if (sb.action) {
    const staticPose = stripChineseExclusions(sb.action).trim();
    if (staticPose) parts.push(`【角色构图与姿态】${staticPose}`);
  }
  // 情绪与光影
  if (sb.emotion || sb.atmosphere || sb.lighting_style) {
    const lparts = [sb.lighting_style, sb.atmosphere, sb.emotion].filter(Boolean);
    if (lparts.length > 0) parts.push(`【光影影调】${lparts.join('，')}`);
  }
  // 风格（英文 prompt token，保持英文以兼容图片 AI）
  const styleText = (style && String(style).trim()) || 'photorealistic, ultra-detailed, 8k uhd, sharp focus';
  parts.push(`【摄影风格】${styleText}，首帧静止画面`);
  return parts.join('\n');
}

function generateLastFramePrompt(sb, style) {
  let lastVisuals = sb.last_frame_visuals;
  if (typeof lastVisuals === 'string') {
    try { lastVisuals = JSON.parse(lastVisuals); } catch (_) { lastVisuals = null; }
  }
  const { compileLastFramePromptFromSlots } = require('../ontology/visualSlots');
  if (!Array.isArray(lastVisuals) || lastVisuals.length === 0) {
    if (sb.last_frame_prompt && String(sb.last_frame_prompt).trim()) {
      return String(sb.last_frame_prompt).trim();
    }
    return compileLastFramePromptFromSlots(sb, [], { style });
  }
  return compileLastFramePromptFromSlots(sb, lastVisuals, { style });
}

/**
 * 从 AI 分镜的 characters 字段提取角色造型文本（#38）。
 * @param {Array} sbCharacters AI 返回的角色列表，元素为 {id,name} / id / name
 * @param {Object<string,string>} [appearanceMap] id 或 `name:姓名` → 「姓名」造型 的映射
 * @returns {string} 每行一个角色的造型文本；无可用信息时返回空串
 */
function buildCharacterAppearancesFromAiCharacters(sbCharacters, appearanceMap) {
  if (!appearanceMap || !Array.isArray(sbCharacters) || sbCharacters.length === 0) return '';
  const lines = [];
  const seen = new Set();
  for (const item of sbCharacters) {
    let line = null;
    if (item != null && typeof item === 'object') {
      line = (item.id != null ? appearanceMap[String(item.id)] : null)
        || (item.name ? appearanceMap['name:' + String(item.name).trim()] : null);
    } else if (item != null) {
      const key = String(item).trim();
      line = appearanceMap[key] || appearanceMap['name:' + key];
    }
    if (line && !seen.has(line)) {
      seen.add(line);
      lines.push(line);
    }
  }
  return lines.join('\n');
}

/**
 * 本剧角色造型映射（#38）：id / `name:姓名` → 「姓名」造型。
 * AI 分镜只带角色 id 与姓名，须在入库前把外貌补进视频提示词，
 * 否则视频模型无从获知人物形象，每次生成结果随机。
 */
function buildDramaCharacterAppearanceMap(characters) {
  const map = {};
  for (const c of characters || []) {
    const appearance = String(c.appearance || '').trim();
    if (!appearance) continue;
    const line = c.name ? `「${c.name}」${appearance}` : appearance;
    map[String(c.id)] = line;
    if (c.name) map['name:' + String(c.name).trim()] = line;
  }
  return map;
}

/**
 * 从 AI 输出的单个分镜对象计算入库字段（INSERT/UPDATE 共用）。
 * 会就地写入 sb.location / sb.time（由 scene_description 拆分）。
 */
function deriveStoryboardFieldsFromAi(sb, style, videoRatio, opts = {}) {
  const universalOmni = !!opts.universalOmni;
  const angleValFn = (x) => x.angle ?? x.camera_angle ?? null;
  const shotNumber = normalizeStoryboardShotNumber(sb);
  const title = sb.title ?? '';
  let shotType = sb.shot_type ?? '';
  let movement = sb.movement ?? sb.camera_movement ?? '';
  const angle = angleValFn(sb);
  const action = sb.action ?? '';
  const dialogue = sb.dialogue ?? '';
  const narration = sb.narration ?? '';
  const result = sb.result ?? '';
  const emotion = sb.emotion ?? '';
  const segmentIndex = sb.segment_index != null ? Number(sb.segment_index) : 0;
  const segmentTitle = sb.segment_title ?? null;
  let lightingStyle = sb.lighting_style ?? null;
  let depthOfField = sb.depth_of_field ?? null;

  // 摄影参数归一化与自动推断（确保分镜视角、灯光、景别、运镜、景深全量就绪）
  const inferred = angleService.inferPhotographyParams(sb, { upgradeStatic: true });
  const normMovement = angleService.normalizeMovement(movement);
  // 严格少用固定镜头 static：若 AI 输出了 static 或为空，自动升级为推断的动态运镜（除非剧情明确要求固定）
  if (!normMovement || (normMovement === 'static' && inferred.movement && inferred.movement !== 'static')) {
    movement = inferred.movement;
  } else {
    movement = normMovement;
  }
  lightingStyle = angleService.normalizeLighting(lightingStyle) || inferred.lighting_style || 'natural';
  depthOfField = angleService.normalizeDof(depthOfField) || inferred.depth_of_field || 'medium';

  // 镜头视角三元组 (h, v, s) 归一化与自动推断
  const { h: angleH, v: angleV, s: angleS } = angleService.inferAngleTriple({
    ...sb,
    shot_type: shotType,
    angle,
    action,
    atmosphere: sb.atmosphere,
  });

  if (!shotType && angleS) {
    shotType = angleS === 'close_up' ? '特写' : (angleS === 'wide' ? '远景' : '中景');
  }

  let durationSec = normalizeDuration(sb.duration) || 5;
  const targetClip = opts.targetClipDuration != null ? Number(opts.targetClipDuration) : 0;
  if (opts.durationRange) {
    durationSec = planShotDuration(sb, opts.durationRange);
  } else if (Number.isFinite(targetClip) && targetClip > 0) {
    durationSec = Math.round(targetClip);
  }
  durationSec = Math.min(120, Math.max(1, Math.round(durationSec)));
  sb.duration = durationSec;
  if (!sb.location && sb.scene_description) {
    const sceneDesc = String(sb.scene_description).trim();
    const sepIdx = sceneDesc.search(/[，,、]/);
    if (sepIdx > 0) {
      sb.location = sceneDesc.slice(0, sepIdx).trim();
      if (!sb.time) sb.time = sceneDesc.slice(sepIdx + 1).trim();
    } else {
      sb.location = sceneDesc;
    }
  }
  const description = `【镜头类型】${shotType}\n【运镜】${movement}\n【动作】${action}\n【对话】${dialogue}\n【解说】${narration}\n【结果】${result}\n【情绪】${emotion}`;
  // 背景音乐与音效设计：无对白镜头必须配上背景音乐描述，专供 H3 等视频模型原生生成高质量背景音乐
  let bgmPrompt = (sb.bgm_prompt || '').toString().trim();
  const soundEffect = (sb.sound_effect || '').toString().trim();
  if (!dialogue && (!bgmPrompt || bgmPrompt === '无' || /禁bgm|无背景音乐|no\s*bgm/i.test(bgmPrompt))) {
    bgmPrompt = angleService.inferBgmPrompt(sb);
  }
  const sbWithAngles = { ...sb, shot_type: shotType, movement, lighting_style: lightingStyle, depth_of_field: depthOfField, angle_h: angleH, angle_v: angleV, angle_s: angleS, bgm_prompt: bgmPrompt, sound_effect: soundEffect };

  // 首尾帧双关键帧槽位与视频语义槽位契约（消灭无槽位、正则匹配、尾帧形变与口型错乱）
  let characterVisuals = sb.character_visuals;
  if (typeof characterVisuals === 'string') {
    try { characterVisuals = JSON.parse(characterVisuals); } catch (_) { characterVisuals = null; }
  }
  // 执行层视觉槽位必须由导演 Agent 规划；基础分镜阶段不再用本地模板猜测姿态、视线或站位。
  if (!Array.isArray(characterVisuals)) characterVisuals = null;

  let lastFrameVisuals = sb.last_frame_visuals;
  if (typeof lastFrameVisuals === 'string') {
    try { lastFrameVisuals = JSON.parse(lastFrameVisuals); } catch (_) { lastFrameVisuals = null; }
  }
  if (!Array.isArray(lastFrameVisuals)) lastFrameVisuals = null;

  // 角色造型注入（#38）：视频提示词须携带角色外貌，否则视频模型每次随机生成人物形象
  const characterAppearances = buildCharacterAppearancesFromAiCharacters(sb.characters, opts.characterAppearances);

  let videoSlots = sb.video_slots;
  if (typeof videoSlots === 'string') {
    try { videoSlots = JSON.parse(videoSlots); } catch (_) { videoSlots = null; }
  }
  if (!videoSlots || typeof videoSlots !== 'object' || !videoSlots.camera || !videoSlots.audio_lip_sync) videoSlots = null;

  const sbWithSlots = {
    ...sbWithAngles,
    character_visuals: characterVisuals,
    last_frame_visuals: lastFrameVisuals,
    video_slots: videoSlots,
    character_appearances: characterAppearances,
  };

  const imagePrompt = generateImagePrompt(sbWithSlots, style);
  // H3 compiles its final prompt directly from the authoritative slots at
  // submission time. Do not persist a second, editable text representation.
  const videoPrompt = null;
  const sceneId = sb.scene_id != null ? Number(sb.scene_id) : null;
  // 角色 ID 规范化：优先数字 ID / 对象 ID，若是名字字符串则在 opts.dramaCharacters 中按名解析为 ID
  const rawChars = Array.isArray(sb.characters) ? sb.characters : (sb.characters != null ? [sb.characters] : []);
  const charIds = Array.from(new Set(rawChars
    .map((c) => {
      if (typeof c === 'object' && c != null && c.id != null) return Number(c.id);
      if (Number.isFinite(Number(c)) && String(c).trim() !== '') return Number(c);
      if (typeof c === 'string' && opts.dramaCharacters?.length) {
        const found = opts.dramaCharacters.find((dc) => dc.name && dc.name.trim() === c.trim());
        if (found) return Number(found.id);
      }
      return null;
    })
    .filter(Number.isFinite)));
  const charactersJson = JSON.stringify(charIds);
  const backgroundCharactersJson = Array.isArray(sb.background_characters) ? JSON.stringify(sb.background_characters) : (sb.background_characters ? JSON.stringify([].concat(sb.background_characters)) : '[]');

  // 道具 ID 规范化
  const rawProps = Array.isArray(sb.props) ? sb.props : (sb.props != null ? [sb.props] : []);
  const propIds = Array.from(new Set(rawProps
    .map((p) => {
      if (typeof p === 'object' && p != null && p.id != null) return Number(p.id);
      if (Number.isFinite(Number(p)) && String(p).trim() !== '') return Number(p);
      if (typeof p === 'string' && opts.dramaProps?.length) {
        const found = opts.dramaProps.find((dp) => dp.name && dp.name.trim() === p.trim());
        if (found) return Number(found.id);
      }
      return null;
    })
    .filter(Number.isFinite)));
  let universalSegmentText = '';
  if (sb.universal_segment_text != null && String(sb.universal_segment_text).trim()) {
    universalSegmentText = String(sb.universal_segment_text).trim().replace(/\r?\n/g, ' ');
  }
  if (universalOmni && !universalSegmentText) {
    universalSegmentText = buildFallbackUniversalH3Line(
      sb,
      {
        shotNumber,
        durationSec,
        shotType,
        movement,
        angle,
        action,
        dialogue,
        result,
        emotion,
        lightingStyle,
        depthOfField,
      },
      style
    );
  }
  const creationMode = universalOmni ? 'universal' : 'classic';
  if (!universalOmni) universalSegmentText = null;
  const layoutDescription = (sb.layout_description && String(sb.layout_description).trim()) || null;
  const dialogueFraming = sb.dialogue_framing || (Array.isArray(sb.characters) && sb.characters.length >= 2 ? (dialogue ? 'two_shot_face_to_face' : 'joint_observation') : (dialogue ? 'single_reaction_offscreen' : 'solo_action'));
  return {
    shotNumber,
    title,
    dialogueFraming,
    shotType,
    movement,
    angle,
    action,
    dialogue,
    narration,
    result,
    emotion,
    segmentIndex,
    segmentTitle,
    lightingStyle,
    depthOfField,
    bgmPrompt,
    soundEffect,
    description,
    imagePrompt,
    videoPrompt,
    characterVisuals,
    lastFrameVisuals,
    videoSlots,
    sceneId,
    charIds,
    charactersJson,
    backgroundCharactersJson,
    angleH,
    angleV,
    angleS,
    propIds,
    creationMode,
    universalSegmentText,
    layoutDescription,
  };
}

/**
 * 持久化执行器真正消费的 Agent 合同。旧测试库可能没有这些增量列，
 * 因此按 PRAGMA 检测后更新；不推断、不补写任何创意字段。
 */
function persistStoryboardExecutionContract(db, storyboardId, sb) {
  const available = new Set(db.prepare('PRAGMA table_info(storyboards)').all().map((column) => column.name));
  const updates = [];
  const values = [];
  const add = (column, value) => {
    if (!available.has(column)) return;
    updates.push(`${column} = ?`);
    values.push(value);
  };
  if (Object.prototype.hasOwnProperty.call(sb || {}, 'semantic_slots')) {
    const semantic = sb.semantic_slots;
    add('semantic_slots', semantic == null || semantic === ''
      ? null
      : (typeof semantic === 'string' ? semantic : JSON.stringify(semantic)));
  }
  if (Object.prototype.hasOwnProperty.call(sb || {}, 'long_take_group_id')) {
    add('long_take_group_id', sb.long_take_group_id || null);
  }
  if (Object.prototype.hasOwnProperty.call(sb || {}, 'long_take_role')) {
    add('long_take_role', sb.long_take_role || null);
  }
  if (Object.prototype.hasOwnProperty.call(sb || {}, 'long_take_sequence')) {
    const sequence = Number(sb.long_take_sequence);
    add('long_take_sequence', Number.isInteger(sequence) && sequence > 0 ? sequence : null);
  }
  if (!updates.length) return;
  db.prepare(`UPDATE storyboards SET ${updates.join(', ')} WHERE id = ?`).run(...values, Number(storyboardId));
}

/** 用最终解析的分镜对象覆盖已存在的行（修正流式增量先入库时缺 narration 等字段的问题） */
function updateStoryboardRowFromDerived(db, existingId, episodeIdNum, d, sb, now) {
  try {
    db.prepare(
      `UPDATE storyboards SET
        scene_id = ?, title = ?, description = ?, location = ?, time = ?, duration = ?,
        dialogue = ?, narration = ?, action = ?, result = ?, atmosphere = ?,
        image_prompt = ?, video_prompt = ?, characters = ?,
        character_visuals = ?, last_frame_visuals = ?, video_slots = ?,
        shot_type = ?, angle = ?, angle_h = ?, angle_v = ?, angle_s = ?, movement = ?, dialogue_framing = COALESCE(?, dialogue_framing),
        lighting_style = ?, depth_of_field = ?, bgm_prompt = ?, sound_effect = ?, segment_index = ?, segment_title = ?,
        creation_mode = ?, universal_segment_text = ?,
        layout_description = COALESCE(?, layout_description),
        updated_at = ?
       WHERE id = ? AND episode_id = ? AND deleted_at IS NULL`
    ).run(
      d.sceneId,
      d.title || null,
      d.description,
      sb.location ?? null,
      sb.time ?? null,
      sb.duration ?? 5,
      d.dialogue || null,
      d.narration || null,
      d.action || null,
      d.result || null,
      sb.atmosphere ?? null,
      d.imagePrompt,
      d.videoPrompt,
      d.charactersJson,
      d.characterVisuals ? JSON.stringify(d.characterVisuals) : null,
      d.lastFrameVisuals ? JSON.stringify(d.lastFrameVisuals) : null,
      d.videoSlots ? JSON.stringify(d.videoSlots) : null,
      d.shotType || null,
      d.angle,
      d.angleH,
      d.angleV,
      d.angleS,
      d.movement || null,
      d.dialogueFraming || null,
      d.lightingStyle,
      d.depthOfField,
      d.bgmPrompt || null,
      d.soundEffect || null,
      d.segmentIndex,
      d.segmentTitle,
      d.creationMode || 'classic',
      d.universalSegmentText != null ? d.universalSegmentText : null,
      d.layoutDescription,
      now,
      existingId,
      episodeIdNum
    );
  } catch (upErr) {
    if ((upErr.message || '').includes('character_visuals') || (upErr.message || '').includes('layout_description') || (upErr.message || '').includes('bgm_prompt')) {
      db.prepare(
        `UPDATE storyboards SET
          scene_id = ?, title = ?, description = ?, location = ?, time = ?, duration = ?,
          dialogue = ?, narration = ?, action = ?, result = ?, atmosphere = ?,
          image_prompt = ?, video_prompt = ?, characters = ?,
          shot_type = ?, angle = ?, angle_h = ?, angle_v = ?, angle_s = ?, movement = ?,
          lighting_style = ?, depth_of_field = ?, segment_index = ?, segment_title = ?,
          creation_mode = ?, universal_segment_text = ?,
          updated_at = ?
         WHERE id = ? AND episode_id = ? AND deleted_at IS NULL`
      ).run(
        d.sceneId,
        d.title || null,
        d.description,
        sb.location ?? null,
        sb.time ?? null,
        sb.duration ?? 5,
        d.dialogue || null,
        d.narration || null,
        d.action || null,
        d.result || null,
        sb.atmosphere ?? null,
        d.imagePrompt,
        d.videoPrompt,
        d.charactersJson,
        d.shotType || null,
        d.angle,
        d.angleH,
        d.angleV,
        d.angleS,
        d.movement || null,
        d.lightingStyle,
        d.depthOfField,
        d.segmentIndex,
        d.segmentTitle,
        d.creationMode || 'classic',
        d.universalSegmentText != null ? d.universalSegmentText : null,
        now,
        existingId,
        episodeIdNum
      );
    } else {
      throw upErr;
    }
  }
  persistStoryboardExecutionContract(db, existingId, sb);
  require('./wardrobeService').recordAiChange(db, episodeIdNum, existingId, sb);
  require('./speechDeliveryService').recordAiPlan(db, episodeIdNum, existingId, sb);
  try {
    db.prepare('DELETE FROM storyboard_characters WHERE storyboard_id = ?').run(existingId);
    if (d.charIds && d.charIds.length > 0) {
      const insChar = db.prepare('INSERT OR IGNORE INTO storyboard_characters (storyboard_id, character_id, created_at) VALUES (?, ?, ?)');
      for (const cid of d.charIds) insChar.run(existingId, cid, now);
    }
  } catch (_) {}
  try {
    db.prepare('DELETE FROM storyboard_props WHERE storyboard_id = ?').run(existingId);
    if (d.propIds.length > 0) {
      const insProp = db.prepare('INSERT OR IGNORE INTO storyboard_props (storyboard_id, prop_id) VALUES (?, ?)');
      for (const pid of d.propIds) insProp.run(existingId, pid);
    }
  } catch (_) {}
}

/**
 * 将单个分镜对象插入 DB，供增量流式保存使用。
 * 返回插入后的 id，出错则返回 null（不抛异常）。
 */
function insertOneStoryboard(db, episodeIdNum, sb, style, videoRatio, now, deriveOpts = {}) {
  const d = deriveStoryboardFieldsFromAi(sb, style, videoRatio, deriveOpts);
  const shotNumber = d.shotNumber;
  try {
    let newId;
    try {
      const info = db.prepare(
        `INSERT INTO storyboards (episode_id, scene_id, storyboard_number, title, description, location, time, duration, dialogue, narration, action, result, atmosphere, image_prompt, video_prompt, characters, background_characters, character_visuals, last_frame_visuals, video_slots, shot_type, angle, angle_h, angle_v, angle_s, dialogue_framing, movement, lighting_style, depth_of_field, bgm_prompt, sound_effect, segment_index, segment_title, creation_mode, universal_segment_text, layout_description, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      ).run(
        episodeIdNum, d.sceneId, shotNumber, d.title || null, d.description,
        sb.location ?? null, sb.time ?? null, sb.duration ?? 5,
        d.dialogue || null, d.narration || null, d.action || null, d.result || null, sb.atmosphere ?? null,
        d.imagePrompt, d.videoPrompt, d.charactersJson,
        d.backgroundCharactersJson,
        d.characterVisuals ? JSON.stringify(d.characterVisuals) : null,
        d.lastFrameVisuals ? JSON.stringify(d.lastFrameVisuals) : null,
        d.videoSlots ? JSON.stringify(d.videoSlots) : null,
        d.shotType || null, d.angle, d.angleH, d.angleV, d.angleS,
        d.dialogueFraming || null,
        d.movement || null, d.lightingStyle, d.depthOfField, d.bgmPrompt || null, d.soundEffect || null, d.segmentIndex, d.segmentTitle,
        d.creationMode || 'classic',
        d.universalSegmentText != null ? d.universalSegmentText : null,
        d.layoutDescription,
        now, now
      );
      newId = info.lastInsertRowid;
    } catch (colErr) {
      if ((colErr.message || '').includes('character_visuals') || (colErr.message || '').includes('layout_description') || (colErr.message || '').includes('bgm_prompt') || (colErr.message || '').includes('background_characters')) {
        const info = db.prepare(
          `INSERT INTO storyboards (episode_id, scene_id, storyboard_number, title, description, location, time, duration, dialogue, narration, action, result, atmosphere, image_prompt, video_prompt, characters, shot_type, angle, angle_h, angle_v, angle_s, movement, lighting_style, depth_of_field, segment_index, segment_title, creation_mode, universal_segment_text, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
        ).run(
          episodeIdNum, d.sceneId, shotNumber, d.title || null, d.description,
          sb.location ?? null, sb.time ?? null, sb.duration ?? 5,
          d.dialogue || null, d.narration || null, d.action || null, d.result || null, sb.atmosphere ?? null,
          d.imagePrompt, d.videoPrompt, d.charactersJson,
          d.shotType || null, d.angle, d.angleH, d.angleV, d.angleS,
          d.movement || null, d.lightingStyle, d.depthOfField, d.segmentIndex, d.segmentTitle,
          d.creationMode || 'classic',
          d.universalSegmentText != null ? d.universalSegmentText : null,
          now, now
        );
        newId = info.lastInsertRowid;
      } else {
        throw colErr;
      }
    }
    persistStoryboardExecutionContract(db, newId, sb);
    require('./wardrobeService').recordAiChange(db, episodeIdNum, newId, sb);
    require('./speechDeliveryService').recordAiPlan(db, episodeIdNum, newId, sb);
    if (d.charIds && d.charIds.length > 0) {
      try {
        const insChar = db.prepare('INSERT OR IGNORE INTO storyboard_characters (storyboard_id, character_id, created_at) VALUES (?, ?, ?)');
        for (const cid of d.charIds) insChar.run(newId, cid, now);
      } catch (_) {}
    }
    if (d.propIds.length > 0) {
      try {
        const insProp = db.prepare('INSERT OR IGNORE INTO storyboard_props (storyboard_id, prop_id) VALUES (?, ?)');
        for (const pid of d.propIds) insProp.run(newId, pid);
      } catch (_) {}
    }
    return newId;
  } catch (_) {
    return null;
  }
}

/**
 * 在流式输出过程中，从已积累的文本尝试解析并保存尚未保存的分镜。
 * savedNums：已保存的 storyboard_number Set，用于去重。
 */
function tryIncrementalSave(db, log, episodeIdNum, accumulated, savedNums, style, videoRatio, deriveOpts = {}) {
  if (deriveOpts.deferPersistence) return;
  try {
    let cleaned = accumulated.trim()
      .replace(/^```json\s*/gm, '').replace(/^```\s*/gm, '').replace(/```\s*$/gm, '').trim();
    // 转义字符串字段里的原始换行符，防止 JSON.parse 报 "Unterminated string"
    cleaned = safeJson.escapeNewlinesInStrings(cleaned);
    let candidate = extractJsonCandidate(cleaned);
    if (!candidate) return;

    // 如果 AI 将数组包在对象里（如 doubao 的 {"storyboards":[...]}），提取内部数组
    const innerArray = safeJson.extractWrappedArrayStr(candidate);
    const arrayCandidate = innerArray || candidate;

    // 策略A：截断修复（找到已完整闭合的顶层元素）
    let parsed = null;
    const repaired = repairTruncatedJsonArray(arrayCandidate);
    if (repaired) {
      try { parsed = JSON.parse(repaired); } catch (_) {}
      // 策略B：截断修复 + jsonrepair
      if (!parsed && safeJson._jsonrepair) {
        try { parsed = JSON.parse(safeJson._jsonrepair(repaired)); } catch (_) {}
      }
    }
    // 策略C：直接 jsonrepair 整体修复
    if (!parsed && safeJson._jsonrepair) {
      try { parsed = JSON.parse(safeJson._jsonrepair(arrayCandidate)); } catch (_) {}
    }
    if (!parsed) return;
    const items = Array.isArray(parsed) ? parsed : extractFirstArray(parsed);
    if (!items || items.length === 0) return;
    const now = new Date().toISOString();
    let newCount = 0;
    for (const sb of items) {
      const shotNumber = normalizeStoryboardShotNumber(sb);
      if (shotNumber > 0 && savedNums.has(shotNumber)) continue;
      const id = insertOneStoryboard(db, episodeIdNum, sb, style, videoRatio, now, deriveOpts);
      if (id !== null) {
        savedNums.add(shotNumber);
        newCount++;
      }
    }
    if (newCount > 0) {
      log.info('Storyboard incremental save', { episode_id: episodeIdNum, new_count: newCount, total_saved: savedNums.size });
    }
  } catch (_) { /* 流式解析错误静默忽略，等待最终完整解析 */ }
}

/**
 * @param {Set|null} skipShotNumbers - 已通过增量流式保存的 storyboard_number 集合，跳过重复插入
 */
function saveStoryboards(db, log, episodeId, storyboards, cfg, styleOverride, skipShotNumbers = null, deriveOpts = {}) {
  const episodeIdNum = Number(episodeId);
  if (storyboards.length === 0) {
    throw new Error('AI生成分镜失败：返回的分镜数量为0');
  }
  const style = (styleOverride && String(styleOverride).trim()) || cfg?.style?.default_style || '';
  const videoRatio = cfg?.style?.default_video_ratio || '16:9';
  const now = new Date().toISOString();

  // 仅在非增量模式下才删除旧数据（增量模式时已在流式开始前删除）
  if (skipShotNumbers === null) {
    const existing = db.prepare('SELECT id FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL').all(episodeIdNum);
    if (existing.length > 0) {
      db.prepare('UPDATE storyboards SET deleted_at = ? WHERE episode_id = ?').run(now, episodeIdNum);
    }
  }

  const saved = [];
  const processedInSave = new Set();
  for (const sb of storyboards) {
    const shotNumber = normalizeStoryboardShotNumber(sb);
    if (shotNumber > 0 && processedInSave.has(shotNumber)) {
      log.warn('Duplicate storyboard_number in final AI batch, skipping extra row', {
        episode_id: episodeIdNum,
        storyboard_number: shotNumber,
      });
      continue;
    }

    // 已由增量流式保存过的分镜：必须用**最终完整 JSON** 再 UPDATE 一行（否则首镜常在流式阶段缺 narration 等字段且永不修正）
    if (skipShotNumbers && skipShotNumbers.has(shotNumber)) {
      const existing = db.prepare(
        'SELECT * FROM storyboards WHERE episode_id = ? AND storyboard_number = ? AND deleted_at IS NULL'
      ).get(episodeIdNum, shotNumber);
      if (existing) {
        const d = deriveStoryboardFieldsFromAi(sb, style, videoRatio, deriveOpts);
        updateStoryboardRowFromDerived(db, existing.id, episodeIdNum, d, sb, now);
        log.info('Storyboard merged from final parse after incremental save', {
          episode_id: episodeIdNum,
          storyboard_id: existing.id,
          storyboard_number: shotNumber,
        });
        const refreshed = db.prepare(
          'SELECT * FROM storyboards WHERE id = ? AND deleted_at IS NULL'
        ).get(existing.id);
        let propIds = [];
        try {
          const propLinks = db.prepare('SELECT prop_id FROM storyboard_props WHERE storyboard_id = ?').all(refreshed.id);
          propIds = propLinks.map((p) => p.prop_id);
        } catch (_) {}
        saved.push({
          id: refreshed.id,
          episode_id: episodeIdNum,
          scene_id: refreshed.scene_id,
          storyboard_number: shotNumber,
          title: refreshed.title,
          description: refreshed.description,
          location: refreshed.location,
          time: refreshed.time,
          duration: refreshed.duration,
          dialogue: refreshed.dialogue,
          narration: refreshed.narration ?? null,
          action: refreshed.action,
          result: refreshed.result,
          atmosphere: refreshed.atmosphere,
          image_prompt: refreshed.image_prompt,
          video_prompt: refreshed.video_prompt,
          shot_type: refreshed.shot_type,
          angle: refreshed.angle,
          movement: refreshed.movement,
          segment_index: refreshed.segment_index ?? 0,
          segment_title: refreshed.segment_title ?? null,
          creation_mode: refreshed.creation_mode === 'universal' ? 'universal' : 'classic',
          universal_segment_text: refreshed.universal_segment_text ?? null,
          characters: (() => { try { return JSON.parse(refreshed.characters || '[]'); } catch (_) { return []; } })(),
          prop_ids: propIds,
          status: refreshed.status,
          created_at: refreshed.created_at,
          updated_at: refreshed.updated_at,
        });
        if (shotNumber > 0) processedInSave.add(shotNumber);
        continue;
      }
      // 流式阶段已登记镜号但库中无行（竞态/异常）：不再 INSERT 重复行
      if (shotNumber > 0) {
        log.warn('Incremental shot missing in DB at final save, skipping insert', {
          episode_id: episodeIdNum,
          storyboard_number: shotNumber,
        });
        continue;
      }
    }

    const d = deriveStoryboardFieldsFromAi(sb, style, videoRatio, deriveOpts);

    try {
      db.prepare(
        `INSERT INTO storyboards (episode_id, scene_id, storyboard_number, title, description, location, time, duration, dialogue, narration, action, result, atmosphere, image_prompt, video_prompt, characters, background_characters, shot_type, angle, angle_h, angle_v, angle_s, movement, lighting_style, depth_of_field, bgm_prompt, sound_effect, segment_index, segment_title, creation_mode, universal_segment_text, layout_description, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      ).run(
        episodeIdNum, d.sceneId, shotNumber, d.title || null, d.description,
        sb.location ?? null, sb.time ?? null, sb.duration ?? 5,
        d.dialogue || null, d.narration || null, d.action || null, d.result || null, sb.atmosphere ?? null,
        d.imagePrompt, d.videoPrompt, d.charactersJson,
        d.backgroundCharactersJson,
        d.shotType || null, d.angle, d.angleH, d.angleV, d.angleS,
        d.movement || null, d.lightingStyle, d.depthOfField, d.bgmPrompt || null, d.soundEffect || null, d.segmentIndex, d.segmentTitle,
        d.creationMode || 'classic',
        d.universalSegmentText != null ? d.universalSegmentText : null,
        d.layoutDescription,
        now, now
      );
    } catch (e) {
      if ((e.message || '').includes('shot_type') || (e.message || '').includes('angle') || (e.message || '').includes('movement') || (e.message || '').includes('result') || (e.message || '').includes('segment') || (e.message || '').includes('narration') || (e.message || '').includes('layout_description') || (e.message || '').includes('bgm_prompt') || (e.message || '').includes('background_characters')) {
        db.prepare(
          `INSERT INTO storyboards (episode_id, scene_id, storyboard_number, title, description, location, time, duration, dialogue, action, atmosphere, image_prompt, video_prompt, characters, creation_mode, universal_segment_text, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
        ).run(
          episodeIdNum, d.sceneId, shotNumber, d.title || null, d.description,
          sb.location ?? null, sb.time ?? null, sb.duration ?? 5,
          d.dialogue || null, d.action || null, sb.atmosphere ?? null,
          d.imagePrompt, d.videoPrompt, d.charactersJson,
          d.creationMode || 'classic',
          d.universalSegmentText != null ? d.universalSegmentText : null,
          now, now
        );
      } else {
        throw e;
      }
    }
    const id = db.prepare('SELECT last_insert_rowid() as id').get().id;
    persistStoryboardExecutionContract(db, id, sb);
    require('./wardrobeService').recordAiChange(db, episodeIdNum, id, sb);
    require('./speechDeliveryService').recordAiPlan(db, episodeIdNum, id, sb);
    if (d.charIds && d.charIds.length > 0) {
      try {
        const insChar = db.prepare('INSERT OR IGNORE INTO storyboard_characters (storyboard_id, character_id, created_at) VALUES (?, ?, ?)');
        for (const cid of d.charIds) insChar.run(id, cid, now);
      } catch (_) {}
    }
    if (d.propIds.length > 0) {
      try {
        const insProp = db.prepare('INSERT OR IGNORE INTO storyboard_props (storyboard_id, prop_id) VALUES (?, ?)');
        for (const pid of d.propIds) insProp.run(id, pid);
      } catch (_) {}
    }
    saved.push({
      id,
      episode_id: episodeIdNum,
      scene_id: d.sceneId,
      storyboard_number: shotNumber,
      title: d.title || null,
      description: d.description,
      location: sb.location ?? null,
      time: sb.time ?? null,
      duration: sb.duration ?? 5,
      dialogue: d.dialogue || null,
      narration: d.narration || null,
      action: d.action || null,
      result: d.result || null,
      atmosphere: sb.atmosphere ?? null,
      image_prompt: d.imagePrompt,
      video_prompt: d.videoPrompt,
      shot_type: d.shotType || null,
      angle: d.angle,
      movement: d.movement || null,
      segment_index: d.segmentIndex,
      segment_title: d.segmentTitle,
      creation_mode: d.creationMode || 'classic',
      universal_segment_text: d.universalSegmentText != null ? d.universalSegmentText : null,
      characters: d.charIds || [],
      prop_ids: d.propIds || [],
      status: 'pending',
      created_at: now,
      updated_at: now,
    });
    if (shotNumber > 0) processedInSave.add(shotNumber);
  }
  log.info('Storyboards saved', { episode_id: episodeId, count: saved.length });
  return saved;
}

/**
 * 构建续写 prompt：当首次响应被截断时，携带已生成分镜完整列表 + 末尾详情作为上下文，
 * 请求 AI 从 lastShotNum+1 继续生成剩余分镜。
 * 关键：必须把所有已生成分镜的 shot_number + segment_title + title 全部列出，
 * 防止 AI 因不知道哪些情节已覆盖而重复生成相同内容。
 */
function buildContinuationPrompt(originalUserPrompt, alreadySaved, lastShotNum, attempt, includeNarration, universalOmni = false) {
  const narrLine = includeNarration
    ? '\n- 每条新增分镜均有 narration 字符串；仅在需要解释关键背景或因果时补旁白，已讲清的对白镜头与过场可为空。'
    : '';
  const uniLine = universalOmni
    ? '\n- 每条新增分镜必须含 creation_mode:"universal" 与非空 universal_segment_text，沿用首轮的多行段落格式；默认一个连续子分镜、至多一种简单运镜，台词与 dialogue/narration 逐字一致。'
    : '';
  // 全量已生成分镜摘要（每行一个，仅 shot_number + segment + title）
  const allSummary = alreadySaved.map((sb) => {
    const num = sb.shot_number ?? sb.storyboard_number ?? 0;
    const seg = (sb.segment_title || '').replace(/"/g, '\\"');
    const title = (sb.title || '').replace(/"/g, '\\"');
    return `  ${num}. [${seg}] ${title}`;
  }).join('\n');

  // 末尾 5 个分镜的详细内容（供衔接用）
  const lastCtx = alreadySaved.slice(-5).map((sb) => {
    const num = sb.shot_number ?? sb.storyboard_number ?? 0;
    const title = (sb.title || '').replace(/"/g, '\\"');
    const loc = (sb.location || '').replace(/"/g, '\\"');
    const action = (sb.action || '').slice(0, 120).replace(/"/g, '\\"');
    return `  {"shot_number": ${num}, "title": "${title}", "location": "${loc}", "action": "${action}"}`;
  }).join(',\n');

  return `[续写指令 - 第${attempt}次续写]
之前的分镜生成因长度限制在 shot_number ${lastShotNum} 处中断，已生成 ${alreadySaved.length} 个分镜。

━━━ 已生成分镜完整列表（绝对不能重复以下内容）━━━
${allSummary}
━━━ 列表结束 ━━━

以上所有情节均已覆盖，请勿重复。末尾几个分镜详情供衔接参考：
[
${lastCtx}
]

请从 shot_number ${lastShotNum + 1} 继续生成剩余分镜，直至剧本全部场景覆盖完毕。
要求：
- 仅返回新增分镜（JSON数组），shot_number 从 ${lastShotNum + 1} 开始递增
- 格式与之前完全相同，字段保持一致${narrLine}${uniLine}
- 严禁重复已生成列表中的任何情节或场景
- 不要输出任何解释文字，直接输出 JSON

原始剧本与任务说明：
${originalUserPrompt}`;
}

function buildPlanningRepairPrompt(originalUserPrompt, storyboards, violations, attempt, catalogs = {}) {
  const messages = (violations || []).map((item) => `- 分镜#${item.shot_number || '?'} · ${item.message} · 冲突字段=${JSON.stringify(item.conflict_slots || [])}`).join('\n');
  const targetNumbers = [...new Set((violations || []).map((item) => Number(item.shot_number)).filter(Number.isFinite))];
  const characterCatalog = (catalogs.characters || []).map((item) => ({ id: item.id, name: item.name }));
  return `[阶段一规划修复 - 第${attempt}次]

【必须修复的门禁反馈】
${messages}

【修复要求】
- 只修改违规镜头 ${JSON.stringify(targetNumbers)} 以及因拆镜必须顺延的镜号；其他镜头保持不变。
- 若门禁提示「包含 N 个发言段」或「对白与旁白超出时长预算」：必须把该镜按说话轮次与句意拆成多个连续镜头！拆分后每个新镜最多只允许 1 个说话人的单轮对白（或 1 段旁白），严禁同一镜内多人交替发言或对白与旁白混镜；每镜 duration 必须在允许范围内并能完整容纳该镜台词（按 TTS 1.25x 约 5 字/秒），逐字保留全部对白/旁白、不得删字或重复，并为拆出的新镜补全标题、动作、结果与当前可见人物。
- 动作、结果、起幅和构图中明确实际出场的剧库角色，必须加入该镜 characters 或 background_characters；如果只是环境事件、敌军或群众，不得挂载身份角色。
- 每镜最多包含 2 个有身份的剧库角色；若加入后超过2人，必须按剧情拆成连续镜头，不能静默删除或选择性遗漏。
- 保留原剧本对白、旁白和剧情因果，不得删字、改写台词或把角色动作改成无依据的环境事件。
- 返回修复后的完整 storyboards 数组（连续重排 shot_number），不要返回补丁或解释文字。
【可用角色目录】
${JSON.stringify(characterCatalog)}
【当前完整候选】
${JSON.stringify(storyboards)}
【原始任务说明】
${originalUserPrompt}`;
}
function parseStoryboardArray(text, log) {
  const meta = {};
  const parsed = safeParseAIJSON(text, null, log, meta);
  const items = extractFirstArray(parsed) || [];
  if (!items.length) throw new Error('阶段一规划修复未返回分镜数组');
  if (meta.truncated) throw new Error('阶段一规划修复输出被截断');
  return items;
}

async function processStoryboardGeneration(db, log, cfg, taskId, episodeId, model, style, userPrompt, systemPrompt, includeNarration, universalOmni, targetClipDurationSec = null, durationRange = null, pipelineOptions = {}) {
  // 增量保存状态放在 try 外，catch 里可用于部分恢复
  const episodeIdNum = Number(episodeId);
  const streamSavedNums = new Set();
  const streamStyle = (style && String(style).trim()) || cfg?.style?.default_style || '';
  const streamVideoRatio = cfg?.style?.default_video_ratio || '16:9';
  // 角色造型映射（#38）：流式增量入库同样需要，否则视频提示词丢失人物外貌
  const streamEpisode = db.prepare('SELECT drama_id FROM episodes WHERE id = ? AND deleted_at IS NULL').get(episodeIdNum);
  const characterAppearances = streamEpisode?.drama_id
    ? buildDramaCharacterAppearanceMap(
        db.prepare('SELECT id, name, appearance FROM characters WHERE drama_id = ? AND deleted_at IS NULL ORDER BY name ASC').all(streamEpisode.drama_id)
      )
    : {};
  const dramaCharacters = streamEpisode?.drama_id
    ? (() => {
        try {
          return db.prepare('SELECT id, name FROM characters WHERE drama_id = ? AND deleted_at IS NULL ORDER BY name ASC').all(streamEpisode.drama_id);
        } catch (_) { return []; }
      })()
    : [];
  const dramaProps = streamEpisode?.drama_id
    ? (() => {
        try {
          return db.prepare('SELECT id, name FROM props WHERE drama_id = ? AND deleted_at IS NULL ORDER BY name ASC').all(streamEpisode.drama_id);
        } catch (_) { return []; }
      })()
    : [];
  const deriveOpts = {
    universalOmni: !!universalOmni,
    // Publish only after the entire result passes speech validation.
    deferPersistence: true,
    durationRange,
    targetClipDuration: targetClipDurationSec != null && Number(targetClipDurationSec) > 0 ? Number(targetClipDurationSec) : null,
    characterAppearances,
    dramaCharacters,
    dramaProps,
  };
  let streamThrottle = 0;

  try {
    taskService.updateTaskStatus(db, taskId, 'processing', 10, '开始生成分镜头...');
    log.info('Processing storyboard generation', { task_id: taskId, episode_id: episodeId });
    log.info('Storyboard prompt preview', {
      user_prompt_len: userPrompt ? userPrompt.length : 0,
      system_prompt_len: systemPrompt ? systemPrompt.length : 0,
      user_prompt_head: userPrompt ? userPrompt.slice(0, 200) : '',
    });
    logDebugStoryboardPrompts(log, `task-${taskId}-initial`, userPrompt, systemPrompt);

    // Keep existing shots visible until validated replacements can be saved atomically.

    // 不使用 json_mode：response_format:json_object 要求返回 JSON 对象而非数组，会导致模型包装成
    // {"storyboards":[...]} 或产生乱码 key，改由 extractFirstArray 统一处理任意包装格式。
    const text = await generateTextForStoryboard(db, log, userPrompt, systemPrompt, {
      model: model || undefined,
      // 每积累约 400 字符触发一次增量解析，尝试提前保存已完成的分镜
      streamCallback: (accumulated) => {
        if (accumulated.length - streamThrottle < 400) return;
        streamThrottle = accumulated.length;
        tryIncrementalSave(db, log, episodeIdNum, accumulated, streamSavedNums, streamStyle, streamVideoRatio, deriveOpts);
        // 同步更新任务进度（根据已保存分镜数量）
        if (streamSavedNums.size > 0) {
          taskService.updateTaskStatus(db, taskId, 'processing', 30,
            `已解析 ${streamSavedNums.size} 个分镜，生成中...`);
        }
      },
    });

    taskService.updateTaskStatus(db, taskId, 'processing', 50, '分镜头生成完成，正在解析结果...');

    log.info('AI raw response received', {
      task_id: taskId,
      text_type: typeof text,
      text_length: text ? String(text).length : 0,
      text_preview: text ? String(text).slice(0, 2000) : '(empty)',
    });

    let storyboards = [];
    const parseMeta = {};
    try {
      const parsed = safeParseAIJSON(text, null, log, parseMeta);
      storyboards = extractFirstArray(parsed) || [];
    } catch (e) {
      log.error('Parse storyboard JSON failed', {
        error: e.message,
        task_id: taskId,
        text_type: typeof text,
        text_length: text ? String(text).length : 0,
        raw_text: text ? String(text).slice(0, 2000) : '(empty)',
      });

      // 解析失败时，若流式增量保存已有部分分镜，视为截断的部分成功
      if (streamSavedNums.size > 0) {
        const partialBoards = getStoryboardsForEpisode(db, episodeIdNum);
        if (partialBoards.length > 0) {
          if (pipelineOptions?.chainEnrichment) {
            const stageError = new Error(`阶段一分镜 JSON 解析失败：${e.message || '格式错误'}`);
            stageError.stage = 'stage1';
            stageError.partial_shot_count = partialBoards.length;
            throw stageError;
          }
          const totalDuration = partialBoards.reduce((s, sb) => s + (Number(sb.duration) || 0), 0);
          log.warn('Parse failed but partial storyboards already saved incrementally, treating as truncated success', {
            task_id: taskId, recovered_count: partialBoards.length, parse_error: e.message,
          });
          taskService.updateTaskResult(db, taskId, {
            storyboards: partialBoards,
            total: partialBoards.length,
            total_duration: totalDuration,
            duration_minutes: Math.ceil((totalDuration + 59) / 60),
            truncated: true,
            error_message: `AI输出含JSON格式缺陷（${e.message}），已恢复 ${partialBoards.length} 个分镜`,
          });
          return;
        }
      }

      if (pipelineOptions?.chainEnrichment) {
        const stageError = new Error('阶段一分镜 JSON 解析失败：' + (e.message || '格式错误'));
        stageError.stage = 'stage1';
        stageError.partial_shot_count = streamSavedNums.size;
        throw stageError;
      }
      taskService.updateTaskError(db, taskId, '解析分镜头结果失败: ' + (e.message || ''));
      return;
    }

    if (storyboards.length === 0) {
      // 最终解析为空，但流式已保存了内容，同样回退使用增量结果
      if (streamSavedNums.size > 0) {
        const partialBoards = getStoryboardsForEpisode(db, episodeIdNum);
        if (partialBoards.length > 0) {
          if (pipelineOptions?.chainEnrichment) {
            const stageError = new Error(`阶段一只解析出 ${partialBoards.length} 个分镜，未形成完整结果`);
            stageError.stage = 'stage1';
            stageError.partial_shot_count = partialBoards.length;
            throw stageError;
          }
          const totalDuration = partialBoards.reduce((s, sb) => s + (Number(sb.duration) || 0), 0);
          log.warn('Final parse returned 0 items but incremental saves exist, using those', {
            task_id: taskId, recovered_count: partialBoards.length,
          });
          taskService.updateTaskResult(db, taskId, {
            storyboards: partialBoards,
            total: partialBoards.length,
            total_duration: totalDuration,
            duration_minutes: Math.ceil((totalDuration + 59) / 60),
            truncated: true,
          });
          return;
        }
      }
      log.error('AI returned 0 storyboards', { task_id: taskId });
      if (pipelineOptions?.chainEnrichment) {
        const stageError = new Error('阶段一 AI 未返回任何分镜');
        stageError.stage = 'stage1';
        throw stageError;
      }
      taskService.updateTaskError(db, taskId, 'AI生成分镜失败：返回的分镜数量为0');
      return;
    }

    if (parseMeta.truncated) {
      log.warn('Storyboard JSON was truncated by AI (max_tokens limit), will attempt continuation', {
        task_id: taskId, episode_id: episodeId,
        rescued_count: storyboards.length,
        raw_text_length: text ? String(text).length : 0,
      });
    }
    log.info('Storyboard initial parse', { task_id: taskId, episode_id: episodeId, count: storyboards.length, truncated: parseMeta.truncated || false });

    // ── 自动续写：若 AI 输出被截断，最多续写 3 次直到完整 ──────────────────
    const MAX_CONTINUATION = 3;
    let contAttempt = 0;
    while (parseMeta.truncated && storyboards.length > 0 && contAttempt < MAX_CONTINUATION) {
      contAttempt++;
      const lastShot = Math.max(...storyboards.map(s => Number(s.shot_number ?? s.storyboard_number) || 0));
      log.info('Storyboard continuation start', { task_id: taskId, attempt: contAttempt, last_shot: lastShot, current_count: storyboards.length });
      taskService.updateTaskStatus(db, taskId, 'processing', 50 + contAttempt * 5,
        `已生成 ${storyboards.length} 个分镜，正在续写剩余部分（第${contAttempt}次）...`);

      const contPrompt = buildContinuationPrompt(userPrompt, storyboards, lastShot, contAttempt, !!includeNarration, !!universalOmni);
      logDebugStoryboardPrompts(log, `task-${taskId}-continuation-${contAttempt}`, contPrompt, systemPrompt);
      streamThrottle = 0; // 重置节流，让续写段落也能增量保存

      // 等待 3 秒后再发续写请求：避免流式请求刚结束服务端连接未释放导致 "socket hang up"
      await new Promise(r => setTimeout(r, 3000));

      let contText;
      try {
        contText = await generateTextForStoryboard(db, log, contPrompt, systemPrompt, {
          model: model || undefined,
          streamCallback: (accumulated) => {
            if (accumulated.length - streamThrottle < 400) return;
            streamThrottle = accumulated.length;
            tryIncrementalSave(db, log, episodeIdNum, accumulated, streamSavedNums, streamStyle, streamVideoRatio, deriveOpts);
          },
        });
      } catch (e) {
        log.warn('Continuation request failed', { task_id: taskId, attempt: contAttempt, error: e.message });
        break;
      }

      const contMeta = {};
      let contItems = [];
      try {
        const contParsed = safeParseAIJSON(contText, null, log, contMeta);
        contItems = extractFirstArray(contParsed) || [];
      } catch (e) {
        log.warn('Continuation parse failed', { task_id: taskId, attempt: contAttempt, error: e.message });
        break;
      }

      if (contItems.length === 0) {
        log.warn('Continuation returned 0 items', { task_id: taskId, attempt: contAttempt });
        break;
      }

      // 按 shot_number 去重，防止 AI 重复已生成的分镜
      const existingNums = new Set(storyboards.map((s) => normalizeStoryboardShotNumber(s)));
      const newItems = contItems.filter((s) => !existingNums.has(normalizeStoryboardShotNumber(s)));
      if (newItems.length === 0) {
        log.warn('Continuation returned only duplicate items', { task_id: taskId, attempt: contAttempt });
        break;
      }

      storyboards = [...storyboards, ...newItems];
      parseMeta.truncated = contMeta.truncated || false;
      log.info('Storyboard continuation done', {
        task_id: taskId, attempt: contAttempt,
        new_items: newItems.length, total_count: storyboards.length, still_truncated: parseMeta.truncated,
      });
    }
    // ── 续写结束 ────────────────────────────────────────────────────────────

    if (parseMeta.truncated) {
      const incompleteError = new Error('分镜结果仍不完整，未覆盖原分镜；请重试或减少单次剧本长度');
      incompleteError.stage = 'stage1';
      incompleteError.partial_shot_count = storyboards.length;
      throw incompleteError;
    }
    const wardrobePlanner=require('./storyboardWardrobeService');
    taskService.updateTaskStatus(db, taskId, 'processing', 63, '正在校验单镜造型，换装按镜头拆分...');
    storyboards=await wardrobePlanner.enforceSingleOutfit(storyboards,{
      db,dramaId:streamEpisode.drama_id,episodeId:episodeIdNum,
      generate:(user,system)=>generateTextForStoryboard(db,log,user,system,{model:model || undefined,temperature:0.2}),
      onRepair:(shot,reason)=>log.info('Splitting costume transition',{task_id:taskId,shot_number:normalizeStoryboardShotNumber(shot),reason}),
    });
    taskService.updateTaskStatus(db, taskId, 'processing', 65, '正在校验对白时长与单镜单发言人规则，必要时按语义拆镜...');
    try {
      storyboards = await enforceStoryboardSpeechTiming(storyboards, {
        targetDuration: deriveOpts.targetClipDuration,
        durationRange: deriveOpts.durationRange,
        narrativeStyle: cfg.narrative_style,
        enforceSingleSpeaker: Boolean(pipelineOptions?.chainEnrichment),
        keepUnresolvedForRepair: Boolean(pipelineOptions?.chainEnrichment),
        generate: (user, system) => generateTextForStoryboard(db, log, user, system, { model: model || undefined, temperature: 0.2 }),
        onRepair: (shot, assessment) => log.info('Splitting over-budget or multi-speaker storyboard', {
          task_id: taskId, shot_number: normalizeStoryboardShotNumber(shot),
          duration: assessment.duration, estimated_seconds: assessment.requiredSeconds,
        }),
        onSplitFailure: (shot, reason) => log.warn('Storyboard local speech split deferred to stage 1 planning repair', {
          task_id: taskId, shot_number: normalizeStoryboardShotNumber(shot), reason,
        }),
      });
    } catch (splitErr) {
      if (pipelineOptions?.chainEnrichment) {
        log.warn('Storyboard speech timing split encountered error, handing over to stage 1 planning gate', {
          task_id: taskId,
          error: splitErr.message,
        });
      } else {
        throw splitErr;
      }
    }

    storyboards.forEach(shot=>{wardrobePlanner.assertSingleOutfit(shot);wardrobePlanner.validateChoices(db,streamEpisode.drama_id,shot,episodeIdNum);});

    // 规划门禁属于阶段一：人物数量、角色集合、单镜单说话人与台词时长拆镜会改变基础剧情结构，
    // 必须在入库前通过规划修复环拆清，绝不能把超长或多说话人镜头带病放行给阶段二。
    if (pipelineOptions?.chainEnrichment && pipelineOptions.planningCatalogs) {
      const planningAttempts = Math.max(1, Math.min(5, Number(pipelineOptions.planningRepairAttempts || 5)));
      const checkStage1 = (boards) => stageOnePlanningViolations(boards, {
        catalogs: pipelineOptions.planningCatalogs,
        narrativeStyle: cfg.narrative_style,
        durationRange: deriveOpts.durationRange,
      });
      let planningViolations = checkStage1(storyboards);
      for (let attempt = 1; planningViolations.length && attempt <= planningAttempts; attempt++) {
        taskService.updateTaskStatus(db, taskId, 'processing', 66,
          `阶段一规划门禁发现 ${planningViolations.length} 项问题，正在反馈导演 Agent 拆镜/修复（第${attempt}次）...`);
        const repairText = await generateTextForStoryboard(
          db,
          log,
          buildPlanningRepairPrompt(userPrompt, storyboards, planningViolations, attempt, pipelineOptions.planningCatalogs),
          `你是阶段一基础分镜的规划修复节点。只修复门禁反馈指定的镜头人物集合、超长台词或多人对白问题：
1) 遇到「包含多个发言段」或「对白与旁白超出时长预算」时，必须把该镜头按说话轮次与句意拆成多个连续镜头，每镜最多 1 个说话人的单轮台词（或 1 段旁白），严禁两人轮流对白或对白与旁白混在同一镜，并保证每镜台词能在 duration 预算内说完（约 5 字/秒）；
2) 逐字完整保留原剧本台词与旁白，重排连续 shot_number，保持其他无问题镜头内容不变；
3) 每镜最多 2 名有身份角色；环境事件、敌军和群众不得挂载角色 ID；通过通讯器/对讲机/电话远程参与或同场画外的角色不要加入 characters/background_characters。
只返回完整 JSON：{"storyboards":[...]}，不要解释。`,
          { model: model || undefined, temperature: 0.1 }
        );
        storyboards = parseStoryboardArray(repairText, log).map((item, idx) => ({
          ...item,
          shot_number: idx + 1,
          storyboard_number: idx + 1,
        }));
        planningViolations = checkStage1(storyboards);
      }
      if (planningViolations.length) {
        const planningError = new Error(`阶段一规划门禁经过 ${planningAttempts} 轮 Agent 修复仍未通过：${planningViolations.map((item) => item.message).join('；')}`);
        planningError.stage = 'stage1';
        planningError.partial_shot_count = storyboards.length;
        planningError.violations = planningViolations;
        planningError.status = 422;
        throw planningError;
      }
    }
    const totalDuration = storyboards.reduce((sum, sb) => sum + (Number(sb.duration) || 0), 0);
    if (parseMeta.truncated) {
      log.warn('Storyboard still truncated after max continuations', {
        task_id: taskId, final_count: storyboards.length, continuation_attempts: contAttempt,
      });
    }
    log.info('Storyboard generated', { task_id: taskId, episode_id: episodeId, count: storyboards.length, total_duration_seconds: totalDuration, truncated: parseMeta.truncated || false, continuation_attempts: contAttempt });

    taskService.updateTaskStatus(db, taskId, 'processing', 70, '正在保存分镜头...');

    // Soft deletion and all inserts roll back together if saving fails.
    const saved = db.transaction(() =>
      saveStoryboards(db, log, episodeId, storyboards, cfg, style, null, deriveOpts)
    )();

    // 导演两阶段路径的人物清单是 Agent 的规划合同；不能再用文本扫描静默追加
    // 角色，否则阶段一门禁通过后又会把台词中提到的第三人写回 characters，
    // 直到阶段二才暴露为 H3 人数冲突。旧的非导演生成入口仍保留历史补全行为。
    if (!pipelineOptions?.chainEnrichment) {
      taskService.updateTaskStatus(db, taskId, 'processing', 75, '正在校验分镜角色关联...');
      let totalCharAdded = 0;
      for (const sb of saved) {
        if (!sb?.id) continue;
        const { added } = syncStoryboardCharacters(db, log, sb.id);
        totalCharAdded += added.length;
      }
      if (totalCharAdded > 0) {
        log.info('[分镜] 角色补全完成', { episode_id: episodeId, total_added: totalCharAdded });
      }
    }

    taskService.updateTaskStatus(db, taskId, 'processing', 90, '正在更新剧集时长...');

    const durationMinutes = Math.ceil((totalDuration + 59) / 60);
    db.prepare('UPDATE episodes SET duration = ?, updated_at = ? WHERE id = ?').run(durationMinutes, new Date().toISOString(), Number(episodeId));
    log.info('Episode duration updated', { episode_id: episodeId, duration_seconds: totalDuration, duration_minutes: durationMinutes });

    const resultData = {
      storyboards: saved,
      total: saved.length,
      total_duration: totalDuration,
      duration_minutes: durationMinutes,
      truncated: parseMeta.truncated || false,
    };
    if (pipelineOptions?.chainEnrichment) {
      taskService.updateTaskStatus(db, taskId, 'processing', 55, '【阶段 1/2】基础分镜已生成，正在准备装配视听本体槽位...');
      log.info('Storyboard stage 1 base generation done, chaining stage 2 enrichment', { task_id: taskId, episode_id: episodeId });
      return resultData;
    }
    taskService.updateTaskResult(db, taskId, resultData);
    log.info('Storyboard generation completed', { task_id: taskId, episode_id: episodeId });
    return resultData;
  } catch (err) {
    log.error('Storyboard generation failed', { error: err.message, task_id: taskId });

    // The two-stage director pipeline owns the async task lifecycle.  Stage 1
    // must never mark that task as completed/failed and then return to the
    // caller: the pipeline would continue into Stage 2 with a terminal task
    // and its progress callback would report the misleading
    // "导演任务已停止" error.  Re-throw the original failure so the outer
    // director runner records the real cause and preserves a resumable
    // checkpoint instead.
    if (pipelineOptions?.chainEnrichment) {
      const stageError = err instanceof Error ? err : new Error(String(err || '基础分镜生成失败'));
      stageError.stage = 'stage1';
      stageError.partial_shot_count = Number(err.partial_shot_count || streamSavedNums.size || 0);
      if (err.violations) stageError.violations = err.violations;
      throw stageError;
    }

    // 若连接中断（ECONNRESET 等）但已通过增量流式保存了部分分镜，视为部分成功而非彻底失败
    if (streamSavedNums.size > 0) {
      try {
        const partialBoards = getStoryboardsForEpisode(db, episodeIdNum);
        if (partialBoards.length > 0) {
          const totalDuration = partialBoards.reduce((s, sb) => s + (Number(sb.duration) || 0), 0);
          log.warn('Partial storyboards recovered after error, treating as truncated success', {
            task_id: taskId, recovered_count: partialBoards.length, error: err.message,
          });
          taskService.updateTaskResult(db, taskId, {
            storyboards: partialBoards,
            total: partialBoards.length,
            total_duration: totalDuration,
            duration_minutes: Math.ceil((totalDuration + 59) / 60),
            truncated: true,
            error_message: `连接中断（${err.message}），已恢复 ${partialBoards.length} 个分镜`,
          });
          return;
        }
      } catch (_) {}
    }

    taskService.updateTaskError(db, taskId, (err.message || '生成分镜头失败'));
  }
}

function prepareStoryboardGenerationContext(db, episodeId, options = {}) {
  const {
    model,
    style,
    storyboardCount,
    storyboard_count,
    videoDuration,
    video_duration,
    aspectRatio,
    aspect_ratio,
    includeNarration,
    include_narration,
    universalOmni,
    universal_omni,
    universal_omni_storyboard,
    requestedDurationRange,
    shot_duration_range,
  } = options;

  const count = storyboardCount ?? storyboard_count;
  const duration = videoDuration ?? video_duration;
  const ratio = aspectRatio ?? aspect_ratio;
  const narration = includeNarration ?? include_narration;
  const omni = universalOmni ?? universal_omni ?? universal_omni_storyboard;
  const range = requestedDurationRange ?? shot_duration_range;

  let cfg = loadConfig();
  const episode = db.prepare(
    'SELECT id, script_content, description, drama_id FROM episodes WHERE id = ? AND deleted_at IS NULL'
  ).get(Number(episodeId));
  if (!episode) {
    throw new Error('剧集不存在或无权限访问');
  }

  // 获取剧集风格和比例（如果未指定，则从 drama metadata / style 中获取完整提示词）
  const drama = db.prepare('SELECT style, metadata FROM dramas WHERE id = ?').get(episode.drama_id);
  cfg = require('./narrativeStyleService').withConfig(cfg, drama?.metadata);
  const projectMetadata = require('./narrativeStyleService').parse(drama?.metadata);
  cfg.narrative_style = { ...(cfg.narrative_style || {}), tts_speed: require('./speechDeliveryService').configuredTtsSpeed(db, projectMetadata) };
  const { resolvedStreamStyleFromDrama } = require('../utils/dramaStyleMerge');
  const finalStyle = resolvedStreamStyleFromDrama(style, drama);

  // 图片比例 + 每镜时长：优先用传入值，再从 drama.metadata 读，最后兜底全局配置
  let dramaAspectRatio = null;
  let videoClipDuration = null;
  let savedDurationRange = null;
  try {
    if (drama && drama.metadata) {
      const meta = typeof drama.metadata === 'string' ? JSON.parse(drama.metadata) : drama.metadata;
      if (meta && meta.aspect_ratio) dramaAspectRatio = meta.aspect_ratio;
      if (meta && meta.shot_duration_range) savedDurationRange = meta.shot_duration_range;
      if (meta && meta.video_clip_duration) videoClipDuration = Number(meta.video_clip_duration) || null;
    }
  } catch (_) {}
  // Legacy project video_clip_duration is only a display hint.  It must not
  // cap new director plans at 5 seconds now that Continuum supports 9–30s.
  const durationRange = (range || savedDurationRange)
    ? normalizeDurationRange(range || savedDurationRange, null)
    : null;
  const imageRatio = ratio || dramaAspectRatio || cfg?.style?.default_video_ratio || '16:9';

  // 计算单镜建议时长（秒）：
  // 项目 metadata 中的旧 video_clip_duration 先作为范围回退输入，随后统一归一到 H3 4～30 秒；
  // 否则前端同时传总时长+镜数时会把每镜压成过短（与「每段秒数」配置矛盾）。
  // 无项目配置时再使用总时长÷镜数；再否则 null。
  let effectiveShotDuration = null;
  const impliedFromTotal =
    duration && count
      ? Math.round(Number(duration) / Number(count))
      : null;
  if (videoClipDuration && Number(videoClipDuration) > 0) {
    effectiveShotDuration = Number(videoClipDuration);
  } else if (impliedFromTotal && impliedFromTotal > 0) {
    effectiveShotDuration = impliedFromTotal;
  } else {
    effectiveShotDuration = null;
  }

  let scriptContent = (episode.script_content && String(episode.script_content).trim())
    ? String(episode.script_content)
    : (episode.description && String(episode.description).trim())
      ? String(episode.description)
      : '';
  if (!scriptContent) {
    throw new Error('剧本内容为空，请先生成剧集内容');
  }

  const characters = db.prepare(
    'SELECT id, name FROM characters WHERE drama_id = ? AND deleted_at IS NULL ORDER BY name ASC'
  ).all(episode.drama_id);
  let characterList = '无角色';
  if (characters.length > 0) {
    characterList = '[' + characters.map((c) => `{"id": ${c.id}, "name": "${(c.name || '').replace(/"/g, '\\"')}"}`).join(', ') + ']';
  }

  const scenes = db.prepare(
    'SELECT id, location, time FROM scenes WHERE drama_id = ? AND deleted_at IS NULL ORDER BY location ASC, time ASC'
  ).all(episode.drama_id);
  let sceneList = '无场景';
  if (scenes.length > 0) {
    sceneList = '[' + scenes.map((s) => `{"id": ${s.id}, "location": "${(s.location || '').replace(/"/g, '\\"')}", "time": "${(s.time || '').replace(/"/g, '\\"')}"}`).join(', ') + ']';
  }

  const props = db.prepare(
    'SELECT id, name, type FROM props WHERE drama_id = ? AND deleted_at IS NULL ORDER BY id ASC'
  ).all(episode.drama_id);
  let propList = '无道具';
  if (props.length > 0) {
    propList = '[' + props.map((p) => `{"id": ${p.id}, "name": "${(p.name || '').replace(/"/g, '\\"')}"${p.type ? `, "type": "${p.type.replace(/"/g, '\\"')}"` : ''}}`).join(', ') + ']';
  }

  const scriptLabel = promptI18n.formatUserPrompt(cfg, 'script_content_label');
  const taskLabel = promptI18n.formatUserPrompt(cfg, 'task_label');
  const taskInstruction = promptI18n.formatUserPrompt(cfg, 'task_instruction');
  
  // 处理分镜数量和时长约束
  let extraConstraint = '';
  // 宽松判断：只要有值（包括字符串形式的数字），就尝试转换并添加约束
  if (count) {
    const countVal = Number(count);
    if (Number.isFinite(countVal) && countVal > 0) {
      const countLabel = promptI18n.formatUserPrompt(cfg, 'storyboard_count_constraint', countVal);
      if (countLabel) extraConstraint += `\n${countLabel}`;
    }
  }
  if (duration) {
    const durationVal = Number(duration);
    if (Number.isFinite(durationVal) && durationVal > 0) {
      const durationLabel = promptI18n.formatUserPrompt(cfg, 'video_duration_constraint', durationVal);
      if (durationLabel) extraConstraint += `\n${durationLabel}`;
    }
  }
  // 当同时指定总时长和数量时，补充单镜 duration 说明（与项目「每段秒数」一致时勿用总÷镜压短）
  if (!durationRange && count && duration && effectiveShotDuration) {
    const isEn = promptI18n.isEnglish(cfg);
    const clipFromProject = videoClipDuration && Number(videoClipDuration) > 0;
    const implied =
      impliedFromTotal && impliedFromTotal > 0 ? impliedFromTotal : Math.round(Number(duration) / Number(count));
    if (clipFromProject) {
      const clip = Number(videoClipDuration);
      if (isEn) {
        extraConstraint += `\nEach shot "duration" field: prioritize **~${clip}s per shot** (project clip-length setting); ±1s OK. Total ~${Number(duration)}s and ~${Number(count)} shots are overall planning hints—do NOT force every shot to ~${implied}s (total÷count) when it conflicts with the project clip length.`;
      } else {
        extraConstraint += `\n每个镜头的 **duration** 请优先按项目「每段约 **${clip} 秒**」填写（可 ±1 秒微调）。全片总时长约 ${Number(duration)} 秒、镜头数约 ${Number(count)} 为整体规划参考，**禁止**为机械凑「总时长÷镜数」（约 ${implied}s）而把每镜普遍写成过短镜头；除非该镜对白与动作为实需的极短镜头。`;
      }
    } else if (isEn) {
      extraConstraint += `\nEach shot target duration: approximately ${effectiveShotDuration}s (= total ${Number(duration)}s ÷ ${Number(count)} shots). Set each shot's duration field to this value, adjusting ±1s for dialogue/action length.`;
    } else {
      extraConstraint += `\n每镜头目标时长：约 ${effectiveShotDuration} 秒（= 总时长 ${Number(duration)}s ÷ ${Number(count)} 个镜头）。每个镜头的 duration 字段请设为此值，可根据对话/动作长短适当调整 ±1 秒。`;
    }
  }

  const charListLabel = promptI18n.formatUserPrompt(cfg, 'character_list_label');
  const charConstraint = promptI18n.formatUserPrompt(cfg, 'character_constraint');
  const sceneListLabel = promptI18n.formatUserPrompt(cfg, 'scene_list_label');
  const sceneConstraint = promptI18n.formatUserPrompt(cfg, 'scene_constraint');
  const propListLabel = promptI18n.formatUserPrompt(cfg, 'prop_list_label');
  const propConstraint = promptI18n.formatUserPrompt(cfg, 'prop_constraint');
  const suffix = promptI18n.getStoryboardUserPromptSuffix(cfg, durationRange ? null : effectiveShotDuration);

  let userPrompt =
    `${scriptLabel}\n${scriptContent}\n\n${taskLabel}\n${taskInstruction}${extraConstraint}\n\n${charListLabel}\n${characterList}\n\n${charConstraint}\n\n${sceneListLabel}\n${sceneList}\n\n${sceneConstraint}\n\n${propListLabel}\n${propList}\n\n${propConstraint}\n\n${suffix}`;

  const wantNarration = narration === true || narration === 1 || String(narration).toLowerCase() === 'true';
  if (wantNarration) {
    userPrompt += promptI18n.getStoryboardNarrationExtraInstructions(cfg);
  }

  let systemPrompt = promptI18n.getStoryboardSystemPrompt(cfg);
  const wardrobe = require('./narrativeStyleService').parse(drama?.metadata).wardrobe;
  if (wardrobe?.characters) systemPrompt += '\n本剧已审核的默认服装 / Approved base costumes: '+JSON.stringify(wardrobe.characters);
  systemPrompt += require('./wardrobeService').planningContext(db,episode.drama_id);

  // Shot count is a planning target; speech completeness and timing take precedence.
  if (count && Number(count) > 0) {
    const targetCount = Number(count);
    const isEn = systemPrompt.includes('[Role]');
    if (isEn) {
      systemPrompt += `\n\n[USER REQUESTED SHOT COUNT]
Aim for ${targetCount} shots (±10%) where the speech timing budget allows.
Merge related actions or split key moments while preserving complete dialogue and narration.
If words cannot fit, increase the shot count rather than omit words, rush speech, or inflate each clip's duration.`;
    } else {
      systemPrompt += `\n\n【目标分镜数量】
尽量生成 ${targetCount} 个分镜（允许 ±10% 偏差），前提是对白与旁白能在镜头预算内完整说完。
可合并相关连续动作或拆分关键情节；若台词超时，必须按语义增加镜头，禁止为凑镜数删字、加速对白或擅自拉长每段时长。`;
    }
  }

  const wantUniversalOmni =
    omni === true ||
    omni === 1 ||
    String(omni || '').toLowerCase() === 'true';
  if (wantUniversalOmni) {
    systemPrompt += promptI18n.getStoryboardUniversalOmniModeSuffix(cfg);
  }

  // Keep comprehension, speech separation and the narration option consistent across modes/overrides.
  systemPrompt += promptI18n.getStoryboardNarrationModeInstructions(cfg, wantNarration);

  // Append after custom/mode/count prompts so timing and full dialogue take precedence.
  systemPrompt += rangeTimingInstructions(durationRange || { min: 4, max: 30 }, cfg.narrative_style);

  const runCfg = { ...cfg, style: { ...(cfg?.style || {}), default_video_ratio: imageRatio, default_image_ratio: imageRatio } };

  return {
    cfg,
    runCfg,
    episode,
    drama,
    finalStyle,
    imageRatio,
    durationRange,
    effectiveShotDuration,
    storyboardCount: count,
    videoDuration: duration,
    scriptContent,
    characters,
    scenes,
    props,
    userPrompt,
    systemPrompt,
    wantNarration,
    wantUniversalOmni,
    model,
  };
}

async function runStageOneBaseGeneration(db, log, episodeId, taskId, options = {}) {
  const ctx = prepareStoryboardGenerationContext(db, episodeId, options);
  // Stage 1 is deliberately a small, fast narrative pass.  The execution
  // contract Agent owns semantic/video slots in Stage 2; sending those low
  // level fields here made the first response huge and caused truncation.
  const stage1DurationLabel = ctx.durationRange
    ? `${ctx.durationRange.min}～${ctx.durationRange.max}秒整数秒，严禁超过上限 ${ctx.durationRange.max} 秒`
    : '4～30秒整数秒，超过30秒才按语义拆镜';
  ctx.systemPrompt = `你是短剧基础分镜导演。只把本集剧本拆成完整、紧凑、可执行的剧情分镜，先保证剧情顺序和台词逐字覆盖。每镜${stage1DurationLabel}；每个分镜最多只允许 1 个说话人的单轮对白（或 1 段旁白），严禁两人轮流对话或对白与旁白混在同一镜，多人轮流对话必须按说话轮次拆成连续分镜；每镜对白/旁白字数必须能在本镜 duration 内按实际 TTS 速度（默认 1.25x，约 5 字/秒）自然说完，超长台词必须按语义拆镜；单镜最多2名有身份角色，群众/敌军写成环境事件。动作与画面描写必须是可拍摄的纯写实物理动作，严禁文学心理隐喻及在画面中描述 UI 元素（如血条、准星、倒计时悬浮窗、屏幕小字）。不要输出 semantic_slots、video_slots、character_visuals、动作原子、口型、视线枚举或 H3 提示词。只返回 JSON 对象 {"storyboards":[...]}，不要解释。每镜字段：shot_number,title,scene_id,characters,background_characters,props,duration,location,time,shot_type,angle_h,angle_v,angle_s,movement,action,result,dialogue,narration,emotion,start_framing,end_framing,transition_to_next。注意：scene_id 填可用场景目录中的数字 ID；characters 必须填入可用角色目录中的数字 ID 数组（如 [26]，严禁写角色名字符串；无人物则为 []）；props 必须填入可用道具目录中的数字 ID 数组（如 [37]；无道具则为 []）。对白和旁白必须逐字保留，动作必须与对白同时发生，禁止用互相看着或静止等待填时长。可用场景目录：${JSON.stringify(ctx.scenes.map(s => ({ id: s.id, name: s.name, location: s.location })))}；可用角色目录：${JSON.stringify(ctx.characters.map(c => ({ id: c.id, name: c.name })))}；可用道具目录：${JSON.stringify(ctx.props.map(p => ({ id: p.id, name: p.name })))}。`;
  ctx.userPrompt = `【本集剧本】\n${ctx.scriptContent}\n\n【规划目标】镜头数${ctx.storyboardCount || '自动'}；总时长${ctx.videoDuration || '自动'}秒；镜头时长范围${ctx.durationRange ? JSON.stringify(ctx.durationRange) : '4～30秒'}。按剧情节拍规划，不删台词、不重复内容。`;
  log.info('Running Stage 1 Base Storyboard Generation', {
    task_id: taskId,
    episode_id: episodeId,
    storyboard_count: ctx.storyboardCount,
    video_duration: ctx.videoDuration,
  });

  return await processStoryboardGeneration(
    db,
    log,
    ctx.runCfg,
    taskId,
    String(episodeId),
    ctx.model || undefined,
    ctx.finalStyle,
    ctx.userPrompt,
    ctx.systemPrompt,
    ctx.wantNarration,
    ctx.wantUniversalOmni,
    null,
    ctx.durationRange,
    {
      ...options,
      chainEnrichment: true,
    }
  );
}

function generateStoryboard(db, log, episodeId, model, style, storyboardCount, videoDuration, aspectRatio, includeNarration, universalOmni, requestedDurationRange) {
  const ctx = prepareStoryboardGenerationContext(db, episodeId, {
    model,
    style,
    storyboardCount,
    videoDuration,
    aspectRatio,
    includeNarration,
    universalOmni,
    requestedDurationRange,
  });

  const task = taskService.createTask(db, log, 'storyboard_generation', String(episodeId));
  log.info('Generating storyboard asynchronously', {
    task_id: task.id,
    episode_id: episodeId,
    drama_id: ctx.episode.drama_id,
    script_length: ctx.scriptContent.length,
    character_count: ctx.characters.length,
    scene_count: ctx.scenes.length,
    storyboard_count: ctx.storyboardCount,
    video_duration: ctx.videoDuration,
    universal_omni_storyboard: ctx.wantUniversalOmni,
  });

  setImmediate(() => {
    processStoryboardGeneration(
      db,
      log,
      ctx.runCfg,
      task.id,
      String(episodeId),
      ctx.model || undefined,
      ctx.finalStyle,
      ctx.userPrompt,
      ctx.systemPrompt,
      ctx.wantNarration,
      ctx.wantUniversalOmni,
      null,
      ctx.durationRange
    );
  });

  return { task_id: task.id, status: 'pending', message: '分镜生成任务已创建，正在后台处理...' };
}


/**
 * 分镜绑定角色的 id 列表（#38）。
 * 权威顺序与 universalSegmentPromptBundle 一致：storyboards.characters JSON → storyboard_characters 关联表。
 */
function loadStoryboardCharacterIds(db, storyboardId) {
  const sid = Number(storyboardId);
  if (!Number.isFinite(sid) || sid <= 0) return [];
  const ids = [];
  let usedExplicit = false;
  try {
    const sbRow = db.prepare('SELECT characters FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(sid);
    if (sbRow && sbRow.characters != null && String(sbRow.characters).trim() !== '') {
      const parsed = JSON.parse(sbRow.characters);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item != null && typeof item === 'object' && item.id != null) ids.push(Number(item.id));
          else if (typeof item === 'number' || (typeof item === 'string' && /^\d+$/.test(item))) ids.push(Number(item));
        }
        usedExplicit = ids.length > 0;
      }
    }
  } catch (_) {}
  if (!usedExplicit) {
    try {
      const links = db.prepare('SELECT character_id FROM storyboard_characters WHERE storyboard_id = ? ORDER BY id ASC').all(sid);
      for (const link of links) ids.push(Number(link.character_id));
    } catch (_) {}
  }
  return [...new Set(ids.filter((n) => Number.isFinite(n) && n > 0))];
}

/** 按 id 列表读取角色造型：本剧 characters 优先，缺失时回退角色库 character_libraries */
function loadCharacterAppearanceRows(db, ids) {
  const uniq = [...new Set((ids || []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  if (uniq.length === 0) return [];
  const placeholders = uniq.map(() => '?').join(',');
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT id, name, appearance FROM characters WHERE id IN (${placeholders}) AND deleted_at IS NULL`
    ).all(...uniq);
  } catch (_) {
    rows = [];
  }
  if (rows.length === 0) {
    try {
      rows = db.prepare(
        `SELECT id, name, description AS appearance FROM character_libraries WHERE id IN (${placeholders}) AND deleted_at IS NULL`
      ).all(...uniq);
    } catch (_) {
      rows = [];
    }
  }
  return rows;
}

/**
 * 分镜角色造型文本（#38）：每行一个角色，无造型信息的角色跳过。
 * 供视频提示词注入，修复「主角已指定造型但每次生成视频形象随机」。
 */
function buildCharacterAppearanceText(db, storyboardId) {
  const rows = loadCharacterAppearanceRows(db, loadStoryboardCharacterIds(db, storyboardId));
  const lines = [];
  const seen = new Set();
  for (const r of rows) {
    const appearance = String(r.appearance || '').trim();
    if (!appearance) continue;
    const name = String(r.name || '').trim();
    const key = name || `#${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(name ? `「${name}」${appearance}` : appearance);
  }
  return lines.join('\n');
}

function rebuildVideoPromptForStoryboard(db, log, storyboardId) {
  const sbId = Number(storyboardId);
  if (!Number.isFinite(sbId) || sbId <= 0) return null;
  const row = db.prepare('SELECT id FROM storyboards WHERE id=? AND deleted_at IS NULL').get(sbId);
  if (!row) return null;
  const now = new Date().toISOString();
  db.prepare('UPDATE storyboards SET video_prompt=NULL, updated_at=? WHERE id=?').run(now, sbId);
  log?.info?.('[分镜] 已清除旧 video_prompt；H3 将直接编译权威槽位', { id: sbId });

  const storyboardService = require('./storyboardService');
  return storyboardService.getStoryboardById(db, sbId);
}

function rebuildPromptsForStoryboard(db, log, storyboardId) {
  const sbId = Number(storyboardId);
  if (!Number.isFinite(sbId) || sbId <= 0) return null;

  const row = db.prepare(
    `SELECT s.*, e.drama_id
     FROM storyboards s
     JOIN episodes e ON e.id = s.episode_id AND e.deleted_at IS NULL
     WHERE s.id = ? AND s.deleted_at IS NULL`
  ).get(sbId);
  if (!row) return null;

  const loadConfig = require('../config').loadConfig;
  const cfg = loadConfig();
  const drama = row.drama_id
    ? db.prepare('SELECT style, metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(row.drama_id)
    : null;
  const { resolvedStreamStyleFromDrama } = require('../utils/dramaStyleMerge');
  const finalStyle = resolvedStreamStyleFromDrama('', drama) || cfg?.style?.default_style || '';

  // 0. 槽位完整性硬门禁：执行器只编译 Agent 已规划的槽位，不补造人物或尾帧语义。
  const { validateCharacterVisualSlots } = require('../ontology/visualSlots');

  let charVisuals = row.character_visuals;
  if (typeof charVisuals === 'string') {
    try { charVisuals = JSON.parse(charVisuals); } catch (_) { charVisuals = null; }
  }
  const charViolations = Array.isArray(charVisuals) ? validateCharacterVisualSlots(row, charVisuals) : [{
    rule: 'INVARIANT_CHARACTER_VISUAL_SLOTS_REQUIRED',
    severity: 'error',
    shot_number: row.storyboard_number,
    message: '缺少 Agent 规划的 character_visuals',
    conflict_slots: ['character_visuals'],
  }];
  if (!Array.isArray(charVisuals) || charVisuals.length === 0 || charViolations.some(v => v.severity === 'error')) {
    throw Object.assign(new Error(`角色视觉槽位未通过门禁：${charViolations.map(v => v.message).join('；')}`), { status: 422, violations: charViolations });
  }

  // 1. 若 image_prompt 为空，依据结构化角色视觉槽位直接编译；不静默改写既有提示词文本
  const existingImagePrompt = (row.image_prompt || '').trim();
  const imagePrompt = existingImagePrompt || generateImagePrompt(row, finalStyle);
  const existingPolished = (row.polished_prompt || '').trim();
  const polishedPrompt = existingPolished || imagePrompt;

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE storyboards
     SET image_prompt = ?,
         polished_prompt = ?,
         updated_at = ?
     WHERE id = ?`
  ).run(imagePrompt, polishedPrompt, now, sbId);

  // 2. 清除旧的派生 video_prompt；H3 在提交时直接编译权威槽位。
  rebuildVideoPromptForStoryboard(db, log, sbId);

  const storyboardService = require('./storyboardService');
  return storyboardService.getStoryboardById(db, sbId);
}

function rebuildPromptsForEpisode(db, log, episodeId) {
  const epId = Number(episodeId);
  if (!Number.isFinite(epId) || epId <= 0) return 0;
  const rows = db.prepare(
    'SELECT id FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL ORDER BY storyboard_number ASC'
  ).all(epId);
  let count = 0;
  for (const r of rows) {
    try {
      rebuildPromptsForStoryboard(db, log, r.id);
      count++;
    } catch (err) {
      if (log?.warn) log.warn('[分镜] 重建提示词失败', { id: r.id, error: err.message });
    }
  }
  return count;
}

function copyStoryboardAssetLinks(db, fromSbId, toSbId) {
  const from = Number(fromSbId);
  const to = Number(toSbId);
  const now = new Date().toISOString();
  try {
    const chars = db.prepare('SELECT character_id FROM storyboard_characters WHERE storyboard_id = ?').all(from);
    const insC = db.prepare(
      'INSERT OR IGNORE INTO storyboard_characters (storyboard_id, character_id, created_at) VALUES (?, ?, ?)'
    );
    for (const c of chars) insC.run(to, c.character_id, now);
  } catch (_) {}
  try {
    const props = db.prepare('SELECT prop_id FROM storyboard_props WHERE storyboard_id = ?').all(from);
    const insP = db.prepare('INSERT OR IGNORE INTO storyboard_props (storyboard_id, prop_id) VALUES (?, ?)');
    for (const p of props) insP.run(to, p.prop_id);
  } catch (_) {}
}

function durationForSplitSegment(type, text) {
  const speech = type === 'narration' ? { narration: text } : { dialogue: text };
  const assessment = assessSpeechTiming(speech, 30);
  if (!assessment.ok) {
    throw new Error(`单段${type === 'narration' ? '旁白' : '对白'}约需 ${assessment.requiredSeconds} 秒，超过单个逻辑分镜 30 秒上限；请让导演 Agent 继续按语义拆分`);
  }
  return Math.min(30, Math.max(4, assessment.recommendedDuration));
}

function buildSplitPlansFromStoryboard(row) {
  const dialogueEntries = parseDialogueToEntries(row.dialogue);
  const narrationText = row.narration != null ? String(row.narration).trim() : '';
  const segmentCount = dialogueEntries.length + (narrationText ? 1 : 0);
  if (segmentCount < 2) {
    throw new Error('当前分镜仅有一段对白或旁白，无需拆镜');
  }
  if (dialogueEntries.length === 0 && narrationText) {
    throw new Error('仅有旁白无法按对白拆镜');
  }

  const allSpeakers = dialogueEntries.map((d) => d.speaker).filter(Boolean);
  const plans = [];

  for (const { speaker, text } of dialogueEntries) {
    const who = speaker || '角色';
    const others = allSpeakers.filter((n) => n && n !== who);
    const closed = others.length ? others.join('、') : '对方';
    const isReporter = /记者/.test(who) || who === '小雅';
    plans.push({
      type: 'dialogue',
      speaker: who,
      dialogue: `${who}：${text}`,
      narration: null,
      title: `${(row.title || '分镜').trim()}·${who}对白`,
      duration: durationForSplitSegment('dialogue', text),
      action: isReporter
        ? `采访场景，${who}面向对方发问，仅${who}开口说话，${closed}闭口聆听无口型。`
        : `镜头聚焦${who}，仅${who}开口对口型说话，${closed}全程闭口无口型。`,
      result: isReporter ? `${closed}保持静默聆听。` : `${who}完成台词，情绪鲜明。`,
      shot_type: isReporter ? row.shot_type || '中景' : '近景',
      movement: isReporter ? row.movement || '固定' : '推镜',
    });
  }

  if (narrationText) {
    const focus =
      inferPrimaryOnScreenCharacter(
        { action: row.action, result: row.result, title: row.title, dialogue: row.dialogue },
        allSpeakers
      ) || allSpeakers[allSpeakers.length - 1] || '角色';
    plans.push({
      type: 'narration',
      speaker: null,
      dialogue: null,
      narration: narrationText,
      title: `${(row.title || '分镜').trim()}·画外旁白`,
      duration: durationForSplitSegment('narration', narrationText),
      action: `${focus}在画面中保持静止，双唇闭合，无口型，听画外纪录片旁白。`,
      result: `${focus}表情维持强硬自信，无唇动。`,
      shot_type: '近景',
      movement: row.movement || '固定',
    });
  }

  return plans;
}

function persistSplitStoryboardRow(db, episodeId, storyboardNumber, baseRow, plan, now) {
  const info = db.prepare(
    `INSERT INTO storyboards (
      episode_id, scene_id, storyboard_number, title, description, layout_description,
      location, time, duration, dialogue, narration, action, result, atmosphere,
      image_prompt, characters, shot_type, angle, angle_h, angle_v, angle_s, dialogue_framing,
      movement, lighting_style, depth_of_field, segment_index, segment_title,
      creation_mode, universal_segment_text, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).run(
    episodeId,
    baseRow.scene_id ?? null,
    storyboardNumber,
    plan.title,
    baseRow.description ?? null,
    baseRow.layout_description ?? null,
    baseRow.location ?? null,
    baseRow.time ?? null,
    plan.duration,
    plan.dialogue,
    plan.narration,
    plan.action,
    plan.result,
    baseRow.atmosphere ?? null,
    baseRow.image_prompt ?? null,
    baseRow.characters ?? null,
    plan.shot_type ?? baseRow.shot_type ?? null,
    baseRow.angle ?? null,
    baseRow.angle_h ?? null,
    baseRow.angle_v ?? null,
    baseRow.angle_s ?? null,
    plan.dialogue_framing ?? baseRow.dialogue_framing ?? null,
    plan.movement ?? baseRow.movement ?? null,
    baseRow.lighting_style ?? null,
    baseRow.depth_of_field ?? null,
    baseRow.segment_index ?? null,
    baseRow.segment_title ?? null,
    baseRow.creation_mode === 'universal' ? 'universal' : 'classic',
    null,
    now,
    now
  );
  return info.lastInsertRowid;
}

function updateStoryboardAsSplitSegment(db, sbId, baseRow, plan, now) {
  db.prepare(
    `UPDATE storyboards SET
      title = ?, duration = ?, dialogue = ?, narration = ?, action = ?, result = ?,
      shot_type = ?, movement = ?, universal_segment_text = NULL,
      video_prompt = NULL, video_url = NULL, audio_local_path = NULL,
      narration_audio_local_path = NULL, status = 'pending', updated_at = ?
     WHERE id = ? AND deleted_at IS NULL`
  ).run(
    plan.title,
    plan.duration,
    plan.dialogue,
    plan.narration,
    plan.action,
    plan.result,
    plan.shot_type ?? baseRow.shot_type ?? null,
    plan.movement ?? baseRow.movement ?? null,
    now,
    sbId
  );
}

/**
 * 按对白/旁白拆成多条分镜（每条仅一人说话或仅旁白），解决多角色同镜串音。
 * @returns {{ source_id, storyboard_ids, created_count, plans_summary }}
 */
function splitStoryboardByAudio(db, log, storyboardId) {
  const sbId = Number(storyboardId);
  if (!Number.isFinite(sbId) || sbId <= 0) throw new Error('无效的分镜 id');

  const row = db
    .prepare('SELECT * FROM storyboards WHERE id = ? AND deleted_at IS NULL')
    .get(sbId);
  if (!row) throw new Error('分镜不存在');

  const plans = buildSplitPlansFromStoryboard(row);
  const extraCount = plans.length - 1;
  const now = new Date().toISOString();
  const episodeId = row.episode_id;
  const baseNumber = Number(row.storyboard_number) || 0;

  if (extraCount > 0) {
    db.prepare(
      `UPDATE storyboards SET storyboard_number = storyboard_number + ?, updated_at = ?
       WHERE episode_id = ? AND storyboard_number > ? AND deleted_at IS NULL`
    ).run(extraCount, now, episodeId, baseNumber);
  }

  const storyboardIds = [];
  updateStoryboardAsSplitSegment(db, sbId, row, plans[0], now);
  storyboardIds.push(sbId);

  for (let i = 1; i < plans.length; i++) {
    const newNum = baseNumber + i;
    const newId = persistSplitStoryboardRow(db, episodeId, newNum, row, plans[i], now);
    copyStoryboardAssetLinks(db, sbId, newId);
    storyboardIds.push(newId);
  }

  for (const id of storyboardIds) {
    rebuildVideoPromptForStoryboard(db, log, id);
  }

  const summary = plans.map((p) => `${p.duration}s ${p.title}`).join('；');
  if (log?.info) {
    log.info('[分镜] 按对白拆镜完成', { source_id: sbId, storyboard_ids: storyboardIds, plans: summary });
  }

  const storyboardService = require('./storyboardService');
  return {
    source_id: sbId,
    storyboard_ids: storyboardIds,
    created_count: extraCount,
    plans_summary: summary,
    storyboards: storyboardIds.map((id) => storyboardService.getStoryboardById(db, id)),
  };
}

function clearEpisodeMedia(db, log, episodeId, options = {}) {
  const epId = Number(episodeId);
  if (!epId) throw new Error('缺少分集 ID');
  const episode = db.prepare('SELECT id, drama_id FROM episodes WHERE id = ? AND deleted_at IS NULL').get(epId);
  if (!episode) throw new Error('分集不存在或已删除');

  const clearImages = options.clear_images !== false;
  const clearVideos = options.clear_videos !== false;
  const now = new Date().toISOString();

  const storyboards = db.prepare('SELECT id FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL').all(epId);
  const sbIds = storyboards.map(s => s.id);
  if (!sbIds.length) {
    return { cleared_storyboards: 0, cleared_images: 0, cleared_videos: 0 };
  }

  const placeholders = sbIds.map(() => '?').join(',');
  let clearedImages = 0;
  let clearedVideos = 0;

  db.transaction(() => {
    if (clearVideos) {
      try {
        db.prepare("UPDATE video_batches SET status = 'stopped', updated_at = ? WHERE episode_id = ? AND status IN ('running', 'stopping')").run(now, epId);
        db.prepare(`UPDATE video_batch_items SET status = 'cancelled' WHERE storyboard_id IN (${placeholders}) AND status IN ('pending', 'running')`).run(...sbIds);
      } catch (_) {}

      const vidRes = db.prepare(`UPDATE video_generations SET deleted_at = ? WHERE storyboard_id IN (${placeholders}) AND deleted_at IS NULL`).run(now, ...sbIds);
      clearedVideos = vidRes.changes || 0;
      db.prepare(`UPDATE storyboards SET video_url = NULL, selected_video_id = NULL, updated_at = ? WHERE id IN (${placeholders})`).run(now, ...sbIds);
    }

    if (clearImages) {
      const imgRes = db.prepare(`UPDATE image_generations SET deleted_at = ? WHERE storyboard_id IN (${placeholders}) AND deleted_at IS NULL`).run(now, ...sbIds);
      clearedImages = imgRes.changes || 0;
      db.prepare(`UPDATE storyboards SET image_url = NULL, local_path = NULL, first_frame_image_id = NULL, last_frame_image_id = NULL, last_frame_image_url = NULL, last_frame_local_path = NULL, composed_image = NULL, continuity_snapshot = NULL, updated_at = ? WHERE id IN (${placeholders})`).run(now, ...sbIds);
    }

    try {
      db.prepare(`UPDATE async_tasks SET status = 'cancelled', message = '用户清除了分镜媒体' WHERE resource_id IN (${placeholders}) AND status = 'processing'`).run(...sbIds.map(String));
    } catch (_) {}
  })();

  log?.info?.('[分镜] 一键清除参考帧和分镜视频完成', {
    episode_id: epId,
    storyboards: sbIds.length,
    clear_images: clearImages,
    clear_videos: clearVideos,
    cleared_images: clearedImages,
    cleared_videos: clearedVideos,
  });

  return {
    cleared_storyboards: sbIds.length,
    cleared_images: clearedImages,
    cleared_videos: clearedVideos,
  };
}

/**
 * 清空当前集的分镜脚本（软删除分镜及其媒体），用于重新开始一次全新的导演规划。
 * 不删除剧本、角色、道具或场景；历史分镜仍可从数据库审计记录中恢复。
 */
function clearEpisodeStoryboards(db, log, episodeId) {
  const epId = Number(episodeId);
  if (!epId) throw new Error('缺少分集 ID');
  const episode = db.prepare('SELECT id FROM episodes WHERE id = ? AND deleted_at IS NULL').get(epId);
  if (!episode) throw new Error('分集不存在或已删除');

  const rows = db.prepare('SELECT id FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL').all(epId);
  const storyboardIds = rows.map((row) => Number(row.id));
  if (!storyboardIds.length) return { cleared_storyboards: 0, cleared_images: 0, cleared_videos: 0 };

  // 先按现有媒体清理逻辑撤销图片/视频记录，再软删除脚本行，避免留下可被批量任务重新拾取的媒体。
  const media = clearEpisodeMedia(db, log, epId, { clear_images: true, clear_videos: true });
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare('UPDATE storyboards SET deleted_at = ?, updated_at = ? WHERE episode_id = ? AND deleted_at IS NULL')
      .run(now, now, epId);
    db.prepare(`UPDATE async_tasks
      SET status = 'cancelled', message = '用户清空了当前集分镜脚本'
      WHERE resource_id = ? AND type = 'director_storyboard_generation'
        AND status IN ('pending', 'processing')`).run(String(epId));
  })();

  log?.info?.('[分镜] 已清空当前集分镜脚本', {
    episode_id: epId,
    storyboards: storyboardIds.length,
    cleared_images: media.cleared_images || 0,
    cleared_videos: media.cleared_videos || 0,
  });
  return {
    cleared_storyboards: storyboardIds.length,
    cleared_images: media.cleared_images || 0,
    cleared_videos: media.cleared_videos || 0,
  };
}

function clearStoryboardMedia(db, log, storyboardId, options = {}) {
  const sbId = Number(storyboardId);
  if (!sbId) throw new Error('缺少分镜 ID');
  const sb = db.prepare('SELECT id, episode_id FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(sbId);
  if (!sb) throw new Error('分镜不存在或已删除');

  const clearImages = options.clear_images !== false;
  const clearVideos = options.clear_videos !== false;
  const now = new Date().toISOString();

  let clearedImages = 0;
  let clearedVideos = 0;

  db.transaction(() => {
    if (clearVideos) {
      try {
        db.prepare("UPDATE video_batch_items SET status = 'cancelled' WHERE storyboard_id = ? AND status IN ('pending', 'running')").run(sbId);
      } catch (_) {}
      const vidRes = db.prepare('UPDATE video_generations SET deleted_at = ? WHERE storyboard_id = ? AND deleted_at IS NULL').run(now, sbId);
      clearedVideos = vidRes.changes || 0;
      db.prepare('UPDATE storyboards SET video_url = NULL, selected_video_id = NULL, updated_at = ? WHERE id = ?').run(now, sbId);
    }
    if (clearImages) {
      const imgRes = db.prepare('UPDATE image_generations SET deleted_at = ? WHERE storyboard_id = ? AND deleted_at IS NULL').run(now, sbId);
      clearedImages = imgRes.changes || 0;
      db.prepare('UPDATE storyboards SET image_url = NULL, local_path = NULL, first_frame_image_id = NULL, last_frame_image_id = NULL, last_frame_image_url = NULL, last_frame_local_path = NULL, composed_image = NULL, continuity_snapshot = NULL, updated_at = ? WHERE id = ?').run(now, sbId);
    }
    try {
      db.prepare("UPDATE async_tasks SET status = 'cancelled', message = '用户清除了分镜媒体' WHERE resource_id = ? AND status = 'processing'").run(String(sbId));
    } catch (_) {}
  })();

  log?.info?.('[分镜] 单镜清除媒体完成', { storyboard_id: sbId, clear_images: clearImages, clear_videos: clearVideos });
  return { cleared_images: clearedImages, cleared_videos: clearedVideos };
}

module.exports = {
  processStoryboardGeneration,
  normalizeStoryboardShotNumber,
  dedupeStoryboardRowsByNumber,
  getStoryboardsForEpisode,
  generateStoryboard,
  /** 与分镜入库时一致的「图片提示词」拼装 */
  composeStoryboardImagePrompt: generateImagePrompt,
  /** 尾帧确定性提示词拼装（首尾帧模式） */
  generateLastFramePrompt,
  /** AI 分镜对象的入库字段计算（含角色造型注入，供测试与复用） */
  deriveStoryboardFieldsFromAi,
  /** 批量入库（与后台任务同一 deriveOpts 通道，供测试与复用） */
  saveStoryboards,
  rebuildVideoPromptForStoryboard,
  rebuildPromptsForStoryboard,
  rebuildPromptsForEpisode,
  splitStoryboardByAudio,
  copyStoryboardAssetLinks,
  clearEpisodeMedia,
  clearEpisodeStoryboards,
  clearStoryboardMedia,
  prepareStoryboardGenerationContext,
  runStageOneBaseGeneration,
  stageOnePlanningViolations,
};
