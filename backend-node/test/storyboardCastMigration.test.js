const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { createStoryboard } = require('../src/services/storyboardService');
const { loadStoryboardCharacterNames } = require('../src/services/framePromptService');

function setup(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  t.mock.method(console, 'log', () => {});
  runMigrationsAndEnsure(db);
  db.exec(`INSERT INTO dramas(id,title) VALUES(1,'项目'),(2,'其他项目');
    INSERT INTO episodes(id,drama_id,episode_number) VALUES(1,1,1);
    INSERT INTO characters(id,drama_id,name) VALUES(8,1,'本剧人物'),(9,2,'其他人物');
    INSERT INTO character_libraries(id,name) VALUES(8,'素材人物');`);
  return db;
}

test('startup rebuilds cast links once and preserves explicit decisions, including empty props', t => {
  const db = setup(t);
  db.exec(`DROP INDEX storyboard_cast_unique;
    DELETE FROM data_migrations;
    INSERT INTO storyboards(id,episode_id,storyboard_number,characters,semantic_slots,action)
    VALUES(5,1,1,'[8]','{"visible_characters":[8],"required_references":[]}', '茶杯没带来');
    INSERT INTO storyboards(id,episode_id,storyboard_number,characters,deleted_at)
    VALUES(6,1,2,'["归档角色"]','2026-01-01');
    INSERT INTO storyboard_characters(storyboard_id,character_id) VALUES(6,9),(6,9);
    INSERT INTO props(id,drama_id,name) VALUES(1,1,'茶杯');
    INSERT INTO storyboard_characters(storyboard_id,character_id) VALUES(5,8),(5,8),(5,9),(1000,8);`);
  const before = db.prepare('SELECT * FROM storyboards WHERE id=5').get();
  runMigrationsAndEnsure(db);
  const links = () => db.prepare('SELECT * FROM storyboard_characters').all();
  const first = links();
  assert.deepEqual(first.map(l => [l.storyboard_id, l.character_id]), [[6,9],[5,8]]);
  assert.deepEqual(loadStoryboardCharacterNames(db, 5), ['本剧人物']);
  runMigrationsAndEnsure(db);
  assert.deepEqual(links(), first);
  assert.deepEqual(db.prepare('SELECT * FROM storyboards WHERE id=5').get(), before);
  assert.deepEqual(db.prepare('SELECT * FROM storyboard_props').all(), []);
});

test('manual creation saves the cast atomically and rejects a foreign project character', t => {
  const db = setup(t);
  const log = {info() {}};
  const shot = createStoryboard(db, log, {episode_id:1, storyboard_number:1, character_ids:[8]});
  assert.equal(db.prepare('SELECT characters FROM storyboards WHERE id=?').pluck().get(shot.id), '[8]');
  assert.deepEqual(db.prepare('SELECT character_id FROM storyboard_characters WHERE storyboard_id=?').pluck().all(shot.id), [8]);
  assert.throws(() => createStoryboard(db, log, {episode_id:1, storyboard_number:2, characters:[8,9]}), /人物 ID 9/);
  assert.equal(db.prepare('SELECT count(*) FROM storyboards').pluck().get(), 1);
  assert.deepEqual(db.prepare('SELECT character_id FROM episode_characters').pluck().all(), [8]);
});
