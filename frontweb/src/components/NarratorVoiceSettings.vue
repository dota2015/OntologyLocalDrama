<template>
  <section id="anchor-dubbing" class="section card">
    <h2 class="section-title">旁白音色设置</h2>
    <p class="dubbing-tip">为 H3 设置独立的旁白音色，可试听或上传旁白参考声音。人物音色请在人物编辑中设置。</p>
    <el-button type="primary" plain :disabled="!dramaId" @click="open">旁白音色设置</el-button>
    <el-dialog v-model="visible" title="旁白音色设置" width="640px" style="max-width:96vw" append-to-body>
      <div v-loading="loading">
        <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon class="dubbing-gap" />
        <el-alert v-if="!loading && !configs.length" title="请先在 AI 配置中添加并启用 TTS 服务，再打开此面板。" type="warning" :closable="false" />
        <el-form label-width="100px" :disabled="saving || loading">
          <el-form-item label="TTS 服务">
            <el-select v-model="profile.config_id" @change="changeConfig">
              <el-option v-for="c in configs" :key="c.id" :value="c.id" :label="c.name" />
            </el-select>
          </el-form-item>
          <el-form-item label="默认音色">
            <el-select v-model="profile.default_voice" filterable allow-create default-first-option placeholder="使用服务默认音色" clearable>
              <el-option v-for="v in voiceOptions" :key="v.id" :label="v.label" :value="v.id" :disabled="v.id === profile.narrator_voice" />
            </el-select>
            <span class="dubbing-tip">未标注人物的对白使用此音色</span>
          </el-form-item>
          <el-form-item label="旁白音色">
            <el-select v-model="profile.narrator_voice" filterable allow-create default-first-option placeholder="选择独立的旁白音色">
              <el-option v-for="v in voiceOptions" :key="v.id" :label="v.label" :value="v.id" :disabled="v.id === profile.default_voice || Object.values(profile.voices).includes(v.id)" />
            </el-select>
            <el-button class="dubbing-preview" :loading="previewing === '__narrator__'" :disabled="!!previewing || !profile.config_id" @click="previewVoice('__narrator__')">试听旁白</el-button>
          </el-form-item>
          <el-form-item label="H3 旁白参考">
            <H3VoiceReferenceSettings v-if="visible && !loading" :drama-id="dramaId" target="narrator" :voice-id="profile.narrator_voice" :before-prepare="saveBeforeH3Reference" :disabled="saving || loading" />
          </el-form-item>
          <el-form-item label="语音速度">
            <span class="dubbing-tip">统一使用自然语速，不再进行倍速处理。</span>
          </el-form-item>
          <p class="dubbing-tip">人物音色请在「编辑角色 → 配音音色」中选择；各分镜的「生成对话 / 编辑文本」用于整理台词。</p>
        </el-form>
      </div>
      <template #footer>
        <el-button @click="visible = false">关闭</el-button>
        <el-button type="primary" :loading="saving" :disabled="loading || !profile.config_id" @click="save">保存音色设置</el-button>
      </template>
    </el-dialog>
  </section>
</template>
<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import H3VoiceReferenceSettings from './H3VoiceReferenceSettings.vue'
import { getVoiceOptionsByProvider } from '@/utils/dubbingVoices'

const props = defineProps({ dramaId: [Number, String] })
const emit = defineEmits(['profile'])
const visible = ref(false)
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const configs = ref([])
const profile = ref({ config_id: null, default_voice: '', narrator_voice: '', speed: 1, voices: {}, character_voices: {}, speaker_characters: {} })
const previewing = ref('')
let audio
const voiceOptions = computed(() => {
  const config = configs.value.find(c => c.id === profile.value.config_id)
  return getVoiceOptionsByProvider(config?.provider)
})
async function api(url, body, method = 'POST') {
  const response = await fetch('/api/v1' + url, body === undefined ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const result = await response.json()
  if (!response.ok || !(result.success === true || Number(result.code) === 200)) throw new Error(result.error?.message || result.message || '操作失败')
  return result.data
}
function endpoint() { return '/audio/dubbing/' + props.dramaId }
async function load(resetProfile = false) {
  const id = props.dramaId
  const data = await api(endpoint() + "/profile")
  if (id !== props.dramaId) return
  configs.value = data.configs
  emit('profile', data.profile)
  if (resetProfile) {
    const selected = data.configs.find(c => c.id === data.profile.config_id) || data.configs.find(c => c.is_default) || data.configs[0]
    profile.value = { config_id: selected?.id, default_voice: data.profile.default_voice ?? selected?.default_voice ?? '', narrator_voice: data.profile.narrator_voice || '', speed: data.profile.speed || 1, voices: { ...(data.profile.voices || {}) }, character_voices: { ...(data.profile.character_voices || {}) }, speaker_characters: { ...(data.profile.speaker_characters || {}) } }
  }
}
async function open() {
  visible.value = true
  loading.value = true
  error.value = ''
  try { await load(true) } catch (e) { error.value = e.message } finally { loading.value = false }
}
async function changeConfig(id) {
  profile.value.default_voice = configs.value.find(c => c.id === id)?.default_voice || ''
  profile.value.narrator_voice = ''
  profile.value.voices = {}
  profile.value.character_voices = {}
  await autoAssign()
}
async function autoAssign() {
  saving.value = true
  error.value = ''
  try { profile.value = await api(endpoint() + '/auto-assign', { ...profile.value, character_voices: {} }) }
  catch (e) { error.value = e.message }
  finally { saving.value = false }
}
async function save() {
  const url = endpoint()
  const selected = { config_id: profile.value.config_id, default_voice: profile.value.default_voice,
    narrator_voice: profile.value.narrator_voice, speed: 1 }
  saving.value = true
  error.value = ''
  try {
    const current = await api(url + '/profile')
    if (url !== endpoint()) throw new Error('剧目已切换，请重新打开音色设置')
    const updated = { ...current.profile, ...selected }
    const saved = await api(url, updated, 'PUT')
    if (url !== endpoint()) return
    profile.value = saved
    emit('profile', profile.value)
    ElMessage.success('音色设置已保存，将用于后续 H3 参考音频生成')
  } catch (e) { error.value = e.message } finally { saving.value = false }
}
async function saveBeforeH3Reference() {
  await save()
  if (error.value) throw new Error(error.value)
}
function play(rel) {
  audio?.pause()
  audio = new Audio('/static/' + rel)
  audio.play().catch(() => ElMessage.error('音频播放失败'))
}
async function previewVoice(speaker) {
  previewing.value = speaker
  try {
    const result = await api(endpoint() + '/preview', { profile: profile.value, speaker })
    play(result.local_path)
  } catch (e) { error.value = e.message } finally { previewing.value = '' }
}
watch(() => props.dramaId, async (id) => {
  visible.value = false
  audio?.pause()
  if (id) { try { await load(true) } catch (_) {} }
}, { immediate: true })
onBeforeUnmount(() => { audio?.pause() })
</script>

<style scoped>
.dubbing-tip { color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.6; margin: 8px 0; }
span.dubbing-tip { margin-left: 12px; }
.dubbing-preview { margin-left: 8px; }
.dubbing-gap { margin-top: 16px; }
</style>
