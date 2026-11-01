/** H3 supports the multi-reference Ref2VA path used by universal storyboards. */

export function videoModelNameFromAiConfig(cfg) {
  if (!cfg) return ''
  const dm = (cfg.default_model || '').toString().trim()
  if (dm) return dm
  const m = cfg.model
  if (Array.isArray(m) && m.length) return String(m[0]).trim()
  return String(m || '').trim()
}

export function isH3VideoAiConfig(cfg, selectedModel = '') {
  if (/^minimax[-_]?h3\b/i.test(String(selectedModel || '').trim())) return true
  if (!cfg) return false
  const proto = String(cfg.api_protocol || '').toLowerCase()
  const provider = String(cfg.provider || '').toLowerCase()
  const model = videoModelNameFromAiConfig(cfg).toLowerCase()
  return proto === 'minimax_h3'
    || provider === 'minimax_h3'
    || ((!proto || proto === 'openai') && /^minimax[-_]?h3\b/.test(model))
}

export function canUseUniversalOmniVideoApi(cfg) {
  return isH3VideoAiConfig(cfg)
}
