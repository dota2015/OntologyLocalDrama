/**
 * 门禁：生图构图槽位完整性检查（Visual Slots & Freeze-frame Posture Hard Gate）
 */
const BaseInvariantRule = require('./baseRule');

function parseCharacterIds(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
    } catch (_) {}
  }
  return [];
}

class VisualSlotCompletenessRule extends BaseInvariantRule {
  constructor() {
    super({
      id: 'RULE_VISUAL_SLOT_COMPLETENESS',
      name: '生图构图槽位完整性',
      category: 'visual_slot',
      defaultSeverity: 'error',
      description: '审查结构化角色视觉槽位（depth_layer, screen_position, facing, head_pose, gaze_type, posture, hands_state, expression）与多人物防重叠约束',
    });
  }

  evaluate(context) {
    const shots = context.shots;
    const violations = [];
    if (!Array.isArray(shots)) return violations;

    const { validateCharacterVisualSlots } = require('../visualSlots');

    shots.forEach((shot, idx) => {
      const shotNum = shot.shot_number || shot.storyboard_number || (idx + 1);
      const charIds = parseCharacterIds(shot.characters || shot.character_ids);
      if (charIds.length === 0) return;

      let visuals = shot.character_visuals;
      if (typeof visuals === 'string') {
        try { visuals = JSON.parse(visuals); } catch (_) { visuals = []; }
      }

      if (Array.isArray(visuals) && visuals.length > 0) {
        violations.push(...validateCharacterVisualSlots(shot, visuals));
      } else {
        violations.push({
          rule: 'INVARIANT_CHARACTER_VISUAL_SLOTS_REQUIRED',
          shot_number: shotNum,
          severity: this.defaultSeverity,
          conflict_slots: ['character_visuals'],
          message: `分镜 ${shotNum} 包含出场角色但缺少结构化 character_visuals 视觉槽位，旧版纯文本提示词兜底已移除，请由导演 Agent 生成或补全结构化槽位。`,
        });
      }

      let lastVisuals = shot.last_frame_visuals;
      if (typeof lastVisuals === 'string') {
        try { lastVisuals = JSON.parse(lastVisuals); } catch (_) { lastVisuals = []; }
      }
      if (Array.isArray(lastVisuals) && lastVisuals.length > 0) {
        violations.push(...validateCharacterVisualSlots(shot, lastVisuals, 'last_frame_visuals'));
      }
    });

    return violations;
  }
}

module.exports = {
  VisualSlotCompletenessRule,
  parseCharacterIds,
};
