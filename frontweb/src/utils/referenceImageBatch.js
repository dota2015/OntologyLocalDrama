export function hasReferenceImage(resource) {
  return !!(resource?.image_url || resource?.local_path)
}

export function referenceImageJobs(groups, scope = 'all') {
  const seen = new Set()
  return Object.entries(groups).flatMap(([type, resources]) => {
    if (scope !== 'all' && scope !== type) return []
    return (resources || []).flatMap(resource => {
      const id = Number(resource.id)
      const key = `${type}:${id}`
      if (!Number.isSafeInteger(id) || id <= 0 || seen.has(key) || hasReferenceImage(resource)) return []
      seen.add(key)
      return [{ type, id, label: resource.name || resource.location || String(id) }]
    })
  })
}

// Re-check each resource immediately before submitting: a prior upload or another
// generator may already have filled it. Work is serial to avoid flooding the GPU.
export async function runReferenceImageBatch(jobs, { resolve, isRunning, generate, shouldStop, onProgress }) {
  const state = { total: jobs.length, current: 0, success: 0, failed: 0, skipped: 0, pending: 0, stopped: false, label: '', errors: [] }
  const publish = () => onProgress?.({ ...state, errors: [...state.errors] })
  publish()
  for (const job of jobs) {
    if (shouldStop()) { state.stopped = true; break }
    const resource = resolve(job)
    state.label = job.label
    if (!resource || hasReferenceImage(resource) || isRunning(job)) {
      state.skipped++
      state.current++
      publish()
      continue
    }
    publish()
    try {
      const result = await generate(job, resource)
      if (result?.status === 'completed') state.success++
      else if (result?.status === 'timeout' || result?.status === 'cancelled') {
        state.pending++
        state.stopped = true
        state.errors.push({ ...job, error: result.error || '任务尚未确认完成，请刷新查看' })
      } else {
        throw new Error(result?.error || '图片生成失败')
      }
    } catch (error) {
      state.failed++
      state.errors.push({ ...job, error: error.message || '图片生成失败' })
    }
    state.current++
    publish()
    if (state.stopped) break
  }
  state.label = ''
  publish()
  return { ...state, remaining: state.total - state.current }
}
