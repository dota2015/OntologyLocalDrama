export function missingStoryboardImageSlots({ useFirstLast, hasFirst, hasLast, hasImage }) {
  if (!useFirstLast) return hasImage ? [] : ['image']
  return [!hasFirst && 'first', !hasLast && 'last'].filter(Boolean)
}

// Re-check each slot after waiting: another action may have supplied its image.
// A tail must never be submitted before the first frame has finished successfully.
export async function fillMissingStoryboardImages({ getMissingSlots, generate, shouldStop = () => false }) {
  const generated = []
  for (const slot of getMissingSlots()) {
    if (shouldStop()) return { stopped: true, generated }
    if (!getMissingSlots().includes(slot)) continue
    const result = await generate(slot)
    if (result?.paused) return { paused: true, generated }
    if (result?.status && result.status !== 'completed') {
      throw new Error(result.error || '图片任务尚未成功完成，请刷新后重试')
    }
    if (slot !== 'image' && getMissingSlots().includes(slot)) {
      throw new Error(`${slot === 'last' ? '尾帧' : '首帧'}尚未确认生成完成，请刷新后重试`)
    }
    generated.push(slot)
  }
  return { stopped: false, generated }
}
