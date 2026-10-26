/**
 * 门禁：H3视频参考图物理上限与复杂度审查（单镜角色<=3，核心道具<=2）
 */
const BaseInvariantRule = require('./baseRule');
const { parseCharacterIds } = require('./visualSlotCompletenessRule');

class H3ReferenceCapacityRule extends BaseInvariantRule {
  constructor() {
    super({
      id: 'RULE_H3_REFERENCE_CAPACITY',
      name: 'H3 视频参考图槽位上限',
      category: 'h3',
      defaultSeverity: 'error',
      description: '单镜角色不超过3人、道具不超过2件，严格防止超出 H3 9张参考图物理上限',
    });
  }

  evaluate(context) {
    const shots = context.shots;
    const violations = [];
    if (!Array.isArray(shots)) return violations;

    shots.forEach((shot, idx) => {
      const shotNum = shot.shot_number || (idx + 1);
      const charIds = parseCharacterIds(shot.character_ids || shot.characters);
      const propIds = Array.isArray(shot.props) ? shot.props : (Array.isArray(shot.prop_ids) ? shot.prop_ids : []);

      if (charIds.length > 3) {
        violations.push({
          rule: 'INVARIANT_H3_CROWD_OVERLOAD',
          shot_number: shotNum,
          severity: this.defaultSeverity,
          message: `分镜 ${shotNum} 出场角色超过3人（当前${charIds.length}人），超出 H3 视频生成 9 张参考图物理上限，必须拆镜为正反打镜头！`,
        });
      }
      if (propIds.length > 2) {
        violations.push({
          rule: 'INVARIANT_H3_PROP_OVERLOAD',
          shot_number: shotNum,
          severity: this.defaultSeverity,
          message: `分镜 ${shotNum} 挂载道具超过2件（当前${propIds.length}件），超出 H3 参考图槽位上限，必须拆镜精简！`,
        });
      }
    });

    return violations;
  }
}

module.exports = H3ReferenceCapacityRule;
