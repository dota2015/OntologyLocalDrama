/** 统一媒体 URL：优先 local_path，其次 image_url / video_url */
export function assetImageUrl(item) {
  if (!item) return ''
  const lp = item.local_path && String(item.local_path).trim()
  if (lp) return '/static/' + lp.replace(/^\//, '')
  return item.image_url || ''
}

export function storyboardImageUrl(sb) {
  if (!sb) return ''
  return assetImageUrl(sb)
}

export function storyboardVideoUrl(sb) {
  if (!sb) return ''
  const lp = sb.video_local_path && String(sb.video_local_path).trim()
  if (lp) return '/static/' + lp.replace(/^\//, '')
  return sb.video_url || ''
}

export function audioUrl(localPath) {
  if (!localPath) return ''
  const p = String(localPath).trim()
  if (!p) return ''
  return '/static/' + p.replace(/^\//, '')
}

export function episodeVideoUrl(urlOrEp) {
  if (!urlOrEp) return ''
  const raw = typeof urlOrEp === 'string' ? urlOrEp : (urlOrEp.video_url || urlOrEp.local_path || '')
  if (!raw) return ''
  if (/^(https?:|blob:|data:)/i.test(raw)) return raw
  const trimmed = raw.replace(/^\/+/, '')
  if (trimmed.startsWith('static/')) return '/' + trimmed
  return '/static/' + trimmed
}
