const SUPPORTED_VIDEO_FAMILIES = Object.freeze({
  H3: 'minimax_h3',
});

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function modelValues(config, modelHint) {
  const values = [];
  if (modelHint) values.push(modelHint);
  if (config?.default_model) values.push(config.default_model);
  if (Array.isArray(config?.model)) values.push(...config.model);
  else if (config?.model) values.push(config.model);
  return values.map(normalize).filter(Boolean);
}

function isH3Model(model) {
  return /^minimax[-_]?h3(?:$|[-_.])/.test(normalize(model));
}

function resolveSupportedVideoFamily(config = {}, modelHint = '') {
  const protocol = normalize(config.api_protocol);
  const provider = normalize(config.provider);
  const models = modelValues(config, modelHint);

  if (protocol === SUPPORTED_VIDEO_FAMILIES.H3 || provider === SUPPORTED_VIDEO_FAMILIES.H3) {
    return models.length > 0 && models.every(isH3Model) ? SUPPORTED_VIDEO_FAMILIES.H3 : null;
  }
  if ((!protocol || protocol === 'openai') && models.length > 0 && models.every(isH3Model)) {
    return SUPPORTED_VIDEO_FAMILIES.H3;
  }
  return null;
}

function isSupportedVideoConfig(config, modelHint = '') {
  return !!resolveSupportedVideoFamily(config, modelHint);
}

function assertSupportedVideoConfig(config, modelHint = '') {
  const family = resolveSupportedVideoFamily(config, modelHint);
  if (!family) {
    const error = new Error('当前仅支持 MiniMax H3 视频模型');
    error.status = 400;
    error.code = 'UNSUPPORTED_VIDEO_MODEL';
    throw error;
  }
  return family;
}

module.exports = {
  SUPPORTED_VIDEO_FAMILIES,
  resolveSupportedVideoFamily,
  isSupportedVideoConfig,
  assertSupportedVideoConfig,
  isH3Model,
};
