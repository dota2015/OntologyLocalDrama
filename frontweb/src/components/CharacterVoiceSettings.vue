<template>
  <div class="character-voice" v-loading="loading">
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <template v-if="data?.profile.config_id">
      <div class="character-voice-controls">
        <el-select v-model="voice" filterable allow-create default-first-option placeholder="选择或输入音色 ID" :disabled="saving || previewing">
          <el-option v-for="v in options" :key="v.id" :label="v.label" :value="v.id" :disabled="v.id === data.profile.narrator_voice" />
        </el-select>
        <el-button :loading="previewing" :disabled="loading || saving || !voice" @click="preview">试听音色</el-button>
      </div>
      <p class="character-voice-tip">{{ config?.name }} · {{ voice }}</p>
      <p class="character-voice-tip">点击人物窗口的「保存」同步保存音色，与统一配音面板共用；已有配音需重新生成才会变化。</p>
    </template>
    <p v-else-if="!loading && !error" class="character-voice-tip">请先在「AI 配置」启用 TTS 服务，启用后重新打开人物编辑。</p>
    <H3VoiceReferenceSettings v-if="!loading && characterId" :drama-id="dramaId" :target="characterId" :voice-id="voice" :before-prepare="save" :disabled="saving || previewing" />
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import H3VoiceReferenceSettings from './H3VoiceReferenceSettings.vue'
import { EDGE_VOICE_OPTIONS, withCharacterVoice } from '@/utils/dubbingVoices'

const props = defineProps({ dramaId: [Number, String], characterId: [Number, String] })
const emit = defineEmits(['profile'])
const data = ref(null)
const voice = ref('')
const initialVoice = ref('')
const loading = ref(true)
const saving = ref(false)
const previewing = ref(false)
const error = ref('')
let audio
let requestVersion = 0
const config = computed(() => data.value?.configs.find(c => c.id === data.value.profile.config_id))
const options = computed(() => /^(edge-tts|edgetts|edge)$/i.test(config.value?.provider || '') ? EDGE_VOICE_OPTIONS : [])
function endpoint() { return '/audio/dubbing/' + props.dramaId }
async function api(url, body, method = 'POST') {
  const response = await fetch('/api/v1' + url, body === undefined ? {} : {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const result = await response.json()
  if (!response.ok || !(result.success === true || Number(result.code) === 200)) throw new Error(result.error?.message || result.message || '音色操作失败')
  return result.data
}
function profileWithVoice(current) {
  const character = current.characters.find(c => Number(c.id) === Number(props.characterId))
  if (!character) throw new Error('人物已不存在，请重新打开人物编辑')
  return { character, profile: withCharacterVoice(current.profile, character, voice.value) }
}
async function load() {
  const version = ++requestVersion
  loading.value = true
  error.value = ''
  data.value = null
  audio?.pause()
  try {
    const result = await api(endpoint())
    if (version !== requestVersion) return
    data.value = result
    const character = result.characters.find(c => Number(c.id) === Number(props.characterId))
    voice.value = result.profile.character_voices?.[props.characterId] || result.profile.voices?.[character?.name] || result.profile.default_voice || ''
    initialVoice.value = voice.value
    emit('profile', result.profile)
  } catch (e) { if (version === requestVersion) error.value = e.message }
  finally { if (version === requestVersion) loading.value = false }
}
async function save() {
  if (loading.value) throw new Error('人物音色正在加载，请稍后保存')
  // A missing/unavailable TTS service must not prevent ordinary character edits.
  if (!data.value?.profile.config_id) return
  saving.value = true
  error.value = ''
  try {
    // Re-read so editing one character preserves other voices/settings saved elsewhere.
    const current = await api(endpoint())
    if (current.profile.config_id !== data.value.profile.config_id) throw new Error('TTS 服务已变更，请重新打开人物编辑后选择音色')
    if (current.profile.character_voices?.[props.characterId] !== initialVoice.value && voice.value === initialVoice.value) {
      // No local edit: retain an assignment changed in the unified panel.
      voice.value = current.profile.character_voices?.[props.characterId] || initialVoice.value
    }
    const { profile } = profileWithVoice(current)
    const saved = await api(endpoint(), profile, 'PUT')
    initialVoice.value = voice.value
    data.value = { ...current, profile: saved }
    emit('profile', saved)
  } catch (e) { error.value = e.message; throw e }
  finally { saving.value = false }
}
async function preview() {
  previewing.value = true
  error.value = ''
  try {
    const { character, profile } = profileWithVoice(data.value)
    const result = await api(endpoint() + '/preview', { profile, speaker: character.name })
    audio?.pause()
    audio = new Audio('/static/' + result.local_path)
    await audio.play()
  } catch (e) { error.value = e.message || '音频播放失败' }
  finally { previewing.value = false }
}
watch(() => [props.dramaId, props.characterId], load, { immediate: true })
onBeforeUnmount(() => { requestVersion++; audio?.pause() })
defineExpose({ save })
</script>

<style scoped>
.character-voice { width: 100%; min-height: 40px; }
.character-voice-controls { display: flex; gap: 8px; flex-wrap: wrap; }
.character-voice-controls .el-select { width: min(360px, 100%); }
.character-voice-tip { margin: 5px 0 0; font-size: 12px; color: var(--el-text-color-secondary); line-height: 1.6; }
</style>
