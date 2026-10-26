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
      description: '审查关键构图槽位（facing, posture, hands, head_gaze），杜绝动态叙事混入静态生图',
    });
  }

  evaluate(context) {
    const shots = context.shots;
    const violations = [];
    if (!Array.isArray(shots)) return violations;

    const { validateCharacterVisualSlots, FACING_REGEX, POSTURE_REGEX, HANDS_REGEX, GAZE_REGEX, DYNAMIC_REGEX } = require('../visualSlots');

    shots.forEach((shot, idx) => {
      const shotNum = shot.shot_number || shot.storyboard_number || (idx + 1);
      const charIds = parseCharacterIds(shot.characters || shot.character_ids);
      if (charIds.length === 0) return;

      let visuals = shot.character_visuals;
      if (typeof visuals === 'string') {
        try { visuals = JSON.parse(visuals); } catch (_) { visuals = []; }
      }

      if (Array.isArray(visuals) && visuals.length > 0) {
        const slotViolations = validateCharacterVisualSlots(shot, visuals);
        violations.push(...slotViolations);
      } else {
        const p = String(shot.image_prompt || shot.action || '');
        const hasFacing = FACING_REGEX.test(p);
        const hasPosture = POSTURE_REGEX.test(p);
        const hasHands = HANDS_REGEX.test(p);
        const hasGaze = GAZE_REGEX.test(p);

        const missing = [];
        if (!hasFacing) missing.push('人物朝向 (facing)');
        if (!hasPosture) missing.push('躯干重心姿态 (posture)');
        if (!hasHands) missing.push('手部动作 (hands)');
        if (!hasGaze) missing.push('头部视线 (head_gaze)');

        if (missing.length > 0) {
          violations.push({
            rule: 'INVARIANT_IMAGE_SLOT_INCOMPLETE',
            shot_number: shotNum,
            severity: this.defaultSeverity,
            message: `分镜 ${shotNum} 画面构图缺少关键槽位：${missing.join('、')}。生图模型无法确定朝向与具体肢体姿态，易造成人物发呆立正或机械套用参考图！`,
          });
        }

        if (DYNAMIC_REGEX.test(p)) {
          violations.push({
            rule: 'INVARIANT_SLOT_DYNAMIC_ACTION',
            shot_number: shotNum,
            severity: this.defaultSeverity,
            message: `分镜 ${shotNum} 图片提示词中包含视频化时序动态叙述，生图模型无法绘制动态过程，必须改为决定性瞬间静态定格！`,
          });
        }
      }

      let lastVisuals = shot.last_frame_visuals;
      if (typeof lastVisuals === 'string') {
        try { lastVisuals = JSON.parse(lastVisuals); } catch (_) { lastVisuals = []; }
      }
      if (Array.isArray(lastVisuals) && lastVisuals.length > 0) {
        const lastViolations = validateCharacterVisualSlots(shot, lastVisuals);
        violations.push(...lastViolations);
      }
    });

    return violations;
  }
}

module.exports = {
  VisualSlotCompletenessRule,
  parseCharacterIds,
};
