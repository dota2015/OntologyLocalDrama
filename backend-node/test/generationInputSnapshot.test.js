const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Database = require('better-sqlite3');
const snapshots = require('../src/services/generationInputSnapshot');
const { ComfyUiImageProvider } = require('../src/services/image/providers/comfyUiImageProvider');

function setup(t) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE image_generations(id INTEGER PRIMARY KEY, input_snapshot TEXT); INSERT INTO image_generations(id) VALUES(1)');
  t.after(() => db.close());
  return db;
}

test('input history is immutable, retains attempts, and excludes media and credentials', t => {
  const db = setup(t);
  assert.equal(snapshots.read(db.prepare('SELECT * FROM image_generations').get()), null);
  const shot = { id: 9, semantic_slots: '{"h3_mode":"ref2va"}', updated_at: 'before' };
  const version = snapshots.storyboardVersion(shot);
  snapshots.record(db, 'image', 1, { storyboard: version, prompt: '原文', references: [snapshots.media('data:image/png;base64,aGVsbG8=')], request: { api_key: 'secret-key', authorization: 'Bearer secret', headers: { password: 'secret' }, image: 'data:image/png;base64,aGVsbG8=', url: 'https://name:password@host/path?token=secret#secret' } });
  shot.updated_at = 'after';
  snapshots.record(db, 'image', 1, { prompt: '第二次' });
  const result = snapshots.read(db.prepare('SELECT * FROM image_generations').get());
  assert.equal(result.attempts.length, 2);
  assert.deepEqual(result.attempts[0].storyboard, version);
  assert.equal(result.attempts[0].references[0].content_sha256, snapshots.sha256(Buffer.from('hello')));
  assert.doesNotMatch(JSON.stringify(result), /secret|password|base64|aGVsbG8/);
  assert.equal(snapshots.media('https://host/image.png').content_sha256, null);
});

async function server(t, handler) {
  const s = http.createServer(handler);
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  t.after(() => s.close());
  return `http://127.0.0.1:${s.address().port}`;
}

test('Comfy records exactly the submitted prompt, seed, aligned size and ordered reference bytes even on rejection', async t => {
  const db = setup(t);
  let submitted, uploads = 0;
  const base = await server(t, (req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/upload/image') { uploads++; res.end(JSON.stringify({ name: `ref${uploads}.png`, subfolder: 'tests' })); }
      else { submitted = JSON.parse(body); res.end(JSON.stringify({ error: 'controlled rejection' })); }
    });
  });
  const result = await new ComfyUiImageProvider().generateImage({
    db, config: { base_url: base }, opts: { image_gen_id: 1, input_storyboard: { id: 4 }, structured_storyboard: true, seed: 42, reference_image_urls: ['data:image/png;base64,YQ==','data:image/png;base64,Yg=='], input_references: [{ role: 'character', asset_id: 1 }, { role: 'character', asset_id: 2 }] },
    effectivePrompt: '保留人工文本：右侧人物安静倾听。', mergedNegativePrompt: '用户负面词', size: '930x546', model: 'qwen',
  });
  assert.match(result.error, /controlled rejection/);
  const record = snapshots.read(db.prepare('SELECT * FROM image_generations').get()).attempts[0];
  assert.deepEqual(record.request, submitted);
  assert.equal(record.prompt, submitted.prompt['4'].inputs.prompt);
  assert.equal(record.parameters.seed, 42);
  assert.equal(record.parameters.width % 32, 0);
  assert.equal(record.negative_prompt, '用户负面词');
  assert.deepEqual(record.references.map(r => r.content_sha256), ['a','b'].map(snapshots.sha256));
  assert.deepEqual(record.references.map(r => r.asset_id), [1,2]);
});

test('Comfy never submits a reduced set after missing or rejected reference uploads', async t => {
  const db = setup(t);
  let submissions = 0;
  const base = await server(t, (req, res) => {
    if (req.url === '/prompt') submissions++;
    res.statusCode = 400; res.end('{"error":"upload rejected"}');
  });
  for (const reference of ['nonexistent-ref.png', 'data:image/png;base64,YQ==']) {
    await assert.rejects(new ComfyUiImageProvider().generateImage({ db, config: { base_url: base }, opts: { image_gen_id: 1, reference_image_urls: [reference] }, size: '512x512' }), /参考图/);
  }
  assert.equal(submissions, 0);
  assert.equal(snapshots.read(db.prepare('SELECT * FROM image_generations').get()), null);
});

test('H3 detail exposes the actual prepared request while polling lists omit the snapshot', async t => {
  const db = setup(t);
  db.exec("CREATE TABLE video_generations(id INTEGER PRIMARY KEY, input_snapshot TEXT, deleted_at TEXT, status TEXT, created_at TEXT); INSERT INTO video_generations(id,status) VALUES(1,'processing'),(2,'completed')");
  const config = require('../src/services/aiConfigService');
  const native = require('../src/services/h3NativeService');
  const client = require('../src/services/videoClient');
  const service = require('../src/services/videoService');
  t.mock.method(config, 'listConfigs', () => [{ is_active: true, is_default: true, provider: 'minimax_h3', model: ['MiniMax-H3'], base_url: 'http://example.test/v1', api_key: 'private-key' }]);
  t.mock.method(native, 'prepare', async () => ({
    prompt: '最终槽位正文', h3_mode: 'ref2va', h3_mixed_references: true,
    reference_urls: ['data:image/png;base64,YQ=='], h3_audio_references: [{ key: 'character:28', url: 'data:audio/wav;base64,Yg==' }],
    input_references: [{ source: 'people/28.png', character_id: 28 }], input_storyboard: { id: 9, updated_at: 'old' },
    h3_native: { width: 1344, height: 768, steps: 23 },
  }));
  let sent;
  t.mock.method(global, 'fetch', async (_url, opts) => { sent = JSON.parse(opts.body); return { ok: true, status: 200, text: async () => JSON.stringify({ task_id: 'sample', execution: { seed: 42, generation_frames: 158, output_frames: 144, model: 'actual-ref2va-fp8.safetensors', steps: 23 } }) }; });
  const result = await client.callVideoApi(db, null, { video_gen_id: 1, storyboard_id: 9, drama_id: 1, prompt: '预览不是最终正文', duration: 6 });
  assert.equal(result.task_id, 'sample');
  const saved = service.getById(db, 1).input_snapshot.attempts[0];
  assert.equal(saved.prompt, sent.content[0].text);
  assert.deepEqual(saved.request, snapshots.sanitize(sent));
  assert.equal(saved.parameters.steps, 23);
  assert.deepEqual(saved.references.map(r => r.content_sha256), ['a','b'].map(snapshots.sha256));
  assert.equal(saved.references[0].asset_source, 'people/28.png');
  assert.equal(saved.references[0].character_id, 28);
  assert.equal(saved.parameters.seed, null);
  assert.equal(saved.execution.seed, 42);
  assert.equal(saved.execution.generation_frames, 158);
  assert.equal(saved.execution.model, 'actual-ref2va-fp8.safetensors');
  assert.doesNotMatch(JSON.stringify(saved), /private-key|base64/);
  assert.equal(service.getById(db, 2).input_snapshot, null);
  assert.ok(service.list(db, {}).items.every(item => !Object.hasOwn(item, 'input_snapshot')));
});
