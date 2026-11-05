/**
 * 影视视听本体服务路由（Audiovisual Drama Ontology Routes）
 * 提供：
 * 1. 语义包查询：查看当前不可变 DramaSemanticPackage
 * 2. 视听门禁质检：对分镜运行 SHACL 风格的硬约束检验
 * 3. 实体统一抽取：从剧本一次性提取角色、道具、场景空间地标
 * 4. 导演智能体生成：启动导演 Agent 闭环推演与自纠审校
 */

const response = require('../response');
const { compileDramaSemanticPackage } = require('../ontology/semanticPackage');
const { validateAllInvariants } = require('../ontology/invariants');
const { extractAllEntitiesFromScript, autocompleteEntityFromScript } = require('../ontology/extractionAgent');
const { runDirectorAgent, runFullDramaDirectorAgent, refineSingleStoryboard } = require('../ontology/directorAgent');
const { enrichEpisodeOntologySlots, runTwoStageDirectorPipeline } = require('../ontology/directorEnrichmentService');
const taskService = require('../services/taskService');
const directorCheckpoint = require('../services/directorCheckpoint');
const { withTaskTokenUsage } = require('../services/agentTokenUsage');
const { withTaskTrace } = require('../services/directorTrace');
const runDirectorTask = (db, taskId, work) => withTaskTrace(db, taskId, () => withTaskTokenUsage(db, taskId, work));
const { loadConfig } = require('../config');

function ontologyRoutes(db, log) {
  return {
    // 获取当前剧集的不可变本体语义包
    getSemanticPackage: (req, res) => {
      try {
        const episodeId = Number(req.params.episode_id);
        const pkg = compileDramaSemanticPackage(db, episodeId);
        response.success(res, {
          semantic_revision: pkg.semantic_revision,
          drama: pkg.drama,
          episode: pkg.episode,
          catalogs: pkg.catalogs,
        });
      } catch (err) {
        log.error('ontology getSemanticPackage', { error: err.message });
        response.badRequest(res, err.message);
      }
    },

    // 运行全套视听本体质量门禁（SHACL-like Invariants Check）
    validateEpisodeInvariants: (req, res) => {
      try {
        const episodeId = Number(req.params.episode_id);
        const pkg = compileDramaSemanticPackage(db, episodeId);
        let shots = [];
        if (Array.isArray(req.body?.storyboards) && req.body.storyboards.length > 0) {
          // 允许直接校验内存中的候选分镜（支持「校验候选→结构化退回→原子保存」，无需预先落库）
          shots = req.body.storyboards;
        } else {
          shots = db.prepare('SELECT * FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL ORDER BY storyboard_number ASC').all(episodeId);

          // 挂载当前集各分镜关联的道具 ID（storyboard_props）
          const sbIds = shots.map(s => s.id);
          if (sbIds.length > 0) {
            const placeholders = sbIds.map(() => '?').join(',');
            const spRows = db.prepare(`SELECT storyboard_id, prop_id FROM storyboard_props WHERE storyboard_id IN (${placeholders})`).all(...sbIds);
            const propMap = {};
            for (const row of spRows) {
              if (!propMap[row.storyboard_id]) propMap[row.storyboard_id] = [];
              propMap[row.storyboard_id].push(row.prop_id);
            }
            for (const s of shots) {
              s.prop_ids = propMap[s.id] || [];
            }
          }
        }

        // 读取全剧剧本与全剧分镜，作为跨集世界观资产生命周期的判定依据，防止将其他集专属道具/角色误报为废弃
        const dramaId = pkg.episode?.drama_id || pkg.drama?.id;
        let fullDramaScript = pkg.episode.script_content || '';
        let allDramaShots = shots;
        if (dramaId) {
          try {
            const allEps = db.prepare('SELECT script_content FROM episodes WHERE drama_id = ? AND deleted_at IS NULL').all(dramaId);
            fullDramaScript = allEps.map(e => e.script_content || '').join('\n');
            allDramaShots = db.prepare(`
              SELECT s.id, s.scene_id, s.characters, sp.prop_id
              FROM storyboards s
              JOIN episodes e ON e.id = s.episode_id
              LEFT JOIN storyboard_props sp ON sp.storyboard_id = s.id
              WHERE e.drama_id = ? AND s.deleted_at IS NULL
            `).all(dramaId);
          } catch (_) {}
        }

        const audit = validateAllInvariants(shots, {
          db,
          props: pkg.catalogs.props,
          dramaEra: pkg.drama.era,
          catalogs: pkg.catalogs,
          scriptContent: fullDramaScript,
          dramaShots: allDramaShots,
        });

        response.success(res, {
          semantic_revision: pkg.semantic_revision,
          total_shots: shots.length,
          audit,
        });
      } catch (err) {
        log.error('ontology validateEpisodeInvariants', { error: err.message });
        response.internalError(res, err.message);
      }
    },

    // 从剧本一次性抽取角色、道具、场景空间地标
    extractEntities: async (req, res) => {
      try {
        const episodeId = Number(req.params.episode_id);
        const cfg = loadConfig();
        const result = await extractAllEntitiesFromScript(db, log, cfg, episodeId);
        response.success(res, result);
      } catch (err) {
        log.error('ontology extractEntities', { error: err.message });
        response.badRequest(res, err.message);
      }
    },

    // 智能清理剧目中已过时、无任何引用的残留道具
    reconcileDramaAssets: (req, res) => {
      try {
        const dramaId = Number(req.params.drama_id);
        const { reconcileObsoleteDramaAssets } = require('../ontology/directorAgent');
        const result = reconcileObsoleteDramaAssets(db, log, dramaId);
        response.success(res, result);
      } catch (err) {
        log.error('ontology reconcileDramaAssets', { error: err.message });
        response.badRequest(res, err.message);
      }
    },

    // 启动导演智能体生成全集分镜（规划 -> 推演 -> 审校自省 -> 入库）
    directorGenerate: async (req, res) => {
      try {
        const episodeId = Number(req.params.episode_id);
        const cfg = loadConfig();
        const active = db.prepare(`SELECT id FROM async_tasks WHERE resource_id=? AND type='director_storyboard_generation'
          AND status IN ('pending','processing') AND deleted_at IS NULL`).get(String(episodeId));
        if (active) return response.error(res, 409, 'DIRECTOR_ACTIVE', '当前集已有导演任务运行，请等待完成或停止后再操作', { task_id: active.id });
        let requestOptions = req.body || {};
        if (requestOptions.resume_task_id) {
          const saved = directorCheckpoint.requireResume(db, requestOptions.resume_task_id, episodeId, cfg);
          // Resume uses the original creative inputs, never silently the current form.
          requestOptions = { ...saved.options, resume_task_id: requestOptions.resume_task_id };
        }
        const task = taskService.createTask(db, log, 'director_storyboard_generation', String(episodeId));
        const taskId = task.id;

        // 异步后台运行导演智能体
        (async () => {
          taskService.updateTaskStatus(db, taskId, 'processing', 5, '导演智能体正在准备视听本体调度...');
          try {
            const options = {
              ...requestOptions,
              taskId,
              onProgress: (pct, msg) => {
                if (!['pending', 'processing'].includes(taskService.getTask(db, taskId)?.status)) throw new Error('导演任务已停止，检查点已保留');
                taskService.updateTaskStatus(db, taskId, 'processing', pct, msg);
              },
            };
            const runner = options.mode === 'deep_react'
              ? () => runDirectorAgent(db, log, cfg, episodeId, options)
              : () => runTwoStageDirectorPipeline(db, log, cfg, episodeId, options);
            const result = await runDirectorTask(db, taskId, runner);
            taskService.updateTaskStatus(db, taskId, 'completed', 100, '视听本体硬门禁审查与自纠完毕，分镜已入库。');
            taskService.updateTaskResult(db, taskId, result);
          } catch (agentErr) {
            log.error('directorGenerate task failed', { error: agentErr.message, task_id: taskId });
            taskService.updateTaskError(db, taskId, agentErr.message || '导演智能体推演失败', {
              valid: false,
              violations: agentErr.violations || [],
              status: agentErr.status || 422,
              planning_advice: agentErr.planning_advice || null,
              token_usage: agentErr.token_usage,
              trace_file: agentErr.trace_file,
            });
          }
        })();

        response.success(res, {
          task_id: taskId,
          status: 'pending',
          message: '导演视听智能体任务已启动，正在进行场面调度与质检自省推演...',
        });
      } catch (err) {
        log.error('ontology directorGenerate', { error: err.message });
        response.badRequest(res, err.message);
      }
    },

    // 独立执行阶段二：为现有基础分镜批量装配视听本体槽位（后台任务，可刷新恢复）
    enrichSlots: async (req, res) => {
      try {
        const episodeId = Number(req.params.episode_id);
        const cfg = loadConfig();
        const active = db.prepare(`SELECT id FROM async_tasks WHERE resource_id=? AND type='director_ontology_enrichment'
          AND status IN ('pending','processing') AND deleted_at IS NULL`).get(String(episodeId));
        if (active) return response.error(res, 409, 'ONTOLOGY_ENRICH_ACTIVE', '当前集已有视听槽位任务运行，请等待完成或停止后再操作', { task_id: active.id });
        const task = taskService.createTask(db, log, 'director_ontology_enrichment', String(episodeId));
        const taskId = task.id;
        (async () => {
          taskService.updateTaskStatus(db, taskId, 'processing', 5, '正在读取基础分镜与本体资产...');
          try {
            const result = await runDirectorTask(db, taskId, () => enrichEpisodeOntologySlots(db, log, cfg, episodeId, {
              ...(req.body || {}),
              taskId,
              onProgress: (pct, message) => {
                const current = taskService.getTask(db, taskId);
                if (!current || !['pending', 'processing'].includes(current.status)) throw new Error('视听槽位任务已停止');
                taskService.updateTaskStatus(db, taskId, 'processing', pct, message);
              },
            }));
            taskService.updateTaskResult(db, taskId, result);
          } catch (err) {
            log.error('ontology enrichSlots task failed', { error: err.message, task_id: taskId });
            taskService.updateTaskError(db, taskId, err.message || '视听槽位 Agent 规划失败', {
              valid: false,
              violations: err.violations || [],
              audit: err.audit || null,
              status: err.status || 422,
            });
          }
        })();
        response.success(res, {
          task_id: taskId,
          status: 'pending',
          message: '视听槽位 Agent 后台任务已启动，页面刷新不会丢失进度。',
        });
      } catch (err) {
        log.error('ontology enrichSlots', { error: err.message });
        response.badRequest(res, err.message);
      }
    },

    // 启动全生命周期全剧导演智能体（故事梗概 ➔ 多集剧本 ➔ 角色/道具尺寸/场景地标抽取 ➔ 逐集动态分镜与BGM ➔ SHACL门禁自检自纠）
    directorFullPipeline: async (req, res) => {
      try {
        const dramaId = Number(req.params.drama_id);
        const cfg = loadConfig();
        const task = taskService.createTask(db, log, 'director_full_pipeline_generation', String(dramaId));
        const taskId = task.id;

        // 异步后台全生命周期推演
        (async () => {
          taskService.updateTaskStatus(db, taskId, 'processing', 5, '全生命周期导演智能体已就绪，正在准备推演...');
          try {
            const result = await runDirectorTask(db, taskId, () => runFullDramaDirectorAgent(db, log, cfg, dramaId, req.body || {}, (progress, message) => {
              taskService.updateTaskStatus(db, taskId, 'processing', progress, message);
            }));
            taskService.updateTaskResult(db, taskId, result);
          } catch (agentErr) {
            log.error('directorFullPipeline task failed', { error: agentErr.message, task_id: taskId });
            taskService.updateTaskError(db, taskId, agentErr.message || '全流程导演智能体推演失败', {
              token_usage: agentErr.token_usage,
              trace_file: agentErr.trace_file,
              valid: false,
              violations: agentErr.violations || [],
              status: agentErr.status || 422,
            });
          }
        })();

        response.success(res, {
          task_id: taskId,
          status: 'pending',
          message: '全生命周期导演智能体已启动，正在执行【故事梗概 ➔ 多集剧本 ➔ 角色/道具/场景抽取 ➔ 逐集动态分镜 ➔ 门禁自纠】闭环推演...',
        });
      } catch (err) {
        log.error('ontology directorFullPipeline', { error: err.message });
        response.internalError(res, err.message);
      }
    },

    // 针对单个分镜的导演定向原子微调（微观流程：针对特定元素调整）
    refineStoryboard: async (req, res) => {
      try {
        const storyboardId = Number(req.params.id);
        const cfg = loadConfig();
        const instruction = (req.body?.instruction || req.body?.user_feedback || req.body?.directives || '').trim();
        if (!Number.isFinite(storyboardId) || storyboardId <= 0) {
          return response.badRequest(res, '分镜 ID 无效');
        }
        if (!instruction) {
          return response.badRequest(res, '请提供针对该分镜的具体导演调整指令');
        }
        const storyboard = db.prepare(
          'SELECT id, storyboard_number FROM storyboards WHERE id = ? AND deleted_at IS NULL'
        ).get(storyboardId);
        if (!storyboard) return response.notFound(res, '分镜不存在');

        const task = taskService.createTask(db, log, 'director_storyboard_refinement', String(storyboardId));
        const taskId = task.id;
        (async () => {
          taskService.updateTaskStatus(db, taskId, 'processing', 5, `导演 Agent 正在读取第 ${storyboard.storyboard_number} 镜及本集记忆...`);
          try {
            const result = await runDirectorTask(db, taskId, () => refineSingleStoryboard(db, log, cfg, storyboardId, instruction, {
              maxReflectionRounds: req.body?.max_reflection_rounds,
              onProgress: (pct, msg) => taskService.updateTaskStatus(db, taskId, 'processing', pct, msg),
            }));
            taskService.updateTaskResult(db, taskId, result);
          } catch (agentErr) {
            log.error('refineStoryboard task failed', { error: agentErr.message, task_id: taskId, storyboard_id: storyboardId });
            taskService.updateTaskError(db, taskId, agentErr.message || '导演单镜微调失败', {
              token_usage: agentErr.token_usage,
              trace_file: agentErr.trace_file,
              valid: false,
              violations: agentErr.violations || [],
              status: agentErr.status || 422,
            });
          }
        })();

        response.success(res, {
          task_id: taskId,
          status: 'pending',
          storyboard_id: storyboardId,
          storyboard_number: storyboard.storyboard_number,
          message: '导演单镜微调已转入后台，刷新页面后仍可恢复进度。',
        });
      } catch (err) {
        log.error('ontology refineStoryboard', { error: err.message });
        response.internalError(res, err.message);
      }
    },

    // 人机协同：结合剧本与世界观智能补全实体属性（角色/道具/场景）
    autocompleteEntity: async (req, res) => {
      try {
        const dramaId = Number(req.params.drama_id);
        const { entity_type, name, episode_id, hint } = req.body || {};
        if (!entity_type || !name || !String(name).trim()) {
          return response.badRequest(res, 'entity_type 与 name 不能为空');
        }
        const cfg = loadConfig();
        const result = await autocompleteEntityFromScript(db, log, cfg, {
          dramaId,
          episodeId: episode_id ? Number(episode_id) : null,
          entityType: String(entity_type).trim(),
          name: String(name).trim(),
          hint: hint ? String(hint).trim() : '',
        });
        response.success(res, result);
      } catch (err) {
        log.error('ontology autocompleteEntity', { error: err.message });
        response.badRequest(res, err.message);
      }
    },

    // 查询视听本体槽位统一数据字典规范
    getDataDictionary: (req, res) => {
      try {
        const { AUDIOTISUAL_DATA_DICTIONARY } = require('../ontology/schema');
        response.success(res, AUDIOTISUAL_DATA_DICTIONARY);
      } catch (err) {
        log.error('ontology getDataDictionary', { error: err.message });
        response.badRequest(res, err.message);
      }
    },
  };
}

module.exports = ontologyRoutes;
