/**
 * 门禁：H3视频参考图物理上限与复杂度审查（单镜身份角色<=2，核心道具<=2）
 */
const BaseInvariantRule = require('./baseRule');
const { shotCharacterIds } = require('./assetReferenceRule');

class H3ReferenceCapacityRule extends BaseInvariantRule {
  constructor() {
    super({
      id: 'RULE_H3_REFERENCE_CAPACITY',
      name: 'H3 视频参考图槽位上限',
      category: 'h3',
      defaultSeverity: 'error',
      description: '单镜身份角色不超过2人、道具不超过2件，严格防止短剧近景与正反打出现克隆人',
    });
  }

  evaluate(context) {
    const shots = context.shots;
    const violations = [];
    if (!Array.isArray(shots)) return violations;

    const maxChars = Number(context.ruleConfig?.params?.max_characters ?? context.options?.max_characters) || 2;
    const maxProps = Number(context.ruleConfig?.params?.max_props ?? context.options?.max_props) || 2;
    const maxRefs = Number(context.ruleConfig?.params?.max_references ?? context.options?.max_references) || 9;
    const severity = context.ruleConfig?.severity || this.defaultSeverity;

    shots.forEach((shot, idx) => {
      const shotNum = shot.shot_number || (idx + 1);

      // 短剧本体特性：围观吃瓜反应镜头豁免主角限2人
      const isCrowdReaction = shot.is_crowd_reaction
        || shot.beat_type === 'crowd_reaction'
        || shot.dialogue_framing === 'crowd_reaction'
        || (shot.title && (shot.title.includes('反应') || shot.title.includes('围观') || shot.title.includes('众人')));

      const charIds = shotCharacterIds(shot).all;
      const propIds = Array.isArray(shot.props) ? shot.props : (Array.isArray(shot.prop_ids) ? shot.prop_ids : []);

      if (charIds.length > maxChars && !isCrowdReaction) {
        violations.push({
          rule: 'INVARIANT_H3_CROWD_OVERLOAD',
          shot_number: shotNum,
          severity,
          message: `分镜 ${shotNum} 出场身份角色超过设定的上限 ${maxChars} 人（当前${charIds.length}人），短剧镜头必须拆为正反打或反应镜头；路人/群众请改写为环境事件！`,
        });
      }
      if (propIds.length > maxProps) {
        violations.push({
          rule: 'INVARIANT_H3_PROP_OVERLOAD',
          shot_number: shotNum,
          severity,
          message: `分镜 ${shotNum} 挂载道具超过设定的上限 ${maxProps} 件（当前${propIds.length}件），超出 H3 参考图槽位上限，必须拆镜精简！`,
        });
      }
      const semantic = typeof shot.semantic_slots === 'string'
        ? (() => { try { return JSON.parse(shot.semantic_slots); } catch (_) { return {}; } })()
        : (shot.semantic_slots || {});
      const refs = Array.isArray(semantic?.required_references) ? semantic.required_references : [];
      if (refs.length > maxRefs) {
        violations.push({
          rule: 'INVARIANT_H3_REFERENCE_OVERLOAD',
          shot_number: shotNum,
          severity,
          message: `分镜 ${shotNum} 需要 ${refs.length} 张参考图，超过设定的单镜 ${maxRefs} 张参考图上限，必须减少非核心参考或拆镜！`,
        });
      }
    });

    return violations;
  }
}

module.exports = H3ReferenceCapacityRule;
