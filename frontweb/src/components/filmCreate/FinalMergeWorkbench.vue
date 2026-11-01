<template>
  <div class="final-merge-workbench">
    <!-- 6. 视频配置 -->
    <section class="section card">
      <h2 class="section-title">视频配置</h2>
      <div class="config-grid">
        <el-form-item label="分辨率">
          <el-select v-model="videoResolution" style="width: 160px">
            <el-option label="480p" value="480p" />
            <el-option label="720p" value="720p" />
            <el-option label="1080p" value="1080p" />
          </el-select>
        </el-form-item>
        <el-form-item label="字幕">
          <div class="video-option-row">
            <el-switch v-model="videoSubtitle" />
            <span v-if="videoSubtitle" class="video-option-hint">将已有对白和旁白烧录为字幕，按各分镜实际视频时长显示（非逐字语音识别对齐）。仅开启字幕会保留视频原声，无需生成 TTS。</span>
          </div>
        </el-form-item>
        <el-form-item label="替换对白配音">
          <div class="video-option-row">
            <el-switch v-model="videoBurnDialogue" />
            <span v-if="videoBurnDialogue" class="video-option-hint">使用已生成的对白 TTS 替换对应镜头原声，包括原有音乐与音效。使用 H3 原声时请关闭；不会重新生成口型。</span>
          </div>
        </el-form-item>
        <el-form-item label="替换旁白配音">
          <div class="video-option-row">
            <el-switch v-model="videoBurnNarration" />
            <span v-if="videoBurnNarration" class="video-option-hint">使用旁白 TTS 替换对应镜头原声，缺失配音时自动生成。与字幕独立；使用 H3 原声时请关闭。</span>
          </div>
        </el-form-item>
        <el-form-item label="水印">
          <div class="video-option-row">
            <el-switch v-model="videoWatermark" />
            <el-input
              v-if="videoWatermark"
              v-model="videoWatermarkText"
              placeholder="右下角水印文字"
              maxlength="200"
              show-word-limit
              clearable
              class="video-watermark-input"
            />
          </div>
        </el-form-item>
        <el-form-item label="片尾黑屏缓冲">
          <div class="video-option-row">
            <el-switch v-model="videoTailBlack" />
            <span class="video-option-hint">默认开启（末尾追加 1 秒黑屏与静音）。防止上传至抖音、视频号、快手、小红书等社交平台时因播放器提前循环或截断导致成片丢失结尾画面与对白。</span>
          </div>
        </el-form-item>
      </div>
      <p class="config-tip">文本/图片/视频使用的模型以「<el-link type="primary" underline="never" @click="emit('openAiConfig')">AI 配置</el-link>」中设为默认的为准。</p>
    </section>

    <!-- 7. 合成视频 -->
    <section id="anchor-video" class="section card">
      <h2 class="section-title">合成视频</h2>
      <BackgroundMusicSettings ref="backgroundMusicPanel" :episode-id="currentEpisodeId" :disabled="videoStatus === 'generating'" />
      <el-button
        type="primary"
        size="large"
        :loading="videoStatus === 'generating'"
        :disabled="!currentEpisodeId || storyboards.length === 0 || videoStatus === 'generating'"
        @click="onGenerateVideo"
      >
        合成视频
      </el-button>
      <div v-if="videoStatus === 'generating'" class="video-progress">
        <el-progress :percentage="videoProgress" :status="videoProgress >= 100 ? 'success' : undefined" />
        <p>视频生成中...</p>
      </div>
      <div v-if="videoStatus === 'done'" class="video-done">
        <el-alert type="success" title="视频生成完成" show-icon />
      </div>
      <div v-else-if="videoStatus === 'error'" class="video-error">
        <el-alert type="error" :title="videoErrorMsg" show-icon />
      </div>
      <div v-if="currentEpisodeVideoUrl" class="video-preview-wrap">
        <p class="video-preview-label">本集合成视频预览</p>
        <video
          :src="currentEpisodeVideoUrl"
          controls
          class="video-preview-player"
          preload="metadata"
        />
      </div>
    </section>
  </div>
</template>

<script setup>
import { ref, computed, inject } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage } from 'element-plus'
import { useFilmStore } from '@/stores/film'
import { useGenerationTaskStore, GEN_RESOURCE } from '@/stores/generationTaskStore'
import { dramaAPI } from '@/api/drama'
import { episodeVideoUrl } from '@/utils/mediaUrl'
import BackgroundMusicSettings from '@/components/BackgroundMusicSettings.vue'

const emit = defineEmits(['openAiConfig'])

const ctx = inject('filmCreateContext', {})

const store = ctx.store || useFilmStore()
const genStore = ctx.genStore || useGenerationTaskStore()
const dramaId = ctx.dramaId
const currentEpisodeId = ctx.currentEpisodeId
const storyboards = ctx.storyboards || computed(() => store?.storyboards || [])
const loadDrama = ctx.loadDrama || (() => {})
const pollTask = ctx.pollTask || (() => Promise.resolve(null))
const imageUrl = ctx.imageUrl || ((u) => u || '')

const { videoResolution: storeVideoResolution } = storeToRefs(store)
const videoResolution = storeVideoResolution

// 视频导出配置状态
const videoSubtitle = ref(false)
const videoBurnDialogue = ref(false)
const videoBurnNarration = ref(false)
const videoWatermark = ref(false)
const videoWatermarkText = ref('')
const videoTailBlack = ref(true)
const videoErrorMsg = ref('')

const backgroundMusicPanel = ref(null)

// 响应式视频合成状态
const videoProgress = computed(() => store.videoProgress)
const videoStatus = computed(() => store.videoStatus)

const currentEpisodeVideoUrl = computed(() => {
  const ep = store.currentEpisode
  if (!ep) return ''
  if (ep.video_url) return episodeVideoUrl(ep.video_url)
  const vidList = (store.drama?.episodes || []).find((e) => e.id === ep.id)?.videos
  if (Array.isArray(vidList) && vidList.length > 0) {
    const v = vidList[0]
    return episodeVideoUrl(v.video_url || v.local_path || '')
  }
  return ''
})

function setVideoErrorMsg(msg) {
  videoErrorMsg.value = msg || ''
}

function getFinalizeMergeOptions() {
  return {
    burn_subtitles: !!videoSubtitle.value,
    burn_narration_audio: !!videoBurnNarration.value,
    burn_dialogue_audio: !!videoBurnDialogue.value,
    watermark_text: videoWatermark.value ? String(videoWatermarkText.value || '').trim().slice(0, 200) : '',
    tail_black_seconds: videoTailBlack.value ? 1.0 : 0,
  }
}

async function onGenerateVideo() {
  if (!currentEpisodeId.value) return
  try {
    await backgroundMusicPanel.value?.flush()
  } catch (e) {
    ElMessage.error(e.message)
    return
  }
  const epId = currentEpisodeId.value
  const did = dramaId.value
  const dramaTitle = store.drama?.title || ''
  const epNum = store.currentEpisode?.episode_number
  const epLabel = dramaTitle ? `${dramaTitle} · 第${epNum ?? ''}集` : `第${epNum ?? ''}集`
  const mergeMeta = {
    dramaId: did,
    episodeId: epId,
    dramaTitle,
    episodeNumber: epNum,
    resourceType: GEN_RESOURCE.EPISODE_MERGE,
    resourceId: epId,
    label: `${epLabel} 合成视频`,
  }
  store.setVideoStatus('generating', did, epId)
  store.setVideoProgress(5, did, epId)
  genStore.markRunning(mergeMeta)
  videoErrorMsg.value = ''
  try {
    const result = await dramaAPI.finalizeEpisode(epId, getFinalizeMergeOptions())
    if (result?.task_id != null) {
      store.setVideoProgress(10, did, epId)
      ElMessage.success(result?.message || '视频合成任务已提交，请稍后查看')
      const pollResult = await pollTask(result.task_id, () => loadDrama(), mergeMeta)
      await loadDrama()
      if (pollResult?.status === 'completed') {
        store.setVideoProgress(100, did, epId)
        if (currentEpisodeVideoUrl.value) {
          store.setVideoStatus('done', did, epId)
          ElMessage.success('视频生成完成')
        } else {
          store.setVideoStatus('error', did, epId)
          videoErrorMsg.value = '视频生成完成但未获取到播放地址，请稍后刷新'
          ElMessage.warning(videoErrorMsg.value)
        }
      } else if (pollResult?.status === 'failed') {
        store.setVideoStatus('error', did, epId)
        videoErrorMsg.value = pollResult?.error || '视频生成失败'
      } else if (pollResult?.status === 'timeout') {
        store.setVideoStatus('generating', did, epId)
        videoErrorMsg.value = '任务仍在排队或生成中，请稍后刷新查看'
        ElMessage.warning(videoErrorMsg.value)
      }
    } else {
      store.setVideoStatus('error', did, epId)
      const msg = result?.message || '本集没有可合成的视频片段'
      videoErrorMsg.value = msg
      ElMessage.warning(msg)
    }
  } catch (e) {
    videoErrorMsg.value = e.message || '生成失败'
    store.setVideoStatus('error', did, epId)
  } finally {
    if (store.getVideoStatus(did, epId) !== 'generating') {
      genStore.markDone(mergeMeta)
    }
  }
}

async function flushBackgroundMusic() {
  return await backgroundMusicPanel.value?.flush?.()
}

defineExpose({
  getFinalizeMergeOptions,
  onGenerateVideo,
  setVideoErrorMsg,
  backgroundMusicPanel,
  flushBackgroundMusic,
  videoSubtitle,
  videoBurnDialogue,
  videoBurnNarration,
  videoWatermark,
  videoWatermarkText,
  videoTailBlack,
  videoResolution,
})
</script>

<style scoped>
.final-merge-workbench {
  display: contents;
}

.config-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px 24px;
  margin-bottom: 16px;
}
.video-option-hint {
  flex: 1;
  min-width: 200px;
  font-size: 12px;
  line-height: 1.45;
  color: var(--el-text-color-secondary);
}
.video-option-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 10px 12px;
}
.video-watermark-input {
  flex: 1;
  min-width: 200px;
  max-width: 360px;
}
.config-tip {
  margin: 12px 0 0;
  font-size: 0.9rem;
  color: #a1a1aa;
}
.config-tip .el-link { font-size: inherit; }
.sub-title {
  font-size: 1rem;
  margin: 16px 0 8px;
  color: #e4e4e7;
}
.video-progress, .video-done, .video-error {
  margin-top: 16px;
}
.video-preview-wrap {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}
.video-preview-label {
  margin: 0 0 10px;
  font-size: 0.95rem;
  color: #a1a1aa;
}
.video-preview-player {
  display: block;
  max-width: 100%;
  max-height: 360px;
  border-radius: 8px;
  background: #1a1b24;
}
</style>
