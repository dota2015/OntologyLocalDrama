export function directorPlanningInputs(count, seconds, range) {
  const read = (value, label, min, max) => {
    if (value == null || value === '') return undefined
    const n = Number(value)
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label}需为 ${min}–${max} 的整数，或留空自动规划`)
    return n
  }
  const storyboard_count = read(count, '分镜数量', 1, 200)
  const video_duration = read(seconds, '视频总时长', 10, 600)
  if (video_duration != null) {
    const minCount = Math.ceil(video_duration / range.max)
    const maxCount = Math.floor(video_duration / range.min)
    if (minCount > maxCount || (storyboard_count != null && (storyboard_count < minCount || storyboard_count > maxCount))) {
      throw new Error(`总时长 ${video_duration} 秒、单镜 ${range.min}–${range.max} 秒${storyboard_count ? `、${storyboard_count} 镜` : ''}无法同时满足。`
        + (minCount <= maxCount ? `仅按时长需 ${minCount}–${maxCount} 镜；请调整数值或留空自动规划。` : '请调整总时长或将其留空。'))
    }
  }
  return { ...(storyboard_count != null ? { storyboard_count } : {}), ...(video_duration != null ? { video_duration } : {}) }
}

const HAN_PER_SECOND = 4
const WORDS_PER_SECOND = 2.5
const DEFAULT_TTS_SPEED = 1.25

function speechTextFromScriptLine(line) {
  const match = String(line || '').match(/^\s*([^：:\n]{1,24})\s*[：:]\s*(.*?)\s*$/u)
  if (!match) return null
  const label = match[1].replace(/[“”"'「」『』]/gu, '').trim()
  const text = match[2].replace(/^[“"「『]|[”"」』]$/gu, '').trim()
  // Ignore screenplay metadata and action/scene labels. Unknown short labels are
  // treated as speakers so manually written dialogue remains visible to the
  // preflight estimate.
  if (!text || /^(?:场景|镜头|镜头标题|标题|类型|风格|标签|人物|道具|场景|时间|地点|动作|结果|画面|运镜|景别|光线|氛围|情绪|音效|配乐|时长|旁白说明|narration|dialogue|action|title|scene|style)$/iu.test(label)) return null
  return { text, narration: /旁白|解说|voice.?over|narrat/iu.test(label) }
}

/**
 * Conservative client-side speech estimate used only for an inline warning.
 * The backend remains authoritative and performs the full extraction before
 * starting the director task.
 */
export function estimateScriptSpeech(script, speed = DEFAULT_TTS_SPEED) {
  const lines = String(script || '').split(/\r?\n/u)
  const speech = lines.map(speechTextFromScriptLine).filter(Boolean)
  if (!speech.length) return { seconds: 0, han: 0, words: 0, lines: 0, speed: DEFAULT_TTS_SPEED }
  const rate = Number.isFinite(Number(speed)) && Number(speed) > 0 ? Number(speed) : DEFAULT_TTS_SPEED
  const text = speech.map((item) => item.text).join('\n')
  const han = (text.match(/\p{Script=Han}/gu) || []).length
  const words = (text.replace(/\p{Script=Han}/gu, ' ').match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || []).length
  return { seconds: (han / HAN_PER_SECOND + words / WORDS_PER_SECOND) / rate, han, words, lines: speech.length, speed: rate }
}

export function speechPlanningWarning(script, count, duration, range, speed = DEFAULT_TTS_SPEED) {
  const estimate = estimateScriptSpeech(script, speed)
  if (!estimate.lines || (!count && !duration)) return ''
  const maxAvailable = duration != null && duration !== ''
    ? Number(duration)
    : count != null && count !== ''
      ? Number(count) * Number(range?.max || 8)
      : 0
  if (!Number.isFinite(maxAvailable) || maxAvailable <= 0 || estimate.seconds <= maxAvailable + 0.2) return ''
  const required = Math.ceil(estimate.seconds)
  const targetShots = Math.ceil(required / Number(range?.max || 8))
  const targetDuration = Math.max(required, targetShots * Number(range?.min || 4))
  const limitText = duration != null && duration !== ''
    ? `当前总时长仅 ${Math.round(maxAvailable)} 秒`
    : `${count} 镜按最长 ${range?.max || 8} 秒最多 ${Math.round(maxAvailable)} 秒`
  return `当前台词与旁白约需 ${required} 秒（按 TTS ${estimate.speed}x，未含额外动作停顿），${limitText}；建议至少 ${targetShots} 镜、约 ${targetDuration} 秒。提交时后端仍会按完整剧本最终校验。`
}
