/**
 * 视频提供商工厂 (VideoProviderFactory)
 * 遵循工厂模式 (Factory Pattern)，根据 protocol/provider/model 动态解析并返回对应的 Provider Strategy 实例。
 */

const { MinimaxH3VideoProvider } = require('./providers/minimaxH3Provider');

class VideoProviderFactory {
  static providers = [
    new MinimaxH3VideoProvider(),
  ];

  /**
   * 解析匹配的视频提供商策略
   * @param {object} config AI 配置对象
   * @param {string} [modelHint] 显式传入的模型名称
   * @returns {BaseVideoProvider}
   */
  static getProvider(config, modelHint = '') {
    const protocol = String(config?.api_protocol || '').trim().toLowerCase();
    const provider = String(config?.provider || '').trim().toLowerCase();
    const model = String(modelHint || config?.default_model || '').trim();

    for (const p of this.providers) {
      if (p.supports(protocol, provider, model)) {
        return p;
      }
    }
    return null;
  }
}

module.exports = VideoProviderFactory;
