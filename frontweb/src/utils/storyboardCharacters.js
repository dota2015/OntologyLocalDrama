// Resolve by identity, never by display name. Missing records remain visible.
export function resolveStoryboardCharacters(ids, episodeCharacters = [], dramaCharacters = []) {
  const catalog = new Map([...dramaCharacters, ...episodeCharacters].map(c => [Number(c.id), c]))
  return (ids || []).map(id => catalog.get(Number(id)) || {
    id: Number(id), name: `人物 ID ${id} 无法解析，请检查人物关联`, missing: true,
  })
}
