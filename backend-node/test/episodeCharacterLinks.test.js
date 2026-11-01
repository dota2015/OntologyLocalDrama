const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const migrate = require('../src/db/migrate');
const { linkEpisodeCharacters } = require('../src/services/episodeCharacterLinks');
const { compileDramaSemanticPackage } = require('../src/ontology/semanticPackage');
const dramaService = require('../src/services/dramaService');

function setup(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  migrate.runMigrationsAndEnsure(db);
  db.exec(`INSERT INTO dramas(id,title) VALUES(5,'三角洲'),(6,'其他剧');
    INSERT INTO episodes(id,drama_id,episode_number) VALUES(17,5,2);
    INSERT INTO characters(id,drama_id,name) VALUES(17,5,'蜂医'),(26,5,'蜂医'),(18,5,'露娜'),(99,6,'外剧人物');
    INSERT INTO episode_characters VALUES(17,26);
    INSERT INTO storyboards(id,episode_id,storyboard_number,characters) VALUES(620,17,1,'[17]');`);
  return db;
}

test('publication links exact primary and background IDs and page returns those records', t => {
  const db = setup(t);
  const shot = { characters: '[17]', background_characters: [{ character_id: 18 }] };
  assert.equal(linkEpisodeCharacters(db, 17, [shot]).added, 2);
  assert.equal(linkEpisodeCharacters(db, 17, [shot]).added, 0);
  const ep = dramaService.getDrama(db, 5).episodes[0];
  assert.deepEqual(ep.characters.map(c => c.id).sort((a,b) => a-b), [17,18,26]);
  assert.deepEqual(ep.storyboards[0].characters, [17]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM characters').get().n, 4);
  db.prepare('UPDATE characters SET local_path=? WHERE id=?').run('characters/17.png', 17);
  db.prepare('UPDATE characters SET local_path=? WHERE id=?').run('characters/26.png', 26);
  const refs = require('../src/services/h3NativeService').assetReferences(db, 5,
    db.prepare('SELECT * FROM storyboards WHERE id=620').get());
  assert.equal(refs[0].character_id, 17);
  assert.equal(refs[0].source, 'characters/17.png');
  assert.ok(!refs.some(r => r.character_id === 26));
});

test('invalid IDs reject atomically without substituting same-name characters', t => {
  const db = setup(t);
  for (const bad of [99, 999, 0]) {
    assert.throws(() => linkEpisodeCharacters(db, 17, [{ characters: [17,bad] }]));
    assert.deepEqual(db.prepare('SELECT character_id FROM episode_characters').all(), [{ character_id: 26 }]);
  }
  db.prepare('UPDATE characters SET deleted_at=? WHERE id=17').run('deleted');
  assert.throws(() => linkEpisodeCharacters(db, 17, [{ characters: [17] }]), /17/);
});

test('outer publication rollback also rolls back episode links', t => {
  const db = setup(t);
  assert.throws(() => db.transaction(() => {
    linkEpisodeCharacters(db, 17, [{ characters: [17] }]);
    throw new Error('publication failed');
  })());
  assert.deepEqual(db.prepare('SELECT character_id FROM episode_characters').all(), [{ character_id: 26 }]);
});

test('director catalog distinguishes episode cast from reusable same-name records', t => {
  const db = setup(t);
  const pkg = compileDramaSemanticPackage(db, 17);
  assert.match(pkg.getSystemDigest(), /ID:17 \[蜂医\] 【剧库可复用/);
  assert.match(pkg.getSystemDigest(), /ID:26 \[蜂医\] 【本集已关联】/);
  linkEpisodeCharacters(db, 17, [{ characters: [17] }]);
  assert.notEqual(compileDramaSemanticPackage(db, 17).semantic_revision, pkg.semantic_revision);
});
