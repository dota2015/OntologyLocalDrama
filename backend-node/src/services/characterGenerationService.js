
const taskService = require('./taskService');
const aiClient = require('./aiClient');
const promptI18n = require('./promptI18n');
const { safeParseAIJSON, extractFirstArray } = require('../utils/safeJson');
const characterLibraryService = require('./characterLibraryService');
const { mergeCfgStyleWithDrama } = require('../utils/dramaStyleMerge');
const reuse = require('./extractionReuseService');

/**
 * 从角色外貌描述中提炼 6层视觉锚点，写入 characters.identity_anchors
 * 异步后台执行，不阻塞角色生成主流程
 */
async function enrichIdentityAnchors(db, log, characterId, appearance) {
  if (!appearance || !String(appearance).trim()) return;
  try {
    const systemPrompt = promptI18n.getIdentityAnchorsPrompt();
    const userPrompt = `Character appearance description:\n${appearance}`;
    const raw = await aiClient.generateText(db, log, 'text', userPrompt, systemPrompt, {
      scene_key: 'identity_anchors',
      max_tokens: 800,
      temperature: 0.1,
    });
    const anchors = safeParseAIJSON(raw, log);
    if (!anchors || typeof anchors !== 'object') return;
    const colorPalette = anchors.color_anchors ? JSON.stringify(Object.values(anchors.color_anchors)) : null;
    db.prepare(
      'UPDATE characters SET identity_anchors = ?, color_palette = ?, updated_at = ? WHERE id = ?'
    ).run(JSON.stringify(anchors), colorPalette, new Date().toISOString(), characterId);
    log.info('[锚点] identity_anchors 提炼完成', { character_id: characterId });
  } catch (err) {
    log.warn('[锚点] identity_anchors 提炼失败', { character_id: characterId, error: err.message });
  }
}

async function processCharacterGeneration(db, cfg, log, taskID, req) {
  taskService.updateTaskStatus(db, taskID, 'processing', 0, '正在生成角色...');
  let outlineText = req.outline || '';

  // 读取剧的 style 和 metadata.aspect_ratio，覆盖全局 cfg
  let effectiveCfg = cfg;
  const dramaRow = db.prepare('SELECT id, title, description, genre, style, metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(Number(req.drama_id));
  if (!dramaRow) {
    taskService.updateTaskStatus(db, taskID, 'failed', 0, '剧本信息不存在');
    return;
  }
  try {
    let next = { ...cfg, style: { ...(cfg?.style || {}) } };
    if (dramaRow.metadata) {
      const meta = typeof dramaRow.metadata === 'string' ? JSON.parse(dramaRow.metadata) : dramaRow.metadata;
      if (meta && meta.aspect_ratio) {
        next.style.default_image_ratio = meta.aspect_ratio;
      }
    }
    effectiveCfg = mergeCfgStyleWithDrama(next, dramaRow);
  } catch (_) {}

  if (!outlineText) {
    outlineText = promptI18n.formatUserPrompt(
      effectiveCfg,
      'drama_info_template',
      dramaRow.title || '',
      dramaRow.description || '',
      dramaRow.genre || ''
    );
  }
  const known = reuse.catalog(db, req.drama_id, 'character');
  const userPrompt = promptI18n.formatUserPrompt(effectiveCfg, 'character_request', outlineText) + reuse.promptContext(known);
  const systemPrompt = promptI18n.getCharacterExtractionPrompt(effectiveCfg) + reuse.instructions('character');
  const temperature = req.temperature != null ? req.temperature : 0.7;

  // 固定 6000 tokens：足够约 10-12 个角色（每角色约 400-500 tokens）
  // repairTruncatedJsonArray 兜底处理极端截断情况
  const maxTokensForChars = 6000;

  let text;
  try {
    text = await aiClient.generateText(db, log, 'text', userPrompt, systemPrompt, {
      scene_key: 'role_extraction',
      model: req.model || undefined,
      temperature,
      max_tokens: maxTokensForChars,
    });
  } catch (err) {
    log.error('Character generation AI failed', { error: err.message, task_id: taskID });
    taskService.updateTaskStatus(db, taskID, 'failed', 0, 'AI生成失败: ' + err.message);
    return;
  }

  console.log('[角色生成] AI 原始返回：\n' + text);

  let result;
  try {
    const parsed = safeParseAIJSON(text, log);
    result = extractFirstArray(parsed);
    if (!Array.isArray(result)) throw new Error('角色提取未返回数组');
  } catch (err) {
    log.error('Character generation parse failed', { error: err.message, task_id: taskID });
    console.error('[角色生成] JSON解析失败，原始内容：\n' + text);
    taskService.updateTaskStatus(db, taskID, 'failed', 0, '解析AI返回结果失败');
    return;
  }

  const dramaId = Number(req.drama_id);
  let characters;
  const newlyCreated = [];
  try {
    characters = db.transaction(() => {
      // Re-read after the model call; deleted/cross-drama references must fail
      // before replacing any episode associations.
      const current = reuse.catalog(db, dramaId, 'character');
      const resolved = result.map(item => reuse.resolve(current, item));
      if (req.episode_id && !db.prepare('SELECT id FROM episodes WHERE id = ? AND drama_id = ? AND deleted_at IS NULL').get(Number(req.episode_id), dramaId)) {
        throw new Error('分集不属于当前剧');
      }
      const selected = new Map();
      for (const choice of resolved) {
        let row = choice.existing;
        if (!row) {
          const data = choice.library || choice.fresh;
          // Deduplicate repeated mentions within this extraction too.
          row = current.resources.find(c => c.name.trim() === data.name.trim());
          if (!row) {
            const fields = ['name', 'role', 'description', 'personality', 'appearance', 'voice_style'];
            if (choice.library) fields.push('image_url', 'local_path', 'identity_anchors', 'style_tokens', 'color_palette', 'four_view_image_url');
            const now = new Date().toISOString();
            const info = db.prepare(`INSERT INTO characters (drama_id, ${fields.join(', ')}, sort_order, created_at, updated_at)
              VALUES (?, ${fields.map(() => '?').join(', ')}, 0, ?, ?)`)
              .run(dramaId, ...fields.map(key => data[key] ?? null), now, now);
            row = db.prepare('SELECT * FROM characters WHERE id = ?').get(info.lastInsertRowid);
            current.resources.push(row);
            if (!choice.library) newlyCreated.push(row);
          }
        }
        selected.set(row.id, row);
      }
      if (req.episode_id) {
        db.prepare('DELETE FROM episode_characters WHERE episode_id = ?').run(Number(req.episode_id));
        const link = db.prepare('INSERT OR IGNORE INTO episode_characters (episode_id, character_id) VALUES (?, ?)');
        for (const row of selected.values()) link.run(Number(req.episode_id), row.id);
      }
      // Existing characters remain in the drama catalog even when absent in this episode.
      return [...selected.values()];
    })();
  } catch (err) {
    log.error('Character reuse validation failed', { error: err.message, task_id: taskID });
    taskService.updateTaskError(db, taskID, '角色保存失败，原有资源未修改: ' + err.message);
    return;
  }
  for (const row of newlyCreated) {
    if (row.appearance) setImmediate(() => {
      enrichIdentityAnchors(db, log, row.id, row.appearance).catch(() => {});
      characterLibraryService.generateCharacterPromptOnly(db, log, effectiveCfg, row.id, undefined, undefined).catch((err) => {
        log.warn('[提取角色] 预生成polished_prompt失败', { character_id: row.id, error: err.message });
      });
    });
  }

  taskService.updateTaskResult(db, taskID, { characters, count: characters.length });
  log.info('Character generation completed', { task_id: taskID, drama_id: req.drama_id, character_count: characters.length });
}

function generateCharacters(db, cfg, log, req) {
  const dramaId = String(req.drama_id || '');
  if (!dramaId) throw new Error('drama_id 必填');
  const task = taskService.createTask(db, log, 'character_generation', dramaId);
  setImmediate(() => {
    processCharacterGeneration(db, cfg, log, task.id, {
      drama_id: req.drama_id,
      episode_id: req.episode_id,
      outline: req.outline,
      temperature: req.temperature,
      model: req.model,
    }).catch((err) => {
      log.error('processCharacterGeneration fatal', { error: err.message, task_id: task.id });
    });
  });
  return task.id;
}

module.exports = {
  generateCharacters,
  processCharacterGeneration,
  enrichIdentityAnchors,
};
