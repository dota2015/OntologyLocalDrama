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
const taskService = require('../services/taskService');
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
        const shots = db.prepare('SELECT * FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL ORDER BY storyboard_number ASC').all(episodeId);

        const audit = validateAllInvariants(shots, {
          db,
          props: pkg.catalogs.props,
          dramaEra: pkg.drama.era,
          catalogs: pkg.catalogs,
          scriptContent: pkg.episode.script_content,
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
        const task = taskService.createTask(db, log, 'director_storyboard_generation', String(episodeId));
        const taskId = task.id;

        // 异步后台运行导演智能体
        (async () => {
          taskService.updateTaskStatus(db, taskId, 'processing', 10, '导演智能体正在阅读剧本并编译本体语义包...');
          try {
            taskService.updateTaskStatus(db, taskId, 'processing', 40, '导演智能体正在推演场面调度与动态机位...');
            const result = await runDirectorAgent(db, log, cfg, episodeId, req.body || {});
            taskService.updateTaskStatus(db, taskId, 'processing', 85, '视听本体硬门禁审查与自纠完毕，正在入库...');
            taskService.updateTaskResult(db, taskId, result);
          } catch (agentErr) {
            log.error('directorGenerate task failed', { error: agentErr.message, task_id: taskId });
            taskService.updateTaskError(db, taskId, agentErr.message || '导演智能体推演失败');
          }
        })();

        response.success(res, {
          task_id: taskId,
          status: 'pending',
          message: '导演视听智能体任务已启动，正在进行场面调度与质检自省推演...',
        });
      } catch (err) {
        log.error('ontology directorGenerate', { error: err.message });
        response.internalError(res, err.message);
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
            const result = await runFullDramaDirectorAgent(db, log, cfg, dramaId, req.body || {}, (progress, message) => {
              taskService.updateTaskStatus(db, taskId, 'processing', progress, message);
            });
            taskService.updateTaskResult(db, taskId, result);
          } catch (agentErr) {
            log.error('directorFullPipeline task failed', { error: agentErr.message, task_id: taskId });
            taskService.updateTaskError(db, taskId, agentErr.message || '全流程导演智能体推演失败');
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
        const result = await refineSingleStoryboard(db, log, cfg, storyboardId, instruction);
        response.success(res, result);
      } catch (err) {
        log.error('ontology refineStoryboard', { error: err.message });
        response.badRequest(res, err.message);
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
  };
}

module.exports = ontologyRoutes;
