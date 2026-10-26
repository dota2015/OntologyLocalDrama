// Video generation includes provider queuing, sampling and download. Elapsed time alone
// cannot establish failure; the backend owns terminal status and restart recovery.
export const isVideoTask = task => task?.type === 'video_generation' || task?.resourceType === 'sb_video'
export function videoAwareMaxAttempts(meta, fallback = 450) {
  return isVideoTask(meta) ? Infinity : fallback
}
export function canExpireLocally(task) {
  return !isVideoTask(task)
}
