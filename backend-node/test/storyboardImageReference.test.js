const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const migrate = require('../src/db/migrate');
const imageService = require('../src/services/imageService');
const imageClient = require('../src/services/imageClient');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../src/config');

const log = { info() {}, warn() {}, error() {} };

function makeDb(t) {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-sb-ref-test-'));
  t.after(() => fs.rmSync(storage, { recursive: true, force: true }));
  const db = new Database(':memory:');
  t.after(() => db.close());
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(config, 'loadConfig', () => ({ app: { name: 'test', language: 'zh' }, style: {}, storage: { local_path: storage } }));
  migrate.runMigrationsAndEnsure(db);
  db.prepare(`
    INSERT INTO ai_service_configs (service_type, provider, api_protocol, name, model, is_active, is_default)
    VALUES ('image', 'openai', 'unsloth', 'test', '["test/qwen"]', 1, 1)
  `).run();
  return db;
}

test('Step 2.3 filters out unmentioned characters from multi-character storyboard and injects exact person count rule', async (t) => {
  const db = makeDb(t);

  // Drama & Episode
  db.prepare("INSERT INTO dramas (id, title) VALUES (1, '测试剧')").run();
  db.prepare("INSERT INTO episodes (id, drama_id, episode_number, title) VALUES (1, 1, 1, '第1集')").run();

  // Characters
  db.prepare("INSERT INTO characters (id, drama_id, name, local_path) VALUES (10, 1, '奕辰', 'char_10.png')").run();
  db.prepare("INSERT INTO characters (id, drama_id, name, local_path) VALUES (20, 1, '丽霞', 'char_20.png')").run();
  db.prepare("INSERT INTO scenes (id, drama_id, location, local_path) VALUES (100, 1, '书桌区', 'scene_100.png')").run();

  // Storyboard with both characters linked [10, 20], but prompt/action ONLY has 奕辰
  db.prepare(`
    INSERT INTO storyboards (id, episode_id, storyboard_number, scene_id, characters, action, dialogue, image_prompt, polished_prompt)
    VALUES (501, 1, 1, 100, '[10, 20]', '奕辰坐在书桌前敲键盘，专注盯着屏幕', null, '奕辰坐在书桌前敲键盘', '奕辰（少年，圆脸，短发）坐在书桌前敲键盘，暖黄灯光')
  `).run();

  // Insert image generation row for standard storyboard image (frame_type = null)
  db.prepare(`
    INSERT INTO image_generations (id, storyboard_id, drama_id, episode_id, prompt, status, frame_type)
    VALUES (901, 501, 1, 1, '奕辰（少年，圆脸，短发）坐在书桌前敲键盘，暖黄灯光', 'pending', null)
  `).run();

  let capturedOpts = null;
  t.mock.method(imageClient, 'callImageApi', async (_db, _log, opts) => {
    capturedOpts = opts;
    return { image_url: 'data:image/png;base64,ZmFrZQ==' };
  });

  await imageService.processImageGeneration(db, log, 901);
  const genRow = db.prepare('SELECT * FROM image_generations WHERE id = 901').get();
  assert.equal(genRow.error_msg, null, 'no error in row: ' + genRow.error_msg);

  assert.ok(capturedOpts, 'callImageApi was called');
  // Character 20 (丽霞) was not in prompt/action/dialogue, so Step 2.3 should have filtered her out!
  assert.ok(capturedOpts.reference_image_urls.includes('char_10.png'), 'includes 奕辰 reference');
  assert.ok(!capturedOpts.reference_image_urls.includes('char_20.png'), '丽霞 reference was filtered out');

  // Exact character count rule was injected
  assert.match(capturedOpts.prompt, /出场人数铁律.*严格且仅有 1 人.*奕辰/);
  assert.match(capturedOpts.prompt, /STRICT RULE: Exactly 1 person \(奕辰\)/);

  // sanitizeFramePrompt normalized appearance in prompt
  assert.match(capturedOpts.prompt, /奕辰（(?:见 Image \d+[^）]*|参考图中的人物形象)）/);
  assert.ok(!capturedOpts.prompt.includes('圆脸，短发'), 'conflicting detailed appearance was normalized');
});

test('Step 2.1 does not inject offscreen/voiceover character into storyboard reference images', async (t) => {
  const db = makeDb(t);

  db.prepare("INSERT INTO dramas (id, title) VALUES (1, '测试剧')").run();
  db.prepare("INSERT INTO episodes (id, drama_id, episode_number, title) VALUES (1, 1, 1, '第1集')").run();

  db.prepare("INSERT INTO characters (id, drama_id, name, local_path) VALUES (10, 1, '奕辰', 'char_10.png')").run();
  db.prepare("INSERT INTO characters (id, drama_id, name, local_path) VALUES (30, 1, '妈妈', 'char_30.png')").run();
  db.prepare("INSERT INTO scenes (id, drama_id, location, local_path) VALUES (100, 1, '书桌区', 'scene_100.png')").run();

  // Storyboard action explicitly says 妈妈 from offscreen / does not enter frame
  db.prepare(`
    INSERT INTO storyboards (id, episode_id, storyboard_number, scene_id, characters, action, dialogue, image_prompt)
    VALUES (502, 1, 2, 100, '[10]', '奕辰坐在电脑前，妈妈从画外催促，不入画', '妈妈："奕辰，先把作业写完。"', '中景平视正面，奕辰坐在电脑前')
  `).run();

  db.prepare(`
    INSERT INTO image_generations (id, storyboard_id, drama_id, episode_id, prompt, status, frame_type)
    VALUES (902, 502, 1, 1, '中景平视正面，奕辰坐在电脑前', 'pending', null)
  `).run();

  let capturedOpts = null;
  t.mock.method(imageClient, 'callImageApi', async (_db, _log, opts) => {
    capturedOpts = opts;
    return { image_url: 'data:image/png;base64,ZmFrZQ==' };
  });

  await imageService.processImageGeneration(db, log, 902);

  assert.ok(capturedOpts, 'callImageApi was called');
  assert.ok(capturedOpts.reference_image_urls.includes('char_10.png'), 'includes 奕辰');
  assert.ok(!capturedOpts.reference_image_urls.includes('char_30.png'), 'offscreen 妈妈 was NOT added');
});

test('getCleanSingleCharacterRef crops 16:9 industrial character sheet to single front view and caches it', async (t) => {
  const sharp = require('sharp');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-char-crop-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // 1. Create a 1792x1024 test character sheet (aspect ~ 1.75)
  const sheetPath = path.join(tmpDir, 'char_sheet.png');
  await sharp({
    create: {
      width: 1792,
      height: 1024,
      channels: 3,
      background: { r: 255, g: 255, b: 255 }
    }
  }).png().toFile(sheetPath);

  // 2. Also create a 512x768 portrait photo (aspect ~ 0.67 < 1.45)
  const portraitPath = path.join(tmpDir, 'portrait.png');
  await sharp({
    create: {
      width: 512,
      height: 768,
      channels: 3,
      background: { r: 200, g: 200, b: 200 }
    }
  }).png().toFile(portraitPath);

  // Test wide sheet crop
  const cropped = await imageService.getCleanSingleCharacterRef(tmpDir, sheetPath, log);
  assert.equal(cropped, path.join(tmpDir, 'char_sheet_front_crop.png'));
  assert.ok(fs.existsSync(cropped), 'cropped file created on disk');
  const cropMeta = await sharp(cropped).metadata();
  assert.equal(cropMeta.width, 491);
  assert.equal(cropMeta.height, 980);

  // Test cache reuse (does not throw, returns existing file)
  const cached = await imageService.getCleanSingleCharacterRef(tmpDir, sheetPath, log);
  assert.equal(cached, cropped);

  // Test portrait image (aspect < 1.45) -> untouched
  const portraitResult = await imageService.getCleanSingleCharacterRef(tmpDir, portraitPath, log);
  assert.equal(portraitResult, portraitPath, 'portrait is not cropped');
});

test('processImageGeneration automatically provides clean single front-view crop for characters with industrial sheets', async (t) => {
  const db = makeDb(t);
  const sharp = require('sharp');

  // Find the temp storage path configured in makeDb
  const storageRoot = config.loadConfig().storage.local_path;
  const sheetRelPath = 'char_yichen_sheet.png';
  const sheetAbsPath = path.join(storageRoot, sheetRelPath);

  // Create a 1792x1024 industrial sheet in storage
  await sharp({
    create: {
      width: 1792,
      height: 1024,
      channels: 3,
      background: { r: 240, g: 240, b: 240 }
    }
  }).png().toFile(sheetAbsPath);

  db.prepare("INSERT INTO dramas (id, title) VALUES (1, '测试剧')").run();
  db.prepare("INSERT INTO episodes (id, drama_id, episode_number, title) VALUES (1, 1, 1, '第1集')").run();

  // Character 10 points to the industrial sheet
  db.prepare("INSERT INTO characters (id, drama_id, name, local_path) VALUES (10, 1, '奕辰', ?)").run(sheetRelPath);
  db.prepare("INSERT INTO scenes (id, drama_id, location, local_path) VALUES (100, 1, '书桌区', 'scene_100.png')").run();

  db.prepare(`
    INSERT INTO storyboards (id, episode_id, storyboard_number, scene_id, characters, action, image_prompt)
    VALUES (503, 1, 1, 100, '[10]', '奕辰坐在电脑前专注打游戏', '奕辰坐在电脑前打游戏')
  `).run();

  db.prepare(`
    INSERT INTO image_generations (id, storyboard_id, drama_id, episode_id, prompt, status, frame_type)
    VALUES (903, 503, 1, 1, '奕辰坐在电脑前打游戏', 'pending', null)
  `).run();

  let capturedOpts = null;
  t.mock.method(imageClient, 'callImageApi', async (_db, _log, opts) => {
    capturedOpts = opts;
    return { image_url: 'data:image/png;base64,ZmFrZQ==' };
  });

  await imageService.processImageGeneration(db, log, 903);

  assert.ok(capturedOpts, 'callImageApi was called');
  // Must contain the front cropped version instead of raw multi-view sheet!
  const hasFrontCrop = capturedOpts.reference_image_urls.some(ref => ref.includes('char_yichen_sheet_front_crop.png'));
  assert.ok(hasFrontCrop, 'reference_image_urls contains the single front view crop: ' + JSON.stringify(capturedOpts.reference_image_urls));
  const hasRawSheet = capturedOpts.reference_image_urls.some(ref => ref === sheetRelPath);
  assert.ok(!hasRawSheet, 'raw multi-view sheet was replaced');
});

test('getCleanSingleSceneRef extracts top-left establishing wide shot for 2x2 quad-grid scenes', async (t) => {
  const sharp = require('sharp');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-scene-ref-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const db = new Database(':memory:');
  t.after(() => db.close());
  migrate.runMigrationsAndEnsure(db);

  // 1. Create a 1792x1024 2x2 quad-grid scene image
  const quadScenePath = path.join(tmpDir, 'scene_quad.png');
  await sharp({
    create: { width: 1792, height: 1024, channels: 3, background: { r: 100, g: 150, b: 200 } }
  }).png().toFile(quadScenePath);

  // Insert into DB as quad_grid
  db.prepare(`
    INSERT INTO scenes (id, drama_id, location, reference_image_mode, polished_prompt, local_path)
    VALUES (1, 1, '书桌区', 'quad_grid', 'ONE image: 2×2 grid. TL=establishing wide.', 'scene_quad.png')
  `).run();

  const cropped = await imageService.getCleanSingleSceneRef(tmpDir, 'scene_quad.png', 1, db, log);
  assert.ok(cropped.includes('scene_quad_establishing_crop.png'), 'cropped path returned');
  assert.ok(fs.existsSync(path.join(tmpDir, 'scene_quad_establishing_crop.png')), 'file exists on disk');

  // Verify cropped dimensions
  const meta = await sharp(path.join(tmpDir, 'scene_quad_establishing_crop.png')).metadata();
  assert.equal(meta.width, 896);
  assert.equal(meta.height, 512);

  // Calling again returns cached
  const cached = await imageService.getCleanSingleSceneRef(tmpDir, 'scene_quad.png', 1, db, log);
  assert.equal(cached, cropped);

  // 2. Single scene image is untouched
  const singleScenePath = path.join(tmpDir, 'scene_single.png');
  await sharp({
    create: { width: 1792, height: 1024, channels: 3, background: { r: 50, g: 80, b: 120 } }
  }).png().toFile(singleScenePath);

  db.prepare(`
    INSERT INTO scenes (id, drama_id, location, reference_image_mode, polished_prompt, local_path)
    VALUES (2, 1, '客厅', 'single', 'ONE single continuous image (no grid).', 'scene_single.png')
  `).run();

  const singleResult = await imageService.getCleanSingleSceneRef(tmpDir, 'scene_single.png', 2, db, log);
  assert.equal(singleResult, 'scene_single.png', 'single scene is not cropped');
});

test('processImageGeneration automatically provides clean establishing shot for 2x2 quad-grid scenes in storyboards', async (t) => {
  const db = makeDb(t);
  const sharp = require('sharp');

  const storageRoot = config.loadConfig().storage.local_path;
  const sceneQuadRel = 'scene_desk_quad.png';
  const sceneQuadAbs = path.join(storageRoot, sceneQuadRel);

  await sharp({
    create: { width: 1792, height: 1024, channels: 3, background: { r: 120, g: 160, b: 200 } }
  }).png().toFile(sceneQuadAbs);

  db.prepare("INSERT INTO dramas (id, title) VALUES (1, '测试剧')").run();
  db.prepare("INSERT INTO episodes (id, drama_id, episode_number, title) VALUES (1, 1, 1, '第1集')").run();

  db.prepare("INSERT INTO characters (id, drama_id, name, local_path) VALUES (10, 1, '奕辰', 'char_10.png')").run();
  db.prepare(`
    INSERT INTO scenes (id, drama_id, location, reference_image_mode, polished_prompt, local_path)
    VALUES (101, 1, '奕辰房间·书桌区', 'quad_grid', 'ONE image: 2×2 grid. TL=establishing wide.', ?)
  `).run(sceneQuadRel);

  db.prepare(`
    INSERT INTO storyboards (id, episode_id, storyboard_number, scene_id, characters, action, image_prompt)
    VALUES (504, 1, 5, 101, '[10]', '奕馨抱着练习册站在门口，看向奕辰。', '中景平视正面构图，傍晚暖黄灯光')
  `).run();

  db.prepare(`
    INSERT INTO image_generations (id, storyboard_id, drama_id, episode_id, prompt, status, frame_type)
    VALUES (904, 504, 1, 1, '中景平视正面构图，傍晚暖黄灯光', 'pending', null)
  `).run();

  let capturedOpts = null;
  t.mock.method(imageClient, 'callImageApi', async (_db, _log, opts) => {
    capturedOpts = opts;
    return { image_url: 'data:image/png;base64,ZmFrZQ==' };
  });

  await imageService.processImageGeneration(db, log, 904);

  assert.ok(capturedOpts, 'callImageApi was called');
  // Must contain scene establishing crop instead of raw quad grid!
  const hasEstablishingCrop = capturedOpts.reference_image_urls.some(ref => ref.includes('scene_desk_quad_establishing_crop.png'));
  assert.ok(hasEstablishingCrop, 'reference_image_urls contains establishing wide shot crop: ' + JSON.stringify(capturedOpts.reference_image_urls));
  const hasRawQuad = capturedOpts.reference_image_urls.some(ref => ref === sceneQuadRel);
  assert.ok(!hasRawQuad, 'raw 2x2 quad grid scene was replaced');
});
