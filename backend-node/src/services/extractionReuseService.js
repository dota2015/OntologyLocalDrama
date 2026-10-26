// Keep model-selected references scoped to the current drama. Never infer identity
// from a partial name: nicknames must be resolved by the model using this catalog.
const kinds = {
  character: { table: 'characters', library: 'character_libraries', source: 'character' },
  prop: { table: 'props', library: 'prop_libraries', source: 'prop' },
  scene: { table: 'scenes', library: 'scene_libraries', source: 'scene', nameKey: 'location' },
};

function catalog(db, dramaId, kind) {
  const spec = kinds[kind];
  if (!spec) throw new Error('Unknown extraction resource');
  const rows = table => db.prepare(`SELECT * FROM ${table} WHERE drama_id = ? AND deleted_at IS NULL ORDER BY id`).all(Number(dramaId));
  return { ...spec, resources: rows(spec.table), library: rows(spec.library) };
}

function promptContext(items) {
  const describe = row => Object.fromEntries(['name', 'location', 'time', 'prompt', 'role', 'type', 'description', 'appearance', 'category', 'tags']
    .filter(key => row[key]).map(key => [key, String(row[key]).slice(0, 400)]));
  return '\n\n[Existing resources in THIS drama / 本剧已有资源]\n' + JSON.stringify({
    resources: items.resources.map(row => ({ existing_id: row.id, ...describe(row) })),
    library: items.library.map(row => ({ library_id: row.id, ...describe(row) })),
  });
}

function instructions(kind) {
  if (kind === 'scene') return `\n\n[Scene reuse — highest priority / 本剧场景复用]
Compare every location in the script with the supplied existing scenes and THIS drama's scene library before creating a scene. Identify the same physical space by story context, owner, room layout and descriptions, even when its name changes. For example, 家中书桌所在的学习空间 may be 王奕宸房间·书桌区 when this is the same child's desk at home.
For a reused scene return its exact canonical location and existing_id, or library_id when available only in this drama's library. Copy the supplied IDs exactly and use only one reference field. Return only scenes actually appearing in this script, once each.
Reuse the established architecture, furniture, materials, visual style and reference images. A project genre such as science fiction does not justify redesigning an established ordinary bedroom as a futuristic room. Changes in time of day, lighting, temporary props, camera angle or action do not create a new physical scene; put those in the shots. Do not merge different owners' rooms, distinct areas, or spaces explicitly rebuilt in the story merely because names are similar.
For genuinely new places omit both IDs and return the usual location, time and prompt fields. Preserve existing scenes instead of writing replacement descriptions for them.`;
  return `\n\n[Resource reuse — highest priority / 本剧资源复用]
Before extracting ${kind}s, compare the script with the supplied existing resources and drama library. Extract only resources actually present in this script, not every catalog entry.
Identify the same person/object using story context, nicknames, short names and descriptions. If it already exists, use its exact canonical name and existing_id. For example, 奕宸 may refer to 王奕宸 when the context confirms the same character. Do not create another character just because the surname is omitted.
If it exists only in the drama library, use its exact name and library_id. Prefer existing_id when an existing resource is available. These IDs are optional EXTRA fields on each object in the required JSON array. Copy IDs exactly from the supplied catalog; never invent an ID. Use only one reference field.
For reused resources return just {"name":"canonical name","existing_id":123} or {"name":"canonical name","library_id":456}; preserve their established appearance, images and voice. Return each resource once.
For genuinely new resources omit both reference fields and provide the usual descriptive fields. Similar names alone do not prove identity; do not merge distinct people, owners' objects or visibly different variants. Do not treat people/creatures as props or objects as characters unless the script explicitly personifies them.`;
}

function resolve(items, item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('提取结果包含无效资源');
  const supplied = key => item[key] !== undefined && item[key] !== null && item[key] !== '';
  if (supplied('existing_id') && supplied('library_id')) throw new Error('同一资源不能同时指定 existing_id 和 library_id');
  const get = (rows, key) => {
    if (typeof item[key] === 'boolean' || !Number.isSafeInteger(Number(item[key])) || Number(item[key]) <= 0) throw new Error('资源复用 ID 无效');
    const row = rows.find(row => row.id === Number(item[key]));
    if (!row) throw new Error('复用资源不存在或不属于当前剧，请重新提取');
    return row;
  };
  let library;
  if (supplied('existing_id')) return { existing: get(items.resources, 'existing_id') };
  if (supplied('library_id')) library = get(items.library, 'library_id');
  const nameKey = items.nameKey || 'name';
  const rowName = row => String(row[nameKey] || '').trim();
  const name = typeof item[nameKey] === 'string' ? item[nameKey].trim() : '';
  if (!name && !library) throw new Error('提取资源缺少名称');
  if (!library) {
    const matches = items.resources.filter(row => rowName(row) === name);
    if (matches.length > 1) throw new Error('本剧有多个同名资源，请指定 existing_id');
    if (matches.length === 1) return { existing: matches[0] };
    const libraries = items.library.filter(row => rowName(row) === name);
    if (libraries.length > 1) throw new Error('本剧库有多个同名资源，请指定 library_id');
    library = libraries[0];
  }
  if (library) {
    const source = library.source_type === items.source
      ? items.resources.find(row => row.id === Number(library.source_id)) : null;
    const sameName = items.resources.filter(row => rowName(row) === rowName(library));
    if (source) return { existing: source };
    if (sameName.length > 1) throw new Error('本剧有多个同名资源，请指定 existing_id');
    if (sameName.length === 1) return { existing: sameName[0] };
    return { library };
  }
  return { fresh: { ...item, [nameKey]: name } };
}

module.exports = { catalog, promptContext, instructions, resolve };
