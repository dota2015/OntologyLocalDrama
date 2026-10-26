/**
 * 快手可灵图片生成策略 (KlingImageProvider)
 * 遵循策略模式 (Strategy Pattern)，负责 Kling 异步任务提交与轮询。
 */

const {
  BaseImageProvider,
  IMAGE_HTTP_TIMEOUT_MS,
  resolveImageRef,
} = require('../baseProvider');
const { postJSONWithTimeout } = require('../../aiClient');

// 可灵 aspect_ratio：16:9 / 9:16 / 1:1 / 4:3 / 3:4 / 3:2 / 2:3
function klingImageAspectRatio(size) {
  if (!size) return '16:9';
  const s = String(size).trim().toLowerCase().replace(/\s/g, '');
  const ratioSet = new Set(['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3']);
  if (ratioSet.has(s)) return s;
  const match = s.match(/^(\d+)[x*](\d+)$/);
  if (!match) return '1:1';
  const w = parseInt(match[1], 10);
  const h = parseInt(match[2], 10);
  if (!w || !h) return '1:1';
  const r = w / h;
  if (r >= 1.6) return '16:9';
  if (r >= 1.2) return '4:3';
  if (r >= 0.9) return '1:1';
  if (r >= 0.7) return '3:4';
  return '9:16';
}

class KlingImageProvider extends BaseImageProvider {
  constructor() {
    super('kling');
  }

  supports(protocol, provider, model) {
    const p = String(provider || '').toLowerCase();
    const proto = String(protocol || '').toLowerCase();
    const m = String(model || '').toLowerCase();
    return proto === 'kling' || p === 'kling' || p === 'klingai' || /^kling-/i.test(m);
  }

  async generateImage({ config, log, opts, effectivePrompt, model, size }) {
    const { image_gen_id, reference_image_urls, files_base_url, storage_local_path } = opts;
    const base = (config.base_url || 'https://api.klingai.com').replace(/\/$/, '');
    const apiKey = config.api_key || '';
    const headers = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey,
    };

    let ep = config.endpoint || '/v1/images/generations';
    if (!ep.startsWith('/')) ep = '/' + ep;
    const submitUrl = base + ep;

    const aspectRatio = klingImageAspectRatio(size);
    const m = model || 'kling-image';

    const rawRefs = Array.isArray(reference_image_urls) ? reference_image_urls.filter(Boolean) : [];
    const resolvedRefs = rawRefs.map((r) => resolveImageRef(r, files_base_url, storage_local_path)).filter(Boolean);

    const body = {
      model: m,
      prompt: effectivePrompt || '',
      aspect_ratio: aspectRatio,
      n: 1,
      callback_url: '',
    };

    if (resolvedRefs.length > 0) {
      body.image_reference = resolvedRefs.slice(0, 1).map((url) => ({ type: 'subject', url }));
      body.image_fidelity = 0.5;
    }

    const bodyForLog = { ...body };
    if (Array.isArray(bodyForLog.image_reference)) {
      bodyForLog.image_reference = bodyForLog.image_reference.map((r) =>
        r.url && r.url.startsWith('data:') ? { ...r, url: '(base64)' } : r
      );
    }
    log.info('[Kling图生] 发送请求', {
      url: submitUrl, model: m, image_gen_id,
      has_ref: resolvedRefs.length > 0,
      aspect_ratio: aspectRatio,
      body_preview: JSON.stringify(bodyForLog).slice(0, 300),
    });

    let submitRaw;
    let submitStatus;
    try {
      const out = await postJSONWithTimeout(submitUrl, headers, body, IMAGE_HTTP_TIMEOUT_MS);
      submitStatus = out.statusCode;
      submitRaw = out.raw;
    } catch (e) {
      log.error('[Kling图生] 网络错误', { image_gen_id, error: e.message });
      return { error: 'Kling 图片生成网络请求失败: ' + e.message };
    }

    if (submitStatus < 200 || submitStatus >= 300) {
      let errMsg = 'Kling 图片生成请求失败: ' + submitStatus;
      try {
        const errJson = JSON.parse(submitRaw);
        const msg = errJson.message || errJson.msg || (errJson.error && (errJson.error.message || errJson.error));
        if (msg) errMsg += ' - ' + String(msg).slice(0, 200);
      } catch (_) {
        if (submitRaw) errMsg += ' - ' + submitRaw.slice(0, 200);
      }
      log.error('[Kling图生] 请求失败', { status: submitStatus, body: submitRaw.slice(0, 500), image_gen_id });
      return { error: errMsg };
    }

    let submitData;
    try {
      submitData = JSON.parse(submitRaw);
    } catch (e) {
      return { error: 'Kling 返回格式异常: ' + submitRaw.slice(0, 200) };
    }

    if (submitData.code !== undefined && submitData.code !== 0) {
      return { error: `Kling 错误(${submitData.code}): ${submitData.message || '未知错误'}` };
    }

    const directUrl = submitData?.data?.task_result?.images?.[0]?.url;
    if (directUrl) {
      log.info('[Kling图生] 同步返回图片', { image_gen_id });
      return { image_url: directUrl };
    }

    const taskId = submitData?.data?.task_id;
    if (!taskId) {
      log.warn('[Kling图生] 未返回 task_id', { image_gen_id, raw_preview: submitRaw.slice(0, 300) });
      return { error: 'Kling 未返回 task_id: ' + submitRaw.slice(0, 200) };
    }

    const cfgQEp = config.query_endpoint
      ? (config.query_endpoint.startsWith('/') ? config.query_endpoint : '/' + config.query_endpoint)
      : '';
    function buildKlingQueryUrl(tid) {
      if (cfgQEp) return base + cfgQEp.replace(/\{taskId\}/gi, encodeURIComponent(tid)).replace(/\{task_id\}/gi, encodeURIComponent(tid)).replace(/\{id\}/gi, encodeURIComponent(tid));
      return base + ep + '/' + encodeURIComponent(tid);
    }

    log.info('[Kling图生] 任务已提交，开始轮询', { image_gen_id, task_id: taskId });
    const maxAttempts = 60;
    const intervalMs = 4000;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((r) => setTimeout(r, intervalMs));
      try {
        const queryRes = await fetch(buildKlingQueryUrl(taskId), { method: 'GET', headers });
        if (!queryRes.ok) continue;
        const queryData = JSON.parse(await queryRes.text());
        const status = queryData?.data?.task_status;
        log.info('[Kling图生] 轮询状态', { image_gen_id, task_id: taskId, attempt, status });
        if (status === 'succeed') {
          const imgUrl = queryData?.data?.task_result?.images?.[0]?.url;
          if (imgUrl) {
            log.info('[Kling图生] 生成完成', { image_gen_id, task_id: taskId });
            return { image_url: imgUrl };
          }
          return { error: '可灵未返回图片地址' };
        }
        if (status === 'failed') {
          const errMsg = queryData?.data?.task_status_msg || '任务失败';
          log.warn('[Kling图生] 任务失败', { image_gen_id, task_id: taskId, error: errMsg });
          return { error: '可灵生成失败: ' + errMsg };
        }
      } catch (e) {
        log.warn('[Kling图生] 轮询请求失败', { attempt, error: e.message, image_gen_id });
      }
    }
    return { error: '可灵图片生成超时' };
  }
}

module.exports = {
  KlingImageProvider,
  klingImageAspectRatio,
};
