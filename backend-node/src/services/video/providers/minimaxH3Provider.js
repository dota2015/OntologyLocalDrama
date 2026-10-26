/**
 * MiniMax H3 视频服务提供商策略 (MinimaxH3VideoProvider)
 * 采用原生 V2 协议与内容数组传输契约
 */

const BaseVideoProvider = require('../baseProvider');

function isMinimaxH3Model(name) {
  const m = String(name || '').trim().toLowerCase();
  return m === 'minimax-h3' || m === 'minimax_h3' || /^minimax[-_]?h3\b/.test(m);
}

function getMinimaxApiRoot(baseUrl) {
  let root = String(baseUrl || 'https://api.minimaxi.com').trim().replace(/\/$/, '');
  for (const suf of ['/v2', '/v1']) {
    if (root.toLowerCase().endsWith(suf)) {
      root = root.slice(0, -suf.length).replace(/\/$/, '');
      break;
    }
  }
  return root || 'https://api.minimaxi.com';
}

function normalizeMinimaxH3Duration(duration) {
  const n = Math.round(Number(duration));
  const safe = Number.isFinite(n) && n > 0 ? n : 5;
  return Math.min(15, Math.max(4, safe));
}

function normalizeMinimaxH3Resolution(resolution) {
  const s = String(resolution || '').trim().toLowerCase();
  if (!s) return '768P';
  if (s === '2k' || s.includes('2k') || s.includes('1080') || s === '1080p') return '2K';
  if (s.includes('768') || s === '768p') return '768P';
  return '768P';
}

function buildMinimaxH3CreateUrl(config) {
  const root = getMinimaxApiRoot(config?.base_url);
  let ep = (config?.endpoint || '/v2/video_generation').toString().trim();
  if (!ep.startsWith('/')) ep = '/' + ep;
  if (/^\/video_generation\/?$/i.test(ep) || /^\/v1\/video_generation\/?$/i.test(ep)) {
    ep = '/v2/video_generation';
  }
  return root + ep;
}

function buildMinimaxH3PollUrl(config, taskId) {
  const root = getMinimaxApiRoot(config?.base_url);
  const id = String(taskId || '').trim();
  let ep = (config?.query_endpoint || '/v2/query/video_generation/{taskId}').toString().trim();
  if (!ep.startsWith('/')) ep = '/' + ep;
  if (/query\/video_generation\?task_id=/i.test(ep) || /^\/v1\/query\//i.test(ep)) {
    ep = '/v2/query/video_generation/{taskId}';
  }
  ep = ep
    .replace(/\{taskId\}/gi, encodeURIComponent(id))
    .replace(/\{task_id\}/gi, encodeURIComponent(id))
    .replace(/\{id\}/gi, encodeURIComponent(id));
  if (/\/v2\/query\/video_generation\/?$/i.test(ep) && id) {
    ep = ep.replace(/\/?$/, '/') + encodeURIComponent(id);
  }
  return root + ep;
}

function extractMinimaxH3VideoUrl(data) {
  if (!data || typeof data !== 'object') return null;
  const coerce = (val) => {
    if (!val) return null;
    const s = String(val).trim();
    return /^https?:\/\/.+/i.test(s) ? s : null;
  };
  const task = data.task && typeof data.task === 'object' ? data.task : data;
  const content = task.content && typeof task.content === 'object' ? task.content : null;
  return (
    coerce(content?.url) ||
    coerce(task.video_url) ||
    coerce(task.url) ||
    coerce(data.video_url) ||
    coerce(data.url) ||
    null
  );
}

class MinimaxH3VideoProvider extends BaseVideoProvider {
  constructor() {
    super('minimax_h3');
  }

  supports(protocol, provider, model) {
    const proto = String(protocol || '').toLowerCase();
    const p = String(provider || '').toLowerCase();
    return proto === 'minimax_h3' || p === 'minimax_h3' || isMinimaxH3Model(model);
  }

  normalizeDuration(duration) {
    return normalizeMinimaxH3Duration(duration);
  }

  normalizeSize(resolution) {
    return normalizeMinimaxH3Resolution(resolution);
  }

  buildPollUrl(config, taskId) {
    return buildMinimaxH3PollUrl(config, taskId);
  }

  extractVideoUrl(data) {
    return extractMinimaxH3VideoUrl(data);
  }
}

module.exports = {
  MinimaxH3VideoProvider,
  isMinimaxH3Model,
  getMinimaxApiRoot,
  normalizeMinimaxH3Duration,
  normalizeMinimaxH3Resolution,
  buildMinimaxH3CreateUrl,
  buildMinimaxH3PollUrl,
  extractMinimaxH3VideoUrl,
};
