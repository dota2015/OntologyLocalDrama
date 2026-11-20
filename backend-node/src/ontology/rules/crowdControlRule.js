/**
 * 门禁 3：群戏防人脸崩溃与防克隆人检查（单镜身份角色 <= 2）
 */
const { MAX_VISIBLE_CHARACTERS } = require('../../services/h3Limits');
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

    const maxChars = Number(context.ruleConfig?.params?.max_characters ?? context.options?.max_characters) || MAX_VISIBLE_CHARACTERS;
    const severity = context.ruleConfig?.severity || this.defaultSeverity;

    shots.forEach((shot, idx) => {
      const shotNum = shot.shot_number || (idx + 1);

      const charIds = shotCharacterIds(shot).all;
      if (charIds.length > maxChars) {
        // 短剧本体特性：围观吃瓜反应镜头（众人震惊、议论、倒吸凉气）仍须严格遵守 ≤ 2 具名角色限制
        // 领头吃瓜代表（焦点）最多 2 人挂参考图，其余群众必须改写为环境事件或无ID背景，杜绝生图模型克隆人
        const isCrowdReaction = shot.is_crowd_reaction
          || shot.beat_type === 'crowd_reaction'
          || shot.dialogue_framing === 'crowd_reaction';

        const message = isCrowdReaction
          ? `分镜 ${shotNum} 为围观吃瓜镜头，具名焦点角色仍须 ≤ ${maxChars} 人（作为领头震惊/议论的焦点代表），其余围观群众严禁分配角色ID或挂入人脸参考图（会导致生图模型克隆人崩溃），必须改写为 background_characters 无ID群像或环境氛围描述（environment_vfx）！`
          : `分镜 ${shotNum} 关联了 ${charIds.length} 名身份角色（超过设定的上限 ${maxChars} 人），违反短剧正反打语法。路人/群众应写成环境事件，建议拆解为主体行动镜+反应特写。`;

        violations.push({
          rule: 'INVARIANT_CROWD_COLLAPSE_RISK',
          shot_number: shotNum,
          severity,
          message,
        });
      }
    });

    return violations;
  }
}

module.exports = CrowdControlRule;
