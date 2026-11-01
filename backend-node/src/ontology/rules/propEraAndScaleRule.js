/**
 * 门禁 6：道具时代与物理尺度硬约束检查
 */
const BaseInvariantRule = require('./baseRule');

// 兼容旧调用保留该导出。时代判断已改为 Agent 的结构化结论，不再扫描自然语言关键词。
const MODERN_ANACHRONISMS = [];

class PropEraAndScaleRule extends BaseInvariantRule {
  constructor() {
    super({
      id: 'RULE_PROP_ERA_AND_SCALE',
      name: '道具时代与物理尺度锚点',
      category: 'prop',
      defaultSeverity: 'error',
      description: '校验 Agent 给出的道具时空兼容合同，以及道具物理尺度锚点',
    });
  }

  evaluate(context) {
    const allProps = context.props || [];
    const violations = [];
    if (!Array.isArray(allProps)) return violations;

    const referencedIds = new Set();
    if (Array.isArray(context.shots)) {
      for (const shot of context.shots) {
        const ids = Array.isArray(shot.props) ? shot.props : (Array.isArray(shot.prop_ids) ? shot.prop_ids : []);
        for (const value of ids) {
          const id = Number(typeof value === 'object' ? (value.prop_id ?? value.id) : value);
          if (Number.isFinite(id)) referencedIds.add(id);
        }
      }
    }
    const props = Array.isArray(context.shots)
      ? allProps.filter((prop) => referencedIds.has(Number(prop.id)))
      : allProps;

    props.forEach((prop, idx) => {
      const name = prop.name || `道具${idx + 1}`;
      const compatibility = String(prop.era_compatibility || '').trim().toLowerCase();
      const reason = String(prop.era_reason || '').trim();

      if (compatibility === 'incompatible') {
        violations.push({
          rule: 'INVARIANT_PROP_ERA_CONTRACT_CONFLICT',
          prop_id: prop.id,
          prop_name: name,
          severity: 'error',
          message: `道具「${name}」被 Agent 明确判定为与当前剧情时空不兼容${reason ? `：${reason}` : ''}。请修改道具、镜头时空或声明为剧情刻意跨时代。`,
        });
      } else if (!['compatible', 'intentional_cross_era'].includes(compatibility)) {
        violations.push({
          rule: 'INVARIANT_PROP_ERA_CONTRACT_UNDECLARED',
          prop_id: prop.id,
          prop_name: name,
          severity: 'warning',
          message: `道具「${name}」尚无结构化时代使用结论；旧数据允许继续，但建议由 Agent 标记 compatible、intentional_cross_era、incompatible 或 uncertain。`,
        });
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
