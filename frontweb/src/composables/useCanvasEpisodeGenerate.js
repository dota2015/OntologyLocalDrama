import { ref } from 'vue'
import { generationJobsAPI } from '@/api/generationJobs'
import { dramaUsesFirstLastFrame } from '@/utils/storyboardMedia'
import { ElMessage, ElMessageBox } from 'element-plus'
import { parseDramaMetadata } from '@/utils/canvasLayout'
import { getDramaGenerationOptions } from '@/utils/canvasWorkflow'

/** 画布模式：当前集 AI 生成分镜 + 批量生图/生视频 */
export function useCanvasEpisodeGenerate(deps) {
  const {
    drama,
    filterEpisodeId,
    imagesBySbId,
    videosBySbId,
    refreshCanvas,
    nodeStatus,
  } = deps

  const episodeGenerating = ref(false)
  const episodeGenProgress = ref('')

  function getEpisode() {
    const epId = filterEpisodeId.value
    if (!epId) return null
    return (drama.value?.episodes || []).find((ep) => ep.id === epId) || null
  }

  function getStoryboardsForEpisode() {
    return getEpisode()?.storyboards || []
  }

  function buildStoryboardApiOptions() {
    const meta = parseDramaMetadata(drama.value?.metadata)
    const gen = getDramaGenerationOptions(drama.value)
    const ep = getEpisode()
    const scriptLen = (ep?.script_content || '').trim().length
    let videoDuration
    if (meta.video_clip_duration) {
      videoDuration = Number(meta.video_clip_duration)
    } else if (scriptLen > 0) {
      videoDuration = Math.max(10, Math.round(10 + (scriptLen / 600) * 60))
    }
    return {
      style: gen.style || undefined,
      aspect_ratio: gen.aspectRatio,
      video_duration: videoDuration,
      include_narration: !!meta.storyboard_include_narration,
      universal_omni_storyboard: !!meta.storyboard_universal_omni,
    }
  }

  function getGenOpts() {
    return {
      ...getDramaGenerationOptions(drama.value),
      imagesBySbId: imagesBySbId.value,
    }
  }

  async function aiGenerateStoryboards() {
    const ep=getEpisode()
    if(!ep) {ElMessage.warning('请先选择集数');return}
    if(!(ep.script_content || '').trim()){ElMessage.warning('该集暂无剧本');return}
    if(getStoryboardsForEpisode().length) {
      try {await ElMessageBox.confirm('当前集已有分镜，确认重新生成？','AI生成分镜',{type:'warning',confirmButtonText:'继续生成'})}
      catch(_){return}
    }
    episodeGenerating.value=true
    try {
      await generationJobsAPI.create(drama.value.id,'storyboards',ep.id,{storyboard:buildStoryboardApiOptions()})
      ElMessage.success('分镜生成与后续处理已加入后台队列，可关闭页面')
    }catch(e){ElMessage.error(e.message)}finally{episodeGenerating.value=false}
  }

  async function submitBatch(kind) {
    const ep=getEpisode()
    if(!ep) {ElMessage.warning('请先选择集数');return}
    episodeGenerating.value=true
    try {
      const opts=getGenOpts()
      await generationJobsAPI.create(drama.value.id,kind,ep.id,{
        style:opts.style,aspect_ratio:opts.aspectRatio,resolution:opts.videoResolution,
        use_first_last:dramaUsesFirstLastFrame(drama.value),
      })
      ElMessage.success('已加入后台队列，刷新或关闭页面不影响生成')
      await refreshCanvas(true)
    } catch(e){ElMessage.error(e.message || '后台任务提交失败')}
    finally {episodeGenerating.value=false;episodeGenProgress.value=''}
  }
  async function batchGenerateImages() {return submitBatch('storyboard_images')}
  async function batchGenerateVideos() {return submitBatch('canvas_videos')}

  return {
    episodeGenerating,
    episodeGenProgress,
    aiGenerateStoryboards,
    batchGenerateImages,
    batchGenerateVideos,
  }
}
