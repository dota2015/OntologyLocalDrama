/**
 * 影视视听本体槽位装配增强服务 (Director Ontology Enrichment Service)
 * 践行两阶段分镜生成架构 (Two-Stage Storyboard Generation Architecture):
 * 阶段一：快速全集分镜生成（使用原版引擎流式产出基础骨架）
 * 阶段二：由导演 Agent 生成 semantic_slots、video_slots、character_visuals 等执行合同，
 * 本服务只做格式归一化、门禁审查和原子提交。
 */

const { compileDramaSemanticPackage } = require('./semanticPackage');
const { validateAllInvariants, checkPlanningFeasibility } = require('./invariants');
const {
  ensureDirectorExecutionSlots,
  normalizeTimelineTimestamps,
} = require('./directorAgent');

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
 * 兼容旧调用名，但不再“补齐”任何语义槽位。
 * 阶段二的完整执行合同必须由 director-execution-slots-planner 生成。
 */
function enrichSingleStoryboardSlots(shot) {
  return normalizeStoryboardForAgent(shot);
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
  const planningViolations = checkPlanningFeasibility(normalizedShots, { catalogs: pkg.catalogs });
  if (planningViolations.length) {
    const error = new Error(`阶段二执行前的导演规划可行性门禁未通过：${planningViolations.map((item) => item.message).join('；')}`);
    error.status = 422;
    error.violations = planningViolations;
    throw error;
  }
  let enrichedShots = [];
  const maxAttempts = Math.max(1, Math.min(5, Number(options.maxAttempts || options.max_attempts || 3)));

  // 执行合同由专用导演 Agent 生成。为了保证连戏上下文，阶段二按镜头顺序执行。
  for (let i = 0; i < normalizedShots.length; i++) {
    const shot = normalizedShots[i];
    const planned = await ensureDirectorExecutionSlots(db, log, shot, {
      maxAttempts,
      forceAgent: true,
      onProgress: (message) => onProgress(15 + Math.floor(((i + 1) / rows.length) * 55), `正在由导演 Agent 规划第 ${i + 1}/${rows.length} 镜：${message}`),
      episodeScript: pkg.episode?.script_content || '',
      catalogs: pkg.catalogs,
      allShots: normalizedShots.map((item, index) => enrichedShots[index] || item),
      previousShot: enrichedShots[i - 1] || null,
      nextShot: normalizedShots[i + 1] || null,
    });
    enrichedShots.push(planned);
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
  };
  let audit = validateAllInvariants(enrichedShots, auditOptions);

  // 门禁只反馈，不创作。每轮把同一镜头的完整违规一次性交给 Agent，
  // 并连同相邻镜头上下文重新规划完整执行合同。
  const repairRounds = Math.max(1, Math.min(5, Number(options.repairRounds || options.repair_rounds || 3)));
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
        onProgress: (message) => onProgress(75 + Math.floor((round / repairRounds) * 10), `导演 Agent 修复第 ${shotNumber} 镜：${message}`),
      });
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
      updated_at = ?
    WHERE id = ?
  `);

  const now = new Date().toISOString();
  db.transaction(() => {
    for (const shot of enrichedShots) {
      updateStmt.run(
        shot.characters ? (typeof shot.characters === 'string' ? shot.characters : JSON.stringify(shot.characters)) : null,
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
        now,
        shot.id
      );
    }
  })();

  log.info('[本体丰富] 阶段二槽位装配成功完成并落库', {
    episode_id: epId,
    total_shots: enrichedShots.length,
    invariants_valid: audit.valid,
    remaining_errors: audit.error_count || 0,
  });

  onProgress(100, `视听本体槽位装配完毕（${enrichedShots.length} 镜全部就绪，门禁质检 ${audit.valid ? '通过' : '告警'}）`);

  return {
    success: true,
    episode_id: epId,
    total_shots: enrichedShots.length,
    updated_shots: enrichedShots.length,
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

  log.info('[两阶段导演流水线] 启动', { episode_id: epId, task_id: taskId });
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
  const stage1Result = await runStageOneBaseGeneration(db, log, epId, taskId, options);

  // 2. 阶段二：视听本体槽位装配与 SHACL 门禁闭环
  onProgress(58, '【阶段 1/2】全集基础分镜生成完成！【阶段 2/2】开始装配视听本体槽位...');
  const stage2Result = await enrichEpisodeOntologySlots(db, log, cfg, epId, {
    ...options,
    onProgress: (pct, msg) => {
      const overallPct = 58 + Math.floor(pct * 0.40); // 58% -> 98%
      onProgress(overallPct, `【阶段 2/2】${msg}`);
    },
  });

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
  enrichSingleStoryboardSlots,
  enrichEpisodeOntologySlots,
  runTwoStageDirectorPipeline,
};
