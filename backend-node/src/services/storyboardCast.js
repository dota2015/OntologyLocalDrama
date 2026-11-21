const { shotCharacterIds } = require('./episodeCharacterLinks');

function storyboardCharacterIds(db, shot) {
  if (!shot) return [];
  if (shot.characters != null) return shotCharacterIds({ characters: shot.characters });
  return db.prepare('SELECT character_id FROM storyboard_characters WHERE storyboard_id=? ORDER BY id').pluck().all(shot.id);
}

// Called inside the transaction that publishes/updates the storyboard row.
function replaceStoryboardCast(db, storyboardId, ids) {
  db.prepare('DELETE FROM storyboard_characters WHERE storyboard_id=?').run(storyboardId);
  const insert = db.prepare('INSERT INTO storyboard_characters(storyboard_id,character_id,created_at) VALUES(?,?,?)');
  const now = new Date().toISOString();
  for (const id of new Set(ids)) insert.run(storyboardId, id, now);
}

module.exports = { replaceStoryboardCast, storyboardCharacterIds };
