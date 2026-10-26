// Keep the original episode_range/appearance format readable; IDs make shot selections stable.
function normalizeStages(value) {
  if (value == null || value === '') return [];
  let rows = value;
  if (typeof rows === 'string') {
    try { rows = JSON.parse(rows); } catch { throw new Error('多阶段造型必须是有效的 JSON 数组'); }
  }
  if (!Array.isArray(rows) || rows.length > 20) throw new Error('多阶段造型需为数组，最多20套');
  const ids = new Set();
  return rows.map((row, i) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('每套造型需填写名称和外观描述');
    const id = String(row.id || `legacy-${i + 1}`);
    const name = String(row.name || `造型${i + 1}`).trim();
    const appearance = typeof row.appearance === 'string' ? row.appearance.trim() : '';
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || ids.has(id)) throw new Error('造型编号无效或重复');
    if (!name || name.length > 80 || !appearance || appearance.length > 1500) throw new Error('造型需有名称（最多80字）和外观描述（最多1500字）');
    ids.add(id);
    const stage = { id, name, appearance };
    if (row.episode_range != null) {
      const range = row.episode_range;
      if (!Array.isArray(range) || range.length !== 2 || range.some(n => !Number.isInteger(n) || n < 1) || range[0] > range[1]) throw new Error('造型集数范围需为起止集数，例如 [1,3]');
      stage.episode_range = [...range];
    }
    if (row.reference_image) {
      if (typeof row.reference_image !== 'string' || row.reference_image.length > 2000 || /[\x00-\x1f\\]/.test(row.reference_image)) throw new Error('造型参考图地址无效');
      const reference = row.reference_image.trim();
      if (/^https?:\/\//i.test(reference)) {
        try { new URL(reference); } catch { throw new Error('造型参考图地址无效'); }
      } else if (reference.replace(/^\/static\//, '').startsWith('/') || reference.split('/').includes('..') || reference.includes(':')) throw new Error('造型参考图路径无效');
      stage.reference_image = reference;
    }
    return stage;
  });
}
function readStages(value) { try { return normalizeStages(value); } catch { return []; } }
function episodeStage(stages, number) {
  const matches = stages.filter(s => s.episode_range && s.episode_range[0] <= number && number <= s.episode_range[1]);
  return matches.length === 1 ? matches[0] : null;
}
module.exports = { normalizeStages, readStages, episodeStage };
