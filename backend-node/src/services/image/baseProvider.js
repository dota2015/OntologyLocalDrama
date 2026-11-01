/**
 * 图片提供商抽象基类 (BaseImageProvider)
 * 遵循策略模式 (Strategy Pattern)，定义图片生成与结果解析的标准化契约与通用工具方法。
 */

const fs = require('fs');
const path = require('path');

/** 图生 POST 使用 Node http(s)，默认 10 分钟，避免 undici fetch 大包体/慢链路下模糊失败 */
const IMAGE_HTTP_TIMEOUT_MS = 600000;

// 多参考图时注入到所有支持 negative_prompt 的模型，防止生成分割/拼贴布局；同时加入安全词以减少敏感拦截
const ANTI_SPLIT_NEGATIVE_PROMPT = 'nsfw, nudity, naked, violence, blood, gore, sensitive content, duplicate person, clone, cloned person, two identical people, extra person, multiple views of same person, duplicate face, duplicate characters, extra people, background bystander, extra limbs, split panels, side-by-side layout, collage, diptych, triptych, grid layout, multiple panels, comparison view, composite image, two images in one frame, character sheet layout, split screen, missing character, bad anatomy, deformed limbs, frontal standing portrait in center, standing pose, character standing in foreground, extra person in front of scene, passport photo, model sheet, character reference sheet, 正面站立肖像, 画面中心多余人物, 双重人物, 额外角色, 克隆人, 呆立, 证件照, 模特立绘';

function mergeNegativePromptFragments(auto, user) {
  const a = (auto || '').trim();
  const u = (user || '').trim();
  if (a && u) return `${a}, ${u}`;
  return a || u || '';
}

/** 角色/场景/道具资产生图：请求里显式传入 model 且资产上存有负面词时，与自动负面片段合并后传给图生 API */
function resolveAssetUserNegativeForApi(explicitModelName, storedNegative) {
  const hasModel = explicitModelName != null && String(explicitModelName).trim().length > 0;
  const neg = storedNegative != null ? String(storedNegative).trim() : '';
  return hasModel && neg ? neg : '';
}

// sharp 惰性加载（参考图压缩用）
let _sharp = null;
function getSharp() {
  if (!_sharp) {
    try { _sharp = require('sharp'); } catch (_) {}
  }
  return _sharp;
}

/**
 * 压缩单张参考图 buffer，目标 ≤ targetKB（默认 2048KB=2MB）
 */
async function compressImageBuffer(buffer, mimeType, targetKB = 2048, log = null) {
  const sharp = getSharp();
  if (!sharp) return { buffer, mimeType };
  const targetBytes = targetKB * 1024;
  if (buffer.length <= targetBytes) return { buffer, mimeType };
  try {
    let quality = 80;
    let compressed = await sharp(buffer).jpeg({ quality }).toBuffer();
    while (compressed.length > targetBytes && quality > 30) {
      quality -= 15;
      compressed = await sharp(buffer).jpeg({ quality }).toBuffer();
    }
    if (compressed.length < buffer.length) {
      if (log) log.info('[参考图压缩] 压缩完成', {
        original_kb: Math.round(buffer.length / 1024),
        compressed_kb: Math.round(compressed.length / 1024),
        quality,
      });
      return { buffer: compressed, mimeType: 'image/jpeg' };
    }
  } catch (e) {
    if (log) log.warn('[参考图压缩] sharp 压缩失败，使用原图', { error: e.message });
  }
  return { buffer, mimeType };
}

/**
 * 解析参考图路径：本地路径 / localhost URL → base64，公网 URL 直接保留
 */
function resolveImageRef(value, filesBaseUrl, storageLocalPath) {
  if (!value || !String(value).trim()) return null;
  const s = String(value).trim();
  const baseUrl = (filesBaseUrl || '').replace(/\/$/, '');
  const isLocalhostUrl = /localhost|127\.0\.0\.1/i.test(s);
  const isLocalhostBase = baseUrl && /localhost|127\.0\.0\.1/i.test(baseUrl);
  const isLocalhost = isLocalhostUrl || isLocalhostBase;

  function toPublicUrl(v) {
    if (!v || !String(v).trim()) return null;
    const sv = String(v).trim();
    if (sv.startsWith('http://') || sv.startsWith('https://')) return sv;
    if (baseUrl) return baseUrl + '/' + sv.replace(/^\//, '');
    return sv;
  }

  const defaultStorage = path.resolve(__dirname, '../../../data/storage');
  const effectiveStorageLocalPath = storageLocalPath || (fs.existsSync(path.resolve(process.cwd(), 'data/storage')) ? path.resolve(process.cwd(), 'data/storage') : defaultStorage);
  let relPath = null;
  if (s.startsWith('http://') || s.startsWith('https://')) {
    if (!isLocalhost || !effectiveStorageLocalPath) return s;
    const afterStatic = s.split('/static/')[1]
      || (baseUrl ? s.replace(baseUrl + '/', '').replace(baseUrl, '') : null)
      || s.replace(/^https?:\/\/[^/]+\//, '');
    if (afterStatic) relPath = afterStatic.replace(/^\//, '');
    else return s;
  } else {
    relPath = s.replace(/^\/?static\//, '').replace(/^\//, '');
  }

  const filePath = relPath ? path.join(effectiveStorageLocalPath, relPath) : null;
  try {
    if (filePath && fs.existsSync(filePath)) {
      const buf = fs.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.bmp': 'image/bmp' }[ext] || 'image/png';
      return 'data:' + mime + ';base64,' + buf.toString('base64');
    }
    if (fs.existsSync(s)) {
      const buf = fs.readFileSync(s);
      const ext = path.extname(s).toLowerCase();
      const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.bmp': 'image/bmp' }[ext] || 'image/png';
      return 'data:' + mime + ';base64,' + buf.toString('base64');
    }
    return toPublicUrl(s);
  } catch (e) {
    return toPublicUrl(s);
  }
}

/**
 * 约束图片尺寸到最大 2048、最小 256，且对齐到 16 的倍数
 */
function clampAndAlignSize(size, maxDim = 2048, minDim = 256, align = 16) {
  if (!size || typeof size !== 'string') return '1024x1024';
  const s = size.trim().toLowerCase().replace(/\*/g, 'x');
  const match = s.match(/^(\d+)\s*x\s*(\d+)$/);
  if (!match) return size;

  let w = parseInt(match[1], 10);
  let h = parseInt(match[2], 10);
  if (!w || !h) return size;

  if (w > maxDim || h > maxDim) {
    const scale = Math.min(maxDim / w, maxDim / h);
    w = Math.round((w * scale) / align) * align;
    h = Math.round((h * scale) / align) * align;
  }

  if (w < minDim) w = minDim;
  if (h < minDim) h = minDim;

  w = Math.round(w / align) * align;
  h = Math.round(h / align) * align;

  if (w > maxDim) w = maxDim;
  if (h > maxDim) h = maxDim;

  return `${w}x${h}`;
}

function buildImageUrl(config) {
  const base = (config.base_url || '').replace(/\/$/, '');
  let ep = config.endpoint || '/images/generations';
  if (!ep.startsWith('/')) ep = '/' + ep;
  return base + ep;
}

class BaseImageProvider {
  /**
   * @param {string} name 提供商名称
   */
  constructor(name) {
    this.name = name;
  }

  /**
   * 判断策略是否支持当前配置或模型
   * @param {string} protocol 接口规范
   * @param {string} provider 厂商名称
   * @param {string} model 模型名称
   * @returns {boolean}
   */
  supports(protocol, provider, model) {
    return false;
  }

  /**
   * 执行图片生成操作
   * @param {object} params 调用参数封装
   * @returns {Promise<{ image_url?: string, error?: string }>}
   */
  async generateImage(params) {
    throw new Error(`generateImage not implemented for provider ${this.name}`);
  }
}

module.exports = {
  BaseImageProvider,
  IMAGE_HTTP_TIMEOUT_MS,
  ANTI_SPLIT_NEGATIVE_PROMPT,
  mergeNegativePromptFragments,
  resolveAssetUserNegativeForApi,
  compressImageBuffer,
  resolveImageRef,
  clampAndAlignSize,
  buildImageUrl,
};
