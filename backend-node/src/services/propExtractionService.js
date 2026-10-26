const referenceModes = require('./referenceImageModeService');
// 与 Go PropService.ExtractPropsFromScript + processPropExtraction 对齐：从剧本提取道具
const taskService = require('./taskService');
const aiClient = require('./aiClient');
const promptI18n = require('./promptI18n');
const propService = require('./propService');
const reuse = require('./extractionReuseService');
const { safeParseAIJSON, extractFirstArray } = require('../utils/safeJson');

async function processPropExtraction(db, log, taskId, episodeId, suppliedCfg) {
  taskService.updateTaskStatus(db, taskId, 'processing', 0, '正在分析剧本...');

  const episode = db.prepare(
    'SELECT id, drama_id, script_content FROM episodes WHERE id = ? AND deleted_at IS NULL'
  ).get(Number(episodeId));
  if (!episode) {
    taskService.updateTaskError(db, taskId, '剧集不存在');
    return;
  }

  const scriptContent = episode.script_content;
  if (!scriptContent || !String(scriptContent).trim()) {
    taskService.updateTaskError(db, taskId, '剧本内容为空');
    return;
  }

  const loadConfig = require('../config').loadConfig;
  let cfg = suppliedCfg || loadConfig();
  // 用项目的 aspect_ratio 和 style 覆盖全局配置，使 image_prompt 使用正确比例和风格
  try {
    const dramaRow = db.prepare('SELECT style, metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(episode.drama_id);
    if (dramaRow) {
      const { mergeCfgStyleWithDrama } = require('../utils/dramaStyleMerge');
      let next = { ...cfg, style: { ...(cfg?.style || {}), default_prop_style: '' } };
      if (dramaRow.metadata) {
        const meta = typeof dramaRow.metadata === 'string' ? JSON.parse(dramaRow.metadata) : dramaRow.metadata;
        if (meta && meta.aspect_ratio) {
          next.style.default_prop_ratio = meta.aspect_ratio;
          next.style.default_image_ratio = meta.aspect_ratio;
        }
      }
      cfg = mergeCfgStyleWithDrama(next, dramaRow);
    }
  } catch (_) {}
  const known = reuse.catalog(db, episode.drama_id, 'prop');
  const systemPrompt = promptI18n.getPropExtractionPrompt(cfg) + reuse.instructions('prop') + referenceModes.extractionInstructions('prop');
  const contentLabel = promptI18n.isEnglish(cfg) ? '[Script Content]\n' : '【剧本内容】\n';
  const prompt = contentLabel + String(scriptContent).trim() + reuse.promptContext(known);

  let response;
  try {
    response = await aiClient.generateText(db, log, 'text', prompt, systemPrompt, {
      scene_key: 'prop_extraction',
      max_tokens: 2000,
      temperature: 0.3,
    });
  } catch (err) {
    log.error('Prop extraction AI failed', { error: err.message, task_id: taskId });
    taskService.updateTaskError(db, taskId, 'AI 提取失败: ' + (err.message || '未知错误'));
    return;
  }

  let extractedProps = [];
  try {
    const parsed = safeParseAIJSON(response, log);
    extractedProps = extractFirstArray(parsed);
    if (!Array.isArray(extractedProps)) throw new Error('道具提取未返回数组');
  } catch (_) {
    taskService.updateTaskError(db, taskId, '解析 AI 返回的 JSON 失败');
    return;
  }

  taskService.updateTaskStatus(db, taskId, 'processing', 50, '正在保存道具...');

  const dramaId = episode.drama_id;
  let createdProps;
  const newProps = [];
  try {
    createdProps = db.transaction(() => {
      const current = reuse.catalog(db, dramaId, 'prop');
      const resolved = extractedProps.map(item => reuse.resolve(current, item));
      const selected = new Map();
      for (const choice of resolved) {
        let prop = choice.existing;
        if (!prop) {
          const data = choice.library || choice.fresh;
          prop = current.resources.find(p => p.name.trim() === data.name.trim());
          if (!prop) {
            prop = propService.create(db, log, {
              drama_id: dramaId,
              episode_id: episodeId,
              name: data.name,
              type: data.type ?? null,
              description: data.description ?? null,
              prompt: choice.library ? data.prompt : data.image_prompt,
              ...(choice.library ? { image_url: data.image_url, local_path: data.local_path } : {}),
            });
            current.resources.push(prop);
            if (!choice.library) newProps.push(prop);
          }
        }
        const item = extractedProps[resolved.indexOf(choice)];
        if (!choice.existing || item.reference_image_mode != null) referenceModes.saveAdvice(db, 'prop', prop.id, item);
        prop = propService.getById(db, prop.id);
        selected.set(prop.id, prop);
      }
      // Props belong to the drama. Do not delete another episode's shared prop
      // or overwrite the reference description/image when extracting again.
      return [...selected.values()];
    })();
  } catch (err) {
    log.error('Prop reuse validation failed', { error: err.message, task_id: taskId });
    taskService.updateTaskError(db, taskId, '道具保存失败，原有资源未修改: ' + err.message);
    return;
  }
  for (const prop of newProps) {
    if (!prop.prompt) setImmediate(() => {
      propService.generatePropPromptOnly(db, log, cfg, prop.id, undefined, undefined).catch((err) => {
        log.warn('[提取道具] 预生成提示词失败', { prop_id: prop.id, error: err.message });
      });
    });
  }

  taskService.updateTaskResult(db, taskId, {
    props: createdProps,
    count: createdProps.length,
    episode_id: episodeId,
    drama_id: dramaId,
  });
  log.info('Prop extraction completed', {
    task_id: taskId,
    episode_id: episodeId,
    count: createdProps.length,
  });
}

function extractPropsForEpisode(db, log, episodeId, cfg) {
  const episode = db.prepare(
    'SELECT id, drama_id, script_content FROM episodes WHERE id = ? AND deleted_at IS NULL'
  ).get(Number(episodeId));
  if (!episode) throw new Error('episode not found');
  if (!episode.script_content || !String(episode.script_content).trim()) {
    throw new Error('剧集剧本内容为空，无法提取道具');
  }

  const task = taskService.createTask(db, log, 'prop_extraction', String(episodeId));
  setImmediate(() => {
    processPropExtraction(db, log, task.id, episodeId, cfg).catch((err) => {
      log.error('processPropExtraction fatal', { error: err.message, task_id: task.id });
    });
  });
  return task.id;
}

module.exports = {
  extractPropsForEpisode,
  processPropExtraction,
};
