/**
 * 图片提供商工厂 (ImageProviderFactory)
 * 遵循工厂模式 (Factory Pattern)，根据 protocol/provider/model 动态解析并返回对应的 Provider Strategy 实例。
 */

const { DashScopeImageProvider } = require('./providers/dashScopeProvider');
const { KlingImageProvider } = require('./providers/klingProvider');
const { GeminiImageProvider } = require('./providers/geminiProvider');
const { NanoBananaImageProvider } = require('./providers/nanoBananaProvider');
const { ComfyUiImageProvider } = require('./providers/comfyUiImageProvider');
const { UnslothImageProvider } = require('./providers/unslothProvider');
const { OpenAiImageProvider } = require('./providers/openAiProvider');
const { BaseImageProvider } = require('./baseProvider');

class ImageProviderFactory {
  static providers = [
    new ComfyUiImageProvider(),
    new DashScopeImageProvider(),
    new KlingImageProvider(),
    new GeminiImageProvider(),
    new NanoBananaImageProvider(),
    new UnslothImageProvider(),
    new OpenAiImageProvider(),
  ];

  static defaultProvider = new OpenAiImageProvider();

  /**
   * 根据 provider 名或模型推断接口规范（api_protocol 未设置时的兜底逻辑）
   * @param {string} provider
   * @param {string} model
   * @returns {string}
   */
  static inferProtocol(provider, model) {
    const p = String(provider || '').toLowerCase();
    if (p === 'comfyui' || p === 'comfyui_image') return 'comfyui';
    if (p === 'dashscope' || p === 'qwen_image') return 'dashscope';
    if (p === 'nano_banana') return 'nano_banana';
    if (p === 'gemini' || p === 'google') return 'gemini';
    if (p === 'volces' || p === 'volcengine' || p === 'volc') return 'volcengine';
    if (/seedream|doubao/i.test(model || '')) return 'volcengine';
    if (p === 'kling' || p === 'klingai') return 'kling';
    if (/^kling-/i.test(model || '')) return 'kling';
    if (p === 'agnes' || /agnes-image|apihub\.agnes-ai\.com/i.test(String(model || ''))) return 'agnes';
    return 'openai';
  }

  /**
   * 解析匹配的图片提供商策略
   * @param {object} config AI 配置对象
   * @param {string} [modelHint] 显式传入的模型名称
   * @returns {BaseImageProvider}
   */
  static getProvider(config, modelHint = '') {
    const protocol = String(config?.api_protocol || '').trim().toLowerCase();
    const provider = String(config?.provider || '').trim().toLowerCase();
    const model = String(modelHint || config?.default_model || '').trim();
    const effectiveProtocol = protocol || this.inferProtocol(provider, model);

    for (const p of this.providers) {
      if (p.supports(effectiveProtocol, provider, model)) {
        return p;
      }
    }
    return this.defaultProvider;
  }
}

module.exports = ImageProviderFactory;
