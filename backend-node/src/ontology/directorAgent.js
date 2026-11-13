/**
 * 影视导演视听编排智能体（Audiovisual Director ReAct Agent）
 * 践行 /home/nvidia/ontology-semantic-system 的核心哲学：
 * 1. 语义图绑定：以不可变 DramaSemanticPackage 为世界事实底座
 * 2. 场面调度：按剧情规划动作过程、互动与结果，机位和切镜服务叙事
 * 3. 音画多模态：无对白分镜绑定原生 BGM 描述供 H3 视频生成
 * 4. 自我反思纠偏环（Critic & Reflection Loop）：通过 SHACL 风格的 validateAllInvariants 检验草稿，发现违规自动修正
 */

const { compileDramaSemanticPackage } = require('./semanticPackage');
const { validateAllInvariants, SpeechTimingRule, planningFeasibilityViolations } = require('./invariants');
const actionAtoms = require('./actionAtoms');
const { PERFORMANCE_CONTRACT } = actionAtoms;
const { validateVideoSlots, formatH3Timestamp } = require('./videoSlots');
const { CONTINUUM_MIN_SECONDS } = require('../services/continuumPlan');
const { validateCharacterVisualSlots, STRUCTURED_DEPTH_LAYERS, STRUCTURED_SCREEN_POSITIONS } = require('./visualSlots');
const { extractAllEntitiesFromScript } = require('./extractionAgent');
const { isAssetObsolete } = require('./assetMatcher');
const { CrossSlotInvariantsRule } = require('./rules/crossSlotRules');

const singleShotCrossSlotRule = new CrossSlotInvariantsRule();
const STAGE2_SKIPPED_CROSS_SLOT_RULES = new Set([
  'INVARIANT_MULTI_SPEAKER_SHOT',
  'INVARIANT_MID_SHOT_WARDROBE_MUTATION',
]);

function crossSlotStage2Violations(shot, catalogs = {}) {
  return singleShotCrossSlotRule
    .evaluate({ shots: [shot], catalogs, options: { directorPlanningMode: 'persisted' } })
    .filter((item) => item?.severity === 'error' && !STAGE2_SKIPPED_CROSS_SLOT_RULES.has(item.rule));
}

function normalizeTimelineTimestamps(timeline) {
  if (!Array.isArray(timeline)) return timeline;
  let expectedStart = 0;
  return timeline.map((seg, idx) => {
    if (!seg || typeof seg !== 'object') return seg;
    const timestamp = idx === 0
      ? (seg.timestamp ? formatH3Timestamp(0) : null)
      : formatH3Timestamp(expectedStart);
    const segDur = Number.isFinite(Number(seg.duration)) ? Number(seg.duration) : 0;
    expectedStart += segDur;
    const nextSeg = { ...seg, timestamp };
    const dialogue = String(seg.audio_lip_sync?.dialogue_content || '').trim();
    if (dialogue) {
      const alignment = seg.speech_action_alignment && typeof seg.speech_action_alignment === 'object'
        ? { ...seg.speech_action_alignment }
        : {};
      if (!String(alignment.mode || '').trim()) {
        alignment.mode = 'concurrent';
      }
      if (!alignment.speech_window) {
        alignment.speech_window = { start: 0, end: segDur || 2 };
      }
      if (!alignment.speaker_action_window) {
        alignment.speaker_action_window = { start: 0, end: segDur || 2 };
      }
      if (!alignment.speaker_character_id && !String(alignment.speaker_action || '').trim()) {
        const spk = seg.audio_lip_sync?.speaker_name || '角色';
        alignment.speaker_action = `${spk}开口说话并保持战术戒备姿态`;
      }
      nextSeg.speech_action_alignment = alignment;
    }
    return nextSeg;
  });
}
const agentsRuntime = require('../services/agentsRuntime');
const angleService = require('../services/angleService');
const dramaService = require('../services/dramaService');
const { generateStory } = require('../services/storyGenerationService');
const promptI18n = require('../services/promptI18n');
const pacing = require('./directorPacing');
const directorTrace = require('../services/directorTrace');
const directorCheckpoint = require('../services/directorCheckpoint');
const { linkEpisodeCharacters } = require('../services/episodeCharacterLinks');

const REQUIRED_VIDEO_SLOT_KEYS = ['performance_contract', 'camera', 'audio_lip_sync', 'trajectories', 'environment_vfx', 'timing', 'shots_timeline'];
// Shared by draft, execution planning and repairs. Semantic decisions stay with
// the Director; this is not a backend verb detector or an automatic motion patch.
const DIRECTOR_ACTION_COMPLETION_CONTRACT = `
${require('../services/narrativeStyleService').directorPrinciples()}
【对白与动作完成合同：提交前由导演自检】
- 本合同适用于全部题材、视觉风格和叙事偏好，不以任何风格选项为开关。不强制对白占比、快剪、说完必须动或所有人持续运动。
- 结合原剧本与上下镜，区分当场执行的意图、未来承诺、回忆、假设、拒绝和被打断的动作。不得仅凭台词动词强行安排动作，也不得改写台词来回避冲突。
- 对当前镜头应执行的事件，在现有 action/result、action_atom/start_state/result_state 槽位中给出起始状态、动作过程、互动对象的配合或反应、实际结束状态；轨迹与终态必须能接续。保持安静可以是剧情选择，不能成为所有人的默认动作。
- 例如当场说“爹，我扶您起来”，应规划女儿托肩背、父亲撑床配合、从半躺到坐稳；若剧情要求扶起失败，则明确尝试、受阻及实际终态。说“明天我扶您出去”不代表本镜就要起身。
- 说话与动作可以同时进行；按实际台词时间和动作时间轴完成本镜事件。不要预留固定的无台词收尾，也不要在台词结束后凭空等待；为剩余时间规划有剧情作用的动作或反应，不要用无关手势、运镜、重复动作填时长，也不必强行用满30秒。
- character_visuals 只描述起幅瞬间，last_frame_visuals（需要尾帧时）、end_framing、result 与最终 result_state 描述同一结束状态；全局 trajectories、shots_timeline 和全能分镜文本必须一致。连续动作可以在一个镜头内叙述先后阶段，不要为了分阶段而强制切镜。
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
    maxAttempts: Math.max(1, Math.min(20, Number(options.maxAttempts || options.max_attempts || 8))),
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
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 30) return [];
  // A timeline is a causal action plan, not a mandatory edit list. The
  // default is one uninterrupted beat; the Agent may split it at real camera,
  // speaker, or information changes using any positive integer durations.
  return [[seconds]];
}

function timelineDurationPlanContract(duration) {
  if (!validTimelineDurationPlans(duration).length) throw new Error(`无法为 ${duration} 秒镜头建立合法的镜内剪辑时长组合`);
  return `shots_timeline 是因果动作节拍，不是强制切镜：可以使用一个 ${duration} 秒连续段，也可以按真实的机位、说话人或信息变化拆成多个正整数秒段；每段 1～30 秒，所有段时长之和必须严格等于总时长。只有 camera.shot_change=true 时才切镜。禁止用“说完后互相看着”、无意义特写、等待或静止填满时长。`;
}

// Stage-two prompts must describe the current shot, not replay the entire
// episode database. Keep only immutable story facts and the execution fields
// that are relevant to the current repair.
function compactExecutionShot(shot, options = {}) {
  const value = shot && typeof shot === 'object' ? shot : {};
  const semantic = value.semantic_slots && typeof value.semantic_slots === 'object'
    ? value.semantic_slots : {};
  const result = {
    shot_number: value.shot_number ?? value.storyboard_number ?? null,
    title: value.title || '',
    scene_id: value.scene_id ?? null,
    duration: Number(value.duration ?? semantic.shot_duration ?? 0) || 0,
    characters: Array.isArray(value.characters) ? value.characters : [],
    background_characters: Array.isArray(value.background_characters) ? value.background_characters : [],
    props: Array.isArray(value.props) ? value.props : [],
    dialogue: value.dialogue || '',
    narration: value.narration || '',
    action: value.action || '',
    result: value.result || '',
    shot_type: value.shot_type || '',
    dialogue_framing: value.dialogue_framing || '',
    start_framing: value.start_framing || '',
    end_framing: value.end_framing || '',
    transition_to_next: value.transition_to_next || '',
    semantic_slots: {
      visible_characters: semantic.visible_characters || [],
      background_characters: semantic.background_characters || [],
      offscreen_characters: semantic.offscreen_characters || [],
      identity_visibility: semantic.identity_visibility || '',
      speech_plan: semantic.speech_plan || {},
      sound_plan: semantic.sound_plan || {},
      continuity_type: semantic.continuity_type || '',
      continuity_from_previous: semantic.continuity_from_previous || {},
      h3_mode: semantic.h3_mode || '',
      h3_mode_reason: semantic.h3_mode_reason || '',
      first_frame_policy: semantic.first_frame_policy || '',
      first_frame_reason: semantic.first_frame_reason || '',
      last_frame_policy: semantic.last_frame_policy || '',
      last_frame_reason: semantic.last_frame_reason || '',
      required_references: semantic.required_references || [],
      audio_lip_sync: semantic.audio_lip_sync || '',
      shot_duration: semantic.shot_duration ?? value.duration ?? null,
      execution_backend: semantic.execution_backend || '',
      continuum_plan: semantic.continuum_plan ?? null,
      source_script_excerpt: semantic.source_script_excerpt || '',
    },
  };
  if (options.includeExecution) {
    result.character_visuals = Array.isArray(value.character_visuals) ? value.character_visuals : [];
    result.last_frame_visuals = Array.isArray(value.last_frame_visuals) ? value.last_frame_visuals : [];
    result.video_slots = value.video_slots || {};
  }
  return result;
}

function compactExecutionCatalogs(catalogs = {}, shot = {}) {
  const ids = new Set();
  const names = new Set();
  const add = (value) => (Array.isArray(value) ? value : []).forEach((item) => {
    const id = Number(item && typeof item === 'object' ? (item.id ?? item.character_id ?? item.prop_id) : item);
    if (Number.isInteger(id) && id > 0) ids.add(id);
    const name = item && typeof item === 'object' ? item.name : (typeof item === 'string' ? item : '');
    if (String(name || '').trim()) names.add(String(name).trim());
  });
  add(shot.characters);
  add(shot.background_characters);
  add(shot.props);
  add(shot.semantic_slots?.visible_characters);
  add(shot.semantic_slots?.background_characters);
  add(shot.semantic_slots?.required_references);
  const pick = (items = []) => (Array.isArray(items) ? items : [])
    .filter((item) => ids.has(Number(item?.id)) || names.has(String(item?.name || '').trim()))
    .map((item) => ({ id: item.id, name: item.name, location: item.location, role: item.role }));
  return {
    // Characters and props are NEVER cropped to the current shot: a drama has only a
    // handful of identity characters and props (< 20 items), and an Agent that cannot see
    // real IDs will either invent invalid ones or be unable to assign entering assets if
    // Stage 1 omitted them. The catalogs are drama-scoped, so compact lists are cheap.
    characters: (Array.isArray(catalogs.characters) ? catalogs.characters : [])
      .map((item) => ({ id: item.id, name: item.name, location: item.location, role: item.role })),
    scenes: (catalogs.scenes || []).filter((item) => Number(item?.id) === Number(shot.scene_id))
      .map((item) => ({ id: item.id, name: item.name, location: item.location, time: item.time })),
    props: (Array.isArray(catalogs.props) ? catalogs.props : [])
      .map((item) => ({ id: item.id, name: item.name, type: item.type })),
  };
}

function selectBalancedPartition(partitions, sourceUnits) {
  if (!partitions || !partitions.length) return null;
  if (partitions.length === 1) return partitions[0];
  const unitLengths = new Map((sourceUnits || []).map(u => [String(u?.id || u), String(u?.text || '').length || 1]));
  let best = partitions[0];
  let minVariance = Infinity;
  for (const part of partitions) {
    const lengths = part.map(group => group.reduce((sum, id) => sum + (unitLengths.get(id) || 1), 0));
    const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const variance = lengths.reduce((sum, len) => sum + Math.pow(len - mean, 2), 0) / lengths.length;
    if (variance < minVariance) {
      minVariance = variance;
      best = part;
    }
  }
  return best;
}

async function planDirectorSourceAssignments(db, log, batch, retryOptions = {}) {
  const retry = directorRetryContext(retryOptions);
  const partitions = agentsRuntime.buildContiguousSourcePartitions(batch.source_units, batch.shot_count);
  if (!partitions.length) throw new Error(`导演初稿第 ${batch.index + 1} 批无法建立原文覆盖规划`);
  if (partitions.length === 1) return partitions[0];

  const balancedFallback = selectBalancedPartition(partitions, batch.source_units);
  const maxPlannerAttempts = retry.maxAttempts || 2;
  let lastError = null;
  for (let attempt = 1; attempt <= maxPlannerAttempts; attempt++) {
    try {
      const planned = await agentsRuntime.runAgent(db, log, {
        name: 'director-source-coverage-planner',
        instructions: '你是短剧导演的原文覆盖规划节点。只选择最符合语义节拍的连续分组；不得遗漏、重复、倒序或改写原文单元。单镜头原则上分配 1~2 个台词单元；多句正反打对白尽量均匀分配到不同镜头槽位，禁止将多轮对白集中塞入单个镜头。',
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
  log.warn(`[导演Agent] 原文覆盖规划经过 ${maxPlannerAttempts} 轮门禁反馈仍未通过，自动回退到最优连续平衡分区`, {
    batch: batch.index + 1,
    fallback: balancedFallback,
    lastError: lastError?.message,
  });
  return balancedFallback;
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
  const patched = mergeDirectorAgentPatch(current, response.patch);
  if (response.patch?.semantic_slots?.visible_characters && !response.patch?.characters) {
    patched.characters = response.patch.semantic_slots.visible_characters
      .map((c) => Number(c?.id ?? c?.character_id ?? c))
      .filter((id) => Number.isInteger(id) && id > 0);
  }
  if (response.patch?.semantic_slots?.background_characters && !response.patch?.background_characters) {
    patched.background_characters = response.patch.semantic_slots.background_characters;
  }
  if (Array.isArray(response.patch?.video_slots?.shots_timeline)) {
    patched.video_slots.shots_timeline = normalizeTimelineTimestamps(patched.video_slots.shots_timeline);
  }
  return patched;
}

function selectDirectorRepairTarget(shots, violations, skippedShots = new Set()) {
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
    const unskipped = [...byShot.keys()].filter(k => !skippedShots.has(k)).sort((a, b) => a - b);
    const shotNumber = unskipped.length > 0 ? unskipped[0] : [...byShot.keys()].sort((a, b) => a - b)[0];
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
    INVARIANT_VISUAL_ENUM_INVALID: 'character_visuals / last_frame_visuals 的每个视觉字段必须严格使用 actionAtoms 结构化枚举值，禁止退回自由文本。',
    INVARIANT_SLOT_DUPLICATE_POSITION: '多人同框时 character_visuals 的 screen_position 必须互不相同并区分前景/中景/后景。',
    INVARIANT_CHARACTER_VISUAL_SLOTS_REQUIRED: '包含出场人物的镜头必须由 Agent 显式提供结构化 character_visuals 数组。',
    INVARIANT_H3_PERFORMANCE_CONTRACT_VERSION: `video_slots.performance_contract 必须固定为 "${PERFORMANCE_CONTRACT}"。`,
    INVARIANT_UNIVERSAL_CREATION_MODE_REQUIRED: '本轮只能修改顶层 creation_mode，且值必须为 universal；不得返回 semantic_slots、video_slots 或其他字段。',
    INVARIANT_MISSING_INCOMING_CONTINUITY: '在 semantic_slots 中补齐 continuity_from_previous，必须包含 relationship、previous_end_state、entry_state、causal_link；只修复当前镜头，不能改写上一镜。',
    INVARIANT_INCOMING_CONTINUITY_INCOMPLETE: '在 semantic_slots.continuity_from_previous 中补齐门禁指出的字段，并保持上一镜结束状态、本镜进入状态和因果关系一致。',
    INVARIANT_EYELINE_MATCH_WITHOUT_EYE_TARGET: '修正 continuity_from_previous 与对应 character_visuals/video_slots 的视线目标，明确上一镜视线来源、本镜目标和注意力落点。',
    INVARIANT_SPEECH_SLOT_DIVERGENCE: '先修复台词槽位冲突，再重新评估时长：以当前镜头数据库 dialogue/narration 为不可变原文，逐字同步 semantic_slots.speech_plan.text 与 video_slots.audio_lip_sync.dialogue_content；禁止因为派生的超时结果直接拆镜或把下一镜台词带入本镜。',
    INVARIANT_CLOSE_DIALOGUE_BACKGROUND_CONFLICT: '近景/过肩/正反打双人对话构图中，背景角色容易造成面部融合或克隆人：必须将 background_characters 设为 []，semantic_slots.background_characters 设为 []；并从 character_visuals、semantic_slots.required_references 中移除背景角色（或将 dialogue_framing 改为宽景三人构图 wide_group/group_blocking）。',
    INVARIANT_CHARACTER_PARTICIPATION_CONFLICT: '同一角色在同一镜只能有一种参与方式：入画列入 visible_characters/background_characters，不入画列入 semantic_slots.offscreen_characters，必须二选一并保持顶层与 semantic_slots 一致。',
    INVARIANT_OFFSCREEN_CHARACTER_VISUALIZED: '画外参与者（semantic_slots.offscreen_characters）不入画：必须从 character_visuals、last_frame_visuals 与角色类 required_references 中移除，不得为其生成视觉定格或参考图；若该角色实际入画，改列入 visible_characters/background_characters 并确保单镜最多2人。',
    INVARIANT_SPEAKER_NOT_DECLARED: '说话人必须先声明参与方式：入画列入 visible_characters/background_characters，不入画（通讯器、画外喊话）列入 semantic_slots.offscreen_characters 并注明 mode（present_offscreen/remote_voice），再同步 speech_plan.speaker_id。',
    INVARIANT_OFFSCREEN_SPEAKER_LIP_SYNC: '说话人是画外参与者时，semantic_slots.audio_lip_sync 必须改为 offscreen_voiceover，画内全员双唇紧闭；不得把画外说话人改列入画人物清单来迁就口型模式。',
    INVARIANT_REF2VA_REFERENCE_REQUIRED: 'Ref2VA 至少需要一项有效参考合同：在 semantic_slots.required_references 中按「当前 scene_id 场景 -> visible_characters/background_characters 画内角色 -> 入画道具 props」顺序填入白名单资产 ID（1～9 项），严禁留空 [] 且严禁列入 offscreen_characters。',
    INVARIANT_UNIVERSAL_SCENE_REFERENCE_REQUIRED: '全能分镜的 semantic_slots.required_references 第 1 项必须为当前镜头 scene_id 对应的场景参考 { type:"scene", id, name }。',
    INVARIANT_UNIVERSAL_CHARACTER_REFERENCE_MISSING: '全能分镜的 semantic_slots.required_references 必须包含所有 visible_characters 与 background_characters 角色参考 { type:"character", id, character_id, name }。',
  };
  const exact = fieldRules[item.rule] || '';
  const speechExtension = item.rule === 'INVARIANT_SPEECH_OVER_BUDGET'
    && Number(item.assessment?.recommendedDuration) <= (item.max_duration ?? 8)
    ? `- 本镜无需拆外层分镜：把顶层 duration、semantic_slots.shot_duration、video_slots.timing.duration 统一延长为 ${Number(item.assessment.recommendedDuration)} 秒，并重新规划 video_slots.shots_timeline；镜内每段必须是正整数秒的连续动作节拍（1～30 秒），段时长总和必须严格等于新总时长。逐字保留台词。`
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
  if (violation?.rule === 'INVARIANT_CLOSE_DIALOGUE_BACKGROUND_CONFLICT') {
    return {
      type: 'object',
      additionalProperties: false,
      properties: {
        background_characters: { const: [] },
        dialogue_framing: { type: 'string' },
        shot_type: { type: 'string' },
        universal_segment_text: { type: 'string' },
        character_visuals: agentsRuntime.directorCharacterVisualsOutputType().schema.properties.character_visuals,
        required_references: {
          type: 'array',
          items: { type: 'object' },
        },
        semantic_slots: {
          type: 'object',
          additionalProperties: false,
          properties: {
            background_characters: { const: [] },
            required_references: {
              type: 'array',
              items: { type: 'object' },
            },
          },
        },
      },
    };
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
  const structuredVisualEnums = {
    depth_layer: STRUCTURED_DEPTH_LAYERS,
    screen_position: STRUCTURED_SCREEN_POSITIONS,
    facing: actionAtoms.FACING,
    head_pose: actionAtoms.HEAD_POSES,
    gaze_type: actionAtoms.GAZE_TYPES,
    posture: actionAtoms.POSTURES,
    hands_state: actionAtoms.HAND_STATES,
    expression: actionAtoms.EXPRESSIONS,
  };
  const slotPath = String(violation?.conflict_slots?.[0] || '');
  const visualMatch = slotPath.match(/^(character_visuals|last_frame_visuals)\[(\d+)\]\.([a-z0-9_]+)$/u);
  const visualField = visualMatch ? visualMatch[1] : (slotPath.startsWith('last_frame_visuals[') ? 'last_frame_visuals' : 'character_visuals');
  const targetField = visualMatch ? visualMatch[3] : '';
  const allowedValues = (violation?.rule === 'INVARIANT_VISUAL_ENUM_INVALID' || violation?.rule === 'INVARIANT_SLOT_DUPLICATE_POSITION')
    ? structuredVisualEnums[targetField]
    : null;
  const visuals = Array.isArray(targetShot?.[visualField]) ? targetShot[visualField] : [];
  if (!allowedValues || visuals.length === 0) return null;
  const field = targetField;
  let targetIndex = visualMatch ? Number(visualMatch[2]) : -1;
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
      if (repair.patch?.semantic_slots?.visible_characters && !repair.patch?.characters) {
        next[index].characters = repair.patch.semantic_slots.visible_characters
          .map((c) => Number(c?.id ?? c?.character_id ?? c))
          .filter((id) => Number.isInteger(id) && id > 0);
      }
      if (repair.patch?.semantic_slots?.background_characters && !repair.patch?.background_characters) {
        next[index].background_characters = repair.patch.semantic_slots.background_characters;
      }
      if (Array.isArray(repair.patch?.video_slots?.shots_timeline)) {
        next[index].video_slots.shots_timeline = normalizeTimelineTimestamps(next[index].video_slots.shots_timeline);
      }
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
      next.splice(index, 1, ...replacements.map((shot) => {
        const merged = mergeDirectorAgentPatch(baseShot, shot);
        if (merged.semantic_slots?.visible_characters && !shot.characters) {
          merged.characters = merged.semantic_slots.visible_characters
            .map((c) => Number(c?.id ?? c?.character_id ?? c))
            .filter((id) => Number.isInteger(id) && id > 0);
        }
        if (merged.semantic_slots?.background_characters && !shot.background_characters) {
          merged.background_characters = merged.semantic_slots.background_characters;
        }
        if (Array.isArray(merged.video_slots?.shots_timeline)) {
          merged.video_slots.shots_timeline = normalizeTimelineTimestamps(merged.video_slots.shots_timeline);
        }
        return merged;
      }));
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
      video_slots: s.video_slots ? {
        ...s.video_slots,
        ...(Array.isArray(s.video_slots.shots_timeline) ? {
          shots_timeline: normalizeTimelineTimestamps(s.video_slots.shots_timeline),
        } : {}),
      } : null,
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
  const normalizedShots = normalizeDirectorShots(shots, invariantOptions.directorPlanningMode === 'universal');
  const base = validateAllInvariants(normalizedShots, invariantOptions);
  const shapeErrors = directorRequiredSlotViolations(shots, invariantOptions.directorPlanningMode === 'universal');
  const candidates = [...base.violations, ...shapeErrors];
  const range = invariantOptions.requestedPacing?.range;
  if (range) {
    for (const violation of candidates) {
      if (violation.rule === 'INVARIANT_SPEECH_OVER_BUDGET') violation.max_duration = range.max;
    }
    for (const [index, shot] of shots.entries()) {
      const duration = Number(shot.duration);
      if (!Number.isInteger(duration) || duration < range.min || duration > range.max) {
        const requiresSplit = duration > range.max
          && new SpeechTimingRule().evaluate({ shots: [{ ...shot, duration: range.max }], options: invariantOptions }).length > 0;
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

function auditDirectorDraftScoped(shots, invariantOptions, previousAudit, shotNumber, options = {}) {
  const isStructural = Boolean(
    options.structural ||
    (options.previousShotCount != null && options.previousShotCount !== shots.length)
  );
  const full = auditDirectorDraft(shots, invariantOptions);
  const target = Number(shotNumber);
  const scope = isStructural
    ? new Set(shots.map((s, idx) => Number(s?.shot_number) || idx + 1))
    : new Set([target - 1, target, target + 1].filter(n => n > 0));

  return {
    ...full,
    audit_scope: [...scope].sort((a, b) => a - b),
  };
}

function shortDramaTimelineViolations(shot, timeline) {
  const normalizedTimeline = Array.isArray(timeline) ? normalizeTimelineTimestamps(timeline) : [];
  const videoSlots = {
    ...(shot.video_slots && typeof shot.video_slots === 'object' ? shot.video_slots : {}),
    shots_timeline: normalizedTimeline,
  };
  return validateVideoSlots(shot, videoSlots).filter((item) => item.severity === 'error');
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

function visualSlotViolations(shot, characterVisuals, lastFrameVisuals) {
  const expected = directorCharacterIds(shot).sort((a, b) => a - b);
  const actual = (Array.isArray(characterVisuals) ? characterVisuals : [])
    .map((item) => Number(item?.character_id)).filter((id) => id > 0).sort((a, b) => a - b);
  const violations = [];
  const push = (message, conflictSlots = ['character_visuals'], rule = 'INVARIANT_VISUAL_SLOT') => {
    violations.push({ rule, severity: 'error', conflict_slots: conflictSlots, message });
  };
  if (!Array.isArray(characterVisuals)) push('character_visuals 必须由 Agent 显式输出为数组，无人镜头输出 []，不能省略或填 null');
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    push(`character_visuals 角色 ID 必须精确为 ${JSON.stringify(expected)}，实际为 ${JSON.stringify(actual)}`);
  }
  const policy = String(shot?.semantic_slots?.last_frame_policy || shot?.last_frame_policy || 'none');
  if (policy === 'generate_tail' && !Array.isArray(lastFrameVisuals)) {
    push('需要尾帧时 last_frame_visuals 必须由 Agent 显式输出为数组', ['last_frame_visuals']);
  }
  const lastIds = (Array.isArray(lastFrameVisuals) ? lastFrameVisuals : [])
    .map((item) => Number(item?.character_id)).filter((id) => id > 0).sort((a, b) => a - b);
  if (policy === 'generate_tail' && JSON.stringify(lastIds) !== JSON.stringify(expected)) {
    push(`last_frame_policy=generate_tail 时 last_frame_visuals 必须覆盖 ${JSON.stringify(expected)}`, ['last_frame_visuals']);
  }
  if (policy !== 'generate_tail' && lastIds.length) {
    push(`last_frame_policy=${policy} 时 last_frame_visuals 必须为空数组`, ['last_frame_visuals']);
  }

  if (expected.length > 0 && Array.isArray(characterVisuals) && characterVisuals.length > 0) {
    violations.push(...validateCharacterVisualSlots(shot, characterVisuals, 'character_visuals').filter((item) => item.severity === 'error'));
  }
  if (policy === 'generate_tail' && expected.length > 0 && Array.isArray(lastFrameVisuals) && lastFrameVisuals.length > 0) {
    violations.push(...validateCharacterVisualSlots(shot, lastFrameVisuals, 'last_frame_visuals').filter((item) => item.severity === 'error'));
  }
  return violations;
}

// Generate framing and the execution timeline together. They are two views of
// the same performance and should not be planned by independent agents.
async function ensureDirectorExecutionSlots(db, log, shot, retryOptions = {}) {
  const retry = directorRetryContext(retryOptions);
  // Execution-slot repair is an Agent loop.  Six attempts was too small for a
  // long structured contract and made a recoverable field omission terminal.
  // Keep a finite, configurable safety ceiling, but default to the same 20
  // rounds used by the director retry context.
  const maxAttempts = Math.max(1, Math.min(20, Number(retryOptions.maxAttempts || retryOptions.max_attempts || 20)));
  // Database rows use storyboard_number; the in-memory director payload uses
  // shot_number.  Always resolve one display number so failures can be tied
  // back to the actual storyboard instead of being reported as #undefined.
  const shotNumber = shot?.shot_number || shot?.storyboard_number || shot?.id || '?';
  const planningViolations = planningFeasibilityViolations([shot], { catalogs: retryOptions.catalogs || {} });
  if (planningViolations.length) {
    const error = new Error(`分镜 #${shotNumber} 的导演规划不可执行：${planningViolations.map((item) => item.message).join('；')}`);
    error.status = 422;
    error.violations = planningViolations;
    throw error;
  }
  const semantic = shot?.semantic_slots && typeof shot.semantic_slots === 'object' ? shot.semantic_slots : {};
  const duration = Number(semantic.shot_duration || shot.duration || 5);
  const durationPlanContract = timelineDurationPlanContract(duration);
  const lastFramePolicy = String(semantic.last_frame_policy || shot.last_frame_policy || 'none');
  const allowTailVisuals = lastFramePolicy === 'generate_tail';
  const requireSemantic = retryOptions.forceAgent === true;
  const semanticRequired = [
    ['visible_characters', Array.isArray(semantic.visible_characters)],
    ['background_characters', Array.isArray(semantic.background_characters)],
    ['speech_plan', semantic.speech_plan && typeof semantic.speech_plan === 'object'],
    ['h3_mode', semantic.h3_mode === 'ref2va'],
    ['first_frame_policy', typeof semantic.first_frame_policy === 'string'],
    ['last_frame_policy', typeof semantic.last_frame_policy === 'string'],
    ['required_references', Array.isArray(semantic.required_references)],
    ['source_script_excerpt', typeof semantic.source_script_excerpt === 'string'],
    ['shot_duration', Number.isFinite(Number(semantic.shot_duration))],
    ['continuity_from_previous', semantic.continuity_from_previous && typeof semantic.continuity_from_previous === 'object'],
  ];
  const continuityRequired = ['relationship', 'previous_end_state', 'entry_state', 'causal_link', 'sound_bridge', 'requires_previous_tail'];
  const continuityMissing = (value) => continuityRequired.filter((field) => {
    if (!value || typeof value !== 'object') return true;
    if (field === 'requires_previous_tail') return typeof value[field] !== 'boolean';
    return typeof value[field] !== 'string';
  });
  const continuityErrors = (value) => continuityMissing(value).map((field) => ({ message: `缺少 Agent 规划的 semantic_slots.continuity_from_previous.${field}` }));
  let errors = [
    ...(requireSemantic ? semanticRequired.filter(([, valid]) => !valid).map(([field]) => ({ message: `缺少 Agent 规划的 semantic_slots.${field}` })) : []),
    ...(requireSemantic ? continuityErrors(semantic.continuity_from_previous) : []),
    ...visualSlotViolations(shot, shot.character_visuals, shot.last_frame_visuals),
    ...(shot.video_slots && typeof shot.video_slots === 'object'
      ? shortDramaTimelineViolations(shot, shot.video_slots.shots_timeline)
      : [{ message: '缺少 video_slots，必须与人物定格和动作时间轴一起规划' }]),
  ];
  if (shot.video_slots && Math.abs(Number(shot.video_slots?.timing?.duration || 0) - duration) > 0.1) {
    errors.push({ message: `video_slots.timing.duration 必须等于权威时长 ${duration} 秒` });
  }
  if (retryOptions.forceAgent) errors.push({ message: '按阶段二合同要求重新由导演 Agent 完整规划 semantic_slots、character_visuals、last_frame_visuals 和 video_slots' });
  if (Array.isArray(retryOptions.invariantViolations) && retryOptions.invariantViolations.length) {
    errors.push(...retryOptions.invariantViolations.map((item) => (
      item && typeof item === 'object' ? item : { message: String(item) }
    )));
  }
  if (errors.length === 0) return shot;

  let currentShot = shot;
  const semanticCharacterIds = (value, background = false) => {
    const list = Array.isArray(value) ? value : [];
    return list.map(item => Number(item && typeof item === 'object'
      ? (background ? (item.character_id ?? item.id) : (item.id ?? item.character_id))
      : item)).filter(id => Number.isInteger(id) && id > 0).sort((a, b) => a - b);
  };
  const resolveRosterIds = (value) => {
    const catalog = Array.isArray(retryOptions.catalogs?.characters) ? retryOptions.catalogs.characters : [];
    const byName = new Map(catalog.map(item => [String(item?.name || '').trim(), Number(item?.id)]));
    const list = Array.isArray(value) ? value : [];
    return list.map(item => {
      const raw = item && typeof item === 'object' ? (item.id ?? item.character_id ?? item.name) : item;
      const numeric = Number(raw);
      if (Number.isInteger(numeric) && numeric > 0) return numeric;
      return byName.get(String(raw || '').trim()) || 0;
    }).filter(id => Number.isInteger(id) && id > 0).sort((a, b) => a - b);
  };
  const sameIds = (left, right) => left.length === right.length && left.every((id, index) => id === right[index]);
  // Stage one owns the identity roster. If its semantic arrays are not yet
  // present, lock the top-level draft roster (names are resolved through the
  // immutable catalog) so stage two cannot invent background characters from
  // a free-text action description.
  const lockedVisibleIds = Array.isArray(semantic.visible_characters)
    ? semanticCharacterIds(semantic.visible_characters)
    : resolveRosterIds(shot.characters);
  const lockedBackgroundIds = Array.isArray(semantic.background_characters)
    ? semanticCharacterIds(semantic.background_characters, true)
    : resolveRosterIds(shot.background_characters);
  // Offscreen participation has no top-level fallback roster: lock it only
  // when stage one explicitly declared the array. When stage one produced no
  // semantic_slots (base-generation chain), stage two is the author of the
  // offscreen list — locking it to [] would make every remote/offscreen
  // speaker unsatisfiable (declare it -> lock error; omit it -> speaker
  // not declared). The asset gate still validates whatever stage two declares.
  const hasOffscreenContract = Array.isArray(semantic.offscreen_characters);
  const lockedOffscreenIds = hasOffscreenContract
    ? semanticCharacterIds(semantic.offscreen_characters, true)
    : [];
  const hasLockedCharacterContract = Array.isArray(semantic.visible_characters)
    || Array.isArray(shot.characters);
  let lastFatalError = null;
  let hasValidAgentOutput = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Each retry must see the latest candidate. Sending the original shot
      // made the loop forget every previous repair and repeat the same omission.
      const candidateBase = currentShot;
      const patchMode = attempt > 1;
      const patchFields = new Set();
      let hasUnclassifiedViolation = false;
      const classifySlot = (slot, targetSet) => {
        const s = String(slot || '');
        if (!s) return;
        if (s.startsWith('character_visuals')) targetSet.add('character_visuals');
        else if (s.startsWith('last_frame_visuals')) targetSet.add('last_frame_visuals');
        else if (s.startsWith('semantic_slots') || /^(?:characters|background_characters|offscreen_characters|visible_characters|scene_id|props|required_references|h3_mode|first_frame_policy|last_frame_policy|identity_visibility|dialogue_framing|wardrobe_id|speech_plan|sound_plan|continuity_|execution_backend|continuum_plan)/.test(s)) targetSet.add('semantic_slots');
        else if (s.startsWith('video_slots') || /^(?:shots_timeline|audio_lip_sync|speech_action_alignment|timing|trajectories|video_prompt)/.test(s)) {
          targetSet.add('video_slots');
          if (s === 'audio_lip_sync') targetSet.add('semantic_slots');
        }
      };
      const classifyRule = (rule, targetSet) => {
        const r = String(rule || '');
        if (!r) return;
        if (/CHARACTER_VISUAL|FACING|GAZE|POSTURE|FRAME_VISUAL|DUPLICATE_POSITION|VISUAL_ENUM/.test(r)) targetSet.add('character_visuals');
        if (/LAST_FRAME|TAIL/.test(r)) targetSet.add('last_frame_visuals');
        if (/CHARACTER|OFFSCREEN|SPEAKER_NOT_DECLARED|OFFSCREEN_SPEAKER_LIP_SYNC|CONTINUITY|REQUIRED_REF|UNKNOWN_.*REFERENCE|SCENE_REFERENCE_REQUIRED|CHARACTER_REFERENCE_MISSING|IMAGE_TAG_DANGLING|EYELINE|REF2VA_|FL2VA_|NARRATION_SPEAKER|FRAMING_CHARACTER|CLOSE_DIALOGUE_BACKGROUND|DUAL_ROLE|IDENTITY_VISIBILITY|CONTINUUM_|SINGLE_BACKEND|EXECUTION_BACKEND/.test(r)) targetSet.add('semantic_slots');
        if (/TIMELINE|TRAJECTORY|LISTENER|ACTION_|SPEAKER_|SHORT_DRAMA_|VIDEO|SPEECH_ACTION|PACING|SPEECH_SLOT|NONVERBAL_|EXECUTION_BACKEND/.test(r)) targetSet.add('video_slots');
        if (/NARRATION_SPEAKER|SPEECH_SLOT|SPEAKER_SLOT|NONVERBAL_SHOT_SPEECH/.test(r)) targetSet.add('semantic_slots');
      };
      for (const item of errors) {
        const matchedForItem = new Set();
        if (Array.isArray(item?.conflict_slots)) {
          item.conflict_slots.forEach(slot => classifySlot(slot, matchedForItem));
        }
        if (item?.rule) classifyRule(item.rule, matchedForItem);
        const message = String(item?.message || item || '');
        if (/character_visuals/.test(message)) matchedForItem.add('character_visuals');
        if (/last_frame_visuals/.test(message)) matchedForItem.add('last_frame_visuals');
        if (/semantic_slots|continuity|source_script_excerpt|h3_mode|人物清单|offscreen|画外参与/.test(message)) matchedForItem.add('semantic_slots');
        if (/video_slots|时间轴|时间线|动作|轨迹|听者|target_id|shots_timeline|visible_characters|未入画|speaker_synced|mouth_state|角色 ID .*第 .*段|trajectory|audio_lip_sync|对白/.test(message)) matchedForItem.add('video_slots');
        matchedForItem.forEach(field => patchFields.add(field));
        // A partial match must never narrow the Agent out of the field it
        // actually needs: any violation this classifier cannot place widens
        // the whole round to full repair permission instead of deadlocking.
        if (!matchedForItem.size) hasUnclassifiedViolation = true;
      }
      if (!patchFields.size || hasUnclassifiedViolation) ['semantic_slots', 'character_visuals', 'last_frame_visuals', 'video_slots'].forEach(field => patchFields.add(field));
      const compactCandidate = compactExecutionShot(candidateBase, { includeExecution: patchMode });
      const compactNeighbours = [retryOptions.previousShot, retryOptions.nextShot]
        .filter(Boolean).map(item => compactExecutionShot(item));
      const compactCatalogs = compactExecutionCatalogs(retryOptions.catalogs || {}, candidateBase);
      const rosterLockLine = hasOffscreenContract
        ? `【阶段一锁定人物】visible=${JSON.stringify(lockedVisibleIds)}，background=${JSON.stringify(lockedBackgroundIds)}，offscreen=${JSON.stringify(lockedOffscreenIds)}。不得新增、删除或在三类之间挪动角色。offscreen 是画外参与者（同场画外/通讯远程），不入画：不得为其生成 character_visuals、轨迹或参考图，只影响声音与画内人物的视线/反应。`
        : `【阶段一锁定人物】visible=${JSON.stringify(lockedVisibleIds)}，background=${JSON.stringify(lockedBackgroundIds)}。不得新增、删除或改角色归属。offscreen 阶段一未声明、未锁定：按对白声源与本镜事件如实填写 semantic_slots.offscreen_characters——通过通讯器/画外说话的人、被喊话的远程对象必须登记并注明 mode（present_offscreen/remote_voice），说话人必须出现在 visible/background/offscreen 之一；画外参与者不入画，不得为其生成 character_visuals、轨迹或参考图。`;
      const gateFeedbackText = errors.map((item) => {
        const msg = String(item?.message || item || '');
        const slots = Array.isArray(item?.conflict_slots) && item.conflict_slots.length
          ? ` [冲突字段: ${item.conflict_slots.join(', ')}]`
          : '';
        return `${msg}${slots}`;
      }).join('；');
      const requestInput = patchMode
        ? `${rosterLockLine}
【权威镜头事实】${JSON.stringify(compactExecutionShot(candidateBase))}
【当前已有执行槽位】${JSON.stringify(compactCandidate)}
【允许修复字段】${JSON.stringify([...patchFields])}
【相邻镜头连续性摘要】${JSON.stringify(compactNeighbours)}
【本体资产白名单】${JSON.stringify(compactCatalogs)}
【门禁反馈】${gateFeedbackText}
只返回 {"repairs":[{"shot_number":${Number(shotNumber) || 0},"patch":{...}}]}。patch 只能包含允许修复字段；character_visuals 和 video_slots.shots_timeline 必须返回该字段的完整新值，其他字段保持不变。`
        : `${rosterLockLine}
【权威镜头事实】${JSON.stringify(compactExecutionShot(candidateBase))}
【相邻镜头连续性摘要】${JSON.stringify(compactNeighbours)}
【本体资产白名单】${JSON.stringify(compactCatalogs)}
【门禁反馈】${gateFeedbackText}
必须输出当前镜头完整执行合同。`;
      const expectedExecutionBackend = duration >= CONTINUUM_MIN_SECONDS ? 'h3_continuum' : 'h3_single';
      const executionBackendContract = expectedExecutionBackend === 'h3_continuum'
        ? `当前镜头时长为 ${duration} 秒（≥${CONTINUUM_MIN_SECONDS}秒），semantic_slots.execution_backend 必须固定填 'h3_continuum'，且 continuum_plan.total_duration 等于 ${duration}`
        : `当前镜头时长为 ${duration} 秒（4～8秒普通 H3），semantic_slots.execution_backend 必须固定填 'h3_single'，且 semantic_slots.continuum_plan 必须固定填 null`;
      const requiredReferencesContract = 'semantic_slots.required_references 必须从【本体资产白名单】与本镜权威资产按顺序填写 1～9 项，严禁留空 []：第 1 项为当前 scene_id 对应场景（{ type:"scene", id, name }），随后依次填入全部画内主体 visible_characters、background_characters（{ type:"character", id, character_id:id, name }）与本镜实际入画道具 props（{ type:"prop", id, name }），严禁列入 offscreen_characters。';
      const planned = await agentsRuntime.runAgent(db, log, {
        name: 'director-execution-slots-planner',
        instructions: patchMode
          ? `你是短剧导演执行合同的局部修复节点。只修复门禁反馈列出的字段，禁止改写人物清单、场景、对白、旁白、总时长和其他已通过字段。h3_mode 固定 ref2va 时，semantic_slots.first_frame_policy 与 semantic_slots.last_frame_policy 必须固定填 'none'。${requiredReferencesContract}${executionBackendContract}。当镜头已有角色对白（dialogue 非空且 narration 为空）时，speech_plan.is_narration 必须为 false、text 与 dialogue 台词逐字一致，严禁把角色台词标为旁白。character_visuals 必须精确覆盖权威人物且每人有实际定格、多人不得占用完全相同的 screen_position；video_slots.shots_timeline 必须让每位画内角色在该段有与事件同步的动作或反应。凡存在对白的 timeline 段，speech_action_alignment.mode 固定填 'concurrent'（禁止填 sync/deliberate_pause/none），画内说话人 character_trajectories[].mouth_state 固定填 'speaker_synced'。当【本体资产白名单】的 props 为空或不含目标物体时，动作 target_type 禁止填 'prop'（无有效 target_id 必被门禁拒绝），改用 'event' 或 'scene' 并填写 target_label。只返回指定 repairs JSON，不要解释。`
          : `你是短剧导演执行合同节点。根据紧凑的当前镜头事实，一次输出完整 semantic_slots、character_visuals、last_frame_visuals 和 video_slots。禁止改写人物清单、场景、对白、旁白和总时长。semantic_slots.continuity_from_previous 必须完整；h3_mode 固定 ref2va，first_frame_policy 与 last_frame_policy 必须固定填 'none'；${requiredReferencesContract}${executionBackendContract}；当镜头已有角色对白（dialogue 非空且 narration 为空）时，speech_plan.is_narration 必须为 false，严禁把角色台词标为旁白。performance_contract 固定 ${PERFORMANCE_CONTRACT}；多人同框时 character_visuals 的 screen_position 必须互相错开。动作与对白必须同步，所有画内人物都要有本段可执行动作或反应；有对白段 speech_action_alignment.mode 固定填 'concurrent'，画内说话人 character_trajectories[].mouth_state 固定填 'speaker_synced'。当【本体资产白名单】的 props 为空或不含目标物体时，动作 target_type 禁止填 'prop'（无有效 target_id 必被门禁拒绝），改用 'event' 或 'scene' 并填写 target_label。动作与画面描述必须是可拍摄的纯写实物理事件，严禁文学心理隐喻及在画面中描述 UI 元素（如血条、准星、倒计时悬浮窗、屏幕小字）。${durationPlanContract}。只返回指定 JSON，不要解释。`,
        input: requestInput,
        outputType: patchMode
          ? agentsRuntime.directorExecutionRepairOutputType(shotNumber)
          : agentsRuntime.directorExecutionSlotsOutputType(duration, { lastFramePolicy, allowTailVisuals }),
        thinking: 'enabled',
        maxTokens: 24576,
        temperature: 0.2,
      });
      hasValidAgentOutput = true;
      const plannedPatch = patchMode ? (planned?.repairs?.[0]?.patch || {}) : planned;
      const plannedVideoSlots = plannedPatch?.video_slots ? {
        ...(patchMode ? (candidateBase.video_slots || {}) : {}),
        ...plannedPatch.video_slots,
        ...(Array.isArray(plannedPatch.video_slots.shots_timeline) ? {
          shots_timeline: normalizeTimelineTimestamps(plannedPatch.video_slots.shots_timeline),
        } : {}),
      } : null;
      // Merge the new execution contract onto the latest candidate so a
      // partial response does not erase fields that already passed review.
      const mergedSemantic = plannedPatch?.semantic_slots
        ? Object.entries(plannedPatch.semantic_slots).reduce((merged, [key, value]) => {
          if (value && typeof value === 'object' && !Array.isArray(value)
            && merged[key] && typeof merged[key] === 'object' && !Array.isArray(merged[key])) {
            merged[key] = { ...merged[key], ...value };
          } else {
            merged[key] = value;
          }
          return merged;
        }, { ...(candidateBase.semantic_slots || {}) })
        : (patchMode ? candidateBase.semantic_slots : plannedPatch?.semantic_slots);
      currentShot = {
        ...candidateBase,
        // 阶段二 forceAgent 必须拿到 Agent 新输出的 semantic_slots；旧深度路径
        // 若只返回视觉/视频补丁则保留原语义，避免破坏断点恢复。
        semantic_slots: mergedSemantic,
        character_visuals: plannedPatch?.character_visuals ?? (patchMode ? candidateBase.character_visuals : undefined),
        last_frame_visuals: plannedPatch?.last_frame_visuals ?? (patchMode ? candidateBase.last_frame_visuals : undefined),
        video_slots: plannedVideoSlots ?? (patchMode ? candidateBase.video_slots : plannedPatch?.video_slots),
      };
      const plannedSemantic = currentShot.semantic_slots && typeof currentShot.semantic_slots === 'object'
        ? currentShot.semantic_slots
        : {};
      errors = [
        ...(requireSemantic ? [
          ['visible_characters', Array.isArray(plannedSemantic.visible_characters)],
          ['background_characters', Array.isArray(plannedSemantic.background_characters)],
          ['speech_plan', plannedSemantic.speech_plan && typeof plannedSemantic.speech_plan === 'object'],
          ['h3_mode', plannedSemantic.h3_mode === 'ref2va'],
          ['first_frame_policy', typeof plannedSemantic.first_frame_policy === 'string'],
          ['last_frame_policy', typeof plannedSemantic.last_frame_policy === 'string'],
          ['required_references', Array.isArray(plannedSemantic.required_references)],
          ['source_script_excerpt', typeof plannedSemantic.source_script_excerpt === 'string'],
          ['shot_duration', Number.isFinite(Number(plannedSemantic.shot_duration))],
          ['continuity_from_previous', plannedSemantic.continuity_from_previous && typeof plannedSemantic.continuity_from_previous === 'object'],
        ].filter(([, valid]) => !valid).map(([field]) => ({ message: `Agent 未输出 semantic_slots.${field}` })) : []),
        ...(requireSemantic ? continuityErrors(plannedSemantic.continuity_from_previous) : []),
        ...visualSlotViolations(currentShot, currentShot.character_visuals, currentShot.last_frame_visuals),
        ...shortDramaTimelineViolations(currentShot, currentShot.video_slots?.shots_timeline),
      ];
      // Stage one owns the story structure.  Stage two may fill execution
      // fields, but it must not add/remove identity characters while repairing
      // those fields.  Otherwise the required visual IDs become impossible to
      // satisfy and the error only appears much later as a misleading array
      // mismatch.
      if (requireSemantic && hasLockedCharacterContract) {
        const plannedVisibleIds = semanticCharacterIds(plannedSemantic.visible_characters);
        const plannedBackgroundIds = semanticCharacterIds(plannedSemantic.background_characters, true);
        const plannedOffscreenIds = semanticCharacterIds(plannedSemantic.offscreen_characters, true);
        if (!sameIds(lockedVisibleIds, plannedVisibleIds) || !sameIds(lockedBackgroundIds, plannedBackgroundIds) || (hasOffscreenContract && !sameIds(lockedOffscreenIds, plannedOffscreenIds))) {
          errors.push({ message: `阶段二不得改写阶段一锁定的人物清单：visible_characters 应为 ${JSON.stringify(lockedVisibleIds)}、background_characters 应为 ${JSON.stringify(lockedBackgroundIds)}、offscreen_characters 应为 ${JSON.stringify(lockedOffscreenIds)}，Agent 实际输出为 visible_characters=${JSON.stringify(plannedVisibleIds)}、background_characters=${JSON.stringify(plannedBackgroundIds)}、offscreen_characters=${JSON.stringify(plannedOffscreenIds)}` });
        }
        const planningDrift = planningFeasibilityViolations([currentShot], { catalogs: retryOptions.catalogs || {} });
        errors.push(...planningDrift.map(item => ({ message: item.message })));
      }
      if (requireSemantic) {
        const existingMsgs = new Set(errors.map((item) => String(item?.message || item || '')));
        for (const v of crossSlotStage2Violations(currentShot, retryOptions.catalogs || {})) {
          if (!existingMsgs.has(v.message)) {
            errors.push(v);
            existingMsgs.add(v.message);
          }
        }
      }
      if (requireSemantic && typeof semantic.source_script_excerpt === 'string'
        && plannedSemantic.source_script_excerpt !== semantic.source_script_excerpt) {
        errors.push({ message: 'semantic_slots.source_script_excerpt 必须保持阶段一/原剧本覆盖证据不变，不能由执行槽位 Agent 改写' });
      }
      if (Math.abs(Number(currentShot.video_slots?.timing?.duration || 0) - duration) > 0.1) {
        errors.push({ message: `video_slots.timing.duration 必须等于权威时长 ${duration} 秒` });
      }
      retryOptions.checkpoint?.record?.({
        stage: 'stage2',
        shot_number: Number(shotNumber) || null,
        round: attempt,
        type: 'agent_response',
        payload: { errors, output: planned },
      });
      retryOptions.checkpoint?.save?.();
      if (errors.length === 0) {
        // Report successful completion as well as retries.  Without this
        // callback the two-stage runner leaves the task row showing the last
        // shot that started, even while later shots are already running.
        retry.onProgress(`分镜 #${shotNumber} 执行合同已通过`);
        return currentShot;
      }

      reportDirectorLayerRetry(retry, `分镜 #${shotNumber} 视听执行合同`, attempt, errors.map(item => item.message).join('；'));
    } catch (error) {
      // Schema/protocol failures happen before the model can produce a
      // candidate. Retrying the identical invalid request only burns the
      // entire retry budget and hides the actual deployment bug.
      if (/json schema|schema error|schema must be|invalid schema|response_format/i.test(String(error?.message || ''))) {
        error.status = error.status || 502;
        throw error;
      }
      lastFatalError = error;
      errors = [{ message: `视听执行合同 Agent 输出格式失败：${error.message}` }];
      reportDirectorLayerRetry(retry, `分镜 #${shotNumber} 视听执行合同`, attempt, errors[0].message);
    }
  }

  if (!hasValidAgentOutput && lastFatalError) {
    throw lastFatalError;
  }

  throw new Error(`分镜 #${shotNumber} 的视听执行合同经过 ${maxAttempts} 轮门禁反馈仍未通过：${errors.map(item => item.message).join('；')}`);
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
    const { runTwoStageDirectorPipeline } = require('./directorEnrichmentService');
    const epRes = await runTwoStageDirectorPipeline(db, log, cfg, ep.id, {
      storyboardCount: options.storyboardCount ?? options.storyboard_count,
      videoDuration: options.videoDuration ?? options.video_duration,
      forceExtractEntities: false, // 实体已在阶段二统一抽取
      userDirectives: options.userDirectives || options.directives || options.feedback,
      universal_omni_storyboard: options.universal_omni_storyboard ?? options.universalOmniStoryboard,
    });
    const epShots = epRes?.stage2?.shots || epRes?.storyboards || db.prepare('SELECT id FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL').all(ep.id);
    episodeResults.push({
      episode_id: ep.id,
      episode_number: ep.episode_number,
      title: ep.title,
      shot_count: Number(epRes.total_shots || epShots.length || 0),
      audit: epRes.audit,
      semantic_revision: null,
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
直接对话默认建立说话人与受话人的视线轴；故意不看对方时必须在 reaction_trigger/gaze_target_label 写明剧情理由。咳嗽、吐血、受伤、摔倒、拔刀或发光等事件发生后，所有应当反应的画内角色必须在对应镜内段同步更新 facing、head_pose、gaze_type、gaze_target_id、gaze_target_label、posture、hands_state、expression 与 reaction_trigger。
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
- 若需要新增或修复 video_slots，video_slots.performance_contract 必须固定为 "${PERFORMANCE_CONTRACT}"；shots_timeline 每段必须且只能使用以下执行字段名：shot_number、timestamp、duration、camera、visible_characters、action、result、audio_lip_sync、speech_action_alignment、character_trajectories。visible_characters 是本段实际入画人物，character_trajectories 必须且只能覆盖这些人物；特写、过肩和画外音可以使用外层人物清单的子集。timestamp 第一段可为 null，后续段使用 "00:02.000" 这类整数秒起始时间；duration 必须是正整数且不超过本镜总时长，全部段之和必须等于本镜总时长。camera 必须包含 shot_type、movement、movement_description。character_trajectories 必须且只能覆盖该段 visible_characters，每项使用结构化枚举契约（character_id、name、start_state、action_atom、result_state、reaction_trigger、facing、facing_target_id、head_pose、gaze_type、gaze_target_id、gaze_target_label、posture、hands_state、hands_object_id、hands_target_id、expression、expression_detail、mouth_state）；禁止使用小数秒、segment、time、beat、dialogue_text、duration_seconds 或旧版 V1 自由文本字段。
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
  const maxReflectionRounds = Math.max(1, Math.min(10, Number(
    options.maxReflectionRounds || options.max_reflection_rounds || 6
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
  auditDirectorDraftScoped,
  normalizeTimelineTimestamps,
  ensureDirectorExecutionSlots,
};
