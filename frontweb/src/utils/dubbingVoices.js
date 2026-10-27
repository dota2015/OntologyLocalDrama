export const EDGE_VOICE_OPTIONS = [
  { id: 'zh-CN-YunxiaNeural', label: '云夏 · 男声（偏少年）' },
  { id: 'zh-CN-YunxiNeural', label: '云希 · 男声' },
  { id: 'zh-CN-YunjianNeural', label: '云健 · 男声' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊 · 女声' },
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 女声' },
  { id: 'zh-CN-YunyangNeural', label: '云扬 · 播报男声' },
]

export const INDEXTTS_VOICE_OPTIONS = [
  { id: 'voice_01.wav', label: 'IndexTTS 01 · 青年男声' },
  { id: 'voice_02.wav', label: 'IndexTTS 02 · 阳光少年' },
  { id: 'voice_03.wav', label: 'IndexTTS 03 · 稳重男声' },
  { id: 'voice_04.wav', label: 'IndexTTS 04 · 磁性男声' },
  { id: 'voice_05.wav', label: 'IndexTTS 05 · 沉稳低音' },
  { id: 'voice_06.wav', label: 'IndexTTS 06 · 清爽男声' },
  { id: 'voice_07.wav', label: 'IndexTTS 07 · 清新女声' },
  { id: 'voice_08.wav', label: 'IndexTTS 08 · 知性女声（推荐旁白）' },
  { id: 'voice_09.wav', label: 'IndexTTS 09 · 温柔女声' },
  { id: 'voice_11.wav', label: 'IndexTTS 11 · 干练女声' },
  { id: 'voice_12.wav', label: 'IndexTTS 12 · 沉稳女声' },
]

export function getVoiceOptionsByProvider(provider) {
  const p = String(provider || '').toLowerCase()
  if (/^(indextts|indextts2|indextts25|local)$/i.test(p) || p.includes('7860')) {
    return INDEXTTS_VOICE_OPTIONS
  }
  if (/^(edge-tts|edgetts|edge)$/i.test(p)) {
    return EDGE_VOICE_OPTIONS
  }
  return []
}

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
