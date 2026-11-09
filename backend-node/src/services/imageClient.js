// 与 Go pkg/image + ImageGenerationService 对齐：调用图片生成 API，更新 image_generations 与角色头像
const fs = require('fs');
const path = require('path');
const aiConfigService = require('./aiConfigService');
const uploadService = require('./uploadService');
const storageLayout = require('./storageLayout');
const taskService = require('./taskService');
const { loadConfig } = require('../config');
const { flattenModelIds, pickModelId } = require('./modelId');
const seedance2AssetGuards = require('../utils/seedance2AssetGuards');

// 导入策略模式与工厂架构
const ImageProviderFactory = require('./image/imageProviderFactory');
const {
  BaseImageProvider,
  IMAGE_HTTP_TIMEOUT_MS,
  ANTI_SPLIT_NEGATIVE_PROMPT,
  mergeNegativePromptFragments,
  resolveAssetUserNegativeForApi,
  compressImageBuffer,
  resolveImageRef,
  clampAndAlignSize,
  buildImageUrl,
} = require('./image/baseProvider');
const {
  getProxyCache,
  deleteProxyCache,
  isProxyUrlAlive,
  getProxyCacheValidated,
  setProxyCache,
  buildCacheKey,
} = require('./image/proxyCache');
const {
  isDashScopeImageConfig,
  resolveDashScopeImageModel,
  dashScopeSize,
  parseDashScopeImageUrl,
} = require('./image/providers/dashScopeProvider');
const {
  fixSeedreamSize,
  isAgnesImageConfig,
  mapAgnesImageSizeSpec,
  fixAgnesImageSize,
} = require('./image/providers/openAiProvider');
const { klingImageAspectRatio } = require('./image/providers/klingProvider');
const { geminiAspectRatio, buildGeminiImageConfig } = require('./image/providers/geminiProvider');
const { nanoBananaAspectRatio } = require('./image/providers/nanoBananaProvider');

// 惰性加载配置，避免循环依赖与启动顺序问题
let _appConfig = null;
function getAppConfig() {
  if (!_appConfig) {
    try { _appConfig = loadConfig(); } catch (_) { _appConfig = {}; }
  }
  return _appConfig;
}

function inferProtocol(provider, model) {
  return ImageProviderFactory.inferProtocol(provider, model);
}

/**
 * 获取默认图片配置：优先使用前端勾选的「默认」配置（is_default），同类型内按优先级（priority）排序；
 * 可选按 preferredProvider / preferredModel 进一步筛选。
 */
function getDefaultImageConfig(db, preferredModel, preferredProvider, imageServiceType) {
  const serviceType = imageServiceType || 'image';
  let configs = aiConfigService.listConfigs(db, serviceType);
  if (configs.length === 0 && serviceType === 'storyboard_image') {
    configs = aiConfigService.listConfigs(db, 'image');
  }
  let active = configs.filter((c) => c.is_active);
  if (active.length === 0) return null;
  if (preferredProvider && String(preferredProvider).trim()) {
    const want = String(preferredProvider).trim().toLowerCase();
    const forProvider = active.filter((c) => (c.provider || '').toLowerCase() === want);
    if (forProvider.length > 0) active = forProvider;
  }
  if (preferredModel && String(preferredModel).trim()) {
    const wantM = pickModelId(preferredModel);
    const hasModel = active.filter((c) => {
      const models = flattenModelIds(c.model);
      return models.includes(wantM) || pickModelId(c.default_model) === wantM;
    });
    if (hasModel.length > 0) {
      const def = hasModel.find((c) => c.is_default);
      return def || hasModel[0];
    }
  }
  const defaultOne = active.find((c) => c.is_default);
  if (defaultOne) return defaultOne;
  return active[0];
}

function getModelFromConfig(config, preferredModel) {
  const models = flattenModelIds(config?.model);
  const preferred = pickModelId(preferredModel);
  const fallback = pickModelId(config?.default_model);
  let picked = models[0] || 'dall-e-3';
  if (preferred && models.includes(preferred)) picked = preferred;
  else if (fallback && models.includes(fallback)) picked = fallback;
  return resolveDashScopeImageModel(config, picked);
}

/**
 * 调用提供商图片生成 API（门面方法，委托给 ImageProviderFactory）
 * @param {object} db - database
 * @param {object} log - logger
 * @param {object} opts - 生图参数选项
 * @returns {Promise<{ image_url?: string, error?: string }>}
 */
async function callImageApi(db, log, opts) {
  const {
    prompt,
    model: preferredModel,
    size,
    quality,
    drama_id,
    preferred_provider,
    character_id,
    image_type,
    image_gen_id,
    imageServiceType,
    reference_image_urls,
    files_base_url,
    storage_local_path,
    system_prompt,
    user_negative_prompt,
  } = opts;
  const preferredProvider = preferred_provider ?? opts.preferredProvider;
  const config = getDefaultImageConfig(db, preferredModel, preferredProvider, imageServiceType);
  if (!config) {
    throw new Error('未配置图片模型，请在「AI 配置」中添加 image 类型且已启用的配置');
  }
  const model = getModelFromConfig(config, preferredModel);
  const provider = (config.provider || '').toLowerCase();
  const protocol = (config.api_protocol || '').toLowerCase() || inferProtocol(provider, model);

  // ── 参考图自然语言说明注入：告知生图模型每张参考图的用途与角色映射 ─────────
  let effectivePrompt = prompt || '';
  if (
    protocol !== 'gemini' &&
    Array.isArray(reference_image_urls) && reference_image_urls.length > 0 &&
    system_prompt
  ) {
    const refLines = String(system_prompt).split('\n').filter((l) => /^Image\s+\d+:/i.test(l));
    if (refLines.length > 0) {
      const refDescriptions = refLines
        .map((l, i) => {
          const m = l.match(/^Image\s+(\d+):\s*(.*)/i);
          const idx = m ? m[1] : (i + 1);
          const content = m ? m[2] : l;
          const isLastOrLock = /LAYOUT_LOCK|首帧|FIRST_FRAME/i.test(l);
          const isChar = /character appearance reference/i.test(l);
          const isFourView = /four-view|reference sheet/i.test(l);
          const isScene = /scene background reference/i.test(l);
          const isProp = /prop/i.test(l);

          if (isLastOrLock) {
            return `参考图 ${idx}：本分镜首帧画面，继承其构图与既有角色站位。`;
          }
          if (isChar) {
            const nameM = content.match(/for\s+"([^"]+)"/i);
            const cName = nameM ? nameM[1] : '该角色';
            return `参考图 ${idx}：提供角色「${cName}」的相貌身份与服装参考。`;
          }
          if (isScene) {
            const sceneM = content.match(/for\s+"([^"]+)"/i);
            const sName = sceneM ? sceneM[1] : '场景';
            return `参考图 ${idx}：提供场景「${sName}」的环境构图与光影参考。`;
          }
          if (isProp) {
            const propM = content.match(/for\s+"([^"]+)"/i);
            const pName = propM ? propM[1] : '道具';
            return `参考图 ${idx}：提供道具「${pName}」的外观参考。`;
          }
          if (isFourView) {
            return `参考图 ${idx}：提供角色形象与服装参考。`;
          }
          return `参考图 ${idx}：提供视觉参考。`;
        });
      const refHeader = `使用 ${refDescriptions.length} 张参考图进行分镜创作：\n${refDescriptions.join('\n')}`;
      effectivePrompt = opts.structured_storyboard
        ? `${refHeader}\n\n当前画面：\n${effectivePrompt}`
        : `${refHeader}\n\n[GENERATE THIS SCENE — single continuous image, no grid, no split panels / 生成当前单张连续画面，非多格非画中画]:\n${effectivePrompt}`;
    }
  }

  log.info('[图生] callImageApi 路由', {
    image_gen_id,
    protocol,
    api_protocol_raw: config.api_protocol || '(empty→auto)',
    provider,
    model,
    size,
    imageServiceType,
    ref_count: Array.isArray(opts.reference_image_urls) ? opts.reference_image_urls.length : 0,
    ref_label_injected: effectivePrompt !== (prompt || ''),
    effectivePrompt,
  });

  // 多参考图时统一生成 negative_prompt
  const incomingUserNeg = user_negative_prompt || opts.negative_prompt;
  const refCountForNeg = Array.isArray(opts.reference_image_urls) ? opts.reference_image_urls.filter(Boolean).length : 0;
  const isVolcOrSeedream = protocol === 'volcengine' || /seedream|doubao/i.test(model);
  // Structured storyboard requests use the same identity protection as every
  // other multi-reference request.  The guard stays in the negative channel
  // so it cannot pollute the positive scene description.
  const autoNegativePrompt = refCountForNeg >= 1 || isVolcOrSeedream || protocol === 'unsloth'
    ? ANTI_SPLIT_NEGATIVE_PROMPT
    : '';
  const userNegFragment = (incomingUserNeg && String(incomingUserNeg).trim()) || '';
  const mergedNegativePrompt = mergeNegativePromptFragments(autoNegativePrompt, userNegFragment);

  // 通过工厂解析匹配的 Provider 策略并执行生图
  const providerStrategy = ImageProviderFactory.getProvider(config, model);
  return await providerStrategy.generateImage({
    db,
    config,
    log,
    opts,
    effectivePrompt,
    mergedNegativePrompt,
    model,
    size,
    protocol,
  });
}

/**
 * 创建 image_generation 记录并异步调用 API，完成后更新记录与角色 image_url。
 * 与场景图一致：创建 task 并写入 task_id，便于前端轮询 /tasks/:task_id 获知完成或报错。
 */
function createAndGenerateImage(db, log, opts) {
  const {
    drama_id,
    character_id,
    scene_id,
    image_type,
    prompt,
    model,
    size,
    quality,
    provider,
    user_negative_prompt,
    reference_image_urls,
    files_base_url,
    storage_local_path,
    system_prompt,
  } = opts;
  const negRow = (user_negative_prompt && String(user_negative_prompt).trim()) || null;
  const now = new Date().toISOString();
  const dramaIdNum = Number(drama_id) || 0;
  const charIdNum = character_id != null ? Number(character_id) : null;
  const sceneIdNum = scene_id != null ? Number(scene_id) : null;

  let resourceId;
  if (charIdNum != null) resourceId = `character_${charIdNum}`;
  else if (sceneIdNum != null) resourceId = `scene_${sceneIdNum}`;
  else resourceId = String(dramaIdNum);
  const task = taskService.createTask(db, log, 'image_generation', resourceId);
  const taskId = task.id;

  let imageGenId;
  try {
    const info = db.prepare(
      `INSERT INTO image_generations (drama_id, character_id, scene_id, provider, prompt, negative_prompt, model, size, quality, status, task_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
    ).run(
      dramaIdNum,
      charIdNum,
      sceneIdNum,
      provider || 'openai',
      prompt || '',
      negRow,
      model || null,
      size || null,
      quality || null,
      taskId,
      now,
      now
    );
    imageGenId = info.lastInsertRowid;
  } catch (e) {
    if ((e.message || '').includes('scene_id') || (e.message || '').includes('character_id')) {
      const info = db.prepare(
        `INSERT INTO image_generations (drama_id, provider, prompt, model, size, quality, status, task_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
      ).run(dramaIdNum, provider || 'openai', prompt || '', model || null, size || null, quality || null, taskId, now, now);
      imageGenId = info.lastInsertRowid;
    } else {
      throw e;
    }
  }

  if (Array.isArray(reference_image_urls) && reference_image_urls.length) {
    db.prepare('UPDATE image_generations SET reference_images = ? WHERE id = ?')
      .run(JSON.stringify(reference_image_urls), imageGenId);
  }

  setImmediate(async () => {
    try {
      db.prepare('UPDATE image_generations SET status = ? WHERE id = ?').run('processing', imageGenId);
      const result = await callImageApi(db, log, {
        prompt,
        model,
        size,
        quality,
        drama_id: drama_id,
        character_id: character_id,
        image_type,
        image_gen_id: imageGenId,
        user_negative_prompt: user_negative_prompt || undefined,
        reference_image_urls,
        files_base_url,
        storage_local_path,
        system_prompt,
      });
      const now2 = new Date().toISOString();
      if (result.error) {
        db.prepare(
          'UPDATE image_generations SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?'
        ).run('failed', result.error, now2, imageGenId);
        taskService.updateTaskError(db, taskId, result.error);
        if (charIdNum != null) {
          try {
            db.prepare('UPDATE characters SET error_msg = ?, updated_at = ? WHERE id = ?').run(result.error, now2, charIdNum);
          } catch (_) {}
        }
        if (sceneIdNum != null) {
          try {
            db.prepare('UPDATE scenes SET error_msg = ?, updated_at = ? WHERE id = ?').run(result.error, now2, sceneIdNum);
          } catch (_) {}
        }
        log.error('Image generation failed', { image_gen_id: imageGenId, error: result.error });
        return;
      }
      let localPath = null;
      try {
        const loadConfig = require('../config').loadConfig;
        const cfg = loadConfig();
        const storagePath = path.isAbsolute(cfg.storage?.local_path)
          ? cfg.storage.local_path
          : path.join(process.cwd(), cfg.storage?.local_path || './data/storage');
        const category = sceneIdNum != null ? 'scenes' : (charIdNum != null ? 'characters' : 'images');
        const projectSubdir = storageLayout.getProjectStorageSubdir(db, dramaIdNum);
        localPath = await uploadService.downloadImageToLocal(
          storagePath,
          result.image_url,
          category,
          log,
          'ig',
          projectSubdir
        );
      } catch (_) {}
      try {
        db.prepare(
          'UPDATE image_generations SET status = ?, image_url = ?, local_path = ?, updated_at = ?, completed_at = ? WHERE id = ?'
        ).run('completed', result.image_url, localPath, now2, now2, imageGenId);
      } catch (e) {
        if ((e.message || '').includes('completed_at')) {
          db.prepare(
            'UPDATE image_generations SET status = ?, image_url = ?, local_path = ?, updated_at = ? WHERE id = ?'
          ).run('completed', result.image_url, localPath, now2, imageGenId);
        } else {
          throw e;
        }
      }
      taskService.updateTaskResult(db, taskId, { image_generation_id: imageGenId, image_url: result.image_url, local_path: localPath, status: 'completed' });
      if (charIdNum != null) {
        try {
          const oldChar = db
            .prepare('SELECT local_path, image_url, extra_images, seedance2_asset FROM characters WHERE id = ?')
            .get(charIdNum);
          const oldPath = oldChar?.local_path || oldChar?.image_url || '';
          let extras = [];
          try { extras = oldChar?.extra_images ? JSON.parse(oldChar.extra_images) : []; } catch (_) {}
          if (!Array.isArray(extras)) extras = [];
          if (oldPath && !extras.includes(oldPath)) extras.push(oldPath);
          const extraJson = extras.length ? JSON.stringify(extras) : null;
          seedance2AssetGuards.markStaleOnCharacterMainImageDrift(db, log, { ...oldChar, id: charIdNum }, {
            image_url: result.image_url,
            local_path: localPath,
          });
          db.prepare('UPDATE characters SET image_url = ?, local_path = ?, extra_images = ?, updated_at = ? WHERE id = ?').run(
            result.image_url,
            localPath,
            extraJson,
            now2,
            charIdNum
          );
        } catch (e) {
          if ((e.message || '').includes('local_path') || (e.message || '').includes('extra_images')) {
            db.prepare('UPDATE characters SET image_url = ?, updated_at = ? WHERE id = ?').run(result.image_url, now2, charIdNum);
          } else {
            throw e;
          }
        }
        log.info('Character image updated', { character_id: charIdNum, image_url: result.image_url, local_path: localPath });
      }
      if (sceneIdNum != null) {
        try {
          const oldScene = db.prepare('SELECT local_path, image_url, extra_images FROM scenes WHERE id = ?').get(sceneIdNum);
          const oldPath = oldScene?.local_path || oldScene?.image_url || '';
          let extras = [];
          try { extras = oldScene?.extra_images ? JSON.parse(oldScene.extra_images) : []; } catch (_) {}
          if (!Array.isArray(extras)) extras = [];
          if (oldPath && !extras.includes(oldPath)) extras.push(oldPath);
          const extraJson = extras.length ? JSON.stringify(extras) : null;
          db.prepare('UPDATE scenes SET image_url = ?, local_path = ?, extra_images = ?, updated_at = ? WHERE id = ?').run(
            result.image_url,
            localPath,
            extraJson,
            now2,
            sceneIdNum
          );
        } catch (e) {
          if ((e.message || '').includes('local_path') || (e.message || '').includes('extra_images')) {
            db.prepare('UPDATE scenes SET image_url = ?, updated_at = ? WHERE id = ?').run(result.image_url, now2, sceneIdNum);
          } else {
            throw e;
          }
        }
        log.info('Scene image updated', { scene_id: sceneIdNum, image_url: result.image_url, local_path: localPath });
      }
      log.info('Image generation completed', { image_gen_id: imageGenId, local_path: localPath });
    } catch (err) {
      const now2 = new Date().toISOString();
      const errMsg = (err && err.message) ? String(err.message).slice(0, 500) : 'Unknown error';
      try {
        db.prepare(
          'UPDATE image_generations SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?'
        ).run('failed', errMsg, now2, imageGenId);
      } catch (e) {
        log.error('Image generation: failed to update image_generations', { image_gen_id: imageGenId, error: e.message });
      }
      try {
        taskService.updateTaskError(db, taskId, errMsg);
      } catch (e) {
        log.error('Image generation: failed to update task status', { task_id: taskId, error: e.message });
      }
      if (charIdNum != null) {
        try {
          db.prepare('UPDATE characters SET error_msg = ?, updated_at = ? WHERE id = ?').run(errMsg, now2, charIdNum);
        } catch (_) {}
      }
      if (sceneIdNum != null) {
        try {
          db.prepare('UPDATE scenes SET error_msg = ?, updated_at = ? WHERE id = ?').run(errMsg, now2, sceneIdNum);
        } catch (_) {}
      }
      log.error('Image generation error', { image_gen_id: imageGenId, task_id: taskId, error: err.message });
    }
  });

  const row = db.prepare('SELECT * FROM image_generations WHERE id = ?').get(imageGenId);
  return row ? rowToItem(row) : { id: imageGenId, task_id: taskId, status: 'pending', drama_id: dramaIdNum, character_id: charIdNum, scene_id: sceneIdNum, prompt, model, size, quality, created_at: now, updated_at: now };
}

function rowToItem(r) {
  return {
    id: r.id,
    storyboard_id: r.storyboard_id,
    drama_id: r.drama_id,
    character_id: r.character_id,
    provider: r.provider,
    prompt: r.prompt,
    model: r.model,
    size: r.size,
    quality: r.quality,
    image_url: r.image_url,
    local_path: r.local_path,
    status: r.status,
    task_id: r.task_id,
    error_msg: r.error_msg,
    created_at: r.created_at,
    updated_at: r.updated_at,
    completed_at: r.completed_at,
  };
}

/** 分镜参考图上限（与 Gemini、可灵等策略对齐） */
function getStoryboardReferenceLimits(config, modelName) {
  const provider = (config?.provider || '').toLowerCase();
  const protocol = (config?.api_protocol || '').toLowerCase() || inferProtocol(provider, modelName || config?.model);
  if (protocol === 'kling') {
    return { total: 1, maxCharacters: 1, maxObjects: 1 };
  }
  return { total: 4, maxCharacters: 3, maxObjects: 4 };
}

function countStoryboardRefsFromLabels(refLabels) {
  let characters = 0;
  let objects = 0;
  for (const lbl of refLabels || []) {
    if (/character appearance/i.test(lbl)) characters += 1;
    else if (/scene background|prop\/object/i.test(lbl)) objects += 1;
  }
  return { characters, objects };
}

function canAddStoryboardCharacterRef(refLabels, limits) {
  const { characters } = countStoryboardRefsFromLabels(refLabels);
  return refLabels.length < limits.total && characters < limits.maxCharacters;
}

function canAddStoryboardObjectRef(refLabels, limits) {
  const { objects } = countStoryboardRefsFromLabels(refLabels);
  return refLabels.length < limits.total && objects < limits.maxObjects;
}

/** 去重：同一本地路径或 URL（忽略 query）不重复加入参考图列表 */
function canonicalRefKey(ref) {
  if (ref == null || ref === '') return '';
  let s = String(ref).trim().replace(/\\/g, '/');
  if (s.startsWith('data:')) return s.slice(0, 120);
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      return `${u.origin}${u.pathname}`.toLowerCase();
    } catch (_) {
      return s.split('?')[0].toLowerCase();
    }
  }
  try {
    return path.normalize(s).toLowerCase();
  } catch (_) {
    return s.toLowerCase();
  }
}

function refListHasCanonical(list, ref) {
  const key = canonicalRefKey(ref);
  if (!key) return false;
  return (list || []).some((item) => canonicalRefKey(item) === key);
}

module.exports = {
  getDefaultImageConfig,
  callImageApi,
  createAndGenerateImage,
  resolveAssetUserNegativeForApi,
  getStoryboardReferenceLimits,
  canAddStoryboardCharacterRef,
  canAddStoryboardObjectRef,
  refListHasCanonical,
  clampAndAlignSize,
  fixAgnesImageSize,
  mapAgnesImageSizeSpec,
  isAgnesImageConfig,
  resolveDashScopeImageModel,
  /** 图床 URL 缓存（image_proxy_cache），供 SD2 认证等复用 */
  getProxyCache,
  getProxyCacheValidated,
  deleteProxyCache,
  isProxyUrlAlive,
  setProxyCache,
  // 架构扩展接口
  ImageProviderFactory,
  BaseImageProvider,
};
