/**
 * Unsloth 本地模型图片生成策略 (UnslothImageProvider)
 * 遵循策略模式 (Strategy Pattern)，委托 unslothImageService 执行本地推理与 CFG 控制。
 */

const {
  BaseImageProvider,
  resolveImageRef,
} = require('../baseProvider');

class UnslothImageProvider extends BaseImageProvider {
  constructor() {
    super('unsloth');
  }

  supports(protocol, provider, model) {
    const p = String(provider || '').toLowerCase();
    const proto = String(protocol || '').toLowerCase();
    return proto === 'unsloth' || p === 'unsloth';
  }

  async generateImage({ db, config, log, opts, effectivePrompt, mergedNegativePrompt, model, size }) {
    const { reference_image_urls, files_base_url, storage_local_path, imageServiceType } = opts;
    const refs = (reference_image_urls || []).filter(Boolean)
      .map((ref) => resolveImageRef(ref, files_base_url, storage_local_path));

    let guidanceForUnsloth = opts.guidance;
    if (guidanceForUnsloth == null && (imageServiceType === 'storyboard_image' || opts.storyboard_id) && refs.length > 0) {
      guidanceForUnsloth = 2.0;
    }
    const unslothService = require('../../unslothImageService');
    const result = await unslothService.callUnslothImageApi(config, log, {
      prompt: effectivePrompt,
      model,
      size,
      reference_image_urls: refs,
      negative_prompt: mergedNegativePrompt || undefined,
      guidance: guidanceForUnsloth,
    });
    if (!result.error && opts.image_gen_id && result.size && db) {
      try {
        db.prepare('UPDATE image_generations SET size = ?, width = ?, height = ? WHERE id = ?')
          .run(result.size, result.width, result.height, opts.image_gen_id);
      } catch (e) {
        log?.warn?.('[Unsloth图生] 更新尺寸信息失败', { error: e.message, image_gen_id: opts.image_gen_id });
      }
    }
    return result;
  }
}

module.exports = {
  UnslothImageProvider,
};
