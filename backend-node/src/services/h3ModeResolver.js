/**
 * MiniMax-H3 执行方案编译器。
 * 模式与参考帧由导演 Agent 写入 semantic_slots；执行层只应用人工覆盖、
 * 校验物理约束并编译请求，禁止根据对白或素材反向猜测创作意图。
 */

const H3_MODES = new Set(['fl2va', 'ref2va']);
const FIRST_FRAME_POLICIES = new Set(['none', 'generate_new', 'inherit_tail', 'layout_lock']);
const LAST_FRAME_POLICIES = new Set(['none', 'generate_tail']);

function semanticSlots(shot) {
  let slots = shot?.semantic_slots || shot || {};
  if (typeof slots === 'string') {
    try { slots = JSON.parse(slots); } catch (_) { return {}; }
  }
  return slots && typeof slots === 'object' && !Array.isArray(slots) ? slots : {};
}

function jsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function entityId(value) {
  const id = Number(value && typeof value === 'object'
    ? (value.id ?? value.character_id ?? value.scene_id ?? value.prop_id)
    : value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * 用户把一个 Agent 规划的 FL2VA 镜头人工切换为 Ref2VA 时，原合同按规则没有
 * required_references。此时把已经由导演明确落库的场景、画内人物、背景人物和
 * 道具关联展开为执行参考合同。这里只映射既有实体关系，不推断或删改创作语义。
 */
function deriveManualRef2vaReferences(db, dramaId, shot) {
  if (!db || !dramaId || !shot?.id) return [];
  const refs = [];
  const seen = new Set();
  const add = (type, id, name, extra = {}) => {
    id = entityId(id);
    if (!id) return;
    const key = `${type}:${id}:${extra.stage_id || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ type, id, name: name || `${type}:${id}`, ...extra });
  };

  const sceneId = entityId(shot.scene_id);
  if (sceneId) {
    const scene = db.prepare('SELECT * FROM scenes WHERE id=? AND drama_id=? AND deleted_at IS NULL').get(sceneId, Number(dramaId));
    if (scene) add('scene', scene.id, scene.name || scene.location || shot.location || `场景 ${scene.id}`);
  }

  const slots = semanticSlots(shot);
  const characterCandidates = [
    ...jsonArray(shot.characters),
    ...(Array.isArray(slots.visible_characters) ? slots.visible_characters : []),
    ...(Array.isArray(slots.background_characters) ? slots.background_characters : []),
    ...db.prepare('SELECT character_id FROM storyboard_characters WHERE storyboard_id=? ORDER BY id').all(Number(shot.id)),
  ];
  for (const candidate of characterCandidates) {
    const id = entityId(candidate);
    if (!id) continue;
    const character = db.prepare('SELECT id,name,local_path FROM characters WHERE id=? AND drama_id=? AND deleted_at IS NULL').get(id, Number(dramaId));
    if (character) {
      let kind = 'character';
      try {
        const generated = character.local_path
          ? db.prepare('SELECT prompt FROM image_generations WHERE character_id=? AND local_path=? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1').get(character.id, character.local_path)
          : null;
        if (/reference sheet|四视图|四格|角色参考表/i.test(generated?.prompt || '')) kind = 'character_sheet';
      } catch (_) {}
      add('character', character.id, character.name, { character_id: character.id, kind });
    }
  }

  const props = db.prepare(`SELECT p.id,p.name FROM props p
    JOIN storyboard_props sp ON sp.prop_id=p.id
    WHERE sp.storyboard_id=? AND p.drama_id=? AND p.deleted_at IS NULL ORDER BY p.id`).all(Number(shot.id), Number(dramaId));
  for (const prop of props) add('prop', prop.id, prop.name);
  return refs;
}

function violation(rule, message, conflictSlots) {
  return { rule, message, conflict_slots: conflictSlots };
}

function resolveH3Mode(shot, context = {}) {
  const slots = semanticSlots(shot);
  const plannedMode = H3_MODES.has(slots.h3_mode) ? slots.h3_mode : null;
  const requestedOverride = context.manualModeOverride || shot?.h3_manual_mode || null;
  const manualMode = H3_MODES.has(requestedOverride) ? requestedOverride : null;
  const mode = manualMode || plannedMode;
  const requestedFirstOverride = context.manualFirstFramePolicy || shot?.h3_manual_first_frame_policy || null;
  const manualFirstFramePolicy = FIRST_FRAME_POLICIES.has(requestedFirstOverride) ? requestedFirstOverride : null;
  const requestedLastOverride = context.manualLastFramePolicy || shot?.h3_manual_last_frame_policy || null;
  const manualLastFramePolicy = LAST_FRAME_POLICIES.has(requestedLastOverride) ? requestedLastOverride : null;
  const rawRefs = Array.isArray(slots.required_references) ? slots.required_references : [];
  const manualRefs = Array.isArray(context.manualReferences) ? context.manualReferences : [];
  const usesManualReferenceContract = manualMode === 'ref2va' && rawRefs.length === 0 && manualRefs.length > 0;
  const effectiveRefs = usesManualReferenceContract ? manualRefs : rawRefs;
  const speechPlan = slots.speech_plan && typeof slots.speech_plan === 'object' ? slots.speech_plan : {};
  const plannedAudioRefs = Array.isArray(speechPlan.audio_references) ? speechPlan.audio_references : [];
  const characterVoices = context.characterVoices || {};
  const speakerId = speechPlan.speaker_id || shot?.speaker_id || null;
  const runtimeVoice = speakerId && characterVoices[speakerId] ? characterVoices[speakerId] : null;
  const audioRefs = runtimeVoice && !plannedAudioRefs.includes(runtimeVoice)
    ? [...plannedAudioRefs, runtimeVoice]
    : plannedAudioRefs;
  const violations = [];

  if (!mode) {
    violations.push(violation(
      'INVARIANT_H3_MODE_PLAN_MISSING',
      '导演 Agent 未规划 semantic_slots.h3_mode，禁止执行层按素材或对白静默猜测 FL2VA/Ref2VA；请重新生成或修订分镜计划',
      ['semantic_slots.h3_mode']
    ));
  }
  if (effectiveRefs.length > 9) {
    violations.push(violation(
      'INVARIANT_REFERENCE_CAPACITY_EXCEEDED',
      `MiniMax-H3 单镜最多支持 9 张参考图（当前 ${effectiveRefs.length} 张），后端禁止静默截断，请 Agent 拆分分镜或精简参考素材`,
      ['required_references']
    ));
  }
  if (audioRefs.length > 3) {
    violations.push(violation(
      'INVARIANT_REFERENCE_CAPACITY_EXCEEDED',
      `声音参考总数 (${audioRefs.length}) 超过 H3 单镜 3 个上限，后端禁止静默截断`,
      ['speech_plan.audio_references']
    ));
  }

  let firstFramePolicy = manualFirstFramePolicy || slots.first_frame_policy;
  let lastFramePolicy = manualLastFramePolicy || (LAST_FRAME_POLICIES.has(slots.last_frame_policy) ? slots.last_frame_policy : 'none');

  // 人工模式覆盖先于策略有效性校验：Ref2VA 确定性关闭首尾帧；FL2VA
  // 在 Agent 原计划无首帧时确定性改为生成新首帧。
  if (manualMode === 'fl2va' && !manualFirstFramePolicy && firstFramePolicy === 'none') firstFramePolicy = 'generate_new';
  if (manualMode === 'ref2va' && !manualFirstFramePolicy && !manualLastFramePolicy) {
    firstFramePolicy = 'none';
    lastFramePolicy = 'none';
  }

  if (!FIRST_FRAME_POLICIES.has(firstFramePolicy)) {
    violations.push(violation(
      'INVARIANT_H3_FIRST_FRAME_POLICY_INVALID',
      '导演 Agent 未提供有效的 first_frame_policy（none/generate_new/inherit_tail/layout_lock）',
      ['semantic_slots.first_frame_policy']
    ));
  }

  if (mode === 'fl2va') {
    if (firstFramePolicy === 'none') {
      violations.push(violation(
        'INVARIANT_FL2VA_FIRST_FRAME_REQUIRED',
        'FL2VA 必须使用首帧，first_frame_policy 不能为 none',
        ['h3_mode', 'first_frame_policy']
      ));
    }
    if (!manualMode && (rawRefs.length > 0 || audioRefs.length > 0)) {
      violations.push(violation(
        'INVARIANT_FL2VA_REF_CONTAMINATION',
        'Agent 将镜头规划为 FL2VA，但同时规划了多图或声音参考；请由 Agent 在 FL2VA 与 Ref2VA 之间重新决策',
        ['h3_mode', 'required_references', 'speech_plan.audio_references']
      ));
    }
  }

  if (mode === 'ref2va') {
    if (firstFramePolicy !== 'none') {
      violations.push(violation(
        'INVARIANT_REF2VA_FIRST_FRAME_FORBIDDEN',
        '本项目的 Ref2VA 采用纯多参考流程以节省资源，first_frame_policy 必须为 none；禁止混用 AddGuide 首帧',
        ['h3_mode', 'first_frame_policy']
      ));
    }
    if (lastFramePolicy !== 'none') {
      violations.push(violation(
        'INVARIANT_REF2VA_LAST_FRAME_FORBIDDEN',
        '本项目的 Ref2VA 采用纯多参考流程，last_frame_policy 必须为 none；需要锁定结尾状态时应由 Agent 整体规划为 FL2VA',
        ['h3_mode', 'last_frame_policy']
      ));
    }
    if (effectiveRefs.length === 0 && audioRefs.length === 0) {
      violations.push(violation(
        'INVARIANT_REF2VA_REFERENCE_REQUIRED',
        'Ref2VA 至少需要一项图片参考或声音参考；当前镜头没有可用参考合同，禁止以空参考冒充 Ref2VA 提交',
        ['h3_mode', 'required_references', 'speech_plan']
      ));
    }
  }

  const valid = violations.length === 0;
  if (context.throwOnViolation && !valid) {
    throw Object.assign(new Error(violations[0].message), { status: 422, violations });
  }

  const requiresFirstFrame = mode === 'fl2va';
  const hasManualOverride = !!(manualMode || manualFirstFramePolicy || manualLastFramePolicy);
  const overrideParts = [
    manualMode ? `模式=${manualMode.toUpperCase()}` : '',
    manualFirstFramePolicy ? `首帧=${manualFirstFramePolicy}` : '',
    manualLastFramePolicy ? `尾帧=${manualLastFramePolicy}` : '',
  ].filter(Boolean);
  const reason = hasManualOverride
    ? `人工覆盖：${overrideParts.join('，')}；Agent 原方案为 ${plannedMode || '未规划'} / ${slots.first_frame_policy || '未规划'} / ${slots.last_frame_policy || '未规划'}`
    : (slots.h3_mode_reason || (mode ? `导演 Agent 已规划为 ${mode.toUpperCase()}` : '缺少导演 Agent 模式规划'));
  const resolvedReason = usesManualReferenceContract
    ? `${reason}；参考素材按当前镜头已落库的场景、人物与道具合同展开`
    : reason;
  const firstFrameReason = manualFirstFramePolicy
    ? `人工将首帧策略覆盖为 ${manualFirstFramePolicy}`
    : (manualMode === 'fl2va' && slots.first_frame_policy === 'none'
      ? '人工改为 FL2VA，因此生成新首帧作为必需输入'
      : (manualMode === 'ref2va' ? '人工改为 Ref2VA，因此不生成或使用首帧' : (slots.first_frame_reason || '')));
  const lastFrameReason = manualLastFramePolicy
    ? `人工将尾帧策略覆盖为 ${manualLastFramePolicy}`
    : (manualMode === 'ref2va' ? '人工改为 Ref2VA，因此不生成或使用尾帧' : (slots.last_frame_reason || ''));

  return {
    mode,
    agent_mode: plannedMode,
    agent_first_frame_policy: slots.first_frame_policy || null,
    agent_last_frame_policy: slots.last_frame_policy || null,
    first_frame_policy: firstFramePolicy,
    last_frame_policy: lastFramePolicy,
    use_first_frame_guide: requiresFirstFrame,
    requires_first_frame: requiresFirstFrame,
    first_frame_as_picture_1: false,
    references: mode === 'ref2va' ? effectiveRefs : [],
    suppressed_agent_references: manualMode === 'fl2va' ? rawRefs : [],
    audio_references: mode === 'ref2va' ? audioRefs : [],
    audio_mode: mode === 'ref2va' && audioRefs.length ? 'voice_reference' : 'post_synthesis',
    resolution_reason: resolvedReason,
    reference_source: usesManualReferenceContract ? 'manual_ref2va_shot_contract' : 'agent_required_references',
    first_frame_reason: firstFrameReason,
    last_frame_reason: lastFrameReason,
    is_manual_override: hasManualOverride,
    valid,
    violations,
  };
}

function frameSlotsForPlan(plan) {
  const slots = [];
  if (plan?.mode === 'fl2va' && ['generate_new', 'layout_lock'].includes(plan.first_frame_policy)) slots.push('first');
  if (plan?.last_frame_policy === 'generate_tail') slots.push('last');
  return slots;
}

function storedManualMode(db, dramaId, storyboardId) {
  return storedManualPlan(db, dramaId, storyboardId).mode;
}

function storedManualPlan(db, dramaId, storyboardId) {
  if (!db || !dramaId || !storyboardId) return { mode: null, first_frame_policy: null, last_frame_policy: null };
  try {
    const row = db.prepare('SELECT metadata FROM dramas WHERE id=? AND deleted_at IS NULL').get(Number(dramaId));
    const metadata = row?.metadata ? JSON.parse(row.metadata) : {};
    const saved = metadata?.h3_shots?.[storyboardId] || {};
    return {
      mode: H3_MODES.has(saved.engine_mode) ? saved.engine_mode : null,
      first_frame_policy: FIRST_FRAME_POLICIES.has(saved.first_frame_policy) ? saved.first_frame_policy : null,
      last_frame_policy: LAST_FRAME_POLICIES.has(saved.last_frame_policy) ? saved.last_frame_policy : null,
    };
  } catch (_) { return { mode: null, first_frame_policy: null, last_frame_policy: null }; }
}

function resolveH3SubmissionPlan(db, dramaId, shot, requested = {}) {
  const stored = storedManualPlan(db, dramaId, shot?.id);
  const explicit = H3_MODES.has(requested.h3_mode) ? requested.h3_mode : null;
  const manualMode = explicit || stored.mode;
  const explicitReferences = Array.isArray(requested.reference_image_urls)
    ? requested.reference_image_urls.filter(Boolean).map((url, index) => ({ type: 'context', url, name: `人工参考 ${index + 1}` }))
    : [];
  return resolveH3Mode(shot, {
    manualModeOverride: manualMode,
    manualFirstFramePolicy: FIRST_FRAME_POLICIES.has(requested.first_frame_policy) ? requested.first_frame_policy : stored.first_frame_policy,
    manualLastFramePolicy: LAST_FRAME_POLICIES.has(requested.last_frame_policy) ? requested.last_frame_policy : stored.last_frame_policy,
    manualReferences: manualMode === 'ref2va'
      ? (explicitReferences.length ? explicitReferences : deriveManualRef2vaReferences(db, dramaId, shot))
      : [],
    throwOnViolation: true,
  });
}

module.exports = {
  resolveH3Mode,
  frameSlotsForPlan,
  storedManualMode,
  storedManualPlan,
  resolveH3SubmissionPlan,
  deriveManualRef2vaReferences,
};
