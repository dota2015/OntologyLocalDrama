const fs = require('fs');
const path = require('path');
const wardrobe = require('./wardrobeService');

const characterReferenceTypes = new Set(['character', 'character_sheet', 'character_outfit', 'costume', 'wardrobe']);

function referenceCharacterId(ref) {
  if (!characterReferenceTypes.has(ref?.type || ref?.kind)) return null;
  const id = Number(ref.character_id ?? ref.id);
  if (!Number.isInteger(id) || id <= 0) throw new Error('H3 角色或服装参考图缺少有效角色 ID');
  return id;
}

function groupSubjects(pictures) {
  const groups = new Map();
  for (const picture of pictures) {
    const key = picture.character_id ? `character:${picture.character_id}` : picture.tag;
    if (!groups.has(key)) groups.set(key, { tag: `<Subject ${groups.size + 1}>`, characterId: picture.character_id, pictures: [] });
    groups.get(key).pictures.push(picture);
  }
  return [...groups.values()];
}

function localFile(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\') || relative.includes('\0')) throw new Error('H3 素材路径无效');
  const realRoot = fs.realpathSync(root);
  const file = fs.realpathSync(path.resolve(realRoot, relative));
  if (!file.startsWith(realRoot + path.sep) || !fs.statSync(file).isFile()) throw new Error('H3 素材路径无效');
  return file;
}
// Reconcile browser /static URLs with database-relative paths before assigning Picture indices.
function canonicalSource(root, source) {
  if (typeof source !== 'string') return '';
  source = source.trim();
  let relative = source;
  if (/^https?:\/\//i.test(source)) {
    try {
      const url = new URL(source);
      if (!url.pathname.startsWith('/static/')) return source;
      relative = decodeURIComponent(url.pathname.slice(8));
    } catch { return source; }
  } else relative = source.replace(/^\/static\//, '');
  if (root) {
    try { return path.relative(fs.realpathSync(root), localFile(root, relative)).split(path.sep).join('/'); }
    catch { /* Keep external URLs and report missing local files when preparing inputs. */ }
  }
  return /^https?:/i.test(source) ? source : relative;
}
function imageSource(entity) { return entity?.local_path || entity?.ref_image || entity?.image_url || ''; }

function referenceSource(db, dramaId, shot, ref, root) {
  const explicit = ref?.url || ref?.image_url || ref?.local_path || '';
  if (explicit) return canonicalSource(root, explicit);
  const type = ref?.type || 'character';
  const id = Number(ref?.id ?? ref?.character_id);
  let entity = null;
  if (['character', 'character_sheet'].includes(type) && id > 0) {
    entity = db.prepare('SELECT * FROM characters WHERE id=? AND drama_id=? AND deleted_at IS NULL').get(id, Number(dramaId));
  } else if (type === 'scene' && id > 0) {
    entity = db.prepare('SELECT * FROM scenes WHERE id=? AND drama_id=? AND deleted_at IS NULL').get(id, Number(dramaId));
  } else if (type === 'prop' && id > 0) {
    entity = db.prepare('SELECT * FROM props WHERE id=? AND drama_id=? AND deleted_at IS NULL').get(id, Number(dramaId));
  } else if (['costume', 'wardrobe', 'character_outfit'].includes(type)) {
    const characterId = Number(ref?.character_id ?? ref?.id);
    const state = wardrobe.getShot(db, shot.id).characters.find(c => Number(c.id) === characterId);
    if (!state) return '';
    if (ref?.stage_id && state.stage_id !== ref.stage_id) {
      const stage = state.stages?.find(s => s.id === ref.stage_id);
      return canonicalSource(root, stage?.reference_image || '');
    }
    return canonicalSource(root, state.reference_image || '');
  }
  return canonicalSource(root, imageSource(entity));
}

function resolveRequiredReference(db, dramaId, shot, ref, root) {
  const source = referenceSource(db, dramaId, shot, ref, root);
  if (!source) throw new Error(`H3 必要参考素材「${ref?.name || ref?.type || '素材'} #${ref?.id ?? ref?.character_id ?? '空'}」尚未生成或上传图片，或不属于当前项目`);
  return source;
}
function sourceVersion(root, source) {
  if (!source) return null;
  if (/^(https?:|data:)/i.test(source)) return require('node:crypto').createHash('sha256').update(source).digest('hex');
  const stat = fs.statSync(localFile(root, source));
  return [stat.size, stat.mtimeMs];
}

module.exports = { sourceVersion, referenceSource, referenceCharacterId, groupSubjects, resolveRequiredReference, localFile, canonicalSource, imageSource };
