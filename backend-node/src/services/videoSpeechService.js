const videoClient = require('./videoClient');
const { assessVideoSpeech, timingError } = require('../utils/speechTiming');

function validateVideoSpeech(db, row, config) {
  const shot = row.storyboard_id
    ? db.prepare('SELECT * FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(Number(row.storyboard_id))
    : null;
  if(shot)require('./storyboardWardrobeService').assertSingleOutfit(shot);
  let duration = Number(shot?.duration) > 0 ? Number(shot.duration) : (Number(row.duration) > 0 ? Number(row.duration) : 5);
  const resolvedConfig = config || videoClient.getDefaultVideoConfig(db, row.model);
  if (resolvedConfig && videoClient.resolveVideoProtocol(resolvedConfig, row.model) === 'minimax_h3') {
    duration = videoClient.normalizeMinimaxH3Duration(duration);
  }
  const delivery=shot ? require('./speechDeliveryService').forShot(db,shot,{duration}) : null;
  const options=delivery ? require('./speechDeliveryService').budgetOptions(delivery) : {};
  const assessment = assessVideoSpeech(shot, row.prompt, duration, options);
  // Include saved universal edits even if a caller submits an older prompt.
  if (shot?.creation_mode === 'universal' && shot.universal_segment_text) {
    const universal = assessVideoSpeech(shot, shot.universal_segment_text, duration, options);
    if (!universal.ok) return { error: timingError(shot, universal), duration, assessment: universal };
  }
  return { error: assessment.ok ? null : timingError(shot, assessment), duration, assessment };
}

module.exports = { validateVideoSpeech };
