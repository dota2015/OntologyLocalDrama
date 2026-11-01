// Capture at the provider POST boundary, never rebuild history from current slots.
const { createHash } = require('crypto');

const sha256 = value => createHash('sha256').update(value).digest('hex');

function media(source, buffer) {
  const value = String(source || '');
  if (!buffer && value.startsWith('data:')) {
    const comma = value.indexOf(',');
    buffer = /;base64/i.test(value.slice(0, comma))
      ? Buffer.from(value.slice(comma + 1), 'base64')
      : Buffer.from(decodeURIComponent(value.slice(comma + 1)));
  }
  let uri = value;
  if (value.startsWith('data:')) uri = '[inline media omitted]';
  else if (/^https?:/i.test(value)) {
    const url = new URL(value);
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    uri = url.toString();
  }
  return {
    source: uri,
    content_sha256: buffer ? sha256(buffer) : null,
    bytes: buffer ? buffer.length : null,
    // A URL is not a content digest. Remote providers may fetch mutable URLs later.
    digest_basis: buffer ? 'submitted_bytes' : 'content_not_available',
  };
}

function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/^(?:api_?key|authorization|password|token|secret|headers)$/i.test(key))
      .map(([key, item]) => [key, sanitize(item)]));
  }
  if (typeof value === 'string' && /^(?:data:|https?:)/i.test(value)) return media(value).source;
  return value;
}

function storyboardVersion(shot) {
  if (!shot) return null;
  let semantic = shot.semantic_slots;
  if (typeof semantic === 'string') { try { semantic = JSON.parse(semantic); } catch (_) {} }
  return {
    id: shot.id,
    updated_at: shot.updated_at || null,
    revision: shot.semantic_revision || semantic?.semantic_revision || null,
    // Includes manual edits even when there is no persisted Director revision.
    content_sha256: sha256(JSON.stringify(shot)),
  };
}

function read(row) {
  if (!row?.input_snapshot) return null;
  return JSON.parse(row.input_snapshot);
}

function record(db, kind, id, input) {
  if (!db || !id) return; // Direct diagnostic calls need not have a generation row.
  const table = kind === 'image' ? 'image_generations' : kind === 'video' ? 'video_generations' : null;
  if (!table) throw new Error('Unknown generation input kind');
  return db.transaction(() => {
    const row = db.prepare(`SELECT input_snapshot FROM ${table} WHERE id=?`).get(id);
    if (!row) throw new Error('生成记录不存在，未提交模型');
    const history = read(row) || { version: 1, attempts: [] };
    const attemptIndex = history.attempts.length;
    history.attempts.push(sanitize({
      ...input,
      recorded_at: new Date().toISOString(),
      boundary: 'provider_submission',
      // This records the attempted request even when the network/provider fails.
      status_note: '提交时输入；执行结果以生成记录状态为准',
    }));
    db.prepare(`UPDATE ${table} SET input_snapshot=? WHERE id=?`).run(JSON.stringify(history), id);
    return attemptIndex;
  })();
}

function attachExecution(db, id, attemptIndex, execution) {
  db.transaction(() => {
    const row = db.prepare('SELECT input_snapshot FROM video_generations WHERE id=?').get(id);
    const history = read(row);
    if (!history?.attempts?.[attemptIndex]) throw new Error('提交快照不存在');
    history.attempts[attemptIndex].execution = sanitize(execution);
    db.prepare('UPDATE video_generations SET input_snapshot=? WHERE id=?').run(JSON.stringify(history), id);
  })();
}

module.exports = { sha256, media, sanitize, storyboardVersion, read, record, attachExecution };
