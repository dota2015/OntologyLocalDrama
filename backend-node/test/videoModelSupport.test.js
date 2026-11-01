const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const aiConfigs = require('../src/services/aiConfigService');
const {
  resolveSupportedVideoFamily,
  assertSupportedVideoConfig,
} = require('../src/services/videoModelSupport');

const log = { info() {}, error() {}, errorw() {} };

function createDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE ai_service_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, service_type TEXT, provider TEXT, api_protocol TEXT,
    name TEXT, base_url TEXT, api_key TEXT, model TEXT, default_model TEXT, endpoint TEXT,
    query_endpoint TEXT, priority INTEGER, is_default INTEGER, is_active INTEGER, settings TEXT,
    created_at TEXT, updated_at TEXT, deleted_at TEXT
  )`);
  return db;
}

test('supported video family resolver accepts only MiniMax H3', () => {
  assert.equal(resolveSupportedVideoFamily({ api_protocol: 'minimax_h3', model: ['minimax_h3'] }), 'minimax_h3');
  assert.equal(resolveSupportedVideoFamily({ provider: 'comfyui_wan22', model: ['Wan2.2'] }), null);
  assert.equal(resolveSupportedVideoFamily({ api_protocol: 'openai', model: ['MiniMax-H3'] }), 'minimax_h3');
  assert.equal(resolveSupportedVideoFamily({ provider: 'dashscope', model: ['wan2.2-kf2v-flash'] }), null);
  assert.equal(resolveSupportedVideoFamily({ api_protocol: 'minimax_h3', model: ['agnes-video-2.5'] }), null);
  assert.equal(resolveSupportedVideoFamily({ api_protocol: 'comfyui_wan22', model: ['seedance-2.0'] }), null);
  assert.throws(() => assertSupportedVideoConfig({ provider: 'agnes' }), /仅支持 MiniMax H3/);
});

test('AI config CRUD rejects removed video providers but keeps their image configs', (t) => {
  const db = createDb();
  t.after(() => db.close());
  assert.throws(() => aiConfigs.createConfig(db, log, {
    service_type: 'video', provider: 'agnes', api_protocol: 'agnes', name: 'Agnes video',
    base_url: 'http://example', api_key: 'key', model: ['agnes-video-2.5'],
  }), /仅支持 MiniMax H3/);

  const image = aiConfigs.createConfig(db, log, {
    service_type: 'image', provider: 'agnes', api_protocol: 'openai', name: 'Agnes image',
    base_url: 'http://example', api_key: 'key', model: ['agnes-image-2.5'],
  });
  assert.equal(image.provider, 'agnes');

  const h3 = aiConfigs.createConfig(db, log, {
    service_type: 'video', provider: 'minimax_h3', api_protocol: 'minimax_h3', name: 'H3',
    base_url: 'http://h3', api_key: 'local', model: ['minimax_h3'], is_default: true,
  });
  assert.throws(() => aiConfigs.createConfig(db, log, {
    service_type: 'video', provider: 'comfyui_wan22', api_protocol: 'comfyui_wan22', name: 'Wan',
    base_url: 'http://wan', api_key: 'local', model: ['Wan2.2-I2V-A14B-FP8-4steps'],
  }), /仅支持 MiniMax H3/);
  assert.deepEqual(aiConfigs.listConfigs(db, 'video').map((item) => item.id), [h3.id]);
});
