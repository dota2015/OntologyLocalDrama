/**
 * 阿里百炼 / 通义万象图片生成策略 (DashScopeImageProvider)
 * 遵循策略模式 (Strategy Pattern)，负责通义万象 (wanx) 及通义千问 (qwen-image) 图生接口调用。
 */

const {
  BaseImageProvider,
  IMAGE_HTTP_TIMEOUT_MS,
  ANTI_SPLIT_NEGATIVE_PROMPT,
  resolveImageRef,
} = require('../baseProvider');
const { postJSONWithTimeout } = require('../../aiClient');
const { pickModelId } = require('../../modelId');

const DASHSCOPE_MIN_PIXELS = 589824;
const DASHSCOPE_MAX_PIXELS = 1638400;

const RETIRED_QWEN_IMAGE_MODELS = {
  'qwen-image-max': 'qwen-image-3.0',
  'qwen-image-plus': 'qwen-image-3.0',
  'qwen-image': 'qwen-image-3.0',
};

function isDashScopeImageConfig(config) {
  return String(config?.base_url || '').toLowerCase().includes('dashscope.aliyuncs.com');
}

function resolveDashScopeImageModel(config, model) {
  const id = pickModelId(model);
  if (!id || !isDashScopeImageConfig(config)) return id || model;
  return RETIRED_QWEN_IMAGE_MODELS[id.toLowerCase()] || id;
}

function isQwenImageProvider(config, model) {
  const p = (config?.provider || '').toLowerCase();
  const m = (model || '').toLowerCase();
  return p === 'qwen_image' || /^qwen-image/.test(m);
}

function qwenImageSize(size) {
  if (!size || typeof size !== 'string') return '1664*928';
  const s = String(size).trim().toLowerCase().replace(/x/g, '*');
  const match = s.match(/^(\d+)\s*\*\s*(\d+)$/);
  if (!match) return '1664*928';
  const w = parseInt(match[1], 10);
  const h = parseInt(match[2], 10);
  if (!w || !h) return '1664*928';
  const ratio = w / h;
  if (ratio >= 1.7) return '1664*928';   // 16:9
  if (ratio >= 1.2) return '1472*1104';   // 4:3
  if (ratio >= 0.85) return '1328*1328';  // 1:1
  if (ratio >= 0.65) return '1104*1472';  // 3:4
  return '928*1664';                      // 9:16
}

function dashScopeSize(size) {
  if (!size || typeof size !== 'string') return '1280*1280';
  const s = String(size).trim().toLowerCase().replace(/x/g, '*');
  const match = s.match(/^(\d+)\s*\*\s*(\d+)$/);
  if (!match) return '1280*1280';
  let w = parseInt(match[1], 10);
  let h = parseInt(match[2], 10);
  if (!w || !h) return '1280*1280';
  let pixels = w * h;
  if (pixels <= DASHSCOPE_MAX_PIXELS && pixels >= DASHSCOPE_MIN_PIXELS) return `${w}*${h}`;
  if (pixels > DASHSCOPE_MAX_PIXELS) {
    const scale = Math.sqrt(DASHSCOPE_MAX_PIXELS / pixels);
    w = Math.max(16, Math.round((w * scale) / 16) * 16);
    h = Math.max(16, Math.round((h * scale) / 16) * 16);
    if (w * h > DASHSCOPE_MAX_PIXELS) {
      w = Math.min(w, 1280);
      h = Math.min(h, Math.floor(DASHSCOPE_MAX_PIXELS / w));
      h = Math.floor(h / 16) * 16;
    }
    return `${w}*${h}`;
  }
  const scale = Math.sqrt(DASHSCOPE_MIN_PIXELS / pixels);
  w = Math.max(384, Math.round((w * scale) / 16) * 16);
  h = Math.max(384, Math.round((h * scale) / 16) * 16);
  return `${w}*${h}`;
}

function parseDashScopeImageUrl(data) {
  const choices = data?.output?.choices;
  if (!Array.isArray(choices)) return null;
  for (const c of choices) {
    const content = c?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part) continue;
      if (part.image && (part.type === 'image' || !part.type)) return part.image;
    }
  }
  return null;
}

class DashScopeImageProvider extends BaseImageProvider {
  constructor() {
    super('dashscope');
  }

  supports(protocol, provider, model) {
    const p = String(provider || '').toLowerCase();
    const proto = String(protocol || '').toLowerCase();
    return proto === 'dashscope' || p === 'dashscope' || p === 'qwen_image';
  }

  async generateImage({ config, log, opts, effectivePrompt, mergedNegativePrompt, model, size }) {
    const { image_gen_id, reference_image_urls, files_base_url, storage_local_path } = opts;
    const base = (config.base_url || '').replace(/\/$/, '');
    const url = base + (config.endpoint || '/api/v1/services/aigc/multimodal-generation/generation');
    if (!url.includes('dashscope')) {
      return { error: '通义万象 base_url 需为 https://dashscope.aliyuncs.com' };
    }
    const isQwenImage = isQwenImageProvider(config, model);

    if (isQwenImage) {
      const text = (effectivePrompt || '').toString().trim().slice(0, 800);
      const body = {
        model: resolveDashScopeImageModel(config, model) || 'qwen-image-3.0',
        input: {
          messages: [{ role: 'user', content: [{ text }] }],
        },
        parameters: {
          prompt_extend: true,
          watermark: false,
          size: qwenImageSize(size),
        },
      };
      if (mergedNegativePrompt && String(mergedNegativePrompt).trim()) {
        body.parameters.negative_prompt = String(mergedNegativePrompt).trim().slice(0, 500);
      }
      log.info('Image API request (Qwen-Image sync)', { url: url.slice(0, 70), model: body.model, image_gen_id });
      const qwenHeaders = {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (config.api_key || ''),
      };
      let raw;
      let httpStatus;
      try {
        const out = await postJSONWithTimeout(url, qwenHeaders, body, IMAGE_HTTP_TIMEOUT_MS);
        httpStatus = out.statusCode;
        raw = out.raw;
      } catch (e) {
        log.error('Qwen-Image network error', { image_gen_id, error: e.message });
        return { error: '图片生成网络请求失败: ' + e.message };
      }
      if (httpStatus < 200 || httpStatus >= 300) {
        let errMsg = '图片生成请求失败: ' + httpStatus;
        try {
          const errJson = JSON.parse(raw);
          if (errJson.message) errMsg += ' - ' + errJson.message;
          else if (errJson.code) errMsg += ' - ' + errJson.code;
        } catch (_) {
          if (raw && raw.length) errMsg += ' - ' + raw.slice(0, 200);
        }
        log.error('Qwen-Image create failed', { status: httpStatus, body: raw.slice(0, 300), image_gen_id });
        return { error: errMsg };
      }
      try {
        const data = JSON.parse(raw);
        if (data.code) {
          log.warn('Qwen-Image response error', { code: data.code, message: data.message, image_gen_id });
          return { error: data.message || data.code || '通义千问接口错误' };
        }
        const imageUrl = parseDashScopeImageUrl(data);
        if (imageUrl) {
          log.info('Qwen-Image image (sync)', { image_gen_id, has_image_url: true });
          return { image_url: imageUrl };
        }
        return { error: '未返回图片地址' };
      } catch (e) {
        log.warn('Qwen-Image parse error', { image_gen_id, error: e.message, raw_preview: raw.slice(0, 300) });
        return { error: '通义千问返回格式异常' };
      }
    }

    const refs = Array.isArray(reference_image_urls) ? reference_image_urls.filter(Boolean) : [];
    const content = [{ text: effectivePrompt || '' }];
    const resolvedRefs = [];
    for (const ref of refs.slice(0, 10)) {
      const img = resolveImageRef(ref, files_base_url, storage_local_path);
      if (img) {
        content.push({ image: img });
        resolvedRefs.push(img.startsWith('data:') ? '(base64)' : img);
      }
    }
    log.info('reference_image_urls 完整路径（imageClient 入参及解析后）', {
      image_gen_id,
      raw_reference_image_urls: reference_image_urls || [],
      resolved_for_api: resolvedRefs,
    });

    const hasRefs = content.length > 1;
    const stream = !hasRefs;
    const body = {
      model: model || 'wan2.6-image',
      input: {
        messages: [{ role: 'user', content }],
      },
      parameters: {
        prompt_extend: true,
        watermark: false,
        n: 1,
        enable_interleave: !hasRefs,
        size: dashScopeSize(size),
        stream,
        ...(hasRefs ? { negative_prompt: mergedNegativePrompt || ANTI_SPLIT_NEGATIVE_PROMPT } : (mergedNegativePrompt ? { negative_prompt: mergedNegativePrompt } : {})),
      },
    };
    const contentSummary = content.map((p) => (p.text != null ? 'text' : p.image && p.image.startsWith('data:') ? 'image(base64)' : 'image(url)'));
    log.info('Image API request (DashScope)', {
      url: url.slice(0, 70),
      model: body.model,
      image_gen_id,
      reference_count: refs.length,
      enable_interleave: body.parameters.enable_interleave,
      stream: body.parameters.stream,
      content_parts: contentSummary,
    });
    const headers = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + (config.api_key || ''),
    };
    if (stream) headers['X-DashScope-Sse'] = 'enable';
    let raw;
    let httpStatus;
    try {
      const out = await postJSONWithTimeout(url, headers, body, IMAGE_HTTP_TIMEOUT_MS);
      httpStatus = out.statusCode;
      raw = out.raw;
    } catch (e) {
      log.error('DashScope network error', { image_gen_id, error: e.message });
      return { error: '图片生成网络请求失败: ' + e.message };
    }
    if (httpStatus < 200 || httpStatus >= 300) {
      let errMsg = '图片生成请求失败: ' + httpStatus;
      try {
        const errJson = JSON.parse(raw);
        if (errJson.message) errMsg += ' - ' + errJson.message;
        else if (errJson.code) errMsg += ' - ' + errJson.code;
      } catch (_) {
        if (raw && raw.length) errMsg += ' - ' + raw.slice(0, 200);
      }
      log.error('DashScope create failed', { status: httpStatus, body: raw.slice(0, 300), image_gen_id });
      return { error: errMsg };
    }

    if (!stream) {
      try {
        const data = JSON.parse(raw);
        if (data.code) {
          log.warn('DashScope response error', { code: data.code, message: data.message, image_gen_id });
          return { error: data.message || data.code || '通义万象接口错误' };
        }
        const imageUrl = parseDashScopeImageUrl(data);
        if (imageUrl) {
          log.info('DashScope image (sync)', { image_gen_id, has_image_url: true });
          return { image_url: imageUrl };
        }
        log.warn('DashScope sync no image in response', {
          image_gen_id,
          output_keys: data.output ? Object.keys(data.output) : [],
          raw_preview: raw.slice(0, 500),
        });
        return { error: '未返回图片地址' };
      } catch (e) {
        log.warn('DashScope sync parse error', { image_gen_id, error: e.message, raw_preview: raw.slice(0, 300) });
        return { error: '通义万象返回格式异常' };
      }
    }

    let lastImageUrl = null;
    const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    let firstChunkKeys = null;
    for (const line of lines) {
      let jsonStr = line;
      if (line.startsWith('data:')) {
        jsonStr = line.slice(5).trim();
        if (!jsonStr || jsonStr === '[DONE]') continue;
      }
      try {
        const data = JSON.parse(jsonStr);
        if (data.code) {
          log.warn('DashScope stream chunk error', { code: data.code, message: data.message, image_gen_id });
          return { error: data.message || data.code || '通义万象接口错误' };
        }
        if (firstChunkKeys == null && data.output) {
          const oc = data.output.choices?.[0];
          firstChunkKeys = {
            output_keys: Object.keys(data.output),
            choice_message_keys: oc?.message ? Object.keys(oc.message) : [],
            content_types: Array.isArray(oc?.message?.content) ? oc.message.content.map((p) => p && p.type) : [],
          };
        }
        const urlFromChunk = parseDashScopeImageUrl(data);
        if (urlFromChunk) lastImageUrl = urlFromChunk;
      } catch (_) {
        // 忽略非 JSON 行
      }
    }
    if (lastImageUrl) {
      log.info('DashScope image (stream)', { image_gen_id, has_image_url: true });
      return { image_url: lastImageUrl };
    }
    if (lines.length > 0) {
      try {
        const firstLine = lines[0].startsWith('data:') ? lines[0].slice(5).trim() : lines[0];
        const first = JSON.parse(firstLine);
        if (first.code) return { error: first.message || first.code || '通义万象接口错误' };
      } catch (_) {}
    }
    log.warn('DashScope stream no image in response', {
      image_gen_id,
      line_count: lines.length,
      first_chunk: firstChunkKeys,
      raw_preview: raw.slice(0, 400),
    });
    return { error: '未返回图片地址' };
  }
}

module.exports = {
  DashScopeImageProvider,
  isDashScopeImageConfig,
  resolveDashScopeImageModel,
  dashScopeSize,
  parseDashScopeImageUrl,
};
