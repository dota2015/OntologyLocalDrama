const { assessVideoSpeech } = require('./speechTiming');

function normalizeDurationRange(value, legacyDuration = 5) {
  const fallbackMax = Math.min(15, Math.max(4, Math.round(Number(legacyDuration) || 5)));
  const range = value || { min: 4, max: fallbackMax };
  const min = Number(range.min);
  const max = Number(range.max);
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 4 || max > 15 || min > max) throw new Error('单镜时长范围需为 4–15 秒的整数，最短不能大于最长');
  return { min, max };
}
function planShotDuration(shot, range, speechOptions) {
  const raw = Math.round(Number(String(shot.duration ?? '').replace(/s$/i, '')));
  const suggested = raw > 0 ? raw : Math.round((range.min + range.max) / 2);
  const speech = assessVideoSpeech(shot, shot.universal_segment_text, range.max, speechOptions);
  return Math.min(range.max, Math.max(range.min, suggested, Math.ceil(speech.requiredSeconds)));
}
function rangeTimingInstructions(range, narrativeStyle) {
  const baseRate = Number(narrativeStyle?.speech_rate) > 0 ? Number(narrativeStyle.speech_rate) : 1.5;
  const creditRatio = baseRate >= 1.4 ? 0.8 : 0.5;
  const effectiveRate = baseRate > 1 ? 1 + (baseRate - 1) * creditRatio : baseRate;
  const maxChars = Math.floor(Math.max(1, range.max - 1) * 4 * effectiveRate);
  const shortShotAlert = range.max <= 5
    ? `\n【4–5秒短镜头极速模式铁律】：本项目严格锁定 4–5 秒短镜头（确保视频生成极速完成），基准语速 ${baseRate}x。每个镜头的对白或旁白总汉字数绝不能超过 ${maxChars} 个字！凡超过 ${maxChars} 个字的较长对白或旁白，必须在拆分镜时直接拆分成多个连续的 4–5 秒分镜（按逗号、句号逐字切分，每镜不超过 ${maxChars} 字），严禁在单镜内塞入超长台词！`
    : '';
  return `\n\n【最高优先级：按需规划每镜时长与强制对白时长预算】
单镜 duration 必须在 ${range.min}–${range.max} 秒内（含边界，整数秒）。这是显卡负载预算，不是固定时长；不要把所有分镜都机械写成 5 秒或都用上限。
根据镜头任务分别分配：短反应、过场可用较短时长，动作过程、对白轮次、情绪停顿用较长时长；情节相同的相邻镜头可同长，不必强制凑不同数字。
${narrativeStyle ? require('../services/speechDeliveryService').planningInstructions(narrativeStyle,range.max) : `对白与旁白合计按每秒约4个中文字或2.5个英文单词估算，混合语言相加；至少另留1秒收尾，并为动作、换人说话、停顿预留时间。${range.max}秒的范围上限最多约 ${Math.floor((range.max - 1) * 4)} 个中文字；短镜的字数预算相应更少。`}
完整保留剧本的台词、旁白及说话者与顺序，禁止删字、缩写或超出本镜既定语速强行塞字。台词所需时长超过 ${range.max} 秒时按完整语义拆镜，每个新镜头重新在范围内按需分配；允许增加镜头数，不突破上限。${shortShotAlert}
镜头数量与全片总时长只是规划参考，此范围和完整表达优先于凑镜数或总秒数。输出每个镜头各自的 duration，视频提示词与结构化台词一致。`;
}
module.exports = { normalizeDurationRange, planShotDuration, rangeTimingInstructions };
