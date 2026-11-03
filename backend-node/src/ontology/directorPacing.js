const runtime = require('../services/agentsRuntime');
const { normalizeDurationRange, rangeTimingInstructions } = require('../utils/shotDurationRange');

// Automatic short-drama planning should remain reviewable and purposeful.
// Explicit user counts are still honored and validated separately.
const AUTO_MAX_SHOTS = 30;

function optionalInteger(value, label, min, max) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label}需为 ${min}–${max} 的整数，或留空自动规划`);
  return n;
}

function constraints(options = {}, metadata = {}) {
  const count = optionalInteger(options.storyboardCount ?? options.storyboard_count, '分镜数量', 1, 200);
  const duration = optionalInteger(options.videoDuration ?? options.video_duration, '视频总时长', 10, 600);
  // The legacy video_clip_duration field is only a display hint. It must not
  // silently cap new director plans at the old five-second default.
  const range = normalizeDurationRange(options.shot_duration_range ?? metadata.shot_duration_range, null);
  if (duration != null) {
    const minCount = Math.ceil(duration / range.max), maxCount = Math.floor(duration / range.min);
    if (minCount > maxCount || (count != null && (count < minCount || count > maxCount))) {
      throw new Error(`手动设置冲突：${duration} 秒总时长、单镜 ${range.min}–${range.max} 秒${count ? `、${count} 镜` : ''}无法同时满足。`
        + (minCount <= maxCount ? `仅按时长计算需 ${minCount}–${maxCount} 镜；请调整数量、总时长，或留空交给导演规划。` : '请调整总时长或单镜范围，或将总时长留空。'));
    }
  }
  return { count, duration, range };
}

function validatePlan(plan, requested) {
  if (!plan || typeof plan.feasible !== 'boolean' || !Array.isArray(plan.shots) || !plan.shots.length || !String(plan.reason || '').trim()) {
    throw new Error('节奏规划必须返回 feasible、非空 shots 与原因 reason');
  }
  for (const [i, shot] of plan.shots.entries()) {
    if (!Number.isInteger(shot.duration) || shot.duration < requested.range.min || shot.duration > requested.range.max || !String(shot.purpose || '').trim()) {
      throw new Error(`节奏规划第 ${i + 1} 镜需在 ${requested.range.min}–${requested.range.max} 秒内，并说明剧情任务`);
    }
  }
  if (requested.count == null && plan.shots.length > AUTO_MAX_SHOTS) {
    throw new Error(`自动规划得到 ${plan.shots.length} 镜，超过短剧建议上限 ${AUTO_MAX_SHOTS} 镜。请合并同一事件中的连续动作、对白和即时反应；只有真实时长或场景变化才拆镜`);
  }
  const total = plan.shots.reduce((sum, shot) => sum + shot.duration, 0);
  if (plan.feasible && ((requested.count != null && plan.shots.length !== requested.count) || (requested.duration != null && total !== requested.duration))) {
    throw new Error('规划声称可行，但未满足用户填写的镜数或总时长；请修正规划，无法满足则明确返回 feasible:false 和替代建议');
  }
  return { ...plan, total_duration: total, total_shots: plan.shots.length, requested };
}

async function planEpisodePacing(db, log, script, requested, { maxAttempts = 500, onProgress = () => {} } = {}) {
  let feedback = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let plan;
    try {
      const result = await runtime.runAgent(db, log, {
        name: 'director-episode-pacing',
        instructions: `你是同一导演工作流的整集节奏规划节点，先根据完整剧情、逐字保留的台词、动作完成与互动反应决定镜头数量和逐镜时长。禁止按字符数除法、固定镜数或均分秒数决定切镜。每镜用一句 purpose 说明其连续剧情范围与任务，不输出完整槽位。\n${rangeTimingInstructions(requested.range, { tts_speed: requested.tts_speed })}\n用户填写的数量和总秒数是明确要求；空值才表示由你决定，旧剧集时长和页面公式估算都不是约束。自动决定镜数时通常不得超过 ${AUTO_MAX_SHOTS} 镜；优先让一个镜头承载同一事件中的多个连续动作、对白和即时反应。禁止用“说一句话后互相看着”、无意义特写、空等或重复反应凑镜头。若手动数值太少或太短，不能删台词、漏剧情、加速或静默覆盖；返回 feasible:false、具体 reason，以及能完整表达剧情的建议 shots。无需修改已有剧本。`,
        input: `用户要求：${JSON.stringify(requested)}\n按连贯事件规划，不按动作个数拆镜：一个4～30秒逻辑分镜可以包含多个连续或同时发生的动作、对白和对方反应；9秒以上使用Continuum。不得为每句对白、每个动作、每次反应各建一镜；能自然同镜完成的应合并。只有超过30秒、场景或造型变化、或剧情确需独立视角时拆镜。两人对话优先使用有明确叙事作用的正反打（shot-reverse-shot）或过肩反打；正反打必须服务信息、反应或权力变化，不能把每句台词机械拆成无意义特写。台词逐字保留，不能为减少镜数删减剧情；也不要重复表达同一信息、添加停顿凑时长。\n完整剧本：\n${script}\n${feedback ? `上轮门禁反馈：${feedback}` : ''}`,
        outputType: {
          type: 'json_schema', name: 'director_episode_pacing', strict: true,
          schema: { type: 'object', additionalProperties: false, required: ['feasible', 'reason', 'shots'], properties: {
            feasible: { type: 'boolean' }, reason: { type: 'string' },
            shots: { type: 'array', minItems: 1, ...(requested.count == null ? { maxItems: AUTO_MAX_SHOTS } : {}), items: { type: 'object', additionalProperties: false, required: ['duration', 'purpose'], properties: { duration: { type: 'integer' }, purpose: { type: 'string' } } } },
          } },
        },
        maxTokens: null, temperature: 0.2,
      });
      plan = validatePlan(result, requested);
    } catch (error) {
      feedback = error.message;
      onProgress(35, `导演节奏规划自纠第 ${attempt}/${maxAttempts} 轮：${feedback}`);
      continue;
    }
    if (!plan.feasible) {
      const error = new Error(`导演认为当前要求无法完整表达剧情：${plan.reason}。建议 ${plan.total_shots} 镜、共 ${plan.total_duration} 秒（单镜 ${requested.range.min}–${requested.range.max} 秒）；请调整输入或留空自动规划，原分镜未覆盖。`);
      error.status = 422;
      error.planning_advice = plan;
      throw error;
    }
    onProgress(38, `导演已规划 ${plan.total_shots} 镜、共 ${plan.total_duration} 秒，正在展开完整分镜`);
    return plan;
  }
  throw new Error(`导演节奏规划经过 ${maxAttempts} 轮仍未通过：${feedback}`);
}

function assertManualTargets(shots, requested) {
  for (const [index, shot] of shots.entries()) {
    const duration = Number(shot.duration);
    if (!Number.isInteger(duration) || duration < requested.range.min || duration > requested.range.max) {
      throw new Error(`分镜 #${index + 1} 时长 ${shot.duration} 秒超出本轮 ${requested.range.min}–${requested.range.max} 秒范围，请让导演调整，原分镜未覆盖`);
    }
  }
  const total = shots.reduce((sum, s) => sum + Number(s.duration), 0);
  if ((requested.count != null && shots.length !== requested.count) || (requested.duration != null && total !== requested.duration)) {
    throw new Error(`导演修复后的方案为 ${shots.length} 镜、${total} 秒，与手动要求（${requested.count ?? '自动'} 镜、${requested.duration ?? '自动'} 秒）不一致。请调整手动要求或留空自动规划；禁止静默覆盖要求，原分镜未覆盖。`);
  }
}

module.exports = { constraints, validatePlan, planEpisodePacing, assertManualTargets };
