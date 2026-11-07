/**
 * 门禁 3：群戏防人脸崩溃与防克隆人检查（单镜角色 <= 3）
 */
const BaseInvariantRule = require('./baseRule');
const { shotCharacterIds } = require('./assetReferenceRule');

class CrowdControlRule extends BaseInvariantRule {
  constructor() {
    super({
      id: 'RULE_CROWD_CONTROL',
      name: '群戏防人脸崩溃与克隆人',
      category: 'crowd',
      defaultSeverity: 'warning',
      description: '单镜同时出场超过 3 人极易导致生图模型人脸崩溃、双胞胎或克隆人，建议拆解为正反打',
    });
  }

  evaluate(context) {
    const shots = context.shots;
    const violations = [];
    if (!Array.isArray(shots)) return violations;

    shots.forEach((shot, idx) => {
      const shotNum = shot.shot_number || (idx + 1);
      const charIds = shotCharacterIds(shot).all;
      if (charIds.length > 3) {
        violations.push({
          rule: 'INVARIANT_CROWD_COLLAPSE_RISK',
          shot_number: shotNum,
          severity: this.defaultSeverity,
          message: `分镜 ${shotNum} 关联了 ${charIds.length} 名角色（超过3人），违反短剧正反打语法。单镜同时出场超过 3 人极易导致生图模型人脸崩溃、双胞胎或克隆人，建议拆解为主体行动镜+反应特写。`,
        });
      }
    });

    return violations;
  }
}

module.exports = CrowdControlRule;
