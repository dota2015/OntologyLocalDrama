/**
 * 门禁 2：音频视听合同检查。
 *
 * 无语言镜头不必强行添加 BGM：动作/环境音、纯器乐配乐和完全静音
 * 是三种互斥合同，具体互斥关系由 crossSlotRules 统一检查。
 */
const BaseInvariantRule = require('./baseRule');

class AudioContractRule extends BaseInvariantRule {
  constructor() {
    super({
      id: 'RULE_AUDIO_CONTRACT',
      name: '音频视听合同',
      category: 'audio',
      defaultSeverity: 'error',
      description: '音频模式由 semantic_slots.audio_lip_sync 与 sound_plan 共同声明；环境音、纯配乐和完全静音互斥',
    });
  }

  evaluate(context) {
    const shots = context.shots;
    const violations = [];
    if (!Array.isArray(shots)) return violations;

    shots.forEach((shot, idx) => {
      const shotNum = shot.shot_number || (idx + 1);
      // The absence of speech alone is not an audio error. The director may
      // choose silent_ambient, bgm_only, or is_silent; cross-slot validation
      // checks that the selected contract and sound fields agree.
      // Keep this rule as the category anchor; the cross-slot rule owns the
      // mutually exclusive field-level checks so one shot yields one coherent
      // feedback set instead of a legacy "missing BGM" error.
    });

    return violations;
  }
}

module.exports = AudioContractRule;
