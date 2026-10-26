const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const migrate = require('../src/db/migrate');
const characters = require('../src/services/characterLibraryService');
const images = require('../src/services/imageClient');
const uploads = require('../src/services/uploadService');
const config = require('../src/config');
const native = require('../src/services/unslothImageService');
const characterRoutes = require('../src/routes/characters');

const log = { info() {}, warn() {}, error() {} };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=', 'base64');
const dataUrl = 'data:image/png;base64,' + png.toString('base64');

async function setup(t) {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-photo-test-'));
  t.after(() => fs.rmSync(storage, { recursive: true, force: true }));
  fs.writeFileSync(path.join(storage, 'portrait.png'), png);
  const db = new Database(':memory:');
  t.after(() => db.close());
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  migrate.runMigrationsAndEnsure(db);
  db.exec(`INSERT INTO dramas (id,title,metadata) VALUES (1,'本剧','{}');
    INSERT INTO characters (id,drama_id,name,appearance,polished_prompt,ref_image,local_path)
    VALUES (1,1,'奕宸','蓝色训练服','Four views, blue training uniform','portrait.png','old-character.png');`);
  const requests = [];
  const status = { loaded: true, repo_id: 'test/qwen', workflows: ['txt2img','reference'],
    conditioning: { max_condition_images: 10, dimension_multiple: 32, max_output_side: 2752, max_output_pixels: 4300800 },
    generation_defaults: { steps: 25, guidance: 1 }, supports_negative_prompt: true };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ url: req.url, method: req.method, auth: req.headers.authorization, body });
    if (req.url === '/api/inference/images/status') {
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(status));
    } else if (req.url === '/api/inference/images/generate') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ images: [{ id: 'result', url: '/api/inference/images/gallery/result/file' }] }));
    } else if (req.url === '/api/inference/images/gallery/result/file' || req.url === '/portrait') {
      res.setHeader('Content-Type', 'image/png'); res.end(png);
    } else if (req.url === '/v1/images/generations') {
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ url: dataUrl }] }));
    } else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = 'http://127.0.0.1:' + server.address().port;
  db.prepare(`INSERT INTO ai_service_configs (service_type,provider,api_protocol,name,base_url,api_key,model,is_active,is_default)
    VALUES ('image','openai','unsloth','Test',?,'test-key','["test/qwen"]',1,1)`).run(origin + '/v1');
  const cfg = { app: { name: 'test', language: 'zh' }, style: {}, storage: { local_path: storage } };
  t.mock.method(config, 'loadConfig', () => cfg);
  t.mock.method(uploads, 'downloadImageToLocal', async (root, imageUrl) => {
    assert.equal(imageUrl, dataUrl); return 'generated-character.png';
  });
  return { db, cfg, requests, status, origin };
}

async function finish(db, count = 1) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const rows = db.prepare('SELECT * FROM image_generations ORDER BY id').all();
    if (rows.length === count && rows.every(r => ['completed','failed'].includes(r.status))) {
      for (const row of rows) assert.equal(row.status, 'completed', row.error_msg);
      return rows;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('image generation did not finish');
}

test('saved photo reaches native Qwen reference generation and stays separate from the generated card', async t => {
  const { db, cfg, requests } = await setup(t);
  const out = await characters.generateCharacterFourViewImage(db, log, cfg, 1);
  assert.equal(out.ok, true);
  const [row] = await finish(db);
  assert.deepEqual(JSON.parse(row.reference_images), ['portrait.png']);
  const sent = requests.find(r => r.url.endsWith('/generate')).body;
  assert.equal(sent.workflow, 'reference');
  assert.equal(sent.init_image, dataUrl);
  assert.deepEqual(sent.reference_images, []);
  assert.equal(sent.steps, 25);
  assert.equal(sent.guidance, 1);
  assert.deepEqual([sent.width, sent.height], [1792,1024]);
  assert.match(sent.prompt, /blue training uniform/);
  assert.match(sent.prompt, /preserve the same facial features/);
  assert.ok(sent.prompt.indexOf('人物身份优先') < sent.prompt.indexOf('blue training uniform'));
  assert.equal(requests.some(r => r.url === '/v1/images/generations'), false);
  assert.equal(requests.find(r => r.url.includes('/gallery/')).auth, 'Bearer test-key');
  const character = db.prepare('SELECT * FROM characters WHERE id=1').get();
  assert.equal(character.ref_image, 'portrait.png');
  assert.equal(character.polished_prompt, 'Four views, blue training uniform');
  assert.equal(character.local_path, 'generated-character.png');
  assert.ok(JSON.parse(character.extra_images).includes('old-character.png'));
});

test('standard character generation and batches use each character own saved photo', async t => {
  const { db, cfg, requests } = await setup(t);
  fs.writeFileSync(path.join(cfg.storage.local_path, 'second.png'), Buffer.from('second-photo'));
  db.exec(`INSERT INTO characters (id,drama_id,name,polished_prompt,ref_image)
    VALUES (2,1,'妈妈','Four views of mother','second.png');`);
  assert.equal(characters.generateCharacterImage(db, log, cfg, 1).ok, true);
  await finish(db);
  const first = requests.find(r => r.url.endsWith('/generate')).body;
  assert.equal(first.init_image, dataUrl);
  assert.match(first.prompt, /蓝色训练服/);
  db.exec('DELETE FROM image_generations'); requests.length = 0;
  assert.equal(characters.batchGenerateCharacterImages(db, log, cfg, [1,2]).ok, true);
  const rows = await finish(db, 2);
  assert.deepEqual(rows.map(r => JSON.parse(r.reference_images)[0]).sort(), ['portrait.png','second.png']);
  const sent = requests.filter(r => r.url.endsWith('/generate')).map(r => r.body.init_image);
  assert.ok(sent.includes(dataUrl));
  assert.ok(sent.includes('data:image/png;base64,' + Buffer.from('second-photo').toString('base64')));
});

test('without an uploaded photo existing generated main images are not used as hidden references', async t => {
  const { db, cfg, requests } = await setup(t);
  db.exec('UPDATE characters SET ref_image=NULL WHERE id=1');
  await characters.generateCharacterFourViewImage(db, log, cfg, 1);
  await finish(db);
  const sent = requests.find(r => r.url.endsWith('/generate')).body;
  assert.equal(sent.init_image, undefined);
  assert.equal(sent.workflow, undefined);
});

test('a missing saved photo fails before a generation task instead of silently generating from text', async t => {
  const { db, cfg, requests } = await setup(t);
  db.exec("UPDATE characters SET ref_image='missing.png' WHERE id=1");
  await assert.rejects(characters.generateCharacterFourViewImage(db, log, cfg, 1), /参考照片不存在/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM image_generations').get().n, 0);
  assert.equal(requests.length, 0);
});

test('OpenAI compatible providers also receive persisted reference images in the actual HTTP request', async t => {
  const { db, cfg, requests } = await setup(t);
  db.exec("UPDATE ai_service_configs SET api_protocol='openai'");
  await characters.generateCharacterFourViewImage(db, log, cfg, 1);
  await finish(db);
  assert.deepEqual(requests.find(r => r.url === '/v1/images/generations').body.image, [dataUrl]);
});

test('native adapter refuses unsupported references, excessive counts and wrong resident models before generation', async t => {
  const { status, requests, origin } = await setup(t);
  const cfg = { base_url: origin + '/v1', api_key: 'test-key' };
  const opts = { prompt: 'a character', model: 'test/qwen', reference_image_urls: [dataUrl] };
  status.workflows = ['txt2img'];
  assert.match((await native.callUnslothImageApi(cfg, log, opts)).error, /不支持参考图/);
  status.workflows.push('reference'); status.conditioning.max_condition_images = 1;
  assert.match((await native.callUnslothImageApi(cfg, log, { ...opts, reference_image_urls: [dataUrl,dataUrl] })).error, /超过.*上限/);
  assert.match((await native.callUnslothImageApi(cfg, log, { ...opts, model: 'wrong/model' })).error, /不一致/);
  assert.match((await native.callUnslothImageApi(cfg, log, { ...opts, reference_image_urls: ['missing.png'] })).error, /参考图无法读取/);
  assert.equal(requests.some(r => r.url.endsWith('/generate')), false);
});

test('native adapter fetches remote reference images without leaking the Unsloth token', async t => {
  const { requests, origin } = await setup(t);
  const result = await native.callUnslothImageApi({ base_url: origin, api_key: 'test-key' }, log, {
    prompt: 'a character', model: 'test/qwen', reference_image_urls: [origin + '/portrait'],
  });
  assert.equal(result.image_url, dataUrl);
  assert.equal(requests.find(r => r.url === '/portrait').auth, undefined);
  assert.equal(requests.find(r => r.url.endsWith('/generate')).body.init_image, dataUrl);
});

test('card upload image patch saves the face photo without replacing the current character card, then generation uses it', async t => {
  const { db, cfg, requests } = await setup(t);
  db.exec('UPDATE characters SET ref_image=NULL WHERE id=1');
  const routes=characterRoutes(db,cfg,log);
  const res={status(code){this.code=code;return this},json(body){this.body=body;return this}};
  routes.putImage({params:{id:'1'},body:{extra_images:'["portrait.png"]',ref_image:'portrait.png'}},res);
  assert.equal(res.body.success,true);
  const saved=db.prepare('SELECT * FROM characters WHERE id=1').get();
  assert.equal(saved.local_path,'old-character.png');
  assert.equal(saved.ref_image,'portrait.png');
  await characters.generateCharacterFourViewImage(db,log,cfg,1);
  await finish(db);
  assert.equal(requests.find(r=>r.url.endsWith('/generate')).body.init_image,dataUrl);
});
