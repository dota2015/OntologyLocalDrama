<template>
  <el-button type="primary" plain size="large" :disabled="disabled || !episodeId" :loading="starting" title="从各分镜脚本提取台词并结构化整理为对白与旁白文本（不生成音频）" @click="open">📝 提取整理分镜台词{{ running ? '（整理中）' : '' }}</el-button>
  <el-dialog v-model="visible" title="📝 提取整理分镜台词（对白与旁白）" width="640px" style="max-width:96vw" append-to-body>
    <p>从当前集的所有分镜提取已有台词，按人物对白与旁白结构化整理（仅整理文本，不生成音频）。已编辑确认的文本会保留；完成后可在分镜卡片或下方编辑检查，再点击「🎙️ 批量对白与旁白配音(TTS)」生成语音。</p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <template v-if="task">
      <el-progress :percentage="Number(task.progress) || 0" :status="task.status === 'failed' ? 'exception' : (task.status === 'completed' ? 'success' : undefined)" />
      <p>{{ task.error || task.message || '任务已结束' }}</p>
      <p v-if="task.status === 'completed'">已整理 {{ result.succeeded || 0 }} 镜，无明确台词 {{ skipped }} 镜，失败 {{ failures.length }} 镜。</p>
      <p v-for="item in failures" :key="item.storyboard_id">分镜 {{ item.storyboard_number }}：{{ item.error }}</p>
    </template>
    <template #footer>
      <el-button @click="visible = false">关闭</el-button>
      <el-button v-if="running" type="warning" @click="cancel">停止后续提取</el-button>
      <el-button v-else type="primary" :loading="starting" @click="start">提取并整理台词文本</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
const props = defineProps({ dramaId: [Number, String], episodeId: [Number, String], disabled: Boolean })
const emit = defineEmits(['updated'])
const visible = ref(false)
const starting = ref(false)
const error = ref('')
const task = ref(null)
let timer
const running = computed(() => ['pending', 'processing'].includes(task.value?.status))
const result = computed(() => { try { return typeof task.value?.result === 'string' ? JSON.parse(task.value.result) : (task.value?.result || {}) } catch (_) { return {} } })
const failures = computed(() => (result.value.results || []).filter(r => r.error))
const skipped = computed(() => (result.value.results || []).filter(r => r.skipped).length)
function endpoint() { return '/audio/dubbing/' + props.dramaId }
async function api(url, body) {
  const response = await fetch('/api/v1' + url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await response.json()
  if (!response.ok || !(data.success === true || Number(data.code) === 200)) throw new Error(data.error?.message || data.message || '操作失败')
  return data.data
}
async function open() {
  visible.value = true
  error.value = ''
  const dramaId = props.dramaId
  try {
    const current = await api(endpoint() + '/speech-task')
    if (dramaId !== props.dramaId) return
    task.value = current
    if (running.value) poll()
  } catch (e) { error.value = e.message }
}
async function start() {
  starting.value = true
  error.value = ''
  const dramaId = props.dramaId
  try {
    const job = await api(endpoint() + '/speech-batch', { episode_id: props.episodeId })
    if (dramaId !== props.dramaId) return
    task.value = job
    poll()
  } catch (e) { error.value = e.message }
  finally { starting.value = false }
}
function poll() {
  clearTimeout(timer)
  const dramaId = props.dramaId
  const taskId = task.value?.id
  timer = setTimeout(async () => {
    try {
      const current = await api('/tasks/' + taskId)
      if (dramaId !== props.dramaId || taskId !== task.value?.id) return
      task.value = current
      if (running.value) poll()
      else emit('updated')
    } catch (e) {
      if (dramaId !== props.dramaId) return
      error.value = '进度查询失败，可重新打开恢复：' + e.message
      if (running.value) poll()
    }
  }, 1500)
}
async function cancel() {
  try { await api('/tasks/' + task.value.id + '/cancel', {}); poll() } catch (e) { error.value = e.message }
}
watch(() => props.dramaId, () => { clearTimeout(timer); task.value = null; visible.value = false })
onBeforeUnmount(() => clearTimeout(timer))
</script>
