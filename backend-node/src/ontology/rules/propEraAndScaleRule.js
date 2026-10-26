/**
 * 门禁 6：道具时代与物理尺度硬约束检查
 */
const BaseInvariantRule = require('./baseRule');

const MODERN_ANACHRONISMS = [
  /手机/, /智能机/, /电脑/, /笔记本/, /遥控器/, /塑料袋/, /打火机/, /汽车/, /现代/, /液晶屏/,
];

class PropEraAndScaleRule extends BaseInvariantRule {
  constructor() {
    super({
      id: 'RULE_PROP_ERA_AND_SCALE',
      name: '道具时代与物理尺度锚点',
      category: 'prop',
      defaultSeverity: 'error',
      description: '严格防止古装剧出现现代工业品穿帮，以及道具缺少尺寸约束导致生图比例失真',
    });
  }

  evaluate(context) {
    const props = context.props || [];
    const dramaEra = context.dramaEra || 'modern';
    const violations = [];
    if (!Array.isArray(props)) return violations;

    const isAncient = dramaEra === 'ancient' || dramaEra === '古风' || dramaEra === '古装';

    props.forEach((prop, idx) => {
      const name = prop.name || `道具${idx + 1}`;
      const text = `${name} ${prop.description || ''} ${prop.type || ''}`;

      if (isAncient) {
        for (const pattern of MODERN_ANACHRONISMS) {
          if (pattern.test(text)) {
            violations.push({
              rule: 'INVARIANT_PROP_ANACHRONISM',
              prop_id: prop.id,
              prop_name: name,
              severity: 'error',
              message: `道具「${name}」在古装世界观中出现现代穿帮物品（匹配到 ${pattern}）。严禁在古代剧目中引入现代工业品。`,
            });
          }
        }
      }

      if (!prop.physical_scale || !String(prop.physical_scale).trim()) {
        violations.push({
          rule: 'INVARIANT_PROP_MISSING_SCALE',
          prop_id: prop.id,
          prop_name: name,
          severity: 'warning',
          message: `道具「${name}」未定义物理尺度锚点(physical_scale)。缺少尺寸约束容易导致生图模型将道具画得比例失真、喧宾夺主。`,
        });
      }
    });

    return violations;
  }
}

module.exports = {
  PropEraAndScaleRule,
  MODERN_ANACHRONISMS,
};
