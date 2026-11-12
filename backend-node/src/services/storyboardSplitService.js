/**
 * storyboardSplitService.js
 * 提供基于 AI 的分镜智能拆分能力：将复杂/长镜头拆分为多个连续子镜头
 */

const aiClient = require('./aiClient');
const episodeStoryboardService = require('./episodeStoryboardService');
const storyboardService = require('./storyboardService');

/**
 * 构建 AI 拆分分镜的 System Prompt
 */
function getStoryboardSplitSystemPrompt() {
  return `你是一位顶级影视导演与专业微短剧分镜师。
你的任务是将一个内容复杂、包含多个连续动作或多人物交互的复杂分镜镜头，合理拆分为多个连续的子分镜镜头。

【拆镜最高准则】
1. 因果节拍而不是逐动词拆镜（Causal Beat）：
   - 每个子镜头聚焦一个能被观众理解的因果节拍；同一空间内可以包含多个紧密相连的身体动作与即时结果。
   - 只有说话人/人物切换、场景或时间变化、视线轴线重大变化，或确实超出30秒时才拆镜。4～8秒走普通H3，9～30秒由Continuum承载，不要因为普通H3的旧上限机械拆镜。
   - 关键动机、选择、规则与后果应放入对白或必要旁白，不能只藏在 action 中。
2. 镜头语言与视听节奏（Cinematic Coverage & Rhythm）：
   - 建立清晰的景别层次：如从全景交代空间 -> 中景聚焦主体行动 -> 特写捕捉情绪与关键道具，形成电影级剪辑节奏。
   - 每个子镜头应指定合理的景别（特写 / 近景 / 中景 / 全景）与运镜方式（推镜 / 拉镜 / 摇镜 / 跟镜 / 固定）。
3. 纯物理动作与因果衔接：
   - 动作描写必须是纯物理动作（起伏、倒下、伸手、转头），严禁文学化心理隐喻或虚构画面转场。
   - 子镜头之间按物理时间自然推移，首尾状态紧密咬合；每个子镜头必须说明上一镜结束状态、本镜进入状态和两者的因果关系。
4. 台词与旁白精确归位：
   - 将原镜头的对白和旁白分配给对应做出动作与表情的子镜头；没有台词的镜头设为 null。
5. 服装与设定连续性：
   - 所有角色必须完全沿用原镜头的服装、造型与设定，不得更改换装。
6. 严格输出 JSON 数组格式：
   - 输出必须是一个严格合法的 JSON 数组，不含任何多余的前言、解释或外部注释。

【JSON 元素数据结构】
[
  {
    "title": "简短镜头标题（如：角色挣扎撑起）",
    "duration": 时长整数（秒，4~30之间）,
    "shot_type": "特写|近景|中景|全景",
    "movement": "推镜|拉镜|摇镜|跟镜|手持|环绕|固定（严格少用固定镜头）",
    "action": "当前子镜头的核心物理动作描写",
    "result": "动作完成时的静态最终结果",
    "dialogue": "当前镜头人物台词（无则null）",
    "narration": "画外旁白（无则null）",
    "atmosphere": "镜头氛围",
    "image_prompt": "适合AI生图的模型提示词，交代主体、动作、景别与环境光影"
  }
]`;
}

/**
 * 提取 AI 输出中的 JSON 数组
 */
function extractJsonArray(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  // 1. 尝试直接解析
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed) && parsed.length >= 2) return parsed;
  } catch (_) {}

  // 2. 尝试从 markdown 代码块提取
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1]);
      if (Array.isArray(parsed) && parsed.length >= 2) return parsed;
    } catch (_) {}
  }

  // 3. 尝试正则抓取最外层中括号
  const bracketMatch = trimmed.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (bracketMatch) {
    try {
      const parsed = JSON.parse(bracketMatch[0]);
      if (Array.isArray(parsed) && parsed.length >= 2) return parsed;
    } catch (_) {}
  }

  return null;
}

/**
 * AI 智能拆分分镜
 * @param {object} db - better-sqlite3 实例
 * @param {object} log - 日志对象
 * @param {number|string} storyboardId - 要拆分的目标分镜 ID
 * @param {object} options - { split_count: number|string, instruction: string }
 * @returns {Promise<{ ok: boolean, source_id: number, count: number, storyboard_ids: number[], storyboards: object[] }>}
 */
async function splitStoryboardWithAi(db, log, storyboardId, options = {}) {
  const sbId = Number(storyboardId);
  if (!Number.isFinite(sbId) || sbId <= 0) {
    throw new Error('无效的分镜 ID');
  }

  const baseRow = db.prepare(
    `SELECT s.*, e.drama_id
     FROM storyboards s
     JOIN episodes e ON e.id = s.episode_id AND e.deleted_at IS NULL
     WHERE s.id = ? AND s.deleted_at IS NULL`
  ).get(sbId);
  if (!baseRow) {
    throw new Error('分镜不存在或已被删除');
  }

  // 整理拆分数量要求
  let requestedCount = parseInt(options.split_count, 10);
  if (!requestedCount || requestedCount < 2 || requestedCount > 5) {
    requestedCount = 2; // 默认拆为 2 镜
  }

  const userInstruction = String(options.instruction || options.user_feedback || '').trim();

  // 获取剧本、角色与场景信息
  let scriptContent = '';
  try {
    const ep = db.prepare('SELECT script_content FROM episodes WHERE id = ?').get(baseRow.episode_id);
    if (ep?.script_content) scriptContent = ep.script_content.slice(0, 1000);
  } catch (_) {}

  let characterNames = [];
  if (baseRow.characters) {
    try {
      const parsed = JSON.parse(baseRow.characters);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const cid = typeof item === 'object' && item != null ? item.id : item;
          const c = db.prepare('SELECT name FROM characters WHERE id = ?').get(Number(cid));
          if (c?.name) characterNames.push(c.name);
        }
      }
    } catch (_) {}
  }

  let sceneLocation = '';
  if (baseRow.scene_id) {
    try {
      const sc = db.prepare('SELECT location FROM scenes WHERE id = ?').get(baseRow.scene_id);
      if (sc?.location) sceneLocation = sc.location;
    } catch (_) {}
  }

  const userPromptLines = [
    `【原分镜基本信息】`,
    `镜头序号：第 ${baseRow.storyboard_number ?? '?'} 镜`,
    `标题：${baseRow.title || '未命名'}`,
    `原时长：${baseRow.duration || 5} 秒`,
    `景别与运镜：${baseRow.shot_type || '中景'} · ${baseRow.movement || '固定'}`,
    `场景地点：${sceneLocation || baseRow.location || '未知'}`,
    `出场角色：${characterNames.join('、') || '暂无'}`,
    `动作（Action）：${baseRow.action || '无'}`,
    `结果（Result）：${baseRow.result || '无'}`,
    `对白（Dialogue）：${baseRow.dialogue || '无'}`,
    `旁白（Narration）：${baseRow.narration || '无'}`,
    `原画面描述（Prompt）：${baseRow.image_prompt || '无'}`,
    '',
    `【拆分要求】`,
    `目标镜头数：拆分为 ${requestedCount} 个子镜头（可依据剧情自然切分，每个镜头时长 4~30 秒整数；超过8秒的逻辑镜头使用Continuum）。`,
    userInstruction ? `【用户指定拆分方向 / 重点要求】（最高优先级，必须服从）：\n${userInstruction}\n` : null,
    `请将原分镜中的复合动作按因果与时间线拆分为 ${requestedCount} 个连续子镜头，输出严格合法的 JSON 数组。`,
  ].filter(Boolean);

  log.info('[分镜AI拆分] 开始请求 AI 拆镜', {
    sb_id: sbId,
    requested_count: requestedCount,
    has_instruction: !!userInstruction,
  });

  const responseText = await aiClient.generateText(
    db,
    log,
    'text',
    userPromptLines.join('\n'),
    getStoryboardSplitSystemPrompt(),
    {
      scene_key: 'storyboard_create',
      max_tokens: 2200,
      temperature: 0.3,
    }
  );

  const subShots = extractJsonArray(responseText);
  if (!subShots || !Array.isArray(subShots) || subShots.length < 2) {
    log.error('[分镜AI拆分] AI 返回未成功解析为有效子镜头数组', { raw: (responseText || '').slice(0, 300) });
    throw new Error('AI 生成拆分分镜格式异常，请重试或更换文本模型');
  }
  const durations = subShots.map((shot, index) => {
    const duration = Number(shot.duration);
    if (!Number.isInteger(duration) || duration < 4 || duration > 30) {
      throw new Error(`AI 拆分结果第 ${index + 1} 镜 duration 必须是 4～30 秒整数，当前为 ${shot.duration ?? '空'}；后端不会静默改写`);
    }
    return duration;
  });

  log.info('[分镜AI拆分] 成功获取子镜头列表', {
    count: subShots.length,
    titles: subShots.map(s => s.title),
  });

  const now = new Date().toISOString();
  const episodeId = baseRow.episode_id;
  const baseNumber = Number(baseRow.storyboard_number) || 1;
  const extraCount = subShots.length - 1;

  const storyboardIds = [];

  // 在事务中执行数据库写入
  const runTransaction = db.transaction(() => {
    // 1. 将后续镜头的编号顺延 extraCount
    if (extraCount > 0) {
      db.prepare(
        `UPDATE storyboards SET storyboard_number = storyboard_number + ?, updated_at = ?
         WHERE episode_id = ? AND storyboard_number > ? AND deleted_at IS NULL`
      ).run(extraCount, now, episodeId, baseNumber);
    }

    // 2. 更新原镜头为第 1 个子镜头
    const firstPlan = subShots[0];
    const dur1 = durations[0];
    db.prepare(
      `UPDATE storyboards SET
        title = ?, duration = ?, dialogue = ?, narration = ?, action = ?, result = ?,
        atmosphere = ?, shot_type = ?, movement = ?, image_prompt = ?,
        universal_segment_text = NULL, video_prompt = NULL, video_url = NULL,
        audio_local_path = NULL, narration_audio_local_path = NULL,
        status = 'pending', updated_at = ?
       WHERE id = ? AND deleted_at IS NULL`
    ).run(
      String(firstPlan.title || `${baseRow.title || '分镜'}-1`).trim(),
      dur1,
      firstPlan.dialogue ? String(firstPlan.dialogue).trim() : null,
      firstPlan.narration ? String(firstPlan.narration).trim() : null,
      firstPlan.action ? String(firstPlan.action).trim() : null,
      firstPlan.result ? String(firstPlan.result).trim() : null,
      firstPlan.atmosphere ? String(firstPlan.atmosphere).trim() : (baseRow.atmosphere ?? null),
      firstPlan.shot_type ? String(firstPlan.shot_type).trim() : (baseRow.shot_type ?? null),
      firstPlan.movement ? String(firstPlan.movement).trim() : (baseRow.movement ?? null),
      firstPlan.image_prompt ? String(firstPlan.image_prompt).trim() : (baseRow.image_prompt ?? null),
      now,
      sbId
    );
    storyboardIds.push(sbId);

    // 3. 插入后续子镜头
    const insertStmt = db.prepare(
      `INSERT INTO storyboards (
        episode_id, scene_id, storyboard_number, title, description, layout_description,
        location, time, duration, dialogue, narration, action, result, atmosphere,
        image_prompt, characters, shot_type, angle, angle_h, angle_v, angle_s,
        movement, lighting_style, depth_of_field, segment_index, segment_title,
        creation_mode, universal_segment_text, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    );

    for (let i = 1; i < subShots.length; i++) {
      const plan = subShots[i];
      const newNum = baseNumber + i;
      const dur = durations[i];
      const info = insertStmt.run(
        episodeId,
        baseRow.scene_id ?? null,
        newNum,
        String(plan.title || `${baseRow.title || '分镜'}-${i + 1}`).trim(),
        baseRow.description ?? null,
        baseRow.layout_description ?? null,
        baseRow.location ?? null,
        baseRow.time ?? null,
        dur,
        plan.dialogue ? String(plan.dialogue).trim() : null,
        plan.narration ? String(plan.narration).trim() : null,
        plan.action ? String(plan.action).trim() : null,
        plan.result ? String(plan.result).trim() : null,
        plan.atmosphere ? String(plan.atmosphere).trim() : (baseRow.atmosphere ?? null),
        plan.image_prompt ? String(plan.image_prompt).trim() : (baseRow.image_prompt ?? null),
        baseRow.characters ?? null,
        plan.shot_type ? String(plan.shot_type).trim() : (baseRow.shot_type ?? null),
        baseRow.angle ?? null,
        baseRow.angle_h ?? null,
        baseRow.angle_v ?? null,
        baseRow.angle_s ?? null,
        plan.movement ? String(plan.movement).trim() : (baseRow.movement ?? null),
        baseRow.lighting_style ?? null,
        baseRow.depth_of_field ?? null,
        baseRow.segment_index ?? null,
        baseRow.segment_title ?? null,
        baseRow.creation_mode === 'universal' ? 'universal' : 'classic',
        null,
        now,
        now
      );
      const newId = Number(info.lastInsertRowid);
      episodeStoryboardService.copyStoryboardAssetLinks(db, sbId, newId);
      storyboardIds.push(newId);
    }
  });

  runTransaction();

  // 4. 重建所有生成镜头的 video_prompt
  for (const id of storyboardIds) {
    try {
      episodeStoryboardService.rebuildVideoPromptForStoryboard(db, log, id);
    } catch (e) {
      log.warn('[分镜AI拆分] rebuildVideoPromptForStoryboard 失败（继续）', { id, error: e.message });
    }
  }

  log.info('[分镜AI拆分] 拆分成功并入库', {
    source_id: sbId,
    total_shots: storyboardIds.length,
    ids: storyboardIds,
  });

  return {
    ok: true,
    source_id: sbId,
    count: storyboardIds.length,
    storyboard_ids: storyboardIds,
    storyboards: storyboardIds.map((id) => storyboardService.getStoryboardById(db, id)),
  };
}

module.exports = {
  getStoryboardSplitSystemPrompt,
  extractJsonArray,
  splitStoryboardWithAi,
};
