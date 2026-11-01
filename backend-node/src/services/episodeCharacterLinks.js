// Persist an already accepted cast decision. Never infer identity from a name.
function list(value) {
  if (value == null || value === '') return [];
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) throw new Error('人物关联必须是数组');
  return parsed;
}

function shotCharacterIds(shot) {
  return [...new Set([...list(shot.characters), ...list(shot.background_characters)].map(item => {
    const id = Number(item && typeof item === 'object' ? (item.character_id ?? item.id) : item);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('人物关联包含无效 ID');
    return id;
  }))];
}

function linkEpisodeCharacters(db, episodeId, shots) {
  return db.transaction(() => {
    const episode = db.prepare('SELECT drama_id FROM episodes WHERE id=? AND deleted_at IS NULL').get(Number(episodeId));
    if (!episode) throw new Error('人物关联对应的剧集不存在');
    const ids = [...new Set(shots.flatMap(shotCharacterIds))];
    const find = db.prepare('SELECT id FROM characters WHERE id=? AND drama_id=? AND deleted_at IS NULL');
    // Validate the complete set before writing; cross-project/deleted IDs never disappear silently.
    for (const id of ids) {
      if (!find.get(id, episode.drama_id)) throw new Error(`人物 ID ${id} 不存在、已删除或不属于当前剧目，请修正人物选择`);
    }
    const insert = db.prepare('INSERT OR IGNORE INTO episode_characters (episode_id,character_id) VALUES (?,?)');
    let added = 0;
    for (const id of ids) added += insert.run(Number(episodeId), id).changes;
    return { ids, added };
  })();
}

module.exports = { shotCharacterIds, linkEpisodeCharacters };
