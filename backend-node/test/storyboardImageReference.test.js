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
  assert.match(capturedOpts.prompt, /The frame contains exactly 1 person: 奕辰/);
  assert.doesNotMatch(capturedOpts.prompt, /<image\d+>/i, 'business prompt must not inject pipeline visual tokens');
  assert.doesNotMatch(capturedOpts.prompt, /ZERO\s+clones|clone|克隆分身/i, 'positive prompt must not contain anti-clone concepts');

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

test('getCleanSingleCharacterRef preserves full multi-angle character sheet without destructive cropping', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-char-sheet-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const sheetPath = path.join(tmpDir, 'char_sheet.png');
  fs.writeFileSync(sheetPath, 'fake-sheet');

  const portraitPath = path.join(tmpDir, 'portrait.png');
  fs.writeFileSync(portraitPath, 'fake-portrait');

  // Multi-angle sheet preserved without cropping
  const sheetResult = await imageService.getCleanSingleCharacterRef(tmpDir, sheetPath, log);
  assert.equal(sheetResult, sheetPath, 'multi-angle character sheet is preserved intact');

  // Portrait image preserved without cropping
  const portraitResult = await imageService.getCleanSingleCharacterRef(tmpDir, portraitPath, log);
  assert.equal(portraitResult, portraitPath, 'portrait is preserved intact');

  // Legacy _front_crop path is normalized back to original
  const legacyCrop = path.join(tmpDir, 'char_sheet_front_crop.png');
  const normalized = await imageService.getCleanSingleCharacterRef(tmpDir, legacyCrop, log);
  assert.equal(normalized, sheetPath, 'legacy crop is normalized back to original sheet');
});

test('processImageGeneration provides full multi-angle reference for characters without destructive cropping', async (t) => {
  const db = makeDb(t);

  // Find the temp storage path configured in makeDb
  const storageRoot = config.loadConfig().storage.local_path;
  const sheetRelPath = 'char_yichen_sheet.png';
  const sheetAbsPath = path.join(storageRoot, sheetRelPath);
  fs.writeFileSync(sheetAbsPath, 'fake-yichen-sheet');

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
  // Must preserve the full multi-angle sheet
  const hasRawSheet = capturedOpts.reference_image_urls.some(ref => ref === sheetRelPath);
  assert.ok(hasRawSheet, 'reference_image_urls contains the full multi-angle sheet: ' + JSON.stringify(capturedOpts.reference_image_urls));
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

test('Director-owned image execution preserves manual text and all cast references without a rewrite', async t => {
  const db = makeDb(t);
  db.exec(`INSERT INTO dramas(id,title) VALUES(1,'测试'); INSERT INTO episodes(id,drama_id,episode_number) VALUES(1,1,1);
    INSERT INTO characters(id,drama_id,name,local_path) VALUES(10,1,'奕辰','boy.png'),(20,1,'丽霞','mother.png');
    INSERT INTO storyboards(id,episode_id,storyboard_number,characters,semantic_slots) VALUES(501,1,1,'[10,20]','{"visible_characters":[{"id":10},{"id":20}],"background_characters":[]}');
    INSERT INTO image_generations(id,storyboard_id,drama_id,prompt,status,frame_type) VALUES(901,501,1,'人工编辑：奕辰看向右侧的妈妈，妈妈安静倾听。','pending','first');`);
  t.mock.method(require('../src/services/aiClient'), 'generateText', async () => { throw new Error('unexpected rewrite'); });
  let sent;
  t.mock.method(imageClient, 'callImageApi', async (_db,_log,opts) => { sent = opts; return { error: 'controlled API failure' }; });
  await imageService.processImageGeneration(db, log, 901);
  assert.ok(sent);
  assert.equal(sent.prompt, '人工编辑：奕辰看向右侧的妈妈，妈妈安静倾听。');
  assert.deepEqual(sent.reference_image_urls, ['boy.png','mother.png']);
  assert.deepEqual(sent.input_references.map(r=>r.asset_id), [10,20]);
  assert.equal(db.prepare('SELECT error_msg FROM image_generations WHERE id=901').get().error_msg,'controlled API failure');
});

test('Director references reject missing people and overflow instead of silently trimming', t => {
  const db = makeDb(t);
  db.exec(`INSERT INTO dramas(id,title) VALUES(1,'测试'); INSERT INTO characters(id,drama_id,name,local_path) VALUES(10,1,'甲','a.png'),(20,1,'乙','b.png');`);
  const plan = require('../src/services/storyboardImagePlan');
  const shot = { id: 501, semantic_slots: { visible_characters: [{ id:10 },{ id:20 }] } };
  assert.throws(() => plan.resolveReferences(db,shot,{},[],{ total:1,maxCharacters:1,maxObjects:1 }), /超出/);
  db.prepare('UPDATE characters SET local_path=NULL WHERE id=20').run();
  assert.throws(() => plan.resolveReferences(db,shot,{},[],{ total:4,maxCharacters:3,maxObjects:4 }), /缺少图片/);
});
