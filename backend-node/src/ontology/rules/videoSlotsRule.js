/**
 * 视听硬门禁：视频语义槽位契约与画外音口型审查
 */
const BaseInvariantRule = require('./baseRule');

class VideoSlotsRule extends BaseInvariantRule {
  constructor() {
    super({
      id: 'RULE_VIDEO_SLOTS',
      name: '视频语义槽位与画外音口型',
      category: 'video_slot',
      defaultSeverity: 'error',
      description: '杜绝画外音导致画内演员张嘴以及军事术语未具象化',
    });
  }

  evaluate(context) {
    const shots = context.shots;
    const violations = [];
    if (!Array.isArray(shots)) return violations;

    const { validateVideoSlots } = require('../videoSlots');

    shots.forEach((shot, idx) => {
      let vidSlots = shot.video_slots;
      if (typeof vidSlots === 'string') {
        try { vidSlots = JSON.parse(vidSlots); } catch (_) { vidSlots = null; }
      }
      if (vidSlots && typeof vidSlots === 'object') {
        const vErrs = validateVideoSlots(shot, vidSlots);
        violations.push(...vErrs);
      }
    });

    return violations;
  }
}

module.exports = VideoSlotsRule;
