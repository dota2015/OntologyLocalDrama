const videoClient = require('./videoClient');
const { assessVideoSpeech, timingError } = require('../utils/speechTiming');

function validateVideoSpeech(db, row, config) {
  const shot = row.storyboard_id
    ? db.prepare('SELECT * FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(Number(row.storyboard_id))
    : null;
  if(shot)require('./storyboardWardrobeService').assertSingleOutfit(shot);
  let duration = Number(shot?.duration) > 0 ? Number(shot.duration) : (Number(row.duration) > 0 ? Number(row.duration) : 5);
  const resolvedConfig = config || videoClient.getDefaultVideoConfig(db, row.model);
  const protocol = resolvedConfig ? videoClient.resolveVideoProtocol(resolvedConfig, row.model) : '';
  if (protocol === 'minimax_h3') {
    if (!Number.isInteger(duration) || duration < 4 || duration > 8) {
      return {
        error: `H3 单镜时长必须是 4～8 秒整数，当前为 ${duration} 秒；请让导演 Agent 调整或拆镜，后端不会静默改写`,
        duration,
        assessment: null,
      };
    }
    duration = videoClient.normalizeMinimaxH3Duration(duration);
  }
  const delivery=shot ? require('./speechDeliveryService').forShot(db,shot,{duration}) : null;
  const options=delivery ? require('./speechDeliveryService').budgetOptions(delivery) : {};
  const assessment = assessVideoSpeech(shot, null, duration, options);
  return { error: assessment.ok ? null : timingError(shot, assessment), duration, assessment };
}

module.exports = { validateVideoSpeech };
