function link(db, dramaId, episodeId, sceneId) {
  const episode = db.prepare('SELECT id FROM episodes WHERE id=? AND drama_id=? AND deleted_at IS NULL').get(Number(episodeId), Number(dramaId));
  const scene = db.prepare('SELECT id FROM scenes WHERE id=? AND drama_id=? AND deleted_at IS NULL').get(Number(sceneId), Number(dramaId));
  if (!episode || !scene) throw new Error('场景或分集不属于当前剧，无法复用');
  db.prepare('INSERT OR IGNORE INTO episode_scenes (episode_id,scene_id) VALUES (?,?)').run(Number(episodeId), Number(sceneId));
}

function list(db, dramaId, episodeId) {
  return db.prepare(`SELECT s.* FROM scenes s WHERE s.drama_id=? AND s.deleted_at IS NULL AND
    (s.episode_id=? OR s.id IN (SELECT scene_id FROM episode_scenes WHERE episode_id=?)
      OR s.id IN (SELECT scene_id FROM storyboards WHERE episode_id=? AND deleted_at IS NULL)) ORDER BY s.id`)
    .all(Number(dramaId), Number(episodeId), Number(episodeId), Number(episodeId));
}

module.exports = { link, list };
