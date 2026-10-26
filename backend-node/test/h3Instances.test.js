const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const path = require('path');
const migrate = require('../src/db/migrate');
const h3InstanceService = require('../src/services/h3InstanceService');
const settingsService = require('../src/services/settingsService');
const routes = require('../src/routes/settings');

const log = { info() {}, warn() {}, error() {} };

function setupDb(t) {
  const db = new Database(':memory:');
  t.after(() => { if (db.open) db.close(); });
  migrate.runMigrationsAndEnsure(db);
  return db;
}

test('H3 instance configuration and automatic concurrency binding', async (t) => {
  const db = setupDb(t);

  // Setup temporary config directory
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-instances-test-'));
  const tempConfigFile = path.join(tempDir, 'minimax_video_bridge.json');
  fs.writeFileSync(tempConfigFile, JSON.stringify({
    comfy_urls: ['http://10.10.13.7:8188', 'http://10.10.13.7:8189']
  }, null, 2), 'utf-8');

  const oldEnv = process.env.MINIMAX_BRIDGE_CONFIG;
  process.env.MINIMAX_BRIDGE_CONFIG = tempConfigFile;
  t.after(() => {
    if (oldEnv !== undefined) process.env.MINIMAX_BRIDGE_CONFIG = oldEnv;
    else delete process.env.MINIMAX_BRIDGE_CONFIG;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // Mock global fetch for ComfyUI probe
  t.mock.method(global, 'fetch', async (url, opts) => {
    if (url.includes('/queue')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ queue_running: [], queue_pending: [] }),
      };
    }
    return { ok: false, status: 404 };
  });

  // 1. Initial read: should read from temp config file
  const initial = await h3InstanceService.getInstances(db);
  assert.equal(initial.count, 2);
  assert.equal(initial.instances.length, 2);
  assert.equal(initial.instances[0].url, 'http://10.10.13.7:8188');
  assert.equal(initial.instances[1].url, 'http://10.10.13.7:8189');

  // 2. Update instances to 3 instances: should write to file and auto-sync pipeline_video_concurrency to 3
  const updateResult = await h3InstanceService.updateInstances(db, log, {
    instances: [
      'http://10.10.13.7:8188',
      'http://10.10.13.7:8189',
      'http://10.10.13.7:8191'
    ],
    auto_sync_concurrency: true,
  });

  assert.equal(updateResult.ok, true);
  assert.equal(updateResult.count, 3);
  assert.equal(updateResult.pipeline_video_concurrency, 3);

  // Verify database setting was updated
  const dbConcurrency = settingsService.getGlobalSetting(db, 'pipeline_video_concurrency');
  assert.equal(Number(dbConcurrency), 3);

  // Verify file on disk was updated
  const savedFile = JSON.parse(fs.readFileSync(tempConfigFile, 'utf-8'));
  assert.deepEqual(savedFile.comfy_urls, [
    'http://10.10.13.7:8188',
    'http://10.10.13.7:8189',
    'http://10.10.13.7:8191'
  ]);
  assert.equal(savedFile.comfy_url, 'http://10.10.13.7:8188');

  // 3. Test instance probe
  const probe = await h3InstanceService.testInstance('http://10.10.13.7:8188');
  assert.equal(probe.ok, true);
  assert.equal(probe.online, true);
  assert.equal(probe.queue_running, 0);

  // 4. Invalid URL check
  await assert.rejects(
    async () => {
      await h3InstanceService.updateInstances(db, log, { instances: ['invalid-url'] });
    },
    { message: /至少需要提供一个有效的 ComfyUI 实例地址/ }
  );
});
