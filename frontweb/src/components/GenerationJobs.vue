<template>
  <section v-if="visibleJobs.length || error" class="generation-jobs" aria-live="polite">
    <el-alert v-if="error" :title="'后台进度暂时无法查询，任务不会因此停止：' + error" type="warning" :closable="false" />
    <div v-for="job in visibleJobs" :key="job.id" class="generation-job">
      <div class="generation-job-header">
        <div><strong>{{ labels[job.kind] || '后台生成' }}</strong> · {{ statuses[job.status] || job.status }} · {{ job.current }}/{{ job.total }} 步 <span v-if="job.failed"> · 失败 {{ job.failed }}</span></div>
        <el-button v-if="canDismiss(job)" size="small" type="info" plain class="dismiss-btn" title="关闭并清除此进度提示" @click="dismiss(job)">✕ 关闭提示</el-button>
      </div>
      <div v-if="activeGenerationJob(job)">{{ job.label }}（刷新或关闭页面后继续执行）</div>
      <el-progress :percentage="job.total ? Math.min(100, Math.round(job.current / job.total * 100)) : 0" :status="job.failed ? 'exception' : job.status === 'completed' ? 'success' : undefined" />
      <el-button v-if="job.status === 'running' && job.items.some(i => i.status === 'running' && i.child_type === 'timer')" size="small" :disabled="controlling" @click="control(job, 'skip_wait')">立即进入下一阶段</el-button>
      <el-button v-if="job.status === 'running'" size="small" :disabled="controlling" @click="control(job, 'pause')">暂停后续步骤</el-button>
      <el-button v-if="job.status === 'paused'" size="small" :disabled="controlling" @click="control(job, 'resume')">继续</el-button>
      <el-button v-if="['running','paused','queued'].includes(job.status)" size="small" :disabled="controlling" @click="control(job, 'stop')">{{ job.status === 'queued' ? '取消排队' : '停止后续步骤' }}</el-button>
      <small v-if="job.status === 'stopping'">已停止后续提交，当前步骤完成后结束</small>
      <div v-for="item in job.items.filter(i => i.error)" :key="item.id" class="generation-error">{{ item.label }}：{{ item.error }}</div>
      <div v-if="job.error && !job.items.some(i => i.error === job.error)" class="generation-error">{{ job.error }}</div>
    </div>
  </section>
</template>
<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { generationJobsAPI, activeGenerationJob } from '@/api/generationJobs'

const STORAGE_KEY = 'localminidrama_dismissed_generation_jobs'
const DISMISSED_KINDS_KEY = 'localminidrama_dismissed_job_kinds'

function loadDismissedIds() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return new Set(raw ? JSON.parse(raw) : [])
  } catch (_) {
    return new Set()
  }
}
function persistDismiss(id) {
  try {
    const set = loadDismissedIds()
    set.add(id)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(set).slice(-500)))
  } catch (_) {}
}

function loadDismissedKinds() {
  try {
    const raw = localStorage.getItem(DISMISSED_KINDS_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch (_) {
    return {}
  }
}
function persistDismissKind(kind, episodeId) {
  try {
    const map = loadDismissedKinds()
    map[`${kind}_${episodeId || 'all'}`] = Date.now()
    localStorage.setItem(DISMISSED_KINDS_KEY, JSON.stringify(map))
  } catch (_) {}
}

const props = defineProps({ dramaId: [Number, String], episodeId: [Number, String], kinds: [Array, String] })
const emit = defineEmits(['jobs-change', 'updated'])
const jobs = ref([]), error = ref(''), controlling = ref(false)
const dismissedIds = ref(loadDismissedIds())
const dismissedKindsMap = ref(loadDismissedKinds())
const labels = {storyboard_images:'分镜图片 / 首尾帧',reference_images:'参考图',pipeline:'一键成片',repair:'补全并生成',text_framework:'文本框架',omni_polish:'全能片段润色',storyboards:'分镜脚本与润色',canvas_workflow:'画布工作流',canvas_videos:'画布批量视频',extraction:'角色、场景和道具提取'}
const statuses = {queued:'排队中',running:'后台执行中',paused:'已暂停后续步骤',stopping:'正在停止',stopped:'已停止',completed:'已完成',completed_with_errors:'部分失败',failed:'失败，后续步骤已停止'}

function canDismiss(job) {
  if (!job) return false
  if (!activeGenerationJob(job)) return true
  // 若任务已处于停止阶段或进度已达 100%，允许用户手动点击关闭
  if (['stopped', 'completed', 'failed', 'completed_with_errors'].includes(job.status)) return true
  if (job.status === 'stopping' && job.total > 0 && job.current >= job.total) return true
  return false
}

const targetKinds = computed(() => {
  if (!props.kinds) return null
  return (Array.isArray(props.kinds) ? props.kinds : String(props.kinds).split(',')).map(s => s.trim()).filter(Boolean)
})
const visibleJobs = computed(() => {
  const dismissedKinds = dismissedKindsMap.value
  return jobs.value
    .filter(j => !dismissedIds.value.has(j.id))
    .filter(j => !props.episodeId || !j.episode_id || Number(j.episode_id) === Number(props.episodeId))
    .filter(j => !targetKinds.value || targetKinds.value.includes(j.kind))
    .filter(j => {
      if (activeGenerationJob(j)) return true
      const key = `${j.kind}_${j.episode_id || 'all'}`
      const dismissedAt = dismissedKinds[key]
      if (dismissedAt && j.created_at && new Date(j.created_at).getTime() <= dismissedAt) return false
      return true
    })
    .filter((j, i, list) => activeGenerationJob(j) || !list.slice(0, i).some(x => x.kind === j.kind))
    .slice(0, 8)
})
let epoch = 0, timer, signature = ''
async function refresh() {
  if (!props.dramaId) return
  const did = props.dramaId, version = epoch
  try {
    const list = await generationJobsAPI.list(did)
    if (version !== epoch || did !== props.dramaId) return
    jobs.value = list || []; error.value = ''
    emit('jobs-change', jobs.value)
    const next = JSON.stringify(jobs.value.map(j => [j.id,j.status,j.items.map(i=>[i.id,i.status])]))
    if (next !== signature) { signature = next; emit('updated') }
  } catch (e) { if (version === epoch) error.value = e.message }
}
async function control(job, command) {
  controlling.value = true
  try { await generationJobsAPI.control(job.drama_id || props.dramaId, job.id, command); await refresh() }
  catch(e){ ElMessage.error(e.message) }
  finally {controlling.value=false}
}
async function dismiss(job) {
  persistDismiss(job.id)
  persistDismissKind(job.kind, job.episode_id)
  dismissedKindsMap.value = { ...dismissedKindsMap.value, [`${job.kind}_${job.episode_id || 'all'}`]: Date.now() }
  dismissedIds.value = new Set([...dismissedIds.value, job.id])
  jobs.value = jobs.value.filter(j => j.id !== job.id && !(j.kind === job.kind && Number(j.episode_id) === Number(job.episode_id) && !activeGenerationJob(j)))
  try { await generationJobsAPI.control(job.drama_id || props.dramaId, job.id, 'dismiss') }
  catch (_) {}
  emit('jobs-change', jobs.value)
}
watch(() => props.dramaId, () => {
  const version = ++epoch
  clearTimeout(timer); jobs.value=[]; signature=''; error.value=''
  const tick = async () => { await refresh(); if(version===epoch) timer=setTimeout(tick,4000) }
  tick()
}, {immediate:true})
watch(() => props.episodeId, () => emit('jobs-change',jobs.value))
onBeforeUnmount(() => {epoch++;clearTimeout(timer)})
defineExpose({ refresh })
</script>
<style scoped>
.generation-jobs { margin: 12px 0; padding: 12px; background: var(--el-fill-color-light); border-radius: 8px; }
.generation-job + .generation-job { margin-top: 14px; }
.generation-job-header { display: flex; justify-content: space-between; align-items: center; }
.dismiss-btn { font-size: 12px; cursor: pointer; color: var(--el-text-color-secondary); }
.dismiss-btn:hover { color: var(--el-color-danger); }
.generation-error { color: var(--el-color-danger); font-size: 13px; white-space: pre-wrap; margin-top: 4px; }
</style>
