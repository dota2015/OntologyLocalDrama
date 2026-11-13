const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { getStoryboardsForEpisode } = require('../src/services/episodeStoryboardService');

test('episode list returns saved director slots for Ref2VA without storyboard frames', t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE storyboards (
    id INTEGER PRIMARY KEY, episode_id INTEGER, storyboard_number INTEGER,
    semantic_slots TEXT, video_slots TEXT, creation_mode TEXT, deleted_at TEXT
  )`);
  const semantic = {
    h3_mode: 'ref2va', first_frame_policy: 'none', last_frame_policy: 'none',
    visible_characters: [{ id: 17, name: '蜂医' }],
    speech_plan: { text: '' },
  };
  const video = { audio_lip_sync: { dialogue_content: '' } };
  db.prepare('INSERT INTO storyboards VALUES (1,17,1,?,?,?,NULL)')
    .run(JSON.stringify(semantic), JSON.stringify(video), 'universal');
  const before = db.prepare('SELECT * FROM storyboards').all();
  const [shot] = getStoryboardsForEpisode(db, 17);
  assert.deepEqual(shot.semantic_slots, semantic);
  assert.deepEqual(shot.video_slots, video);
  assert.equal(shot.creation_mode, 'universal');
  assert.equal(shot.composed_image, undefined);
  assert.deepEqual(db.prepare('SELECT * FROM storyboards').all(), before);
});

test('episode list leaves missing or invalid director slots unavailable', t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE storyboards (
    id INTEGER PRIMARY KEY, episode_id INTEGER, storyboard_number INTEGER,
    semantic_slots TEXT, deleted_at TEXT
  );
  INSERT INTO storyboards VALUES (1,17,1,NULL,NULL), (2,17,2,'invalid',NULL)`);
  assert.deepEqual(getStoryboardsForEpisode(db, 17).map(s => s.semantic_slots), [null, null]);
});

test('episode list resolves character IDs from semantic_slots and returns prop_ids', t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE episodes (id INTEGER PRIMARY KEY, drama_id INTEGER);
    CREATE TABLE characters (id INTEGER PRIMARY KEY, drama_id INTEGER, name TEXT, deleted_at TEXT);
    CREATE TABLE storyboard_props (id INTEGER PRIMARY KEY, storyboard_id INTEGER, prop_id INTEGER);
    CREATE TABLE storyboards (
      id INTEGER PRIMARY KEY, episode_id INTEGER, storyboard_number INTEGER,
      characters TEXT, semantic_slots TEXT, deleted_at TEXT
    );
    INSERT INTO episodes VALUES (17, 5);
    INSERT INTO characters VALUES (26, 5, '蜂医', NULL);
    INSERT INTO storyboard_props (storyboard_id, prop_id) VALUES (1, 37);
  `);

  // Case 1: legacy characters is ["蜂医"] (string name), semantic_slots has id 26
  const semantic = {
    visible_characters: [{ id: 26, name: '蜂医' }],
    required_references: [{ type: 'prop', id: 37, name: '电脑' }],
  };
  db.prepare('INSERT INTO storyboards VALUES (1, 17, 1, ?, ?, NULL)')
    .run(JSON.stringify(['蜂医']), JSON.stringify(semantic));

  const [shot] = getStoryboardsForEpisode(db, 17);
  assert.deepEqual(shot.characters, [26], 'Characters should resolve to [26]');
  assert.deepEqual(shot.prop_ids, [37], 'Prop IDs should contain [37]');
});
