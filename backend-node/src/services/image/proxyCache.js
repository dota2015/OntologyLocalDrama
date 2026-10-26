/**
 * 图床缓存管理 (ImageProxyCache)
 * 提供图床 URL 的本地 SQLite 缓存、有效期校验与健康探测。
 */

const crypto = require('crypto');
const { loadConfig } = require('../../config');

let _appConfig = null;
function getAppConfig() {
  if (!_appConfig) {
    try { _appConfig = loadConfig(); } catch (_) { _appConfig = {}; }
  }
  return _appConfig;
}

function getProxyExpireHours() {
  return Number(getAppConfig()?.image_proxy?.expire_hours ?? 23);
}

function getProxyCache(db, cacheKey) {
  try {
    const row = db.prepare('SELECT proxy_url, created_at FROM image_proxy_cache WHERE cache_key = ?').get(cacheKey);
    if (!row?.proxy_url) return null;

    const expireMs = getProxyExpireHours() * 3600 * 1000;
    const createdAt = new Date(row.created_at).getTime();
    if (isNaN(createdAt) || Date.now() - createdAt > expireMs) {
      deleteProxyCache(db, cacheKey);
      return null;
    }

    return row.proxy_url;
  } catch (_) { return null; }
}

function deleteProxyCache(db, cacheKey) {
  try { db.prepare('DELETE FROM image_proxy_cache WHERE cache_key = ?').run(cacheKey); } catch (_) {}
}

async function isProxyUrlAlive(url, timeoutMs = 8000) {
  if (!url || !/^https?:\/\//i.test(url)) return false;
  const opts = { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' };
  try {
    let res = await fetch(url, opts);
    if (res.ok) return true;
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
    }
    return res.ok || res.status === 206;
  } catch (_) {
    return false;
  }
}

async function getProxyCacheValidated(db, cacheKey, log, tag) {
  const url = getProxyCache(db, cacheKey);
  if (!url) return null;
  if (await isProxyUrlAlive(url)) return url;
  deleteProxyCache(db, cacheKey);
  log?.warn?.('[图床缓存] URL 已失效，将重新上传', { tag, cache_key: cacheKey, url_head: url.slice(0, 80) });
  return null;
}

function setProxyCache(db, cacheKey, proxyUrl) {
  try {
    db.prepare(
      'INSERT OR REPLACE INTO image_proxy_cache (cache_key, proxy_url, created_at) VALUES (?, ?, ?)'
    ).run(cacheKey, proxyUrl, new Date().toISOString());
  } catch (_) {}
}

function buildCacheKey(ref, imageBuffer) {
  if (!ref.startsWith('data:')) return ref;
  return 'sha256:' + crypto.createHash('sha256').update(imageBuffer).digest('hex').slice(0, 32);
}

module.exports = {
  getProxyCache,
  deleteProxyCache,
  isProxyUrlAlive,
  getProxyCacheValidated,
  setProxyCache,
  buildCacheKey,
};
