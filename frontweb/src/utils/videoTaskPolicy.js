// These tasks can legitimately spend a long time inside a provider/model call. Elapsed
// browser time cannot establish failure; the backend owns terminal status and restart
// recovery. Director storyboard generation is included because multi-batch ReAct runs
// commonly exceed the generic 15-minute observer window.
export const isVideoTask = task => task?.type === 'video_generation' || task?.resourceType === 'sb_video'

export const isDurableBackendTask = task => (
  isVideoTask(task)
  || task?.type === 'director_storyboard_generation'
  || task?.taskType === 'director_storyboard_generation'
  || task?.resourceType === 'generate_storyboard'
)

export function videoAwareMaxAttempts(meta, fallback = 450) {
  return isDurableBackendTask(meta) ? Infinity : fallback
}
export function canExpireLocally(task) {
  return !isDurableBackendTask(task)
}
