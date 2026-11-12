/**
 * 资产引用与规划可行性门禁。
 *
 * 导演阶段可以输出很多结构化槽位，但所有 ID 都必须来自剧库语义包，
 * 且一个镜头的有身份主体与背景人物去重后不能超过短剧的两人上限。这个规则
 * 必须在执行槽位 Agent 之前运行，否则执行 Agent 会收到一个物理上不可
 * 满足的合同（例如四个人却只能输出三项 character_visuals）。
 */
const BaseInvariantRule = require('./baseRule');

function parseValue(value) {
  if (typeof value !== 'string' || !value.trim()) return value;
  try { return JSON.parse(value); } catch (_) { return value; }
}

function arrayValue(value) {
  const parsed = parseValue(value);
  return Array.isArray(parsed) ? parsed : [];
}

function idOf(value, preferred = [], nameToId = null) {
  if (value == null) return null;
  if (typeof value === 'object') {
    for (const key of preferred) {
      if (value[key] != null && Number.isFinite(Number(value[key]))) return Number(value[key]);
    }
    for (const key of ['id', 'character_id', 'scene_id', 'prop_id']) {
      if (value[key] != null && Number.isFinite(Number(value[key]))) return Number(value[key]);
    }
    const name = String(value.name || '').trim();
    if (name && nameToId?.has(name)) return nameToId.get(name);
    return null;
  }
  if (Number.isFinite(Number(value))) return Number(value);
  const key = String(value || '').trim();
  return nameToId?.get(key) || null;
}

function ids(value, preferred = [], nameToId = null) {
  return arrayValue(value).map((item) => idOf(item, preferred, nameToId)).filter((id) => id != null);
}

function semanticObject(shot) {
  const value = parseValue(shot?.semantic_slots);
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function shotCharacterIds(shot) {
  const semantic = semanticObject(shot);
  const visible = ids(shot?.characters ?? shot?.character_ids, ['character_id', 'id']);
  const background = ids(shot?.background_characters, ['character_id', 'id']);
  const semanticVisible = ids(semantic.visible_characters, ['id', 'character_id']);
  const semanticBackground = ids(semantic.background_characters, ['character_id', 'id']);
  const semanticOffscreen = ids(semantic.offscreen_characters, ['character_id', 'id']);
  const visuals = ids(shot?.character_visuals, ['character_id', 'id']);
  const lastVisuals = ids(shot?.last_frame_visuals, ['character_id', 'id']);
  return {
    visible,
    background,
    semanticVisible,
    semanticBackground,
    semanticOffscreen,
    visuals,
    lastVisuals,
    // Only depicted characters belong in `all`: offscreen participants are
    // registered identities but must never count toward the visual capacity
    // or be treated as if they needed character_visuals.
    all: [...new Set([...visible, ...background, ...semanticVisible, ...semanticBackground, ...visuals, ...lastVisuals])],
  };
}

function sameIds(left, right) {
  const a = [...new Set(left)].sort((x, y) => x - y);
  const b = [...new Set(right)].sort((x, y) => x - y);
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function planningFeasibilityViolations(shots, options = {}) {
  const catalogs = options.catalogs || {};
  const hasCharacterCatalog = Array.isArray(catalogs.characters);
  const hasSceneCatalog = Array.isArray(catalogs.scenes);
  const hasPropCatalog = Array.isArray(catalogs.props);
  const knownCharacters = new Set((catalogs.characters || []).map((item) => Number(item.id)).filter(Number.isFinite));
  const characterNameToId = new Map((catalogs.characters || [])
    .filter((item) => item?.name != null && Number.isFinite(Number(item.id)))
    .map((item) => [String(item.name).trim(), Number(item.id)]));
  const knownScenes = new Set((catalogs.scenes || []).map((item) => Number(item.id)).filter(Number.isFinite));
  const knownProps = new Set((catalogs.props || []).map((item) => Number(item.id)).filter(Number.isFinite));
  const violations = [];
  if (!Array.isArray(shots)) return violations;

  shots.forEach((shot, index) => {
    const shotNumber = Number(shot?.shot_number || shot?.storyboard_number || index + 1);
    // Stage-one drafts may still contain display names. Resolve those names
    // against the immutable catalog before applying the H3 two-person gate;
    // otherwise a three-person draft can slip through because Number('角色B')
    // is NaN and only fails later in character_visuals.
    const chars = {
      ...shotCharacterIds(shot),
      visible: ids(shot?.characters ?? shot?.character_ids, ['character_id', 'id'], characterNameToId),
      background: ids(shot?.background_characters, ['character_id', 'id'], characterNameToId),
    };
    const semantic = semanticObject(shot);
    chars.semanticVisible = ids(semantic.visible_characters, ['id', 'character_id'], characterNameToId);
    chars.semanticBackground = ids(semantic.background_characters, ['character_id', 'id'], characterNameToId);
    chars.semanticOffscreen = ids(semantic.offscreen_characters, ['character_id', 'id'], characterNameToId);
    chars.visuals = chars.visuals || [];
    chars.lastVisuals = chars.lastVisuals || [];
    chars.all = [...new Set([
      ...chars.visible, ...chars.background, ...chars.semanticVisible, ...chars.semanticBackground,
      ...chars.visuals, ...chars.lastVisuals,
    ])];
    if (shot?.characters != null && semantic.visible_characters != null && !sameIds(chars.visible, chars.semanticVisible)) {
      violations.push({
        rule: 'INVARIANT_CHARACTER_SLOT_DIVERGENCE', shot_number: shotNumber, severity: 'error',
        conflict_slots: ['characters', 'semantic_slots.visible_characters'],
        message: `分镜 #${shotNumber} 的顶层 characters 与 semantic_slots.visible_characters 不一致，必须在导演规划阶段统一人物清单。`,
      });
    }
    if (shot?.background_characters != null && semantic.background_characters != null && !sameIds(chars.background, chars.semanticBackground)) {
      violations.push({
        rule: 'INVARIANT_CHARACTER_SLOT_DIVERGENCE', shot_number: shotNumber, severity: 'error',
        conflict_slots: ['background_characters', 'semantic_slots.background_characters'],
        message: `分镜 #${shotNumber} 的顶层 background_characters 与 semantic_slots.background_characters 不一致，必须在导演规划阶段统一人物清单。`,
      });
    }
    const dualRoles = chars.semanticVisible.filter((id) => chars.semanticBackground.includes(id));
    if (dualRoles.length) {
      violations.push({
        rule: 'INVARIANT_CHARACTER_DUAL_ROLE_CONFLICT', shot_number: shotNumber, severity: 'error',
        conflict_slots: ['semantic_slots.visible_characters', 'semantic_slots.background_characters'],
        message: `分镜 #${shotNumber} 的角色 ID [${dualRoles.join(', ')}] 同时被列为主体和背景人物，必须由导演明确唯一定位。`,
      });
    }
    // Participation is declared, never guessed: a character takes part in a
    // shot in exactly one way — depicted (visible/background) or offscreen
    // (present_offscreen / remote_voice in semantic_slots.offscreen_characters).
    // Offscreen participants are real identities (their IDs must exist and
    // they may speak), but they are not depicted: no capacity cost, no
    // character_visuals, no visual references.
    const depictedIds = [...new Set([...chars.visible, ...chars.background, ...chars.semanticVisible, ...chars.semanticBackground])];
    const participationOverlap = chars.semanticOffscreen.filter((id) => depictedIds.includes(id));
    if (participationOverlap.length) {
      violations.push({
        rule: 'INVARIANT_CHARACTER_PARTICIPATION_CONFLICT', shot_number: shotNumber, severity: 'error',
        character_ids: participationOverlap,
        conflict_slots: ['semantic_slots.offscreen_characters', 'semantic_slots.visible_characters', 'semantic_slots.background_characters'],
        message: `分镜 #${shotNumber} 的角色 ID [${participationOverlap.join(', ')}] 同时被声明为画内人物和画外参与者，同一角色在同一镜只能有一种参与方式，必须由导演明确唯一定位。`,
      });
    }
    const visualizedOffscreen = chars.semanticOffscreen.filter((id) => chars.visuals.includes(id) || chars.lastVisuals.includes(id));
    if (visualizedOffscreen.length) {
      violations.push({
        rule: 'INVARIANT_OFFSCREEN_CHARACTER_VISUALIZED', shot_number: shotNumber, severity: 'error',
        character_ids: visualizedOffscreen,
        conflict_slots: ['semantic_slots.offscreen_characters', 'character_visuals', 'last_frame_visuals'],
        message: `分镜 #${shotNumber} 的画外参与者 ID [${visualizedOffscreen.join(', ')}] 被写入了 character_visuals/last_frame_visuals。画外参与者不入画，不得生成视觉定格；若该角色实际入画，必须由导演将其改列入 visible_characters/background_characters 并确保单镜最多2人。`,
      });
    }
    const offscreenReferenceIds = arrayValue(semantic.required_references)
      .filter((ref) => String(ref?.type || 'character').toLowerCase() === 'character')
      .map((ref) => idOf(ref, ['character_id', 'id'], characterNameToId))
      .filter((id) => id != null && chars.semanticOffscreen.includes(id));
    if (offscreenReferenceIds.length) {
      violations.push({
        rule: 'INVARIANT_OFFSCREEN_CHARACTER_VISUALIZED', shot_number: shotNumber, severity: 'error',
        character_ids: [...new Set(offscreenReferenceIds)],
        conflict_slots: ['semantic_slots.offscreen_characters', 'semantic_slots.required_references'],
        message: `分镜 #${shotNumber} 的画外参与者 ID [${[...new Set(offscreenReferenceIds)].join(', ')}] 被列入 required_references 的角色视觉参考。画外参与者不需要参考图；若该角色实际入画，必须由导演将其改列入 visible_characters/background_characters。`,
      });
    }
    const speechPlan = semantic.speech_plan && typeof semantic.speech_plan === 'object' ? semantic.speech_plan : null;
    const speakerId = Number(speechPlan?.speaker_id);
    const hasParticipantLists = Array.isArray(semantic.visible_characters)
      || Array.isArray(semantic.background_characters) || Array.isArray(semantic.offscreen_characters);
    if (speechPlan && Number.isInteger(speakerId) && speakerId > 0 && hasParticipantLists) {
      const participantIds = [...new Set([...depictedIds, ...chars.semanticOffscreen])];
      if (!participantIds.includes(speakerId)) {
        violations.push({
          rule: 'INVARIANT_SPEAKER_NOT_DECLARED', shot_number: shotNumber, severity: 'error',
          asset_id: speakerId,
          conflict_slots: ['semantic_slots.speech_plan', 'semantic_slots.visible_characters', 'semantic_slots.offscreen_characters'],
          message: `分镜 #${shotNumber} 的说话人 ID ${speakerId} 未出现在任何人物清单中。说话人必须由导演声明参与方式：入画列入 visible_characters/background_characters，不入画列入 semantic_slots.offscreen_characters；后端不会根据文本猜测说话人的在场状态。`,
        });
      } else if (chars.semanticOffscreen.includes(speakerId)
        && String(semantic.audio_lip_sync || '') === 'in_frame_dialogue') {
        violations.push({
          rule: 'INVARIANT_OFFSCREEN_SPEAKER_LIP_SYNC', shot_number: shotNumber, severity: 'error',
          asset_id: speakerId,
          conflict_slots: ['semantic_slots.speech_plan', 'semantic_slots.offscreen_characters', 'semantic_slots.audio_lip_sync'],
          message: `分镜 #${shotNumber} 的说话人 ID ${speakerId} 是画外参与者，但 audio_lip_sync 仍为 in_frame_dialogue。画外说话必须使用 offscreen_voiceover，画内全员双唇紧闭。`,
        });
      }
    }
    const reportUnknown = (set, values, rule, label, slots) => {
      if (!set.size) return;
      for (const id of [...new Set(values)]) {
        if (!set.has(Number(id))) {
          violations.push({
            rule,
            shot_number: shotNumber,
            severity: 'error',
            asset_id: Number(id),
            conflict_slots: slots,
            message: `分镜 #${shotNumber} 引用了不存在的${label} ID ${id}。请从剧库资产目录选择已有 ID；敌军、群众或环境事件没有角色资产时写入环境事件，不得虚构角色 ID。`,
          });
        }
      }
    };

    if (hasCharacterCatalog || hasSceneCatalog || hasPropCatalog) {
      if (hasCharacterCatalog) reportUnknown(knownCharacters, chars.all, 'INVARIANT_UNKNOWN_CHARACTER_REFERENCE', '角色', [
        'characters', 'background_characters', 'semantic_slots.visible_characters',
        'semantic_slots.background_characters', 'character_visuals', 'last_frame_visuals',
      ]);
      if (hasCharacterCatalog) reportUnknown(knownCharacters, chars.semanticOffscreen, 'INVARIANT_UNKNOWN_CHARACTER_REFERENCE', '角色', [
        'semantic_slots.offscreen_characters',
      ]);
      const sceneId = idOf(shot.scene_id, ['scene_id', 'id']);
      if (hasSceneCatalog && sceneId != null && !knownScenes.has(sceneId)) {
        violations.push({
          rule: 'INVARIANT_UNKNOWN_SCENE_REFERENCE', shot_number: shotNumber, severity: 'error',
          asset_id: sceneId, conflict_slots: ['scene_id'],
          message: `分镜 #${shotNumber} 引用了不存在的场景 ID ${sceneId}，请从剧库场景目录选择已有 ID。`,
        });
      }
      const propIds = ids(shot.props ?? shot.prop_ids, ['prop_id', 'id']);
      if (hasPropCatalog) reportUnknown(knownProps, propIds, 'INVARIANT_UNKNOWN_PROP_REFERENCE', '道具', ['props', 'prop_ids']);
      const refs = arrayValue(semantic.required_references);
      refs.forEach((ref) => {
        const type = String(ref?.type || '').toLowerCase();
        const refId = idOf(ref, ['id', 'character_id']);
        if (refId == null) return;
        const [set, rule, label] = type === 'character'
          ? [knownCharacters, 'INVARIANT_UNKNOWN_REQUIRED_CHARACTER_REFERENCE', '角色']
          : type === 'scene'
            ? [knownScenes, 'INVARIANT_UNKNOWN_REQUIRED_SCENE_REFERENCE', '场景']
            : type === 'prop'
              ? [knownProps, 'INVARIANT_UNKNOWN_REQUIRED_PROP_REFERENCE', '道具']
              : [null, null, null];
        const hasSet = type === 'character' ? hasCharacterCatalog : type === 'scene' ? hasSceneCatalog : type === 'prop' ? hasPropCatalog : false;
        if (set && hasSet && !set.has(refId)) {
          violations.push({
            rule, shot_number: shotNumber, severity: 'error', asset_id: refId,
            conflict_slots: ['semantic_slots.required_references'],
            message: `分镜 #${shotNumber} 的 required_references 引用了不存在的${label} ID ${refId}，必须改用剧库资产目录中的 ID。`,
          });
        }
      });
    }

    if (chars.all.length > 2) {
      violations.push({
        rule: 'INVARIANT_PLANNING_CHARACTER_CAPACITY', shot_number: shotNumber, severity: 'error',
        character_ids: chars.all,
        conflict_slots: [
          'characters', 'background_characters', 'semantic_slots.visible_characters',
          'semantic_slots.background_characters', 'character_visuals',
        ],
        message: `分镜 #${shotNumber} 的有身份主体与背景人物去重后共有 ${chars.all.length} 人，超过短剧单镜最多 2 个角色的制作上限。路人/敌军群体必须写成环境事件，或按剧情拆成连续镜头；禁止后端静默删除人物。`,
      });
    }
    // Deliberately no free-text name scanning here. Whether a character is
    // present, offscreen, remote, or merely mentioned is a semantic decision
    // the Director declares in the participant lists; this gate only checks
    // that the declared structure is consistent (existence, exclusivity,
    // capacity, speaker registration). Inferring presence from narrative
    // wording made legitimate offscreen/remote participation unsatisfiable.
    const refs = arrayValue(semanticObject(shot).required_references);
    if (refs.length > 9) {
      violations.push({
        rule: 'INVARIANT_REQUIRED_REFERENCE_CAPACITY', shot_number: shotNumber, severity: 'error',
        conflict_slots: ['semantic_slots.required_references'],
        message: `分镜 #${shotNumber} 需要 ${refs.length} 张参考图，超过 H3 单镜 9 张上限；请减少非核心参考或拆镜。`,
      });
    }
  });
  return violations;
}

class AssetReferenceRule extends BaseInvariantRule {
  constructor() {
    super({
      id: 'RULE_ASSET_REFERENCE_AND_PLANNING_FEASIBILITY',
      name: '资产引用与导演规划可行性',
      category: 'asset',
      defaultSeverity: 'error',
      description: '检查角色、场景、道具 ID 是否存在，并统一 H3 单镜人物与参考图容量口径',
    });
  }

  evaluate(context) {
    return planningFeasibilityViolations(context.shots, context);
  }
}

module.exports = {
  AssetReferenceRule,
  planningFeasibilityViolations,
  shotCharacterIds,
};
