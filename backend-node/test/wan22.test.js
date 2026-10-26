const { it } = require('node:test');
const assert = require('node:assert/strict');
const client = require('../src/services/videoClient');
const ai = require('../src/services/aiConfigService');
const service = require('../src/services/videoService');
const Database = require('better-sqlite3');
const log = { info() {}, warn() {}, error() {} };
const model = 'Wan2.2-I2V-A14B-FP8-4steps';
const config = { provider: 'comfyui_wan22', api_protocol: 'comfyui_wan22', base_url: 'http://bridge.example', model: [model], default_model: model, is_active: true, is_default: true };

it('Wan submits actual duration, seed and both frame roles despite duplicate classic references', async t => {
  t.mock.method(ai, 'listConfigs', () => [config]);
  let body;
  t.mock.method(global, 'fetch', async (url, options) => {
    assert.equal(url, 'http://bridge.example/v1/videos');
    body = JSON.parse(options.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'wan-task' }) };
  });
  const result = await client.callVideoApi(null, log, { model, prompt: 'walking', duration: 3, seed: 123,
    first_frame_url: 'https://cdn/first.png', last_frame_url: 'https://cdn/last.png', reference_urls: ['https://cdn/first.png', 'https://cdn/last.png'] });
  assert.equal(result.task_id, 'wan-task');
  assert.equal(body.model, model);
  assert.equal(body.duration, 3);
  assert.equal(body.seed, 123);
  assert.equal(body.resolution, 'local');
  assert.deepEqual(body.content.slice(1).map(x => x.role), ['first_frame', 'last_frame']);
  assert.equal(client.buildQueryUrl(config, 'a b'), 'http://bridge.example/v1/videos/a%20b');
});

it('Wan rejects missing first frames and unsupported durations before submission', async t => {
  t.mock.method(ai, 'listConfigs', () => [config]);
  t.mock.method(global, 'fetch', () => assert.fail('Invalid job was submitted'));
  const noImage = await client.callVideoApi(null, log, { model, prompt: 'shot', reference_urls: ['https://cdn/ref.png'] });
  assert.match(noImage.error, /首帧/);
  for (const duration of [0, 11, NaN]) {
    const result = await client.callVideoApi(null, log, { model, prompt: 'shot', duration, first_frame_url: 'https://cdn/first.png' });
    assert.match(result.error, /1–10/);
  }
});

it('Wan service preserves explicit frames before transport', async t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE video_generations (id INTEGER PRIMARY KEY, status TEXT, updated_at TEXT, deleted_at TEXT,
    error_msg TEXT, model TEXT, duration REAL, aspect_ratio TEXT, prompt TEXT, first_frame_url TEXT, last_frame_url TEXT, reference_image_urls TEXT)`);
  db.prepare("INSERT INTO video_generations (id,status,model,duration,prompt,first_frame_url,last_frame_url,reference_image_urls) VALUES (1,'processing',?,5,'motion',?,?,?)")
    .run(model,'https://cdn/first.png','https://cdn/last.png',JSON.stringify(['https://cdn/first.png','https://cdn/last.png']));
  t.mock.method(client, 'getDefaultVideoConfig', () => config);
  let opts;
  t.mock.method(client, 'callVideoApi', async (_db,_log,input) => { opts = input; return { error: 'Test stops before GPU submission' }; });
  await service.processVideoGeneration(db,log,1);
  assert.equal(opts.first_frame_url,'https://cdn/first.png');
  assert.equal(opts.last_frame_url,'https://cdn/last.png');
});

it('Wan keeps an identical first and last image as two explicit anchors', async t => {
  t.mock.method(ai, 'listConfigs', () => [config]);
  t.mock.method(global, 'fetch', async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body).content.slice(1).map(x => x.role), ['first_frame','last_frame']);
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'loop-task' }) };
  });
  const result = await client.callVideoApi(null, log, { model, prompt: 'loop motion', first_frame_url: 'https://cdn/loop.png', last_frame_url: 'https://cdn/loop.png' });
  assert.equal(result.task_id, 'loop-task');
});

it('Wan polling returns the video and surfaces execution failures', async t => {
  let response = { status: 'completed', video_url: 'https://cdn/wan.mp4' };
  t.mock.method(global, 'fetch', async () => ({ ok: true, status: 200, text: async () => JSON.stringify(response) }));
  assert.deepEqual(await client.pollVideoTask(null, log, 1, 'wan-task', config, 1, 0), { video_url: 'https://cdn/wan.mp4' });
  response = { status: 'failed', error: 'Out of memory' };
  assert.match((await client.pollVideoTask(null, log, 1, 'wan-task', config, 1, 0)).error, /Out of memory/);
});
