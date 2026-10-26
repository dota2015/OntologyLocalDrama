/**
 * 门禁 5：镜头间空间连续性检查（防跳切与瞬移）
 */
const BaseInvariantRule = require('./baseRule');
const { parseCharacterIds } = require('./visualSlotCompletenessRule');

class SpatialContinuityRule extends BaseInvariantRule {
  constructor() {
    super({
      id: 'RULE_SPATIAL_CONTINUITY',
      name: '空间连续性与防跳切',
      category: 'continuity',
      defaultSeverity: 'warning',
      description: '同一机位同视角下防止角色瞬间置换造成视觉跳切穿帮',
    });
  }

  evaluate(context) {
    const shots = context.shots;
    const violations = [];
    if (!Array.isArray(shots) || shots.length < 2) return violations;

    for (let i = 1; i < shots.length; i++) {
      const prev = shots[i - 1];
      const curr = shots[i];
      const currNum = curr.shot_number || (i + 1);

      const sameScene = prev.scene_id != null && prev.scene_id === curr.scene_id;
      const sameAngle = prev.angle_h === curr.angle_h && prev.angle_v === curr.angle_v && prev.shot_type === curr.shot_type;

      if (sameScene && sameAngle) {
        const prevChars = parseCharacterIds(prev.character_ids || prev.characters).map(String);
        const currChars = parseCharacterIds(curr.character_ids || curr.characters).map(String);

        if (prevChars.length > 0 && currChars.length > 0 && !prevChars.some((id) => currChars.includes(id))) {
          violations.push({
            rule: 'INVARIANT_SPATIAL_JUMP_CUT',
            shot_number: currNum,
            severity: this.defaultSeverity,
            message: `分镜 ${currNum} 与上一镜处于同一场景相同机位，但角色瞬间被完全置换，构成视觉跳切穿帮。应切换为反打特写或交代人物出入画动作。`,
          });
        }
      }
    }

    return violations;
  }
}

module.exports = SpatialContinuityRule;
