export function meaningfulSpeech(value) {
  const text = String(value || '').trim()
  return !!text && !/^(?:无|无对白|无对话|无台词|无旁白|无解说|none|null|silent)[。.!！\s]*$/iu.test(text)
}
export function shotSpeechStatus(shot, recognized) {
  // Summaries describe the exact current text, not an older extraction.
  if (recognized && recognized.sourceDialogue === (shot.dialogue || '') && recognized.sourceNarration === (shot.narration || '') && recognized.sourceUniversal === (shot.universal_segment_text || '')) return recognized
  const dialogue = meaningfulSpeech(shot.dialogue)
  const narration = meaningfulSpeech(shot.narration)
  const universal = String(shot.universal_segment_text || '')
  const cue = /对白|对话|旁白|说[：:“"]|dialogue|narration/iu.test(universal)
  return { dialogue, narration, pending: !dialogue && !narration && cue }
}
export function automaticVideoModel(configs, status) {
  const active = configs.filter(c => c.is_active !== false && c.is_active !== 0)
  // 默认直接采用 minimax_h3，不再根据是否有对白自动推荐 Wan2.2
  const selected = active.find(c => {
    const id = String(c.api_protocol || c.provider || '') + ' ' + String(c.default_model || (Array.isArray(c.model) ? c.model.join(' ') : c.model) || '')
    return /minimax[_-]?h3/i.test(id)
  }) || active.find(c => c.is_default) || active[0]
  return selected?.default_model || (Array.isArray(selected?.model) ? selected.model[0] : selected?.model) || ''
}
