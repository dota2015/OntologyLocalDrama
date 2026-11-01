const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { compileDramaSemanticPackage } = require('../ontology/semanticPackage');

const VERSION = 1;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS director_checkpoints (
    task_id TEXT PRIMARY KEY, episode_id INTEGER NOT NULL, version INTEGER NOT NULL,
    options_json TEXT NOT NULL, fingerprint_json TEXT NOT NULL, state_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
}
function read(db, taskId) {
  ensureTable(db);
  const row = db.prepare('SELECT * FROM director_checkpoints WHERE task_id=?').get(taskId);
  return row ? { ...row, options: JSON.parse(row.options_json), fingerprint: JSON.parse(row.fingerprint_json), state: JSON.parse(row.state_json) } : null;
}
function cleanOptions(options) {
  const keys = ['storyboardCount', 'storyboard_count', 'videoDuration', 'video_duration', 'shot_duration_range',
    'universal_omni_storyboard', 'universalOmniStoryboard', 'userDirectives', 'directives', 'feedback',
    'maxReflectionRounds', 'max_reflection_rounds'];
  return Object.fromEntries(keys.filter(k => options[k] !== undefined).map(k => [k, options[k]]));
}
function fingerprint(db, episodeId, cfg) {
  const pkg = compileDramaSemanticPackage(db, episodeId);
  const metadata = db.prepare('SELECT metadata FROM dramas WHERE id=?').get(pkg.drama.id)?.metadata;
  const configs = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_service_configs'").get()
    ? db.prepare('SELECT * FROM ai_service_configs ORDER BY id').all().map(({ api_key, created_at, updated_at, ...r }) => r) : [];
  const codeFiles = fs.readdirSync(path.join(__dirname, '../ontology'), { recursive: true })
    .filter(f => f.endsWith('.js')).sort().map(f => fs.readFileSync(path.join(__dirname, '../ontology', f), 'utf8'));
  for (const name of ['agentsRuntime.js', 'narrativeStyleService.js', 'promptI18n.js']) codeFiles.push(fs.readFileSync(path.join(__dirname, name), 'utf8'));
  return {
    script: hash({ ...pkg.episode, duration_target: undefined }),
    assets: hash(pkg.catalogs), settings: hash({ drama: pkg.drama, metadata, cfg, configs }),
    published: hash(db.prepare('SELECT * FROM storyboards WHERE episode_id=? AND deleted_at IS NULL ORDER BY id').all(episodeId)),
    rules: hash(codeFiles),
  };
}
function assertCompatible(saved, current) {
  const labels = { script: '剧本', assets: '角色/场景/道具', settings: '生成配置', published: '已发布分镜', rules: '导演规则或提示词版本' };
  const changed = Object.keys(current).filter(k => saved[k] !== current[k]);
  if (changed.length) throw new Error(`无法继续旧任务：${changed.map(k => labels[k]).join('、')}已变化。检查点已保留，请选择重新生成，避免混用不同版本的数据。`);
}
function requireResume(db, taskId, episodeId, cfg) {
  const task = db.prepare('SELECT * FROM async_tasks WHERE id=? AND deleted_at IS NULL').get(taskId);
  if (!task || task.type !== 'director_storyboard_generation' || String(task.resource_id) !== String(episodeId) || task.status !== 'failed') {
    throw new Error('只能继续当前集已失败或中断的导演任务');
  }
  const saved = read(db, taskId);
  if (!saved) throw new Error('此旧任务没有断点记录，无法直接续跑；请重新生成，新任务将自动保存断点');
  if (saved.version !== VERSION || saved.episode_id !== Number(episodeId)) throw new Error('检查点版本或剧集不匹配，请重新生成');
  if (saved.state.published) throw new Error('此任务分镜已经发布，请刷新页面，不能重复发布');
  assertCompatible(saved.fingerprint, fingerprint(db, episodeId, cfg));
  return saved;
}
function open(db, taskId, episodeId, cfg, options, resumeId) {
  if (!taskId) return { state: {}, save() {}, assertCurrent() {} };
  ensureTable(db);
  const saved = resumeId ? requireResume(db, resumeId, episodeId, cfg) : null;
  const initial = saved?.fingerprint || fingerprint(db, episodeId, cfg);
  const state = saved ? structuredClone(saved.state) : {};
  if (resumeId) state.resumed_from = resumeId;
  const assertActive = () => {
    const row = db.prepare('SELECT status FROM async_tasks WHERE id=?').get(taskId);
    if (!row || !['pending', 'processing'].includes(row.status)) throw new Error('导演任务已停止，已保存断点，不再提交生成结果');
  };
  const save = () => {
    assertActive();
    db.prepare(`INSERT INTO director_checkpoints VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(task_id) DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at`)
      .run(taskId, Number(episodeId), VERSION, JSON.stringify(cleanOptions(options)), JSON.stringify(initial), JSON.stringify(state), new Date().toISOString());
  };
  save();
  return { state, save, assertCurrent() { assertActive(); assertCompatible(initial, fingerprint(db, episodeId, cfg)); } };
}
function summary(db, taskId) {
  ensureTable(db);
  const s = db.prepare(`SELECT json_extract(state_json,'$.published') AS published,
    json_extract(state_json,'$.stage') AS stage, json_extract(state_json,'$.nextBatch') AS completed_batches,
    json_array_length(state_json,'$.shots') AS completed_shots,
    json_extract(state_json,'$.resumed_from') AS resumed_from,
    json_extract(state_json,'$.currentShot') AS current_shot,
    json_extract(state_json,'$.reflectionRound') AS reflection_round FROM director_checkpoints WHERE task_id=?`).get(taskId);
  return s ? { ...s, published: undefined, available: !s.published, completed_shots: s.completed_shots || 0, stage: s.stage || '准备' } : null;
}
module.exports = { read, open, summary, requireResume, fingerprint, assertCompatible, cleanOptions };
