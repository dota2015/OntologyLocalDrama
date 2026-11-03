const inputSnapshot = require('./generationInputSnapshot');
const fs = require('fs');
const path = require('path');
const aiConfigService = require('./aiConfigService');
const { flattenModelIds, pickModelId } = require('./modelId');
const { isSupportedVideoConfig, assertSupportedVideoConfig } = require('./videoModelSupport');
const {
  isMinimaxH3Model,
  getMinimaxApiRoot,
  normalizeMinimaxH3Duration,
  normalizeMinimaxH3Resolution,
  buildMinimaxH3CreateUrl,
  buildMinimaxH3PollUrl,
  extractMinimaxH3VideoUrl,
} = require('./video/providers/minimaxH3Provider');

const SUPPORTED_ASPECT_RATIOS = new Set(['9:16', '16:9', '1:1', '4:3', '3:4', '3:2', '2:3']);
const { normalizeExecutionPlan } = require('./continuumPlan');

function modelCandidate(config = {}, modelHint = '') {
  return modelHint
    || config.default_model
    || (Array.isArray(config.model) ? config.model[0] : config.model)
    || '';
}

/** Resolve the only video protocol supported by this application. */
function resolveVideoProtocol(config = {}, modelHint = '') {
  const protocol = String(config.api_protocol || '').trim().toLowerCase();
  const provider = String(config.provider || '').trim().toLowerCase();
  const model = modelCandidate(config, modelHint);
  if (protocol === 'minimax_h3' || provider === 'minimax_h3') return 'minimax_h3';
  if ((!protocol || protocol === 'openai') && isMinimaxH3Model(model)) return 'minimax_h3';
  return '';
}

function normalizeAspectRatioForApi(raw) {
  if (raw == null) return null;
  let value = String(raw)
    .trim()
    .replace(/\uFF1A/g, ':')
    .replace(/[×xX＊*]/g, ':')
    .replace(/\s+/g, '');
  if (!value) return null;
  const aliases = {
    portrait: '9:16',
    landscape: '16:9',
    square: '1:1',
    vertical: '9:16',
    horizontal: '16:9',
  };
  value = aliases[value.toLowerCase()] || value;
  return SUPPORTED_ASPECT_RATIOS.has(value) ? value : null;
}

function getDefaultVideoConfig(db, preferredModel) {
  const active = aiConfigService.listConfigs(db, 'video')
    .filter((config) => config.is_active && isSupportedVideoConfig(config));
  if (!active.length) return null;
  if (preferredModel) {
    return active.find((config) => {
      const models = Array.isArray(config.model) ? config.model : [config.model].filter(Boolean);
      return models.includes(preferredModel);
    }) || null;
  }
  return active.find((config) => config.is_default) || active[0];
}

function getModelFromConfig(config, preferredModel) {
  const models = flattenModelIds(config?.model);
  const preferred = pickModelId(preferredModel);
  const fallback = pickModelId(config?.default_model);
  if (preferred && models.includes(preferred)) return preferred;
  if (fallback && models.includes(fallback)) return fallback;
  return models[0] || '';
}

function buildQueryUrl(config, taskId, extras = {}) {
  const model = extras.model || getModelFromConfig(config);
  assertSupportedVideoConfig(config, model);
  return buildMinimaxH3PollUrl(config, taskId);
}

function isPlausibleHttpVideoUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

function parseSettings(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function localImageDataUrl(rawUrl, filesBaseUrl, storagePath, log, videoGenId, role) {
  const source = String(rawUrl || '').trim();
  if (!source) return null;
  if (source.startsWith('data:') || source.startsWith('asset://')) return source;
  if (/^https?:\/\//i.test(source) && !/localhost|127\.0\.0\.1/i.test(source)) return source;
  if (!storagePath) return source;

  const filesBase = String(filesBaseUrl || '').replace(/\/$/, '');
  let relative = '';
  const staticIndex = source.toLowerCase().indexOf('/static/');
  if (staticIndex >= 0) {
    relative = source.slice(staticIndex + '/static/'.length);
  } else if (filesBase && source.startsWith(filesBase)) {
    relative = source.slice(filesBase.length).replace(/^\//, '');
  } else if (!/^https?:\/\//i.test(source)) {
    relative = source.replace(/^\/static\//, '').replace(/^\//, '');
  }
  relative = relative.split('?')[0];
  if (!relative) return source;

  const root = path.resolve(storagePath);
  const absolute = path.resolve(root, relative);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) return source;
  try {
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return source;
    const mime = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp',
    }[path.extname(absolute).toLowerCase()] || 'image/png';
    const result = `data:${mime};base64,${fs.readFileSync(absolute).toString('base64')}`;
    log?.info?.('[视频] 本地参考图已转为 base64', { video_gen_id: videoGenId, role, relative });
    return result;
  } catch (_) {
    return source;
  }
}

function mediaForLog(value) {
  if (value == null) return value;
  const text = String(value);
  return text.startsWith('data:') ? `(base64, ${text.length} chars)` : text;
}

function requestBodyForLog(body) {
  const copy = JSON.parse(JSON.stringify(body));
  if (Array.isArray(copy.content)) {
    copy.content = copy.content.map((part) => {
      if (part?.type === 'image_url' && part.image_url?.url) {
        return { ...part, image_url: { ...part.image_url, url: mediaForLog(part.image_url.url) } };
      }
      if (part?.type === 'audio_url' && part.audio_url?.url) {
        return { ...part, audio_url: { ...part.audio_url, url: mediaForLog(part.audio_url.url) } };
      }
      return part;
    });
  }
  return copy;
}

function logVideoRequest(log, provider, url, body, videoGenId, meta) {
  log?.info?.(`[${provider}] Video POST 摘要`, { video_gen_id: videoGenId, url, ...meta });
  log?.info?.(`[${provider}] Video POST 请求体`, {
    video_gen_id: videoGenId,
    post_body: JSON.stringify(requestBodyForLog(body), null, 2),
  });
}

function extractTaskStatus(data) {
  if (!data || typeof data !== 'object') return '';
  const task = data.task && typeof data.task === 'object' ? data.task : data;
  const value = task.status || task.state || task.task_status || data.status || data.state;
  return value == null ? '' : String(value).trim().toLowerCase();
}

function extractFailureMessage(data) {
  if (!data || typeof data !== 'object') return '';
  const task = data.task && typeof data.task === 'object' ? data.task : data;
  const candidates = [
    task.error?.message,
    typeof task.error === 'string' ? task.error : null,
    task.fail_reason,
    task.message,
    data.error?.message,
    typeof data.error === 'string' ? data.error : null,
    data.fail_reason,
    data.message,
    data.detail,
  ];
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const message = typeof candidate === 'string' ? candidate.trim() : JSON.stringify(candidate);
    if (message && !isPlausibleHttpVideoUrl(message)) return message;
  }
  return '';
}

async function callContentVideoApi(config, log, opts = {}) {
  const {
    prompt,
    model,
    duration,
    aspect_ratio,
    resolution,
    image_url,
    first_frame_url,
    last_frame_url,
    reference_urls,
    files_base_url,
    storage_local_path,
    video_gen_id,
    execution_backend,
    continuum_plan,
  } = opts;
  const label = 'MiniMax H3';
  const url = buildMinimaxH3CreateUrl(config);

  const finalModel = isMinimaxH3Model(model) ? 'MiniMax-H3' : model || 'MiniMax-H3';
  // Do not let the provider helper's legacy safety clamp turn an invalid
  // 31-second request into a valid 30-second request. Long-shot limits are a
  // planning contract and must be rejected before any upstream submission.
  if (duration != null && String(duration).trim() !== '') {
    const requestedDuration = Number(duration);
    if (!Number.isInteger(requestedDuration) || requestedDuration < 4 || requestedDuration > 30) {
      return { error: `H3 单个逻辑分镜时长必须是 4～30 秒整数，当前为 ${duration}；超过30秒请让导演 Agent 按语义拆镜` };
    }
  }
  const finalDuration = normalizeMinimaxH3Duration(duration);
  const execution = normalizeExecutionPlan(finalDuration, { execution_backend, continuum_plan });
  const finalResolution = normalizeMinimaxH3Resolution(resolution);
  const ratio = normalizeAspectRatioForApi(aspect_ratio) || '16:9';
  const content = [{ type: 'text', text: String(prompt || '').trim() || 'cinematic scene' }];

  const firstImage = localImageDataUrl(
    first_frame_url || image_url,
    files_base_url,
    storage_local_path,
    log,
    video_gen_id,
    'first_frame'
  );
  let lastImage = localImageDataUrl(
    last_frame_url,
    files_base_url,
    storage_local_path,
    log,
    video_gen_id,
    'last_frame'
  );
  if (firstImage && lastImage && firstImage === lastImage) lastImage = null;

  const references = Array.isArray(reference_urls) ? reference_urls.filter(Boolean).map(String) : [];
  const usesGuides = !!(firstImage || lastImage);
  const mixedH3 = opts.h3_mixed_references === true;
  if ((!usesGuides || mixedH3) && references.length > 9) {
    return { error: 'MiniMax-H3 最多支持 9 张参考图，请减少参考图后重试' };
  }

  if (firstImage) content.push({ type: 'image_url', image_url: { url: firstImage }, role: 'first_frame' });
  if (lastImage) content.push({ type: 'image_url', image_url: { url: lastImage }, role: 'last_frame' });
  if (!usesGuides || mixedH3) {
    for (let index = 0; index < references.length; index += 1) {
      const urlValue = localImageDataUrl(
        references[index],
        files_base_url,
        storage_local_path,
        log,
        video_gen_id,
        `reference_${index}`
      );
      if (urlValue) content.push({ type: 'image_url', image_url: { url: urlValue }, role: 'reference_image' });
    }
  }

  const isFl2va = (
    opts.h3_mode === 'fl2va'
    || (usesGuides && !mixedH3 && !opts.h3_audio_references?.length)
  );
  if (!isFl2va && Array.isArray(opts.h3_audio_references)) {
    if (opts.h3_audio_references.length > 3) {
      return { error: 'H3 每镜最多支持 3 个参考声音，请拆分镜头' };
    }
    for (const reference of opts.h3_audio_references) {
      content.push({ type: 'audio_url', audio_url: { url: reference.url }, role: 'reference_audio' });
    }
  }

  const body = {
    model: finalModel,
    content,
    duration: finalDuration,
    resolution: finalResolution,
    execution_backend: execution.execution_backend,
    ...(execution.continuum_plan ? { continuum_plan: execution.continuum_plan } : {}),
    ...(opts.h3_native ? { h3_native: opts.h3_native } : {}),
  };
  body.ratio = usesGuides ? 'adaptive' : ratio;

  logVideoRequest(log, label, url, body, video_gen_id, {
    model: finalModel,
    has_first_frame: !!firstImage,
    has_last_frame: !!lastImage,
    reference_count: (!usesGuides || mixedH3) ? references.length : 0,
  });

  const refMetadata = opts.input_references || [];
  let imageIndex = 0;
  let audioIndex = 0;
  const submittedReferences = content.filter(item => item.type !== 'text').map((item, index) => {
    const audio = item.type === 'audio_url';
    const identity = audio ? opts.h3_audio_references?.[audioIndex++] : refMetadata[imageIndex++];
    const { url: ignored, ...details } = identity || {};
    return { ...details, asset_source: details.source || details.local_path || null, ...inputSnapshot.media(item.image_url?.url || item.audio_url?.url), index: index + 1, role: item.role };
  });
  const snapshotAttempt = inputSnapshot.record(opts.snapshot_db, 'video', video_gen_id, {
    provider: 'minimax_h3', model: finalModel, mode: isFl2va ? 'fl2va' : 'ref2va',
    storyboard: inputSnapshot.storyboardVersion(opts.input_storyboard),
    input_fingerprint: opts.input_fingerprint || null,
    prompt: body.content[0].text, references: submittedReferences,
    parameters: {
      duration: finalDuration,
      execution_backend: execution.execution_backend,
      ...(execution.continuum_plan ? { continuum_plan: execution.continuum_plan } : {}),
      resolution: finalResolution,
      ratio: body.ratio,
      ...opts.h3_native,
      seed: null,
      seed_source: 'upstream_selected',
    },
    request: body,
  });
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.api_key || ''}`,
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  log?.info?.(`[${label}] raw response`, {
    video_gen_id,
    status: response.status,
    raw: raw.slice(0, 1000),
  });
  if (!response.ok) {
    let message = `${label} 请求失败: ${response.status}`;
    try {
      const payload = JSON.parse(raw);
      const detail = payload.error?.message || payload.message || payload.base_resp?.status_msg || payload.detail;
      if (detail) message += ` - ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 200)}`;
    } catch (_) {
      if (raw) message += ` - ${raw.slice(0, 200)}`;
    }
    return { error: message };
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    return { error: `${label} 响应非 JSON: ${error.message}` };
  }
  if (data.execution && snapshotAttempt != null) {
    try {
      inputSnapshot.attachExecution(opts.snapshot_db, video_gen_id, snapshotAttempt, data.execution);
    } catch (error) {
      // Submission already succeeded. Do not orphan or resubmit that upstream task
      // because optional execution metadata could not be persisted.
      log?.warn?.('[H3] 执行参数快照补充失败，保留原提交记录并继续查询原任务', { video_gen_id, error: error.message });
    }
  }
  const taskId = data.task_id || data.task?.id || data.id || data.data?.task_id;
  const directUrl = extractMinimaxH3VideoUrl(data);
  if (directUrl) return { video_url: directUrl };
  if (taskId) return { task_id: String(taskId), status: 'processing' };
  return { error: `${label} 未返回 task_id: ${JSON.stringify(data).slice(0, 300)}` };
}

async function callVideoApi(db, log, opts = {}) {
  const preferredModel = opts.model;
  const config = getDefaultVideoConfig(db, preferredModel);
  if (!config) throw new Error('没有可用的 MiniMax H3 视频配置');
  const family = assertSupportedVideoConfig(config, preferredModel);
  const model = getModelFromConfig(config, preferredModel);
  log?.info?.('[视频] 路由协议', {
    video_gen_id: opts.video_gen_id,
    provider: config.provider || '',
    api_protocol_raw: config.api_protocol || '(empty→auto)',
    protocol_used: family,
    model,
    endpoint: config.endpoint || '(auto)',
  });

  if (family === 'minimax_h3') {
    const settings = parseSettings(config.settings);
    if (db && opts.drama_id && opts.storyboard_id) {
      const prepared = await require('./h3NativeService').prepare(db, log, opts);
      return callContentVideoApi(config, log, { ...opts, ...prepared, model, snapshot_db: db });
    }

    const forceFl2va = opts.h3_mode === 'fl2va';
    let voiceReferences = { references: [], instructions: '' };
    if (!forceFl2va && settings.supports_voice_reference === true && db && opts.drama_id && opts.storyboard_id) {
      voiceReferences = await require('./h3VoiceReferenceService').forShot(
        db,
        log,
        opts.drama_id,
        opts.storyboard_id,
        opts.storage_local_path
      );
      log?.info?.('[H3] Prepared speaker voice references', {
        storyboard_id: opts.storyboard_id,
        speakers: voiceReferences.references.map((reference) => reference.speaker),
      });
    }
    return callContentVideoApi(config, log, {
      ...opts,
      snapshot_db: db,
      prompt: `${opts.prompt || ''}${forceFl2va ? '' : voiceReferences.instructions || ''}`,
      h3_audio_references: forceFl2va ? [] : voiceReferences.references,
      model,
    });
  }

  throw new Error('当前仅支持 MiniMax H3 视频模型');
}

async function pollVideoTask(db, log, videoGenId, taskId, config, maxAttempts = 300, intervalMs = 10000) {
  const model = getModelFromConfig(config);
  const family = assertSupportedVideoConfig(config, model);
  const label = 'MiniMax H3';
  const url = buildQueryUrl(config, taskId, { model });
  log?.info?.('[poll] 开始', {
    video_gen_id: videoGenId,
    task_id: taskId,
    protocol: family,
    poll_url: url,
  });

  const cancellationError = () => {
    if (!db || !videoGenId) return null;
    try {
      const current = db.prepare(
        'SELECT status, error_msg, deleted_at FROM video_generations WHERE id = ?'
      ).get(videoGenId);
      if (!current || current.status === 'failed' || current.status === 'cancelled' || current.deleted_at) {
        return current?.error_msg || '任务已被取消';
      }
    } catch (_) {}
    return null;
  };

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const beforeWait = cancellationError();
    if (beforeWait) return { error: beforeWait };
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const afterWait = cancellationError();
    if (afterWait) return { error: afterWait };

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${config.api_key || ''}` },
      });
      const raw = await response.text();
      const round = attempt + 1;
      log?.info?.('[poll] 查询 HTTP 结果', {
        video_gen_id: videoGenId,
        round,
        http_status: response.status,
        bytes: raw.length,
        body: raw.slice(0, 16384),
      });
      if (!response.ok) continue;

      let data;
      try {
        data = JSON.parse(raw);
      } catch (error) {
        log?.warn?.('[poll] 响应非 JSON', { video_gen_id: videoGenId, round, error: error.message });
        continue;
      }
      const status = extractTaskStatus(data);
      const videoUrl = extractMinimaxH3VideoUrl(data);
      if (['failed', 'failure', 'cancelled', 'canceled', 'error', 'fail'].includes(status)) {
        return { error: (extractFailureMessage(data) || `${label} 任务失败`).slice(0, 500) };
      }
      if (videoUrl && isPlausibleHttpVideoUrl(videoUrl)) return { video_url: videoUrl };
      if (['succeeded', 'completed', 'success', 'done'].includes(status)) {
        return { error: `${label} 任务完成但未返回视频地址` };
      }
    } catch (error) {
      log?.warn?.('Video poll request failed', { attempt, error: error.message });
    }
  }
  return { error: '生成耗时较长，任务仍在队列中渲染，可点击「继续查询」获取进度' };
}

module.exports = {
  resolveVideoProtocol,
  getDefaultVideoConfig,
  callVideoApi,
  pollVideoTask,
  buildQueryUrl,
  normalizeAspectRatioForApi,
  isPlausibleHttpVideoUrl,
  isMinimaxH3Model,
  getMinimaxApiRoot,
  buildMinimaxH3PollUrl,
  extractMinimaxH3VideoUrl,
  normalizeMinimaxH3Duration,
  normalizeMinimaxH3Resolution,
};
