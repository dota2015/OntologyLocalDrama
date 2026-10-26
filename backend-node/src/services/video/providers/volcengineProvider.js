/**
 * 火山引擎 / Seedance 视频服务提供商策略 (VolcengineVideoProvider)
 * 支持 Seedance 2.0 / 2.5、多图 Omni 参考及 Cheap_Seedance2 协议
 */

const BaseVideoProvider = require('../baseProvider');
const { pickModelId, flattenModelIds, ARK_RETIRED_VIDEO_MODELS } = require('../../modelId');

const VOLC_MODEL_ALIASES = {
  'doubao-seedance-1.0-pro-fast':  'doubao-seedance-1-0-pro-250528',
  'doubao-seedance-1.0-pro':       'doubao-seedance-1-0-pro-250528',
  'doubao-seedance-1-0-pro':       'doubao-seedance-1-0-pro-250528',
  'doubao-seedance-1.0-lite':      'doubao-seedance-1-0-lite-250428',
  'doubao-seedance-1-0-lite':      'doubao-seedance-1-0-lite-250428',
  'doubao-seedance-1.5-pro':       'doubao-seedance-1-5-pro-251215',
  'doubao-seedance-1-5-pro':       'doubao-seedance-1-5-pro-251215',
  'doubao-seedance-2.0-pro':       'doubao-seedance-2-0-260128',
  'doubao-seedance-2-0-pro':       'doubao-seedance-2-0-260128',
  'doubao-seedance-2.0-fast':      'doubao-seedance-2-0-fast-260128',
  'doubao-seedance-2-0-fast':      'doubao-seedance-2-0-fast-260128',
};

function isOfficialArkVideoConfig(config) {
  return String(config?.base_url || '').toLowerCase().includes('volces.com');
}

function normalizeVolcModel(name, config) {
  const id = pickModelId(name);
  if (!id) return name;
  const aliased = VOLC_MODEL_ALIASES[id.toLowerCase()] || id;
  if (!isOfficialArkVideoConfig(config)) return aliased;
  return ARK_RETIRED_VIDEO_MODELS[String(aliased).toLowerCase()] || aliased;
}

function isSeedance2FamilyModel(modelName) {
  const m = String(modelName || '').toLowerCase().trim();
  if (!m) return false;
  if (/seedance[-_]?2|seedance2/.test(m)) return true;
  if (/2[-_]0[-_]/.test(m)) return true;
  if (/(^|[-_./])sd2($|[-_./])/.test(m)) return true;
  return false;
}

function shouldUseVolcOmniMultiReference(protocol, modelName, referenceUrls) {
  if (String(protocol || '').toLowerCase() !== 'volcengine') return false;
  if (!isSeedance2FamilyModel(modelName)) return false;
  const refs = Array.isArray(referenceUrls) ? referenceUrls.filter(Boolean) : [];
  return refs.length > 0;
}

function normalizeVolcengineDuration(modelName, durationNum) {
  const m = String(modelName || '').toLowerCase();
  const d = Number(durationNum);
  const safe = Number.isFinite(d) && d > 0 ? Math.round(d) : 5;

  if (isSeedance2FamilyModel(m)) {
    return Math.min(15, Math.max(4, safe));
  }
  if (/seedance[-_]?1[-_.]?5|1-5-pro|1-5-lite|251215/.test(m)) {
    return Math.min(12, Math.max(5, safe));
  }
  if (/seedance|doubao-seedance/.test(m)) {
    return safe <= 7 ? 5 : 10;
  }
  return Math.min(12, Math.max(5, safe));
}

function isCheapSeedance2Provider(provider) {
  return String(provider || '').trim().toLowerCase() === 'cheap_seedance2';
}

function configSupportsUniversalOmni(config) {
  if (isCheapSeedance2Provider(config?.provider)) return true;
  let s = {};
  try {
    if (typeof config?.settings === 'string') s = JSON.parse(config.settings || '{}') || {};
    else if (config?.settings && typeof config.settings === 'object') s = config.settings;
  } catch (_) {
    s = {};
  }
  return s.supports_universal_omni === true || s.supports_universal_omni === 1 || s.supports_universal_omni === 'true';
}

function normalizeCheapSeedance2Duration(duration, model) {
  const modelLower = String(model || '').toLowerCase();
  const is25 = /wb-seedance-2\.5|seedance-2\.5|seedance2\.5/.test(modelLower);
  const allowed = is25 ? [5, 10] : [5, 10, 15];
  const raw = duration == null || duration === '' ? NaN : Number(duration);
  let target;
  if (!Number.isFinite(raw) || raw <= 0) {
    target = 10;
  } else if (raw <= 5) {
    target = 5;
  } else if (raw <= 10) {
    target = 10;
  } else {
    target = is25 ? 10 : 15;
  }
  if (!allowed.includes(target)) target = allowed[allowed.length - 1];
  return String(target);
}

function normalizeCheapSeedance2Size(aspectRatio) {
  const sizeMap = {
    '16:9': '1280x720',
    '9:16': '720x1280',
    '1:1': '1024x1024',
    '4:3': '960x720',
    '3:4': '720x960',
  };
  return sizeMap[String(aspectRatio || '').trim()] || '1280x720';
}

function buildCheapSeedance2ContentUrl(config, taskId) {
  const id = String(taskId || '').trim();
  if (!id) return null;
  const base = String(config?.base_url || '').replace(/\/$/, '');
  if (!base) return null;
  return `${base}/v1/videos/${encodeURIComponent(id)}/content`;
}

class VolcengineVideoProvider extends BaseVideoProvider {
  constructor() {
    super('volcengine');
  }

  supports(protocol, provider) {
    const p = String(provider || '').toLowerCase();
    const proto = String(protocol || '').toLowerCase();
    return proto === 'volcengine' || proto === 'volces' || p === 'volcengine' || p === 'volces';
  }

  normalizeDuration(duration, model) {
    return normalizeVolcengineDuration(model, duration);
  }
}

module.exports = {
  VolcengineVideoProvider,
  VOLC_MODEL_ALIASES,
  normalizeVolcModel,
  isSeedance2FamilyModel,
  shouldUseVolcOmniMultiReference,
  normalizeVolcengineDuration,
  isCheapSeedance2Provider,
  configSupportsUniversalOmni,
  normalizeCheapSeedance2Duration,
  normalizeCheapSeedance2Size,
  buildCheapSeedance2ContentUrl,
};
