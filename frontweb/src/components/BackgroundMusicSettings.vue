<template>
  <div class="background-music" v-loading="loading">
    <h3>背景音乐</h3>
    <p class="music-tip">为当前集添加音乐。上传和设置自动保存，重新合成后生效；音乐与视频原声或 TTS 配音混合。</p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <div class="music-row">
      <input ref="fileInput" type="file" accept=".mp3,.wav,.m4a,.ogg,.flac,.aac" style="display:none" @change="upload" />
      <el-button :loading="uploading" :disabled="busy || disabled || !episodeId" @click="fileInput?.click()">{{ settings.local_path ? '更换音乐' : '上传背景音乐' }}</el-button>
      <span v-if="settings.filename">{{ settings.filename }} · {{ Math.round(settings.duration) }} 秒</span>
      <span v-else class="music-tip">支持 MP3、WAV、M4A、OGG、FLAC、AAC，最大 100MB</span>
      <el-button v-if="settings.local_path" :disabled="busy || disabled" link type="danger" @click="remove">移除音乐</el-button>
    </div>
    <audio v-if="settings.url" :key="settings.url" :src="settings.url" controls preload="metadata" class="music-preview" />
    <el-form v-if="settings.local_path" label-width="100px" :disabled="busy || disabled">
      <el-form-item label="合入背景音乐">
        <el-switch v-model="settings.enabled" @change="save" />
      </el-form-item>
      <el-form-item label="音乐音量">
        <el-slider v-model="settings.volume" :min="0" :max="100" :step="1" show-input style="max-width:440px" @change="save" />
        <span class="music-tip">默认 20%，建议先用较低音量试听成片。</span>
      </el-form-item>
      <el-form-item label="循环播放">
        <el-switch v-model="settings.loop" @change="save" />
        <span class="music-tip">开启后自动循环至片尾；关闭后音乐播完即停止。</span>
      </el-form-item>
      <el-form-item label="淡入 / 淡出">
        <el-input-number v-model="settings.fade_in" :min="0" :max="10" :step="0.5" :precision="1" @change="save" />
        <span>秒 /</span>
        <el-input-number v-model="settings.fade_out" :min="0" :max="10" :step="0.5" :precision="1" @change="save" />
        <span>秒</span>
      </el-form-item>
    </el-form>
    <p v-if="settings.local_path" class="music-tip">{{ saving ? '正在保存…' : (error ? '设置未保存，请重试。' : '设置已保存。试听播放器播放的是原始音乐，音量及淡入淡出以重新合成的成片为准。') }}</p>
    <el-button v-if="error && !loading" size="small" :disabled="busy || disabled" @click="settings.local_path ? save() : load()">重试</el-button>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
const props = defineProps({ episodeId: [Number, String], disabled: Boolean })
const fileInput = ref(null)
const settings = ref({})
const loading = ref(false)
const saving = ref(false)
const uploading = ref(false)
const error = ref('')
const busy = computed(() => loading.value || saving.value || uploading.value)
let version = 0
let pendingSave = null
function endpoint(id = props.episodeId) { return '/api/v1/audio/background-music/' + id }
async function api(url, body, method = 'GET') {
  const multipart = body instanceof FormData
  const response = await fetch(url, { method, ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body), headers: multipart ? {} : { 'Content-Type': 'application/json' } }) })
  const result = await response.json()
  if (!response.ok || !(result.success === true || Number(result.code) === 200)) throw new Error(result.error?.message || result.message || '背景音乐操作失败')
  return result.data
}
async function load() {
  const token = ++version
  settings.value = {}
  error.value = ''
  saving.value = false
  uploading.value = false
  pendingSave = null
  loading.value = !!props.episodeId
  if (!props.episodeId) return
  try {
    const data = await api(endpoint())
    if (token === version) settings.value = data
  } catch (e) { if (token === version) error.value = e.message }
  finally { if (token === version) loading.value = false }
}
function save() {
  if (!props.episodeId || saving.value) return pendingSave
  const token = version
  saving.value = true
  error.value = ''
  pendingSave = api(endpoint(), { enabled: settings.value.enabled, volume: settings.value.volume, loop: settings.value.loop, fade_in: settings.value.fade_in, fade_out: settings.value.fade_out }, 'PUT')
    .catch(e => { if (token === version) error.value = e.message })
    .finally(() => { if (token === version) saving.value = false })
  return pendingSave
}
async function upload(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file || busy.value || props.disabled) return
  if (file.size > 100 * 1024 * 1024) { error.value = '背景音乐不能超过 100MB'; return }
  const token = version
  uploading.value = true
  error.value = ''
  try {
    const body = new FormData()
    body.append('file', file)
    const data = await api(endpoint() + '/upload', body, 'POST')
    if (token === version) settings.value = data
  } catch (e) { if (token === version) error.value = e.message }
  finally { if (token === version) uploading.value = false }
}
async function remove() {
  const token = version
  saving.value = true
  error.value = ''
  pendingSave = api(endpoint(), undefined, 'DELETE')
    .then(data => { if (token === version) settings.value = data })
    .catch(e => { if (token === version) error.value = e.message })
    .finally(() => { if (token === version) saving.value = false })
  await pendingSave
}
async function flush() {
  if (loading.value || uploading.value) throw new Error('背景音乐正在加载或上传，请稍后再合成')
  await pendingSave
  if (error.value) throw new Error(error.value)
}
watch(() => props.episodeId, load, { immediate: true })
onBeforeUnmount(() => { version++ })
defineExpose({ flush })
</script>

<style scoped>
.background-music { margin: 12px 0 20px; padding: 16px; border: 1px solid var(--el-border-color); border-radius: 8px; }
.background-music h3 { margin: 0 0 8px; font-size: 16px; }
.music-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: 12px 0; }
.music-tip { color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.6; }
.el-form-item .music-tip { margin-left: 12px; }
.music-preview { display: block; max-width: 100%; height: 36px; margin-bottom: 16px; }
.el-form-item :deep(.el-form-item__content) { gap: 8px; }
</style>
