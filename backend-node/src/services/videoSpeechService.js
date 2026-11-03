const videoClient = require('./videoClient');
const { assessVideoSpeech, timingError } = require('../utils/speechTiming');
const { normalizeExecutionPlan, CONTINUUM_MAX_SECONDS } = require('./continuumPlan');

function validateVideoSpeech(db, row, config) {
  const shot = row.storyboard_id
    ? db.prepare('SELECT * FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(Number(row.storyboard_id))
    : null;
  if(shot)require('./storyboardWardrobeService').assertSingleOutfit(shot);
  let duration = Number(shot?.duration) > 0 ? Number(shot.duration) : (Number(row.duration) > 0 ? Number(row.duration) : 5);
  const resolvedConfig = config || videoClient.getDefaultVideoConfig(db, row.model);
  const protocol = resolvedConfig ? videoClient.resolveVideoProtocol(resolvedConfig, row.model) : '';
  if (protocol === 'minimax_h3') {
    if (!Number.isInteger(duration) || duration < 4 || duration > CONTINUUM_MAX_SECONDS) {
      return {
        error: `H3 单个逻辑分镜时长必须是 4～30 秒整数（普通 H3 的 duration 必须是 4～8 秒整数，9～30 秒为 Continuum），当前为 ${duration} 秒；请让导演 Agent 调整或拆镜，后端不会静默改写`,
        duration,
        assessment: null,
      };
    }
    const slots = shot ? (() => {
      try { return typeof shot.semantic_slots === 'string' ? JSON.parse(shot.semantic_slots) : shot.semantic_slots || {}; } catch (_) { return {}; }
    })() : {};
    let execution;
    try { execution = normalizeExecutionPlan(duration, slots); } catch (error) {
      return { error: error.message, duration, assessment: null };
    }
    duration = execution.continuum_plan?.total_duration || duration;
    const delivery=shot ? require('./speechDeliveryService').forShot(db,shot,{duration}) : null;
    const options=delivery ? require('./speechDeliveryService').budgetOptions(delivery) : {};
    const assessment = assessVideoSpeech(shot, null, duration, options);
    return { error: assessment.ok ? null : timingError(shot, assessment), duration, assessment, ...execution };
  }
  const delivery=shot ? require('./speechDeliveryService').forShot(db,shot,{duration}) : null;
  const options=delivery ? require('./speechDeliveryService').budgetOptions(delivery) : {};
  const assessment = assessVideoSpeech(shot, null, duration, options);
  return { error: assessment.ok ? null : timingError(shot, assessment), duration, assessment };
}

module.exports = { validateVideoSpeech };
