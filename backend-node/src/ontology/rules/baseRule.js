/**
 * 视听本体 SHACL 规则规范基类 (BaseInvariantRule)
 * 基于 Specification 模式设计，每个规则封装单一视听硬门禁或约束逻辑
 */

class BaseInvariantRule {
  /**
   * @param {object} options
   * @param {string} options.id - 规则唯一标识符
   * @param {string} options.name - 规则人类可读名称
   * @param {string} options.category - 规则门类 (camera/audio/speech/visual_slot/video_slot/crowd/h3/prompt/continuity/prop/asset)
   * @param {'error'|'warning'} [options.defaultSeverity='error'] - 默认严重级别
   * @param {string} [options.description] - 规则详细解释
   */
  constructor({ id, name, category, defaultSeverity = 'error', description = '' }) {
    if (!id) throw new Error('InvariantRule requires an id');
    this.id = id;
    this.name = name;
    this.category = category;
    this.defaultSeverity = defaultSeverity;
    this.description = description;
    this.enabled = true;
  }

  /**
   * 评估规则
   * @param {object} context - 包含 shots, props, dramaEra, catalogs, scriptContent, options 等上下文
   * @returns {Array<object>} 违规列表 [{ rule, shot_number, severity, message, ... }]
   */
  evaluate(context) {
    throw new Error(`Rule ${this.id} must implement evaluate(context)`);
  }
}

module.exports = BaseInvariantRule;
