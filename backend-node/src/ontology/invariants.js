/**
 * 影视视听本体约束与硬门禁引擎（Audiovisual Semantic Invariants）
 * 灵感源自 SHACL 质量形状与规则门禁体系（Specification / Rule Engine 模式）：
 * - 拒绝隐式错误，任何违背视听语法与连戏铁律的情况均输出具名违规项（Violations）
 * - 供 Agent 自省反思环（Self-Reflection Loop）作为质检反馈，精准指导 Agent 进行微调纠偏
 * - 本模块作为 Facade，对底层规则引擎与规则规约进行统一组装与暴露
 */

const BaseInvariantRule = require('./rules/baseRule');
const MovementDynamismRule = require('./rules/movementDynamismRule');
const AudioContractRule = require('./rules/audioContractRule');
const SpeechTimingRule = require('./rules/speechTimingRule');
const { VisualSlotCompletenessRule, parseCharacterIds } = require('./rules/visualSlotCompletenessRule');
const VideoSlotsRule = require('./rules/videoSlotsRule');
const CrowdControlRule = require('./rules/crowdControlRule');
const H3ReferenceCapacityRule = require('./rules/h3ReferenceCapacityRule');
const { PhysicalDescriptionRule, FORBIDDEN_METAPHORS, FORBIDDEN_UI_TEXT } = require('./rules/physicalDescriptionRule');
const SpatialContinuityRule = require('./rules/spatialContinuityRule');
const { PropEraAndScaleRule, MODERN_ANACHRONISMS } = require('./rules/propEraAndScaleRule');
const ObsoleteAssetsRule = require('./rules/obsoleteAssetsRule');
const { InvariantRuleEngine, defaultEngine } = require('./ruleEngine');

// 实例化用于直接独立调用的单例规则
const movementRule = defaultEngine.getRule('RULE_MOVEMENT_DYNAMISM') || new MovementDynamismRule();
const audioRule = defaultEngine.getRule('RULE_AUDIO_CONTRACT') || new AudioContractRule();
const speechTimingRule = defaultEngine.getRule('RULE_SPEECH_TIMING') || new SpeechTimingRule();
const visualSlotRule = defaultEngine.getRule('RULE_VISUAL_SLOT_COMPLETENESS') || new VisualSlotCompletenessRule();
const videoSlotsRule = defaultEngine.getRule('RULE_VIDEO_SLOTS') || new VideoSlotsRule();
const crowdRule = defaultEngine.getRule('RULE_CROWD_CONTROL') || new CrowdControlRule();
const h3CapRule = defaultEngine.getRule('RULE_H3_REFERENCE_CAPACITY') || new H3ReferenceCapacityRule();
const physicalDescRule = defaultEngine.getRule('RULE_PHYSICAL_DESCRIPTION') || new PhysicalDescriptionRule();
const spatialRule = defaultEngine.getRule('RULE_SPATIAL_CONTINUITY') || new SpatialContinuityRule();
const propRule = defaultEngine.getRule('RULE_PROP_ERA_AND_SCALE') || new PropEraAndScaleRule();
const obsoleteRule = defaultEngine.getRule('RULE_OBSOLETE_ASSETS') || new ObsoleteAssetsRule();

/**
 * 门禁 1：运镜动态感与固定镜头比例检查（严格少用固定镜头）
 * @param {Array<object>} shots
 * @returns {Array<object>} 违规列表
 */
function checkMovementDynamism(shots) {
  return movementRule.evaluate({ shots });
}

/**
 * 门禁 2：音频视听合同检查（无对白必配 BGM，供给 H3/Seedance）
 * @param {Array<object>} shots
 * @returns {Array<object>} 违规列表
 */
function checkAudioContract(shots) {
  return audioRule.evaluate({ shots });
}

/**
 * 门禁：台词与旁白时长预算检查（Speech Timing Budget Hard Gate）
 * @param {Array<object>} shots
 * @param {object} options
 * @returns {Array<object>} 违规列表
 */
function checkSpeechTiming(shots, options = {}) {
  return speechTimingRule.evaluate({ shots, options });
}

/**
 * 门禁：生图构图槽位完整性检查（Visual Slots & Freeze-frame Posture Hard Gate）
 * @param {Array<object>} shots
 * @returns {Array<object>} 违规列表
 */
function checkVisualSlotCompleteness(shots) {
  return visualSlotRule.evaluate({ shots });
}

/**
 * 视听硬门禁：视频语义槽位契约与画外音口型审查
 * @param {Array<object>} shots
 * @returns {Array<object>} 违规列表
 */
function checkVideoSlots(shots) {
  return videoSlotsRule.evaluate({ shots });
}

/**
 * 门禁 3：群戏防人脸崩溃与防克隆人检查（单镜角色 <= 3）
 * @param {Array<object>} shots
 * @returns {Array<object>} 违规列表
 */
function checkCrowdControl(shots) {
  return crowdRule.evaluate({ shots });
}

/**
 * 门禁：H3视频参考图物理上限与复杂度审查（单镜角色<=3，核心道具<=2）
 * @param {Array<object>} shots
 * @returns {Array<object>} 违规列表
 */
function checkH3ReferenceCapacity(shots) {
  return h3CapRule.evaluate({ shots });
}

/**
 * 门禁 4：纯物理描写与禁止UI/文字交代剧情检查
 * @param {Array<object>} shots
 * @returns {Array<object>} 违规列表
 */
function checkPhysicalVisualDescription(shots) {
  return physicalDescRule.evaluate({ shots });
}

/**
 * 门禁 5：镜头间空间连续性检查（防跳切与瞬移）
 * @param {Array<object>} shots
 * @returns {Array<object>} 违规列表
 */
function checkSpatialContinuity(shots) {
  return spatialRule.evaluate({ shots });
}

/**
 * 门禁 6：道具时代与物理尺度硬约束检查
 * @param {Array<object>} props
 * @param {string} dramaEra - ancient, modern, sci_fi, etc.
 * @returns {Array<object>} 违规列表
 */
function checkPropEraAndScale(props, dramaEra = 'modern') {
  return propRule.evaluate({ props, dramaEra });
}

/**
 * 检验是否有不符合当前剧本且分镜未引用的过时/孤儿资产（角色、道具、场地）
 * @param {object} catalogs - { characters: [], props: [], scenes: [] }
 * @param {string} scriptContent - 当前集/全剧剧本
 * @param {Array<object>} shots - 分镜列表
 * @param {object} [options]
 * @returns {Array<object>} 警告项列表
 */
function checkObsoleteAssets(catalogs = {}, scriptContent = '', shots = [], options = {}) {
  return obsoleteRule.evaluate({ catalogs, scriptContent, shots, options });
}

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
  MovementDynamismRule,
  AudioContractRule,
  SpeechTimingRule,
  VisualSlotCompletenessRule,
  VideoSlotsRule,
  CrowdControlRule,
  H3ReferenceCapacityRule,
  PhysicalDescriptionRule,
  SpatialContinuityRule,
  PropEraAndScaleRule,
  ObsoleteAssetsRule,

  // 词表与辅助函数
  FORBIDDEN_METAPHORS,
  FORBIDDEN_UI_TEXT,
  MODERN_ANACHRONISMS,
  parseCharacterIds,

  // 向后兼容的标准门禁 API
  checkMovementDynamism,
  checkAudioContract,
  checkSpeechTiming,
  checkVisualSlotCompleteness,
  checkVideoSlots,
  checkCrowdControl,
  checkH3ReferenceCapacity,
  checkPhysicalVisualDescription,
  checkSpatialContinuity,
  checkPropEraAndScale,
  checkObsoleteAssets,
  validateAllInvariants,
};
