const { assessVideoSpeech, hanCapacity, normalizeSpeechRate, DEFAULT_TTS_SPEED } = require('./speechTiming');

function normalizeDurationRange(value, legacyDuration = 5) {
  const legacy = Math.round(Number(legacyDuration) || 0);
  const fallbackMax = legacy > 0 ? Math.min(30, Math.max(4, legacy)) : 30;
  const range = value || { min: 4, max: fallbackMax };
  const min = Number(range.min);
  const max = Number(range.max);
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 4 || max > 30 || min > max) throw new Error('单个逻辑分镜时长范围需为 4–30 秒的整数，最短不能大于最长');
  return { min, max };
}
function planShotDuration(shot, range, speechOptions) {
  const raw = Math.round(Number(String(shot.duration ?? '').replace(/s$/i, '')));
  const suggested = raw > 0 ? raw : Math.round((range.min + range.max) / 2);
  const speech = assessVideoSpeech(shot, shot.universal_segment_text, range.max, speechOptions);
  return Math.min(range.max, Math.max(range.min, suggested, Math.ceil(speech.requiredSeconds)));
}
function rangeTimingInstructions(range, narrativeStyle) {
  const configuredRate = normalizeSpeechRate(narrativeStyle?.tts_speed, DEFAULT_TTS_SPEED);
  const maxChars = hanCapacity(range.max, configuredRate);
  const shortShotAlert = range.max <= 8
    ? `\n【4–8秒普通 H3 模式铁律】：按当前 TTS 速度 ${configuredRate}x 计算本镜容量（上限约 ${maxChars} 个中文字），不要把固定字数当作自然规律；较长台词可延长到9–30秒交给 Continuum，或按语义拆成多个连续分镜，禁止删字或截断！`
    : '';
  return `\n\n【最高优先级：按需规划每镜时长与强制对白时长预算】
单个逻辑分镜 duration 必须在 ${range.min}–${range.max} 秒内（含边界，整数秒）。4–8 秒使用普通 H3，9–30 秒使用 H3 Continuum；不得规划超过 30 秒的单镜。这是显卡负载预算，不是固定时长；不要把所有分镜都机械写成 5 秒或都用上限。
根据镜头任务分别分配：短反应、过场可用较短时长，动作过程、对白轮次、情绪停顿用较长时长；情节相同的相邻镜头可同长，不必强制凑不同数字。
${narrativeStyle ? require('../services/speechDeliveryService').planningInstructions(narrativeStyle,range.max) : `先按中文约4字/秒、英文约2.5词/秒的自然基准乘以实际 TTS 速度（IndexTTS 未配置时默认1.25x）估算；${range.max}秒上限当前约可容纳 ${maxChars} 个中文字。对白和旁白共用实际时间，按时间轴安排动作，不预留固定收尾静音。`}
完整保留剧本的台词、旁白及说话者与顺序，禁止删字、缩写或超出本镜既定语速强行塞字。台词所需时长超过 30 秒时按完整语义拆镜；9–30 秒可保留为一个 Continuum 逻辑分镜。${shortShotAlert}
镜头数量与全片总时长只是规划参考，此范围和完整表达优先于凑镜数或总秒数。输出每个镜头各自的 duration，视频提示词与结构化台词一致。`;
}
module.exports = { normalizeDurationRange, planShotDuration, rangeTimingInstructions };
