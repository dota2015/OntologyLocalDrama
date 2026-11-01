const aiConfigs = require('./aiConfigService');
const videoClient = require('./videoClient');
const { meaningful } = require('./speechExtractionService');
const { speechFromPrompt } = require('../utils/speechTiming');
const { isSupportedVideoConfig, assertSupportedVideoConfig } = require('./videoModelSupport');

function hasSpeech(shot) {
  if (meaningful(shot?.dialogue) || meaningful(shot?.narration)) return true;
  const cues = speechFromPrompt(shot?.universal_segment_text || '');
  return !!(meaningful(cues.dialogue) || meaningful(cues.narration));
}
function automaticModel(configs, speech) {
  const active = configs.filter(c => c.is_active && isSupportedVideoConfig(c));
  // 视频生成只有 MiniMax H3 一条受支持链路。
  const preferred = active.find(c => {
    const proto = videoClient.resolveVideoProtocol(c);
    const m = String(c.default_model || c.model || '');
    return proto === 'minimax_h3' || /minimax[_-]?h3/i.test(m);
  });
  const config = preferred || active.find(c => c.is_default) || active[0];
  return config ? (config.default_model || (Array.isArray(config.model) ? config.model[0] : config.model)) : null;
}
function musicPrompt(prompt, config, shot) {
  if (!shot || hasSpeech(shot) || videoClient.resolveVideoProtocol(config || {}) !== 'minimax_h3') return prompt;
  const cleanPrompt = String(prompt || '').replace(/[\[【]?(?:禁BGM|无背景音乐|禁止背景音乐|no\s+(?:background\s+music|bgm))[\]】]?/giu, '').trim();
  const bgm = shot.bgm_prompt || require('./angleService').inferBgmPrompt(shot);
  const bgmSpec = bgm ? `背景音乐与配乐要求：${bgm}。` : '';
  return cleanPrompt + `\n本镜无人物对白、无解说旁白；${bgmSpec}根据场景与情绪生成匹配的高质量背景音乐和环境音效。`;
}
function resolveStoryboardModel(db, body) {
  const shot = body.storyboard_id != null
    ? db.prepare('SELECT * FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(Number(body.storyboard_id)) : null;
  if (body.storyboard_id != null && !shot) throw new Error('分镜不存在或已删除');
  if (shot && body.drama_id != null) {
    const episode = db.prepare('SELECT drama_id FROM episodes WHERE id = ? AND deleted_at IS NULL').get(shot.episode_id);
    if (!episode || Number(episode.drama_id) !== Number(body.drama_id)) throw new Error('分镜不属于当前项目或已删除');
  }
  const explicit = body.model || shot?.video_model;
  const selected = explicit || (shot ? automaticModel(aiConfigs.listConfigs(db, 'video'), hasSpeech(shot)) : null);
  const config = videoClient.getDefaultVideoConfig(db, selected);
  if (!config) throw Object.assign(new Error('没有可用的 MiniMax H3 视频配置'), { status: 400 });
  assertSupportedVideoConfig(config, selected);
  if (explicit && (!config || !(Array.isArray(config.model) ? config.model : [config.model]).includes(explicit))) throw new Error('所选视频模型未启用或已删除，请重新选择');
  return { model: selected || config?.default_model || null, provider: config?.provider || body.provider || 'chatfire', config, shot };
}

module.exports = { musicPrompt, hasSpeech, automaticModel, resolveStoryboardModel };
