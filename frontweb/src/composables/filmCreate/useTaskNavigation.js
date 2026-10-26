import { computed } from 'vue'
import { ElMessage } from 'element-plus'
import { GEN_RESOURCE } from '@/stores/generationTaskStore'
import { generationJobsAPI, activeGenerationJob } from '@/api/generationJobs'

export function useTaskNavigation({
  dramaId,
  currentEpisodeId,
  genStore,
  scriptContent,
  isStoryGenRunning,
  characters,
  props,
  scenes,
  storyboards,
  hasAssetImage,
  hasSbImage,
  getSbAllVideos,
  assetWorkbenchRef,
  directorGenerating,
  storyboardGenerating,
  universalOmniPolishRunning,
  universalOmniPolishProgress,
  serverGenerationJobs,
  activeImageJobs,
  generatingSbImageIds,
  generatingSbVideoIds,
  generatingSbFirstImageIds,
  generatingSbLastImageIds,
  batchImageRunning,
  batchVideoRunning,
  serverVideoBatch,
  batchVideoProgress,
  storyboardUseFirstLastFrame,
  pipelineRunning,
  pipelineCurrentStep,
  pipelineCountdown,
  controlServerPipeline,
  storyGenerating,
  scriptGenerating,
  stopBatchImageGeneration,
  stopBatchVideoGeneration,
  syncGeneratingSetsFromStore,
  getGeneratingSetsBag,
  loadSingleStoryboardMedia,
  generationJobsPanel,
  scrollToAnchor,
}) {
  /** 左侧导航各步骤状态 */
  const navSteps = computed(() => {
    const epRunning = genStore.getRunningForEpisode(dramaId.value, currentEpisodeId.value)
    // 剧本
    const hasScript = !!(scriptContent?.value?.trim())
    const scriptStatus = isStoryGenRunning.value
      ? 'generating'
      : hasScript ? 'done' : 'pending'

    // 角色
    const charList = characters.value || []
    const charDone = charList.length > 0 && charList.every(c => hasAssetImage(c))
    const charGen = assetWorkbenchRef.value?.charactersGenerating || assetWorkbenchRef.value?.generatingCharIds?.size > 0
      || epRunning.some((t) => t.resourceType === GEN_RESOURCE.CHAR_IMAGE || t.resourceType === GEN_RESOURCE.EXTRACT_CHARACTERS)
    const charStatus = charGen ? 'generating' : charDone ? 'done' : charList.length > 0 ? 'partial' : 'pending'

    // 道具
    const propList = props.value || []
    const propDone = propList.length > 0 && propList.every(p => hasAssetImage(p))
    const propGen = assetWorkbenchRef.value?.propsExtracting || assetWorkbenchRef.value?.generatingPropIds?.size > 0
      || epRunning.some((t) => t.resourceType === GEN_RESOURCE.PROP_IMAGE || t.resourceType === GEN_RESOURCE.EXTRACT_PROPS)
    const propStatus = propGen ? 'generating' : propDone ? 'done' : propList.length > 0 ? 'partial' : 'pending'

    // 场景
    const sceneList = scenes.value || []
    const sceneDone = sceneList.length > 0 && sceneList.every(s => hasAssetImage(s))
    const sceneGen = assetWorkbenchRef.value?.scenesExtracting || assetWorkbenchRef.value?.generatingSceneIds?.size > 0
      || epRunning.some((t) => t.resourceType === GEN_RESOURCE.SCENE_IMAGE || t.resourceType === GEN_RESOURCE.EXTRACT_SCENES)
    const sceneStatus = sceneGen ? 'generating' : sceneDone ? 'done' : sceneList.length > 0 ? 'partial' : 'pending'

    // 分镜脚本
    const sbList = storyboards.value || []
    const sbScriptDone = sbList.length > 0
    const sbScriptGen = (directorGenerating && directorGenerating.value) || storyboardGenerating.value || universalOmniPolishRunning.value || serverGenerationJobs.value.some(j=>Number(j.episode_id)===Number(currentEpisodeId.value) && j.kind==='storyboards' && activeGenerationJob(j))
      || epRunning.some((t) => t.resourceType === GEN_RESOURCE.GENERATE_STORYBOARD)
    const sbScriptStatus = sbScriptGen ? 'generating' : sbScriptDone ? 'done' : 'pending'

    // 分镜图
    const sbImgDone = sbList.length > 0 && sbList.every(sb => hasSbImage(sb))
    const sbImgGen = generatingSbImageIds.size > 0 || batchImageRunning.value || epRunning.some((t) =>
      t.resourceType === GEN_RESOURCE.SB_IMAGE
      || t.resourceType === GEN_RESOURCE.SB_FIRST_IMAGE
      || t.resourceType === GEN_RESOURCE.SB_LAST_IMAGE
    )
    const sbImgStatus = sbImgGen ? 'generating' : sbImgDone ? 'done' : sbList.length > 0 ? 'partial' : 'pending'

    // 视频
    const sbVideoAllDone = sbList.length > 0 && sbList.every(sb => getSbAllVideos(sb.id).length > 0)
    const sbVideoSome = sbList.some(sb => getSbAllVideos(sb.id).length > 0)
    const sbVideoGen = batchVideoRunning.value || generatingSbVideoIds.size > 0
      || epRunning.some((t) => t.resourceType === GEN_RESOURCE.SB_VIDEO)
    const videoStatus = sbVideoGen ? 'generating' : sbVideoAllDone ? 'done' : sbVideoSome ? 'partial' : 'pending'

    return [
      { key: 'script',   label: '故事剧本',   anchor: 'anchor-script',     status: scriptStatus,    count: hasScript ? 1 : 0 },
      { key: 'chars',    label: '角色',        anchor: 'anchor-characters', status: charStatus,      count: charList.length },
      { key: 'props',    label: '道具',        anchor: 'anchor-props',      status: propStatus,      count: propList.length },
      { key: 'scenes',   label: '场景',        anchor: 'anchor-scenes',     status: sceneStatus,     count: sceneList.length },
      { key: 'sb',       label: '分镜脚本',   anchor: 'anchor-storyboard', status: sbScriptStatus,  count: sbList.length },
      { key: 'sbimg',    label: '分镜图',      anchor: 'anchor-storyboard', status: sbImgStatus,     count: sbList.length },
      { key: 'video',    label: '分镜视频',   anchor: 'anchor-video',      status: videoStatus,     count: 0 },
    ]
  })

  /** 聚合所有当前正在运行的任务，用于悬浮任务面板（含跨剧跨集） */
  const allActiveTaskItems = computed(() => {
    const items = []
    const seen = new Set()
    function addItem(item) {
      const id = item.id || item.label
      if (!id || seen.has(id)) return
      seen.add(id)
      items.push({
        ...item,
        isWaiting: Boolean(item.isWaiting),
        createdAt: item.createdAt || (item.task?.startedAt ? Number(item.task.startedAt) : Date.now()),
      })
    }
    for (const t of genStore.getAllRunningTasks()) {
      const isWaiting = t.serverStatus === 'pending'
      const sbId = t.resourceId ? Number(t.resourceId) : null
      const sb = sbId ? (storyboards.value || []).find((s) => Number(s.id) === sbId) : null
      const sbNum = sb ? (sb.storyboard_number || sb.shot_number || '') : ''
      addItem({
        id: `gen:${t.key || t.taskId || t.label}`,
        label: t.label || '任务进行中...',
        kind: 'genStore',
        task: t,
        storyboardId: sbId,
        order: Number(sbNum) || null,
        isWaiting,
        createdAt: t.startedAt || 0,
      })
    }
    if (pipelineRunning.value) {
      const step = pipelineCurrentStep.value
      const isWaiting = (pipelineCountdown.value || 0) > 0
      addItem({
        id: 'pipeline',
        label: step ? step.replace(/^\[步骤 \d+\/\d+\] /, '') : '一键全流程运行中...',
        kind: 'pipeline',
        isWaiting,
      })
    }
    if (isStoryGenRunning.value && !genStore.getAllRunningTasks().some((t) => t.resourceType === GEN_RESOURCE.GENERATE_STORY)) {
      addItem({ id: 'story-gen-local', label: '生成剧本...', kind: 'storyGenLocal', isWaiting: false })
    }
    if (universalOmniPolishRunning.value) {
      const p = universalOmniPolishProgress.value
      addItem({
        id: 'universal-omni-polish',
        label: `润色全能分镜 ${p.current}/${p.total}${p.label ? ' ' + p.label : ''}`,
        kind: 'universalOmniPolish',
        isWaiting: false,
      })
    }
    if (batchImageRunning.value) {
      if (activeImageJobs.value.length > 0) {
        for (const imgJob of activeImageJobs.value) {
          let opt = imgJob.options
          if (typeof opt === 'string') { try { opt = JSON.parse(opt) } catch (_) {} }
          const isSingleShot = Array.isArray(opt?.storyboard_ids) && opt.storyboard_ids.length === 1
          const isJobQueued = imgJob.status === 'queued'
          const imgJobTime = imgJob.created_at ? new Date(imgJob.created_at).getTime() : 0

          if (isSingleShot) {
            const sbId = opt.storyboard_ids[0]
            const sb = (storyboards.value || []).find((s) => Number(s.id) === Number(sbId))
            const sbNum = sb ? (sb.storyboard_number || sb.shot_number || '') : ''
            const numStr = sbNum ? ('#' + sbNum + ' ') : ''
            const slots = opt.slots || []
            let slotText = '分镜图'
            if (slots.includes('first') && slots.includes('last')) slotText = '首尾帧'
            else if (slots.includes('first')) slotText = '首帧'
            else if (slots.includes('last')) slotText = '尾帧'
            addItem({
              id: `job:${imgJob.id}`,
              label: `分镜 ${numStr}${slotText}${isJobQueued ? ' 等待中' : ' 生成中...'}`,
              kind: 'serverImageJob',
              job: imgJob,
              storyboardId: sbId,
              order: Number(sbNum) || 0,
              isWaiting: isJobQueued,
              createdAt: imgJobTime,
            })
          } else {
            // 批量分镜图/首尾帧生成：逐镜展开到任务列表
            const items = imgJob.items || []
            const concreteImageItems = items.filter((i) => i.action === 'image')
            if (concreteImageItems.length > 0) {
              for (const it of concreteImageItems) {
                if (it.status === 'completed' || it.status === 'failed') continue
                const sbId = it.payload?.storyboard_id
                const sb = (storyboards.value || []).find((s) => Number(s.id) === Number(sbId))
                const sbNum = sb ? (sb.storyboard_number || sb.shot_number || '') : (it.label?.match(/#(\d+)/)?.[1] || '')
                const numStr = sbNum ? ('#' + sbNum + ' ') : ''
                const slot = it.payload?.slot || (it.label?.includes('首帧') ? 'first' : it.label?.includes('尾帧') ? 'last' : 'image')
                const slotText = slot === 'first' ? '首帧' : slot === 'last' ? '尾帧' : '分镜图'

                const promptItem = items.find((p) => p.action === 'frame_prompt' && Number(p.payload?.storyboard_id) === Number(sbId) && p.payload?.slot === slot)
                const isPromptRunning = promptItem?.status === 'running'
                const isRunning = it.status === 'running' || isPromptRunning
                const isWaiting = !isRunning && (it.status === 'pending' || isJobQueued)
                const suffix = isPromptRunning ? '优化提示词中...' : isRunning ? '生成中...' : '等待中'

                addItem({
                  id: `img-job-item-${it.id || (imgJob.id + '-' + sbId + '-' + slot)}`,
                  label: `分镜 ${numStr}${slotText} ${suffix}`,
                  kind: 'serverImageJob',
                  job: imgJob,
                  storyboardId: sbId,
                  order: (Number(sbNum) || 0) + (slot === 'last' ? 0.5 : 0),
                  isWaiting,
                  createdAt: imgJobTime,
                })
              }
            } else {
              // 任务展开前/排队中：先依序预挂载待处理的分镜步骤
              const sbs = (storyboards.value || []).slice().sort((a, b) => (Number(a.storyboard_number || a.shot_number || 0) - Number(b.storyboard_number || b.shot_number || 0)))
              const two = storyboardUseFirstLastFrame.value
              for (const sb of sbs) {
                const sbNum = sb.storyboard_number || sb.shot_number || ''
                const numStr = sbNum ? ('#' + sbNum + ' ') : ''
                if (two && sb.creation_mode !== 'universal') {
                  addItem({
                    id: `img-job-pending-${sb.id}-first`,
                    label: `分镜 ${numStr}首帧 等待中`,
                    kind: 'serverImageJob',
                    job: imgJob,
                    storyboardId: sb.id,
                    order: Number(sbNum) || 0,
                    isWaiting: true,
                    createdAt: imgJobTime,
                  })
                  addItem({
                    id: `img-job-pending-${sb.id}-last`,
                    label: `分镜 ${numStr}尾帧 等待中`,
                    kind: 'serverImageJob',
                    job: imgJob,
                    storyboardId: sb.id,
                    order: (Number(sbNum) || 0) + 0.5,
                    isWaiting: true,
                    createdAt: imgJobTime,
                  })
                } else {
                  addItem({
                    id: `img-job-pending-${sb.id}-image`,
                    label: `分镜 ${numStr}分镜图 等待中`,
                    kind: 'serverImageJob',
                    job: imgJob,
                    storyboardId: sb.id,
                    order: Number(sbNum) || 0,
                    isWaiting: true,
                    createdAt: imgJobTime,
                  })
                }
              }
            }
          }
        }
      } else {
        const sbs = (storyboards.value || []).slice().sort((a, b) => (Number(a.storyboard_number || a.shot_number || 0) - Number(b.storyboard_number || b.shot_number || 0)))
        const two = storyboardUseFirstLastFrame.value
        for (const sb of sbs) {
          const sbNum = sb.storyboard_number || sb.shot_number || ''
          const numStr = sbNum ? ('#' + sbNum + ' ') : ''
          if (two && sb.creation_mode !== 'universal') {
            addItem({
              id: `batch-img-fb-${sb.id}-first`,
              label: `分镜 ${numStr}首帧 等待中`,
              kind: 'batchImage',
              storyboardId: sb.id,
              order: Number(sbNum) || 0,
              isWaiting: true,
            })
            addItem({
              id: `batch-img-fb-${sb.id}-last`,
              label: `分镜 ${numStr}尾帧 等待中`,
              kind: 'batchImage',
              storyboardId: sb.id,
              order: (Number(sbNum) || 0) + 0.5,
              isWaiting: true,
            })
          } else {
            addItem({
              id: `batch-img-fb-${sb.id}-image`,
              label: `分镜 ${numStr}分镜图 等待中`,
              kind: 'batchImage',
              storyboardId: sb.id,
              order: Number(sbNum) || 0,
              isWaiting: true,
            })
          }
        }
      }
    }
    if (batchVideoRunning.value) {
      const batchItems = serverVideoBatch.value?.items
      if (Array.isArray(batchItems) && batchItems.length > 0) {
        const activeShots = batchItems.filter((i) => i.status === 'running' || i.status === 'pending')
        if (activeShots.length > 0) {
          for (const shot of activeShots) {
            const isWaiting = shot.status === 'pending'
            const numStr = shot.storyboard_number != null ? `#${shot.storyboard_number} ` : (shot.storyboard_id ? `#${shot.storyboard_id} ` : '')
            const shotTime = shot.created_at ? new Date(shot.created_at).getTime() : 0
            addItem({
              id: `batch-video-shot-${shot.id || shot.storyboard_id}`,
              label: `分镜 ${numStr}视频 ${isWaiting ? '等待中' : '生成中...'}`,
              kind: 'batchVideo',
              shot,
              storyboardId: shot.storyboard_id,
              storyboardNumber: shot.storyboard_number,
              order: Number(shot.storyboard_number) || Number(shot.storyboard_id) || 0,
              isWaiting,
              createdAt: shotTime,
            })
          }
        } else {
          const p = batchVideoProgress.value
          const suffix = p?.total ? ` ${p.current}/${p.total}` : ''
          addItem({ id: 'batch-video', label: `批量生成分镜视频${suffix}...`, kind: 'batchVideo', isWaiting: false })
        }
      } else {
        const sbs = (storyboards.value || []).slice().sort((a, b) => Number(a.storyboard_number || 0) - Number(b.storyboard_number || 0))
        if (sbs.length > 0) {
          for (const sb of sbs) {
            const sbNum = sb.storyboard_number || sb.shot_number || ''
            const numStr = sbNum ? (`#${sbNum} `) : ''
            addItem({
              id: `batch-video-pending-${sb.id}`,
              label: `分镜 ${numStr}视频 等待中`,
              kind: 'batchVideo',
              storyboardId: sb.id,
              order: Number(sbNum) || 0,
              isWaiting: true,
            })
          }
        } else {
          const p = batchVideoProgress.value
          const suffix = p?.total ? ` ${p.current}/${p.total}` : ''
          addItem({ id: 'batch-video', label: `批量生成分镜视频${suffix}...`, kind: 'batchVideo', isWaiting: false })
        }
      }
    }
    return items.sort((a, b) => {
      // 1. 运行中排在前面，等待中排在后面
      if (a.isWaiting !== b.isWaiting) {
        return a.isWaiting ? 1 : -1
      }
      // 2. 如果都有分镜顺序号，按分镜序号升序
      const orderA = a.order != null ? Number(a.order) : null
      const orderB = b.order != null ? Number(b.order) : null
      if (orderA != null && orderB != null && orderA !== orderB) {
        return orderA - orderB
      }
      // 3. 否则按创建时间排序
      const timeA = Number(a.createdAt) || 0
      const timeB = Number(b.createdAt) || 0
      if (timeA && timeB && timeA !== timeB) {
        return timeA - timeB
      }
      return 0
    })
  })

  const runningTasksCount = computed(() => allActiveTaskItems.value.filter((t) => !t.isWaiting).length)
  const waitingTasksCount = computed(() => allActiveTaskItems.value.filter((t) => t.isWaiting).length)
  const allActiveTaskLabels = computed(() => allActiveTaskItems.value.map((t) => t.label))

  async function cancelActiveTask(item) {
    if (!item) return
    try {
      if (item.kind === 'genStore' && item.task) {
        const task = item.task
        await genStore.cancelTask(task)
        if (dramaId.value && currentEpisodeId.value) {
          syncGeneratingSetsFromStore(genStore, dramaId.value, currentEpisodeId.value, getGeneratingSetsBag())
        }
        if (task.resourceType === GEN_RESOURCE.SB_VIDEO && task.resourceId) {
          generatingSbVideoIds.delete(task.resourceId)
          await loadSingleStoryboardMedia(task.resourceId)
        } else if (task.resourceType === GEN_RESOURCE.SB_FIRST_IMAGE && task.resourceId) {
          generatingSbFirstImageIds.delete(task.resourceId)
          await loadSingleStoryboardMedia(task.resourceId)
        } else if (task.resourceType === GEN_RESOURCE.SB_LAST_IMAGE && task.resourceId) {
          generatingSbLastImageIds.delete(task.resourceId)
          await loadSingleStoryboardMedia(task.resourceId)
        } else if (task.resourceId) {
          await loadSingleStoryboardMedia(task.resourceId)
        }
        ElMessage.success('任务已取消')
        return
      }
      if (item.kind === 'serverImageJob' && item.job) {
        await generationJobsAPI.control(dramaId.value, item.job.id, 'stop')
        await generationJobsPanel.value?.refresh()
        ElMessage.success('任务已取消')
        return
      }
      if (item.kind === 'pipeline') { await controlServerPipeline('stop'); return }
      if (item.kind === 'storyGenLocal') {
        storyGenerating.value = false
        scriptGenerating.value = false
        const storyTask = genStore.getAllRunningTasks().find((t) => t.resourceType === GEN_RESOURCE.GENERATE_STORY)
        if (storyTask) await genStore.cancelTask(storyTask)
        ElMessage.success('已取消剧本生成')
        return
      }
      if (item.kind === 'universalOmniPolish') {
        const job = serverGenerationJobs.value.find(j => j.kind === 'omni_polish' && Number(j.episode_id) === Number(currentEpisodeId.value) && activeGenerationJob(j))
        if (job) await generationJobsAPI.control(dramaId.value, job.id, 'stop')
        await generationJobsPanel.value?.refresh()
        return
      }
      if (item.kind === 'batchImage') { await stopBatchImageGeneration(); return }
      if (item.kind === 'batchVideo') {
        await stopBatchVideoGeneration()
        return
      }
    } catch (e) {
      ElMessage.error(e?.message || '取消失败')
    }
  }

  /** 解析任务目标锚点（支持分镜、角色、道具、场景） */
  function getTaskTargetAnchor(item) {
    if (!item) return null
    if (item.storyboardId) {
      const sb = (storyboards.value || []).find((s) => Number(s.id) === Number(item.storyboardId))
      if (sb) return 'sb-' + sb.id
    }
    const t = item.task
    if (t && (t.resourceType === GEN_RESOURCE.STORYBOARD_IMAGE || t.resourceType === GEN_RESOURCE.STORYBOARD_VIDEO || t.resourceType === GEN_RESOURCE.SB_VIDEO || t.resourceType === GEN_RESOURCE.SB_FIRST_IMAGE || t.resourceType === GEN_RESOURCE.SB_LAST_IMAGE)) {
      const sbId = Number(t.resourceId)
      if (sbId) return 'sb-' + sbId
    }
    if (item.job) {
      let opt = item.job.options
      if (typeof opt === 'string') { try { opt = JSON.parse(opt) } catch (_) {} }
      if (Array.isArray(opt?.storyboard_ids) && opt.storyboard_ids.length > 0) {
        return 'sb-' + opt.storyboard_ids[0]
      }
    }
    if (item.shot?.storyboard_id) {
      return 'sb-' + item.shot.storyboard_id
    }
    const m = String(item.label || '').match(/分镜\s*#?(\d+)/)
    if (m) {
      const num = Number(m[1])
      const sb = (storyboards.value || []).find((s) => Number(s.storyboard_number || s.shot_number) === num || Number(s.id) === num)
      if (sb) return 'sb-' + sb.id
    }
    return null
  }

  /** 点击任务项平滑滚动跳转至对应分镜并触发高亮脉冲动画 */
  function handleTaskItemClick(item) {
    const anchorId = getTaskTargetAnchor(item)
    if (!anchorId) return
    scrollToAnchor?.(anchorId)
    const el = document.getElementById(anchorId)
    if (el) {
      el.classList.add('sb-highlight-pulse')
      setTimeout(() => {
        el.classList.remove('sb-highlight-pulse')
      }, 2500)
    }
  }

  return {
    navSteps,
    allActiveTaskItems,
    runningTasksCount,
    waitingTasksCount,
    allActiveTaskLabels,
    cancelActiveTask,
    getTaskTargetAnchor,
    handleTaskItemClick,
  }
}
