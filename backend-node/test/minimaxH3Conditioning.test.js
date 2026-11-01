const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const client = require('../src/services/videoClient');
const service = require('../src/services/videoService');
const aiConfig = require('../src/services/aiConfigService');
const log = { info() {}, warn() {}, error() {} };
const config = {
  is_active: true, is_default: true, provider: 'minimax_h3', api_protocol: 'minimax_h3',
  model: ['MiniMax-H3'], default_model: 'MiniMax-H3', base_url: 'http://bridge.example', endpoint: '/v1/videos',
};

describe('H3 image conditioning', () => {
  it('retains classic frame roles through the service despite the duplicate reference list', async (t) => {
    const db = new Database(':memory:');
    t.after(() => db.close());
    db.exec(`CREATE TABLE video_generations (
      id INTEGER PRIMARY KEY, status TEXT, updated_at TEXT, deleted_at TEXT, error_msg TEXT,
      model TEXT, duration INTEGER, aspect_ratio TEXT, prompt TEXT,
      image_url TEXT, first_frame_url TEXT, last_frame_url TEXT, reference_image_urls TEXT
    )`);
    db.prepare(`INSERT INTO video_generations VALUES
      (1, 'processing', NULL, NULL, NULL, 'MiniMax-H3', 5, '16:9', 'shot', ?, ?, ?, ?)`)
      .run('https://cdn/first.png', 'https://cdn/first.png', 'https://cdn/last.png',
        JSON.stringify(['https://cdn/first.png', 'https://cdn/last.png']));
    t.mock.method(client, 'getDefaultVideoConfig', () => config);
    let captured;
    t.mock.method(client, 'callVideoApi', async (_db, _log, opts) => {
      captured = opts;
      return { error: 'Stop before generation' };
    });
    await service.processVideoGeneration(db, log, 1);
    assert.equal(captured.first_frame_url, 'https://cdn/first.png');
    assert.equal(captured.last_frame_url, 'https://cdn/last.png');
  });

  for (const frames of [true, false]) {
    it(`submits ${frames ? 'first/last frames' : 'ordered universal references'} to the H3 endpoint`, async (t) => {
      t.mock.method(aiConfig, 'listConfigs', () => [config]);
      let body;
      t.mock.method(global, 'fetch', async (url, options) => {
        assert.equal(url, 'http://bridge.example/v1/videos');
        body = JSON.parse(options.body);
        return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'h3-task' }) };
      });
      const result = await client.callVideoApi(null, log, {
        model: 'MiniMax-H3', prompt: '@图片2 walks in @图片1', duration: 5, aspect_ratio: '9:16',
        first_frame_url: frames ? 'https://cdn/first.png' : undefined,
        last_frame_url: frames ? 'https://cdn/last.png' : undefined,
        reference_urls: ['https://cdn/scene.png', 'https://cdn/person.png'],
      });
      assert.equal(result.task_id, 'h3-task');
      const images = body.content.filter(item => item.type === 'image_url');
      assert.deepEqual(images.map(item => item.role), frames
        ? ['first_frame', 'last_frame'] : ['reference_image', 'reference_image']);
      assert.deepEqual(images.map(item => item.image_url.url), frames
        ? ['https://cdn/first.png', 'https://cdn/last.png'] : ['https://cdn/scene.png', 'https://cdn/person.png']);
      assert.equal(body.ratio, frames ? 'adaptive' : '9:16');
    });
  }

  it('rejects an overflowing reference list instead of silently shifting or dropping slots', async (t) => {
    t.mock.method(aiConfig, 'listConfigs', () => [config]);
    t.mock.method(global, 'fetch', () => assert.fail('Invalid references reached the endpoint'));
    const result = await client.callVideoApi(null, log, {
      model: 'MiniMax-H3', prompt: 'shot', reference_urls: Array(10).fill('https://cdn/image.png'),
    });
    assert.match(result.error, /9/);
  });

  it('shows bridge validation errors instead of hiding their detail', async (t) => {
    t.mock.method(aiConfig, 'listConfigs', () => [config]);
    t.mock.method(global, 'fetch', async () => ({
      ok: false, status: 422, text: async () => JSON.stringify({ detail: 'Image could not be decoded' }),
    }));
    const result = await client.callVideoApi(null, log, { model: 'MiniMax-H3', prompt: 'shot' });
    assert.match(result.error, /Image could not be decoded/);
  });
});
