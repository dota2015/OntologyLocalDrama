// Submission persists the entire plan before acknowledging. Polling never dispatches work.
async function api(url, body) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20000)
  try {
    const response = await fetch('/api/v1' + url, { signal: controller.signal,
      ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
    const data = await response.json()
    if (!response.ok || data.success === false) throw new Error(data.error?.message || '后台任务请求失败')
    return data.data
  } finally { clearTimeout(timer) }
}
export const generationJobsAPI = {
  create: (dramaId, kind, episodeId, options = {}) => api(`/dramas/${dramaId}/generation-jobs`, { kind, episode_id: episodeId, options }),
  list: dramaId => api(`/dramas/${dramaId}/generation-jobs`),
  control: (dramaId, jobId, command) => api(`/dramas/${dramaId}/generation-jobs/${jobId}/${command}`, {}),
}
export const activeGenerationJob = job => ['running', 'paused', 'stopping', 'queued'].includes(job?.status)
