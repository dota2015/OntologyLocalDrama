// Polling only observes durable server work. Disposing the observer never cancels a batch.
export function createVideoBatchMonitor({ getBatch, onStatus, schedule = setTimeout, cancel = clearTimeout }) {
  let epoch = 0
  let timer
  return {
    watch(episodeId) {
      const current = ++epoch
      cancel(timer)
      if (!episodeId) return
      const tick = async () => {
        try {
          const batch = await getBatch(episodeId)
          if (current !== epoch) return
          await onStatus(batch, episodeId)
        } catch (_) { /* Keep the server queue running through network failures. */ }
        if (current === epoch) timer = schedule(tick, 5000)
      }
      tick()
    },
    dispose() { epoch++; cancel(timer) },
  }
}
