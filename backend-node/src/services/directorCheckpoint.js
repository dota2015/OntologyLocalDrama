const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { compileDramaSemanticPackage } = require('../ontology/semanticPackage');

const VERSION = 3;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS director_checkpoints (
    task_id TEXT PRIMARY KEY, episode_id INTEGER NOT NULL, version INTEGER NOT NULL,
    options_json TEXT NOT NULL, fingerprint_json TEXT NOT NULL, state_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS director_checkpoint_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL, stage TEXT, shot_number INTEGER, round INTEGER,
    event_type TEXT NOT NULL, payload_json TEXT, created_at TEXT NOT NULL
  )`);
}
function read(db, taskId) {
  ensureTable(db);
  const row = db.prepare('SELECT * FROM director_checkpoints WHERE task_id=?').get(taskId);
  return row ? { ...row, options: JSON.parse(row.options_json), fingerprint: JSON.parse(row.fingerprint_json), state: JSON.parse(row.state_json) } : null;
}
function cleanOptions(options) {
  const keys = ['existingShotsOnly', 'storyboardCount', 'storyboard_count', 'videoDuration', 'video_duration', 'shot_duration_range',
    'universal_omni_storyboard', 'universalOmniStoryboard', 'userDirectives', 'directives', 'feedback',
    'maxReflectionRounds', 'max_reflection_rounds'];
  return Object.fromEntries(keys.filter(k => options[k] !== undefined).map(k => [k, options[k]]));
}
function fingerprint(db, episodeId, cfg) {
  const pkg = compileDramaSemanticPackage(db, episodeId);
  const metadata = db.prepare('SELECT metadata FROM dramas WHERE id=?').get(pkg.drama.id)?.metadata;
  const meta = JSON.parse(metadata || '{}');
  const planning = {
    style: require('../utils/dramaStyleMerge').resolvedStreamStyleFromDrama('', { style: pkg.drama.style, metadata }),
    ratio: meta.aspect_ratio || cfg?.style?.default_video_ratio,
    range: meta.shot_duration_range,
    clipDuration: meta.video_clip_duration,
    narrative: meta.narrative_style,
    wardrobe: meta.wardrobe,
    speechSpeed: require('./speechDeliveryService').configuredTtsSpeed(db, meta),
  };
  const configs = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_service_configs'").get()
    ? db.prepare("SELECT * FROM ai_service_configs WHERE service_type IN ('text','tts') AND deleted_at IS NULL AND is_active=1 ORDER BY id").all().map(({ api_key, created_at, updated_at, ...r }) => r) : [];
  const codeFiles = fs.readdirSync(path.join(__dirname, '../ontology'), { recursive: true })
    .filter(f => f.endsWith('.js')).sort().map(f => fs.readFileSync(path.join(__dirname, '../ontology', f), 'utf8'));
  for (const name of ['agentsRuntime.js', 'narrativeStyleService.js', 'promptI18n.js']) codeFiles.push(fs.readFileSync(path.join(__dirname, name), 'utf8'));
  return {
    script: hash({ ...pkg.episode, duration_target: undefined }),
    assets: hash(pkg.catalogs), settings: hash({ drama: pkg.drama, planning, configs }),
    published: hash(rowVersions(publishedRows(db, episodeId))),
    rules: hash(codeFiles),
  };
}
function publishedRows(db, episodeId) {
  return db.prepare('SELECT * FROM storyboards WHERE episode_id=? AND deleted_at IS NULL ORDER BY storyboard_number,id').all(episodeId);
}

function rowVersions(rows) {
  return rows.map(row => {
    const { updated_at, video_url, selected_video_id, h3_quality_audit, h3_prompt_snapshot,
      h3_prompt_fingerprint, h3_prompt_manual, h3_contract_status, h3_generation_plan, status, ...directorInputs } = row;
    return { id: row.id, number: row.storyboard_number, hash: hash(directorInputs) };
  });
}

function assertCompatible(saved, current, state, db, episodeId, resume = false) {
  const labels = { script: '剧本', assets: '角色/场景/道具', settings: '生成配置', published: '已发布分镜', rules: '导演规则或提示词版本' };
  const changed = Object.keys(current).filter(k => saved[k] !== current[k]);
  if (state?.rowVersions && db) {
    const rows = publishedRows(db, episodeId);
    const versions = rowVersions(rows);
    const baseline = state.rowVersions;
    const sameRoster = baseline.length === versions.length && versions.every((v, i) =>
      v.id === baseline[i].id && v.number === baseline[i].number);
    if (!sameRoster) throw new Error('分镜数量或顺序已变化，请按当前分镜重新规划');
    const invalid = new Set();
    versions.forEach((v, i) => {
      if (v.hash === baseline[i].hash) return;
      invalid.add(v.id);
      if (i > 0) invalid.add(versions[i - 1].id);
      if (i + 1 < versions.length) invalid.add(versions[i + 1].id);
    });
    if (invalid.size && !resume) throw new Error('执行期间分镜已编辑，已保留人工修改。点击继续即可按最新分镜恢复。');
    if (resume && invalid.size) {
      state.enrichedShots = (state.enrichedShots || []).filter(shot => !invalid.has(shot.id));
      if (invalid.has(state.pendingRepair?.candidate?.id)) delete state.pendingRepair;
      state.rowVersions = versions;
    }
    const index = changed.indexOf('published');
    if (index >= 0) changed.splice(index, 1);
  }
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
  assertCompatible(saved.fingerprint, fingerprint(db, episodeId, cfg), saved.state, db, episodeId, true);
  return saved;
}
function open(db, taskId, episodeId, cfg, options, resumeId) {
  if (!taskId) return { state: {}, save() {}, record() {}, assertCurrent() {} };
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
  const record = (event = {}) => {
    if (!taskId) return;
    ensureTable(db);
    db.prepare(`INSERT INTO director_checkpoint_events
      (task_id, stage, shot_number, round, event_type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(taskId, event.stage || state.stage || null, event.shot_number == null ? null : Number(event.shot_number),
        event.round == null ? null : Number(event.round), event.type || 'progress',
        event.payload == null ? null : JSON.stringify(event.payload), new Date().toISOString());
  };
  save();
  return { state, save, record,
    capturePublished() { state.rowVersions = rowVersions(publishedRows(db, episodeId)); save(); },
    assertCurrent() { assertActive(); assertCompatible(initial, fingerprint(db, episodeId, cfg), state, db, episodeId); } };
}
function summary(db, taskId) {
  ensureTable(db);
  const s = db.prepare(`SELECT json_extract(state_json,'$.published') AS published,
    json_extract(state_json,'$.stage') AS stage, json_extract(state_json,'$.nextBatch') AS completed_batches,
    json_array_length(state_json,'$.enrichedShots') AS completed_shots,
    json_array_length(state_json,'$.stage1Storyboards') AS base_shots,
    json_extract(state_json,'$.resumed_from') AS resumed_from,
    json_extract(state_json,'$.currentShot') AS current_shot,
    json_extract(state_json,'$.reflectionRound') AS reflection_round,
    json_extract(state_json,'$.stage1Complete') AS stage1_complete FROM director_checkpoints WHERE task_id=?`).get(taskId);
  if (!s) return null;
  const latest = db.prepare('SELECT stage, shot_number, round, event_type, created_at FROM director_checkpoint_events WHERE task_id=? ORDER BY id DESC LIMIT 1').get(taskId);
  const count = db.prepare('SELECT COUNT(*) AS count FROM director_checkpoint_events WHERE task_id=?').get(taskId)?.count || 0;
  return { ...s, published: undefined, available: !s.published, completed_shots: s.completed_shots || 0, stage: s.stage || '准备', latest_event: latest || null, event_count: count };
}
function events(db, taskId, limit = 100) {
  ensureTable(db);
  return db.prepare('SELECT * FROM director_checkpoint_events WHERE task_id=? ORDER BY id DESC LIMIT ?').all(taskId, Number(limit) || 100);
}
module.exports = { read, open, summary, events, requireResume, fingerprint, assertCompatible, cleanOptions };
