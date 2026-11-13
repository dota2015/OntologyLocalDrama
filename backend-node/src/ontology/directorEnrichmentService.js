/**
 * 影视视听本体槽位装配增强服务 (Director Ontology Enrichment Service)
 * 践行两阶段分镜生成架构 (Two-Stage Storyboard Generation Architecture):
 * 阶段一：快速全集分镜生成（使用原版引擎流式产出基础骨架）
 * 阶段二：由导演 Agent 生成 semantic_slots、video_slots、character_visuals 等执行合同，
 * 本服务只做格式归一化、门禁审查和原子提交。
 */

const { compileDramaSemanticPackage } = require('./semanticPackage');
const { validateAllInvariants, planningFeasibilityViolations } = require('./invariants');
const {
  ensureDirectorExecutionSlots,
  normalizeTimelineTimestamps,
} = require('./directorAgent');
const directorCheckpoint = require('../services/directorCheckpoint');
const { VERSION: H3_CONTRACT_VERSION, buildH3Contract } = require('../services/h3Contract');

function parseJsonValue(value, fallback = null) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

/**
 * 只做机械格式归一化。
 * 这里不能根据对白、动作或角色库推断任何新语义；缺失字段交给 Agent 和门禁处理。
 */
function normalizeStoryboardForAgent(shot) {
  const normalized = { ...shot };
  for (const field of ['characters', 'background_characters', 'props', 'character_visuals', 'last_frame_visuals', 'video_slots', 'semantic_slots']) {
    if (Object.prototype.hasOwnProperty.call(normalized, field)) {
      normalized[field] = parseJsonValue(normalized[field], normalized[field]);
    }
  }
  if (normalized.video_slots && Array.isArray(normalized.video_slots.shots_timeline)) {
    normalized.video_slots = {
      ...normalized.video_slots,
      shots_timeline: normalizeTimelineTimestamps(normalized.video_slots.shots_timeline),
    };
  }
  if (normalized.duration != null && Number.isFinite(Number(normalized.duration))) {
    normalized.duration = Math.round(Number(normalized.duration));
  }
  return normalized;
}

/**
 * 批量装配指定剧集的全集分镜视听本体槽位
 * @param {object} db - SQLite 数据库连接
 * @param {object} log - 日志记录器
 * @param {object} cfg - 配置对象
 * @param {number|string} episodeId - 剧集 ID
 * @param {object} [options] - 选项 (overwrite, useAgent, onProgress)
 */
async function enrichEpisodeOntologySlots(db, log, cfg, episodeId, options = {}) {
  const epId = Number(episodeId);
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};

  log.info('[本体丰富] 开始执行阶段二：视听本体槽位装配', { episode_id: epId });
  onProgress(5, '开始拉取基础分镜与本体资产...');

  const pkg = compileDramaSemanticPackage(db, epId);
  const rows = db.prepare(
    'SELECT * FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL ORDER BY storyboard_number ASC'
  ).all(epId);

  if (!rows || rows.length === 0) {
    log.warn('[本体丰富] 剧集无分镜，无法补充槽位', { episode_id: epId });
    return { total_shots: 0, updated_shots: 0, audit: { valid: true, error_count: 0, violations: [] } };
  }

  onProgress(15, `已加载 ${rows.length} 个基础分镜，开始装配视听契约与镜内时间线...`);

  const normalizedShots = rows.map(normalizeStoryboardForAgent);
  const planningViolations = planningFeasibilityViolations(normalizedShots, { catalogs: pkg.catalogs });
  if (planningViolations.length) {
    const error = new Error(`阶段二执行前的导演规划可行性门禁未通过：${planningViolations.map((item) => item.message).join('；')}`);
    error.status = 422;
    error.violations = planningViolations;
    throw error;
  }
  // Keep stage-two output in the checkpoint. A failed run resumes from the
  // first uncompleted shot instead of asking the Agent to regenerate passed
  // contracts.
  const checkpointState = options.checkpointState || {};
  let enrichedShots = Array.isArray(checkpointState.enrichedShots)
    ? checkpointState.enrichedShots.map(normalizeStoryboardForAgent)
    : [];
  // Resume by storyboard number, never by array index. A failed run can have
  // completed non-contiguous shots in its checkpoint; using `enrichedShots[i]`
  // as the previous shot would then attach the wrong continuity contract.
  const shotNumberOf = item => Number(item?.storyboard_number || item?.shot_number || 0);
  const enrichedByNumber = new Map(enrichedShots.map(item => [shotNumberOf(item), item]).filter(([n]) => Number.isFinite(n) && n > 0));
  const completedNumbers = new Set(enrichedByNumber.keys());
  // A single execution contract can require several structured corrections.
  // Do not terminate the whole episode after the old six-attempt default;
  // checkpoints still make the finite 20-round ceiling resumable and safe.
  const maxAttempts = Math.max(1, Math.min(20, Number(options.maxAttempts || options.max_attempts || 20)));

  // 执行合同由专用导演 Agent 生成。为了保证连戏上下文，阶段二按镜头顺序执行。
  for (let i = 0; i < normalizedShots.length; i++) {
    const shot = normalizedShots[i];
    if (completedNumbers.has(Number(shot.storyboard_number || shot.shot_number))) continue;
    const planned = await ensureDirectorExecutionSlots(db, log, shot, {
      maxAttempts,
      forceAgent: true,
      onProgress: (message) => onProgress(15 + Math.floor(((i + 1) / rows.length) * 55), `正在由导演 Agent 规划第 ${i + 1}/${rows.length} 镜：${message}`),
      episodeScript: pkg.episode?.script_content || '',
      catalogs: pkg.catalogs,
      allShots: normalizedShots.map(item => enrichedByNumber.get(shotNumberOf(item)) || item),
      previousShot: i > 0 ? (enrichedByNumber.get(shotNumberOf(normalizedShots[i - 1])) || normalizedShots[i - 1]) : null,
      nextShot: normalizedShots[i + 1] || null,
      checkpoint: options.checkpoint,
    });
    enrichedByNumber.set(shotNumberOf(planned) || shotNumberOf(shot), planned);
    enrichedShots = normalizedShots.map(item => enrichedByNumber.get(shotNumberOf(item)) || item)
      .filter(item => enrichedByNumber.has(shotNumberOf(item)));
    checkpointState.enrichedShots = enrichedShots;
    checkpointState.currentShot = Number(shot.storyboard_number || shot.shot_number);
    checkpointState.completed_shots = enrichedShots.length;
    options.checkpoint?.record?.({ stage: 'stage2', shot_number: checkpointState.currentShot, type: 'shot_completed', payload: planned });
    options.checkpoint?.save?.();
  }

  onProgress(75, '导演 Agent 已输出全集执行合同，正在进行视听本体门禁审查...');

  const auditOptions = {
    db,
    props: pkg.catalogs.props,
    dramaEra: pkg.drama?.era,
    catalogs: pkg.catalogs,
    scriptContent: pkg.episode?.script_content || '',
    dramaShots: enrichedShots,
    requestedPacing: { range: { min: 4, max: 30 } },
    directorPlanningMode: 'persisted',
  };
  let audit = validateAllInvariants(enrichedShots, auditOptions);

  // 门禁只反馈，不创作。每轮把同一镜头的完整违规一次性交给 Agent，
  // 并连同相邻镜头上下文重新规划完整执行合同。
  const repairRounds = Math.max(1, Math.min(8, Number(options.repairRounds || options.repair_rounds || 4)));
  for (let round = 1; !audit.valid && round <= repairRounds; round++) {
    const byShot = new Map();
    for (const violation of audit.violations || []) {
      const number = Number(violation.shot_number);
      if (!Number.isFinite(number) || number <= 0) continue;
      if (!byShot.has(number)) byShot.set(number, []);
      byShot.get(number).push(violation);
    }
    if (!byShot.size) break;

    const targets = [...byShot.keys()].sort((a, b) => a - b);
    log.warn('[本体丰富] 门禁退回导演 Agent 修复执行合同', {
      episode_id: epId,
      round,
      target_shots: targets,
      violation_count: audit.violations.length,
    });
    for (const shotNumber of targets) {
      const index = enrichedShots.findIndex((shot) => Number(shot.storyboard_number || shot.shot_number) === shotNumber);
      if (index < 0) continue;
      enrichedShots[index] = await ensureDirectorExecutionSlots(db, log, enrichedShots[index], {
        maxAttempts,
        forceAgent: true,
        invariantViolations: byShot.get(shotNumber),
        episodeScript: pkg.episode?.script_content || '',
        catalogs: pkg.catalogs,
        allShots: enrichedShots,
        previousShot: enrichedShots[index - 1] || null,
        nextShot: enrichedShots[index + 1] || null,
        checkpoint: options.checkpoint,
        onProgress: (message) => onProgress(75 + Math.floor((round / repairRounds) * 10), `导演 Agent 修复第 ${shotNumber} 镜：${message}`),
      });
      checkpointState.enrichedShots = enrichedShots;
      checkpointState.currentShot = shotNumber;
      checkpointState.completed_shots = enrichedShots.length;
      options.checkpoint?.record?.({ stage: 'stage2', shot_number: shotNumber, round, type: 'repair_completed', payload: enrichedShots[index] });
      options.checkpoint?.save?.();
    }
    audit = validateAllInvariants(enrichedShots, auditOptions);
  }

  if (!audit.valid) {
    const error = new Error(`阶段二导演执行合同未通过视听本体门禁：${(audit.violations || []).map((item) => item.message).join('；')}`);
    error.status = 422;
    error.violations = audit.violations || [];
    error.audit = audit;
    throw error;
  }

  onProgress(85, '门禁审查与对齐完成，正在持久化写入数据库...');

  // 持久化更新回 storyboards 表
  // Test databases and older installations may not have the new contract
  // columns yet; add only these additive columns at the boundary.
  const existingColumns = new Set(db.prepare('PRAGMA table_info(storyboards)').all().map((item) => item.name));
  for (const column of [
    ['h3_contract_json', 'TEXT'], ['h3_contract_version', 'TEXT'],
    ['h3_contract_status', 'TEXT'], ['h3_prompt_snapshot', 'TEXT'],
    ['h3_prompt_fingerprint', 'TEXT'], ['h3_prompt_manual', 'INTEGER DEFAULT 0'],
    ['h3_quality_audit', 'TEXT'],
  ]) {
    if (!existingColumns.has(column[0])) {
      try { db.prepare(`ALTER TABLE storyboards ADD COLUMN ${column[0]} ${column[1]}`).run(); } catch (_) {}
    }
  }
  const updateStmt = db.prepare(`
    UPDATE storyboards SET
      characters = ?,
      background_characters = ?,
      duration = ?,
      dialogue_framing = ?,
      dialogue = ?,
      narration = ?,
      character_visuals = ?,
      last_frame_visuals = ?,
      video_slots = ?,
      semantic_slots = ?,
      start_framing = ?,
      end_framing = ?,
      transition_to_next = ?,
      layout_description = ?,
      action = ?,
      result = ?,
      image_prompt = ?,
      h3_contract_json = ?,
      h3_contract_version = ?,
      h3_contract_status = ?,
      updated_at = ?
    WHERE id = ?
  `);

  let insSbCharStmt = null;
  let delSbCharStmt = null;
  let insSbPropStmt = null;
  let delSbPropStmt = null;
  try {
    insSbCharStmt = db.prepare('INSERT OR IGNORE INTO storyboard_characters (storyboard_id, character_id, created_at) VALUES (?, ?, ?)');
    delSbCharStmt = db.prepare('DELETE FROM storyboard_characters WHERE storyboard_id = ?');
  } catch (_) {}
  try {
    insSbPropStmt = db.prepare('INSERT OR IGNORE INTO storyboard_props (storyboard_id, prop_id) VALUES (?, ?)');
    delSbPropStmt = db.prepare('DELETE FROM storyboard_props WHERE storyboard_id = ?');
  } catch (_) {}

  const now = new Date().toISOString();
  db.transaction(() => {
    for (const shot of enrichedShots) {
      let resolvedCharIds = [];
      if (Array.isArray(shot.semantic_slots?.visible_characters) && shot.semantic_slots.visible_characters.length > 0) {
        resolvedCharIds = shot.semantic_slots.visible_characters.map((c) => Number(c.id)).filter(Number.isFinite);
      } else if (Array.isArray(shot.character_visuals) && shot.character_visuals.length > 0) {
        resolvedCharIds = shot.character_visuals.map((c) => Number(c.character_id)).filter(Number.isFinite);
      } else if (shot.characters) {
        const parsed = typeof shot.characters === 'string' ? JSON.parse(shot.characters) : shot.characters;
        resolvedCharIds = (Array.isArray(parsed) ? parsed : [parsed])
          .map((c) => Number(typeof c === 'object' && c != null ? c.id : c))
          .filter(Number.isFinite);
      }
      resolvedCharIds = Array.from(new Set(resolvedCharIds));
      shot.characters = resolvedCharIds;

      let resolvedPropIds = [];
      if (Array.isArray(shot.semantic_slots?.required_references)) {
        resolvedPropIds = shot.semantic_slots.required_references
          .filter((ref) => ref.type === 'prop')
          .map((ref) => Number(ref.id || ref.prop_id))
          .filter(Number.isFinite);
      } else if (Array.isArray(shot.props)) {
        resolvedPropIds = shot.props.map((p) => Number(typeof p === 'object' && p != null ? p.id : p)).filter(Number.isFinite);
      }
      resolvedPropIds = Array.from(new Set(resolvedPropIds));

      updateStmt.run(
        JSON.stringify(resolvedCharIds),
        shot.background_characters ? (typeof shot.background_characters === 'string' ? shot.background_characters : JSON.stringify(shot.background_characters)) : null,
        shot.duration,
        shot.dialogue_framing || null,
        shot.dialogue ?? null,
        shot.narration ?? null,
        shot.character_visuals ? JSON.stringify(shot.character_visuals) : null,
        shot.last_frame_visuals ? JSON.stringify(shot.last_frame_visuals) : null,
        shot.video_slots ? JSON.stringify(shot.video_slots) : null,
        shot.semantic_slots ? JSON.stringify(shot.semantic_slots) : null,
        shot.start_framing || null,
        shot.end_framing || null,
        shot.transition_to_next || null,
        shot.layout_description || null,
        shot.action || null,
        shot.result || null,
        shot.image_prompt || null,
        JSON.stringify(buildH3Contract(shot)),
        H3_CONTRACT_VERSION,
        'audited',
        now,
        shot.id
      );

      // 同步 storyboard_characters 关联表
      if (delSbCharStmt && insSbCharStmt) {
        try {
          delSbCharStmt.run(shot.id);
          for (const cid of resolvedCharIds) {
            insSbCharStmt.run(shot.id, cid, now);
          }
        } catch (_) {}
      }

      // 同步 storyboard_props 关联表
      if (resolvedPropIds.length > 0 && delSbPropStmt && insSbPropStmt) {
        try {
          delSbPropStmt.run(shot.id);
          for (const pid of resolvedPropIds) {
            insSbPropStmt.run(shot.id, pid);
          }
        } catch (_) {}
      }
    }
  })();

  let stage3Stats = { compiled: 0, cached: 0, manual_locked: 0 };
  if (options.skipStage3 !== true) {
    onProgress(86, '阶段二门禁通过，正在按官方 H3 SKILL 执行阶段三编译提示词...');
    const h3Stage3 = require('../services/h3Stage3PromptService');
    const persistedRows = db.prepare(
      'SELECT * FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL ORDER BY storyboard_number ASC'
    ).all(epId).map(normalizeStoryboardForAgent);
    const rawMeta = pkg.drama?.metadata;
    const dramaMeta = typeof rawMeta === 'string' ? parseJsonValue(rawMeta, {}) : (rawMeta || {});
    const aspectRatio = String(dramaMeta?.aspect_ratio || pkg.drama?.aspect_ratio || '16:9');
    for (let i = 0; i < persistedRows.length; i++) {
      const shot = persistedRows[i];
      onProgress(86 + Math.floor(((i + 1) / persistedRows.length) * 13), `阶段三正在编译第 ${i + 1}/${persistedRows.length} 镜官方 H3 提示词...`);
      const res = await h3Stage3.ensureShotH3PromptCompiled(db, log, shot, {
        dramaId: pkg.drama?.id,
        aspectRatio,
        forceRecompile: options.forceStage3 === true,
      });
      if (res.source === 'manual_locked') stage3Stats.manual_locked += 1;
      else if (res.source === 'cache_hit') stage3Stats.cached += 1;
      else stage3Stats.compiled += 1;
      options.checkpoint?.record?.({ stage: 'stage3', shot_number: Number(shot.storyboard_number || i + 1), type: 'stage3_completed', payload: { source: res.source, mode: res.mode } });
      options.checkpoint?.save?.();
    }
  }

  log.info('[本体丰富] 阶段二/三完成并落库', {
    episode_id: epId,
    total_shots: enrichedShots.length,
    invariants_valid: audit.valid,
    remaining_errors: audit.error_count || 0,
    stage3: stage3Stats,
  });

  onProgress(100, `视听本体槽位与官方 H3 提示词装配完毕（${enrichedShots.length} 镜全部就绪，门禁质检 ${audit.valid ? '通过' : '告警'}）`);

  return {
    success: true,
    episode_id: epId,
    total_shots: enrichedShots.length,
    updated_shots: enrichedShots.length,
    stage3: stage3Stats,
    audit,
  };
}

/**
 * 运行两阶段极速导演分镜流水线 (Two-Stage Director Storyboard Pipeline)
 * 阶段一：调用原版快速分镜引擎，单次流式推演整集基础剧情分镜；
 * 阶段二：调用视听执行合同 Agent 按镜头顺序规划，门禁失败则反馈 Agent，最后原子提交。
 */
async function runTwoStageDirectorPipeline(db, log, cfg, episodeId, options = {}) {
  const epId = Number(episodeId);
  const taskId = options.taskId;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};

  // Keep a durable checkpoint for the two-stage path as well.  Previously the
  // checkpoint was only opened by the deep-ReAct runner, so a stage-one parse
  // or provider failure left no resumable state and the UI could only report a
  // generic stopped task.
  const checkpoint = directorCheckpoint.open(
    db, taskId, epId, cfg, options, options.resume_task_id
  );
  const checkpointState = checkpoint.state;
  const saveProgress = (stage, message, extra = {}) => {
    Object.assign(checkpointState, { stage, message, ...extra });
    checkpoint.save();
  };

  log.info('[两阶段导演流水线] 启动', { episode_id: epId, task_id: taskId });
  saveProgress('stage1', '启动快速分镜引擎');
  onProgress(5, '【阶段 1/2】启动快速分镜引擎，正在解析剧本并流式生成基础分镜...');

  // 确保 storyboards 表具备本体列
  try {
    const cols = db.prepare('PRAGMA table_info(storyboards)').all().map((c) => c.name);
    const requiredCols = [
      'dialogue_framing',
      'character_visuals',
      'last_frame_visuals',
      'video_slots',
      'long_take_group_id',
      'long_take_role',
      'long_take_sequence',
      'start_framing',
      'end_framing',
      'transition_to_next',
      'background_characters',
      'semantic_slots',
    ];
    for (const col of requiredCols) {
      if (!cols.includes(col)) {
        db.prepare(`ALTER TABLE storyboards ADD COLUMN ${col} TEXT`).run();
      }
    }
  } catch (_) {}

  // 1. 阶段一：快速全集基础分镜生成
  const { runStageOneBaseGeneration } = require('../services/episodeStoryboardService');
  let stage1Result;
  try {
    if (checkpointState.stage1Complete && Array.isArray(checkpointState.stage1Storyboards) && checkpointState.stage1Storyboards.length) {
      stage1Result = { storyboards: checkpointState.stage1Storyboards, resumed: true };
      log.info('[两阶段导演流水线] 从检查点恢复阶段一结果', { episode_id: epId, count: checkpointState.stage1Storyboards.length });
    } else {
      stage1Result = await runStageOneBaseGeneration(db, log, epId, taskId, {
        ...options,
        // 阶段一必须先通过基础规划门禁，再把基础分镜发布给阶段二。
        planningCatalogs: compileDramaSemanticPackage(db, epId).catalogs,
        planningRepairAttempts: options.planningRepairAttempts || 3,
      });
      checkpointState.stage1Complete = true;
      checkpointState.stage1Storyboards = stage1Result.storyboards;
      checkpoint.record({ stage: 'stage1', type: 'stage1_completed', payload: stage1Result.storyboards });
      checkpoint.save();
    }
  } catch (error) {
    saveProgress('stage1_failed', error.message, {
      partial_shot_count: Number(error.partial_shot_count || 0),
      error: error.message,
    });
    throw error;
  }
  if (!stage1Result || !Array.isArray(stage1Result.storyboards) || stage1Result.storyboards.length === 0) {
    const error = new Error('阶段一基础分镜未生成完整结果，已保留检查点，请重试或从检查点继续');
    error.stage = 'stage1';
    saveProgress('stage1_failed', error.message);
    throw error;
  }

  // 2. 阶段二：视听本体槽位装配与 SHACL 门禁闭环
  saveProgress('stage2', '基础分镜生成完成，开始装配视听执行合同', {
    completed_shots: stage1Result.storyboards.length,
  });
  onProgress(58, '【阶段 1/2】全集基础分镜生成完成！【阶段 2/2】开始装配视听本体槽位...');
  let stage2Result;
  try {
    stage2Result = await enrichEpisodeOntologySlots(db, log, cfg, epId, {
      ...options,
      checkpoint,
      checkpointState,
      onProgress: (pct, msg) => {
        const overallPct = 58 + Math.floor(pct * 0.40); // 58% -> 98%
        saveProgress('stage2', msg, { stage2_progress: pct });
        onProgress(overallPct, `【阶段 2/2】${msg}`);
      },
    });
  } catch (error) {
    saveProgress('stage2_failed', error.message, { error: error.message });
    throw error;
  }

  checkpointState.stage = 'completed';
  checkpointState.published = true;
  checkpointState.completed_shots = stage2Result.total_shots;
  checkpoint.save();
  onProgress(100, '两阶段极速导演分镜推演完毕，视听契约已完整入库。');
  return {
    success: true,
    episode_id: epId,
    total_shots: stage2Result.total_shots,
    updated_shots: stage2Result.updated_shots,
    stage1: stage1Result,
    stage2: stage2Result,
    audit: stage2Result.audit,
  };
}

module.exports = {
  normalizeStoryboardForAgent,
  enrichEpisodeOntologySlots,
  runTwoStageDirectorPipeline,
};
