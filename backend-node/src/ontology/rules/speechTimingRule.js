/**
 * 门禁：台词与旁白时长预算检查（Speech Timing Budget Hard Gate）
 */
const BaseInvariantRule = require('./baseRule');

class SpeechTimingRule extends BaseInvariantRule {
  constructor() {
    super({
      id: 'RULE_SPEECH_TIMING',
      name: '台词与旁白时长预算',
      category: 'speech',
      defaultSeverity: 'error',
      description: '严格防止台词字数超出镜头物理容纳上限，造成下游视频生成或口型合成硬中断',
    });
  }

  evaluate(context) {
    const shots = context.shots;
    const options = context.options || context;
    const violations = [];
    if (!Array.isArray(shots)) return violations;

    const { assessVideoSpeech, timingError } = require('../../utils/speechTiming');
    const speechDelivery = require('../../services/speechDeliveryService');

    shots.forEach((shot, idx) => {
      const shotNum = shot.shot_number || shot.storyboard_number || (idx + 1);
      const duration = Number(shot.duration) > 0 ? Number(shot.duration) : 5;
      // Drafts have no database ID. Apply exactly the same speech policy used
      // by persisted shots at submission; never assume accelerated speech.
      const explicit = options?.deliveryOptions && typeof options.deliveryOptions === 'object' ? options.deliveryOptions : {};
      const deliveryOptions = speechDelivery.budgetOptions(speechDelivery.resolve({}, shot, { duration, ...explicit }));
      const assessment = assessVideoSpeech(shot, null, duration, deliveryOptions);
      if (!assessment.ok) {
        violations.push({
          rule: 'INVARIANT_SPEECH_OVER_BUDGET',
          shot_number: shotNum,
          severity: this.defaultSeverity,
          message: timingError(shot, assessment),
          assessment,
        });
      }
    });

    return violations;
  }
}

module.exports = SpeechTimingRule;
