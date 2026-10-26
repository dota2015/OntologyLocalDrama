/**
 * 检验是否有不符合当前剧本且分镜未引用的过时/孤儿资产（角色、道具、场地）
 */
const BaseInvariantRule = require('./baseRule');
const { isAssetObsolete } = require('../assetMatcher');

class ObsoleteAssetsRule extends BaseInvariantRule {
  constructor() {
    super({
      id: 'RULE_OBSOLETE_ASSETS',
      name: '过时与孤儿资产审查',
      category: 'asset',
      defaultSeverity: 'warning',
      description: '识别在剧本和分镜中均未出场且超过冷却期的过时残留角色、道具与场景',
    });
  }

  evaluate(context) {
    const catalogs = context.catalogs || {};
    const scriptContent = context.scriptContent || '';
    const shots = context.shots || [];
    const options = context.options || {};
    const violations = [];

    const script = String(scriptContent || '').trim();
    if (!script) return violations;

    const characters = catalogs.characters || [];
    const props = catalogs.props || [];
    const scenes = catalogs.scenes || [];

    for (const c of characters) {
      const name = String(c.name || '').trim();
      if (!name) continue;
      if (isAssetObsolete('character', c, { script, shots, ...options })) {
        violations.push({
          rule: 'INVARIANT_OBSOLETE_ASSET',
          severity: this.defaultSeverity,
          asset_type: 'character',
          asset_id: c.id,
          asset_name: name,
          message: `角色「${name}」在当前剧本正文与分镜中均未发现出场，疑似废弃或剧情调整后的残留，建议删除。`,
        });
      }
    }

    for (const p of props) {
      const name = String(p.name || '').trim();
      if (!name) continue;
      if (isAssetObsolete('prop', p, { script, shots, ...options })) {
        violations.push({
          rule: 'INVARIANT_OBSOLETE_ASSET',
          severity: this.defaultSeverity,
          asset_type: 'prop',
          asset_id: p.id,
          asset_name: name,
          message: `道具「${name}」在当前剧本正文与分镜中未见使用记录，建议删除以精简世界观。`,
        });
      }
    }

    for (const sc of scenes) {
      const loc = String(sc.location || '').trim();
      if (!loc) continue;
      if (isAssetObsolete('scene', sc, { script, shots, ...options })) {
        violations.push({
          rule: 'INVARIANT_OBSOLETE_ASSET',
          severity: this.defaultSeverity,
          asset_type: 'scene',
          asset_id: sc.id,
          asset_name: loc,
          message: `场地「${loc}」在当前剧本与分镜中均未被涉及，建议删除。`,
        });
      }
    }

    return violations;
  }
}

module.exports = ObsoleteAssetsRule;
