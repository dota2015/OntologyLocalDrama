<template>
  <div class="h3-voice-reference" v-loading="loading">
    <p class="voice-tip">H3 原生声音：优先使用上传样音；未上传时，自动用已保存的 Edge-TTS 音色生成参考声音。</p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <p class="voice-tip">{{ statusText }}</p>
    <audio v-if="selected?.url" :key="selected.url" :src="selected.url" controls preload="none" />
    <div class="voice-actions">
      <el-button size="small" :loading="busy === 'prepare'" :disabled="disabled || !!busy || !voiceId || !!data?.uploaded" @click="prepare">生成 / 更新默认参考声音</el-button>
      <el-button size="small" :loading="busy === 'upload'" :disabled="disabled || !!busy" @click="fileInput?.click()">上传参考声音</el-button>
      <el-button v-if="data?.uploaded" size="small" :disabled="disabled || !!busy" @click="remove">恢复使用 Edge-TTS 音色</el-button>
    </div>
    <input ref="fileInput" type="file" accept=".mp3,.wav,.m4a,.flac,.ogg,.aac" style="display:none" @change="upload" />
    <p class="voice-tip">支持 2～15 秒清晰单人干声，最大 20MB。上传或恢复立即生效；默认样音也会在生成 H3 视频时自动准备。改音色后需重新生成视频才会改变声音。</p>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
const props = defineProps({ dramaId: [Number, String], target: [Number, String], voiceId: String, beforePrepare: Function, disabled: Boolean })
const data = ref(null)
const loading = ref(false)
const busy = ref('')
const error = ref('')
const fileInput = ref(null)
let version = 0
const automatic = computed(() => data.value?.automatic?.voice_id === props.voiceId ? data.value.automatic : null)
const selected = computed(() => data.value?.uploaded || automatic.value)
const statusText = computed(() => data.value?.uploaded ? '当前使用上传样音：' + data.value.uploaded.filename
  : automatic.value ? '当前使用 Edge-TTS 参考声音：' + props.voiceId
    : '当前尚无默认样音，生成 H3 视频时会自动准备。')
function endpoint() { return '/api/v1/audio/h3-voices/' + props.dramaId + '/' + props.target }
async function api(url, options) {
  const response = await fetch(url, options)
  const result = await response.json()
  if (!response.ok || result.success === false) throw new Error(result.error?.message || '参考声音操作失败')
  return result.data
}
async function load() {
  const request = ++version
  data.value = null
  error.value = ''
  if (!props.dramaId || !props.target) return
  loading.value = true
  try { const result = await api(endpoint()); if (request === version) data.value = result }
  catch (e) { if (request === version) error.value = e.message }
  finally { if (request === version) loading.value = false }
}
async function operation(name, action) {
  if (busy.value || props.disabled) return
  const request = ++version
  busy.value = name
  error.value = ''
  try { const result = await action(); if (request === version) data.value = result }
  catch (e) { if (request === version) error.value = e.message }
  finally { busy.value = '' }
}
async function prepare() {
  const url = endpoint()
  await operation('prepare', async () => {
    await props.beforePrepare?.()
    if (url !== endpoint()) throw new Error('当前人物已切换，请重试')
    return api(url + '/prepare', { method: 'POST' })
  })
}
async function upload(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  if (file.size > 20 * 1024 * 1024) { error.value = '参考声音不能超过 20MB'; return }
  await operation('upload', () => {
    const body = new FormData()
    body.append('file', file)
    return api(endpoint() + '/upload', { method: 'POST', body })
  })
}
async function remove() { await operation('remove', () => api(endpoint() + '/upload', { method: 'DELETE' })) }
watch(() => [props.dramaId, props.target], load, { immediate: true })
</script>

<style scoped>
.h3-voice-reference { width: 100%; margin-top: 8px; }
.voice-tip { margin: 6px 0; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.6; }
.voice-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.voice-actions .el-button { margin-left: 0; }
audio { display: block; max-width: 100%; height: 36px; margin: 8px 0; }
</style>
