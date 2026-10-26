const express = require('express');
const multer = require('multer');
const path = require('path');
const response = require('../response');
const music = require('../services/backgroundMusicService');

module.exports = function routes(db, cfg, log) {
  const router = express.Router();
  const storage = cfg.storage?.local_path || './data/storage';
  const root = path.resolve(storage);
  const middleware = multer({ storage: multer.memoryStorage(), limits: { fileSize: music.MAX_BYTES } }).single('file');
  router.get('/:episode_id', (req, res) => {
    try { response.success(res, music.getSettings(db, req.params.episode_id)); }
    catch (e) { response.badRequest(res, e.message); }
  });
  router.put('/:episode_id', (req, res) => {
    try { response.success(res, music.saveSettings(db, req.params.episode_id, req.body || {})); }
    catch (e) { response.badRequest(res, e.message); }
  });
  router.delete('/:episode_id', (req, res) => {
    try { response.success(res, music.remove(db, req.params.episode_id)); }
    catch (e) { response.badRequest(res, e.message); }
  });
  router.post('/:episode_id/upload', (req, res) => {
    middleware(req, res, async error => {
      if (error) return response.badRequest(res, error.code === 'LIMIT_FILE_SIZE' ? '背景音乐不能超过 100MB' : error.message);
      try { response.success(res, await music.upload(db, req.params.episode_id, root, req.file)); }
      catch (e) { log.warn('background music upload', { error: e.message }); response.badRequest(res, e.message); }
    });
  });
  return router;
};
