/**
 * 影视视听本体槽位装配增强服务 (Director Ontology Enrichment Service)
 * 践行两阶段分镜生成架构 (Two-Stage Storyboard Generation Architecture):
 * 阶段一：快速全集分镜生成（使用原版引擎流式产出基础骨架）
 * 阶段二：本服务执行视听本体槽位装配与微调闭环（补齐 semantic_slots、video_slots、character_visuals 等），
 * 并经由 SHACL 视听门禁（Invariants Check）进行轻量校验与确定性闭环。
 */

const { compileDramaSemanticPackage } = require('./semanticPackage');
const { validateAllInvariants } = require('./invariants');
const {
  autoPatchDirectorExecutionSlots,
  autoPatchSingleShot,
  normalizeTimelineTimestamps,
} = require('./directorAgent');
const { dialogueSegments } = require('../services/dialogueDubbingService');
const angleService = require('../services/angleService');
const agentsRuntime = require('../services/agentsRuntime');

/**
 * 针对单个基础分镜，补齐所缺失的视听本体与契约槽位
 * @param {object} shot - 数据库或内存中的分镜对象
 * @param {object} context - 上下文（catalogs, allShots, episode, drama）
 * @returns {object} 完整填充了本体槽位的高精分镜对象
 */
function enrichSingleStoryboardSlots(shot, context = {}) {
  const { catalogs = {}, allShots = [], drama = {}, episode = {} } = context;
  const dramaCharacters = catalogs.characters || [];
  const dramaScenes = catalogs.scenes || [];
  const dramaProps = catalogs.props || [];

  const shotNum = Number(shot.storyboard_number || shot.shot_number || 1);
  const duration = Math.max(4, Math.min(30, Number(shot.duration || 5)));

  // 1. 解析台词与权威发声计划 (speech_plan)
  const dialogueStr = String(shot.dialogue || '').trim();
  const narrationStr = String(shot.narration || '').trim();
  const hasNarration = Boolean(narrationStr);
  const segs = dialogueSegments(dialogueStr || narrationStr);

  let speakerName = '';
  let speakerText = '';
  let speakerId = null;
  let isNarration = false;

  if (hasNarration && !dialogueStr) {
    isNarration = true;
    speakerName = '旁白';
    speakerText = narrationStr;
    speakerId = null; // 旁白必须为 null，严禁为 0，防止触发 INVARIANT_NARRATION_SPEAKER_CONFLICT
  } else if (segs.length > 0 && segs[0].speaker) {
    speakerName = segs[0].speaker;
    speakerText = segs.map((s) => s.text).join(' ');
    if (speakerName === '旁白') {
      isNarration = true;
      speakerId = null;
    } else {
      const charMeta = dramaCharacters.find((c) => c.name === speakerName);
      speakerId = charMeta ? charMeta.id : null;
    }
  } else if (dialogueStr) {
    speakerText = dialogueStr;
  }

  // 2. 解析角色关联 (characters)
  let charIds = [];
  if (Array.isArray(shot.characters)) {
    charIds = shot.characters.map((c) => Number(c?.id ?? c?.character_id ?? c)).filter((n) => Number.isFinite(n) && n > 0);
  } else if (typeof shot.characters === 'string' && shot.characters.trim()) {
    try {
      const parsed = JSON.parse(shot.characters);
      if (Array.isArray(parsed)) {
        charIds = parsed.map((c) => Number(c?.id ?? c?.character_id ?? c)).filter((n) => Number.isFinite(n) && n > 0);
      }
    } catch (_) {}
  }

  // 关键：若台词为画内角色发言且已识别说话人，则说话人必须纳入本镜头角色列表
  if (!isNarration && speakerId && !charIds.includes(speakerId)) {
    charIds.unshift(speakerId);
  }

  // 兜底：若分镜未绑定角色，尝试从 dialogue 与 action 匹配角色库
  if (charIds.length === 0 && dramaCharacters.length > 0) {
    const textPool = `${shot.dialogue || ''} ${shot.action || ''}`;
    for (const char of dramaCharacters) {
      if (char.name && textPool.includes(char.name)) {
        charIds.push(char.id);
      }
    }
  }

  // 限制每镜核心画内角色严格不超过 2 个，保障 AI 生图与视频人物一致性并契合短剧正反打双人语法
  charIds = [...new Set(charIds)];
  if (charIds.length > 2) {
    if (speakerId && charIds.includes(speakerId)) {
      const other = charIds.find((id) => id !== speakerId);
      charIds = other ? [speakerId, other] : [speakerId];
    } else {
      charIds = charIds.slice(0, 2);
    }
  }
  const visibleChars = charIds.map((id) => {
    const meta = dramaCharacters.find((c) => Number(c.id) === id);
    return { id, name: meta ? meta.name : `角色${id}` };
  });

  // 如果无明确发声人且存在画内角色，默认由首位主角承担
  if (!isNarration && !speakerId && visibleChars.length > 0 && speakerText) {
    speakerName = visibleChars[0].name;
    speakerId = visibleChars[0].id;
  }

  const speechPlan = {
    speaker_id: isNarration ? null : (speakerId || null),
    speaker_name: isNarration ? '旁白' : (speakerName || ''),
    is_offscreen: false,
    is_narration: isNarration,
    text: speakerText,
    speed: 1.25,
    emotion: String(shot.emotion || '坚定认真'),
    audio_references: [],
  };

  // 3. 构建前后镜因果连戏上下文 (continuity_from_previous)
  let continuityFromPrevious;
  if (shotNum === 1) {
    continuityFromPrevious = {
      relationship: 'opening',
      previous_end_state: '',
      entry_state: String(shot.action || '').slice(0, 80) || '开场建立叙事空间与主要角色',
      causal_link: '开场建立叙事空间与主要角色',
      sound_bridge: '',
      requires_previous_tail: false,
    };
  } else {
    const prevShot = allShots.find((s) => Number(s.storyboard_number || s.shot_number) === shotNum - 1);
    continuityFromPrevious = {
      relationship: 'continuation',
      previous_end_state: String(prevShot?.result || prevShot?.action || '').slice(0, 80) || '前一镜头动作结束',
      entry_state: String(shot.action || '').slice(0, 80) || '本镜头承接进入',
      causal_link: '剧情承接上一镜头因果发展',
      sound_bridge: '',
      requires_previous_tail: false,
    };
  }

  // 4. 解析现有或构建全新 semantic_slots
  let semanticSlots = {};
  if (typeof shot.semantic_slots === 'string' && shot.semantic_slots.trim()) {
    try { semanticSlots = JSON.parse(shot.semantic_slots); } catch (_) {}
  } else if (shot.semantic_slots && typeof shot.semantic_slots === 'object') {
    semanticSlots = { ...shot.semantic_slots };
  }

  semanticSlots = {
    visible_characters: visibleChars,
    background_characters: Array.isArray(semanticSlots.background_characters) ? semanticSlots.background_characters : [],
    identity_visibility: semanticSlots.identity_visibility || 'silhouette',
    speech_plan: speechPlan,
    sound_plan: {
      sound_effects: String(shot.sound_effect || '').split(/[、，,]/).map((s) => s.trim()).filter(Boolean),
      bgm_prompt: String(shot.bgm_prompt || ''),
      acoustic_env: '现场环境音',
      is_silent: !speakerText && !shot.bgm_prompt && !shot.sound_effect,
    },
    continuity_type: shotNum === 1 ? 'opening' : 'continuation',
    continuity_from_previous: continuityFromPrevious,
    h3_mode: semanticSlots.h3_mode || 'ref2va',
    h3_mode_reason: semanticSlots.h3_mode_reason || '统一使用 Ref2VA 保持空间与人物一致性',
    first_frame_policy: semanticSlots.first_frame_policy || 'none',
    first_frame_reason: semanticSlots.first_frame_reason || 'Ref2VA 直接约束生成，无需首帧',
    last_frame_policy: semanticSlots.last_frame_policy || 'none',
    last_frame_reason: semanticSlots.last_frame_reason || '无需尾帧',
    source_script_excerpt: String(shot.action || '') + (speakerText ? `\n${speakerName}: ${speakerText}` : ''),
    shot_duration: duration,
  };

  // 5. 构图推荐 (dialogue_framing)
  let dialogueFraming = shot.dialogue_framing;
  if (!dialogueFraming || (visibleChars.length === 2 && ['single_reaction_offscreen', 'solo_action'].includes(dialogueFraming)) || (visibleChars.length === 1 && ['two_shot_face_to_face', 'over_the_shoulder', 'joint_observation'].includes(dialogueFraming))) {
    if (visibleChars.length === 2) dialogueFraming = 'two_shot_face_to_face';
    else if (visibleChars.length === 1) dialogueFraming = isNarration ? 'solo_action' : 'single_reaction_offscreen';
    else dialogueFraming = 'solo_action';
  }

  // 6. 调用确定性视听编译器补齐 character_visuals 与 video_slots
  let enrichedShot = {
    ...shot,
    storyboard_number: shotNum,
    duration,
    characters: charIds,
    dialogue: isNarration ? '' : dialogueStr,
    narration: isNarration ? (narrationStr || speakerText) : narrationStr,
    semantic_slots: semanticSlots,
    dialogue_framing: dialogueFraming,
  };

  enrichedShot = autoPatchDirectorExecutionSlots(enrichedShot, duration);

  // 7. 规范化起幅、落幅与转场
  if (!enrichedShot.start_framing) {
    enrichedShot.start_framing = `起幅：${enrichedShot.shot_type || '中景'}，${visibleChars[0]?.name || '主体'}在画面中央，准备开始动作。`;
  }
  if (!enrichedShot.end_framing) {
    enrichedShot.end_framing = `落幅：${visibleChars[0]?.name || '主体'}完成动作，画面定格。`;
  }
  if (!enrichedShot.transition_to_next) {
    enrichedShot.transition_to_next = `cut: 顺切至下一镜头。`;
  }

  // 8. 规范化布局与提示词
  if (!enrichedShot.layout_description) {
    const charsDesc = (enrichedShot.character_visuals || []).map((v) => `${v.name}位于${v.screen_position}，${v.facing}，${v.posture}`).join('；');
    enrichedShot.layout_description = charsDesc || '画面中央为主体，背景景深清晰。';
  }

  // 9. 保证 shots_timeline 包含规范的发声动作对齐
  if (Array.isArray(enrichedShot.video_slots?.shots_timeline)) {
    enrichedShot.video_slots.shots_timeline = normalizeTimelineTimestamps(enrichedShot.video_slots.shots_timeline);
  }

  return enrichedShot;
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

  const context = {
    catalogs: pkg.catalogs,
    allShots: rows,
    drama: pkg.drama,
    episode: pkg.episode,
  };

  const enrichedShots = [];
  for (let i = 0; i < rows.length; i++) {
    const enriched = enrichSingleStoryboardSlots(rows[i], context);
    enrichedShots.push(enriched);
    const pct = 15 + Math.floor(((i + 1) / rows.length) * 55);
    onProgress(pct, `正在装配第 ${i + 1}/${rows.length} 镜的视听槽位...`);
  }

  onProgress(75, '槽位装配初步完成，正在进行 SHACL 视听本体质量门禁预检...');

  // 运行全套门禁预检
  let audit = validateAllInvariants(enrichedShots, {
    db,
    props: pkg.catalogs.props,
    dramaEra: pkg.drama?.era,
    catalogs: pkg.catalogs,
    scriptContent: pkg.episode?.script_content || '',
    dramaShots: enrichedShots,
    requestedPacing: { range: { min: 4, max: 30 } },
  });

  // 如果门禁有违规，应用 autoPatchSingleShot 确定性消除
  if (!audit.valid && Array.isArray(audit.violations) && audit.violations.length > 0) {
    log.info('[本体丰富] 阶段二门禁预检发现可修复项，执行确定性闭环修补', { count: audit.violations.length });
    const byShot = new Map();
    for (const v of audit.violations) {
      const num = Number(v.shot_number);
      if (num > 0) {
        if (!byShot.has(num)) byShot.set(num, []);
        byShot.get(num).push(v);
      }
    }
    for (let i = 0; i < enrichedShots.length; i++) {
      const sNum = Number(enrichedShots[i].storyboard_number);
      const violations = byShot.get(sNum);
      if (violations && violations.length > 0) {
        const { shot: patched } = autoPatchSingleShot(enrichedShots[i], violations, {
          dramaCharacters: pkg.catalogs.characters,
        });
        enrichedShots[i] = patched;
      }
    }

    // 重新质检
    audit = validateAllInvariants(enrichedShots, {
      db,
      props: pkg.catalogs.props,
      dramaEra: pkg.drama?.era,
      catalogs: pkg.catalogs,
      scriptContent: pkg.episode?.script_content || '',
      dramaShots: enrichedShots,
      requestedPacing: { range: { min: 4, max: 30 } },
    });
  }

  onProgress(85, '门禁审查与对齐完成，正在持久化写入数据库...');

  // 持久化更新回 storyboards 表
  const updateStmt = db.prepare(`
    UPDATE storyboards SET
      characters = ?,
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
 * 阶段二：调用视听本体槽位装配服务，并行补充各镜本体契约，SHACL门禁校验闭环。
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
