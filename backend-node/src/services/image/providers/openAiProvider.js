/**
 * OpenAI 及通用兼容策略 (OpenAiImageProvider)
 * 遵循策略模式 (Strategy Pattern)，负责 DALL-E、Volcengine Doubao-Seedream、Agnes Image、ComfyUI 及标准 OpenAI 兼容接口。
 */

const {
  BaseImageProvider,
  IMAGE_HTTP_TIMEOUT_MS,
  resolveImageRef,
  clampAndAlignSize,
  buildImageUrl,
} = require('../baseProvider');
const { postJSONWithTimeout } = require('../../aiClient');

const SEEDREAM_MIN_PIXELS = 3686400;

function fixSeedreamSize(size) {
  if (!size || typeof size !== 'string') return '1920x1920';
  const s = size.trim().toLowerCase().replace(/\*/g, 'x');
  const match = s.match(/^(\d+)\s*x\s*(\d+)$/);
  if (!match) return '1920x1920';

  let w = parseInt(match[1], 10);
  let h = parseInt(match[2], 10);
  if (!w || !h) return '1920x1920';

  const pixels = w * h;
  if (pixels >= SEEDREAM_MIN_PIXELS) return `${w}x${h}`;

  const scale = Math.sqrt(SEEDREAM_MIN_PIXELS / pixels);
  w = Math.ceil((w * scale) / 64) * 64;
  h = Math.ceil((h * scale) / 64) * 64;

  if (w * h < SEEDREAM_MIN_PIXELS) {
    w += 64;
    h += 64;
  }

  return `${w}x${h}`;
}

const AGNES_IMAGE_RATIO_VALUES = [
  ['1:1', 1],
  ['3:4', 3 / 4],
  ['4:3', 4 / 3],
  ['16:9', 16 / 9],
  ['9:16', 9 / 16],
  ['2:3', 2 / 3],
  ['3:2', 3 / 2],
  ['21:9', 21 / 9],
];

function isAgnesImageConfig(config, model) {
  const p = String(config?.provider || '').toLowerCase();
  const m = String(model || '').toLowerCase();
  const base = String(config?.base_url || '').toLowerCase();
  return p === 'agnes' || /agnes-image/.test(m) || /apihub\.agnes-ai\.com/.test(base);
}

function closestAgnesImageRatio(w, h) {
  if (!w || !h) return '1:1';
  const r = w / h;
  let best = '1:1';
  let bestD = Infinity;
  for (const [label, tr] of AGNES_IMAGE_RATIO_VALUES) {
    const d = Math.abs(Math.log(r) - Math.log(tr));
    if (d < bestD) {
      bestD = d;
      best = label;
    }
  }
  return best;
}

function agnesImageTierFromMaxDim(maxDim) {
  if (maxDim >= 3500) return '3K';
  if (maxDim >= 1600) return '2K';
  return '1K';
}

function mapAgnesImageSizeSpec(size) {
  if (!size || typeof size !== 'string') return { size: '2K', ratio: '1:1' };
  const raw = size.trim();
  const tierMatch = raw.match(/^([1-4])[Kk]$/);
  if (tierMatch) return { size: `${tierMatch[1]}K`, ratio: '1:1' };
  const s = raw.toLowerCase().replace(/\*/g, 'x');
  const match = s.match(/^(\d+)\s*x\s*(\d+)$/);
  if (!match) return { size: '2K', ratio: '1:1' };
  const w = parseInt(match[1], 10);
  const h = parseInt(match[2], 10);
  if (!w || !h) return { size: '2K', ratio: '1:1' };
  return {
    size: agnesImageTierFromMaxDim(Math.max(w, h)),
    ratio: closestAgnesImageRatio(w, h),
  };
}

function fixAgnesImageSize(size) {
  return mapAgnesImageSizeSpec(size).size;
}

class OpenAiImageProvider extends BaseImageProvider {
  constructor() {
    super('openai');
  }

  supports(protocol, provider, model) {
    const p = String(provider || '').toLowerCase();
    const proto = String(protocol || '').toLowerCase();
    return (
      proto === 'openai' ||
      proto === 'volcengine' ||
      proto === 'agnes' ||
      p === 'openai' ||
      p === 'volcengine' ||
      p === 'volces' ||
      p === 'volc' ||
      p === 'agnes' ||
      /seedream|doubao/i.test(model || '') ||
      proto === 'generic'
    );
  }

  async generateImage({ config, log, opts, effectivePrompt, mergedNegativePrompt, model, size, protocol }) {
    const { image_gen_id, quality, reference_image_urls, files_base_url, storage_local_path } = opts;
    const url = buildImageUrl(config);
    const isVolc = protocol === 'volcengine';
    const isAgnes = isAgnesImageConfig(config, model);
    const isSeedream = isVolc || /seedream|doubao/i.test(model);

    const rawRefs = Array.isArray(reference_image_urls) ? reference_image_urls.filter(Boolean) : [];
    const resolvedRefs = rawRefs.map((r) => resolveImageRef(r, files_base_url, storage_local_path)).filter(Boolean);
    if (resolvedRefs.length > 0) {
      log.info('Image API request with reference images', {
        url: url.slice(0, 60),
        model,
        image_gen_id,
        ref_count: resolvedRefs.length,
        ref_types: resolvedRefs.map((r) => (r.startsWith('data:') ? 'base64' : 'url')),
      });
    }

    let effectiveSize = size;
    let agnesSizeSpec = null;
    if (isSeedream && size) {
      effectiveSize = fixSeedreamSize(size);
    } else if (isAgnes) {
      agnesSizeSpec = mapAgnesImageSizeSpec(size);
      effectiveSize = agnesSizeSpec.size;
    } else if (effectiveSize) {
      effectiveSize = clampAndAlignSize(effectiveSize);
    }

    const body = {
      model,
      prompt: effectivePrompt,
      ...(!isSeedream && !isAgnes ? { n: 1 } : {}),
      ...(effectiveSize ? { size: effectiveSize } : {}),
      ...(isAgnes && agnesSizeSpec ? { ratio: agnesSizeSpec.ratio } : {}),
      ...(!isAgnes && quality ? { quality } : {}),
      ...(isVolc || isSeedream ? { watermark: false } : {}),
      ...(mergedNegativePrompt ? { negative_prompt: mergedNegativePrompt } : {}),
      ...(resolvedRefs.length > 0 && !isAgnes ? { image: resolvedRefs } : {}),
      ...(isAgnes
        ? {
            extra_body: {
              response_format: 'url',
              ...(resolvedRefs.length > 0 ? { image: resolvedRefs } : {}),
            },
          }
        : {}),
    };

    log.info('Image API request', {
      url: url.slice(0, 60),
      model,
      image_gen_id,
      has_ref_images: resolvedRefs.length > 0,
      size: effectiveSize,
      ratio: isAgnes && agnesSizeSpec ? agnesSizeSpec.ratio : undefined,
      original_size: size !== effectiveSize ? size : undefined,
      is_agnes: isAgnes,
    });

    const openaiCompatHeaders = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + (config.api_key || ''),
    };

    let raw;
    let httpStatus;
    try {
      const out = await postJSONWithTimeout(url, openaiCompatHeaders, body, IMAGE_HTTP_TIMEOUT_MS);
      httpStatus = out.statusCode;
      raw = out.raw;
    } catch (e) {
      log.error('Image API network error', { image_gen_id, error: e.message, url: url.slice(0, 80) });
      return {
        error:
          e.message && e.message.includes('timeout')
            ? e.message
            : '图片生成网络请求失败: ' + e.message,
      };
    }

    if (httpStatus < 200 || httpStatus >= 300) {
      log.error('Image API failed', { status: httpStatus, body: raw.slice(0, 300) });
      let errMsg = '图片生成请求失败: ' + httpStatus;
      try {
        const errJson = JSON.parse(raw);
        const msg = errJson.error?.message || errJson.message || errJson.error;
        if (msg) errMsg += ' - ' + (typeof msg === 'string' ? msg : JSON.stringify(msg).slice(0, 200));
      } catch (_) {
        if (raw && raw.length) errMsg += ' - ' + raw.slice(0, 200);
      }
      return { error: errMsg };
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      log.warn('Image API response parse error', { image_gen_id, raw_preview: raw.slice(0, 200) });
      return { error: '图片生成返回格式异常' };
    }

    const item = data.data && data.data[0];
    let imageUrl = item && (item.url || item.image_url);
    if (!imageUrl && item?.b64_json) {
      imageUrl = `data:image/png;base64,${String(item.b64_json).replace(/\s/g, '')}`;
    }
    if (!imageUrl && Array.isArray(data.images) && data.images.length > 0) {
      const first = data.images[0];
      if (typeof first === 'string' && first.length > 0) {
        imageUrl = first.startsWith('data:') ? first : `data:image/png;base64,${first.replace(/\s/g, '')}`;
      }
    }
    if (!imageUrl) {
      log.warn('Image API no image URL in response', {
        image_gen_id,
        model,
        response_keys: data ? Object.keys(data) : [],
        data_preview: data ? JSON.stringify(data).slice(0, 500) : '',
        has_data_array: !!(data.data && Array.isArray(data.data)),
        first_item_keys: data.data && data.data[0] ? Object.keys(data.data[0]) : [],
      });
      return { error: '未返回图片地址' };
    }
    return { image_url: imageUrl };
  }
}

module.exports = {
  OpenAiImageProvider,
  fixSeedreamSize,
  isAgnesImageConfig,
  mapAgnesImageSizeSpec,
  fixAgnesImageSize,
};
