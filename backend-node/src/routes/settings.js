const settingsService = require('../services/settingsService');
const response = require('../response');
const { loadConfig } = require('../config');
const { resolveVideoGenerationTimeoutMinutes } = require('../config/videoGeneration');

function getLanguage(cfg) {
  return (req, res) => {
    const language = settingsService.getLanguage(cfg);
    response.success(res, { language });
  };
}

function updateLanguage(cfg, log) {
  return (req, res) => {
    const lang = req.body?.language;
    if (lang !== 'zh' && lang !== 'en') {
      return response.badRequest(res, '语言参数错误，只支持 zh 或 en');
    }
    const out = settingsService.updateLanguage(cfg, log, lang);
    if (!out.ok) return response.badRequest(res, out.error);
    const message = lang === 'en' ? 'Language switched to English' : '语言已切换为中文';
    response.success(res, { message, language: lang });
  };
}

/** GET /settings/generation — 获取生成相关全局设置 */
function getGenerationSettings(db) {
  return async (req, res) => {
    try {
      const concurrency = settingsService.getGlobalSetting(db, 'pipeline_concurrency', 3);
      const video_concurrency = 1;
      const video_generation_timeout_minutes = resolveVideoGenerationTimeoutMinutes(loadConfig());
      let h3_instances_count = null;
      try {
        const h3Service = require('../services/h3InstanceService');
        const h3Data = await h3Service.getInstances(db);
        h3_instances_count = h3Data.count || null;
      } catch (_) {}
      response.success(res, {
        concurrency,
        video_concurrency,
        video_generation_timeout_minutes,
        h3_instances_count,
      });
    } catch (err) {
      response.internalError(res, err.message);
    }
  };
}

/** PUT /settings/generation — 更新生成相关全局设置 */
function updateGenerationSettings(db) {
  return async (req, res) => {
    try {
      const { concurrency } = req.body || {};
      // H3 jobs are always serialized.  Accept the legacy field for old
      // clients, but never persist a value that could re-enable parallel GPU
      // execution.
      settingsService.setGlobalSetting(db, 'pipeline_video_concurrency', 1);
      if (concurrency !== undefined) {
        const n = Number(concurrency);
        if (!Number.isInteger(n) || n < 1 || n > 20) {
          return response.badRequest(res, '图片并发数需为 1-20 之间的整数');
        }
        settingsService.setGlobalSetting(db, 'pipeline_concurrency', n);
      }
      const saved = settingsService.getGlobalSetting(db, 'pipeline_concurrency', 3);
      const saved_video = 1;
      const video_generation_timeout_minutes = resolveVideoGenerationTimeoutMinutes(loadConfig());
      let h3_instances_count = null;
      try {
        const h3Service = require('../services/h3InstanceService');
        const h3Data = await h3Service.getInstances(db);
        h3_instances_count = h3Data.count || null;
      } catch (_) {}
      response.success(res, {
        concurrency: saved,
        video_concurrency: saved_video,
        video_generation_timeout_minutes,
        h3_instances_count,
      });
    } catch (err) {
      response.internalError(res, err.message);
    }
  };
}

/** GET /settings/h3-instances — 获取 H3 实例集群列表及连接状态 */
function getH3Instances(db) {
  return async (req, res) => {
    try {
      const h3Service = require('../services/h3InstanceService');
      const data = await h3Service.getInstances(db);
      response.success(res, data);
    } catch (err) {
      response.internalError(res, err.message);
    }
  };
}

/** PUT /settings/h3-instances — 保存 H3 实例列表（视频始终串行） */
function updateH3Instances(db, log) {
  return async (req, res) => {
    try {
      const h3Service = require('../services/h3InstanceService');
      const result = await h3Service.updateInstances(db, log, req.body || {});
      response.success(res, result);
    } catch (err) {
      if (err.status === 400) return response.badRequest(res, err.message);
      response.internalError(res, err.message);
    }
  };
}

/** POST /settings/h3-instances/test — 测试单个 ComfyUI 实例连接状态 */
function testH3Instance() {
  return async (req, res) => {
    try {
      const h3Service = require('../services/h3InstanceService');
      const result = await h3Service.testInstance(req.body?.url);
      response.success(res, result);
    } catch (err) {
      response.internalError(res, err.message);
    }
  };
}

module.exports = function settingsRoutes(db, cfg, log) {
  return {
    getLanguage: getLanguage(cfg),
    updateLanguage: updateLanguage(cfg, log),
    getGenerationSettings: getGenerationSettings(db),
    updateGenerationSettings: updateGenerationSettings(db),
    getH3Instances: getH3Instances(db),
    updateH3Instances: updateH3Instances(db, log),
    testH3Instance: testH3Instance(),
  };
};
