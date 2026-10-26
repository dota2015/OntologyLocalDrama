export const EDGE_VOICE_OPTIONS = [
  { id: 'zh-CN-YunxiaNeural', label: '云夏 · 男声（偏少年）' },
  { id: 'zh-CN-YunxiNeural', label: '云希 · 男声' },
  { id: 'zh-CN-YunjianNeural', label: '云健 · 男声' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊 · 女声' },
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 女声' },
  { id: 'zh-CN-YunyangNeural', label: '云扬 · 播报男声' },
]

// Keep the stable character ID and every linked speaker label in sync.
export function withCharacterVoice(profile, character, voice) {
  const selected = String(voice || '').trim()
  if (!selected) throw new Error('请选择人物音色')
  if (selected === profile.narrator_voice) throw new Error('人物音色不能与旁白相同')
  const voices = { ...profile.voices, [character.name]: selected }
  for (const [speaker, id] of Object.entries(profile.speaker_characters || {})) {
    if (Number(id) === Number(character.id)) voices[speaker] = selected
  }
  return {
    ...profile,
    voices,
    character_voices: { ...profile.character_voices, [character.id]: selected },
  }
}
