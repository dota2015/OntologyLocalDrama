/**
 * 影视视听本体约束与硬门禁引擎（Audiovisual Semantic Invariants）
 * 灵感源自 SHACL 质量形状与规则门禁体系（Specification / Rule Engine 模式）：
 * - 拒绝隐式错误，任何违背视听语法与连戏铁律的情况均输出具名违规项（Violations）
 * - 供 Agent 自省反思环（Self-Reflection Loop）作为质检反馈，精准指导 Agent 进行微调纠偏
 * - 本模块作为 Facade，对底层规则引擎与规则规约进行统一组装与暴露
 */

const BaseInvariantRule = require('./rules/baseRule');
const AudioContractRule = require('./rules/audioContractRule');
const SpeechTimingRule = require('./rules/speechTimingRule');
const { VisualSlotCompletenessRule, parseCharacterIds } = require('./rules/visualSlotCompletenessRule');
const VideoSlotsRule = require('./rules/videoSlotsRule');
const CrowdControlRule = require('./rules/crowdControlRule');
const H3ReferenceCapacityRule = require('./rules/h3ReferenceCapacityRule');
const SpatialContinuityRule = require('./rules/spatialContinuityRule');
const { PropEraAndScaleRule, MODERN_ANACHRONISMS } = require('./rules/propEraAndScaleRule');
const ObsoleteAssetsRule = require('./rules/obsoleteAssetsRule');
const ShotTransitionContinuityRule = require('./rules/shotTransitionContinuityRule');
const { CrossSlotInvariantsRule } = require('./rules/crossSlotRules');
const { AssetReferenceRule, planningFeasibilityViolations } = require('./rules/assetReferenceRule');
const { InvariantRuleEngine, defaultEngine } = require('./ruleEngine');

/**
 * 运行全部视听本体质量门禁（统一由 InvariantRuleEngine 执行求值）
 * @param {Array<object>} shots
 * @param {object} [options]
 * @param {Array<object>} [options.props]
 * @param {string} [options.dramaEra]
 * @param {object} [options.catalogs]
 * @param {string} [options.scriptContent]
 * @returns {{ valid: boolean, error_count: number, warning_count: number, violations: Array<object>, warnings: Array<object>, stats: object, summary: string }}
 */
function validateAllInvariants(shots, options = {}) {
  return defaultEngine.validate({
    shots,
    props: options.props,
    dramaEra: options.dramaEra,
    catalogs: options.catalogs,
    scriptContent: options.scriptContent,
    options,
  }, options);
}

module.exports = {
  // 核心规则引擎与基类
  InvariantRuleEngine,
  defaultEngine,
  BaseInvariantRule,

  // 具体规则实现
  AudioContractRule,
  SpeechTimingRule,
  VisualSlotCompletenessRule,
  VideoSlotsRule,
  CrowdControlRule,
  H3ReferenceCapacityRule,
  SpatialContinuityRule,
  PropEraAndScaleRule,
  ObsoleteAssetsRule,
  ShotTransitionContinuityRule,
  CrossSlotInvariantsRule,
  AssetReferenceRule,

  // 词表与核心判定入口
  MODERN_ANACHRONISMS,
  parseCharacterIds,
  planningFeasibilityViolations,
  validateAllInvariants,
};
