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
      const hasDialogue = !!(shot.dialogue && String(shot.dialogue).trim() && !/^(?:无|无对白|无对话|无台词|none|null|n\/a)[。.!！\s]*$/iu.test(String(shot.dialogue).trim()));
      const hasNarration = !!(shot.narration && String(shot.narration).trim() && !/^(?:无|无旁白|无解说|none|null|n\/a)[。.!！\s]*$/iu.test(String(shot.narration).trim()));
      if (!hasDialogue && !hasNarration) return;

      const duration = Number(shot.duration) > 0 ? Number(shot.duration) : 5;
      let deliveryOptions = options.deliveryOptions || {};
      if (!deliveryOptions.speechRate && options.db && shot.id) {
        try {
          const delivery = speechDelivery.forShot(options.db, shot, { duration });
          deliveryOptions = speechDelivery.budgetOptions(delivery);
        } catch (_) {}
      } else if (!deliveryOptions.speechRate) {
        deliveryOptions = { speechRate: 1.44, turnPauseSeconds: 0 };
      }

      const prompt = shot.video_prompt || shot.universal_segment_text || '';
      const assessment = assessVideoSpeech(shot, prompt, duration, deliveryOptions);
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
