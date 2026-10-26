import { ref, reactive, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { generationJobsAPI, activeGenerationJob } from '@/api/generationJobs'
import { generationSettingsAPI } from '@/api/prompts'
import { runGenerateStoryFromPremise } from '@/composables/useStoryGeneration'

/**
 * 端到端全自动流水线 Composable
 * @param {object} deps - 外部依赖
 */
export function useFullPipeline(deps) {
  const {
    dramaId,
    currentEpisodeId,
    store,
    router,
    route,
    loadDrama,
    loadStoryboardMedia,
    restoreSelectionsFromBackend,
    sbSelectedImgId,
    sbSelectedLastImgId,
    serverGenerationJobs,
    storyInput,
    scriptContent,
    scriptTitle,
    storyStyle,
    storyType,
    storyEpisodeCount,
    narrativeStyle,
    generationStyle,
    customStylePrompt,
    projectAspectRatio,
    savedCurrentEpisodeNumber,
    selectedEpisodeId,
    onEpisodeSelect,
    storyGenerating,
    scriptGenerating,
    pollTask,
    getSelectedStyle,
    storyboardUseFirstLastFrame,
    gridMode,
    lastFrameUseFirstLayoutLock,
    videoResolution,
    videoFrameContiguity,
    scriptLanguage,
    getStoryboardCountForApi,
    getVideoDurationForApi,
    shotDurationMin,
    shotDurationMax,
    storyboardIncludeNarration,
    storyboardUniversalOmni,
    getFinalizeMergeOptions,
    backgroundMusicPanel,
    batchImageRunning,
    batchImageStopping,
    batchImageProgress,
    batchImageErrors,
    generatingSbFirstImageIds,
    generatingSbLastImageIds,
    generatingSbImageIds,
    universalOmniPolishRunning,
    universalOmniPolishProgress,
  } = deps

  // 一键全流程流水线状态
  const pipelineRunning = ref(false)
  const pipelinePaused = ref(false)
  const pipelineErrorLog = ref([])
  const pipelineCurrentStep = ref('')
  const pipelineStepIndex = ref(0)
  const pipelineStepTotal = ref(10)
  const pipelineCountdown = ref(0)
  const pipelineCountdownMsg = ref('')
  const pipelineConcurrency = ref(3)
  const pipelineVideoConcurrency = ref(3)
  const pipelineActiveTasks = reactive(new Set())

  const generationJobsPanel = ref(null)
  const storyboardJobsPanel = ref(null)

  const serverPipeline = computed(() =>
    (serverGenerationJobs?.value || []).find(
      (j) =>
        Number(j.episode_id) === Number(currentEpisodeId?.value) &&
        ['pipeline', 'repair', 'text_framework'].includes(j.kind) &&
        activeGenerationJob(j)
    )
  )

  async function loadPipelineConcurrency() {
    try {
      const res = await generationSettingsAPI.get()
      pipelineConcurrency.value = Math.max(1, Number(res?.concurrency) || 3)
      pipelineVideoConcurrency.value = Math.max(1, Number(res?.video_concurrency) || 3)
    } catch (_) {}
  }

  function generationJobOptions() {
    return {
      style: getSelectedStyle?.(),
      aspect_ratio: projectAspectRatio?.value || '16:9',
      use_first_last: !!storyboardUseFirstLastFrame?.value,
      grid_mode: gridMode?.value,
      layout_lock: !!lastFrameUseFirstLayoutLock?.value,
      resolution: videoResolution?.value || undefined,
      continuity: !!videoFrameContiguity?.value,
      language: scriptLanguage?.value,
      storyboard: {
        style: getSelectedStyle?.(),
        aspect_ratio: projectAspectRatio?.value || '16:9',
        storyboard_count: getStoryboardCountForApi?.(),
        video_duration: getVideoDurationForApi?.(),
        shot_duration_range: { min: shotDurationMin?.value, max: shotDurationMax?.value },
        include_narration: !!storyboardIncludeNarration?.value,
        universal_omni_storyboard: !!storyboardUniversalOmni?.value,
      },
      merge: getFinalizeMergeOptions?.(),
    }
  }

  async function submitGenerationJob(kind, extra = {}) {
    const did = dramaId?.value
    const eid = currentEpisodeId?.value
    if (!did || !eid) return
    if (['pipeline', 'repair'].includes(kind)) {
      await backgroundMusicPanel?.value?.flush?.()
    }
    const job = await generationJobsAPI.create(did, kind, eid, {
      ...generationJobOptions(),
      ...extra,
    })
    if (Number(dramaId?.value) === Number(did)) {
      applyGenerationJobs([job, ...(serverGenerationJobs?.value || []).filter((j) => j.id !== job.id)])
    }
    await Promise.all([generationJobsPanel?.value?.refresh?.(), storyboardJobsPanel?.value?.refresh?.()])
    return job
  }

  function applyGenerationJobs(jobs) {
    if (serverGenerationJobs) {
      serverGenerationJobs.value = jobs
    }
    const local = jobs.filter((j) => Number(j.episode_id) === Number(currentEpisodeId?.value))
    const pipeline = local.find(
      (j) => ['pipeline', 'repair', 'text_framework'].includes(j.kind) && activeGenerationJob(j)
    )
    pipelineRunning.value = !!pipeline
    pipelinePaused.value = pipeline?.status === 'paused'
    pipelineCurrentStep.value = pipeline?.label || ''
    pipelineStepIndex.value = pipeline?.current || 0
    pipelineStepTotal.value = pipeline?.total || 0

    const activeImageJobsList = local.filter((j) => j.kind === 'storyboard_images' && activeGenerationJob(j))
    const currentRunningImgJob = activeImageJobsList.find((j) => j.status === 'running') || activeImageJobsList[0]
    if (batchImageRunning) batchImageRunning.value = activeImageJobsList.length > 0
    if (batchImageStopping) batchImageStopping.value = currentRunningImgJob?.status === 'stopping'
    if (batchImageProgress) {
      batchImageProgress.value = {
        current: currentRunningImgJob?.current || 0,
        total: currentRunningImgJob?.total || 0,
        failed: currentRunningImgJob?.failed || 0,
      }
    }
    if (batchImageErrors) {
      batchImageErrors.value = (currentRunningImgJob?.items || []).filter((i) => i.error).map((i) => `${i.label}：${i.error}`)
    }

    generatingSbFirstImageIds?.clear()
    generatingSbLastImageIds?.clear()
    generatingSbImageIds?.clear()
    for (const imgJob of activeImageJobsList) {
      let opt = imgJob.options
      if (typeof opt === 'string') {
        try { opt = JSON.parse(opt) } catch (_) {}
      }
      const sbIds = opt?.storyboard_ids || []
      const slots = opt?.slots || (storyboardUseFirstLastFrame?.value ? ['first', 'last'] : ['image'])
      for (const sid of sbIds) {
        if (slots.includes('first')) generatingSbFirstImageIds?.add(sid)
        if (slots.includes('last')) generatingSbLastImageIds?.add(sid)
        if (slots.includes('image')) generatingSbImageIds?.add(sid)
      }
    }

    const polish = local.find((j) => j.kind === 'omni_polish' && activeGenerationJob(j))
    if (universalOmniPolishRunning) universalOmniPolishRunning.value = !!polish
    if (universalOmniPolishProgress) {
      universalOmniPolishProgress.value = {
        current: polish?.current || 0,
        total: polish?.total || 0,
        label: polish?.label || '',
      }
    }
  }

  async function controlServerPipeline(command) {
    if (!serverPipeline.value) return
    try {
      await generationJobsAPI.control(dramaId.value, serverPipeline.value.id, command)
      await generationJobsPanel.value?.refresh?.()
    } catch (e) {
      ElMessage.error(e.message)
    }
  }

  function onPipelineResume() {
    return controlServerPipeline('resume')
  }

  function skipPipelineCountdown() {
    return controlServerPipeline('skip_wait')
  }

  let generationJobsReloading = false
  async function onGenerationJobsUpdated() {
    if (generationJobsReloading || !(serverGenerationJobs?.value?.length)) return
    generationJobsReloading = true
    try {
      await loadDrama?.()
      await loadStoryboardMedia?.()
      for (const sb of store?.storyboards || []) {
        if (sbSelectedImgId?.value) delete sbSelectedImgId.value[sb.id]
        if (sbSelectedLastImgId?.value) delete sbSelectedLastImgId.value[sb.id]
      }
      restoreSelectionsFromBackend?.()
    } finally {
      generationJobsReloading = false
    }
  }

  async function launchServerPipeline(kind) {
    if (!currentEpisodeId?.value || pipelineRunning.value) return
    try {
      await submitGenerationJob(kind)
    } catch (e) {
      ElMessage.error(e.message || '流程提交失败')
    }
  }

  async function startOneClickPipeline() {
    return launchServerPipeline('pipeline')
  }

  async function startTextFrameworkPipeline() {
    return launchServerPipeline('text_framework')
  }

  async function startRepairPipeline() {
    return launchServerPipeline('repair')
  }

  async function onStartEndToEndFullPipeline() {
    if (pipelineRunning.value) return
    const hasScript = !!(scriptContent?.value?.trim())
    const hasStory = !!(storyInput?.value?.trim())
    if (!hasScript) {
      if (!hasStory) {
        ElMessage.warning('请先在上方输入故事梗概，或直接导入小说！')
        return
      }
      ElMessage.info('🚀 启动全体全流程：正在由故事梗概创编分集剧本，随后将自动继续全套视听生成...')
      try {
        await runGenerateStoryFromPremise({
          premise: storyInput.value,
          narrativeStyle: { ...narrativeStyle?.value },
          storyStyle: storyStyle?.value,
          storyType: storyType?.value,
          storyEpisodeCount: storyEpisodeCount?.value,
          scriptTitle: scriptTitle?.value,
          generationStyle: generationStyle?.value,
          customStylePrompt: customStylePrompt?.value,
          projectAspectRatio: projectAspectRatio?.value,
          store,
          router,
          route,
          loadDrama,
          savedCurrentEpisodeNumber,
          selectedEpisodeId,
          onEpisodeSelect,
          storyGenerating,
          scriptGenerating,
          pollTask,
          replaceRouteWhenNew: true,
          skipPostLoad: false,
          onComplete: async () => {
            ElMessage.success('剧本创编完成，正在继续全自动生成资产、分镜与成片...')
            await launchServerPipeline('pipeline')
          },
        })
      } catch (err) {
        ElMessage.error(err.message || '剧本生成失败，全流程已中止')
      }
      return
    }
    await launchServerPipeline('pipeline')
  }

  return {
    pipelineRunning,
    pipelinePaused,
    pipelineErrorLog,
    pipelineCurrentStep,
    pipelineStepIndex,
    pipelineStepTotal,
    pipelineCountdown,
    pipelineCountdownMsg,
    pipelineConcurrency,
    pipelineVideoConcurrency,
    pipelineActiveTasks,
    generationJobsPanel,
    storyboardJobsPanel,
    serverPipeline,
    loadPipelineConcurrency,
    generationJobOptions,
    submitGenerationJob,
    applyGenerationJobs,
    controlServerPipeline,
    onPipelineResume,
    skipPipelineCountdown,
    onGenerationJobsUpdated,
    launchServerPipeline,
    startOneClickPipeline,
    startTextFrameworkPipeline,
    startRepairPipeline,
    onStartEndToEndFullPipeline,
  }
}
