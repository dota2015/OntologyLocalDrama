const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const Database = require('better-sqlite3');
const native = require('../src/services/unslothImageService');
const imageService = require('../src/services/imageService');
const migrate = require('../src/db/migrate');
const config = require('../src/config');

const memoryError = 'Generating at 2048x1152 with its input images needs about 14.49 GB of working memory even with tiled VAE decoding (including about 2.00 GB of fixed overhead), but only about 8.74 GB is usable on this device (of the 11.13 GB currently free, after reserving room for fragmentation and other processes).';
const log = { info() {}, warn() {}, error() {} };

async function server(t, generate, referenceResolutions) {
  const requests = [];
  let png = await sharp({ create: { width: 32, height: 32, channels: 3, background: 'white' } }).png().toBuffer();
  const srv = http.createServer(async (req, res) => {
    if (req.url.endsWith('/status')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ loaded: true, repo_id: 'test/qwen', workflows: ['txt2img', 'reference'],
        conditioning: { dimension_multiple: 32, max_condition_images: 10, reference_resolutions: referenceResolutions }, generation_defaults: { steps: 25, guidance: 1 } }));
    } else if (req.url.endsWith('/generate')) {
      let raw = '';
      for await (const part of req) raw += part;
      const body = JSON.parse(raw);
      requests.push(body);
      const failure = await generate(body, requests.length);
      res.setHeader('Content-Type', 'application/json');
      if (failure) { res.statusCode = failure.status; res.end(JSON.stringify({ detail: failure.detail })); return; }
      png = await sharp({ create: { width: body.width, height: body.height, channels: 3, background: 'white' } }).png().toBuffer();
      res.end(JSON.stringify({ images: [{ url: '/gallery/result' }] }));
    } else if (req.url === '/gallery/result') { res.setHeader('Content-Type', 'image/png'); res.end(png); }
    else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { srv.close(resolve); srv.closeAllConnections(); }));
  return { config: { base_url: `http://127.0.0.1:${srv.address().port}/v1`, api_key: 'test' }, requests };
}

test('explicit memory preflight refusal reduces output while preserving every reference, prompt, steps and guidance', async t => {
  const { config, requests } = await server(t, (_body, count) => count === 1 ? { status: 400, detail: memoryError } : null);
  const refs = ['data:image/png;base64,Zmlyc3Q=', 'data:image/png;base64,c2Vjb25k'];
  const result = await native.callUnslothImageApi(config, log, { prompt: 'same boy and outfit', size: '2048x1152', reference_image_urls: refs });
  assert.equal(result.error, undefined);
  assert.equal(requests.length, 2);
  assert.deepEqual([result.width, result.height, result.size], [1344, 768, '1344x768']);
  for (const body of requests) {
    assert.equal(body.workflow, 'reference'); assert.equal(body.init_image, refs[0]);
    assert.deepEqual(body.reference_images, refs.slice(1));
    assert.equal(body.prompt, 'same boy and outfit'); assert.equal(body.steps, 25); assert.equal(body.guidance, 1);
    assert.equal(body.allow_oversized, undefined);
  }
});

test('multi-reference memory overhead is addressed before output downscaling, without dropping or rewriting an input', async t => {
  const { config, requests } = await server(t, body => body.reference_resolution === 512 ? null : { status: 400, detail: memoryError }, [512, 1024, 2048]);
  const refs = ['character-A', 'character-B', 'scene', 'prop'].map(name => 'data:image/png;base64,' + Buffer.from(name).toString('base64'));
  const result = await native.callUnslothImageApi(config, log, { prompt: 'same characters and costumes', size: '2048x1152', reference_image_urls: refs });
  assert.equal(result.error, undefined);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(body => body.reference_resolution), [1024, 512]);
  assert.equal(result.size, '2048x1152');
  for (const body of requests) {
    assert.deepEqual([body.init_image, ...body.reference_images], refs);
    assert.deepEqual([body.width, body.height], [2048, 1152]);
    assert.equal(body.steps, 25); assert.equal(body.guidance, 1);
    assert.equal(body.allow_oversized, undefined);
  }
});

test('native generations to the same endpoint are serialized, including after a failed job', async t => {
  let active = 0, peak = 0;
  const { config, requests } = await server(t, async (_body, count) => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 25));
    active--;
    return count === 1 ? { status: 400, detail: 'Invalid prompt' } : null;
  });
  const results = await Promise.all(['first', 'second', 'third'].map(prompt => native.callUnslothImageApi(config, log, { prompt, size: '512x512' })));
  assert.match(results[0].error, /Invalid prompt/);
  assert.equal(results[1].error, undefined); assert.equal(results[2].error, undefined);
  assert.deepEqual(requests.map(body => body.prompt), ['first', 'second', 'third']);
  assert.equal(peak, 1);
});

test('runtime failures are never retried and repeated preflight refusals stop after three requests', async t => {
  for (const failure of [{ status: 500, detail: memoryError }, { status: 400, detail: 'CUDA out of memory' }, { status: 400, detail: memoryError }]) {
    const { config, requests } = await server(t, () => failure);
    const result = await native.callUnslothImageApi(config, log, { prompt: 'a boy', size: '2048x1152' });
    assert.match(result.error, /Unsloth 图片生成失败/);
    assert.equal(requests.length, failure.status === 400 && failure.detail === memoryError ? 3 : 1);
  }
});

test('real storyboard image pipeline stores the adapted resolution and does not upscale it to the refused canvas', async t => {
  const { config: upstream } = await server(t, (_body, count) => count === 1 ? { status: 400, detail: memoryError } : null);
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-unsloth-memory-'));
  t.after(() => fs.rmSync(storage, { recursive: true, force: true }));
  const db = new Database(':memory:');
  t.after(() => db.close());
  t.mock.method(console, 'log', () => {}); t.mock.method(console, 'warn', () => {});
  migrate.runMigrationsAndEnsure(db);
  t.mock.method(config, 'loadConfig', () => ({ app: { name: 'test', language: 'zh' }, style: {}, storage: { local_path: storage } }));
  db.exec(`INSERT INTO dramas(id,title,metadata) VALUES(1,'本剧','{"aspect_ratio":"16:9"}');
    INSERT INTO episodes(id,drama_id,episode_number) VALUES(1,1,1);
    INSERT INTO storyboards(id,episode_id,storyboard_number,characters,description) VALUES(1,1,1,'[]','少年坐在书桌前。');
    INSERT INTO image_generations(id,drama_id,storyboard_id,frame_type,prompt,size,status) VALUES(1,1,1,'storyboard_first','少年坐在书桌前。','2048x1152','pending');`);
  db.prepare('UPDATE storyboards SET error_msg = ? WHERE id=1').run('Unsloth 图片生成失败（HTTP 400）：' + memoryError);
  db.prepare(`INSERT INTO ai_service_configs(service_type,provider,api_protocol,name,base_url,api_key,model,is_active,is_default)
    VALUES('image','openai','unsloth','test',?,'test','["test/qwen"]',1,1)`).run(upstream.base_url);
  await imageService.processImageGeneration(db, log, 1);
  const row = db.prepare('SELECT * FROM image_generations WHERE id=1').get();
  assert.equal(row.status, 'completed', row.error_msg);
  assert.equal(row.size, '1344x768'); assert.equal(row.width, 1344); assert.equal(row.height, 768);
  assert.equal(db.prepare('SELECT first_frame_image_id FROM storyboards WHERE id=1').get().first_frame_image_id, 1);
  assert.equal(db.prepare('SELECT error_msg FROM storyboards WHERE id=1').get().error_msg, null);
  const actual = await sharp(fs.readFileSync(path.join(storage, row.local_path))).metadata();
  assert.deepEqual([actual.width, actual.height], [1344, 768]);
});
