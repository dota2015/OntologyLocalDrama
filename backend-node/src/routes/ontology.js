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
const { runFullDramaDirectorAgent, refineSingleStoryboard } = require('../ontology/directorAgent');
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
          directorPlanningMode: 'persisted',
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
        if (requestOptions.mode === 'deep_react') {
          return response.badRequest(res, '旧版 deep_react 模式已下线，请使用标准两阶段导演流水线');
        }
        if (requestOptions.resume_task_id) {
          const saved = directorCheckpoint.requireResume(db, requestOptions.resume_task_id, episodeId, cfg);
          // Resume uses the original creative inputs, never silently the current form.
          requestOptions = { ...saved.options, resume_task_id: requestOptions.resume_task_id };
          if (requestOptions.mode === 'deep_react') {
            return response.badRequest(res, '该检查点来自已下线的 deep_react 模式，无法继续执行，请重新发起标准两阶段生成');
          }
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
            const result = await runDirectorTask(db, taskId, () => runTwoStageDirectorPipeline(db, log, cfg, episodeId, options));
            taskService.updateTaskStatus(db, taskId, 'completed', 100, '视听本体硬门禁审查与自纠完毕，分镜已入库。');
            taskService.updateTaskResult(db, taskId, result);
          } catch (agentErr) {
            log.error('directorGenerate task failed', { error: agentErr.message, task_id: taskId });
            taskService.updateTaskError(db, taskId, agentErr.message || '导演智能体推演失败', {
              valid: false,
              violations: agentErr.violations || [],
              status: agentErr.status || 422,
              stage: agentErr.stage || null,
              partial_shot_count: agentErr.partial_shot_count || 0,
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

    // 查询全部 12 项本体门禁规则元数据
    getRules: (req, res) => {
      try {
        const { InvariantRuleEngine } = require('../ontology/ruleEngine');
        const engine = new InvariantRuleEngine();
        const ruleMetaMap = {
          RULE_AUDIO_CONTRACT: {
            category: '视听合同与语义',
            target_fields: ['semantic_slots.audio_lip_sync', 'semantic_slots.sound_plan', 'dialogue'],
            prevention: '杜绝口型与画外音不一致、环境音与纯静音互斥冲突',
            severity: 'error',
          },
          RULE_SPEECH_TIMING: {
            category: '物理时序与时长',
            target_fields: ['duration', 'dialogue', 'narration', 'semantic_slots.speech_plan'],
            prevention: '防止台词字数超出镜头物理容纳上限（按 TTS 1.25x 速率评估），避免下游视频硬截断',
            severity: 'error',
          },
          RULE_VISUAL_SLOT_COMPLETENESS: {
            category: '画面构图与视觉定格',
            target_fields: ['character_visuals', 'depth_layer', 'screen_position', 'facing', 'gaze_type', 'posture', 'hands_state', 'expression'],
            prevention: '确保画内每个出场角色有明确的 3D 站位、朝向与微表情，杜绝多角色站位重叠',
            severity: 'error',
          },
          RULE_VIDEO_SLOTS: {
            category: '动态轨迹与动作原子',
            target_fields: ['video_slots.trajectories', 'video_slots.performance_contract', 'video_slots.camera'],
            prevention: '强化 Structured Sync 动作原子规范，严禁画外角色产生画内动作、杜绝术语未具象化',
            severity: 'error',
          },
          RULE_CROWD_CONTROL: {
            category: '模型容量与防克隆人',
            target_fields: ['semantic_slots.visible_characters', 'characters'],
            prevention: '单镜有身份主角严格控制在 2 人以内，防止生图/视频模型出现克隆人、双胞胎或人脸融化',
            severity: 'error',
          },
          RULE_H3_REFERENCE_CAPACITY: {
            category: '模型容量与防克隆人',
            target_fields: ['semantic_slots.required_references', 'props'],
            prevention: '限制单镜参考图资产 1～9 项，按「场景 -> 角色 -> 道具」严格有序排布',
            severity: 'error',
          },
          RULE_SPATIAL_CONTINUITY: {
            category: '时空连续性',
            target_fields: ['scene_id', 'camera.angle_h', 'continuity_from_previous'],
            prevention: '同一机位同视角下防止角色瞬间置换造成视觉跳切穿帮',
            severity: 'error',
          },
          RULE_PROP_ERA_AND_SCALE: {
            category: '资产与物理规律',
            target_fields: ['props', 'physical_scale', 'era_compatibility'],
            prevention: '校验道具真实物理尺度（不可随意巨化/微化）以及时代相容性（防穿越穿帮）',
            severity: 'error',
          },
          RULE_OBSOLETE_ASSETS: {
            category: '资产与物理规律',
            target_fields: ['catalogs.props', 'catalogs.characters', 'catalogs.scenes'],
            prevention: '识别在剧本和分镜中均未出场且超过冷却期的过时残留资产，防止污染提示词',
            severity: 'warning',
          },
          RULE_SHOT_TRANSITION_CONTINUITY: {
            category: '时空连续性',
            target_fields: ['continuity_type', 'continuity_from_previous', 'start_framing', 'end_framing'],
            prevention: '审查镜头起幅构图、落幅定格与过渡承接的完整性，防止镜头前后脱节',
            severity: 'error',
          },
          RULE_CROSS_SLOT_INVARIANTS: {
            category: '视听合同与语义',
            target_fields: ['semantic_slots.offscreen_characters', 'semantic_slots.first_frame_policy', 'semantic_slots.last_frame_policy', 'h3_mode'],
            prevention: '严格审查跨槽位语义一致性，画外参与角色必须显式声明（present_offscreen / remote_voice），严禁隐式偷渡',
            severity: 'error',
          },
          RULE_ASSET_REFERENCE_AND_PLANNING_FEASIBILITY: {
            category: '资产与物理规律',
            target_fields: ['characters', 'props', 'scene_id', 'required_references'],
            prevention: '严格校验引用资产 ID 必须存在于剧目/集可用白名单中，坚决拦截未知或伪造 ID',
            severity: 'error',
          },
        };

        const list = Array.from(engine.rules.values()).map((r) => {
          const meta = ruleMetaMap[r.id] || {};
          return {
            id: r.id,
            name: r.name || r.id,
            description: r.description || '',
            category: meta.category || '核心视听门禁',
            severity: meta.severity || 'error',
            target_fields: meta.target_fields || [],
            prevention: meta.prevention || '',
          };
        });

        response.success(res, list);
      } catch (err) {
        log.error('ontology getRules', { error: err.message });
        response.badRequest(res, err.message);
      }
    },

    // 查询视听本体全景系统概览（架构、三层管线、规范与统计）
    getOverview: (req, res) => {
      try {
        const schema = require('../ontology/schema');
        const atoms = require('../ontology/actionAtoms');
        const { InvariantRuleEngine } = require('../ontology/ruleEngine');
        const engine = new InvariantRuleEngine();

        let dramaCount = 0;
        let episodeCount = 0;
        let storyboardCount = 0;
        let characterCount = 0;
        let sceneCount = 0;
        let propCount = 0;

        try {
          dramaCount = db.prepare('SELECT count(*) as c FROM dramas WHERE deleted_at IS NULL').get()?.c || 0;
          episodeCount = db.prepare('SELECT count(*) as c FROM episodes WHERE deleted_at IS NULL').get()?.c || 0;
          storyboardCount = db.prepare('SELECT count(*) as c FROM storyboards WHERE deleted_at IS NULL').get()?.c || 0;
          characterCount = db.prepare('SELECT count(*) as c FROM characters WHERE deleted_at IS NULL').get()?.c || 0;
          sceneCount = db.prepare('SELECT count(*) as c FROM scenes WHERE deleted_at IS NULL').get()?.c || 0;
          propCount = db.prepare('SELECT count(*) as c FROM props WHERE deleted_at IS NULL').get()?.c || 0;
        } catch (_) {}

        response.success(res, {
          principles: [
            {
              title: '门禁只认结构化语义',
              description: '本体门禁与不变量判定依据必须是结构化字段（ID、枚举、槽位关系），坚决禁止文本正则推断事实；语义事实由 Agent 显式声明，门禁只校验一致性。',
            },
            {
              title: '平台代码零内容',
              description: '通用短剧平台坚决禁止在代码与规则规范中硬编码任何剧目的剧情、角色名、道具名与题材设定；一切内容完全来源于剧目语义包与目录数据。',
            },
            {
              title: '三层视听编译管线',
              description: '严格遵循「智能体推演层 ➔ 本体门禁质检层 ➔ 执行确定性编译层」三层架构，不合规数据在门禁层立即被打回自修，绝不污染下游渲染。',
            },
          ],
          pipeline: [
            {
              stage: 'Stage 1: 基础剧情分镜划分',
              agent: '短剧基础导演 Agent',
              goal: '确保剧本台词与情节逐字覆盖，单说话人单轮对白拆分，物理动作拍摄规划，TTS 速率时长预算。',
              output: 'shot_number, title, scene_id, characters, props, duration, dialogue, narration, action',
            },
            {
              stage: 'Stage 2: 视听槽位扩充与闭环审校',
              agent: '导演执行合同 Agent',
              goal: '推导 3D 视觉定格、因果动作原子、口型同步模式、声音方案、转场桥接与 H3 参考图合约。',
              output: 'semantic_slots, character_visuals, video_slots, last_frame_visuals',
            },
            {
              stage: 'Stage 3: 视听本体质量门禁硬拦截',
              agent: 'SHACL Invariant Rule Engine',
              goal: '运行 12 大不可变规则校验，发现违规立即触发 Agent 局部反射自纠，确保进入渲染层的数据百分之百合规。',
              output: 'Audited & Validated Contract (Zero Violations)',
            },
            {
              stage: 'Stage 4: 确定性执行编译与渲染',
              agent: 'H3 Compiler & Multi-Modal Engine',
              goal: '依据结构化槽位与资产参考图，确定性编译为 H3 提示词（Ref2VA / FL2VA）、IndexTTS 语音流与视频剪辑工程。',
              output: 'MiniMax H3 Video / TTS Audio / Subtitles',
            },
          ],
          stats: {
            rules_count: engine.rules.size,
            dramas_count: dramaCount,
            episodes_count: episodeCount,
            storyboards_count: storyboardCount,
            characters_count: characterCount,
            scenes_count: sceneCount,
            props_count: propCount,
          },
          action_atoms: {
            actions_count: Object.keys(atoms.ACTIONS || {}).length,
            body_parts_count: Object.keys(atoms.BODY_PARTS || {}).length,
            target_types_count: Object.keys(atoms.TARGET_TYPES || {}).length,
            directions_count: Object.keys(atoms.DIRECTIONS || {}).length,
            contacts_count: Object.keys(atoms.CONTACTS || {}).length,
            states_count: Object.keys(atoms.STATES || {}).length,
            actions_sample: Object.keys(atoms.ACTIONS || {}).slice(0, 12),
          },
          dictionary_dimensions: Object.keys(schema.AUDIOTISUAL_DATA_DICTIONARY || {}).filter(k => !k.startsWith('_')),
        });
      } catch (err) {
        log.error('ontology getOverview', { error: err.message });
        response.badRequest(res, err.message);
      }
    },
  };
}

module.exports = ontologyRoutes;
