const taskService = require('./taskService');
const directorCheckpoint = require('./directorCheckpoint');
const { withTaskTokenUsage } = require('./agentTokenUsage');
const { withTaskTrace } = require('./directorTrace');
const runDirectorTask = (db, taskId, work) => withTaskTrace(db, taskId, () => withTaskTokenUsage(db, taskId, work));
const { runTwoStageDirectorPipeline } = require('../ontology/directorEnrichmentService');

function startDirectorTask(db, log, cfg, episodeId, requestOptions) {
  if (requestOptions.mode === 'deep_react') {
    throw new Error('旧版 deep_react 模式已下线，请使用标准两阶段导演流水线');
  }
  if (requestOptions.resume_task_id) {
    const saved = directorCheckpoint.requireResume(db, requestOptions.resume_task_id, episodeId, cfg);
    // Resume uses the original creative inputs, never silently the current form.
    requestOptions = { ...saved.options, resume_task_id: requestOptions.resume_task_id };
    if (requestOptions.mode === 'deep_react') {
      throw new Error('该检查点来自已下线的 deep_react 模式，无法继续执行，请重新发起标准两阶段生成');
    }
  }
  const claim = db.transaction(() => {
    const active = db.prepare(`SELECT id FROM async_tasks WHERE resource_id=? AND type='director_storyboard_generation'
      AND status IN ('pending','processing') AND deleted_at IS NULL`).get(String(episodeId));
    return active ? { active } : { task: taskService.createTask(db, log, 'director_storyboard_generation', String(episodeId)) };
  }).immediate();
  if (claim.active) throw Object.assign(new Error('当前集已有导演任务运行，请等待完成或停止后再操作'), { code: 'DIRECTOR_ACTIVE', taskId: claim.active.id });
  const taskId = claim.task.id;

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

  return taskId;
}

module.exports = { startDirectorTask, runDirectorTask };
