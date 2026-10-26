<template>
  <div class="reference-batch">
    <div class="reference-batch-actions">
      <el-button type="primary" :loading="running" :disabled="disabled || !episodeId || running || missingCount === 0" @click="start('all')">
        一键生成参考图<span v-if="missingCount">（缺 {{ missingCount }} 张）</span>
      </el-button>
      <el-button v-if="running" :disabled="stopRequested" @click="stop">
        {{ stopRequested ? '当前任务完成后停止' : '停止后续生成' }}
      </el-button>
      <span class="reference-batch-hint">仅补齐当前集角色、道具和场景的缺失图片，已有图片自动跳过。任务在后台执行，刷新或关闭页面不影响生成。</span>
    </div>
    <div v-if="progress.total" class="reference-batch-progress" aria-live="polite">
      <el-progress :percentage="Math.round(progress.current / progress.total * 100)" :status="running ? undefined : progress.failed || progress.pending ? 'warning' : progress.stopped ? undefined : 'success'" />
      <span>{{ running ? `正在生成：${progress.label || '准备中'}` : progress.stopped ? '已停止后续生成' : '批量完成' }} · {{ progress.current }}/{{ progress.total }} · 成功 {{ progress.success }} · 失败 {{ progress.failed }} · 跳过 {{ progress.skipped }}<span v-if="progress.pending"> · 待确认 {{ progress.pending }}</span></span>
      <div v-if="progress.errors.length" class="reference-batch-errors">
        <div v-for="error in progress.errors" :key="`${error.type}:${error.id}`">{{ labels[error.type] }}「{{ error.label }}」：{{ error.error }}</div>
        <span>处理失败原因后，再次点击可补齐缺失图片。</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { referenceImageJobs } from '@/utils/referenceImageBatch'
import { generationJobsAPI, activeGenerationJob } from '@/api/generationJobs'
const props = defineProps({
  dramaId: [Number, String], episodeId: [Number, String], episodeNumber: [Number, String], dramaTitle: String,
  characters: { type: Array, default: () => [] }, props: { type: Array, default: () => [] }, scenes: { type: Array, default: () => [] },
  stylePrompt: String, disabled: Boolean, refresh: Function, jobs: { type: Array, default: () => [] },
})
const emit = defineEmits(['running-change', 'submitted'])
const submitting = ref(false)
const job = computed(() => props.jobs.find(j => j.kind === 'reference_images' && Number(j.episode_id) === Number(props.episodeId)))
const running = computed(() => submitting.value || activeGenerationJob(job.value))
const stopRequested = computed(() => job.value?.status === 'stopping')
const labels = { character: '角色', prop: '道具', scene: '场景' }
const missingCount = computed(() => referenceImageJobs({character:props.characters,prop:props.props,scene:props.scenes}).length)
const progress = computed(() => ({total:job.value?.total || 0,current:job.value?.current || 0,
  success:job.value?.items.filter(i=>i.status==='completed').length || 0,failed:job.value?.failed || 0,
  skipped:job.value?.items.filter(i=>i.status==='skipped').length || 0,pending:0,stopped:job.value?.status==='stopped',label:job.value?.label || '',
  errors:(job.value?.items || []).filter(i=>i.error).map(i=>({id:i.id,type:'',label:i.label,error:i.error}))}))
watch(running, value => emit('running-change',value), {immediate:true})
async function start(scope='all') {
  if(running.value || props.disabled || !props.episodeId) return
  submitting.value=true
  try {
    await generationJobsAPI.create(props.dramaId,'reference_images',props.episodeId,{scope,style:props.stylePrompt})
    emit('submitted'); ElMessage.success('参考图已加入后台队列，可刷新或关闭页面')
  } catch(e){ElMessage.error(e.message)}
  finally {submitting.value=false}
}
async function stop() {
  try {await generationJobsAPI.control(props.dramaId,job.value.id,'stop');emit('submitted')}
  catch(e){ElMessage.error(e.message)}
}
defineExpose({start})
</script>

<style scoped>
.reference-batch { margin: 0 0 16px; }
.reference-batch-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.reference-batch-hint { color: var(--el-text-color-secondary); font-size: 12px; }
.reference-batch-progress { margin-top: 10px; font-size: 13px; }
.reference-batch-errors { color: var(--el-color-danger); margin-top: 8px; }
</style>
