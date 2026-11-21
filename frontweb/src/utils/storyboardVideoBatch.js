import { orderedVideoShots } from './h3VideoBatch.js'

export function buildBatchVideoShot(sb, {
  isSbUniversalMode, collectSbOmniReferenceAbsoluteUrls, sbVideoFirstLastUrls, selectedShotModel,
  getSelectedStyle, projectAspectRatio, videoResolution, getSbVideoDurationForApi,
}) {
  const universal = isSbUniversalMode(sb.id)
  const refs = universal ? collectSbOmniReferenceAbsoluteUrls(sb) : []
  const { first, last } = sbVideoFirstLastUrls(sb, universal, null)
  let referenceUrls = universal ? refs : [first].filter(Boolean)
  if (!universal && last && !referenceUrls.includes(last)) referenceUrls.push(last)
  return {
    storyboard_id: sb.id, model: selectedShotModel(sb),
    image_url: universal ? refs[0] : first, first_frame_url: first, last_frame_url: last,
    reference_image_urls: referenceUrls, universal,
    style: getSelectedStyle(), aspect_ratio: projectAspectRatio.value || '16:9',
    resolution: videoResolution.value || undefined, duration: getSbVideoDurationForApi(sb),
  }
}

export function createStoryboardVideoBatch({
  currentEpisodeId, dramaId, batchVideoRunning, pipelineRunning, batchVideoStopping,
  batchVideoSubmitting, batchVideoErrors, batchVideoProgress, serverVideoBatch, videoFrameContiguity, loadStoryboardMedia, getStoryboards,
  buildShot, canSubmit, videosAPI, ElMessage
}) {
  async function startBatchVideoGeneration(options = {}) {
    if (!currentEpisodeId.value || batchVideoRunning.value || pipelineRunning.value) return
    const episodeId = currentEpisodeId.value
    const did = dramaId.value
    batchVideoErrors.value = []
    batchVideoStopping.value = false
    batchVideoRunning.value = true
    batchVideoSubmitting.value = true
    try {
      await loadStoryboardMedia()
      if (currentEpisodeId.value !== episodeId || dramaId.value !== did) return
      const filterIds = options.filterIds
      const todo = orderedVideoShots(getStoryboards()).filter(sb => {
        if (filterIds && !filterIds.has(Number(sb.id))) return false
        // H3 以权威槽位为输入；具体首帧与参考素材由后端门禁。
        return canSubmit(sb)
      })
      if (!todo.length) {
        ElMessage.info('没有需要生成视频的分镜（缺少导演槽位，或视频已全部生成）')
        return
      }
      // Snapshot all selected inputs once. The server submits each shot after its predecessor finishes.
      const shots = todo.map(buildShot)
      const batch = await videosAPI.createBatch(episodeId, { drama_id: did, shots, continuity: videoFrameContiguity.value })
      if (currentEpisodeId.value === episodeId && dramaId.value === did) applyVideoBatchStatus(batch)
      ElMessage.success('已加入后台队列，刷新或关闭页面不影响生成')
    } catch (e) {
      ElMessage.error(e.message || '批量任务提交失败')
    } finally {
      batchVideoSubmitting.value = false
      if (currentEpisodeId.value === episodeId && dramaId.value === did) batchVideoRunning.value = ['running', 'stopping'].includes(serverVideoBatch.value?.status)
    }
  }

  function applyVideoBatchStatus(batch) {
    serverVideoBatch.value = batch
    batchVideoRunning.value = ['running', 'stopping'].includes(batch?.status)
    batchVideoStopping.value = batch?.status === 'stopping'
    batchVideoProgress.value = { current: batch?.current || 0, total: batch?.total || 0, failed: batch?.failed || 0 }
    if (batch?.status === 'cleared' || !batch) {
      batchVideoErrors.value = []
    } else {
      batchVideoErrors.value = (batch?.items || []).filter(i => i.status === 'failed').map(i => `#${i.storyboard_number ?? i.storyboard_id}: ${i.error || '生成失败'}`)
    }
  }

  async function stopBatchVideoGeneration() {
    const batch = serverVideoBatch.value
    if (!batch || !['running', 'stopping'].includes(batch.status)) return
    try {
      const result = await videosAPI.stopBatch(batch.episode_id, batch.id)
      if (currentEpisodeId.value === batch.episode_id) applyVideoBatchStatus(result)
      if (result?.status === 'stopped') {
        ElMessage.success('批量生成已停止')
      } else {
        ElMessage.info('已停止后续提交，正在生成的分镜会正常完成（再次点击可强制停止）')
      }
    } catch (e) { ElMessage.error(e.message || '停止失败') }
  }
  return { startBatchVideoGeneration, applyVideoBatchStatus, stopBatchVideoGeneration }
}
