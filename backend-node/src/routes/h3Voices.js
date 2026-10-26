const express = require('express');
const multer = require('multer');
const path = require('path');
const response = require('../response');
const service = require('../services/h3VoiceReferenceService');

module.exports = (db, cfg, log) => {
  const router = express.Router();
  const root = path.resolve(cfg.storage?.local_path || './data/storage');
  const middleware = multer({ storage: multer.memoryStorage(), limits: { fileSize: service.MAX_BYTES } }).single('file');
  router.get('/:drama_id/:target', (req, res) => {
    try { response.success(res, service.getSettings(db, req.params.drama_id, req.params.target, root)); }
    catch (e) { response.badRequest(res, e.message); }
  });
  router.post('/:drama_id/:target/prepare', async (req, res) => {
    try { response.success(res, await service.prepare(db, log, req.params.drama_id, req.params.target, root)); }
    catch (e) { log.warn('H3 voice preparation', { error: e.message }); response.badRequest(res, e.message); }
  });
  router.post('/:drama_id/:target/upload', (req, res) => {
    middleware(req, res, async error => {
      if (error) return response.badRequest(res, error.code === 'LIMIT_FILE_SIZE' ? '参考声音不能超过 20MB' : error.message);
      try { response.success(res, await service.upload(db, req.params.drama_id, req.params.target, root, req.file)); }
      catch (e) { log.warn('H3 voice upload', { error: e.message }); response.badRequest(res, e.message); }
    });
  });
  router.delete('/:drama_id/:target/upload', (req, res) => {
    try { response.success(res, service.removeUpload(db, req.params.drama_id, req.params.target, root)); }
    catch (e) { response.badRequest(res, e.message); }
  });
  return router;
};
