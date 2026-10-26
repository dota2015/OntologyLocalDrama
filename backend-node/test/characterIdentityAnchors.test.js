const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentTestDb, seedTwoDramas } = require('./helpers/agentTestDb');
const dramaService = require('../src/services/dramaService');
const characterRoutes = require('../src/routes/characters');
const { enrichIdentityAnchors } = require('../src/services/characterGenerationService');
const aiClient = require('../src/services/aiClient');

const log = { info() {}, warn() {}, error() {} };

function makeDb(t) {
  const db = createAgentTestDb();
  t.after(() => db.close());
  db.exec(`
    ALTER TABLE characters ADD COLUMN identity_anchors TEXT;
    ALTER TABLE characters ADD COLUMN voice_style TEXT;
    ALTER TABLE characters ADD COLUMN polished_prompt TEXT;
    ALTER TABLE characters ADD COLUMN four_view_image_url TEXT;
    ALTER TABLE characters ADD COLUMN seedance2_voice_asset TEXT;
    CREATE TABLE props (id INTEGER, drama_id INTEGER, episode_id INTEGER, deleted_at TEXT);
    CREATE TABLE image_generations (character_id INTEGER, status TEXT, error_msg TEXT, created_at TEXT);
  `);
  seedTwoDramas(db);
  return db;
}

function response() {
  return {
    status() { return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

test('extracted anchors survive character save and all character reload paths', async (t) => {
  const db = makeDb(t);
  const anchors = {
    bone_structure: 'oval face', facial_features: 'narrow eyes',
    distinguishing_marks: 'left cheek mole',
    color_anchors: { hair: '#101010', eyes: '#302010' },
    skin_texture: 'fine lines', hair_style: 'short straight hair',
  };
  db.exec('ALTER TABLE characters ADD COLUMN color_palette TEXT');
  t.mock.method(aiClient, 'generateText', async () => JSON.stringify(anchors));
  await enrichIdentityAnchors(db, log, 1, '短发，有左脸痣');
  const saved = db.prepare('SELECT identity_anchors FROM characters WHERE id = 1').get().identity_anchors;
  assert.deepEqual(JSON.parse(saved), anchors);

  const routes = characterRoutes(db, {}, log);
  const res = response();
  routes.update({ params: { id: '1' }, body: { name: '甲角' } }, res);
  assert.equal(res.payload.success, true);

  const single = response();
  routes.getOne({ params: { id: '1' } }, single);
  const drama = dramaService.getDrama(db, 1);
  const reloaded = [
    single.payload.data.character,
    drama.characters.find((c) => c.id === 1),
    drama.episodes.find((e) => e.id === 11).characters.find((c) => c.id === 1),
    dramaService.getCharacters(db, 1).find((c) => c.id === 1),
    dramaService.getCharacters(db, 1, 11).find((c) => c.id === 1),
  ];
  for (const character of reloaded) {
    assert.equal(character.identity_anchors, saved, 'reload must include persisted anchors');
  }
});

test('characters without extracted anchors return null', (t) => {
  const db = makeDb(t);
  assert.equal(dramaService.getCharacters(db, 1)[0].identity_anchors, null);
});
