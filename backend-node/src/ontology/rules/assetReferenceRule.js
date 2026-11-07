/**
 * 资产引用与规划可行性门禁。
 *
 * 导演阶段可以输出很多结构化槽位，但所有 ID 都必须来自剧库语义包，
 * 且一个镜头的主体与背景人物去重后不能超过 H3 的三人上限。这个规则
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

function idOf(value, preferred = []) {
  if (value == null) return null;
  if (typeof value === 'object') {
    for (const key of preferred) {
      if (value[key] != null && Number.isFinite(Number(value[key]))) return Number(value[key]);
    }
    for (const key of ['id', 'character_id', 'scene_id', 'prop_id']) {
      if (value[key] != null && Number.isFinite(Number(value[key]))) return Number(value[key]);
    }
    return null;
  }
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function ids(value, preferred = []) {
  return arrayValue(value).map((item) => idOf(item, preferred)).filter((id) => id != null);
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
  const visuals = ids(shot?.character_visuals, ['character_id', 'id']);
  const lastVisuals = ids(shot?.last_frame_visuals, ['character_id', 'id']);
  return {
    visible,
    background,
    semanticVisible,
    semanticBackground,
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
  const knownScenes = new Set((catalogs.scenes || []).map((item) => Number(item.id)).filter(Number.isFinite));
  const knownProps = new Set((catalogs.props || []).map((item) => Number(item.id)).filter(Number.isFinite));
  const violations = [];
  if (!Array.isArray(shots)) return violations;

  shots.forEach((shot, index) => {
    const shotNumber = Number(shot?.shot_number || shot?.storyboard_number || index + 1);
    const chars = shotCharacterIds(shot);
    const semantic = semanticObject(shot);
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

    if (chars.all.length > 3) {
      violations.push({
        rule: 'INVARIANT_PLANNING_CHARACTER_CAPACITY', shot_number: shotNumber, severity: 'error',
        character_ids: chars.all,
        conflict_slots: [
          'characters', 'background_characters', 'semantic_slots.visible_characters',
          'semantic_slots.background_characters', 'character_visuals',
        ],
        message: `分镜 #${shotNumber} 的主体与背景人物去重后共有 ${chars.all.length} 人，超过 H3 单镜最多 3 人的物理上限。请把敌军/群众作为环境事件，或按剧情拆成连续镜头；禁止后端静默删除人物。`,
      });
    }
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
