/**
 * 影视导演视听编排智能体（Audiovisual Director ReAct Agent）
 * 践行 /home/nvidia/ontology-semantic-system 的核心哲学：
 * 1. 语义图绑定：以不可变 DramaSemanticPackage 为世界事实底座
 * 2. 场面调度：按剧情规划动作过程、互动与结果，机位和切镜服务叙事
 * 3. 音画多模态：无对白分镜绑定原生 BGM 描述供 H3 视频生成
 * 4. 自我反思纠偏环（Critic & Reflection Loop）：通过 SHACL 风格的 validateAllInvariants 检验草稿，发现违规自动修正
 */

const { compileDramaSemanticPackage } = require('./semanticPackage');
const { validateAllInvariants, checkSpeechTiming } = require('./invariants');
const { validateVideoSlots } = require('./videoSlots');
const { extractAllEntitiesFromScript } = require('./extractionAgent');
const { isAssetObsolete } = require('./assetMatcher');
const agentsRuntime = require('../services/agentsRuntime');
const angleService = require('../services/angleService');
const dramaService = require('../services/dramaService');
const { generateStory } = require('../services/storyGenerationService');
const promptI18n = require('../services/promptI18n');
const pacing = require('./directorPacing');
const directorTrace = require('../services/directorTrace');
const directorCheckpoint = require('../services/directorCheckpoint');
const { linkEpisodeCharacters } = require('../services/episodeCharacterLinks');

const REQUIRED_VIDEO_SLOT_KEYS = ['camera', 'audio_lip_sync', 'trajectories', 'environment_vfx', 'timing', 'shots_timeline'];
// Shared by draft, execution planning and repairs. Semantic decisions stay with
// the Director; this is not a backend verb detector or an automatic motion patch.
const DIRECTOR_ACTION_COMPLETION_CONTRACT = `
${require('../services/narrativeStyleService').directorPrinciples()}
【对白与动作完成合同：提交前由导演自检】
- 本合同适用于全部题材、视觉风格和叙事偏好，不以任何风格选项为开关。不强制对白占比、快剪、说完必须动或所有人持续运动。
- 结合原剧本与上下镜，区分当场执行的意图、未来承诺、回忆、假设、拒绝和被打断的动作。不得仅凭台词动词强行安排动作，也不得改写台词来回避冲突。
- 对当前镜头应执行的事件，在现有 action/result、trajectory/terminal_pose 槽位中给出起始状态、动作过程、互动对象的配合或反应、实际结束状态；轨迹与终态必须能接续。保持安静可以是剧情选择，不能成为所有人的默认动作。
- 例如当场说“爹，我扶您起来”，应规划女儿托肩背、父亲撑床配合、从半躺到坐稳；若剧情要求扶起失败，则明确尝试、受阻及实际终态。说“明天我扶您出去”不代表本镜就要起身。
- 说话与动作可以同时进行；按实际台词时间和动作时间轴完成本镜事件。不要预留固定的无台词收尾，也不要在台词结束后凭空等待；为剩余时间规划有剧情作用的动作或反应，不要用无关手势、运镜、重复动作填时长，也不必强行用满8秒。
- character_visuals 只描述起幅瞬间，last_frame_visuals（需要尾帧时）、end_framing、result 与最终 terminal_pose 描述同一结束状态；全局 trajectories、shots_timeline 和全能分镜文本必须一致。连续动作可以在一个镜头内叙述先后阶段，不要为了分阶段而强制切镜。
- 若上下文提供实际 TTS 时长，以实测复核台词与动作时间线；超出配置时长上限时反馈给可调整剧情分镜的导演节点处理，不能删字、加速或在只读槽位节点擅自改总时长。
- 输出前逐人核对：台词意图是否与剧情事件一致、动作是否足以到达终态、互动对象是否有必要的反应、说完后的时间是否有用途。发现矛盾先在本节点允许修改的范围内修正，保留用户锁定的内容；后端不替你推测或补写语义。只输出本节点约定字段，不增加自检报告或另一套动作槽位。
`;
const REQUIRED_SEMANTIC_SLOT_KEYS = [
  'visible_characters', 'background_characters', 'identity_visibility', 'speech_plan', 'sound_plan',
  'continuity_type', 'h3_mode', 'h3_mode_reason', 'first_frame_policy', 'first_frame_reason', 'last_frame_policy', 'last_frame_reason', 'required_references',
  'audio_lip_sync', 'shot_duration',
];

const SINGLE_STORYBOARD_PATCH_FIELDS = new Set([
  'title', 'scene_id', 'characters', 'props', 'shot_type', 'angle_h', 'angle_v', 'angle_s',
  'movement', 'lighting_style', 'depth_of_field', 'duration', 'action', 'result', 'dialogue',
  'narration', 'dialogue_framing', 'bgm_prompt', 'sound_effect', 'layout_description', 'emotion',
  'start_framing', 'end_framing', 'transition_to_next', 'background_characters',
  'character_visuals', 'last_frame_visuals', 'video_slots', 'semantic_slots',
  'continuity_snapshot', 'universal_segment_text',
]);

function directorOutputTokenBudget(shotCount) {
  const count = Number.isFinite(Number(shotCount)) ? Math.max(1, Number(shotCount)) : 8;
  // 完整初稿必须容纳每镜的全部视听槽位。这里仅估算任务需求，不再设置与模型无关的业务硬上限；
  // 模型自身的输出/上下文上限由 OpenAI Agents SDK 和上游模型共同处理。
  return Math.max(32768, Math.ceil(count * 1400 + 4000));
}

function directorRepairTokenBudget(violationCount, repairShotCount) {
  // A repair response is structured JSON and may need to rewrite a complete
  // execution object (timeline, reactions, speech windows and synchronized
  // visual slots).  Thinking models can consume the completion budget before
  // emitting JSON, so every repair gets the full safe budget.  The upstream
  // model/configuration may still clamp this value to its supported maximum.
  return 24576;
}

const DIRECTOR_DRAFT_BATCH_SIZE = 3;
const DIRECTOR_BATCH_THRESHOLD = 10;

function normalizeCoverageText(value) {
  return String(value || '').replace(/\s+/gu, '');
}

function splitCoverageEvenly(source, count) {
  const chars = Array.from(String(source || '').trim());
  if (chars.length < count) throw new Error(`原文仅 ${chars.length} 字，无法分配给 ${count} 个非空原文单元；请调整镜数或剧本`);
  return Array.from({ length: count }, (_, i) => chars.slice(
    Math.floor(i * chars.length / count), Math.floor((i + 1) * chars.length / count)
  ).join(''));
}

function splitScriptUnits(scriptContent, minimumUnits = 1) {
  const lines = String(scriptContent || '').split(/\n+/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length >= minimumUnits) return lines;
  const sentences = String(scriptContent || '')
    .match(/[^。！？!?\n]+[。！？!?]?/gu)
    ?.map((sentence) => sentence.trim())
    .filter(Boolean) || [];
  return sentences.length ? sentences : [String(scriptContent || '').trim()].filter(Boolean);
}

function buildDirectorSourceUnits(scriptSegment, minimumUnits = 1, batchNumber = 1) {
  const source = String(scriptSegment || '').trim();
  if (!source) return [];
  const minimum = Math.max(1, Math.floor(Number(minimumUnits) || 1));
  let units = source.split(/\n+/u).map((item) => item.trim()).filter(Boolean);
  if (units.length < minimum) {
    units = source.match(/[^。！？!?；;\n]+[。！？!?；;]?/gu)?.map((item) => item.trim()).filter(Boolean) || [];
  }
  if (units.length < minimum) {
    units = source.match(/[^，,。！？!?；;\n]+[，,。！？!?；;]?/gu)?.map((item) => item.trim()).filter(Boolean) || [];
  }
  if (units.length < minimum) {
    units = splitCoverageEvenly(source, minimum);
  }
  if (normalizeCoverageText(units.join('')) !== normalizeCoverageText(source)) {
    throw new Error(`导演初稿第 ${batchNumber} 批原文单元切分未完整覆盖源文本`);
  }
  return units.map((text, index) => ({ id: `B${batchNumber}U${index + 1}`, text }));
}

/**
 * Split only the transport workload.  The Agent still sees the complete script
 * and makes every creative decision; the backend merely assigns contiguous
 * source ranges so a large JSON document cannot be silently cut by the model.
 */
function buildDirectorDraftBatches(scriptContent, targetCount, batchSize = DIRECTOR_DRAFT_BATCH_SIZE) {
  const count = Math.max(1, Math.floor(Number(targetCount) || 1));
  if (count <= DIRECTOR_BATCH_THRESHOLD) {
    return [{ index: 0, shot_count: count, script_segment: String(scriptContent || '').trim() }];
  }

  const shotCounts = [];
  for (let remaining = count; remaining > 0; remaining -= batchSize) {
    shotCounts.push(Math.min(batchSize, remaining));
  }
  let units = splitScriptUnits(scriptContent, shotCounts.length);
  if (units.length < shotCounts.length) {
    units = splitCoverageEvenly(scriptContent, shotCounts.length);
  }
  const unitLengths = units.map((unit) => normalizeCoverageText(unit).length);
  const totalLength = unitLengths.reduce((sum, len) => sum + len, 0) || units.length;
  const batches = [];
  let unitIndex = 0;
  let consumedLength = 0;
  let consumedShots = 0;

  shotCounts.forEach((shotCount, batchIndex) => {
    const isLast = batchIndex === shotCounts.length - 1;
    const desiredEnd = totalLength * ((consumedShots + shotCount) / count);
    const selected = [];
    while (unitIndex < units.length) {
      const remainingUnits = units.length - unitIndex;
      const remainingBatches = shotCounts.length - batchIndex;
      // A long final paragraph must not cause this batch to consume the source
      // reserved for later batches, even when the proportional target is unmet.
      if (selected.length > 0 && remainingUnits <= remainingBatches - 1) break;
      if (!isLast && selected.length > 0 && consumedLength >= desiredEnd && remainingUnits >= remainingBatches) break;
      selected.push(units[unitIndex]);
      consumedLength += unitLengths[unitIndex] || 1;
      unitIndex += 1;
      if (!isLast && unitIndex < units.length && consumedLength >= desiredEnd && (units.length - unitIndex) >= (remainingBatches - 1)) break;
    }
    if (isLast && unitIndex < units.length) {
      selected.push(...units.slice(unitIndex));
      unitIndex = units.length;
    }
    const scriptSegment = selected.join('\n');
    batches.push({
      index: batchIndex,
      shot_count: shotCount,
      script_segment: scriptSegment,
      source_units: buildDirectorSourceUnits(scriptSegment, shotCount, batchIndex + 1),
    });
    consumedShots += shotCount;
  });
  // Validate all transport partitions before spending tokens on any draft.
  for (const batch of batches) {
    if (!normalizeCoverageText(batch.script_segment) || batch.source_units.length < batch.shot_count) {
      throw new Error(`导演初稿第 ${batch.index + 1} 批原文不足以覆盖 ${batch.shot_count} 镜，请调整规划；尚未生成初稿`);
    }
  }
  if (normalizeCoverageText(batches.map((batch) => batch.script_segment).join('')) !== normalizeCoverageText(scriptContent)) {
    throw new Error('导演初稿分批未完整覆盖源文本；尚未生成初稿');
  }
  return batches;
}

function batchCoverageText(shots) {
  return (Array.isArray(shots) ? shots : []).map((shot) => (
    shot?.semantic_slots?.source_script_excerpt || shot?.source_script_excerpt || ''
  )).join('');
}

function assertDirectorDraftBatch(batch, shots, parseMeta = {}) {
  if (parseMeta.truncated) {
    throw new Error(`导演初稿第 ${batch.index + 1} 批输出被模型截断，禁止保存已完成的局部镜头`);
  }
  if (!Array.isArray(shots) || shots.length !== batch.shot_count) {
    throw new Error(`导演初稿第 ${batch.index + 1} 批应返回 ${batch.shot_count} 镜，实际返回 ${Array.isArray(shots) ? shots.length : 0} 镜`);
  }
  if (Array.isArray(batch.source_units) && batch.source_units.length) {
    const expectedIds = batch.source_units.map((unit) => unit.id);
    const actualIds = [];
    for (let index = 0; index < shots.length; index++) {
      const ids = shots[index]?.semantic_slots?.source_script_unit_ids;
      if (!Array.isArray(ids) || ids.length === 0) {
        throw new Error(`导演初稿第 ${batch.index + 1} 批第 ${index + 1} 镜缺少 source_script_unit_ids`);
      }
      actualIds.push(...ids.map((id) => String(id)));
    }
    const expectedSet = new Set(expectedIds);
    const unknown = [...new Set(actualIds.filter((id) => !expectedSet.has(id)))];
    const missing = expectedIds.filter((id) => !actualIds.includes(id));
    const duplicates = [...new Set(actualIds.filter((id, index) => actualIds.indexOf(id) !== index))];
    const sameOrder = expectedIds.length === actualIds.length
      && expectedIds.every((id, index) => actualIds[index] === id);
    if (unknown.length || missing.length || duplicates.length || !sameOrder) {
      throw new Error(
        `导演初稿第 ${batch.index + 1} 批原文单元分配不完整`
        + `（缺失: ${missing.join(',') || '无'}；重复: ${duplicates.join(',') || '无'}；未知: ${unknown.join(',') || '无'}；必须按 ${expectedIds.join('→')} 连续分配）`
      );
    }
    return;
  }
  const expected = normalizeCoverageText(batch.script_segment);
  const actual = normalizeCoverageText(batchCoverageText(shots));
  if (expected && expected !== actual) {
    throw new Error(`导演初稿第 ${batch.index + 1} 批未完整映射连续剧本文本（期望 ${expected.length} 字，实际 ${actual.length} 字）`);
  }
}

function materializeDirectorDraftBatchExcerpts(batch, shots) {
  if (!Array.isArray(batch?.source_units) || !batch.source_units.length) return shots;
  const textById = new Map(batch.source_units.map((unit) => [unit.id, unit.text]));
  return shots.map((shot) => {
    const semanticSlots = isPlainObject(shot?.semantic_slots) ? shot.semantic_slots : {};
    const ids = semanticSlots.source_script_unit_ids.map((id) => String(id));
    return {
      ...shot,
      semantic_slots: {
        ...semanticSlots,
        source_script_unit_ids: ids,
        source_script_excerpt: ids.map((id) => textById.get(id)).join('\n'),
      },
    };
  });
}

function validateDirectorSourceAssignments(batch, rawAssignments) {
  if (!Array.isArray(rawAssignments) || rawAssignments.length !== batch.shot_count) {
    throw new Error(`导演原文覆盖规划应返回 ${batch.shot_count} 个镜头槽位`);
  }
  const normalized = rawAssignments.map((item, index) => {
    if (Number(item?.shot_slot) !== index + 1 || !Array.isArray(item?.source_script_unit_ids) || !item.source_script_unit_ids.length) {
      throw new Error(`导演原文覆盖规划第 ${index + 1} 个镜头槽位无效`);
    }
    return item.source_script_unit_ids.map((id) => String(id));
  });
  const expected = batch.source_units.map((unit) => unit.id);
  const actual = normalized.flat();
  const exact = actual.length === expected.length && actual.every((id, index) => id === expected[index]);
  if (!exact) {
    throw new Error(`导演原文覆盖规划必须按 ${expected.join('→')} 连续、无遗漏且无重复地分配`);
  }
  return normalized;
}

function directorRetryContext(options = {}) {
  return {
    maxAttempts: Math.max(1, Math.min(500, Number(options.maxAttempts || options.max_attempts || 500))),
    onProgress: typeof options.onProgress === 'function' ? options.onProgress : () => {},
    progress: Number.isFinite(Number(options.progress)) ? Number(options.progress) : 40,
  };
}

function reportDirectorLayerRetry(context, layer, attempt, detail = '') {
  context.onProgress(
    context.progress,
    `${layer}门禁反馈第 ${attempt}/${context.maxAttempts} 轮${detail ? ` · ${detail}` : ''}`
  );
}

function validTimelineDurationPlans(duration) {
  const seconds = Number(duration);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 8) return [];
  const plans = [];
  function visit(remaining, current) {
    if (!remaining) { plans.push(current); return; }
    // 镜内时间线只能使用 1～2 秒段。每段都必须成为一个可执行动作窗口，
    // 禁止把 4～8 秒整段交给模型自由填充。
    for (let n = Math.min(2, remaining); n >= 1; n--) visit(remaining - n, [...current, n]);
  }
  visit(seconds, []);
  return plans;
}

function timelineDurationPlanContract(duration) {
  const plans = validTimelineDurationPlans(duration);
  if (!plans.length) throw new Error(`无法为 ${duration} 秒镜头建立合法的镜内剪辑时长组合`);
  return `shots_timeline.duration 必须全部使用 1 或 2 个整数秒，并严格逐项采用下列任一完整数组：${JSON.stringify(plans)}。每一项对应连续时间窗口（例如 0–1、1–2 秒），不得用单个 4～8 秒大段填充。`;
}

async function planDirectorSourceAssignments(db, log, batch, retryOptions = {}) {
  const retry = directorRetryContext(retryOptions);
  const partitions = agentsRuntime.buildContiguousSourcePartitions(batch.source_units, batch.shot_count);
  if (!partitions.length) throw new Error(`导演初稿第 ${batch.index + 1} 批无法建立原文覆盖规划`);
  if (partitions.length === 1) return partitions[0];

  let lastError = null;
  for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
    try {
      const planned = await agentsRuntime.runAgent(db, log, {
        name: 'director-source-coverage-planner',
        instructions: '你是短剧导演的原文覆盖规划节点。只选择最符合语义节拍的连续分组；不得遗漏、重复、倒序或改写原文单元。',
        input: `把下列连续原文单元分配给 ${batch.shot_count} 个镜头槽位。每个槽位至少一个单元，保持原顺序，并让动作或对白尽量在语义完整处切镜：\n${JSON.stringify(batch.source_units, null, 2)}`,
        outputType: agentsRuntime.sourceAssignmentOutputType(batch.shot_count, batch.source_units),
        maxTokens: 2048,
        temperature: 0.2,
      });
      return validateDirectorSourceAssignments(batch, planned?.assignments);
    } catch (error) {
      lastError = error;
      log.warn('[导演Agent] 原文覆盖规划未通过门禁，退回 SDK Agent 重试', {
        batch: batch.index + 1,
        attempt,
        error: error.message,
      });
      reportDirectorLayerRetry(retry, `导演初稿第 ${batch.index + 1} 批原文覆盖规划`, attempt, error.message);
    }
  }
  throw new Error(`导演初稿第 ${batch.index + 1} 批原文覆盖规划经过 ${retry.maxAttempts} 轮门禁反馈仍未通过：${lastError?.message || '未知错误'}`);
}

/**
 * A draft batch is a transport boundary.  Do not leave the complete episode
 * script in the same request: some reasoning models follow the global story
 * instead of the later batch instruction and regenerate many earlier shots.
 * The semantic package remains available in the system prompt for continuity;
 * the user message contains only the source text this batch is allowed to map.
 */
function isolateDirectorDraftBatchPrompt(userPrompt, fullScript, batchScript) {
  const fullScriptBlock = `【剧本内容】：\n${String(fullScript || '')}`;
  if (!String(userPrompt || '').includes(fullScriptBlock)) {
    throw new Error('导演初稿分批提示词缺少完整剧本边界，无法安全隔离当前批次');
  }
  return String(userPrompt).replace(
    fullScriptBlock,
    `【当前批次唯一允许处理的剧本内容】：\n${String(batchScript || '')}`
  );
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * 确定性应用 Agent 返回的 JSON Merge Patch：对象递归合并，数组/标量整体替换，null 作为显式值保留。
 * 后端只执行 Agent 明示的变更，不补字段、不推断创意内容。
 */
function mergeDirectorAgentPatch(current, patch) {
  if (!isPlainObject(patch)) throw new Error('Director repair patch 必须是 JSON 对象');
  const output = isPlainObject(current) ? { ...current } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      throw new Error(`Director repair patch 包含非法字段 ${key}`);
    }
    if (isPlainObject(value) && isPlainObject(output[key])) {
      output[key] = mergeDirectorAgentPatch(output[key], value);
    } else if (Array.isArray(value)) {
      output[key] = value.map((item) => (isPlainObject(item) ? mergeDirectorAgentPatch({}, item) : item));
    } else {
      output[key] = value;
    }
  }
  return output;
}

/**
 * 单镜微调只接受 Agent 明示的字段级 Patch。未列出的字段保持原值；未知字段直接退回 Agent，
 * 避免把 id、镜号或数据库状态等执行层字段混入导演语义。
 */
function applySingleStoryboardPatch(current, response, shotNumber) {
  if (isPlainObject(response) && response.noop === true) {
    if (!String(response.reason || '').trim() || Object.prototype.hasOwnProperty.call(response, 'patch')) {
      throw Object.assign(new Error('单镜微调 noop 必须提供 reason，且不能同时包含 patch'), {
        status: 422,
        valid: false,
        violations: [{
          rule: 'INVARIANT_AGENT_NOOP_INVALID',
          severity: 'error',
          shot_number: shotNumber,
          conflict_slots: ['noop', 'reason', 'patch'],
          message: '已满足用户指令时返回 {"noop":true,"reason":"..."}；不得与 patch 混用',
        }],
      });
    }
    return mergeDirectorAgentPatch({}, current);
  }
  if (!isPlainObject(response) || !isPlainObject(response.patch)) {
    throw Object.assign(new Error('单镜微调响应必须是 patch 或 noop 协议'), {
      status: 422,
      valid: false,
      violations: [{
        rule: 'INVARIANT_AGENT_PATCH_INVALID',
        severity: 'error',
        shot_number: shotNumber,
        conflict_slots: ['patch'],
        message: '需要修改时返回 {"patch":{...}}；当前数据已满足指令时返回 {"noop":true,"reason":"..."}',
      }],
    });
  }
  const keys = Object.keys(response.patch);
  if (!keys.length) {
    throw Object.assign(new Error('单镜微调 Patch 不能为空'), {
      status: 422,
      valid: false,
      violations: [{
        rule: 'INVARIANT_AGENT_PATCH_EMPTY',
        severity: 'error',
        shot_number: shotNumber,
        conflict_slots: ['patch'],
        message: 'patch 必须包含本轮需要修改的字段',
      }],
    });
  }
  const unknown = keys.filter((field) => !SINGLE_STORYBOARD_PATCH_FIELDS.has(field));
  if (unknown.length) {
    throw Object.assign(new Error(`单镜微调 Patch 包含不可修改字段：${unknown.join('、')}`), {
      status: 422,
      valid: false,
      violations: unknown.map((field) => ({
        rule: 'INVARIANT_AGENT_PATCH_FIELD_FORBIDDEN',
        severity: 'error',
        shot_number: shotNumber,
        conflict_slots: [field],
        message: `单镜微调不得修改执行层字段 ${field}`,
      })),
    });
  }
  return mergeDirectorAgentPatch(current, response.patch);
}

function selectDirectorRepairTarget(shots, violations) {
  const list = Array.isArray(shots) ? shots : [];
  const errors = Array.isArray(violations) ? violations : [];
  if (!list.length || !errors.length) return null;

  const byShot = new Map();
  for (const violation of errors) {
    const shotNumber = Number(violation?.shot_number);
    if (!Number.isInteger(shotNumber) || shotNumber <= 0) continue;
    if (!byShot.has(shotNumber)) byShot.set(shotNumber, []);
    byShot.get(shotNumber).push(violation);
  }

  if (byShot.size > 0) {
    const shotNumber = [...byShot.keys()].sort((a, b) => a - b)[0];
    // Repair one shot as a coherent unit. Sending only the first violation
    // caused the same shot to be reopened once per missing field/timeline
    // segment and multiplied a single defect into dozens of model calls.
    return { shot_number: shotNumber, violations: byShot.get(shotNumber), global: false };
  }

  // The current whole-episode hard gate is the static-shot ratio. Repair one
  // concrete static shot, then let the next full audit decide whether another
  // shot still needs changing.
  const globalViolation = errors[0];
  let target = null;
  if (globalViolation?.rule === 'INVARIANT_STATIC_RATIO_EXCEEDED') {
    target = list.find((shot) => ['static', '固定'].includes(String(shot?.movement || '').trim().toLowerCase()));
  }
  target ||= list[0];
  const shotNumber = Number(target?.shot_number);
  if (!Number.isInteger(shotNumber) || shotNumber <= 0) return null;
  return { shot_number: shotNumber, violations: [globalViolation], global: true };
}

function directorAtomicRepairHint(violation) {
  const item = violation && typeof violation === 'object' ? violation : {};
  const path = Array.isArray(item.conflict_slots) ? item.conflict_slots.filter(Boolean).join('、') : '';
  const character = item.character_name
    ? `角色「${item.character_name}」${item.character_id != null ? `（ID ${item.character_id}）` : ''}`
    : '';
  const fieldRules = {
    INVARIANT_REQUIRED_AGENT_SLOT_MISSING: '由 Agent 显式补齐目标字段，不得改动其他已确认语义。无人镜头也必须显式输出 character_visuals: []；空数组合法，缺字段或 null 不合法。',
    INVARIANT_DIRECTOR_DURATION_RANGE: '遵守违规详情中的本任务时长范围，同步调整 duration、semantic_slots.shot_duration、video_slots.timing.duration 与镜内时间线。不得删改台词；超出范围上限仍说不完时按语义拆镜。',
    INVARIANT_SLOT_MISSING_SCREEN_POSITION: 'screen_position 必须包含“画面左侧/画面右侧/画面中央”之一，并同时写明前景/中景/后景。',
    INVARIANT_SLOT_MISSING_FACING: 'facing 必须明确写成“侧身朝向画面左侧/侧身朝向画面右侧/正面面对镜头/背向镜头”等可校验短语。',
    INVARIANT_SLOT_MISSING_HEAD_POSE: 'head_pose 必须显式包含“头部/侧头/低头/抬头/仰头/俯头/转头/正对”之一，例如“头部微俯并侧头朝向红狼”。',
    INVARIANT_SLOT_MISSING_GAZE: 'gaze 必须显式包含“目光/视线/看/盯/凝视”之一，并写出具体落点。',
    INVARIANT_SLOT_MISSING_POSTURE: 'posture 必须写出站、蹲、坐、卧、趴、俯、仰、倾、跪、靠、立或挺等明确体态与重心。',
    INVARIANT_SLOT_MISSING_HANDS: 'hands 必须写出手、臂、指、握、按、托、持、掌或抓等明确肢体动作。',
    INVARIANT_UNIVERSAL_CREATION_MODE_REQUIRED: '本轮只能修改顶层 creation_mode，且值必须为 universal；不得返回 semantic_slots、video_slots 或其他字段。',
    INVARIANT_MISSING_INCOMING_CONTINUITY: '在 semantic_slots 中补齐 continuity_from_previous，必须包含 relationship、previous_end_state、entry_state、causal_link；只修复当前镜头，不能改写上一镜。',
    INVARIANT_INCOMING_CONTINUITY_INCOMPLETE: '在 semantic_slots.continuity_from_previous 中补齐门禁指出的字段，并保持上一镜结束状态、本镜进入状态和因果关系一致。',
    INVARIANT_EYELINE_MATCH_WITHOUT_EYE_TARGET: '修正 continuity_from_previous 与对应 character_visuals/video_slots 的视线目标，明确上一镜视线来源、本镜目标和注意力落点。',
    INVARIANT_SPEECH_SLOT_DIVERGENCE: '先修复台词槽位冲突，再重新评估时长：以当前镜头数据库 dialogue/narration 为不可变原文，逐字同步 semantic_slots.speech_plan.text 与 video_slots.audio_lip_sync.dialogue_content；禁止因为派生的超时结果直接拆镜或把下一镜台词带入本镜。',
  };
  const exact = fieldRules[item.rule] || '';
  const speechExtension = item.rule === 'INVARIANT_SPEECH_OVER_BUDGET'
    && Number(item.assessment?.recommendedDuration) <= (item.max_duration ?? 8)
    ? `- 本镜无需拆外层分镜：把顶层 duration、semantic_slots.shot_duration、video_slots.timing.duration 统一延长为 ${Number(item.assessment.recommendedDuration)} 秒，并重新规划 video_slots.shots_timeline；镜内每段只能是 1 或 2 个整数秒的连续动作窗口，段时长总和必须严格等于新总时长。逐字保留台词。`
    : '';
  if (!path && !exact && !speechExtension) return '';
  return [
    '【本轮原子 Patch 路径约束】',
    path ? `- 唯一目标路径：${path}${character ? `，目标${character}` : ''}。` : '',
    exact ? `- ${exact}` : '',
    speechExtension,
    /^(character_visuals|last_frame_visuals)\[/.test(path)
      ? `- ${path.split('[')[0]} 是数组：Patch 必须返回该镜头完整的 ${path.split('[')[0]} 数组，保留所有人物和所有既有字段，只改上述目标人物的目标字段；不得只返回单个人物或局部对象。首帧与尾帧是不同时间的状态，不得用另一帧代替本轮目标。`
      : '',
  ].filter(Boolean).join('\n');
}

function requiresDirectorStructuralRepair(violation) {
  if (violation?.rule === 'INVARIANT_DIRECTOR_DURATION_RANGE') return violation.requires_split === true;
  if (violation?.rule === 'INVARIANT_MULTI_SPEAKER_SHOT') return true;
  if (violation?.rule !== 'INVARIANT_SPEECH_OVER_BUDGET') return false;
  const recommended = Number(violation?.assessment?.recommendedDuration);
  return !Number.isFinite(recommended) || recommended > (violation.max_duration ?? 8);
}

function mergeAtomicPatchSchemas(left, right) {
  if (!left) return right;
  if (!right) return left;
  if (left.type === 'object' && right.type === 'object') {
    const properties = {};
    const keys = new Set([
      ...Object.keys(left.properties || {}),
      ...Object.keys(right.properties || {}),
    ]);
    for (const key of keys) {
      properties[key] = left.properties?.[key] && right.properties?.[key]
        ? mergeAtomicPatchSchemas(left.properties[key], right.properties[key])
        : (left.properties?.[key] || right.properties?.[key]);
    }
    return {
      type: 'object',
      additionalProperties: false,
      required: [...new Set([...(left.required || []), ...(right.required || [])])],
      properties,
    };
  }
  if (left.type === 'array' && right.type === 'array') {
    const leftPrefix = Array.isArray(left.prefixItems) ? left.prefixItems : [];
    const rightPrefix = Array.isArray(right.prefixItems) ? right.prefixItems : [];
    const prefixItems = Array.from({ length: Math.max(leftPrefix.length, rightPrefix.length) }, (_, index) => (
      leftPrefix[index] && rightPrefix[index]
        ? mergeAtomicPatchSchemas(leftPrefix[index], rightPrefix[index])
        : (leftPrefix[index] || rightPrefix[index])
    ));
    return {
      ...left,
      ...right,
      minItems: Math.max(Number(left.minItems || 0), Number(right.minItems || 0)),
      maxItems: Math.max(Number(left.maxItems || 0), Number(right.maxItems || 0)),
      ...(prefixItems.length ? { prefixItems } : {}),
      items: left.items ?? right.items,
    };
  }
  // A merged repair intentionally unlocks fields that were locked by another
  // single-field schema. Prefer the actionable constraint over a preserved
  // const value for that same path.
  if (Object.prototype.hasOwnProperty.call(left, 'const') && !Object.prototype.hasOwnProperty.call(right, 'const')) return right;
  if (Object.prototype.hasOwnProperty.call(right, 'const') && !Object.prototype.hasOwnProperty.call(left, 'const')) return left;
  if (left.enum && !right.enum) return left;
  if (right.enum && !left.enum) return right;
  // Different constraints on the same path are both valid alternatives only
  // when they describe the same field. Keep both rather than silently picking
  // one; the model must satisfy the relevant contract for this shot.
  if (JSON.stringify(left) === JSON.stringify(right)) return left;
  return { anyOf: [left, right] };
}

function directorAtomicPatchSchemaSingle(violation, targetShot = null) {
  if (violation?.rule === 'INVARIANT_REQUIRED_AGENT_SLOT_MISSING'
    && String(violation?.conflict_slots?.[0] || '').includes('continuity_from_previous')) {
    return {
      type: 'object', additionalProperties: false, required: ['semantic_slots'], properties: {
        semantic_slots: {
          type: 'object', additionalProperties: false, required: ['continuity_from_previous'], properties: {
            continuity_from_previous: {
              type: 'object', additionalProperties: false,
              required: ['relationship', 'previous_end_state', 'entry_state', 'causal_link'],
              properties: {
                relationship: { type: 'string' }, previous_end_state: { type: 'string' },
                entry_state: { type: 'string' }, causal_link: { type: 'string' },
                sound_bridge: { type: 'string' }, requires_previous_tail: { type: 'boolean' },
              },
            },
          },
        },
      },
    };
  }
  if (violation?.rule === 'INVARIANT_REQUIRED_AGENT_SLOT_MISSING'
    && ['character_visuals', 'last_frame_visuals'].includes(violation?.conflict_slots?.[0])) {
    const field = violation.conflict_slots[0];
    return { type: 'object', additionalProperties: false, required: [field], properties: {
      [field]: agentsRuntime.directorCharacterVisualsOutputType().schema.properties[field],
    } };
  }
  if (violation?.rule === 'INVARIANT_UNIVERSAL_CREATION_MODE_REQUIRED') {
    return {
      type: 'object',
      additionalProperties: false,
      required: ['creation_mode'],
      properties: { creation_mode: { const: 'universal' } },
    };
  }
  if (violation?.rule === 'INVARIANT_UNIVERSAL_REF2VA_REQUIRED') {
    return {
      type: 'object',
      additionalProperties: false,
      required: ['semantic_slots'],
      properties: {
        semantic_slots: {
          type: 'object',
          additionalProperties: false,
          required: ['h3_mode'],
          properties: { h3_mode: { const: 'ref2va' } },
        },
      },
    };
  }
  if (violation?.rule === 'INVARIANT_SPEECH_SLOT_DIVERGENCE') {
    // A speech-slot divergence is a prerequisite error for timing checks.  The
    // Agent must first restore the one authoritative utterance across the DB
    // dialogue/narration, semantic speech plan and H3 audio slot.  Keep this
    // as a deterministic patch contract so a derived over-budget violation
    // cannot make the Agent pull the next shot's line into this one.
    const dialogueParts = require('../services/dialogueDubbingService').dialogueSegments(targetShot?.dialogue || '')
      .filter((line) => String(line?.text || '').trim());
    const narration = String(targetShot?.narration || '').trim();
    const databasePart = dialogueParts.length === 1 ? dialogueParts[0] : null;
    const canonicalText = databasePart?.text || narration;
    const canonicalSpeaker = databasePart?.speaker || '';
    if (!canonicalText) return null;

    const patchProperties = {
      dialogue: { const: String(targetShot?.dialogue || '') },
      narration: { const: narration },
      semantic_slots: {
        type: 'object', additionalProperties: false, required: ['speech_plan'],
        properties: {
          speech_plan: {
            type: 'object', additionalProperties: false, required: ['text'],
            properties: {
              text: { const: canonicalText },
              ...(canonicalSpeaker ? { speaker_name: { const: canonicalSpeaker } } : {}),
            },
          },
        },
      },
      video_slots: {
        type: 'object', additionalProperties: false, required: ['audio_lip_sync'],
        properties: {
          audio_lip_sync: {
            type: 'object', additionalProperties: false,
            required: ['dialogue_content'],
            properties: {
              dialogue_content: { const: canonicalText },
              ...(canonicalSpeaker ? { speaker_name: { const: canonicalSpeaker } } : {}),
            },
          },
        },
      },
    };
    return {
      type: 'object', additionalProperties: false,
      required: ['dialogue', 'narration', 'semantic_slots', 'video_slots'],
      properties: patchProperties,
    };
  }
  if (['INVARIANT_MISSING_INCOMING_CONTINUITY', 'INVARIANT_INCOMING_CONTINUITY_INCOMPLETE', 'INVARIANT_EYELINE_MATCH_WITHOUT_EYE_TARGET'].includes(violation?.rule)) {
    let current = targetShot?.semantic_slots;
    if (typeof current === 'string') { try { current = JSON.parse(current); } catch (_) { current = null; } }
    const required = ['relationship', 'previous_end_state', 'entry_state', 'causal_link'];
    const properties = {};
    for (const key of required) {
      properties[key] = { type: 'string' };
    }
    properties.sound_bridge = { type: 'string' };
    properties.requires_previous_tail = { type: 'boolean' };
    return {
      type: 'object', additionalProperties: false, required: ['semantic_slots'], properties: {
        semantic_slots: {
          type: 'object', additionalProperties: false, required: ['continuity_from_previous'], properties: {
            continuity_from_previous: { type: 'object', additionalProperties: false, required, properties },
          },
        },
      },
    };
  }
  const semanticSlots = targetShot?.semantic_slots && typeof targetShot.semantic_slots === 'object'
    ? targetShot.semantic_slots
    : null;
  if ([
    'INVARIANT_CHARACTER_MOUTH_NOT_SEALED',
    'INVARIANT_OFFSCREEN_LIP_SYNC_VIOLATION',
    'INVARIANT_OFFSCREEN_SPEECH_LIP_SYNC_CONFLICT',
  ].includes(violation?.rule)) {
    const trajectories = Array.isArray(targetShot?.video_slots?.trajectories)
      ? targetShot.video_slots.trajectories
      : [];
    const prefixItems = trajectories.map((trajectory) => {
      const properties = Object.fromEntries(Object.entries(trajectory || {}).map(([key, value]) => [
        key,
        key === 'mouth_state' ? { const: '双唇紧闭无口型' } : { const: value },
      ]));
      if (!Object.prototype.hasOwnProperty.call(properties, 'mouth_state')) {
        properties.mouth_state = { const: '双唇紧闭无口型' };
      }
      return {
        type: 'object',
        additionalProperties: false,
        required: Object.keys(properties),
        properties,
      };
    });
    return {
      type: 'object',
      additionalProperties: false,
      required: ['video_slots'],
      properties: {
        video_slots: {
          type: 'object',
          additionalProperties: false,
          required: ['audio_lip_sync', 'trajectories'],
          properties: {
            audio_lip_sync: {
              type: 'object',
              additionalProperties: false,
              required: ['visible_characters_lip_state'],
              properties: { visible_characters_lip_state: { const: 'strictly_sealed' } },
            },
            trajectories: {
              type: 'array',
              minItems: trajectories.length,
              maxItems: trajectories.length,
              prefixItems,
              items: false,
            },
          },
        },
      },
    };
  }
  if (violation?.rule === 'INVARIANT_SPEECH_OVER_BUDGET') {
    const recommendedDuration = Number(violation?.assessment?.recommendedDuration);
    if (Number.isInteger(recommendedDuration) && recommendedDuration >= 4 && recommendedDuration <= (violation.max_duration ?? 8)) {
      const timelinePlans = validTimelineDurationPlans(recommendedDuration);
      const exactTimelineSchema = (plan) => ({
        type: 'array',
        minItems: plan.length,
        maxItems: plan.length,
        prefixItems: plan.map((segmentDuration) => ({
          type: 'object',
          additionalProperties: true,
          required: ['duration'],
          properties: { duration: { const: segmentDuration } },
        })),
        items: false,
      });
      return {
        type: 'object',
        additionalProperties: false,
        required: ['duration', 'semantic_slots', 'video_slots'],
        properties: {
          duration: { const: recommendedDuration },
          semantic_slots: {
            type: 'object',
            additionalProperties: false,
            required: ['shot_duration'],
            properties: { shot_duration: { const: recommendedDuration } },
          },
          video_slots: {
            type: 'object',
            additionalProperties: false,
            required: ['timing', 'shots_timeline'],
            properties: {
              timing: {
                type: 'object',
                additionalProperties: false,
                required: ['duration'],
                properties: { duration: { const: recommendedDuration } },
              },
              shots_timeline: timelinePlans.length === 1
                ? exactTimelineSchema(timelinePlans[0])
                : { oneOf: timelinePlans.map(exactTimelineSchema) },
            },
          },
        },
      };
    }
  }
  if (violation?.rule === 'INVARIANT_FRAMING_CHARACTER_COUNT_MISMATCH') {
    const visibleCount = Array.isArray(semanticSlots?.visible_characters)
      ? semanticSlots.visible_characters.length
      : 0;
    const allowed = visibleCount > 2
      ? ['group_blocking', 'multi_character_reaction', 'wide_group']
      : (visibleCount === 2 ? ['two_shot_face_to_face', 'over_the_shoulder', 'joint_observation'] : ['solo_action']);
    return {
      type: 'object',
      additionalProperties: false,
      required: ['dialogue_framing'],
      properties: { dialogue_framing: { type: 'string', enum: allowed } },
    };
  }
  if (semanticSlots && [
    'INVARIANT_UNIVERSAL_SCENE_REFERENCE_REQUIRED',
    'INVARIANT_UNIVERSAL_CHARACTER_REFERENCE_MISSING',
  ].includes(violation?.rule)) {
    const refs = Array.isArray(semanticSlots.required_references)
      ? semanticSlots.required_references.map((item) => mergeDirectorAgentPatch({}, item))
      : [];
    let nextRefs = refs;
    if (violation.rule === 'INVARIANT_UNIVERSAL_SCENE_REFERENCE_REQUIRED') {
      const sceneId = Number(targetShot?.scene_id);
      const sceneIndex = refs.findIndex((ref) => (
        String(ref?.type || ref?.asset_type || '').toLowerCase() === 'scene'
        && Number(ref?.id ?? ref?.scene_id) === sceneId
      ));
      const sceneRef = sceneIndex >= 0
        ? refs[sceneIndex]
        : { type: 'scene', id: sceneId, scene_id: sceneId };
      nextRefs = [sceneRef, ...refs.filter((_, index) => index !== sceneIndex)];
    } else {
      const present = new Set(refs
        .filter((ref) => String(ref?.type || ref?.asset_type || '').toLowerCase() === 'character')
        .map((ref) => Number(ref?.id ?? ref?.character_id))
        .filter(Number.isFinite));
      const characters = [
        ...(Array.isArray(semanticSlots.visible_characters) ? semanticSlots.visible_characters : []),
        ...(Array.isArray(semanticSlots.background_characters) ? semanticSlots.background_characters : []),
      ];
      const additions = [];
      for (const character of characters) {
        const id = Number(character?.id ?? character?.character_id ?? character);
        if (!Number.isFinite(id) || present.has(id)) continue;
        present.add(id);
        additions.push({
          type: 'character',
          id,
          character_id: id,
          name: String(character?.name || ''),
        });
      }
      nextRefs = [...refs, ...additions];
    }
    return {
      type: 'object',
      additionalProperties: false,
      required: ['semantic_slots'],
      properties: {
        semantic_slots: {
          type: 'object',
          additionalProperties: false,
          required: ['required_references'],
          properties: {
            required_references: {
              type: 'array',
              minItems: nextRefs.length,
              maxItems: nextRefs.length,
              prefixItems: nextRefs.map((ref) => ({ const: ref })),
              items: false,
            },
          },
        },
      },
    };
  }
  const visualFieldByRule = {
    INVARIANT_SLOT_MISSING_SCREEN_POSITION: ['screen_position', ['画面左侧前景', '画面右侧前景', '画面左侧中景', '画面右侧中景', '画面中央后景']],
    INVARIANT_SLOT_MISSING_FACING: ['facing', ['正面面对镜头', '背向镜头', '侧身朝向画面左侧', '侧身朝向画面右侧', '四分之三侧身面对受话人']],
    INVARIANT_SLOT_MISSING_HEAD_POSE: ['head_pose', ['头部正对前方', '头部微俯', '侧头偏向画面左侧', '侧头偏向画面右侧', '低头看向手中道具', '转头朝向受话人']],
    INVARIANT_SLOT_MISSING_GAZE: ['gaze', ['目光紧盯受话人双眼', '视线锁定前方动作源', '目光看向手中道具', '双眼凝视画面左侧事件源', '双眼凝视画面右侧事件源']],
    INVARIANT_SLOT_MISSING_POSTURE: ['posture', ['身体前倾站立，重心压向前脚', '半蹲低伏，重心稳定下沉', '单膝跪地，躯干微微前倾', '端坐并身体前倾，重心落在座面前侧', '侧卧撑地，躯干重心压低']],
    INVARIANT_SLOT_MISSING_HANDS: ['hands', ['双手自然垂在身体两侧', '双手紧握手中道具', '右手按住身前支撑物，左手护在胸前', '双臂抬起并把手掌朝向动作对象', '右手手指指向事件源，左手收在身侧']],
  };
  const target = visualFieldByRule[violation?.rule];
  const visualField = String(violation?.conflict_slots?.[0] || '').startsWith('last_frame_visuals[')
    ? 'last_frame_visuals' : 'character_visuals';
  const visuals = Array.isArray(targetShot?.[visualField]) ? targetShot[visualField] : [];
  if (!target || visuals.length === 0) return null;
  const [field, allowedValues] = target;
  const explicitIndex = String(violation?.conflict_slots?.[0] || '').match(/^(?:character_visuals|last_frame_visuals)\[(\d+)\]\./u);
  let targetIndex = explicitIndex ? Number(explicitIndex[1]) : -1;
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= visuals.length) {
    targetIndex = visuals.findIndex((item) => (
      (violation.character_id != null && Number(item?.character_id) === Number(violation.character_id))
      || (violation.character_name && String(item?.name || '') === String(violation.character_name))
    ));
  }
  if (targetIndex < 0) return null;
  const prefixItems = visuals.map((visual, index) => {
    const entries = Object.entries(visual || {});
    const properties = Object.fromEntries(entries.map(([key, value]) => [
      key,
      index === targetIndex && key === field
        ? { type: 'string', enum: allowedValues }
        : { const: value },
    ]));
    if (!Object.prototype.hasOwnProperty.call(properties, field) && index === targetIndex) {
      properties[field] = { type: 'string', enum: allowedValues };
    }
    return {
      type: 'object',
      additionalProperties: false,
      required: Object.keys(properties),
      properties,
    };
  });
  return {
    type: 'object',
    additionalProperties: false,
    required: [visualField],
    properties: {
      [visualField]: {
        type: 'array',
        minItems: visuals.length,
        maxItems: visuals.length,
        prefixItems,
        items: false,
      },
    },
  };
}

function directorAtomicPatchSchema(violation, targetShot = null) {
  const violations = Array.isArray(violation)
    ? violation.filter(Boolean)
    : [violation].filter(Boolean);
  if (violations.length <= 1) return directorAtomicPatchSchemaSingle(violations[0], targetShot);
  // One response must repair the complete target shot contract. Merge the
  // field requirements for all violations instead of deriving the schema from
  // the first violation and forcing one-field-at-a-time retries.
  return violations
    .map((item) => directorAtomicPatchSchemaSingle(item, targetShot))
    .reduce((merged, schema) => mergeAtomicPatchSchemas(merged, schema), null);
}

function repairContextForViolations(shots, violations) {
  const list = Array.isArray(shots) ? shots : [];
  const target = selectDirectorRepairTarget(list, violations);
  if (!target) return [];
  const index = list.findIndex((shot) => Number(shot.shot_number) === target.shot_number);
  if (index < 0) return [];

  const indexes = new Set();
  indexes.add(index);
  if (index > 0) indexes.add(index - 1);
  if (index + 1 < list.length) indexes.add(index + 1);
  return [...indexes].sort((a, b) => a - b).map((index) => list[index]);
}

/**
 * 支持两种互斥的 Agent 修复协议：
 * 1. repairs: 对现有镜头做字段级 Patch；
 * 2. structural_repairs: 用一到多个完整镜头替换指定镜头，用于超长对白拆镜。
 */
function applyDirectorRepairPlan(currentShots, plan) {
  if (!isPlainObject(plan)) throw new Error('Director repair 响应必须是 JSON 对象');
  const repairs = Array.isArray(plan.repairs) ? plan.repairs : [];
  const structural = Array.isArray(plan.structural_repairs) ? plan.structural_repairs : [];
  if (!repairs.length && !structural.length) throw new Error('Director repair 响应未包含 repairs 或 structural_repairs');
  if (repairs.length && structural.length) throw new Error('字段修复与拆镜修复必须分轮执行，不能在同一响应中混用');
  if (repairs.length > 1) throw new Error('每轮只允许修复一个目标镜头');
  if (structural.length > 1) throw new Error('每轮只允许一项结构修复，完成并重新编号后再处理下一项');

  let next = (Array.isArray(currentShots) ? currentShots : []).map((shot) => mergeDirectorAgentPatch({}, shot));
  let changedCount = 0;

  if (repairs.length) {
    const seen = new Set();
    for (const repair of repairs) {
      const shotNumber = Number(repair && repair.shot_number);
      if (!Number.isInteger(shotNumber) || shotNumber <= 0 || !isPlainObject(repair.patch)) {
        throw new Error('每个 repairs 项必须包含有效 shot_number 与 patch 对象');
      }
      if (seen.has(shotNumber)) throw new Error(`镜头 #${shotNumber} 在同一轮出现重复 Patch`);
      seen.add(shotNumber);
      const index = next.findIndex((shot) => Number(shot.shot_number) === shotNumber);
      if (index < 0) throw new Error(`Patch 指向不存在的镜头 #${shotNumber}`);
      if (Object.prototype.hasOwnProperty.call(repair.patch, 'shot_number') && Number(repair.patch.shot_number) !== shotNumber) {
        throw new Error(`镜头 #${shotNumber} 的 Patch 不得改写为其他 shot_number`);
      }
      const originalExcerpt = next[index]?.semantic_slots?.source_script_excerpt;
      const patchedExcerpt = repair.patch?.semantic_slots?.source_script_excerpt;
      if (originalExcerpt != null && patchedExcerpt != null && normalizeCoverageText(originalExcerpt) !== normalizeCoverageText(patchedExcerpt)) {
        throw new Error(`镜头 #${shotNumber} 的普通字段修复不得改写 source_script_excerpt`);
      }
      const before = JSON.stringify(next[index]);
      next[index] = mergeDirectorAgentPatch(next[index], { ...repair.patch, shot_number: shotNumber });
      if (JSON.stringify(next[index]) !== before) changedCount++;
    }
  } else {
    const seen = new Set();
    for (const operation of structural) {
      const target = Number(operation && operation.replace_shot_number);
      const replacements = operation && operation.storyboards;
      if (!Number.isInteger(target) || target <= 0 || !Array.isArray(replacements) || !replacements.length || replacements.some((shot) => !isPlainObject(shot))) {
        throw new Error('每个 structural_repairs 项必须包含 replace_shot_number 与非空完整 storyboards 数组');
      }
      if (seen.has(target)) throw new Error(`镜头 #${target} 在同一轮出现重复结构修复`);
      seen.add(target);
      const index = next.findIndex((shot) => Number(shot.shot_number) === target);
      if (index < 0) throw new Error(`结构修复指向不存在的镜头 #${target}`);
      const originalExcerpt = next[index]?.semantic_slots?.source_script_excerpt;
      if (originalExcerpt != null) {
        const missingSource = replacements.findIndex(shot => !isPlainObject(shot.semantic_slots)
          || typeof shot.semantic_slots.source_script_excerpt !== 'string');
        if (missingSource >= 0) {
          throw new Error(`镜头 #${target} 拆镜第 ${missingSource + 1} 段缺少 semantic_slots.source_script_excerpt。每段必须包含完整 semantic_slots 对象；顶层 speech_plan、h3_mode、required_references 不能代替该对象。请由 Agent 将原文按顺序分配到各段 source_script_excerpt：${JSON.stringify(originalExcerpt)}`);
        }
        const replacementExcerpt = replacements.map((shot) => shot?.semantic_slots?.source_script_excerpt || '').join('');
        if (normalizeCoverageText(originalExcerpt) !== normalizeCoverageText(replacementExcerpt)) {
          throw new Error(`镜头 #${target} 拆镜后的 source_script_excerpt 拼接结果必须与原镜完全一致`);
        }
      }
      // Structural split responses are compact patches over the original shot,
      // so unchanged identity, wardrobe, references and visual contracts are
      // retained explicitly rather than regenerated and duplicated in JSON.
      // The resulting materialized shots still go through the complete gate.
      const baseShot = next[index];
      next.splice(index, 1, ...replacements.map((shot) => mergeDirectorAgentPatch(baseShot, shot)));
      changedCount += replacements.length;
    }
    next = next.map((shot, index) => ({ ...shot, shot_number: index + 1 }));
  }

  if (!changedCount) throw new Error('Director repair 未产生任何实际变更');
  return { shots: next, changed_count: changedCount, structural: structural.length > 0 };
}

function agentSlotShapeViolations(shot, shotNumber) {
  const violations = [];
  const add = (field, message) => violations.push({
    rule: 'INVARIANT_REQUIRED_AGENT_SLOT_MISSING',
    shot_number: shotNumber,
    severity: 'error',
    conflict_slots: [field],
    message,
  });
  if (!Array.isArray(shot.character_visuals)) add('character_visuals', `分镜 #${shotNumber} 的 character_visuals 必须由 Agent 显式输出为数组`);
  if (!shot.video_slots || typeof shot.video_slots !== 'object' || Array.isArray(shot.video_slots)) {
    add('video_slots', `分镜 #${shotNumber} 缺少 Agent 规划的 video_slots 对象`);
  } else {
    for (const key of REQUIRED_VIDEO_SLOT_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(shot.video_slots, key)) add(`video_slots.${key}`, `分镜 #${shotNumber} 缺少 video_slots.${key}`);
    }
  }
  if (!shot.semantic_slots || typeof shot.semantic_slots !== 'object' || Array.isArray(shot.semantic_slots)) {
    add('semantic_slots', `分镜 #${shotNumber} 缺少 Agent 规划的 semantic_slots 对象`);
  } else {
    for (const key of REQUIRED_SEMANTIC_SLOT_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(shot.semantic_slots, key)) add(`semantic_slots.${key}`, `分镜 #${shotNumber} 缺少 semantic_slots.${key}`);
    }
  }
  return violations;
}

function normalizeDirectorShots(shots, universalOmni) {
  return shots.map((s, idx) => {
    const shotNum = idx + 1;
    const chars = Array.isArray(s.characters) ? s.characters : (Array.isArray(s.character_ids) ? s.character_ids : []);
    const pids = Array.isArray(s.props) ? s.props : (Array.isArray(s.prop_ids) ? s.prop_ids : []);
    const bgChars = Array.isArray(s.background_characters) ? s.background_characters : [];
    const startFraming = s.start_framing ? String(s.start_framing).trim() : (s.layout_description ? String(s.layout_description).trim() : '');
    const endFraming = s.end_framing ? String(s.end_framing).trim() : (s.result ? String(s.result).trim() : '');
    const transitionToNext = s.transition_to_next ? String(s.transition_to_next).trim() : '';

    return {
      ...s,
      shot_number: shotNum,
      characters: chars,
      props: pids,
      movement: String(s.movement).trim(),
      bgm_prompt: s.bgm_prompt ? String(s.bgm_prompt).trim() : '',
      start_framing: startFraming,
      end_framing: endFraming,
      transition_to_next: transitionToNext,
      background_characters: bgChars,
      lighting_style: angleService.normalizeLighting(s.lighting_style),
      depth_of_field: angleService.normalizeDof(s.depth_of_field),
      long_take_group_id: s.long_take_group_id ? String(s.long_take_group_id).trim() : null,
      long_take_role: s.long_take_role ? String(s.long_take_role).trim().toLowerCase() : null,
      long_take_sequence: s.long_take_sequence != null ? Number(s.long_take_sequence) : null,
      character_visuals: Array.isArray(s.character_visuals) ? s.character_visuals : [],
      last_frame_visuals: Array.isArray(s.last_frame_visuals) ? s.last_frame_visuals : [],
      video_slots: s.video_slots || null,
      semantic_slots: s.semantic_slots,
      creation_mode: universalOmni ? String(s.creation_mode || '').trim().toLowerCase() : 'classic',
      universal_segment_text: universalOmni ? String(s.universal_segment_text || '').trim() : null,
    };
  });

}

// One contract for the first audit, each repair, and the publication gate.
// In particular, missing arrays are not equivalent to an Agent-authored [].
function directorRequiredSlotViolations(shots, universalOmni = false) {
  const fields = ['duration', 'movement', 'lighting_style', 'depth_of_field', 'angle_h', 'angle_v', 'angle_s', 'shot_type', 'dialogue_framing'];
  if (universalOmni) fields.push('creation_mode', 'universal_segment_text');
  return shots.flatMap((shot, index) => {
    const shotNumber = shot.shot_number || index + 1;
    const errors = agentSlotShapeViolations(shot, shotNumber);
    for (const field of fields) {
      if (shot[field] == null || (typeof shot[field] === 'string' && !shot[field].trim())) {
        errors.push({ rule: 'INVARIANT_REQUIRED_AGENT_SLOT_MISSING', shot_number: shotNumber,
          severity: 'error', conflict_slots: [field], message: `分镜 #${shotNumber} 缺少 Agent 必须决策的语义字段 ${field}` });
      }
    }
    return errors;
  });
}

function auditDirectorDraft(shots, invariantOptions) {
  const base = validateAllInvariants(shots, invariantOptions);
  const shapeErrors = directorRequiredSlotViolations(shots, invariantOptions.directorPlanningMode === 'universal');
  const candidates = [...base.violations, ...shapeErrors];
  // Use the same format normalization before and after repairs, so normalization
  // cannot introduce a new semantic error only after the ReAct loop has exited.
  candidates.push(...validateAllInvariants(
    normalizeDirectorShots(shots, invariantOptions.directorPlanningMode === 'universal'), invariantOptions
  ).violations);
  const range = invariantOptions.requestedPacing?.range;
  if (range) {
    for (const violation of candidates) {
      if (violation.rule === 'INVARIANT_SPEECH_OVER_BUDGET') violation.max_duration = range.max;
    }
    for (const [index, shot] of shots.entries()) {
      const duration = Number(shot.duration);
      if (!Number.isInteger(duration) || duration < range.min || duration > range.max) {
        const requiresSplit = duration > range.max && checkSpeechTiming([{ ...shot, duration: range.max }], invariantOptions).length > 0;
        candidates.push({ rule: 'INVARIANT_DIRECTOR_DURATION_RANGE', shot_number: shot.shot_number || index + 1,
          severity: 'error', conflict_slots: ['duration', 'semantic_slots.shot_duration', 'video_slots.timing.duration', 'video_slots.shots_timeline'],
          requires_split: requiresSplit, max_duration: range.max,
          message: `分镜 #${shot.shot_number || index + 1} 时长 ${shot.duration} 秒不符合本任务 ${range.min}～${range.max} 秒整数范围。${requiresSplit ? '完整台词在上限内仍说不完，必须按语义拆镜，禁止删字。' : '由 Agent 在范围内重新规划时长及时间线。'}` });
      }
    }
  }
  const seen = new Set();
  const violations = candidates.filter(v => {
    const key = JSON.stringify([v.rule, v.shot_number, v.character_id, v.conflict_slots || [], v.message]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  return { ...base, valid: violations.length === 0, error_count: violations.length, violations,
    summary: violations.length ? `发现 ${violations.length} 项导演门禁违规，需要 Agent 修复。` : base.summary };
}

function auditDirectorDraftScoped(shots, invariantOptions, previousAudit, shotNumber) {
  const full = auditDirectorDraft(shots, invariantOptions);
  const target = Number(shotNumber);
  const scope = new Set([target - 1, target, target + 1].filter(n => n > 0));
  const previous = Array.isArray(previousAudit?.violations) ? previousAudit.violations : [];
  const preserved = previous.filter(item => Number.isInteger(Number(item?.shot_number)) && !scope.has(Number(item.shot_number)));
  const refreshed = full.violations.filter(item => !Number.isInteger(Number(item?.shot_number)) || scope.has(Number(item.shot_number)));
  const seen = new Set();
  const violations = [...preserved, ...refreshed].filter(item => {
    const key = JSON.stringify([item.rule, item.shot_number, item.character_id, item.conflict_slots || [], item.message]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  return {
    ...full,
    valid: violations.length === 0,
    error_count: violations.length,
    violations,
    audit_scope: [...scope].sort((a, b) => a - b),
  };
}

function shortDramaTimelineViolations(shot, timeline) {
  const videoSlots = {
    ...(shot.video_slots && typeof shot.video_slots === 'object' ? shot.video_slots : {}),
    shots_timeline: Array.isArray(timeline) ? timeline : [],
  };
  return validateVideoSlots(shot, videoSlots)
    .filter((item) => String(item.rule || '').startsWith('INVARIANT_SHORT_DRAMA_') && item.severity === 'error');
}

async function ensureDirectorShotTimeline(db, log, shot, retryOptions = {}) {
  const retry = directorRetryContext(retryOptions);
  const currentTimeline = Array.isArray(shot?.video_slots?.shots_timeline)
    ? shot.video_slots.shots_timeline
    : [];
  if (shortDramaTimelineViolations(shot, currentTimeline).length === 0) return shot;

  const semantic = shot?.semantic_slots && typeof shot.semantic_slots === 'object' ? shot.semantic_slots : {};
  const duration = Number(shot?.video_slots?.timing?.duration || semantic.shot_duration || shot.duration || 5);
  const durationPlanContract = timelineDurationPlanContract(duration);
  const visibleCharacters = Array.isArray(semantic.visible_characters) ? semantic.visible_characters : [];
  let lastErrors = shortDramaTimelineViolations(shot, currentTimeline);

  for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
    const feedback = attempt > 1
      ? `\n上一轮时间线被门禁拒绝：\n${lastErrors.map((item) => `- ${item.message}`).join('\n')}\n请重新规划完整时间线。`
      : '';
    let planned;
    try {
      planned = await agentsRuntime.runAgent(db, log, {
        name: 'director-shot-timeline-planner',
        instructions: `你是短剧导演的镜内剪辑规划节点。只规划当前一个外层分镜的 video_slots.shots_timeline，不得改写剧情、台词、人物、场景、总时长或 H3 模式。每段必须是 1 或 2 个整数秒的连续动作窗口，所有段时长之和必须精确等于总时长；禁止输出一个完整 4～8 秒大段。${durationPlanContract}。由你根据剧情节拍选择其中一个合法数组，并按原顺序逐项写入各段 duration，把段序号对应为 0–1、1–2 这样的连续时间窗口。每段先决定 camera，再填写 visible_characters（本段实际入画的人物；特写、过肩或画外音可以只列当前可见人物），character_trajectories 只能覆盖这个列表。每个时间段是可执行的动作合同：action、result 和每个可见人物的 character_trajectories 都要写该时间窗口内真实发生的动作、互动或因果反应；不能要求没有入画的人物做动作。两人对白必须给当前画面中的说话者与听者分别填写动作窗口；正反打只在信息或反应发生时切换。安静倾听不能单独占满一个时间段，必须与抬眼、转头、接物、退让等可见反应同时发生并有剧情依据。每个文字槽位用不超过 120 个汉字的具体描述，禁止解释、重复和扩写剧情。只使用 shot_number、timestamp、duration、camera、visible_characters、action、result、character_trajectories、audio_lip_sync、speech_action_alignment 字段。\n${DIRECTOR_ACTION_COMPLETION_CONTRACT}`,
        input: `【当前分镜总时长】${duration} 秒\n【合法时长组合】${JSON.stringify(validTimelineDurationPlans(duration))}\n【画内角色】${JSON.stringify(visibleCharacters)}\n【权威台词】${JSON.stringify(semantic.speech_plan || {})}\n【当前完整分镜，只读】${JSON.stringify(shot)}${feedback}`,
        outputType: agentsRuntime.directorTimelineOutputType(duration),
        maxTokens: 24576,
        temperature: 0.2,
      });
    } catch (error) {
      lastErrors = [{
        rule: 'INVARIANT_SHORT_DRAMA_TIMELINE_AGENT_OUTPUT',
        severity: 'error',
        message: `时间线 Agent 输出格式失败：${error.message}`,
      }];
      log.warn('[导演Agent] 镜内时间线 Agent 输出失败，原任务内重试', {
        shot_number: shot.shot_number,
        attempt,
        error: error.message,
      });
      reportDirectorLayerRetry(retry, `分镜 #${shot.shot_number} 镜内时间线`, attempt, error.message);
      continue;
    }
    const timeline = Array.isArray(planned?.shots_timeline) ? planned.shots_timeline : [];
    lastErrors = shortDramaTimelineViolations(shot, timeline);
    if (lastErrors.length === 0) {
      log.info('[导演Agent] 镜内时间线 Agent 规划通过', {
        shot_number: shot.shot_number,
        segment_count: timeline.length,
        duration,
        attempt,
      });
      return {
        ...shot,
        video_slots: { ...(shot.video_slots || {}), shots_timeline: timeline },
      };
    }
    log.warn('[导演Agent] 镜内时间线未通过门禁，退回时间线 Agent', {
      shot_number: shot.shot_number,
      attempt,
      violations: lastErrors,
    });
    reportDirectorLayerRetry(retry, `分镜 #${shot.shot_number} 镜内时间线`, attempt, lastErrors.map((item) => item.message).join('；'));
  }
  const error = new Error(`分镜 #${shot.shot_number} 的镜内时间线经过 ${retry.maxAttempts} 轮门禁反馈仍未通过：${lastErrors.map((item) => item.message).join('；')}`);
  error.violations = lastErrors;
  throw error;
}

function directorCharacterIds(shot) {
  const semantic = shot?.semantic_slots && typeof shot.semantic_slots === 'object' ? shot.semantic_slots : {};
  const ids = [];
  for (const entry of [...(semantic.visible_characters || []), ...(semantic.background_characters || [])]) {
    const id = Number(entry && typeof entry === 'object' ? (entry.id ?? entry.character_id) : entry);
    if (id > 0 && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function visualSlotErrors(shot, characterVisuals, lastFrameVisuals) {
  const expected = directorCharacterIds(shot).sort((a, b) => a - b);
  const actual = (Array.isArray(characterVisuals) ? characterVisuals : [])
    .map((item) => Number(item?.character_id)).filter((id) => id > 0).sort((a, b) => a - b);
  const errors = [];
  if (!Array.isArray(characterVisuals)) errors.push('character_visuals 必须由 Agent 显式输出为数组，无人镜头输出 []，不能省略或填 null');
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    errors.push(`character_visuals 角色 ID 必须精确为 ${JSON.stringify(expected)}，实际为 ${JSON.stringify(actual)}`);
  }
  const policy = String(shot?.semantic_slots?.last_frame_policy || 'none');
  if (policy === 'generate_tail' && !Array.isArray(lastFrameVisuals)) errors.push('需要尾帧时 last_frame_visuals 必须由 Agent 显式输出为数组');
  const lastIds = (Array.isArray(lastFrameVisuals) ? lastFrameVisuals : [])
    .map((item) => Number(item?.character_id)).filter((id) => id > 0).sort((a, b) => a - b);
  if (policy === 'generate_tail' && JSON.stringify(lastIds) !== JSON.stringify(expected)) {
    errors.push(`last_frame_policy=generate_tail 时 last_frame_visuals 必须覆盖 ${JSON.stringify(expected)}`);
  }
  if (policy !== 'generate_tail' && lastIds.length) errors.push(`last_frame_policy=${policy} 时 last_frame_visuals 必须为空数组`);
  return errors;
}

async function ensureDirectorCharacterVisuals(db, log, shot, retryOptions = {}) {
  const retry = directorRetryContext(retryOptions);
  let errors = visualSlotErrors(shot, shot.character_visuals, shot.last_frame_visuals);
  if (errors.length === 0) return shot;
  for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
    let planned;
    try {
      planned = await agentsRuntime.runAgent(db, log, {
        name: 'director-character-visuals-planner',
        instructions: `你是短剧导演的人物定格构图节点。只输出当前镜头的 character_visuals 和 last_frame_visuals，不得改写剧情、人物清单、场景、台词、时长或视频模式。每个角色必须给出明确的纵深层级、屏幕位置、环境依托、身体朝向、面部表情、头部姿态、视线落点、体态重心、双手动作、道具接触和服装细节。描述静止定格状态，禁止“然后、随后、开始、走到、跑向”。每个字段一句话，简洁具体。起幅取事件发生前的状态；需要尾帧时依据本镜 result 与已规划终态定格，不能直接照抄起幅。\n${DIRECTOR_ACTION_COMPLETION_CONTRACT}`,
        input: `【当前完整分镜，只读】${JSON.stringify(shot)}\n【必须覆盖的角色 ID】${JSON.stringify(directorCharacterIds(shot))}\n【上一轮门禁反馈】${errors.join('；')}`,
        outputType: agentsRuntime.directorCharacterVisualsOutputType(),
        maxTokens: 24576,
        temperature: 0.2,
      });
    } catch (error) {
      errors = [`人物定格 Agent 输出格式失败：${error.message}`];
      reportDirectorLayerRetry(retry, `分镜 #${shot.shot_number} 人物定格`, attempt, errors[0]);
      continue;
    }
    errors = visualSlotErrors(shot, planned?.character_visuals, planned?.last_frame_visuals);
    if (errors.length === 0) return { ...shot, character_visuals: planned.character_visuals, last_frame_visuals: planned.last_frame_visuals };
    reportDirectorLayerRetry(retry, `分镜 #${shot.shot_number} 人物定格`, attempt, errors.join('；'));
  }
  throw new Error(`分镜 #${shot.shot_number} 的人物定格经过 ${retry.maxAttempts} 轮门禁反馈仍未通过：${errors.join('；')}`);
}

async function ensureDirectorVideoSlots(db, log, shot, retryOptions = {}) {
  const retry = directorRetryContext(retryOptions);
  const semantic = shot?.semantic_slots && typeof shot.semantic_slots === 'object' ? shot.semantic_slots : {};
  const duration = Number(semantic.shot_duration || shot.duration || 5);
  const durationPlans = validTimelineDurationPlans(duration);
  const durationPlanContract = timelineDurationPlanContract(duration);
  let errors = shot.video_slots && typeof shot.video_slots === 'object'
    ? shortDramaTimelineViolations(shot, shot.video_slots.shots_timeline)
    : [{ message: '缺少 video_slots，必须由视频槽位 Agent 完整规划' }];
  if (shot.video_slots && Math.abs(Number(shot.video_slots?.timing?.duration || 0) - duration) > 0.1) {
    errors.push({ message: `video_slots.timing.duration 必须等于权威时长 ${duration} 秒` });
  }
  if (errors.length === 0) return shot;

  for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
    let planned;
    try {
      planned = await agentsRuntime.runAgent(db, log, {
        name: 'director-video-slots-planner',
        instructions: `你是短剧导演的视频执行槽位节点。只输出当前镜头的完整 video_slots，不得改写剧情、人物清单、人物定格、场景、台词、总时长或 H3 模式。timing.duration 必须等于权威总时长；shots_timeline 必须拆成连续的 1 或 2 个整数秒动作段，总和精确等于权威总时长，禁止一个完整大段。${durationPlanContract}。由你根据剧情节拍选择其中一个合法数组，并按原顺序逐项写入各段 duration。每段先写 camera 和 visible_characters（本段实际入画的人物；特写、过肩或画外音可只列当前可见人物），character_trajectories 必须且只能覆盖 visible_characters。每段是独立可执行的时间合同：action、result 以及每位画内角色的 trajectory 必须描述该时间段实际发生的动作、互动或事件反应，并由窗口和终态承接；禁止用“说完后互相看着、保持不动、等待”填满任何剩余时间。每位当前画内角色在该段都要有可见的身体动作、表情变化或因果反应；不在画面的角色不写视觉轨迹。安静倾听必须与具体反应同步，不能成为独立静止段。两人对白优先在有信息变化的段落使用正反打或过肩反打，不能把视线本身当作动作。每个文字字段不超过 120 个汉字，可写出连续动作阶段，禁止解释和重复。\n${DIRECTOR_ACTION_COMPLETION_CONTRACT}`,
        input: `【权威总时长】${duration} 秒\n【合法时长组合】${JSON.stringify(durationPlans)}\n【权威人物】${JSON.stringify(semantic.visible_characters || [])}\n【权威台词】${JSON.stringify(semantic.speech_plan || {})}\n【当前完整分镜，只读】${JSON.stringify(shot)}\n【上一轮门禁反馈】${errors.map((item) => item.message).join('；')}`,
        outputType: agentsRuntime.directorVideoSlotsOutputType(duration),
        maxTokens: 24576,
        temperature: 0.2,
      });
    } catch (error) {
      errors = [{ message: `视频槽位 Agent 输出格式失败：${error.message}` }];
      reportDirectorLayerRetry(retry, `分镜 #${shot.shot_number} 视频槽位`, attempt, errors[0].message);
      continue;
    }
    const videoSlots = planned?.video_slots;
    errors = shortDramaTimelineViolations({ ...shot, video_slots: videoSlots }, videoSlots?.shots_timeline);
    if (Math.abs(Number(videoSlots?.timing?.duration || 0) - duration) > 0.1) {
      errors.push({ message: `video_slots.timing.duration 必须等于权威时长 ${duration} 秒` });
    }
    if (errors.length === 0) return { ...shot, video_slots: videoSlots };
    log.warn('[导演Agent] 视频槽位未通过门禁，退回视频槽位 Agent', { shot_number: shot.shot_number, attempt, violations: errors });
    reportDirectorLayerRetry(retry, `分镜 #${shot.shot_number} 视频槽位`, attempt, errors.map((item) => item.message).join('；'));
  }
  throw new Error(`分镜 #${shot.shot_number} 的视频槽位经过 ${retry.maxAttempts} 轮门禁反馈仍未通过：${errors.map((item) => item.message).join('；')}`);
}

// Generate framing and the execution timeline together. They are two views of
// the same performance and should not be planned by independent agents.
async function ensureDirectorExecutionSlots(db, log, shot, retryOptions = {}) {
  const retry = directorRetryContext(retryOptions);
  const semantic = shot?.semantic_slots && typeof shot.semantic_slots === 'object' ? shot.semantic_slots : {};
  const duration = Number(semantic.shot_duration || shot.duration || 5);
  const durationPlanContract = timelineDurationPlanContract(duration);
  let errors = [
    ...visualSlotErrors(shot, shot.character_visuals, shot.last_frame_visuals).map(message => ({ message })),
    ...(shot.video_slots && typeof shot.video_slots === 'object'
      ? shortDramaTimelineViolations(shot, shot.video_slots.shots_timeline)
      : [{ message: '缺少 video_slots，必须与人物定格和动作时间轴一起规划' }]),
  ];
  if (shot.video_slots && Math.abs(Number(shot.video_slots?.timing?.duration || 0) - duration) > 0.1) {
    errors.push({ message: `video_slots.timing.duration 必须等于权威时长 ${duration} 秒` });
  }
  if (errors.length === 0) return shot;

  for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
    try {
      const planned = await agentsRuntime.runAgent(db, log, {
        name: 'director-execution-slots-planner',
        instructions: `你是短剧导演的视听执行合同节点。只输出当前镜头的 character_visuals、last_frame_visuals 和 video_slots，禁止改写剧情、角色清单、场景、台词、总时长或 H3 模式。人物定格槽位和镜内时间轴必须描述同一套物理动作与终态：character_visuals 是起幅定格，last_frame_visuals 是明确要求尾帧时的落幅定格；video_slots.shots_timeline 是唯一的动作、对白和反应时间轴权威。${durationPlanContract}。每个 1 或 2 秒段都要先写 camera 与 visible_characters，再为每位入画人物写 trajectory、terminal_pose、facial_expression、facing、head_pose、gaze、attention_target、gaze_motivation、reaction_trigger、mouth_state。含对白段必须在同一段 speech_action_alignment 中写 speech_window、speaker_action_window、speaker_action 和 listener_reactions，动作窗口必须与发声窗口重叠；不能把动作、听取反应或视线留到说完以后。无语言段按实际声音模式填写闭口状态。不要重复输出顶层剧情字段，不要解释，只返回指定 JSON。\n${DIRECTOR_ACTION_COMPLETION_CONTRACT}`,
        input: `【权威时长】${duration} 秒\n【权威人物】${JSON.stringify(semantic.visible_characters || [])}\n【权威台词】${JSON.stringify(semantic.speech_plan || {})}\n【当前完整分镜，只读】${JSON.stringify(shot)}\n【上一轮执行合同反馈】${errors.map(item => item.message).join('；')}`,
        outputType: agentsRuntime.directorExecutionSlotsOutputType(duration),
        maxTokens: 24576,
        temperature: 0.2,
      });
      const nextShot = { ...shot, character_visuals: planned?.character_visuals, last_frame_visuals: planned?.last_frame_visuals, video_slots: planned?.video_slots };
      errors = [
        ...visualSlotErrors(nextShot, nextShot.character_visuals, nextShot.last_frame_visuals).map(message => ({ message })),
        ...shortDramaTimelineViolations(nextShot, nextShot.video_slots?.shots_timeline),
      ];
      if (Math.abs(Number(nextShot.video_slots?.timing?.duration || 0) - duration) > 0.1) {
        errors.push({ message: `video_slots.timing.duration 必须等于权威时长 ${duration} 秒` });
      }
      if (errors.length === 0) return nextShot;
      reportDirectorLayerRetry(retry, `分镜 #${shot.shot_number} 视听执行合同`, attempt, errors.map(item => item.message).join('；'));
    } catch (error) {
      errors = [{ message: `视听执行合同 Agent 输出格式失败：${error.message}` }];
      reportDirectorLayerRetry(retry, `分镜 #${shot.shot_number} 视听执行合同`, attempt, errors[0].message);
    }
  }
  throw new Error(`分镜 #${shot.shot_number} 的视听执行合同经过 ${retry.maxAttempts} 轮门禁反馈仍未通过：${errors.map(item => item.message).join('；')}`);
}

/**
 * 运行影视导演智能体，完成从剧本/资产到高精分镜的闭环推演
 * @param {object} db - SQLite 数据库
 * @param {object} log - 日志记录器
 * @param {object} cfg - 全局配置
 * @param {number|string} episodeId - 剧集 ID
 * @param {object} [options] - 选项 (storyboardCount, premise, forceExtractEntities)
 * @returns {Promise<{ storyboards: Array, audit: object, semantic_revision: string }>}
 */
async function runDirectorAgent(db, log, cfg, episodeId, options = {}, progressCallback = null) {
  const epId = Number(episodeId);
  const onProgress = typeof options.onProgress === 'function'
    ? options.onProgress
    : (typeof progressCallback === 'function' ? progressCallback : () => {});
  const maxReflectionRounds = Math.max(1, Math.min(500, Number(
    options.maxReflectionRounds || options.max_reflection_rounds || 500
  )));

  log.info('[导演Agent] 启动剧集视听本体调度', { episode_id: epId });
  onProgress(5, '启动剧集视听本体调度，准备解析剧本...');

  // 确保 storyboards 具有 dialogue_framing, character_visuals, last_frame_visuals, video_slots 槽位列
  try {
    const cols = db.prepare('PRAGMA table_info(storyboards)').all().map(c => c.name);
    if (!cols.includes('dialogue_framing')) {
      db.prepare('ALTER TABLE storyboards ADD COLUMN dialogue_framing TEXT').run();
    }
    if (!cols.includes('character_visuals')) {
      db.prepare('ALTER TABLE storyboards ADD COLUMN character_visuals TEXT').run();
    }
    if (!cols.includes('last_frame_visuals')) {
      db.prepare('ALTER TABLE storyboards ADD COLUMN last_frame_visuals TEXT').run();
    }
    if (!cols.includes('video_slots')) {
      db.prepare('ALTER TABLE storyboards ADD COLUMN video_slots TEXT').run();
    }
    if (!cols.includes('long_take_group_id')) {
      db.prepare('ALTER TABLE storyboards ADD COLUMN long_take_group_id TEXT').run();
    }
    if (!cols.includes('long_take_role')) {
      db.prepare('ALTER TABLE storyboards ADD COLUMN long_take_role TEXT').run();
    }
    if (!cols.includes('long_take_sequence')) {
      db.prepare('ALTER TABLE storyboards ADD COLUMN long_take_sequence INTEGER').run();
    }
    if (!cols.includes('start_framing')) {
      db.prepare('ALTER TABLE storyboards ADD COLUMN start_framing TEXT').run();
    }
    if (!cols.includes('end_framing')) {
      db.prepare('ALTER TABLE storyboards ADD COLUMN end_framing TEXT').run();
    }
    if (!cols.includes('transition_to_next')) {
      db.prepare('ALTER TABLE storyboards ADD COLUMN transition_to_next TEXT').run();
    }
    if (!cols.includes('background_characters')) {
      db.prepare('ALTER TABLE storyboards ADD COLUMN background_characters TEXT').run();
    }
  } catch (_) {}

  const epRow = db.prepare('SELECT id, drama_id, script_content, title, duration FROM episodes WHERE id = ? AND deleted_at IS NULL').get(epId);
  if (!epRow) throw new Error('剧集不存在');
  const dramaId = epRow.drama_id;
  const metadataRow = db.prepare('SELECT metadata FROM dramas WHERE id = ?').get(dramaId);
  const projectMetadata = require('../services/narrativeStyleService').parse(metadataRow?.metadata);
  const requestedPacing = pacing.constraints(options, projectMetadata);
  requestedPacing.tts_speed = require('../services/speechDeliveryService').configuredTtsSpeed(db, projectMetadata);

  // 阶段零：故事与分集剧本创编（若提供了梗概 premise 或原剧本为空）
  let scriptContent = (epRow.script_content || '').trim();
  if (options.premise || !scriptContent) {
    onProgress(10, '根据故事梗概推演剧本戏剧冲突与正文...');
    log.info('[导演Agent] 阶段零：根据故事梗概推演剧本戏剧冲突与正文...', { episode_id: epId });
    const premiseText = (options.premise || epRow.title || '精彩短剧').trim();
    const dramaRow = db.prepare('SELECT title, genre, style FROM dramas WHERE id = ?').get(dramaId) || {};
    const scriptPrompt = `你是一位院线级短剧导演兼总编剧。
请为短剧《${dramaRow.title || '短剧'}》（题材：${dramaRow.genre || '剧情'}，风格：${dramaRow.style || '写实'}）撰写第 ${epRow.title || '1'} 集的完整拍摄剧本。

【故事大纲 / 梗概】：
${premiseText}

【编剧要求】：
1. 包含核心戏剧冲突与转折，剧情节奏紧凑，扣人心弦。
2. 关键动机、选择、规则、阻碍、后果和转折必须让观众通过角色对白或必要旁白直接听懂；不能只用人物表情、道具、镜头运动或环境变化暗示关键剧情。
3. 对白和动作必须服务同一因果事件，人物说话时同步执行相关动作或反应；不要写“说完后无事可做”的空镜，也不要为了填字数重复同一信息。
4. 同一空间内允许连续完成多个紧密动作，只有说话人/场景/时间/轴线变化或真实时长超限才拆开，避免一个动作一个镜头造成拖沓。
5. 包含清晰的角色对白与动作描写。
6. 纯正剧本格式，约 600-1000 字。`;

    const generatedScript = await agentsRuntime.runAgent(db, log, {
      name: 'director-screenwriter',
      instructions: '你是一位专业影视导演兼编剧。',
      input: scriptPrompt,
      maxTokens: 3000,
      temperature: 0.7,
    });
    if (generatedScript && generatedScript.trim()) {
      scriptContent = generatedScript.trim();
      db.prepare('UPDATE episodes SET script_content = ?, updated_at = ? WHERE id = ?').run(scriptContent, new Date().toISOString(), epId);
      log.info('[导演Agent] 阶段零：剧本推演完成并持久化', { length: scriptContent.length });
    }
  }

  if (!scriptContent || !scriptContent.trim()) {
    throw new Error('剧本为空，无法执行导演分镜推演');
  }

  // 阶段一：世界观资产自动统一抽取（角色外貌锚点、道具真实物理尺寸、场景空间地标）
  const existingChars = db.prepare('SELECT id FROM characters WHERE drama_id = ? AND deleted_at IS NULL').all(dramaId);
  const existingScenes = db.prepare('SELECT id FROM scenes WHERE drama_id = ? AND deleted_at IS NULL').all(dramaId);

  let extractedAssets = null;
  if (options.forceExtractEntities || existingChars.length === 0 || existingScenes.length === 0) {
    onProgress(20, '自动抽取全量世界观实体资产（角色、道具真实尺度、场景地标）...');
    log.info('[导演Agent] 阶段一：自动抽取全量世界观实体资产（角色、道具真实尺度、场景地标）...', { drama_id: dramaId, episode_id: epId });
    extractedAssets = await extractAllEntitiesFromScript(db, log, cfg, epId);
  }

  // 阶段二：编译不可变剧目语义包（Semantic Package）
  onProgress(30, '编译不可变剧目语义包与镜头时长预算...');
  const semPkg = compileDramaSemanticPackage(db, epId);
  const checkpoint = directorCheckpoint.open(db, options.taskId, epId, cfg, options, options.resume_task_id);
  const working = checkpoint.state;
  const saveStage = (stage) => { working.stage = stage; checkpoint.save(); };

  onProgress(35, '导演正在根据完整剧情、台词与动作规划镜数和总时长...');
  const pacingPlan = working.pacingPlan || await pacing.planEpisodePacing(db, log, scriptContent, requestedPacing, { maxAttempts: maxReflectionRounds, onProgress });
  working.pacingPlan = pacingPlan;
  saveStage('节奏规划完成');
  const targetCount = pacingPlan.total_shots;
  const targetDuration = pacingPlan.total_duration;
  // The old episode duration is an output from previous runs, not a new constraint.
  semPkg.episode.duration_target = targetDuration;
  const singleShotDuration = Math.round(targetDuration / targetCount);
  const outputTokenBudget = directorOutputTokenBudget(targetCount);
  const universalOmni = options.universal_omni_storyboard === true
    || options.universalOmniStoryboard === true
    || options.universal_omni_storyboard === 1
    || String(options.universal_omni_storyboard || '').toLowerCase() === 'true';

  // 2. 组织具有本体约束的导演推演提示词
  const userDirectives = (options.userDirectives || options.directives || options.feedback || '').trim();
  const directiveSection = userDirectives
    ? `\n【用户导演最新指导与调整记忆（最高优先级执行，必须严格遵从）】：\n${userDirectives}\n`
    : '';
  const universalPlanningSection = universalOmni
    ? `
【用户已勾选全能分镜模式——这是本轮导演规划的最高优先级输入约束】
1. 每个独立分镜和每个拆分后的分镜都必须按 H3 Ref2VA 多参考方案规划：semantic_slots.h3_mode="ref2va"，first_frame_policy 与 last_frame_policy 均为 "none"，无需生成首尾帧。导演 Agent 不得规划 FL2VA、long_take_continuation、inherit_tail 或任何自动首尾帧接力；FL2VA 只允许用户在分镜生成后手动覆盖执行模式。
2. Ref2VA 的 semantic_slots.required_references 必须由你按剧情选择并排序：第 1 项必须是当前 scene_id 对应的 scene；随后依次列出所有画内主体与背景角色的 character；最后仅列核心交互 prop。总数不得超过 9，禁止后端替你补素材。
3. 每个分镜必须输出 creation_mode:"universal" 和非空 universal_segment_text。universal_segment_text 中的 @图片N 必须与 required_references 的数组顺序严格一一对应，@图片1 永远是场景参考。
4. 全能分镜不是额外生成一套互相矛盾的剧情：universal_segment_text、video_slots、semantic_slots、dialogue、narration 必须表达同一个镜头、相同台词、相同时长与镜内节拍。
${promptI18n.getStoryboardUniversalOmniModeSuffix(cfg)}
`
    : '';

  const systemPrompt = `你是一位严谨的院线级短剧导演与场面调度摄影指导（Cinematographer & Director Agent）。
你必须依据提供的【不可变剧目本体世界观与实体资产】，将剧本拆解为富有电影流动感的专业分镜。

${semPkg.getSystemDigest()}
${directiveSection}
${DIRECTOR_ACTION_COMPLETION_CONTRACT}
【导演核心视听铁律（必须遵守，违反将被质检打回）】：
1. **按剧情决定运镜与切镜**：固定机位与连续固定镜头均可用，但 H3 的 shots_timeline 必须用连续 1～2 秒窗口约束动作。完整对白可以属于同一个外层分镜，但不能由一个大时间段承载；每个窗口先写本段 camera 和 visible_characters，再只为实际入画的人物写动作、表情或因果反应。特写、过肩和画外音可以只列当前可见人物；未入画人物不写视觉轨迹。只在剧情信息、视角或反应需要时使用正反打；静止互看、无意义特写和空等不算动作。所有状态变化必须有剧情依据。
2. **多模态音频设计**：
   - 有台词分镜：bgm_prompt 填空串""，保障说话人声与口型清晰；
   - 无语言但需要环境声/动作音：audio_lip_sync 必须为 silent_ambient，bgm_prompt 必须为空，可填写 sound_effects；
   - 无语言且只需要配乐：audio_lip_sync 必须为 bgm_only，只填写纯器乐 bgm_prompt，sound_effects 必须为空；
   - 真正完全静音：sound_plan.is_silent 必须为 true，台词、旁白、BGM、环境音和动作音全部为空；
   - 上述三种无语言模式中，顶层 dialogue/narration、semantic_slots.speech_plan.text、video_slots.audio_lip_sync.dialogue_content 必须全部为空；video_slots.trajectories 与每个 shots_timeline.character_trajectories 的 mouth_state 必须明确为“双唇紧闭无口型”。
3. **H3 视频生成物理硬约束与智能拆镜（适配 H3 模型 9 张参考图物理上限）**：
   - **模型物理上限为 9 张参考图**：MiniMax H3 单镜头输入包含：首尾帧锚点（至多2张）+ 场景图（1张）+ 角色人设图（每人1张）+ 道具图（每件1张）。一旦超出 9 张或单镜要素过多，模型将严重变形、崩溃或报错！
   - **单镜出场角色严格限制在 1～2 人**：绝不可把 3 个及以上角色塞入同一个分镜！遇多人交互场景，**必须主动拆镜**为正反打镜头序列（如：镜1「角色A动作中景」➔ 镜2「角色B反应特写/反打」➔ 镜3「角色C介入动作」）。
   - **单镜核心交互道具严格限制在 1 件**（至多不超过 2 件）：每个分镜只能聚焦 1 个核心交互道具（如拔枪、递药、看屏幕）。无实质物理交互的静态背景物件不作为道具挂载，**严禁在一个镜头中挂载 3 件以上道具**！
   - **按连贯事件规划，不按动作个数拆镜**：单个 4~8 秒分镜可以包含多个连续或同时发生的动作、对白和人物反应。例如边说话边走近、伸手搀扶、对方借力坐起，可在同镜完成。不得把一句对白、一个动作、一个反应机械拆成独立分镜。仅当实际台词和事件超出时长、场景或造型变化、或剧情确需独立视角时拆镜；保持动作因果与空间关系清晰，不添加停顿来凑时长。
   - **短剧镜内剪辑节奏**：每个外层分镜在 video_slots.shots_timeline 中必须规划连续的 1 或 2 个整数秒动作段，总和精确等于本镜4～8秒时长（例如 0–1、1–2、2–4 秒）。每段先声明本段 camera 和 visible_characters，再约束每个实际入画角色在该窗口内的动作、表情或因果反应；特写、过肩和画外音可以只列当前可见人物，未入画人物不写视觉轨迹。不得用一个完整大段、静态机位、无意义特写或安静互看填时长。正反打只在信息、反应或权力变化发生时切换。
   - **同步视听事件（必须）**：video_slots.performance_contract 必须为 "sync_v1"。每个含对白的 shots_timeline 段必须填写 speech_action_alignment：mode="concurrent"、speech_window、speaker_action_window、speaker_action，以及每个其他画内角色的 listener_reactions。动作时间必须与发声时间重叠；不要把动作默认写成“台词说完后再做”。说话者边说边转身、抬手、操作或改变视线，听者在同一时间段边听边看、回应或操作。刻意停顿才使用 deliberate_pause，并填写 pause_reason。无对白段使用 mode="none"。
   - **正反打是镜内语言，不是机械拆镜规则**：两人对话可在同一外层分镜的 shots_timeline 中使用正反打/过肩反打段落；只有信息交接、权力变化、关键反应或空间轴线确实改变时才新建外层分镜。禁止把“说一句话—两人互相看着—结束”当作剧情动作。台词结束后的每一秒都必须有剧本依据（扶起、递物、阻拦、受伤反应、移动、环境突发等）；没有依据就缩短到本镜实际事件结束，不要虚构相互凝视、无意义特写或等待来填满时长。
4. **场面调度与 Z 轴纵深站位法则（Cinematic Blocking & Z-Axis Depth）**：
   - **严禁双人/多人扁平横向并排贴立**：短剧最忌讳像贴纸一样把多个人平排在同一条水平线上（只有左右而无前后远近）！
   - **多人同框必须确立立体 Z 轴远近关系（前后层级交错）**：
     * **经典过肩/对峙构图 (OTS / Depth Duel)**：一人位于前景近处（如“画面左侧前景近景，背向镜头或四分之三侧背姿，虚化过肩形成视觉引线”），另一人位于中景清晰处（如“画面右侧中景，正面面对镜头，神态细节尽收眼底”）；
     * **主次战术掩护/前后梯次 (Staggered Layering)**：当前台词/动作核心人物处于中景主体位（如“画面中央中景前倾”），支援/掩护/聆听角色处于后景纵深处（如“画面右后方后景约3米处通道掩体旁持枪警戒”）；
     * **斜角纵深透视 (Diagonal Staging)**：一前一后形成空间对角线，强化景深虚化与电影感三维透视，彻底打破二维平面感！
5. **纯物理视觉描写**：严禁心理修辞与文学隐喻（如“焦急凝结”、“高低对照”），只写可见姿态与光影。
6. **生图定格与 H3 视频槽位的绝对区分**：
   - video_slots 描述时间流逝、运镜推拉、动作发生全过程（如“从A走到B，按下肩膀，随后转头”）。
   - 图片提示词（image_prompt）必须是【首帧决断时刻的纯静态画面定格摄影描写（Freeze-frame photo）】：
     a. **严禁视频化时序动态与过程动词**：绝对禁止出现“看了一眼”、“沿...走到...”、“开始转向”、“突然扑向”、“随后”等动态叙事词！必须转化为定格姿态（如：“蜂医沿掩体走到露娜右侧按下肩膀” ➔ 必须写成：“蜂医半蹲停在露娜右侧，单手按在露娜肩头，两人身体压低隐蔽在掩体后”；“快速向右侧岔路看了一眼” ➔ 必须写成：“头偏向右侧，目光警戒地注视着右侧岔路口”）。
     b. **严禁抽象或残缺姿态**：绝对禁止只写人物名字或“某某身体”！遇到动态失衡（如“失去平衡”），必须明确具体定格姿态（如“身体大幅向侧方倾斜失衡，单手伸出撑向地面，重心向下滑落的惊险定格瞬间”）。
     c. **静态构图三要素必须完整**：
        - 躯干重心与体态（站立/深蹲/半蹲/单膝跪姿/身体前倾30度/侧身靠墙）；
        - 四肢与双手动作（双手搭在键盘上/单手按住掩体/右手紧握武器/单手按住对方肩膀）；
        - 头部角度与视线朝向（侧头注视右侧/目光紧盯屏幕/双眼戒备注视通道）。
7. **台词时长硬预算与强制语义拆镜（Speech Timing Budget & Atomic Split）**：
   - 人物对白与旁白的台词截止点按实际 TTS 语音时长和镜内时间轴决定：以中文约4字/秒、英文约2.5词/秒的自然基准乘以实际 TTS speed（IndexTTS 未配置时默认1.25x，其他引擎按配置）。不预留固定收尾，不删字，不由 Agent 自行改变语速。说话与动作同步规划，台词结束处应到达事件终态或继续执行已规划的剧情动作。
   - 镜头时长预算必须按实际 TTS speed 动态计算，不得套用固定的 4秒/10字、5秒/14字等静态表格；IndexTTS 未配置时按1.25x，其他引擎按配置。
   - **绝对禁止在一个镜头内塞入超出时长预算的冗长对白或旁白！**
   - **长台词必须拆镜**：遇长台词或包含多句话的对白，必须在标点符号（逗号/句号/感叹号）处主动切分拆解为 2 个以上连续分镜（如正反打镜头：前一句配说话人动作，后一句切听者反应特写或说话人进一步动作承接）；
   - **禁止删改剧本台词**：拆镜时必须逐字完整保留原剧本对白与说话人，按顺序分配到拆解后的各分镜中，不允许缩写、偷换或通过强行加速说话来逃避拆镜！
8. **角色与生图构图五层视听矩阵（Cinematic Visual Slots Matrix）**：
   - **杜绝模板式假槽位套话**：严禁出现“身体保持戒备低姿，重心稳固隐蔽”、“双手紧握装备保持待发状态”、“目光专注注视前方”等万能模板套话！必须根据该分镜的【剧本具体动作、场景空间反差与人物生理微状态】进行具象定格描写！
   - **单镜五维视听构图槽位**：
     * environment_depth: 空间三层纵深（必须明确：前景虚化遮挡物、中景主体物理接触地表/构件、背景视线尽头材质与灭点透视；如“前景右下角虚化遮挡着锈蚀钢架，中景地表散落碎石与断裂线缆，背景纵深处是雨水横流的防爆玻璃窗与闪烁微弱绿色荧光的故障控制台”）
     * lighting_chiaroscuro: 影视打光与影调质感（主光方向、轮廓光/侧逆光、局部冷暖发光、高反差阴影；如“自破损天窗斜射而入的硬质冷白天光，右侧荧光屏在人物面颊勾勒出幽蓝侧轮廓光，伴随深重电影级侧影暗部”）
     * cinematic_lens: 电影镜头光学参数（如“35mm宽银幕电影镜头抓拍，f/2.8浅景深焦外散景，微弱柯达35mm胶片颗粒质感”）
     * character_visuals 内部强类型槽位（出场角色必须填写）：
       - character_id: 角色ID
       - name: 角色名字
       - depth_layer: 画面纵深层级【极其重要】（必须明确：foreground 前景近处 / midground 中景主体 / background 后景远处）
       - screen_position: 画面构图位置与远近前后站位【极其重要】（必须同时交代【横向X轴】与【纵深Z轴远近】，如：画面左侧前景近景过肩 / 画面右侧中景正对 / 画面右后方后景深处。多人同框严禁在同一水平横轴并排贴立，必须一前一后构建远近层次！）
       - environmental_anchor: 物理环境依托（低矮断墙后 / 实木书桌前 / 走廊转角掩体）
       - facing: 人物朝向（必须明确：正面面对镜头 / 背向镜头 / 侧身朝向画面左侧 / 侧身朝向画面右侧 / 侧向四分之三面朝左 / 侧向四分之三面朝右）
       - expression: 面部微表情与神态（如：咬肌紧绷、瞳孔微聚盯防、下颌微收、冷峻警惕、嘴角抿直）
       - head_pose: 头部姿态（头部正对前方 / 头部微仰 / 低头咬牙 / 侧头偏向右侧 / 侧头偏向左侧 / 转头回望）
       - gaze: 目光视线落点（双眼紧盯前方冷光屏幕 / 目光警惕锁定高窗火力点 / 视线锁定右侧岔路）
       - posture: 躯干体态与重心（必须结合剧本写实，禁止套话：如“双膝跪地双手撑在碎石地上” / “身体前倾靠在控制台边缘”）
       - hands: 双手具体四肢定格（必须结合具体动作与接触点）
       - prop_interaction: 手指与道具具体的物理接触点（如：食指扣在磨砂黑战术终端侧键边缘，拇指悬停在确认键上方）
       - appearance_details: 服装质感与生理状态（如：额角渗出的细密冷汗与被汗浸湿贴在前额的凌乱碎发、粗糙抗撕裂战术背心上的泥渍刮擦）
   - 槽位中严禁出现“从A到B”、“跑向”、“走到”、“随后”、“看了一眼”等动态时序过程词，文生图模型会将两地各画一人产生克隆分身！必须是首帧决定性瞬间的纯静态摄影描写！
9. **连贯长镜头结构化拆解与接力规范（Long Take Relaying & Sequential Splitting）**：
   - **适用情境**：影视短剧中，连续动作追逐、长走廊/房间连续漫游、连贯推移跟拍等大段无切机位的视听情境。因 AI 视频模型单镜仅能生成 4~8 秒，必须将长镜头拆分为多个连续子镜头（如镜头2~5）。
   - **长镜头拆分**：长动作或长台词需要拆分时，每个新分镜都是独立 Ref2VA 镜头，必须重新列出 required_references，first_frame_policy 与 last_frame_policy 均为 "none"。long_take_group_id、long_take_role、long_take_sequence 全部填 null；不得由 Agent 规划 FL2VA、inherit_tail 或自动尾帧接力。
   - **拆分镜头的动线合同**：每个独立 Ref2VA 镜头必须在 continuity_from_previous、start_framing 和 action 中明确写出上一镜落幅如何触发本镜开幅；这只描述剧情与空间承接，不代表自动继承上一镜视频尾帧。

10. **视听语言视线轴线铁律（字典仅供参考启发，严禁面向镜头直视空气说话）**：
    对话场景中角色绝对禁止双双正面直视摄影机对着空气说话！建议参考 dialogue_framing 建立视线交汇闭环（【重要：字典选项仅供启发参考，不是必须填这些固定值！你完全可以根据剧本情节自由给出更精准、生动的构图描述】）：
    - 常见参考模式：two_shot_face_to_face (双人面对面对视中景)、over_the_shoulder (经典过肩拍 OTS)、single_reaction_offscreen (单人近景目光看画外)、joint_observation (双人同向观察)、solo_action (单人动作无对话)，或任何贴合剧情的自定义构图。
    - 每个镜内段都必须为每位画内角色明确 reaction_trigger、attention_target、head_pose 和 gaze。突发咳嗽、吐血、拔刀、摔落或发光等可见事件发生后，关联角色必须在当拍把头部和视线转向事件源，不得继续保持上一拍的无关视线。
    - 画内直接对话默认建立说话人与受话人面部之间的视线轴。若剧情需要角色故意看米袋、血迹、手腕或其他物体，必须在 gaze_motivation 写明剧情原因，不得以“看向前方”“保持专注”等模糊描述代替。

11. **场景空间全员在场法则（Scene Ensemble & Co-Presence，彻底杜绝角色突兀降临）**：
    - **场景空间全员在场确立**：一个场景空间内（如书房、指挥室、客厅、工位），若剧情设定有特定几名角色在场（例如书房里有奕宸、妹妹、妈妈三个人），**他们自该场景建立起便物理恒常在场**！
    - **主体人物 vs 背景在场人物分层**：
      * **核心主体人物 (focal characters)**：处于前景/中景，负责本镜头的台词发声或核心动作（单镜 1~2 人）；
      * **背景在场人物 (background_characters)**：同处该空间但在本镜头不负责发声/主动作的其他角色。**必须在构图与提示词中维持在场（后景景深、做自己的事、双唇紧闭严禁口型）**！
      * **严禁人物突然凭空降临 (Zero Sudden Pop-in)**：
        绝不能前几镜只画单人空房间，等到某角色说话时才突然凭空从虚空刷新出来！
        必须在前序镜头的景深背景中交代其在场（如：“后景书架旁，妹妹正坐在书桌前低头翻看作业本，若隐若现”），或该角色在本镜必须有明确的入场动作（如“推开房门走入书房”）。
    - **数据结构输出**：
      * background_characters: 数组，填写本镜中处于背景的在场角色（如 [{"character_id": 2, "name": "妹妹", "depth_layer": "background", "screen_position": "画面右后方景深处书架旁", "activity": "低头安静翻看作业本", "mouth_state": "双唇紧闭，无台词口型，后景虚焦"}]）；无背景角色填 []。
      * character_visuals 内部：出场角色（主体 + 背景角色）总计不超过 3 人，背景角色必须指定 depth_layer: "background"。

12. **单镜头时序运动弧线（起幅态 ➔ 动作推进 ➔ 落幅态）与镜头过渡法则（Shot Arc & Transitions）**：
    - 每个分镜必须是一个具备开端、演进、定格与衔接的完整视听单元：
      * start_framing（起幅态）：机位从何处开始、画面初始构图与画内人物初始定格体态（例如：“起幅：中景俯拍，奕宸双手飞快敲击键盘，屏幕冷光照在其专注面孔上；后景书架旁，妹妹正低头写作业”）；
      * action（动作时序推进）：主体发生的具体物理动作与时序推进；
      * end_framing（落幅态）：镜头结束时的定格画面，为下一镜头提供明确的视觉承接锚点（例如：“落幅：镜头推至奕宸后背半身特写，手指悬停键盘，目光向右侧转动；焦点平滑拉至景深背景中正在起身的妹妹，为下镜做视线引导”）；
      * transition_to_next（与下一镜过渡类型及承接说明）：
        - "eyeline_match": 顺接上一镜头角色的视线落点（如：“顺接上一镜头奕宸向右侧偏头的视线，本镜头切至右侧书桌前的妹妹”）；
        - "match_cut": 动作匹配切（上一镜头伸手端杯，下一镜头接茶杯离桌特写）；
        - "rack_focus": 景深焦点拉移（从前景主体拉焦到后景人物）；
        - "ots_reverse": 经典过肩正反打对峙；
        - "continuous_tracking": 镜头连续推移跟拍（或长镜头接力）；
        - "cut": 普通切机位。
      * semantic_slots.continuity_from_previous（本镜如何接入上一镜）：除第1镜外必须填写 relationship、previous_end_state、entry_state、causal_link；声音有延续时填写 sound_bridge。它描述“本镜从哪里来”，不能用 transition_to_next 代替。eyeline_match 必须写清上一镜建立的视线来源与本镜目标；hard_cut 必须写清切换原因以及本镜开头如何重新建立空间。

13. **基于戏剧节拍（Dramatic Beats）自适应规划分镜数量与节奏**：
    - 绝非机械除法！必须根据剧情的戏剧冲突点（空间建构拍 ➔ 铺垫展开拍 ➔ 矛盾激化拍 ➔ 反应特写拍 ➔ 余波收束拍）自适应安排镜头数量与时长。

【导演节奏规划】：本轮由导演根据剧情规划 ${targetCount} 镜、共 ${targetDuration} 秒；平均约 ${singleShotDuration} 秒不是逐镜固定时长。\n【用户明确要求】：${JSON.stringify(requestedPacing)}。空值为自动；手动值不得静默更改，冲突需反馈。\n本轮逐镜剧情任务与时长：${JSON.stringify(pacingPlan.shots)}。必须按既定剧情顺序展开，每镜时长匹配该规划。
${universalPlanningSection}`;

  const userPrompt = `【剧本内容】：
${scriptContent}

【任务要求】：
请以纯 JSON 格式输出 {"storyboards": [...]}。每个分镜包含：
- shot_number: 镜头序号 (从 1 递增)
- dialogue_framing: 视听构图参考（字典仅供启发参考，不是必须填这些固定词，可填参考模式如 two_shot_face_to_face / over_the_shoulder / single_reaction_offscreen / joint_observation / solo_action，亦可结合剧情自由给出更贴切的构图描述）
- long_take_group_id: 固定填 null。长台词或长动作拆分后的镜头也独立执行，不自动接力尾帧
- long_take_role: 固定填 null
- long_take_sequence: 固定填 null
- title: 3-5字镜头标题
- scene_id: 所属场景ID (必须选自可用场景目录)
- characters: 出场角色ID数组 (如 [1, 2]，单镜出场角色最多3人（<=3人），严禁超过3人（>3人）)
- background_characters: 背景在场人物数组 (在场但不说话/主动作，保持空间恒常在场，绝不突然降临；如 [{"character_id": 2, "name": "妹妹", "depth_layer": "background", "screen_position": "画面右后方景深处书架旁", "activity": "低头安静翻看作业本", "mouth_state": "双唇紧闭，无台词口型，后景虚焦"}]，无背景角色填 []。铁律：同一个角色绝对严禁同时出现在 characters 与 background_characters 中！)
- identity_visibility: 角色面部识别度 (clear_frontal/three_quarter/profile/back_view/silhouette/occluded，背影剪影严禁标为clear_frontal)
- wardrobe_id: 当前镜头角色服装造型标识 (如 1 或 null，同一角色在同一镜头严禁出现多套服装)
- speech_plan: 台词方案对象 ({"speaker_id": 1, "is_offscreen": false, "is_narration": false, "text": "台词正文", "speed": 1.25, "emotion": "坚定"}；若为画外音必须标 is_offscreen: true；若为旁白必须标 is_narration: true。铁律：画外音或旁白时，画内所有人物必须全员双唇紧闭，audio_lip_sync 填 offscreen_voiceover 或 narration，visible_characters_lip_state 填 strictly_sealed！)
- sound_plan: 声音方案对象 ({"sound_effects": ["脚步声"], "bgm_prompt": "", "is_silent": false}；silent_ambient 只填环境/动作音，bgm_only 只填纯器乐配乐，完全静音才设 is_silent:true)
- continuity_type: 镜头接续类型 (match_cut/eyeline_match/ots_reverse/hard_cut/continuation；不得使用 long_take_continuation)
- h3_mode: 固定为 "ref2va"。导演 Agent 不负责选择 FL2VA；用户生成后如果需要首帧强绑定，可在单镜设置中手动覆盖执行模式
- h3_mode_reason: 说明本镜为什么需要场景、人物、道具和声音等多参考来保持身份、空间与动作连续性
- first_frame_policy: 固定为 "none"。Ref2VA 使用 required_references，不生成首帧，也不使用 AddGuide 或上一镜尾帧
- first_frame_reason: 说明本镜由哪些多参考素材承担开场构图与人物身份约束
- last_frame_policy: 固定为 "none"。Ref2VA 不生成尾帧
- last_frame_reason: 说明动作在本镜内自然收束，无需额外尾帧
- required_references: 本镜头生成所必需依赖的核心参考图清单。第 1 项必须是场景，随后是画内主体、背景角色和核心道具，严格最多9张
- audio_lip_sync: 口型控制模式 (in_frame_dialogue/offscreen_voiceover/narration/silent_ambient/bgm_only；silent_ambient 表示无语言但保留环境/动作音，bgm_only 表示无语言且只有纯器乐；画外音、旁白及全部无语言模式都要求画内全员双唇紧闭)
- shot_duration: 镜头秒数 (4~8之间，必须匹配台词字数预算)
- start_framing: 镜头起幅机位构图与角色初始姿态 (开端机位与画内人物初始定格状态)
- end_framing: 镜头落幅定格构图与尾帧承接状态 (落幅定格状态，为下一镜头提供视觉承接锚点)
- transition_to_next: 与下一镜过渡类型及承接说明 (如 "eyeline_match: 顺接奕宸向右侧偏头的视线，本镜头切至右侧书桌前的妹妹" / "match_cut" / "rack_focus" / "ots_reverse" / "continuous_tracking" / "cut")
- continuity_from_previous: 本镜从上一镜进入的承接合同。除第1镜外必须填写：{"relationship":"continuation/eyeline_match/match_cut/ots_reverse/hard_cut","previous_end_state":"上一镜最后可见的角色、位置、姿态和事件结果","entry_state":"本镜第一秒可见的角色、位置、姿态和视线","causal_link":"上一镜事件如何触发本镜事件","sound_bridge":"可选的延续音效","requires_previous_tail":true或false}。第1镜使用 relationship:"opening"，previous_end_state 填空，但仍填写 entry_state 和 causal_link。
- props: 出场或交互的核心道具ID数组 (如 [1]，选自可用道具目录，严格0~2件，无道具填 [])
- shot_type: 景别 (大远景/远景/全景/中景/近景/特写)
- angle_h: 水平视角 (front/front_left/front_right/left/right/back)
- angle_v: 俯仰角 (eye_level/low/high/worm)
- angle_s: 景别尺度 (wide/medium/close_up)
- movement: 运镜 (push/pull/pan/tilt/tracking/handheld/crane_up/crane_dn/orbit；少用 static)
- lighting_style: 灯光风格 (natural/side/backlit/dramatic/soft/golden_hour/blue_hour/night/neon)
- lighting_chiaroscuro: 影视打光与影调质感 (主光方向、轮廓光/侧逆光、局部冷暖发光、高反差明暗影调描写)
- environment_depth: 空间三层纵深 (前景虚化遮挡、中景主体物理接触地表/构件、背景纵深透视与材质细节)
- cinematic_lens: 电影镜头光学参数 (如 35mm宽银幕变形镜头/85mm定焦大光圈浅景深焦外散景)
- depth_of_field: 景深 (shallow/medium/deep)
- duration: 本镜秒数 (整数，4~8之间，必须匹配台词字数预算)
- action: 核心物理动作 (严禁单镜头出现中途换装、变身等无法维持单镜一致性的动作)
- result: 动作收束结果
- dialogue: 台词 ("角色名: \"台词\""，无对话填 "")
- narration: 旁白 (无则 "")
- bgm_prompt: 背景音乐描述 (仅 bgm_only 填具体纯器乐风格与节奏；有语言、silent_ambient 或完全静音时填空串)
- sound_effect: 现场音效与动作声音
- layout_description: 画面站位与物体尺度空间合同
- emotion: 核心情绪
- character_visuals: 出场角色视觉槽位数组 (每个出场角色必须完整填写槽位，包含主体与背景在场人物，背景在场人物 depth_layer 必须为 "background"：
    {"character_id": 1, "name": "角色名", "depth_layer": "画面纵深层级(foreground/midground/background)", "screen_position": "构图站位与远近前后(必须同时交代左右与前后远近，必须包含画面左侧/画面右侧/画面中央/画面正中/画面左前/画面右前/画面前景/画面中景/画面后景等明确词，如: 画面左侧前景过肩/画面右侧中景)", "environmental_anchor": "物理环境依托（掩体后/书桌前等）", "facing": "朝向（正面面对镜头/背向镜头/侧身朝向画面左侧/侧身朝向画面右侧/四分之三侧身朝左）", "expression": "具象面部微表情（咬肌紧绷/瞳孔微聚/嘴角抿直等）", "head_pose": "头部姿态（必须包含头/仰/俯/侧头/低头/转头/正对等词，如：头部正对前方/头部微仰/低头看地/侧头偏向右侧）", "gaze": "目光视线（必须包含目光/视线/看/盯/凝视等词，如：双眼紧盯前方/目光警惕锁定右侧岔路）", "posture": "具体的躯干体态与重心定格（必须包含站/蹲/坐/卧/趴/扑/俯/仰/倾/跪/靠/立/挺等姿态词，如：身体前倾30度坐姿/双腿挺直站立/单膝跪地支撑重心等，严禁无姿态词！）", "hands": "双手与四肢具体动作（必须包含手/臂/指/握/按/托/持/掌/抓等词，如：右手平按在膝头/双手下垂于身侧/单手轻握衣角）", "prop_interaction": "手指与道具具体的物理接触点（无道具填 无道具接触）", "appearance_details": "服装质地与生理战损微状态"}
  严格定格瞬间，严禁包含视频化时序动态描述（如：先...再...、然后、随后、逐渐、开始、走到、跑向等）！
  无角色填 [])
- last_frame_visuals: 尾帧人物视觉槽位数组；需要尾帧时按 character_visuals 的同一完整结构规划动作收束状态，不需要尾帧时显式填 []
- video_slots: Agent 规划的视频执行语义对象，必须完整包含 performance_contract:"sync_v1"、camera、audio_lip_sync、trajectories、environment_vfx、timing、shots_timeline 七个键。含对白的镜内段还必须包含 speech_action_alignment，明确语音与动作的重叠时间。trajectories 及每个 shots_timeline.character_trajectories 必须统一使用 terminal_pose、facial_expression、facing、head_pose、gaze、attention_target、gaze_motivation、reaction_trigger 与 mouth_state 字段。每个镜内剪辑段必须是 1 或 2 个整数秒的连续窗口，先填写本段 camera 和 visible_characters，再让 character_trajectories 精确覆盖本段实际入画人物；特写、过肩和画外音可以只列当前可见人物，未入画人物不写视觉轨迹。每个可见人物必须明确该窗口内发生的动作、表情或因果反应，以及“什么事件使他反应、头转向哪里、眼睛实际落在谁或什么东西上”。说话者口型与台词对应，听者不能用静止互看填充整段；安静倾听必须伴随具体反应。示例中每位角色必须像这样给出视线字段：{"character_id":1,"trajectory":"抬手施压","terminal_pose":"食指停在门框方向","facial_expression":"冷笑收紧","facing":"四分之三侧身朝向受话人","head_pose":"头部微俯转向受话人面部","gaze":"双眼锁定受话人眼睛","attention_target":"受话人面部","gaze_motivation":"直接施压对话","reaction_trigger":"自己开口说出威胁","mouth_state":"speaker_synced"}。突发事件后下一拍必须更新 reaction_trigger、attention_target、head_pose 和 gaze，不得沿用无关的旧视线。
- semantic_slots: Agent 的跨层权威语义对象，必须完整包含 visible_characters、background_characters、identity_visibility、speech_plan、sound_plan、continuity_type、continuity_from_previous、h3_mode、h3_mode_reason、first_frame_policy、first_frame_reason、last_frame_policy、last_frame_reason、required_references、audio_lip_sync、shot_duration。长剧本分批规划时还必须包含 source_script_unit_ids，由当前批次协议给出的不可变原文单元 ID 连续分配；后端会据此恢复只读 source_script_excerpt。上面列出的同名语义决策必须写入此对象，不得只散落在顶层。例如 {"visible_characters":[{"id":1,"name":"角色名"}],"background_characters":[],"identity_visibility":"three_quarter","speech_plan":{"speaker_id":1,"speaker_name":"角色名","is_offscreen":false,"is_narration":false,"text":"实际台词","speed":1.25,"emotion":"坚定","audio_references":[]},"sound_plan":{"sound_effects":["脚步声"],"bgm_prompt":"","acoustic_env":"室内","is_silent":false},"continuity_type":"continuation","continuity_from_previous":{"relationship":"opening","previous_end_state":"","entry_state":"角色位于画面左侧掩体后，身体前倾","causal_link":"开场直接建立任务现场","sound_bridge":"","requires_previous_tail":false},"h3_mode":"ref2va","h3_mode_reason":"本镜为角色对白近景，需要人物卡与音色参考保持身份一致","first_frame_policy":"none","first_frame_reason":"人物卡与场景卡直接约束 Ref2VA，本镜无需额外首帧","last_frame_policy":"none","last_frame_reason":"对白结束后的表情允许模型自然收束，无需锁定尾帧","required_references":[{"type":"character","id":1,"character_id":1,"name":"角色名"}],"audio_lip_sync":"in_frame_dialogue","shot_duration":5,"source_script_unit_ids":["B1U1"]}
图片与视频提示词由执行器从上述已通过门禁的槽位确定性编译，禁止输出或手写 <imageN>/<Picture N> 管线占位标签。

只返回纯 JSON，不要 markdown。`;

  onProgress(40, '导演智能体正在规划场面调度、机位构图与动感运镜...');
  log.info('[导演Agent] 阶段一：初稿推演生成中...');
  const draftBatches = working.draftBatches || buildDirectorDraftBatches(scriptContent, targetCount);
  working.draftBatches = draftBatches;
  checkpoint.save();
  directorTrace.record('draft_batches_planned', { target_count: targetCount, batches: draftBatches });
  const batchMode = draftBatches.length > 1;
  let shots = working.shots || [];
  let previousEnding = working.previousEnding || '';

  for (let batchIndex = working.nextBatch || 0; batchIndex < draftBatches.length; batchIndex++) {
    const batch = draftBatches[batchIndex];
    const batchProgress = Math.min(68, 40 + Math.floor((batchIndex / draftBatches.length) * 28));
    const batchRetry = {
      maxAttempts: maxReflectionRounds,
      onProgress,
      progress: batchProgress,
    };
    const sourceAssignments = working.sourceAssignments || (batchMode
      ? await planDirectorSourceAssignments(db, log, batch, batchRetry)
      : null);
    working.sourceAssignments = sourceAssignments;
    saveStage(`第 ${batchIndex + 1} 批原文规划完成`);
    const firstShotNumber = shots.length + 1;
    const lastShotNumber = firstShotNumber + batch.shot_count - 1;
    const batchDirective = batchMode ? `

【长剧本分批展开协议——本批次优先级最高】
这是整集连续导演规划的第 ${batchIndex + 1}/${draftBatches.length} 批。整集目标约 ${targetCount} 镜；本批只输出第 ${firstShotNumber}～${lastShotNumber} 镜，必须恰好 ${batch.shot_count} 镜，不得重述前文，也不得提前处理后续片段。
本批原文已经由系统切成下列不可变单元，并由原文覆盖规划 Agent 选择了连续分组。每镜必须严格使用锁定分组中的 semantic_slots.source_script_unit_ids；不得遗漏、重复、倒序、跨镜移动或虚构。不要抄写原文，系统会在门禁通过后按 ID 确定性恢复 source_script_excerpt：
${JSON.stringify(batch.source_units, null, 2)}
锁定分组：${JSON.stringify(sourceAssignments.map((ids, index) => ({ shot_slot: index + 1, source_script_unit_ids: ids })))}
${previousEnding ? `上一批落幅连续性摘要：${previousEnding}\n` : ''}本批唯一允许展开的连续源剧本片段：
<<<SOURCE_SEGMENT_${batchIndex + 1}>>>
${batch.script_segment}
<<<END_SOURCE_SEGMENT_${batchIndex + 1}>>>
只返回 {"storyboards":[...]}，数组中恰好 ${batch.shot_count} 个完整镜头。` : '';
    const batchPacing = pacingPlan.shots.slice(firstShotNumber - 1, lastShotNumber);
    const batchUserPrompt = (batchMode
      ? isolateDirectorDraftBatchPrompt(userPrompt, scriptContent, batch.script_segment)
      : userPrompt) + `\n本批导演节奏规划（按顺序展开，duration 必须一致）：${JSON.stringify(batchPacing)}`;
    const batchSystemPrompt = batchMode ? `${systemPrompt}

【当前原子批次输出合同——覆盖上文的整集目标数量】
本次调用不是生成整集，只处理第 ${batchIndex + 1}/${draftBatches.length} 批。
只允许输出镜号 ${firstShotNumber}～${lastShotNumber}，storyboards 必须恰好 ${batch.shot_count} 项。
不得输出、复述或修订该范围之外的任何镜头；不得按段落数自行增加镜头。
当前 user 消息中的批次源片段是本次唯一可展开文本。
本调用只负责核心剧情、机位、声音语义和 H3 决策层。不要输出 character_visuals、last_frame_visuals 或 video_slots；后续专用导演 Agent 会读取本轮核心决策并规划这些执行层。` : systemPrompt;

    let batchShots = working.batchShots || null;
    let lastBatchError = null;
    for (let attempt = 1; !batchShots && attempt <= maxReflectionRounds; attempt++) {
      const retryDirective = lastBatchError
        ? `\n\n【上一轮本批输出被完整性门禁拒绝】${lastBatchError.message}。丢弃上一轮结果，从当前批次源片段重新生成；storyboards 只能有 ${batch.shot_count} 项，镜号只能是 ${firstShotNumber}～${lastShotNumber}，不要返回解释。`
        : '';
      const batchBudget = batchMode ? directorOutputTokenBudget(batch.shot_count) : outputTokenBudget;
      try {
        const parsed = await agentsRuntime.runAgent(db, log, {
          name: 'director-storyboard-draft',
          instructions: batchSystemPrompt,
          input: `${batchDirective}\n\n${batchUserPrompt}${retryDirective}`,
          outputType: agentsRuntime.storyboardBatchOutputType(batch.shot_count, batch.source_units, sourceAssignments),
          maxTokens: batchBudget,
          temperature: batchMode ? 0.2 : 0.7,
        });
        const candidate = Array.isArray(parsed?.storyboards) ? parsed.storyboards : [];
        if (batchMode) {
          assertDirectorDraftBatch(batch, candidate);
        } else if (!candidate.length) {
          throw new Error('模型未返回合法分镜数组');
        }
        if (candidate.length !== batch.shot_count) throw new Error(`导演已规划本批 ${batch.shot_count} 镜，实际返回 ${candidate.length} 镜；不得遗漏剧情`);
        candidate.forEach((shot, index) => {
          if (Number(shot.duration) !== batchPacing[index].duration) throw new Error(`分镜 #${firstShotNumber + index} 时长应为导演规划的 ${batchPacing[index].duration} 秒，实际为 ${shot.duration} 秒，请修正`);
        });
        batchShots = batchMode ? materializeDirectorDraftBatchExcerpts(batch, candidate) : candidate;
        break;
      } catch (batchErr) {
        lastBatchError = batchErr;
        log.warn('[导演Agent] 初稿批次未通过完整性门禁，退回 Agent 重试', {
          batch: batchIndex + 1,
          total_batches: draftBatches.length,
          attempt,
          error: batchErr.message,
        });
        reportDirectorLayerRetry(
          batchRetry,
          `导演初稿第 ${batchIndex + 1}/${draftBatches.length} 批`,
          attempt,
          batchErr.message
        );
      }
    }
    if (!batchShots) {
      throw new Error(`导演智能体生成分镜失败：第 ${batchIndex + 1}/${draftBatches.length} 批经过 ${maxReflectionRounds} 轮门禁反馈仍未通过完整性门禁：${lastBatchError?.message || '未知错误'}`);
    }
    batchShots = batchShots.map((shot, index) => ({ ...shot, shot_number: firstShotNumber + index }));
    working.batchShots = batchShots;
    saveStage(`第 ${batchIndex + 1} 批核心初稿完成`);
    for (let shotIndex = 0; shotIndex < batchShots.length; shotIndex++) {
      const shotProgress = Math.min(
        68,
        40 + Math.floor(((batchIndex + ((shotIndex + 1) / batchShots.length)) / draftBatches.length) * 28)
      );
      const shotRetry = {
        maxAttempts: maxReflectionRounds,
        onProgress,
        progress: shotProgress,
      };
      working.currentShot = batchShots[shotIndex].shot_number;
      // One execution pass keeps character framing and the performance timeline
      // synchronized, avoiding two independent low-level plans for one shot.
      batchShots[shotIndex] = await ensureDirectorExecutionSlots(db, log, batchShots[shotIndex], shotRetry);
      saveStage(`分镜 #${working.currentShot} 视听执行合同完成`);
    }
    shots.push(...batchShots);
    const last = batchShots[batchShots.length - 1] || {};
    previousEnding = [last.title, last.end_framing, last.result, last.transition_to_next].filter(Boolean).join('；').slice(0, 1200);
    Object.assign(working, { shots, previousEnding, nextBatch: batchIndex + 1, batchShots: null, sourceAssignments: null, currentShot: null });
    saveStage(`第 ${batchIndex + 1} 批完成`);
    onProgress(
      Math.min(68, 40 + Math.floor(((batchIndex + 1) / draftBatches.length) * 28)),
      `导演初稿第 ${batchIndex + 1}/${draftBatches.length} 批完成 · 已规划 ${shots.length}/${targetCount} 镜`
    );
  }

  if (batchMode && shots.length < targetCount) {
    throw new Error(`导演初稿完整性门禁失败：目标约 ${targetCount} 镜，实际仅 ${shots.length} 镜，禁止以不完整分镜覆盖旧数据`);
  }
  if (batchMode && normalizeCoverageText(batchCoverageText(shots)) !== normalizeCoverageText(scriptContent)) {
    throw new Error('导演初稿完整性门禁失败：整集 source_script_excerpt 未完整覆盖原剧本，禁止落库');
  }

  // 3. 阶段二：运行视听本体质量门禁（SHACL Invariants Check - 严禁后端预先补造视觉槽位）
  onProgress(70, '初稿分镜推演完成，正在执行视听本体硬门禁审查...');
  log.info('[导演Agent] 阶段二：执行视听本体硬门禁审查', { shot_count: shots.length });
  const invariantOptions = {
    db,
    props: semPkg.catalogs.props,
    dramaEra: semPkg.drama.era,
    directorPlanningMode: universalOmni ? 'universal' : 'classic',
    requestedPacing,
  };
  let audit = auditDirectorDraft(shots, invariantOptions);
  directorTrace.record('draft_audited', { episode_id: episodeId, shots, audit });

  // 4. 阶段三：反思自纠环。持续把结构化违规退回 Agent，直到通过或达到显式安全上限。
  const initialReflectionErrors = Math.max(1, audit.error_count);
  let bestRemainingErrors = audit.error_count;
  let reflectionRepairs = working.reflectionRepairs || 0;
  let lastRejectedRepair = working.lastRejectedRepair || null;
  saveStage('整集门禁自纠');
  for (let reflectionRound = 1; reflectionRound <= maxReflectionRounds; reflectionRound++) {
    if (audit.valid || audit.error_count === 0) break;
    const repairTarget = selectDirectorRepairTarget(shots, audit.violations);
    if (!repairTarget) throw new Error('导演智能体无法将剩余门禁违规定位到可修复镜头');
    const repairContext = repairContextForViolations(shots, repairTarget.violations);
    const resolvedRatio = (initialReflectionErrors - bestRemainingErrors) / initialReflectionErrors;
    const repairProgress = Math.min(86, 72 + Math.floor(Math.max(0, resolvedRatio) * 14));
    const shotViolations = audit.violations.filter(item => Number(item.shot_number) === repairTarget.shot_number);
    let parsedRepaired = null;
    let candidateAudit = null;
    const traceRound = { round: reflectionRound, shot_number: repairTarget.shot_number };
    directorTrace.record('repair_started', { ...traceRound, selected_violations: repairTarget.violations,
      shot_violations: shotViolations, before_errors: audit.error_count, context: repairContext });

    onProgress(
      repairProgress,
      `ReAct 单镜自纠第 ${reflectionRound}/${maxReflectionRounds} 轮 · 正在修复分镜 #${repairTarget.shot_number} · 本轮处理 ${repairTarget.violations.length} 项 / 本镜剩余 ${shotViolations.length} 项 · 整集剩余 ${audit.error_count} 项...`
    );
    log.warn(`[导演Agent] 阶段三：第${reflectionRound}轮执行单镜原子纠偏`, {
      target_shot: repairTarget.shot_number,
      target_violations: repairTarget.violations,
      total_remaining_errors: audit.error_count,
      readonly_context_shots: repairContext.map((shot) => shot.shot_number),
    });

    // Speech-slot divergence is upstream of the timing assessment.  Repair the
    // authoritative utterance first; otherwise the Agent sees a derived
    // over-budget error and incorrectly performs a structural split that can
    // pull the following shot's dialogue into the current shot.
    const hasSpeechDivergence = repairTarget.violations.some(
      (item) => item?.rule === 'INVARIANT_SPEECH_SLOT_DIVERGENCE'
    );
    const requiresStructuralRepair = !hasSpeechDivergence
      && repairTarget.violations.some(requiresDirectorStructuralRepair);
    const repairOutputProtocol = requiresStructuralRepair
      ? `【本轮只允许拆镜修复】
只返回 {"structural_repairs":[{"replace_shot_number":${repairTarget.shot_number},"storyboards":[新镜头变更字段1,新镜头变更字段2]}]}。
- replace_shot_number 必须为 ${repairTarget.shot_number}。
- storyboards 至少包含2个新镜头变更对象；系统会以当前镜头为基底合并每个对象，未列出的不变字段自动保持原值。你必须显式提交每个新镜头的 duration、dialogue、narration、semantic_slots、video_slots，以及需要改变的 action、result、构图或视觉字段。
- 每个 semantic_slots 必须包含 source_script_excerpt，并将原镜 source_script_excerpt 按原顺序逐字无损分配；需要改变的 speech_plan、h3_mode、required_references 等语义决策写在 semantic_slots 内，禁止用顶层同名字段代替。每个 video_slots 至少提交拆分后的 timing 与 shots_timeline；不要复制未改变的 character_visuals、场景和参考字段来凑输出长度。
- 省略字段表示沿用原镜，不表示后端替你创作；合并后的每个新镜头仍会经过完整视听本体门禁，失败会把具体字段退回 Agent。
- 所有替换镜头都必须是独立的 Ref2VA 镜头：semantic_slots.h3_mode="ref2va"、first_frame_policy="none"、last_frame_policy="none"，并重新列出本镜所需的 required_references。long_take_group_id、long_take_role、long_take_sequence 必须为 null；不得自动继承上一镜尾帧。用户如需 FL2VA，须在生成后手动修改单镜执行设置。
- 禁止返回 repairs、完整整集 storyboards、markdown或解释。`
      : `【本轮只允许字段 Patch】
只返回 {"repairs":[{"shot_number":${repairTarget.shot_number},"patch":{仅包含需要修改的字段}}]}。
- repairs 必须且只能有1项，shot_number 必须为 ${repairTarget.shot_number}。
- 未列出的字段由系统原样保留；数组字段需要修改时返回修改后的完整数组。
- 同一语义若同时存在于顶层、semantic_slots 或 video_slots，必须在同一个 patch 内同步修正。
- 禁止返回 structural_repairs、完整分镜对象、完整整集 storyboards、markdown或解释。`;

    const reflectionPrompt = `你在刚才推演的分镜草稿中违反了视听本体硬门禁规则：
${repairTarget.violations.map(v => `- [${v.rule}] 镜头 ${v.shot_number || '全局'}: ${v.message}`).join('\n')}
${[...new Set(repairTarget.violations.map(directorAtomicRepairHint).filter(Boolean))].join('\n')}
【本轮选中违规的结构化定位】
${JSON.stringify(repairTarget.violations)}
【本镜其他待处理问题，仅作上下文，不得越过本轮 Schema 修改】
${JSON.stringify(shotViolations)}
【本任务镜头时长范围】${requestedPacing.range.min}～${requestedPacing.range.max} 秒；H3 的 8 秒能力上限不覆盖本任务设置。
${lastRejectedRepair?.shot_number === repairTarget.shot_number ? `【上轮修复被拒绝的完整反馈】\n${JSON.stringify(lastRejectedRepair)}\n上轮补丁没有写入当前镜头。请根据被拒绝的补丁与复检路径调整本轮方案，不得把相同的无效补丁再次提交。` : ''}

${hasSpeechDivergence ? '【台词槽位优先级】本镜同时出现台词槽位冲突与时长违规时，本轮只统一数据库对白/旁白、semantic_slots.speech_plan 与 video_slots.audio_lip_sync 的实际朗读文本；不要拆镜、不要延长时长、不要把相邻镜头台词并入本镜。统一后系统会重新计算时长，只有仍然超限时下一轮才允许拆镜。' : ''}

本轮唯一可修改目标是分镜 #${repairTarget.shot_number}。相邻镜头只用于读取连戏上下文，严禁返回它们的 Patch。

请进行专业导演自省反思并按以下铁律彻底纠正：
1. 固定机位与连续镜头均合法，只依据当前违规及剧情需求修正；不得为了修复其他字段强行添加动态运镜或切镜；
2. 无语言镜头必须按剧情明确选择声音合同：动作、环境与拟音为 silent_ambient（BGM空）；纯器乐蒙太奇为 bgm_only（音效空）；真正无任何声音才设 is_silent:true。三者都必须清空全部台词槽位，并让所有画内角色在顶层及每个 timeline 段明确“双唇紧闭无口型”；
3. 画外音与口型：标记为画外音(is_offscreen: true)或旁白(narration)时，必须在 patch.video_slots.audio_lip_sync.visible_characters_lip_state 精确写入 "strictly_sealed"，并把 patch.video_slots.trajectories 及每个 patch.video_slots.shots_timeline[].character_trajectories[] 中所有画内角色的 mouth_state 写为“双唇紧闭无口型”。严禁只改顶层 audio_lip_sync 字符串，那不是视频执行槽位！
4. 旁白解说：客观无源旁白严禁作为画内角色的台词口型同步！
5. 静音镜头：声明为静音(is_silent: true)时，严禁填入对白、BGM 描述或音效！
6. 角色定位：同一个角色绝不能同时属于主角 (visible_characters) 与背景人物 (background_characters)！
7. 构图人数：单人专注构图 (solo_action) 严格仅限 1 人；双人对视/过肩构图严格仅限 2 人！
8. 正脸与背影：背身、侧后方、剪影严禁标为清晰正脸识别 (clear_frontal)！
9. 服装一致：同一镜头内同一角色绝不允许出现多套不同服装，单镜服装必须统一！
10. 尾帧承接：跨越不同场景、时间线跳跃或角色换装时，严禁使用 inherit_tail 继承上一镜尾帧，必须使用 generate_new 全新生成！
11. 单镜造型：单镜头内严禁出现中途换衣、脱去外袍、换上战甲、变身等动作，必须拆为两个镜头！
12. H3 参考容量上限：出场主角严格 <= 3 人，核心道具严格 <= 2 件，必要参考图 required_references 严格 <= 9 张，音频参考 <= 3 个！超标必须拆镜或精简，禁止塞入多余素材！
13. Picture 标签对齐：若提示词引用 <Picture N>，N 必须与 required_references 序号完全对应，绝不悬空！
14. Ref2VA 执行方案：每镜必须由导演 Agent 输出 h3_mode="ref2va"、first_frame_policy="none"、last_frame_policy="none" 及对应理由；导演 Agent 不得输出 FL2VA 或任何首尾帧接力方案。用户可在生成后手动覆盖单镜执行模式。
15. 台词时长预算：超出时长预算的分镜必须在标点符号处按语义拆分为 2 个以上独立 Ref2VA 分镜，严禁随意删减台词！
16. 参考图合同：每个 Ref2VA 镜头必须由 Agent 明确列出场景、画内人物和必要道具参考；后端不得静默补图、截断或猜测。
17. 角色视觉槽位必须具象完整：每个在场角色的 character_visuals 必须同时包含：
    - posture（躯干重心定格，必须有站/蹲/坐/卧/趴/扑/俯/仰/倾/跪/靠/立/挺等词，如：身体前倾30度坐姿/双腿挺直站立）；
    - facing（身体朝向，必须明确朝向搭档、道具或具体画面方向，禁止无理由正面对摄影机）；
    - head_pose（头部姿态，必须有头/仰/俯/侧头/低头/转头/正对等词，如：头部正对前方/低头凝视）；
    - gaze（必须写明双眼的具体落点，如受话人眼睛、嘴角血迹、被扣手腕或发光掌心，不得只写“看向前方”）；
    - screen_position（构图位置，必须有画面左侧/画面右侧/画面中央/画面正中/画面前景/画面中景/画面后景等词）；
    - hands（双手动作，必须有手/指/握/按/托/持/掌/抓等词）；
18. 严禁时序动态混入生图：character_visuals 中严禁出现“然后、随后、逐渐、开始、走到、跑向、先...再...”等动态时序过程，必须为静态定格瞬时瞬间！
19. 短剧镜内剪辑：video_slots.shots_timeline 必须把总时长完整拆成连续的 1 或 2 个整数秒动作段（4 秒至少 2 段，8 秒至少 4 段），按 0–1、1–2 这样的窗口逐段约束动作；禁止使用一个完整大段、禁止使用小数秒。每段必须使用 shot_number、timestamp、duration、camera、visible_characters、action、result、character_trajectories、audio_lip_sync 字段。visible_characters 是本段实际入画人物，特写、过肩和画外音可以是外层人物清单的子集；character_trajectories 必须且只能覆盖该子集。禁止使用 segment、time、beat、dialogue_text、duration_seconds 等执行层不读取的别名。每项轨迹使用 character_id、name、trajectory、terminal_pose、facial_expression、facing、head_pose、gaze、attention_target、gaze_motivation、reaction_trigger、mouth_state；“说完后互相看着、保持不动、等待”不能作为段落动作或收尾。对白跨切口必须连续，不得重读、漏字或在切换时重新起句！
20. 事件驱动注意力：人物咳嗽、吐血、受伤、摔倒、拔刀、抛出道具或发光时，所有应当反应的画内角色必须在对应镜内段把 attention_target 指向事件源，并给出对应头部转向和眼睛落点。直接对话若故意不看受话人，必须在 gaze_motivation 明确剧情理由。
21. 剧本覆盖合同：semantic_slots.source_script_excerpt 是只读的原剧本覆盖证据。普通字段修复不得改写它；拆镜时必须把原镜的 source_script_excerpt 按原顺序无损分配到新镜，拼接后必须与原值完全一致。

${DIRECTOR_ACTION_COMPLETION_CONTRACT}
${repairOutputProtocol}`;

    try {
      const repairTokenBudget = requiresStructuralRepair
        ? 24576
        : directorRepairTokenBudget(repairTarget.violations.length, 1);
      const repairUserPrompt = `${reflectionPrompt}\n\n【目标镜头与只读相邻连戏上下文】\n${JSON.stringify({ target_shot_number: repairTarget.shot_number, storyboards: repairContext })}`;
      parsedRepaired = await agentsRuntime.runAgent(db, log, {
        name: 'director-invariant-repair',
        instructions: '你是导演分镜的单镜原子修复节点。系统已完成整集初稿；你只能依据用户消息中的门禁反馈修复指定镜头。相邻镜头只读。严格遵守本轮唯一输出协议和 JSON Schema，禁止重新生成整集，禁止输出解释。',
        input: repairUserPrompt,
        outputType: requiresStructuralRepair
          ? agentsRuntime.directorStructuralRepairOutputType(repairTarget.shot_number)
          : agentsRuntime.directorPatchRepairOutputType(
            repairTarget.shot_number,
            directorAtomicPatchSchema(
              repairTarget.violations,
              shots.find((shot) => Number(shot.shot_number) === repairTarget.shot_number)
            )
          ),
        maxTokens: repairTokenBudget,
        temperature: 0.2,
      });
      directorTrace.record('repair_response', { ...traceRound, original_patch: parsedRepaired });
      const returnedTarget = Array.isArray(parsedRepaired?.repairs) && parsedRepaired.repairs.length
        ? Number(parsedRepaired.repairs[0]?.shot_number)
        : Number(parsedRepaired?.structural_repairs?.[0]?.replace_shot_number);
      if (returnedTarget !== repairTarget.shot_number) {
        throw new Error(`Director repair 越界：本轮只允许修复分镜 #${repairTarget.shot_number}`);
      }
      const appliedRepair = applyDirectorRepairPlan(shots, parsedRepaired);
      candidateAudit = auditDirectorDraftScoped(
        appliedRepair.shots,
        invariantOptions,
        audit,
        repairTarget.shot_number,
      );
      directorTrace.record('repair_audited', { ...traceRound, before_errors: audit.error_count,
        after_errors: candidateAudit.error_count, audit_scope: candidateAudit.audit_scope,
        violations: candidateAudit.violations });
      const repairScope = new Set(candidateAudit.audit_scope || [repairTarget.shot_number]);
      const countScopedViolations = (auditResult) => (auditResult?.violations || [])
        .filter((item) => repairScope.has(Number(item?.shot_number))).length;
      const countTargetViolations = (auditResult) => (auditResult?.violations || [])
        .filter((item) => Number(item?.shot_number) === Number(repairTarget.shot_number)).length;
      const beforeScopedErrors = countScopedViolations(audit);
      const afterScopedErrors = countScopedViolations(candidateAudit);
      const beforeTargetErrors = countTargetViolations(audit);
      const afterTargetErrors = countTargetViolations(candidateAudit);
      // Adjacent shots are read-only continuity context. Existing violations
      // there must not block a valid repair of the selected target shot;
      // reject only when the target did not improve or the patch adds errors
      // inside the audited continuity scope.
      if (!appliedRepair.structural && (afterTargetErrors >= beforeTargetErrors || afterScopedErrors > beforeScopedErrors)) {
        const candidateShotErrors = candidateAudit.violations
          .filter((item) => Number(item?.shot_number) === repairTarget.shot_number)
          .map((item) => `[${item.rule}] ${item.message}`)
          .join('；');
        throw new Error(
          `候选 Patch 未减少目标镜头或新增相邻连戏违规（目标 ${beforeTargetErrors} → ${afterTargetErrors}；范围 ${beforeScopedErrors} → ${afterScopedErrors}；整集 ${audit.error_count} → ${candidateAudit.error_count}），已拒绝且未污染当前最佳状态。`
          + (candidateShotErrors ? `候选镜头仍有：${candidateShotErrors}` : '')
        );
      }
      shots = appliedRepair.shots;
      lastRejectedRepair = null;
      directorTrace.record('repair_accepted', { ...traceRound, after_errors: candidateAudit.error_count,
        changed_shots: appliedRepair.changed_count });
      reflectionRepairs += 1;
      audit = candidateAudit;
      bestRemainingErrors = Math.min(bestRemainingErrors, audit.error_count);
      Object.assign(working, { shots, reflectionRepairs, lastRejectedRepair: null, reflectionRound: (working.reflectionRound || 0) + 1 });
      checkpoint.save();
      log.info(`[导演Agent] 第${reflectionRound}轮 Agent Patch 已确定性合并并重新质检`, {
        valid: audit.valid,
        remaining_errors: audit.error_count,
        changed_shots: appliedRepair.changed_count,
        structural_repair: appliedRepair.structural,
        output_token_budget: repairTokenBudget,
      });
      onProgress(
        Math.min(87, 73 + Math.floor(((initialReflectionErrors - bestRemainingErrors) / initialReflectionErrors) * 14)),
        audit.valid
          ? `ReAct 单镜自纠第 ${reflectionRound}/${maxReflectionRounds} 轮完成 · 分镜 #${repairTarget.shot_number} 已通过 · 整集硬门禁已通过`
          : `ReAct 单镜自纠第 ${reflectionRound}/${maxReflectionRounds} 轮完成 · 已修复分镜 #${repairTarget.shot_number} · 整集剩余 ${audit.error_count} 项`
      );
      if (audit.valid) {
        onProgress(87, '单镜自纠完成，视听门禁质检通过...');
        break;
      }
    } catch (refErr) {
      lastRejectedRepair = { ...traceRound, original_patch: parsedRepaired, rejection: refErr.message,
        candidate_violations: candidateAudit?.violations?.filter(item => Number(item.shot_number) === repairTarget.shot_number) || refErr.violations || [] };
      directorTrace.record('repair_rejected', lastRejectedRepair);
      Object.assign(working, { lastRejectedRepair, reflectionRound: (working.reflectionRound || 0) + 1 });
      checkpoint.save();
      log.warn(`[导演Agent] 第${reflectionRound}轮自纠推理异常`, { error: refErr.message });
    }
  }

  // 严格把关：若经过自省纠偏后仍存在致命门禁错误，必须携带结构化违规项阻断抛出，严禁静默保存无效语义！
  if (!audit.valid && audit.error_count > 0) {
    const err = new Error(`导演智能体经过 ${maxReflectionRounds} 轮 ReAct 自纠后仍未通过视听本体硬门禁审查（共 ${audit.error_count} 处违规）：${audit.violations.map(v => `[${v.rule}] ${v.message}`).join('；')}`);
    err.status = 422;
    err.violations = audit.violations;
    err.valid = false;
    throw err;
  }

  if (batchMode) {
    if (shots.length < targetCount) {
      throw new Error(`导演 ReAct 完整性终检失败：目标约 ${targetCount} 镜，修复后仅 ${shots.length} 镜，旧分镜不会被覆盖`);
    }
    if (normalizeCoverageText(batchCoverageText(shots)) !== normalizeCoverageText(scriptContent)) {
      throw new Error('导演 ReAct 完整性终检失败：修复过程破坏了原剧本覆盖合同，旧分镜不会被覆盖');
    }
  }

  // 5. 阶段四：无损格式规范化与终检（严禁后端静默修改运镜、时长、台词、道具或补造槽位）
  onProgress(88, '初稿通过门禁，正在执行无损格式校验与最终审查...');
  const {
    compileImagePromptFromSlots,
  } = require('./visualSlots');

  const normalizedShots = normalizeDirectorShots(shots, universalOmni);

  // 严格二次门禁：无损规整后的候选实体必须重新通过本体门禁审查，绝不带病入库！
  pacing.assertManualTargets(normalizedShots, requestedPacing);
  const finalAudit = auditDirectorDraft(normalizedShots, invariantOptions);
  if (!finalAudit.valid && finalAudit.error_count > 0) {
    const err = new Error(`分镜落库前终检未通过视听本体硬门禁审查（共 ${finalAudit.error_count} 处违规）：${finalAudit.violations.map(v => `[${v.rule}] ${v.message}`).join('；')}`);
    err.status = 422;
    err.violations = finalAudit.violations;
    err.valid = false;
    throw err;
  }

  // 6. 阶段五：原子化持久化入库（软删除历史分镜，插入新分镜并生成完整图片与视频提示词）
  onProgress(92, '视听本体质检通过，正在持久化写入分镜数据...');
  const now = new Date().toISOString();
  let totalDuration = 0;

  const dramaRow = db.prepare('SELECT style, metadata FROM dramas WHERE id = ?').get(dramaId) || {};
  const { resolvedStreamStyleFromDrama } = require('../utils/dramaStyleMerge');
  const finalStyle = resolvedStreamStyleFromDrama('', dramaRow) || cfg?.style?.default_style || '';
  const insertedIds = [];

  db.transaction(() => {
    checkpoint.assertCurrent();
    linkEpisodeCharacters(db, epId, normalizedShots);
    db.prepare('UPDATE storyboards SET deleted_at = ? WHERE episode_id = ? AND deleted_at IS NULL').run(now, epId);

    const insertStmt = db.prepare(`
      INSERT INTO storyboards (
        episode_id, scene_id, storyboard_number, title, description, location, time, duration,
        dialogue, narration, action, result, atmosphere, movement, lighting_style, depth_of_field,
        angle_h, angle_v, angle_s, dialogue_framing, shot_type, bgm_prompt, sound_effect, layout_description,
        characters, character_visuals, last_frame_visuals, video_slots, image_prompt, video_prompt, polished_prompt,
        long_take_group_id, long_take_role, long_take_sequence,
        start_framing, end_framing, transition_to_next, background_characters, semantic_slots,
        creation_mode, universal_segment_text,
        status, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?,
        'pending', ?, ?
      )
    `);

    for (const s of normalizedShots) {
      const scene = semPkg.getScene(s.scene_id) || semPkg.catalogs.scenes[0] || {};
      const dur = Math.max(1, Number(s.duration));
      totalDuration += dur;

      const charJson = Array.isArray(s.characters) ? JSON.stringify(s.characters) : '[]';

      const sbWithAngles = {
        ...s,
        location: scene.location || '场景',
        time: scene.time || '日景',
        environment_depth: s.environment_depth || '',
        lighting_chiaroscuro: s.lighting_chiaroscuro || '',
        cinematic_lens: s.cinematic_lens || '',
        shot_type: s.shot_type,
        movement: s.movement,
        lighting_style: s.lighting_style,
        depth_of_field: s.depth_of_field,
        angle_h: s.angle_h,
        angle_v: s.angle_v,
        angle_s: s.angle_s,
        bgm_prompt: s.bgm_prompt || '',
        sound_effect: s.sound_effect || '',
      };

      const visuals = s.character_visuals || [];
      const lastVisuals = s.last_frame_visuals || [];
      const vidSlots = s.video_slots || {};

      const imgPrompt = compileImagePromptFromSlots(sbWithAngles, visuals, { style: finalStyle });
      if (!imgPrompt) throw new Error(`分镜 #${s.shot_number} 无法从 Agent 视觉槽位编译图片提示词`);
      const polishedPrompt = imgPrompt;
      const charVisualsJson = JSON.stringify(visuals);
      const lastVisualsJson = JSON.stringify(lastVisuals);
      const videoSlotsJson = JSON.stringify(vidSlots);

      const info = insertStmt.run(
        epId,
        s.scene_id || scene.id || null,
        s.shot_number,
        s.title || `镜头${s.shot_number}`,
        s.action || '',
        scene.location || '场景',
        scene.time || '日景',
        dur,
        s.dialogue || '',
        s.narration || '',
        s.action || '',
        s.result || '',
        s.atmosphere || s.emotion || '',
        s.movement,
        s.lighting_style,
        s.depth_of_field,
        s.angle_h,
        s.angle_v,
        s.angle_s,
        s.dialogue_framing,
        s.shot_type,
        s.bgm_prompt || '',
        s.sound_effect || '',
        s.layout_description || '',
        charJson,
        charVisualsJson,
        lastVisualsJson,
        videoSlotsJson,
        imgPrompt,
        null,
        polishedPrompt,
        s.long_take_group_id || null,
        s.long_take_role || null,
        s.long_take_sequence != null ? Number(s.long_take_sequence) : null,
        s.start_framing || '',
        s.end_framing || '',
        s.transition_to_next || '',
        JSON.stringify(s.background_characters || []),
        JSON.stringify(s.semantic_slots),
        s.creation_mode,
        s.universal_segment_text,
        now,
        now
      );
      const insertedId = info.lastInsertRowid;
      insertedIds.push(insertedId);
      for (const pid of s.props || []) {
        const numPid = Number(pid);
        if (numPid > 0) {
          db.prepare('INSERT INTO storyboard_props (storyboard_id, prop_id) VALUES (?, ?)').run(insertedId, numPid);
        }
      }
    }
    working.published = true;
    saveStage('已发布');
  })();

  // 资产清理由显式审核操作触发。导演流程只返回诊断，不在落库后静默删除世界观资产。

  // 更新剧集总时长
  const durationMinutes = Math.ceil(totalDuration / 60);
  db.prepare('UPDATE episodes SET duration = ?, updated_at = ? WHERE id = ?').run(durationMinutes, now, epId);

  log.info('[导演Agent] 分镜入库成功', {
    episode_id: epId,
    shot_count: normalizedShots.length,
    total_duration: totalDuration,
    semantic_revision: semPkg.semantic_revision,
  });

  onProgress(100, `导演智能体分镜推演完成，共生成 ${normalizedShots.length} 个分镜。`);

  return {
    storyboards: normalizedShots,
    total_shots: normalizedShots.length,
    audit,
    semantic_revision: semPkg.semantic_revision,
    total_duration: totalDuration,
    reflection_repairs: reflectionRepairs,
    max_reflection_rounds: maxReflectionRounds,
    planning_mode: universalOmni ? 'universal' : 'classic',
    pacing_plan: pacingPlan,
  };
}

/**
 * 运行全生命周期全剧导演智能体（Full-Lifecycle Autonomous Director Agent）
 * 覆盖：【故事梗概 ➔ 多集大纲与剧本 ➔ 角色/道具尺寸/场景地标抽取 ➔ 逐集动态分镜与BGM ➔ SHACL门禁自检自纠】
 * @param {object} db - SQLite 数据库
 * @param {object} log - 日志记录器
 * @param {object} cfg - 全局配置
 * @param {number|string} dramaId - 短剧 ID
 * @param {object} [options] - 选项 (premise, episodeCount, style, genre, storyboardCount)
 * @param {Function} [progressCallback] - 进度回调 (progress, message)
 */
async function runFullDramaDirectorAgent(db, log, cfg, dramaId, options = {}, progressCallback = null) {
  const did = Number(dramaId);
  const drama = dramaService.getDramaById(db, did);
  if (!drama) throw new Error('短剧项目不存在');

  const premise = (options.premise || drama.description || drama.summary || '').trim();
  if (!premise) throw new Error('请提供故事梗概以启动全流程导演智能体推演');

  const episodeCount = Math.max(1, Math.min(20, Math.floor(Number(options.episode_count || options.episodeCount) || 3)));
  const style = options.style || drama.style || 'modern';
  const genre = options.genre || drama.genre || 'drama';

  if (progressCallback) progressCallback(10, `导演智能体正在根据梗概规划全剧 ${episodeCount} 集大纲与剧本...`);

  // 1. 故事与剧本创编：生成多集剧本
  log.info('[全流程导演Agent] 阶段一：推演多集大纲与剧本正文...', { drama_id: did, episodeCount, premise: premise.slice(0, 100) });
  const storyResult = await generateStory(db, log, {
    premise,
    style,
    genre,
    episode_count: episodeCount,
    drama_id: did,
  });

  const rawEpisodes = storyResult?.episodes || [];
  if (rawEpisodes.length === 0) {
    throw new Error('导演智能体规划故事失败：未生成有效分集剧本');
  }

  // 保存分集剧本入库
  dramaService.saveEpisodes(db, log, did, {
    episodes: rawEpisodes.map((ep, idx) => ({
      episode_number: ep.episode ?? (idx + 1),
      title: ep.title || `第${ep.episode ?? (idx + 1)}集`,
      script_content: ep.content || '',
    })),
  });

  const dbEpisodes = db.prepare('SELECT id, episode_number, title, script_content FROM episodes WHERE drama_id = ? AND deleted_at IS NULL ORDER BY episode_number ASC').all(did);
  if (dbEpisodes.length === 0) throw new Error('分集剧本入库失败');

  if (progressCallback) progressCallback(30, '导演智能体正在构建世界观，统一抽取角色、道具物理尺度与场景地标...');

  // 2. 世界观资产抽取：以第 1 集为锚点统一抽取全剧核心角色、道具尺度与场景地标
  log.info('[全流程导演Agent] 阶段二：抽取世界观本体资产...', { drama_id: did });
  const extractedEntities = await extractAllEntitiesFromScript(db, log, cfg, dbEpisodes[0].id);

  // 3. 逐集导演视听编排与门禁自纠
  const episodeResults = [];
  const totalEps = dbEpisodes.length;

  for (let i = 0; i < totalEps; i++) {
    const ep = dbEpisodes[i];
    const currentProgress = 35 + Math.round(((i + 1) / totalEps) * 55);
    if (progressCallback) {
      progressCallback(currentProgress, `导演智能体正在推演第 ${ep.episode_number} 集《${ep.title}》场面调度、动感运镜与BGM...`);
    }

    log.info('[全流程导演Agent] 阶段三：编排第 ' + ep.episode_number + ' 集视听分镜', { episode_id: ep.id });
    const epRes = await runDirectorAgent(db, log, cfg, ep.id, {
      storyboardCount: options.storyboardCount ?? options.storyboard_count,
      videoDuration: options.videoDuration ?? options.video_duration,
      forceExtractEntities: false, // 实体已在阶段二统一抽取
      userDirectives: options.userDirectives || options.directives || options.feedback,
      universal_omni_storyboard: options.universal_omni_storyboard ?? options.universalOmniStoryboard,
    });
    episodeResults.push({
      episode_id: ep.id,
      episode_number: ep.episode_number,
      title: ep.title,
      shot_count: epRes.storyboards.length,
      audit: epRes.audit,
      semantic_revision: epRes.semantic_revision,
    });
  }

  if (progressCallback) progressCallback(95, '全生命周期推演完毕，正在原子化归档与持久化...');

  const totalShots = episodeResults.reduce((sum, r) => sum + r.shot_count, 0);
  log.info('[全流程导演Agent] 全生命周期闭环推演完成', {
    drama_id: did,
    episodes_count: episodeResults.length,
    total_shots: totalShots,
  });

  return {
    drama_id: did,
    episodes: episodeResults,
    worldview_assets: {
      characters_count: extractedEntities.characters.length,
      scenes_count: extractedEntities.scenes.length,
      props_count: extractedEntities.props.length,
    },
    total_shots: totalShots,
    summary: `导演智能体全流程闭环推演完成：已创作 ${episodeCount} 集剧本，构建包含 ${extractedEntities.characters.length} 个角色、${extractedEntities.scenes.length} 个场景、${extractedEntities.props.length} 个道具的世界观，并完成全集 ${totalShots} 个高动感分镜调度与音频闭环契约。`,
  };
}

/**
 * 针对单个分镜的原子级导演定向微调（Micro Shot-Level Director Refinement）
 * 用户指令直指该镜头的特定元素（如：特写拔剑、侧逆光、运镜改为微推、加紧张BGM等）
 * 智能体结合本体语义包（角色锚点、道具真实物理尺度、场景地标）与前后连戏快照精准重构该镜头
 * @param {object} db - SQLite 数据库
 * @param {object} log - 日志记录器
 * @param {object} cfg - 配置
 * @param {number|string} storyboardId - 分镜 ID
 * @param {string} userInstruction - 用户针对该元素的定向调整意见
 * @returns {Promise<object>} 更新后的分镜与质检结果
 */
async function refineSingleStoryboardAttempt(db, log, cfg, storyboardId, userInstruction = '', correctionContext = '', workingCandidate = null) {
  const sbId = Number(storyboardId);
  const sb = db.prepare('SELECT * FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(sbId);
  if (!sb) throw new Error('分镜不存在');

  const instruction = String(userInstruction || '').trim();
  if (!instruction) throw new Error('请提供针对该分镜的具体导演调整指令');
  const universalOmni = sb.creation_mode === 'universal';

  const semPkg = compileDramaSemanticPackage(db, sb.episode_id);
  const prevShot = db.prepare(
    'SELECT id, storyboard_number, action, location, time, movement, continuity_snapshot FROM storyboards WHERE episode_id = ? AND storyboard_number < ? AND deleted_at IS NULL ORDER BY storyboard_number DESC LIMIT 1'
  ).get(sb.episode_id, sb.storyboard_number);
  const nextShot = db.prepare(
    'SELECT id, storyboard_number, action, location, time FROM storyboards WHERE episode_id = ? AND storyboard_number > ? AND deleted_at IS NULL ORDER BY storyboard_number ASC LIMIT 1'
  ).get(sb.episode_id, sb.storyboard_number);
  const episodeMemory = db.prepare(`
    SELECT * FROM storyboards
    WHERE episode_id = ? AND deleted_at IS NULL
    ORDER BY storyboard_number ASC
  `).all(sb.episode_id).map((shot) => {
    const memory = Object.fromEntries([
      'id', 'storyboard_number', 'title', 'location', 'time', 'duration', 'action', 'result',
      'dialogue', 'narration', 'characters', 'background_characters', 'dialogue_framing',
      'start_framing', 'end_framing', 'transition_to_next', 'continuity_snapshot',
    ].filter((field) => Object.prototype.hasOwnProperty.call(shot, field)).map((field) => [field, shot[field]]));
    for (const field of ['characters', 'background_characters', 'continuity_snapshot']) {
      if (typeof memory[field] === 'string') {
        try { memory[field] = JSON.parse(memory[field]); } catch (_) {}
      }
    }
    return memory;
  });

  const currentSemantic = {};
  for (const field of ['characters', 'background_characters', 'character_visuals', 'last_frame_visuals', 'video_slots', 'semantic_slots', 'continuity_snapshot']) {
    const value = sb[field];
    if (typeof value === 'string') {
      try { currentSemantic[field] = JSON.parse(value); } catch (_) { currentSemantic[field] = value; }
    } else {
      currentSemantic[field] = value;
    }
  }
  try {
    currentSemantic.props = db.prepare('SELECT prop_id FROM storyboard_props WHERE storyboard_id = ? ORDER BY prop_id').all(sbId).map((row) => row.prop_id);
  } catch (_) {
    currentSemantic.props = [];
  }

  const persistedCandidate = {
    title: sb.title,
    scene_id: sb.scene_id,
    characters: currentSemantic.characters,
    props: currentSemantic.props,
    shot_type: sb.shot_type,
    angle_h: sb.angle_h,
    angle_v: sb.angle_v,
    angle_s: sb.angle_s,
    movement: sb.movement,
    lighting_style: sb.lighting_style,
    depth_of_field: sb.depth_of_field,
    duration: sb.duration,
    action: sb.action,
    result: sb.result,
    dialogue: sb.dialogue,
    narration: sb.narration,
    dialogue_framing: sb.dialogue_framing,
    bgm_prompt: sb.bgm_prompt,
    sound_effect: sb.sound_effect,
    layout_description: sb.layout_description,
    emotion: sb.emotion,
    start_framing: sb.start_framing,
    end_framing: sb.end_framing,
    transition_to_next: sb.transition_to_next,
    background_characters: currentSemantic.background_characters,
    character_visuals: currentSemantic.character_visuals,
    last_frame_visuals: currentSemantic.last_frame_visuals,
    video_slots: currentSemantic.video_slots,
    semantic_slots: currentSemantic.semantic_slots,
    continuity_snapshot: currentSemantic.continuity_snapshot,
    universal_segment_text: sb.universal_segment_text,
  };
  const currentCandidate = isPlainObject(workingCandidate)
    ? mergeDirectorAgentPatch({}, workingCandidate)
    : persistedCandidate;

  const universalRefineContract = universalOmni
    ? `
【当前镜头属于全能分镜模式，局部微调不得破坏既有执行合同】
- semantic_slots.h3_mode 必须保持 ref2va；first_frame_policy 与 last_frame_policy 必须保持 none。单镜微调不得把 Agent 方案改成 FL2VA；FL2VA 仅由用户在生成后手动覆盖。
- required_references 第 1 项必须是当前 scene_id 对应的场景，随后覆盖所有画内主体与背景角色，总数不得超过 9。
- 必须重新输出与本轮修改后动作、台词、时长一致的 universal_segment_text；其中 @图片N 与 required_references 顺序严格对应。
${promptI18n.getStoryboardUniversalOmniModeSuffix(cfg)}
`
    : '';

  const systemPrompt = `你是一位严谨的院线级导演与摄影指导（Director Agent）。
你正在继续同一部短剧的导演会话，只对第 ${sb.storyboard_number} 镜进行原子级定向微调。本集完整剧本、整集分镜记忆、当前镜头完整槽位与前后镜连戏都会提供给你。
你拥有全部语义决策权；后端只会校验并编译，不会替你补默认值、删除冲突项或改写运镜、时长、声音、人物及参考素材。
只修改用户明确要求与为保持连戏所必需的字段；其他剧情、台词、时长、人物、造型、场景和镜头编号保持原样。
直接对话默认建立说话人与受话人的视线轴；故意不看对方时必须在 gaze_motivation 写明剧情理由。咳嗽、吐血、受伤、摔倒、拔刀或发光等事件发生后，所有应当反应的画内角色必须在对应镜内段更新 facing、head_pose、gaze、attention_target、gaze_motivation 和 reaction_trigger。
请精准响应用户指令，同时遵守不可变世界观、人物与道具合同，并保持前后连戏。

${semPkg.getSystemDigest()}
${DIRECTOR_ACTION_COMPLETION_CONTRACT}
${universalRefineContract}`;

  const userPrompt = `【本集完整剧本（持久导演记忆）】
${semPkg.episode.script_content || '(本集剧本为空)'}

【本集导演记忆（全部现有分镜摘要）】
${JSON.stringify(episodeMemory, null, 2)}

【当前工作候选（上一轮 Patch 已合并；本轮必须在此基础上继续修改）】
${JSON.stringify(currentCandidate, null, 2)}

【相邻镜头】
上一镜：${prevShot ? JSON.stringify(prevShot) : '无'}
下一镜：${nextShot ? JSON.stringify(nextShot) : '无'}

【用户指令】
${instruction}

${correctionContext ? `【上一轮 ReAct 门禁反馈】\n${correctionContext}\n必须在本轮完整修复这些违规，不得改写与违规无关的内容。` : ''}

只返回一个纯 JSON 对象，并严格二选一：
1. 需要修改：{"patch":{"需要修改的字段":"修改后的值"}}
2. 当前工作候选已经完整满足用户指令：{"noop":true,"reason":"说明哪些现有槽位已经满足"}

- patch 只包含用户指令或本轮门禁反馈要求修改的字段，禁止重新输出完整分镜。
- noop 必须有具体 reason，且不得同时包含 patch；禁止用空 patch 表示无需修改。
- 未出现在 patch 中的字段由系统原样保留；禁止为了“完整”重复输出未修改字段。
- 对象字段支持递归局部 Patch；数组字段一旦修改，必须返回该数组修改后的完整值。
- 同一语义同时存在于 character_visuals、video_slots、semantic_slots 或 continuity_snapshot 时，必须在同一 patch 内同步修改相关位置，不能制造跨槽位冲突。
- 不得修改 id、storyboard_number、episode_id、状态、时间戳等执行层字段。
- 若需要新增或修复 video_slots.shots_timeline，每段必须且只能使用以下执行字段名：shot_number、timestamp、duration、camera、visible_characters、action、result、audio_lip_sync、character_trajectories。visible_characters 是本段实际入画人物，character_trajectories 必须且只能覆盖这些人物；特写、过肩和画外音可以使用外层人物清单的子集。timestamp 第一段可为 null，后续段使用 "00:02.000" 这类整数秒起始时间；duration 必须是正整数且不超过本镜总时长，全部段之和必须等于本镜总时长。camera 必须包含 shot_type、movement、movement_description。character_trajectories 必须且只能覆盖该段 visible_characters，每项使用 character_id、name、trajectory、terminal_pose、facial_expression、facing、head_pose、gaze、attention_target、gaze_motivation、reaction_trigger、mouth_state；禁止使用小数秒、segment、time、beat、dialogue_text、duration_seconds 或其他执行层不读取的同义字段。
${universalOmni ? '- 若本轮修改影响动作、台词、时长或引用顺序，patch 必须同步包含 universal_segment_text。' : ''}`;

  log.info('[导演Agent] 单分镜定向原子微调推理中...', { storyboard_id: sbId, instruction });
  const outputTokenBudget = directorRepairTokenBudget(1, 1);
  const parsedResponse = await agentsRuntime.runAgent(db, log, {
    name: 'director-storyboard-refinement',
    instructions: systemPrompt,
    input: userPrompt,
    outputType: agentsRuntime.directorRefinementOutputType,
    maxTokens: outputTokenBudget,
    temperature: 0.2,
  });
  if (!parsedResponse || typeof parsedResponse !== 'object' || Array.isArray(parsedResponse)) {
    throw new Error('导演智能体未能解析微调 Patch');
  }
  const parsed = applySingleStoryboardPatch(currentCandidate, parsedResponse, sb.storyboard_number);
  if (parsedResponse.noop === true) {
    log.info('[导演Agent] 单分镜定向微调无需变更，当前候选已满足指令', {
      storyboard_id: sbId,
      reason: parsedResponse.reason,
    });
    return {
      storyboard: sb,
      continuity_snapshot: typeof sb.continuity_snapshot === 'string'
        ? sb.continuity_snapshot
        : JSON.stringify(currentCandidate.continuity_snapshot ?? null),
      instruction,
      no_op: true,
      no_op_reason: String(parsedResponse.reason),
      audit: { valid: true, error_count: 0, violations: [], no_op: true },
    };
  }

  const requiredFields = [
    'title', 'scene_id', 'characters', 'props', 'shot_type', 'angle_h', 'angle_v', 'angle_s',
    'movement', 'lighting_style', 'depth_of_field', 'duration', 'action', 'result', 'dialogue',
    'narration', 'dialogue_framing', 'bgm_prompt', 'sound_effect', 'layout_description', 'emotion',
    'start_framing', 'end_framing', 'transition_to_next', 'background_characters',
    'character_visuals', 'last_frame_visuals', 'video_slots', 'semantic_slots', 'continuity_snapshot',
  ];
  if (universalOmni) requiredFields.push('universal_segment_text');
  const missing = requiredFields.filter((field) => !Object.prototype.hasOwnProperty.call(parsed, field));
  if (missing.length) {
    const error = Object.assign(new Error(`导演智能体微调结果缺少必要语义字段：${missing.join('、')}`), {
      status: 422,
      valid: false,
      violations: missing.map((field) => ({
        rule: 'INVARIANT_REQUIRED_AGENT_SLOT_MISSING',
        severity: 'error',
        shot_number: sb.storyboard_number,
        conflict_slots: [field],
        message: `分镜 #${sb.storyboard_number} 缺少 Agent 必须决策的语义字段 ${field}`,
      })),
    });
    error.workingCandidate = parsed;
    throw error;
  }

  const collectStructuralViolations = (value) => {
    const violations = [];
    for (const field of ['characters', 'props', 'background_characters', 'character_visuals', 'last_frame_visuals']) {
      if (!Array.isArray(value[field])) violations.push({ field, expected: 'array' });
    }
    for (const field of ['video_slots', 'semantic_slots', 'continuity_snapshot']) {
      if (!value[field] || typeof value[field] !== 'object' || Array.isArray(value[field])) {
        violations.push({ field, expected: 'object' });
      }
    }
    const valueDuration = Number(value.duration);
    if (!Number.isFinite(valueDuration) || valueDuration <= 0) violations.push({ field: 'duration', expected: 'positive_number' });
    if (!semPkg.getScene(value.scene_id)) violations.push({ field: 'scene_id', expected: 'existing_scene_id' });
    for (const characterId of Array.isArray(value.characters) ? value.characters : []) {
      if (!semPkg.getCharacter(characterId)) violations.push({ field: 'characters', expected: `existing_character_id:${characterId}` });
    }
    const knownProps = new Set((semPkg.catalogs.props || []).map((prop) => Number(prop.id)));
    for (const propId of Array.isArray(value.props) ? value.props : []) {
      if (!knownProps.has(Number(propId))) violations.push({ field: 'props', expected: `existing_prop_id:${propId}` });
    }
    return violations;
  };

  // 单镜 Patch 不强迫用户顺带重建历史旧槽位；只拦截本轮新引入的结构问题。
  const baselineStructural = new Set(collectStructuralViolations(persistedCandidate).map((item) => JSON.stringify(item)));
  const structuralViolations = collectStructuralViolations(parsed)
    .filter((item) => !baselineStructural.has(JSON.stringify(item)));
  const duration = Number(parsed.duration);
  if (structuralViolations.length) {
    const error = Object.assign(new Error('导演智能体微调结果的语义结构无效'), {
      status: 422,
      valid: false,
      violations: structuralViolations.map(({ field, expected }) => ({
        rule: 'INVARIANT_AGENT_SLOT_TYPE_INVALID',
        severity: 'error',
        shot_number: sb.storyboard_number,
        conflict_slots: [field],
        message: `字段 ${field} 必须满足 ${expected}`,
      })),
    });
    error.workingCandidate = parsed;
    throw error;
  }

  const baselineSlotShapes = new Set(agentSlotShapeViolations(persistedCandidate, sb.storyboard_number).map((item) => JSON.stringify([
    item.rule, item.conflict_slots || [], item.message,
  ])));
  const slotShapeViolations = agentSlotShapeViolations(parsed, sb.storyboard_number).filter((item) => !baselineSlotShapes.has(JSON.stringify([
    item.rule, item.conflict_slots || [], item.message,
  ])));
  if (slotShapeViolations.length) {
    const error = Object.assign(new Error('导演智能体微调结果缺少完整语义槽位结构'), {
      status: 422,
      valid: false,
      violations: slotShapeViolations,
    });
    error.workingCandidate = parsed;
    throw error;
  }

  const candidate = {
    ...sb,
    ...parsed,
    storyboard_number: sb.storyboard_number,
    movement: angleService.normalizeMovement(parsed.movement),
    lighting_style: angleService.normalizeLighting(parsed.lighting_style),
    depth_of_field: angleService.normalizeDof(parsed.depth_of_field),
    duration,
  };
  const scene = semPkg.getScene(parsed.scene_id);

  const persistedEpisodeShots = db.prepare(
    'SELECT * FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL ORDER BY storyboard_number ASC'
  ).all(sb.episode_id).map((row) => {
    const normalized = { ...row };
    for (const field of ['characters', 'background_characters', 'character_visuals', 'last_frame_visuals', 'video_slots', 'semantic_slots']) {
      if (typeof normalized[field] === 'string') {
        try { normalized[field] = JSON.parse(normalized[field]); } catch (_) {}
      }
    }
    return normalized;
  });
  const episodeShots = persistedEpisodeShots.map((row) => Number(row.id) === sbId ? candidate : row);
  const auditOptions = {
    db,
    props: semPkg.catalogs.props,
    dramaEra: semPkg.drama.era,
    directorPlanningMode: 'persisted',
  };
  const baselineAudit = validateAllInvariants(persistedEpisodeShots, auditOptions);
  const candidateAudit = validateAllInvariants(episodeShots, auditOptions);
  const violationSignature = (item) => JSON.stringify([
    item?.rule || '', item?.shot_number || null, item?.message || '', item?.conflict_slots || [],
  ]);
  const baselineViolations = new Set((baselineAudit.violations || []).map(violationSignature));
  // 局部 Patch 只对本轮新引入的违规负责。目标镜已有的历史缺口保持可见但不阻塞一次无关微调；
  // 一旦 Patch 改坏字段或影响相邻镜，违规签名会相对基线发生变化并被立即拦截。
  const relevantViolations = (candidateAudit.violations || []).filter(
    (item) => !baselineViolations.has(violationSignature(item))
  );
  const audit = {
    ...candidateAudit,
    valid: relevantViolations.length === 0,
    error_count: relevantViolations.length,
    violations: relevantViolations,
    ignored_preexisting_error_count: Math.max(0, (candidateAudit.error_count || 0) - relevantViolations.length),
  };
  if (!audit.valid) {
    const error = Object.assign(new Error(`单镜微调未通过视听本体硬门禁（${audit.error_count} 项）`), {
      status: 422,
      valid: false,
      violations: audit.violations,
    });
    error.workingCandidate = parsed;
    throw error;
  }

  let finalStyle = '';
  const dramaRow = db.prepare('SELECT d.style, d.metadata FROM dramas d JOIN episodes e ON e.drama_id = d.id WHERE e.id = ?').get(sb.episode_id) || {};
  const { resolvedStreamStyleFromDrama } = require('../utils/dramaStyleMerge');
  finalStyle = resolvedStreamStyleFromDrama('', dramaRow) || dramaRow.style || '';

  const { compileImagePromptFromSlots } = require('./visualSlots');
  const characterAppearances = parsed.characters.map((charId) => {
    const character = semPkg.getCharacter(charId);
    return character ? (character.appearance ? `「${character.name}」${character.appearance}` : character.name) : '';
  }).filter(Boolean).join('\n');
  const promptCandidate = {
    ...candidate,
    location: scene.location || '',
    time: scene.time || '',
    character_appearances: characterAppearances,
  };
  const imagePrompt = compileImagePromptFromSlots(promptCandidate, parsed.character_visuals, { style: finalStyle });
  const continuitySnapshot = JSON.stringify(parsed.continuity_snapshot);
  const universalSegmentText = universalOmni
    ? String(parsed.universal_segment_text || '').trim()
    : sb.universal_segment_text;
  const now = new Date().toISOString();

  db.transaction(() => {
    linkEpisodeCharacters(db, sb.episode_id, [parsed]);
    db.prepare(`
      UPDATE storyboards SET
        title = ?, scene_id = ?, location = ?, time = ?, characters = ?,
        shot_type = ?, angle_h = ?, angle_v = ?, angle_s = ?, movement = ?,
        lighting_style = ?, depth_of_field = ?, duration = ?, action = ?, result = ?,
        dialogue = ?, narration = ?, dialogue_framing = ?, bgm_prompt = ?, sound_effect = ?,
        layout_description = ?, emotion = ?, image_prompt = ?, polished_prompt = ?, video_prompt = NULL,
        character_visuals = ?, last_frame_visuals = ?, video_slots = ?, semantic_slots = ?,
        start_framing = ?, end_framing = ?, transition_to_next = ?, background_characters = ?,
        continuity_snapshot = ?, universal_segment_text = ?, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL
    `).run(
      parsed.title, Number(parsed.scene_id), scene.location || '', scene.time || '', JSON.stringify(parsed.characters),
      parsed.shot_type, parsed.angle_h, parsed.angle_v, parsed.angle_s, candidate.movement,
      candidate.lighting_style, candidate.depth_of_field, duration, parsed.action, parsed.result,
      parsed.dialogue, parsed.narration, parsed.dialogue_framing, parsed.bgm_prompt, parsed.sound_effect,
      parsed.layout_description, parsed.emotion, imagePrompt, imagePrompt,
      JSON.stringify(parsed.character_visuals), JSON.stringify(parsed.last_frame_visuals),
      JSON.stringify(parsed.video_slots), JSON.stringify(parsed.semantic_slots),
      parsed.start_framing, parsed.end_framing, parsed.transition_to_next,
      JSON.stringify(parsed.background_characters), continuitySnapshot, universalSegmentText, now, sbId
    );

    db.prepare('DELETE FROM storyboard_props WHERE storyboard_id = ?').run(sbId);
    const insertProp = db.prepare('INSERT INTO storyboard_props (storyboard_id, prop_id) VALUES (?, ?)');
    for (const propId of parsed.props) insertProp.run(sbId, Number(propId));
  })();

  const updatedSb = db.prepare('SELECT * FROM storyboards WHERE id = ?').get(sbId);
  log.info('[导演Agent] 单分镜定向原子微调已完成入库', { storyboard_id: sbId });
  return { storyboard: updatedSb, continuity_snapshot: continuitySnapshot, instruction, audit };
}

/**
 * 同一导演 Agent 的单镜局部会话：不重建整集，门禁失败时把结构化违规退回 Agent 继续 ReAct。
 * 只有单镜候选通过整集连戏门禁后才会原子更新该分镜。
 */
async function refineSingleStoryboard(db, log, cfg, storyboardId, userInstruction = '', options = {}) {
  const maxReflectionRounds = Math.max(1, Math.min(500, Number(
    options.maxReflectionRounds || options.max_reflection_rounds || 500
  )));
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  let correctionContext = '';
  let workingCandidate = null;
  let lastError = null;

  for (let round = 1; round <= maxReflectionRounds; round++) {
    onProgress(
      Math.min(95, 10 + Math.floor(((round - 1) / maxReflectionRounds) * 85)),
      round === 1
        ? '导演 Agent 正在读取本集记忆并局部修订目标分镜...'
        : `单镜 ReAct 自纠第 ${round}/${maxReflectionRounds} 轮...`
    );
    try {
      const result = await refineSingleStoryboardAttempt(
        db, log, cfg, storyboardId, userInstruction, correctionContext, workingCandidate
      );
      return { ...result, reflection_rounds: round - 1, max_reflection_rounds: maxReflectionRounds };
    } catch (error) {
      lastError = error;
      const violations = Array.isArray(error.violations) ? error.violations : [];
      if (!violations.length || round >= maxReflectionRounds) break;
      if (isPlainObject(error.workingCandidate)) {
        workingCandidate = mergeDirectorAgentPatch({}, error.workingCandidate);
      }
      correctionContext = JSON.stringify({
        error: error.message,
        violations: violations.map((item) => ({
          rule: item.rule,
          shot_number: item.shot_number,
          conflict_slots: item.conflict_slots || [],
          message: item.message,
        })),
      }, null, 2);
      log.warn('[导演Agent] 单分镜微调未通过门禁，继续 ReAct 自纠', {
        storyboard_id: Number(storyboardId),
        round,
        violations: violations.length,
        violation_details: violations.map((item) => ({
          rule: item.rule,
          conflict_slots: item.conflict_slots || [],
          message: item.message,
        })),
      });
    }
  }

  if (lastError) {
    lastError.message = `单镜导演微调经过 ${maxReflectionRounds} 轮 ReAct 仍未通过门禁：${lastError.message}`;
    throw lastError;
  }
  throw new Error('单镜导演微调未产生有效结果');
}

/**
 * 自动对齐与清理剧目中的陈旧/孤儿道具资产
 * 当道具在当前全剧所有有效集剧本中均未提及，且未被任何现有分镜引用时，执行软删除归档
 */
function reconcileObsoleteDramaAssets(db, log, dramaId) {
  const dId = Number(dramaId);
  const episodes = db.prepare('SELECT script_content FROM episodes WHERE drama_id = ? AND deleted_at IS NULL').all(dId);
  const fullDramaScript = episodes.map(e => e.script_content || '').join('\n');
  if (!fullDramaScript.trim()) return { pruned_props: 0, pruned_scenes: 0 };

  const dramaShots = db.prepare(`
    SELECT s.id, s.scene_id, sp.prop_id
    FROM storyboards s
    JOIN episodes e ON e.id = s.episode_id
    LEFT JOIN storyboard_props sp ON sp.storyboard_id = s.id
    WHERE e.drama_id = ? AND s.deleted_at IS NULL
  `).all(dId);

  let props = [];
  try {
    props = db.prepare('SELECT id, name, created_at FROM props WHERE drama_id = ? AND deleted_at IS NULL').all(dId);
  } catch (_) {
    try { props = db.prepare('SELECT id, name FROM props WHERE drama_id = ? AND deleted_at IS NULL').all(dId); } catch (__) {}
  }
  let prunedProps = 0;
  const now = new Date().toISOString();

  for (const p of props) {
    if (isAssetObsolete('prop', p, { script: fullDramaScript, shots: dramaShots })) {
      db.prepare('UPDATE props SET deleted_at = ? WHERE id = ?').run(now, p.id);
      prunedProps++;
    }
  }

  // 清理过时场地
  let scenes = [];
  try {
    scenes = db.prepare('SELECT id, location, created_at FROM scenes WHERE drama_id = ? AND deleted_at IS NULL').all(dId);
  } catch (_) {
    try { scenes = db.prepare('SELECT id, location FROM scenes WHERE drama_id = ? AND deleted_at IS NULL').all(dId); } catch (__) {}
  }
  let prunedScenes = 0;
  for (const s of scenes) {
    if (isAssetObsolete('scene', s, { script: fullDramaScript, shots: dramaShots })) {
      db.prepare('UPDATE scenes SET deleted_at = ? WHERE id = ?').run(now, s.id);
      prunedScenes++;
    }
  }

  log.info('[导演Agent] 世界观资产自动对齐完成', { drama_id: dId, pruned_props: prunedProps, pruned_scenes: prunedScenes });
  return { pruned_props: prunedProps, pruned_scenes: prunedScenes };
}

module.exports = {
  runDirectorAgent,
  auditDirectorDraft,
  runFullDramaDirectorAgent,
  refineSingleStoryboard,
  planDirectorSourceAssignments,
  validTimelineDurationPlans,
  reconcileObsoleteDramaAssets,
  directorOutputTokenBudget,
  directorRepairTokenBudget,
  buildDirectorDraftBatches,
  assertDirectorDraftBatch,
  isolateDirectorDraftBatchPrompt,
  normalizeCoverageText,
  selectDirectorRepairTarget,
  directorAtomicRepairHint,
  directorAtomicPatchSchema,
  requiresDirectorStructuralRepair,
  repairContextForViolations,
  applyDirectorRepairPlan,
  applySingleStoryboardPatch,
};
