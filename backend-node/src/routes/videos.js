const response = require('../response');
const videoService = require('../services/videoService');
const taskService = require('../services/taskService');

function routes(db, log) {
  return {
    h3Inputs: (req, res) => {
      try {
        response.success(res, require('../services/h3NativeService').getSettings(db, req.query.drama_id, req.params.storyboard_id));
      } catch (err) { response.badRequest(res, err.message); }
    },
    saveH3Inputs: (req, res) => {
      try {
        response.success(res, require('../services/h3NativeService').saveSettings(db, req.body?.drama_id, req.params.storyboard_id, req.body || {}));
      } catch (err) { response.badRequest(res, err.message); }
    },
    list: (req, res) => {
      try {
        const query = { ...req.query };
        const { items, total, page, pageSize } = videoService.list(db, query);
        response.successWithPagination(res, items, total, page, pageSize);
      } catch (err) {
        log.error('videos list', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    create: (req, res) => {
      try {
        const body = req.body || {};
        // A stale browser or a second tab must not duplicate a queued/running shot.
        if (body.storyboard_id && body.drama_id) {
          const active = db.prepare("SELECT id FROM video_generations WHERE storyboard_id=? AND drama_id=? AND status='processing' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1")
            .get(Number(body.storyboard_id), Number(body.drama_id));
          if (active) return response.success(res, videoService.getById(db, active.id));
          const queued = db.prepare(`SELECT i.id FROM video_batch_items i JOIN video_batches b ON b.id=i.batch_id
            WHERE i.storyboard_id=? AND b.drama_id=? AND b.status IN ('running','stopping') AND i.status IN ('pending','running') LIMIT 1`)
            .get(Number(body.storyboard_id), Number(body.drama_id));
          if (queued) return response.badRequest(res, '该分镜已在后台视频队列中，请等待完成或先停止批量任务');
        }
        const item = require('../services/videoSubmissionService').submitVideo(db, log, body);
        setImmediate(() => videoService.processVideoGeneration(db, log, item.id));
        response.created(res, item);
      } catch (err) {
        log.error('videos create', { error: err.message });
        if (err.status === 400) return response.badRequest(res, err.message);
        response.internalError(res, err.message);
      }
    },
    get: (req, res) => {
      try {
        const item = videoService.getById(db, req.params.id);
        if (!item) return response.notFound(res, '记录不存在');
        response.success(res, item);
      } catch (err) {
        log.error('videos get', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    delete: (req, res) => {
      try {
        const ok = videoService.deleteById(db, log, req.params.id);
        if (!ok) return response.notFound(res, '记录不存在');
        response.success(res, { message: '删除成功' });
      } catch (err) {
        log.error('videos delete', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    /** 失败后复用 provider_task_id 继续轮询上游，避免浪费已提交任务 */
    resumePoll: (req, res) => {
      try {
        const result = videoService.resumeFailedVideoPoll(db, log, req.params.id);
        if (!result.ok) {
          if (result.status === 404) return response.notFound(res, result.error);
          return response.badRequest(res, result.error);
        }
        response.success(res, result.item);
      } catch (err) {
        log.error('videos resumePoll', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    fromImage: (req, res) => {
      try {
        const task = taskService.createTask(db, log, 'video_generation', req.params.image_gen_id);
        response.success(res, { task_id: task.id });
      } catch (err) {
        log.error('videos fromImage', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    episodeBatch: (req, res) => {
      try {
        response.created(res, require('../services/videoBatchService').createBatch(db, log, req.params.episode_id, req.body || {}));
      } catch (err) { response.badRequest(res, err.message); }
    },
    getEpisodeBatch: (req, res) => {
      try { response.success(res, require('../services/videoBatchService').latestBatch(db, req.params.episode_id)); }
      catch (err) { response.badRequest(res, err.message); }
    },
    stopEpisodeBatch: (req, res) => {
      try { response.success(res, require('../services/videoBatchService').stopBatch(db, req.params.episode_id, req.body?.batch_id)); }
      catch (err) { response.badRequest(res, err.message); }
    },
    clearEpisodeBatch: (req, res) => {
      try { response.success(res, require('../services/videoBatchService').clearBatch(db, req.params.episode_id, req.body?.batch_id)); }
      catch (err) { response.badRequest(res, err.message); }
    },
  };
}

module.exports = routes;
