const IMAGE_RESOURCE_TYPES = {
  image: 'sb_image',
  first: 'sb_first_image',
  last: 'sb_last_image',
}

function parseOptions(value) {
  if (value && typeof value === 'object') return value
  if (typeof value !== 'string' || !value.trim()) return {}
  try { return JSON.parse(value) || {} } catch (_) { return {} }
}

export function storyboardImageTaskKey(resourceType, storyboardId) {
  if (!resourceType || storyboardId == null) return ''
  return `${resourceType}:${Number(storyboardId)}`
}

/**
 * A durable generation job owns the child async image tasks it expands. Return
 * their semantic resource keys so the sidebar can show the parent once instead
 * of rendering both the parent job and its child poller.
 */
export function activeImageJobCoverage(jobs = []) {
  const covered = new Set()
  for (const job of jobs || []) {
    const options = parseOptions(job?.options)
    const storyboardIds = Array.isArray(options.storyboard_ids) ? options.storyboard_ids : []
    const slots = Array.isArray(options.slots) && options.slots.length ? options.slots : ['image']
    for (const storyboardId of storyboardIds) {
      for (const slot of slots) {
        const resourceType = IMAGE_RESOURCE_TYPES[slot]
        if (resourceType) covered.add(storyboardImageTaskKey(resourceType, storyboardId))
      }
    }

    for (const item of job?.items || []) {
      if (item?.action !== 'image' || ['completed', 'failed', 'cancelled', 'skipped'].includes(item.status)) continue
      const resourceType = IMAGE_RESOURCE_TYPES[item.payload?.slot || 'image']
      if (resourceType && item.payload?.storyboard_id != null) {
        covered.add(storyboardImageTaskKey(resourceType, item.payload.storyboard_id))
      }
    }
  }
  return covered
}
