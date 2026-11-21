// Rebuild the derived links once from the stored project cast. A link alone
// cannot distinguish an old library ID from a project character with that ID.
module.exports = function migrateStoryboardCast(db) {
  db.transaction(() => {
    db.exec('CREATE TABLE IF NOT EXISTS data_migrations (name TEXT PRIMARY KEY)');
    const name = 'storyboard-project-character-ids-v1';
    if (db.prepare('SELECT 1 FROM data_migrations WHERE name=?').get(name)) return;
    db.exec('DELETE FROM storyboard_characters WHERE NOT EXISTS (SELECT 1 FROM storyboards s WHERE s.id=storyboard_id)');
    // Archived shots can contain names from the original schema. Preserve their
    // stored IDs and first link, without resolving any name to a current actor.
    db.exec(`DELETE FROM storyboard_characters
      WHERE storyboard_id IN (SELECT id FROM storyboards WHERE deleted_at IS NOT NULL)
        AND id NOT IN (SELECT min(id) FROM storyboard_characters GROUP BY storyboard_id,character_id)`);
    const rows = db.prepare('SELECT id,characters,semantic_slots FROM storyboards WHERE deleted_at IS NULL').all();
    const hasLink = db.prepare('SELECT 1 FROM storyboard_characters WHERE storyboard_id=?');
    const remove = db.prepare('DELETE FROM storyboard_characters WHERE storyboard_id=?');
    const insert = db.prepare('INSERT INTO storyboard_characters(storyboard_id,character_id) VALUES(?,?)');
    for (const row of rows) {
      const cast = JSON.parse(row.characters || 'null') ?? JSON.parse(row.semantic_slots || 'null')?.visible_characters;
      if (cast == null && !hasLink.get(row.id)) continue;
      if (!Array.isArray(cast)) throw new Error(`分镜 ${row.id} 缺少明确的人物清单，请核对后迁移`);
      remove.run(row.id);
      for (const id of new Set(cast.map(c => Number(c?.id ?? c?.character_id ?? c)))) {
        if (!Number.isSafeInteger(id) || id < 1) throw new Error(`分镜 ${row.id} 的人物 ID 无效，请核对后迁移`);
        insert.run(row.id, id);
      }
    }
    db.exec('CREATE UNIQUE INDEX storyboard_cast_unique ON storyboard_characters(storyboard_id,character_id)');
    db.prepare('INSERT INTO data_migrations(name) VALUES(?)').run(name);
  }).immediate();
};
