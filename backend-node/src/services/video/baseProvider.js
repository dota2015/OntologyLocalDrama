/**
 * 视频提供商抽象基类 (BaseVideoProvider)
 * 遵循策略模式 (Strategy Pattern)，定义视频提交、轮询与结果解析的标准化契约。
 */

class BaseVideoProvider {
  /**
   * @param {string} name 提供商名称
   */
  constructor(name) {
    this.name = name;
  }

  /**
   * 判断当前 Provider 策略是否支持该协议或厂商
   * @param {string} protocol 协议
   * @param {string} provider 厂商名
   * @param {string} model 模型名称
   * @returns {boolean}
   */
  supports(protocol, provider, model) {
    return false;
  }

  /**
   * 规范化时长参数
   */
  normalizeDuration(duration, model) {
    const val = Number(duration);
    return Number.isFinite(val) && val > 0 ? val : 5;
  }

  /**
   * 规范化画幅比例或分辨率
   */
  normalizeSize(aspectRatio) {
    return aspectRatio || '16:9';
  }

  /**
   * 构建轮询地址
   */
  buildPollUrl(config, taskId, model) {
    const base = String(config?.base_url || '').replace(/\/+$/, '');
    return `${base}/v1/videos/${encodeURIComponent(taskId)}`;
  }

  /**
   * 从第三方响应体中提取可播放的视频 URL
   */
  extractVideoUrl(data) {
    if (!data) return null;
    return data.video_url || data.url || data.output?.video_url || null;
  }
}

module.exports = BaseVideoProvider;
