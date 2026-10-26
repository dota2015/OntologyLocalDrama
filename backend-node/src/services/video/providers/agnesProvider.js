/**
 * Agnes 视频服务提供商策略 (AgnesVideoProvider)
 * 支持 Agnes Video 2.5、2.5 Flash 及经典 OpenAI 兼容视频协议
 */

const BaseVideoProvider = require('../baseProvider');

const AGNES_ALLOWED_NUM_FRAMES = [81, 121, 161, 241, 441];
const AGNES_VIDEO_25_RATIO_VALUES = [
  ['21:9', 21 / 9],
  ['16:9', 16 / 9],
  ['4:3', 4 / 3],
  ['1:1', 1],
  ['3:4', 3 / 4],
  ['9:16', 9 / 16],
];

function isAgnesVideo25Model(model) {
  return /agnes-video-2\.5/i.test(String(model || ''));
}

function isAgnesVideo25FlashModel(model) {
  return /agnes-video-2\.5-flash/i.test(String(model || ''));
}

function normalizeAgnesVideo25Duration(duration) {
  const n = Math.round(Number(duration) || 5);
  if (!Number.isFinite(n)) return '5';
  return String(Math.min(12, Math.max(4, n)));
}

function normalizeAgnesVideo25AspectRatio(ratio) {
  const allowed = new Set(AGNES_VIDEO_25_RATIO_VALUES.map(([label]) => label));
  const raw = String(ratio || '').trim().replace(/\uFF1A/g, ':').replace(/[×xX＊*]/g, ':');
  if (allowed.has(raw)) return raw;
  const match = raw.match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
  if (match) {
    const r = Number(match[1]) / Number(match[2]);
    let best = '16:9';
    let bestD = Infinity;
    for (const [label, tr] of AGNES_VIDEO_25_RATIO_VALUES) {
      const d = Math.abs(Math.log(r) - Math.log(tr));
      if (d < bestD) {
        bestD = d;
        best = label;
      }
    }
    return best;
  }
  return '16:9';
}

function normalizeAgnesVideo25Size(model, resolution) {
  if (isAgnesVideo25FlashModel(model)) return '720P';
  const r = String(resolution || '').toUpperCase();
  if (/2K|1080|1440|2160|4K/.test(r)) return '2K';
  return '720P';
}

function getAgnesApiRoot(baseUrl) {
  let base = String(baseUrl || 'https://apihub.agnes-ai.com').replace(/\/$/, '');
  for (const suf of ['/v1/videos', '/v1']) {
    if (base.length >= suf.length && base.slice(-suf.length).toLowerCase() === suf) {
      base = base.slice(0, -suf.length).replace(/\/$/, '');
    }
  }
  return base || 'https://apihub.agnes-ai.com';
}

function buildAgnesVideo25Body({
  model,
  prompt,
  duration,
  aspect_ratio,
  resolution,
  useOmniReference,
  resolvedRefs,
  firstResolved,
  lastResolved,
}) {
  const flash = isAgnesVideo25FlashModel(model);
  const body = {
    model: model || 'agnes-video-2.5-flash',
    prompt: prompt || '',
    seconds: normalizeAgnesVideo25Duration(duration),
    size: normalizeAgnesVideo25Size(model, resolution),
    aspect_ratio: normalizeAgnesVideo25AspectRatio(aspect_ratio),
  };
  const refs = Array.isArray(resolvedRefs) ? resolvedRefs.filter(Boolean) : [];
  if (useOmniReference && refs.length) {
    const maxImages = flash ? 5 : 9;
    body.mode = 'reference';
    body.images = refs.slice(0, maxImages);
    return {
      body,
      strategy: refs.length > 1 ? 'v25_reference' : 'v25_reference_single',
    };
  }
  if (firstResolved || lastResolved) {
    body.mode = 'keyframe';
    if (firstResolved) body.first_frame = firstResolved;
    if (lastResolved && lastResolved !== firstResolved) body.last_frame = lastResolved;
    return { body, strategy: 'v25_keyframe' };
  }
  body.mode = 'text';
  return { body, strategy: 'v25_text' };
}

function buildAgnesVideoImagePayload({ useOmniReference, resolvedRefs, firstResolved, lastResolved }) {
  const refs = Array.isArray(resolvedRefs) ? resolvedRefs.filter(Boolean) : [];
  if (useOmniReference && refs.length >= 2) {
    return {
      strategy: 'omni_reference_extra_body',
      extra_body: { image: refs.slice(0, 10) },
    };
  }
  if (useOmniReference && refs.length === 1) {
    return {
      strategy: 'omni_reference_single',
      image: refs[0],
    };
  }
  if (!useOmniReference && firstResolved && lastResolved && firstResolved !== lastResolved) {
    return {
      strategy: 'classic_keyframes',
      extra_body: { mode: 'keyframes', image: [firstResolved, lastResolved] },
    };
  }
  if (firstResolved) {
    return {
      strategy: 'classic_i2v',
      image: firstResolved,
    };
  }
  return { strategy: 'text_only' };
}

function isAgnesBuiltinQueryEndpoint(ep) {
  const s = String(ep || '').trim();
  if (!s) return true;
  return (
    /^\/?(v1\/)?videos\/\{(taskId|task_id|id|videoId|video_id)\}\/?$/i.test(s) ||
    /^\/?(v1\/)?agnesapi(\?|$)/i.test(s)
  );
}

function resolveAgnesVideoModel(config, explicitModel) {
  const named = String(explicitModel || '').trim();
  if (named) return named;
  if (typeof config?.default_model === 'string' && config.default_model.trim()) {
    return config.default_model.trim();
  }
  if (Array.isArray(config?.model) && config.model.length > 0) {
    const first = config.model[0];
    if (typeof first === 'string') return first.trim();
    if (first && typeof first === 'object' && first.id) return String(first.id).trim();
  }
  if (typeof config?.model === 'string' && config.model.trim()) {
    return config.model.trim();
  }
  return '';
}

function buildAgnesPollUrl(config, pollId, explicitModel) {
  const root = getAgnesApiRoot(config?.base_url);
  const id = String(pollId || '').trim();
  const cfgEp = String(config?.query_endpoint || '').trim();
  const model = resolveAgnesVideoModel(config, explicitModel);

  if (cfgEp && !isAgnesBuiltinQueryEndpoint(cfgEp)) {
    const base = (config?.base_url || '').replace(/\/$/, '');
    let ep = cfgEp
      .replace(/\{videoId\}|\{video_id\}|\{taskId\}|\{task_id\}|\{id\}/gi, encodeURIComponent(id))
      .replace(/\{model\}|\{model_name\}/gi, encodeURIComponent(model));
    if (!ep.startsWith('/')) ep = '/' + ep;
    return base + ep;
  }

  if (isAgnesVideo25Model(model)) {
    const params = new URLSearchParams({ video_id: id, model_name: model });
    return `${root}/agnesapi?${params.toString()}`;
  }

  return `${root}/v1/videos/${encodeURIComponent(id)}`;
}

function extractAgnesVideoUrl(data) {
  if (!data || typeof data !== 'object') return null;
  const coerce = (val) => {
    if (!val) return null;
    const s = String(val).trim();
    return /^https?:\/\/.+/i.test(s) ? s : null;
  };
  const nested = (obj, key) => (obj && typeof obj === 'object' && !Array.isArray(obj) ? obj[key] : null);
  const candidates = [
    data.video_url,
    nested(data.content, 'video_url'),
    nested(data.data, 'video_url'),
    nested(data.data, 'url'),
    nested(data.metadata, 'url'),
    nested(data.metadata, 'video_url'),
    nested(data.metadata, 'result_url'),
    data.remixed_from_video_id,
    nested(data.data, 'remixed_from_video_id'),
    data.url,
  ];
  for (const c of candidates) {
    const u = coerce(c);
    if (u) return u;
  }
  return null;
}

class AgnesVideoProvider extends BaseVideoProvider {
  constructor() {
    super('agnes');
  }

  supports(protocol, provider, model) {
    const p = String(provider || '').toLowerCase();
    const proto = String(protocol || '').toLowerCase();
    return proto === 'agnes' || p === 'agnes' || isAgnesVideo25Model(model);
  }

  normalizeDuration(duration, model) {
    if (isAgnesVideo25Model(model)) return normalizeAgnesVideo25Duration(duration);
    return super.normalizeDuration(duration, model);
  }

  normalizeSize(aspectRatio, model, resolution) {
    if (isAgnesVideo25Model(model)) return normalizeAgnesVideo25Size(model, resolution);
    return super.normalizeSize(aspectRatio);
  }

  buildPollUrl(config, taskId, model) {
    return buildAgnesPollUrl(config, taskId, model);
  }

  extractVideoUrl(data) {
    return extractAgnesVideoUrl(data);
  }
}

module.exports = {
  AgnesVideoProvider,
  isAgnesVideo25Model,
  isAgnesVideo25FlashModel,
  normalizeAgnesVideo25Duration,
  normalizeAgnesVideo25Size,
  normalizeAgnesVideo25AspectRatio,
  getAgnesApiRoot,
  isAgnesBuiltinQueryEndpoint,
  resolveAgnesVideoModel,
  buildAgnesVideo25Body,
  buildAgnesVideoImagePayload,
  buildAgnesPollUrl,
  extractAgnesVideoUrl,
};
