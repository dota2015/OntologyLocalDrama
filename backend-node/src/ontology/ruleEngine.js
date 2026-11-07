/**
 * 视听本体 SHACL 不变量规则引擎 (InvariantRuleEngine)
 * 基于 Specification / Rule Engine 模式，统一调度、管理与评估视听质检规则
 */

const BaseInvariantRule = require('./rules/baseRule');
const AudioContractRule = require('./rules/audioContractRule');
const SpeechTimingRule = require('./rules/speechTimingRule');
const { VisualSlotCompletenessRule } = require('./rules/visualSlotCompletenessRule');
const VideoSlotsRule = require('./rules/videoSlotsRule');
const CrowdControlRule = require('./rules/crowdControlRule');
const H3ReferenceCapacityRule = require('./rules/h3ReferenceCapacityRule');
const { PhysicalDescriptionRule } = require('./rules/physicalDescriptionRule');
const SpatialContinuityRule = require('./rules/spatialContinuityRule');
const { PropEraAndScaleRule } = require('./rules/propEraAndScaleRule');
const ObsoleteAssetsRule = require('./rules/obsoleteAssetsRule');
const SceneCoPresenceRule = require('./rules/sceneCoPresenceRule');
const ShotTransitionContinuityRule = require('./rules/shotTransitionContinuityRule');
const { CrossSlotInvariantsRule } = require('./rules/crossSlotRules');
const { AssetReferenceRule } = require('./rules/assetReferenceRule');
const { CAMERA_MOVEMENTS } = require('./schema');

class InvariantRuleEngine {
  constructor() {
    /** @type {Map<string, BaseInvariantRule>} */
    this.rules = new Map();
    this._registerDefaultRules();
  }

  _registerDefaultRules() {
    this.registerRule(new AudioContractRule());
    this.registerRule(new SpeechTimingRule());
    this.registerRule(new VisualSlotCompletenessRule());
    this.registerRule(new VideoSlotsRule());
    this.registerRule(new CrowdControlRule());
    this.registerRule(new H3ReferenceCapacityRule());
    this.registerRule(new PhysicalDescriptionRule());
    this.registerRule(new SpatialContinuityRule());
    this.registerRule(new PropEraAndScaleRule());
    this.registerRule(new ObsoleteAssetsRule());
    this.registerRule(new SceneCoPresenceRule());
    this.registerRule(new ShotTransitionContinuityRule());
    this.registerRule(new CrossSlotInvariantsRule());
    this.registerRule(new AssetReferenceRule());
  }

  /**
   * 注册质检规则
   * @param {BaseInvariantRule} rule
   */
  registerRule(rule) {
    if (!rule || !rule.id) {
      throw new Error('Invalid rule: rule must have an id');
    }
    this.rules.set(rule.id, rule);
  }

  /**
   * 移除规则
   * @param {string} ruleId
   */
  unregisterRule(ruleId) {
    this.rules.delete(ruleId);
  }

  /**
   * 获取指定规则
   * @param {string} ruleId
   * @returns {BaseInvariantRule|undefined}
   */
  getRule(ruleId) {
    return this.rules.get(ruleId);
  }

  /**
   * 获取全部已注册规则列表
   * @returns {Array<BaseInvariantRule>}
   */
  getRules() {
    return Array.from(this.rules.values());
  }

  /**
   * 运行全部或指定规则的本体约束校验
   * @param {object} context
   * @param {Array<object>} context.shots - 分镜列表
   * @param {Array<object>} [context.props] - 道具列表
   * @param {string} [context.dramaEra] - 剧本时代
   * @param {object} [context.catalogs] - 资产目录
   * @param {string} [context.scriptContent] - 剧本文本
   * @param {object} [options]
   * @param {Array<string>} [options.disabledRules] - 禁用的规则 ID
   * @param {Array<string>} [options.onlyCategories] - 仅运行的类别
   * @param {Record<string, 'error'|'warning'>} [options.severityOverrides] - 覆盖规则严重级别
   * @returns {{ valid: boolean, error_count: number, warning_count: number, violations: Array<object>, warnings: Array<object>, stats: object, summary: string }}
   */
  validate(context = {}, options = {}) {
    const disabled = new Set(options.disabledRules || []);
    const onlyCategories = options.onlyCategories ? new Set(options.onlyCategories) : null;
    const severityOverrides = options.severityOverrides || {};

    const allViolations = [];

    for (const rule of this.rules.values()) {
      if (!rule.enabled || disabled.has(rule.id)) continue;
      if (onlyCategories && !onlyCategories.has(rule.category)) continue;

      // 视条件跳过：无 props 时跳过 propEraAndScaleRule；无 catalogs/scriptContent 时跳过 obsoleteAssets
      if (rule.id === 'RULE_PROP_ERA_AND_SCALE' && (!context.props || !Array.isArray(context.props))) {
        continue;
      }
      if (rule.id === 'RULE_OBSOLETE_ASSETS' && (!context.catalogs || !context.scriptContent)) {
        continue;
      }

      try {
        const res = rule.evaluate({ ...context, options });
        if (Array.isArray(res) && res.length > 0) {
          // 若有级别覆盖
          if (severityOverrides[rule.id]) {
            res.forEach((v) => {
              v.severity = severityOverrides[rule.id];
            });
          }
          allViolations.push(...res);
        }
      } catch (err) {
        allViolations.push({
          rule: rule.id,
          severity: 'error',
          message: `规则 [${rule.name}] 执行异常: ${err.message}`,
        });
      }
    }

    const errors = allViolations.filter((v) => v.severity === 'error');
    const warnings = allViolations.filter((v) => v.severity === 'warning');

    let summary = '全部视听本体约束校验通过，符合高质量电影镜头规范。';
    if (errors.length > 0) {
      summary = `发现 ${errors.length} 项视听硬门禁违规，${warnings.length} 项质量警告，需要 Agent 进行针对性纠偏。`;
    } else if (warnings.length > 0) {
      summary = `视听门禁基本通过，但存在 ${warnings.length} 项质量优化建议。`;
    }

    // 统计视听核心指标
    const shots = context.shots;
    const total = Array.isArray(shots) ? shots.length : 0;
    let staticCount = 0;
    let silentCount = 0;
    let silentWithBgm = 0;

    if (Array.isArray(shots)) {
      shots.forEach((s) => {
        const mov = String(s.movement || '').toLowerCase().trim();
        if (mov === CAMERA_MOVEMENTS.STATIC || mov === '固定') staticCount++;
        const hasDialogue = !!(s.dialogue && String(s.dialogue).trim());
        const hasNarration = !!(s.narration && String(s.narration).trim());
        if (!hasDialogue && !hasNarration) {
          silentCount++;
          const bgm = String(s.bgm_prompt || '').trim();
          if (bgm && bgm !== '无' && bgm !== '无BGM' && bgm !== '禁BGM') {
            silentWithBgm++;
          }
        }
      });
    }

    return {
      valid: errors.length === 0,
      error_count: errors.length,
      warning_count: warnings.length,
      violations: errors,
      warnings: warnings,
      stats: {
        total_shots: total,
        static_shots: staticCount,
        dynamic_shots: Math.max(0, total - staticCount),
        static_ratio: total > 0 ? staticCount / total : 0,
        silent_shots: silentCount,
        silent_with_bgm: silentWithBgm,
      },
      summary,
    };
  }
}

// 导出单例实例与类
const defaultEngine = new InvariantRuleEngine();

module.exports = {
  InvariantRuleEngine,
  defaultEngine,
};
