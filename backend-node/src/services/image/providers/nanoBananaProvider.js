/**
 * NanoBanana 图片生成策略 (NanoBananaImageProvider)
 * 遵循策略模式 (Strategy Pattern)，负责 NanoBanana 任务提交（支持原生模型与代理端点）与轮询。
 */

const {
  BaseImageProvider,
  IMAGE_HTTP_TIMEOUT_MS,
  resolveImageRef,
} = require('../baseProvider');
const { postJSONWithTimeout } = require('../../aiClient');

const GEMINI_ASPECT_NUMERIC = [
  ['21:9', 21 / 9],
  ['16:9', 16 / 9],
  ['3:2', 3 / 2],
  ['4:3', 4 / 3],
  ['5:4', 5 / 4],
  ['1:1', 1],
  ['4:5', 4 / 5],
  ['3:4', 3 / 4],
  ['2:3', 2 / 3],
  ['9:16', 9 / 16],
];

function closestAspectRatioFromPixels(w, h) {
  if (!w || !h) return '1:1';
  const r = w / h;
  let best = '1:1';
  let bestD = Infinity;
  for (const [label, tr] of GEMINI_ASPECT_NUMERIC) {
    const d = Math.abs(Math.log(r) - Math.log(tr));
    if (d < bestD) {
      bestD = d;
      best = label;
    }
  }
  return best;
}

function nanoBananaAspectRatio(size) {
  if (!size || typeof size !== 'string') return 'auto';
  const s = String(size).trim().toLowerCase().replace(/\s/g, '');
  const ratioSet = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '5:4', '4:5', '21:9']);
  if (ratioSet.has(s)) return s;
  const match = s.match(/^(\d+)[x*](\d+)$/);
  if (!match) return 'auto';
  const w = parseInt(match[1], 10);
  const h = parseInt(match[2], 10);
  if (!w || !h) return 'auto';
  return closestAspectRatioFromPixels(w, h);
}

class NanoBananaImageProvider extends BaseImageProvider {
  constructor() {
    super('nano_banana');
  }

  supports(protocol, provider, model) {
    const p = String(provider || '').toLowerCase();
    const proto = String(protocol || '').toLowerCase();
    return proto === 'nano_banana' || p === 'nano_banana';
  }

  async generateImage({ config, log, opts, effectivePrompt, model, size }) {
    const { image_gen_id, reference_image_urls, files_base_url, storage_local_path } = opts;
    const base = (config.base_url || 'https://api.nanobananaapi.ai').replace(/\/$/, '');
    const apiKey = config.api_key || '';
    const headers = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey,
    };
    const rawRefs = Array.isArray(reference_image_urls) ? reference_image_urls.filter(Boolean) : [];
    const refs = rawRefs.map((r) => resolveImageRef(r, files_base_url, storage_local_path)).filter(Boolean);
    const aspectRatio = nanoBananaAspectRatio(size);
    const m = (model || 'nano-banana-2').toLowerCase();

    const NATIVE_ENDPOINTS = new Set([
      '/api/v1/nanobanana/generate-2',
      '/api/v1/nanobanana/generate-pro',
      '/api/v1/nanobanana/generate',
    ]);
    const cfgEp = config.endpoint ? (config.endpoint.startsWith('/') ? config.endpoint : '/' + config.endpoint) : '';
    const isProxyMode = cfgEp && !NATIVE_ENDPOINTS.has(cfgEp);

    let submitUrl;
    let body;
    if (isProxyMode) {
      submitUrl = base + cfgEp;
      const isNativeBananaModel = m.startsWith('nano-banana');
      if (isNativeBananaModel) {
        body = {
          prompt: effectivePrompt || '',
          imageUrls: refs,
          aspectRatio: aspectRatio === 'auto' ? '16:9' : aspectRatio,
          resolution: '1K',
        };
      } else {
        body = {
          model: model || '',
          prompt: effectivePrompt || '',
          aspect_ratio: aspectRatio === 'auto' ? '16:9' : (aspectRatio || ''),
          image_size: '1K',
          ...(refs.length > 0 ? { imageUrls: refs } : {}),
        };
      }
    } else if (m === 'nano-banana-2') {
      submitUrl = base + '/api/v1/nanobanana/generate-2';
      body = {
        prompt: effectivePrompt || '',
        imageUrls: refs,
        aspectRatio,
        resolution: '1K',
        outputFormat: 'jpg',
      };
    } else if (m === 'nano-banana-pro') {
      submitUrl = base + '/api/v1/nanobanana/generate-pro';
      body = {
        prompt: effectivePrompt || '',
        imageUrls: refs,
        aspectRatio: aspectRatio === 'auto' ? '16:9' : aspectRatio,
        resolution: '2K',
      };
    } else {
      submitUrl = base + '/api/v1/nanobanana/generate';
      body = {
        prompt: effectivePrompt || '',
        type: refs.length > 0 ? 'IMAGETOIAMGE' : 'TEXTTOIAMGE',
        imageUrls: refs,
        image_size: (aspectRatio === 'auto' ? '16:9' : aspectRatio),
        numImages: 1,
        callBackUrl: 'https://placeholder.no-op/callback',
      };
    }

    const bodyForLog = { ...body };
    if (Array.isArray(bodyForLog.imageUrls)) {
      bodyForLog.imageUrls = bodyForLog.imageUrls.map((u) => (u && u.startsWith('data:') ? '(base64)' : u));
    }
    log.info('NanoBanana Image API request', {
      url: submitUrl,
      model: m,
      image_gen_id,
      proxy_mode: isProxyMode,
      auth_header_prefix: (headers.Authorization || '').slice(0, 20) + '…',
      body_keys: Object.keys(body),
      body_preview: JSON.stringify(bodyForLog).slice(0, 300),
    });
    let submitRaw;
    let submitStatus;
    try {
      const out = await postJSONWithTimeout(submitUrl, headers, body, IMAGE_HTTP_TIMEOUT_MS);
      submitStatus = out.statusCode;
      submitRaw = out.raw;
    } catch (e) {
      log.error('NanoBanana submit network error', { image_gen_id, error: e.message });
      return { error: 'NanoBanana 图片生成网络请求失败: ' + e.message };
    }
    if (submitStatus < 200 || submitStatus >= 300) {
      let errMsg = 'NanoBanana 图片生成请求失败: ' + submitStatus;
      try {
        const errJson = JSON.parse(submitRaw);
        const msg = errJson.msg || errJson.message || (errJson.error && (errJson.error.message || errJson.error));
        if (msg) errMsg += ' - ' + String(msg).slice(0, 200);
      } catch (_) {
        if (submitRaw) errMsg += ' - ' + submitRaw.slice(0, 200);
      }
      log.error('NanoBanana submit failed', {
        status: submitStatus,
        body: submitRaw.slice(0, 500),
        image_gen_id,
        submit_url: submitUrl,
        auth_header_prefix: (headers.Authorization || '').slice(0, 20) + '…',
      });
      return { error: errMsg };
    }
    let submitData;
    try {
      submitData = JSON.parse(submitRaw);
    } catch (e) {
      return { error: 'NanoBanana 返回格式异常' };
    }

    const sdTopImages = submitData?.images;
    const sd0 = Array.isArray(sdTopImages) ? sdTopImages[0] : null;
    const sdTopFirst = typeof sd0 === 'string' && sd0 && !/^https?:\/\//i.test(sd0) && !sdTopImages[0]?.url
      ? (sd0.startsWith('data:') ? sd0 : `data:image/png;base64,${sd0.replace(/\s/g, '')}`)
      : null;
    const directImageUrl = submitData?.images?.[0]?.url
      || sdTopFirst
      || submitData?.image?.url
      || submitData?.image_url
      || submitData?.data?.url
      || submitData?.url
      || (submitData?.data?.state === 'succeeded' ? submitData?.data?.data?.images?.[0]?.url : null);
    if (directImageUrl) {
      log.info('NanoBanana image (synchronous proxy response)', { image_gen_id });
      return { image_url: directImageUrl };
    }

    const taskId = submitData?.data?.taskId || submitData?.data?.task_id || submitData?.request_id || submitData?.taskId;
    if (!taskId) {
      const msg = submitData?.msg || submitData?.message || '未返回任务ID';
      log.warn('NanoBanana no taskId in response', { image_gen_id, raw_preview: submitRaw.slice(0, 300) });
      return { error: 'NanoBanana 提交失败: ' + String(msg).slice(0, 200) };
    }

    const DEFAULT_QUERY_EP = '/api/v1/nanobanana/record-info';
    const cfgQEp = config.query_endpoint
      ? (config.query_endpoint.startsWith('/') ? config.query_endpoint : '/' + config.query_endpoint)
      : '';
    const useQueryEp = cfgQEp && cfgQEp !== DEFAULT_QUERY_EP ? cfgQEp : DEFAULT_QUERY_EP;
    function buildQueryUrl(tid) {
      if (/\{(taskId|taskid|task_id|id)\}/i.test(useQueryEp)) {
        return base + useQueryEp
          .replace(/\{taskId\}/gi, encodeURIComponent(tid))
          .replace(/\{task_id\}/gi, encodeURIComponent(tid))
          .replace(/\{id\}/gi, encodeURIComponent(tid));
      }
      return base + useQueryEp + '?taskId=' + encodeURIComponent(tid);
    }

    const firstQueryUrl = buildQueryUrl(taskId);
    log.info('NanoBanana task submitted, polling…', {
      image_gen_id, task_id: taskId,
      query_ep: useQueryEp,
      first_query_url: firstQueryUrl,
      config_query_endpoint: config.query_endpoint || '(not set)',
    });
    const maxAttempts = 60;
    const intervalMs = 3000;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((r) => setTimeout(r, intervalMs));
      const pollUrl = buildQueryUrl(taskId);
      try {
        const queryRes = await fetch(pollUrl, {
          method: 'GET',
          headers,
        });
        const queryRaw = await queryRes.text();
        if (!queryRes.ok) {
          log.warn('NanoBanana poll HTTP error', {
            image_gen_id, task_id: taskId, attempt,
            poll_url: pollUrl,
            status: queryRes.status,
            body_preview: queryRaw.slice(0, 300),
          });
          continue;
        }
        let queryData;
        try {
          queryData = JSON.parse(queryRaw);
        } catch (parseErr) {
          log.warn('NanoBanana poll JSON parse error', {
            image_gen_id, task_id: taskId, attempt,
            poll_url: pollUrl,
            raw_preview: queryRaw.slice(0, 300),
          });
          continue;
        }
        const successFlag = queryData?.data?.successFlag;
        const state = queryData?.data?.state;
        const status = queryData?.data?.status;
        log.info('NanoBanana poll status', {
          image_gen_id, task_id: taskId, attempt,
          code: queryData?.code, successFlag, state, status,
        });
        if (successFlag === 1 || state === 'succeeded' || status === '3') {
          const respImgs = queryData?.data?.response?.images;
          const fromSdWrapped = Array.isArray(respImgs) && typeof respImgs[0] === 'string' && respImgs[0].length > 0
            ? (respImgs[0].startsWith('data:') ? respImgs[0] : `data:image/png;base64,${respImgs[0].replace(/\s/g, '')}`)
            : null;
          const imageUrl = queryData?.data?.response?.resultImageUrl
            || queryData?.data?.response?.originImageUrl
            || queryData?.data?.data?.images?.[0]?.url
            || fromSdWrapped;
          if (imageUrl) {
            log.info('NanoBanana image completed', { image_gen_id, task_id: taskId, image_url: imageUrl.slice(0, 120) });
            return { image_url: imageUrl };
          }
          log.warn('NanoBanana succeeded but no image URL found', {
            image_gen_id, task_id: taskId,
            data_keys: queryData?.data ? Object.keys(queryData.data) : [],
            nested_data_keys: queryData?.data?.data ? Object.keys(queryData.data.data) : [],
            response_keys: queryData?.data?.response ? Object.keys(queryData.data.response) : [],
            raw_preview: queryRaw.slice(0, 500),
          });
          return { error: '未返回图片地址' };
        }
        if (successFlag === 2 || successFlag === 3 || state === 'failed') {
          const errMsg = queryData?.data?.errorMessage || queryData?.data?.msg || '任务失败';
          log.warn('NanoBanana task failed', { image_gen_id, task_id: taskId, successFlag, state, error_message: errMsg });
          return { error: 'NanoBanana 生成失败: ' + errMsg };
        }
      } catch (e) {
        log.warn('NanoBanana poll request failed', { attempt, error: e.message, image_gen_id, poll_url: pollUrl });
      }
    }
    return { error: 'NanoBanana 图片生成超时' };
  }
}

module.exports = {
  NanoBananaImageProvider,
  nanoBananaAspectRatio,
};
