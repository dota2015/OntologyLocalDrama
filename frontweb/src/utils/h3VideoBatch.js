export const isH3VideoModel = model => /minimax[_-]?h3/i.test(String(model || ''))
// A following H3 shot must prepare its actual predecessor's completed tail, even in a mixed-model batch.
export function videoBatchConcurrency(boards, modelOf, configured, continuity = false) {
  return continuity || boards.some(sb => !modelOf(sb) || isH3VideoModel(modelOf(sb))) ? 1 : Math.max(1, Number(configured) || 2)
}
export function orderedVideoShots(boards) {
  return [...boards].sort((a, b) => Number(a.storyboard_number) - Number(b.storyboard_number) || Number(a.id) - Number(b.id))
}
