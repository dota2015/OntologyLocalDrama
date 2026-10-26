const fs = require('fs');
const path = require('path');
const settingsService = require('./settingsService');

function getProjectRoot() {
  return path.resolve(__dirname, '../../../');
}

function resolveBridgeConfigFile() {
  const root = getProjectRoot();
  const envPath = process.env.MINIMAX_BRIDGE_CONFIG;
  if (envPath) {
    const p = path.isAbsolute(envPath) ? envPath : path.join(root, envPath);
    if (fs.existsSync(p)) return p;
  }
  const fp8 = path.join(root, 'configs/minimax_video_bridge_13.7_fp8.json');
  if (fs.existsSync(fp8)) return fp8;
  const standard = path.join(root, 'configs/minimax_video_bridge.json');
  if (fs.existsSync(standard)) return standard;
  return fp8;
}

function getBridgeUrl(db) {
  try {
    const row = db.prepare(`
      SELECT base_url FROM ai_service_configs
      WHERE service_type = 'video'
        AND (provider = 'minimax_h3' OR api_protocol = 'minimax_h3')
        AND is_active = 1
      ORDER BY is_default DESC, id DESC
      LIMIT 1
    `).get();
    if (row?.base_url) return row.base_url.replace(/\/+$/, '');
  } catch (_) {}
  return 'http://127.0.0.1:5689';
}

function readLocalConfigFile() {
  const configFile = resolveBridgeConfigFile();
  try {
    if (fs.existsSync(configFile)) {
      const content = fs.readFileSync(configFile, 'utf-8');
      return { file: configFile, data: JSON.parse(content) };
    }
  } catch (_) {}
  return { file: configFile, data: null };
}

async function probeSingleInstance(url) {
  const trimmed = (url || '').trim().replace(/\/+$/, '');
  const start = Date.now();
  try {
    const res = await fetch(`${trimmed}/queue`, { signal: AbortSignal.timeout(3000) });
    const latency_ms = Date.now() - start;
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      const running = Array.isArray(data.queue_running) ? data.queue_running.length : 0;
      const pending = Array.isArray(data.queue_pending) ? data.queue_pending.length : 0;
      return {
        url: trimmed,
        online: true,
        latency_ms,
        queue_running: running,
        queue_pending: pending,
        load: running + pending,
      };
    }
    return { url: trimmed, online: false, latency_ms, error: `HTTP ${res.status}` };
  } catch (err) {
    return { url: trimmed, online: false, latency_ms: null, error: err.message };
  }
}

async function getInstances(db) {
  const bridgeUrl = getBridgeUrl(db);
  const currentConcurrency = Number(settingsService.getGlobalSetting(db, 'pipeline_video_concurrency', 3)) || 3;

  // 1. Try querying the active video bridge
  try {
    const res = await fetch(`${bridgeUrl}/v1/instances`, { signal: AbortSignal.timeout(2500) });
    if (res.ok) {
      const data = await res.json();
      return {
        bridge_url: bridgeUrl,
        bridge_online: true,
        instances: Array.isArray(data.instances) ? data.instances : [],
        count: Array.isArray(data.instances) ? data.instances.length : 0,
        pipeline_video_concurrency: currentConcurrency,
        config_file: data.config_path || resolveBridgeConfigFile(),
      };
    }
  } catch (_) {
    // Bridge offline or endpoint not yet loaded; fall back to local file
  }

  // 2. Fallback: inspect config file directly and probe instances from backend
  const { file, data } = readLocalConfigFile();
  const rawUrls = (data?.comfy_urls) || (data?.comfy_url ? [data.comfy_url] : []);
  const uniqueUrls = Array.from(new Set(rawUrls.map(u => String(u || '').trim().replace(/\/+$/, '')).filter(Boolean)));

  const probed = await Promise.all(uniqueUrls.map(u => probeSingleInstance(u)));
  return {
    bridge_url: bridgeUrl,
    bridge_online: false,
    instances: probed,
    count: probed.length,
    pipeline_video_concurrency: currentConcurrency,
    config_file: file,
  };
}

async function updateInstances(db, log, body) {
  const rawList = Array.isArray(body?.instances) ? body.instances : [];
  const cleaned = [];
  for (const item of rawList) {
    const u = typeof item === 'object' && item?.url ? item.url : item;
    if (typeof u !== 'string') continue;
    const trimmed = u.trim().replace(/\/+$/, '');
    if (/^https?:\/\/[a-zA-Z0-9.-]+(:\d+)?(\/.*)?$/.test(trimmed) && !cleaned.includes(trimmed)) {
      cleaned.push(trimmed);
    }
  }

  if (cleaned.length === 0) {
    const err = new Error('至少需要提供一个有效的 ComfyUI 实例地址 (如 http://10.10.13.7:8188)');
    err.status = 400;
    throw err;
  }

  // 1. Persist to config file
  const configFile = resolveBridgeConfigFile();
  try {
    let existing = {};
    if (fs.existsSync(configFile)) {
      try { existing = JSON.parse(fs.readFileSync(configFile, 'utf-8')); } catch (_) {}
    }
    existing.comfy_urls = cleaned;
    existing.comfy_url = cleaned[0];
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
    log?.info?.('Updated H3 bridge config file', { file: configFile, instances: cleaned });
  } catch (e) {
    log?.warn?.('Failed to write H3 bridge config file', { file: configFile, error: e.message });
  }

  // 2. Notify bridge if online
  const bridgeUrl = getBridgeUrl(db);
  try {
    await fetch(`${bridgeUrl}/v1/instances`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instances: cleaned }),
      signal: AbortSignal.timeout(3000),
    });
  } catch (e) {
    log?.info?.('Bridge not reachable for hot update, config saved to file', { bridgeUrl });
  }

  // 3. Automatically sync video concurrency to the number of configured H3 instances
  const autoSync = body?.auto_sync_concurrency !== false;
  if (autoSync) {
    settingsService.setGlobalSetting(db, 'pipeline_video_concurrency', cleaned.length);
    log?.info?.('Auto-synced pipeline_video_concurrency to H3 instances count', { count: cleaned.length });
  }

  const updatedConcurrency = Number(settingsService.getGlobalSetting(db, 'pipeline_video_concurrency', cleaned.length)) || cleaned.length;
  const probed = await Promise.all(cleaned.map(u => probeSingleInstance(u)));

  return {
    ok: true,
    bridge_url: bridgeUrl,
    instances: probed,
    count: cleaned.length,
    pipeline_video_concurrency: updatedConcurrency,
    config_file: configFile,
  };
}

async function testInstance(url) {
  const trimmed = (url || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[a-zA-Z0-9.-]+(:\d+)?(\/.*)?$/.test(trimmed)) {
    return { ok: false, error: '无效的 URL 地址，必须以 http:// 或 https:// 开头' };
  }
  const result = await probeSingleInstance(trimmed);
  return { ok: result.online, ...result };
}

module.exports = {
  getBridgeUrl,
  resolveBridgeConfigFile,
  getInstances,
  updateInstances,
  testInstance,
};
