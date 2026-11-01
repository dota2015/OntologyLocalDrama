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
