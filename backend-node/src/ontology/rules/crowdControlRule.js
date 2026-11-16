/**
 * 门禁 3：群戏防人脸崩溃与防克隆人检查（单镜身份角色 <= 2）
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
      description: '单镜同时出场超过 2 个身份角色极易导致生图模型人脸崩溃、双胞胎或克隆人，建议拆解为正反打',
    });
  }

  evaluate(context) {
    const shots = context.shots;
    const violations = [];
    if (!Array.isArray(shots)) return violations;

    const maxChars = Number(context.ruleConfig?.params?.max_characters ?? context.options?.max_characters) || 2;
    const severity = context.ruleConfig?.severity || this.defaultSeverity;

    shots.forEach((shot, idx) => {
      const shotNum = shot.shot_number || (idx + 1);

      // 短剧本体特性：围观吃瓜反应镜头（众人震惊、议论、倒吸凉气）豁免2人限制，按群像切镜模板处理
      const isCrowdReaction = shot.is_crowd_reaction
        || shot.beat_type === 'crowd_reaction'
        || shot.dialogue_framing === 'crowd_reaction'
        || (shot.title && (shot.title.includes('反应') || shot.title.includes('围观') || shot.title.includes('众人')));
      if (isCrowdReaction) {
        return;
      }

      const charIds = shotCharacterIds(shot).all;
      if (charIds.length > maxChars) {
        violations.push({
          rule: 'INVARIANT_CROWD_COLLAPSE_RISK',
          shot_number: shotNum,
          severity,
          message: `分镜 ${shotNum} 关联了 ${charIds.length} 名身份角色（超过设定的上限 ${maxChars} 人），违反短剧正反打语法。路人/群众应写成环境事件，建议拆解为主体行动镜+反应特写。`,
        });
      }
    });

    return violations;
  }
}

module.exports = CrowdControlRule;
