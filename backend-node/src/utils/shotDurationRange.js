const { assessVideoSpeech } = require('./speechTiming');

function normalizeDurationRange(value, legacyDuration = 5) {
  const fallbackMax = Math.min(8, Math.max(4, Math.round(Number(legacyDuration) || 5)));
  const range = value || { min: 4, max: fallbackMax };
  const min = Number(range.min);
  const max = Number(range.max);
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 4 || max > 8 || min > max) throw new Error('H3 单镜时长范围需为 4–8 秒的整数，最短不能大于最长');
  return { min, max };
}
function planShotDuration(shot, range, speechOptions) {
  const raw = Math.round(Number(String(shot.duration ?? '').replace(/s$/i, '')));
  const suggested = raw > 0 ? raw : Math.round((range.min + range.max) / 2);
  const speech = assessVideoSpeech(shot, shot.universal_segment_text, range.max, speechOptions);
  return Math.min(range.max, Math.max(range.min, suggested, Math.ceil(speech.requiredSeconds)));
}
function rangeTimingInstructions(range, narrativeStyle) {
  const maxChars = Math.floor(Math.max(0, range.max - 1.5) * 4);
  const shortShotAlert = range.max <= 5
    ? `\n【4–5秒短镜头模式铁律】：人物和旁白固定使用自然语速 1.0x。每个镜头的对白或旁白总汉字数绝不能超过 ${maxChars} 个字；较长台词必须按语义拆成多个连续分镜，严禁通过语音加速硬塞！`
    : '';
  return `\n\n【最高优先级：按需规划每镜时长与强制对白时长预算】
单镜 duration 必须在 ${range.min}–${range.max} 秒内（含边界，整数秒）。这是显卡负载预算，不是固定时长；不要把所有分镜都机械写成 5 秒或都用上限。
根据镜头任务分别分配：短反应、过场可用较短时长，动作过程、对白轮次、情绪停顿用较长时长；情节相同的相邻镜头可同长，不必强制凑不同数字。
${narrativeStyle ? require('../services/speechDeliveryService').planningInstructions(narrativeStyle,range.max) : `对白与旁白合计按每秒约4个中文字或2.5个英文单词估算，混合语言相加；至少另留1.5秒收尾，并为动作、换人说话、停顿预留时间。${range.max}秒的范围上限最多约 ${Math.floor(Math.max(0, range.max - 1.5) * 4)} 个中文字；短镜的字数预算相应更少。`}
完整保留剧本的台词、旁白及说话者与顺序，禁止删字、缩写或超出本镜既定语速强行塞字。台词所需时长超过 ${range.max} 秒时按完整语义拆镜，每个新镜头重新在范围内按需分配；允许增加镜头数，不突破上限。${shortShotAlert}
镜头数量与全片总时长只是规划参考，此范围和完整表达优先于凑镜数或总秒数。输出每个镜头各自的 duration，视频提示词与结构化台词一致。`;
}
module.exports = { normalizeDurationRange, planShotDuration, rangeTimingInstructions };
