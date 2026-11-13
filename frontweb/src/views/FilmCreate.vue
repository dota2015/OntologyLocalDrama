<template>
  <div class="film-create" :class="{ 'sidebar-collapsed': navCollapsed }">
    <!-- 顶部 -->
    <header class="header">
      <div class="header-inner">
        <h1 class="logo" @click="goList">
          <span class="logo-main">本地短剧助手</span>
          <span class="logo-sub">LocalMiniDrama</span>
        </h1>
        <span class="breadcrumb-sep">›</span>
        <span class="page-title">{{ dramaId ? (store.drama?.title || '项目') : '新建故事' }}</span>
        <el-select
          v-if="dramaId"
          v-model="selectedEpisodeId"
          class="header-episode-select"
          placeholder="选择集数"
          clearable
          size="small"
          style="width: 130px"
          @change="onEpisodeSelect"
        >
          <el-option
            v-for="ep in (store.drama?.episodes || [])"
            :key="ep.id"
            :label="ep.title || '第' + (ep.episode_number || 0) + '集'"
            :value="ep.id"
          />
        </el-select>
        <el-button v-if="dramaId" class="btn-back-drama" @click="router.push('/drama/' + dramaId)">
          <el-icon><ArrowLeft /></el-icon>
          返回剧集
        </el-button>
        <el-button v-if="dramaId" type="primary" plain class="btn-canvas-mode" @click="goCanvasMode">
          <el-icon><Grid /></el-icon>
          画布模式
        </el-button>
        <div class="header-actions">
          <el-button class="btn-theme" :title="isDark ? '切换到浅色模式' : '切换到暗色模式'" @click="toggleTheme">
            <el-icon><Sunny v-if="isDark" /><Moon v-else /></el-icon>
            {{ isDark ? '浅色' : '暗色' }}
          </el-button><el-button class="btn-ai-config" @click="showAiConfigDialog = true">
            <el-icon><Setting /></el-icon>
            AI配置
          </el-button>
        </div>
      </div>
    </header>

    <!-- 左侧固定侧边栏 -->
    <nav class="quick-nav" :class="{ collapsed: navCollapsed }" aria-label="快捷导航">
      <div class="nav-sidebar-header">
        <span v-if="!navCollapsed" class="nav-sidebar-title">导航</span>
        <div class="nav-toggle" :title="navCollapsed ? '展开导航' : '收起导航'" @click="toggleNav()">
          <el-icon><Expand v-if="navCollapsed" /><Fold v-else /></el-icon>
        </div>
      </div>

      <!-- 步骤列表 -->
      <div class="nav-steps">
        <div
          v-for="(step, idx) in navSteps"
          :key="step.key"
          class="nav-step"
          :class="['status-' + step.status]"
          @click="scrollToAnchor(step.anchor)"
        >
          <!-- 左侧连接线 -->
          <div class="step-connector-wrap">
            <div v-if="idx > 0" class="step-line step-line-top" :class="{ filled: navSteps[idx - 1].status === 'done' }" />
            <div
              class="step-dot"
              :class="['dot-' + step.status]"
            >
              <el-icon v-if="step.status === 'done'" class="dot-icon"><Check /></el-icon>
              <el-icon v-else-if="step.status === 'generating'" class="dot-icon spin"><Loading /></el-icon>
              <span v-else class="dot-num">{{ idx + 1 }}</span>
            </div>
            <div v-if="idx < navSteps.length - 1" class="step-line step-line-bottom" :class="{ filled: step.status === 'done' }" />
          </div>

          <!-- 右侧文字 + 状态徽章 -->
          <div class="step-body">
            <span class="step-label">{{ step.label }}</span>
            <span v-if="step.count > 0 && step.status !== 'done'" class="step-count">{{ step.count }}</span>
            <span v-if="step.status === 'partial'" class="step-badge partial-badge" title="部分完成">
              <el-icon><WarningFilled /></el-icon>
            </span>
            <span v-else-if="step.status === 'generating'" class="step-badge gen-badge" title="生成中">
              <el-icon class="spin"><Loading /></el-icon>
            </span>
          </div>
        </div>
      </div>

      <!-- 分镜子列表 -->
      <div v-if="!navCollapsed && storyboards.length > 0" class="nav-group">
        <div class="nav-sub-toggle" @click="storyboardMenuExpanded = !storyboardMenuExpanded">
          <el-icon><Minus v-if="storyboardMenuExpanded" /><Plus v-else /></el-icon>
          <span>分镜列表</span>
        </div>
        <div v-show="storyboardMenuExpanded" class="nav-sub-list">
          <template v-for="(sb, i) in storyboards" :key="sb.id">
            <!-- 段落标题行 -->
            <div
              v-if="sb.segment_title && (i === 0 || sb.segment_index !== storyboards[i - 1].segment_index)"
              class="nav-segment-label"
            >
              <span class="nav-segment-dot" />
              {{ sb.segment_title }}
            </div>
            <div
              class="nav-sub-item"
              :title="sb.title || '分镜 ' + (i + 1)"
              @click="scrollToAnchor('sb-' + sb.id)"
            >
              {{ i + 1 }}. {{ sb.title || '分镜' }}
            </div>
          </template>
        </div>
      </div>

      <!-- 当前任务面板 -->
      <SidebarActiveTasks
        :nav-collapsed="navCollapsed"
        :active-tasks="allActiveTaskItems"
        :running-count="runningTasksCount"
        :waiting-count="waitingTasksCount"
        :get-anchor="getTaskTargetAnchor"
        @navigate="handleTaskItemClick"
        @cancel="cancelActiveTask"
      />
    </nav>

    <main class="main">
      <!-- 剧本工作台：单卡片 + 选项卡（创作 / 选择） -->
      <ScriptWorkbench ref="scriptWorkbenchRef" />

      <!-- 全体全流程流水线后台监控与状态 -->
      <GenerationJobs ref="generationJobsPanel" :drama-id="dramaId" :episode-id="currentEpisodeId" kinds="pipeline,repair,text_framework,extraction" @jobs-change="applyGenerationJobs" @updated="onGenerationJobsUpdated" />
      <section v-if="pipelineRunning || pipelineErrorLog.length > 0" class="section card pipeline-section">
        <div class="pipeline-running-header" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <span class="one-click-label">🚀 全体全流程正在执行</span>
          <div class="pipeline-controls">
            <el-button v-if="!pipelinePaused" type="warning" size="small" @click="controlServerPipeline('pause')">⏸ 暂停流水线</el-button>
            <el-button v-else type="success" size="small" @click="onPipelineResume">▶ 继续流水线</el-button>
          </div>
        </div>
        <div class="pipeline-status" style="margin-top:0">
          <div v-if="pipelineCurrentStep" class="pipeline-current-step">
            <span v-if="pipelineStepIndex > 0" class="pipeline-step-badge">{{ pipelineStepIndex }}/{{ pipelineStepTotal }}</span>
            {{ pipelineCurrentStep.replace(/^\[步骤 \d+\/\d+\] /, '') }}
          </div>
          <!-- 阶段间倒计时 -->
          <div v-if="pipelineCountdown > 0" class="pipeline-countdown">
            <div class="pipeline-countdown-ring">
              <span class="pipeline-countdown-num">{{ pipelineCountdown }}</span>
              <span class="pipeline-countdown-unit">秒</span>
            </div>
            <div class="pipeline-countdown-body">
              <p class="pipeline-countdown-msg">{{ pipelineCountdownMsg }}</p>
              <div class="pipeline-countdown-actions">
                <el-button size="small" type="success" @click="skipPipelineCountdown">⚡ 立即开始下一阶段</el-button>
                <el-button v-if="!pipelinePaused" size="small" type="warning" @click="controlServerPipeline('pause')">⏸ 暂停倒计时</el-button>
                <span v-else class="pipeline-countdown-paused">已暂停 — 点击右上角"继续"恢复</span>
              </div>
            </div>
          </div>
          <div v-if="pipelineActiveTasks.size > 0" class="pipeline-active-tasks">
            <span
              v-for="label in Array.from(pipelineActiveTasks)"
              :key="label"
              class="pipeline-task-chip"
            >
              <span class="pipeline-task-dot" />{{ label }}
            </span>
          </div>
          <div v-if="pipelineErrorLog.length > 0" class="pipeline-error-log">
            <div class="pipeline-error-title">执行过程中的错误：</div>
            <div v-for="(entry, idx) in pipelineErrorLog" :key="idx" class="pipeline-error-line">
              [{{ entry.step }}] {{ entry.message }}
            </div>
          </div>
        </div>
      </section>

      <!-- 资源管理工作台：角色 / 道具 / 场景 -->
      <AssetWorkbench ref="assetWorkbenchRef" />

      <!-- 5. 分镜生成工作台 -->
      <StoryboardWorkbench ref="storyboardWorkbenchRef" />

      <NarratorVoiceSettings
        @profile="onDubbingProfile"
        :drama-id="dramaId"
      />

      <!-- 视频配置与合成工作台 -->
      <FinalMergeWorkbench ref="finalMergeRef" @open-ai-config="showAiConfigDialog = true" />
    </main>









    <!-- AI 配置弹窗（不跳转，避免本页内容丢失） -->
    <el-dialog v-model="showAiConfigDialog" title="AI 配置" width="90%" destroy-on-close class="ai-config-dialog">
      <AIConfigContent v-if="showAiConfigDialog" />
    </el-dialog>

    <!-- 图片放大预览：点击遮罩或图片关闭 -->
    <Teleport to="body">
      <div
        v-if="previewImageUrl"
        class="image-preview-overlay"
        @click="closeImagePreview"
      >
        <img :src="previewImageUrl" alt="" class="image-preview-img" @click.stop="closeImagePreview" />
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch, reactive, provide } from 'vue'
import GenerationJobs from '@/components/GenerationJobs.vue'
import { activeGenerationJob } from '@/api/generationJobs'
import { useAgentContext } from '@/stores/agentContext'
import { useRoute, useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import { ElMessage } from 'element-plus'
import { ArrowLeft, Setting, Plus, Minus, Sunny, Moon, Check, Loading, WarningFilled, Expand, Fold, Grid } from '@element-plus/icons-vue'
import { useTheme } from '@/composables/useTheme'
import { useFilmStore } from '@/stores/film'
import { useGenerationTaskStore, GEN_RESOURCE } from '@/stores/generationTaskStore'
import { syncGeneratingSetsFromStore, buildEpisodeContext, isEpisodeExtractRunning } from '@/composables/useGenerationTaskSync'
import { dramaAPI } from '@/api/drama'
import AIConfigContent from '@/components/AIConfigContent.vue'
import NarratorVoiceSettings from '@/components/NarratorVoiceSettings.vue'
import FinalMergeWorkbench from '@/components/filmCreate/FinalMergeWorkbench.vue'
import SidebarActiveTasks from '@/components/filmCreate/SidebarActiveTasks.vue'
import StoryboardWorkbench from '@/components/filmCreate/StoryboardWorkbench.vue'
import ScriptWorkbench from '@/components/filmCreate/ScriptWorkbench.vue'
import AssetWorkbench from '@/components/filmCreate/AssetWorkbench.vue'
import {
  generationStyleOptions,
  stylePromptMetadataForSave,
  backfillDramaStylePromptMetadataIfNeeded,
  CUSTOM_STYLE_VALUE,
} from '@/constants/styleOptions'
import { useNavigation } from '@/composables/filmCreate/useNavigation'
import { useTaskNavigation } from '@/composables/filmCreate/useTaskNavigation'
import { useFullPipeline } from '@/composables/filmCreate/useFullPipeline'
import { useStoryboardState } from '@/composables/filmCreate/useStoryboardState'

const route = useRoute()
const router = useRouter()
const store = useFilmStore()
const genStore = useGenerationTaskStore()
const { isDark, toggle: toggleTheme } = useTheme()
const { videoResolution: storeVideoResolution } = storeToRefs(store)

// ── Composable: Navigation ─────────────────────────────
const { navCollapsed, storyboardMenuExpanded, toggleNav, scrollToTop, scrollToAnchor } = useNavigation()

function goList() {
  router.push('/')
}

function goCanvasMode() {
  if (!dramaId.value) return
  const query = selectedEpisodeId.value ? { episode: String(selectedEpisodeId.value) } : {}
  router.push({ path: `/film/${dramaId.value}/canvas`, query })
}

const showAiConfigDialog = ref(false)
watch(showAiConfigDialog, (open) => {
  if (!open) storyboardWorkbenchRef.value?.invalidateActiveVideoAiConfigCache?.()
})
const storyInput = ref('')
const storyStyle = ref('')
const storyType = ref('')
const storyEpisodeCount = ref(1)
const storyGenerating = ref(false)
const scriptWorkbenchRef = ref(null)
const scriptTitle = ref('')
const selectedEpisodeId = ref(null)
/** 保存剧本后用于恢复选中集（后端重插后 id 会变，用 episode_number 匹配） */
const savedCurrentEpisodeNumber = ref(1)
const scriptLanguage = ref('zh')
const scriptStoryboardStyle = ref('')
const scriptGenerating = ref(false)
const isStoryGenRunning = computed(() => {
  if (storyGenerating.value || scriptGenerating.value || scriptWorkbenchRef.value?.episodeScriptGenerating) return true
  return genStore.getAllRunningTasks().some(
    (t) => Number(t.dramaId) === Number(dramaId.value) && t.resourceType === GEN_RESOURCE.GENERATE_STORY
  )
})
const generationStyle = ref('')
const narrativeStyleSaving = ref(false)
const narrativeStyle = ref({ preset: 'balanced', speech_rate: 1, speech_mode: 'fixed' })
const customStylePrompt = ref('')
const projectAspectRatio = ref('16:9')
const shotDurationMin = ref(4)
// A new project may use ordinary H3 for 4–8s or Continuum for 9–30s.
// Keep the full range available unless the user explicitly saved a narrower range.
const shotDurationMax = ref(30)
const videoClipDuration = ref(5)

/** 根据 value 查找样式选项对象 */
function _findStyleOption(val) {
  for (const group of generationStyleOptions) {
    const found = group.options.find(o => o.value === val)
    if (found) return found
  }
  return null
}

/** 传给图像/视频 AI 用的英文 prompt（效果最好）；
 *  找不到 promptEn 时降级到 prompt，再降级到原始值；
 *  custom 时返回用户填写的自定义描述，避免把字面量 "custom" 写入提示词 */
function getSelectedStylePrompt() {
  const val = (generationStyle.value || '').toString().trim()
  if (!val) return undefined
  if (val === CUSTOM_STYLE_VALUE) {
    const text = (customStylePrompt.value || '').toString().trim()
    return text || undefined
  }
  const opt = _findStyleOption(val)
  if (opt) return opt.promptEn || opt.prompt || val
  return val
}

/** 中文风格描述（用于界面展示或中文场景提示词拼接） */
function getSelectedStylePromptZh() {
  const val = (generationStyle.value || '').toString().trim()
  if (!val) return undefined
  if (val === CUSTOM_STYLE_VALUE) {
    const text = (customStylePrompt.value || '').toString().trim()
    return text || undefined
  }
  const opt = _findStyleOption(val)
  if (opt) return opt.prompt || opt.promptEn || val
  return val
}

function projectStylePromptMetadata() {
  return stylePromptMetadataForSave(generationStyle.value, customStylePrompt.value)
}

function getSelectedStyle() {
  return getSelectedStylePrompt()
}

const scriptContent = computed({
  get: () => store.scriptContent,
  set: (v) => store.setScriptContent(v)
})
const videoResolution = storeVideoResolution
const finalMergeRef = ref(null)
const assetWorkbenchRef = ref(null)
const storyboardWorkbenchRef = ref(null)

const dramaId = computed(() => store.dramaId)
const characters = computed(() => store.characters)
const scenes = computed(() => store.scenes)
const props = computed(() => store.props)
const storyboards = computed(() => store.storyboards)
const currentEpisode = computed(() => store.currentEpisode)
const currentEpisodeId = computed(() => store.currentEpisode?.id ?? null)
const videoProgress = computed(() => store.videoProgress)
const videoStatus = computed(() => store.videoStatus)

function trackFilmCreateAction(_action, _payload = {}) {
  // 单机版：无埋点上报
}

const directorGenerating = ref(false)
const storyboardGenerating = computed(() =>
  directorGenerating.value || isEpisodeExtractRunning(genStore, dramaId.value, currentEpisodeId.value, GEN_RESOURCE.GENERATE_STORYBOARD)
)
/** 分镜批量生成结束后，按镜序逐个润色全能片段（仅勾选全能模式且各镜为 universal 且有正文时） */
const universalOmniPolishRunning = ref(false)
const universalOmniPolishAbort = ref(false)
const universalOmniPolishProgress = ref({ current: 0, total: 0, label: '' })
const sbTruncatedWarning = ref(false)
const sbTruncatedDismissed = ref(false)


// 批量参考图与参考模式运行状态（供 ScriptWorkbench 与 AssetWorkbench 共享）
const referenceBatchRunning = ref(false)
const referenceSuggestionsRunning = ref(false)
const savingReferenceModeIds = reactive(new Set())
function onReferenceModeSaving(kind, id, saving) {
  const key = `${kind}:${id}`
  if (saving) savingReferenceModeIds.add(key)
  else savingReferenceModeIds.delete(key)
}

// 批量生成分镜图/视频全局状态（供 useFullPipeline / useTaskNavigation 调度）
const batchImageRunning = ref(false)
const batchImageStopping = ref(false)
const batchImageProgress = ref({ current: 0, total: 0, failed: 0 })
const inferringParams = ref(false)
const auditingInvariants = ref(false)
const showVideoParamsDialog = ref(false)
const videoParamsTarget = ref(null)
const videoParamsSaving = ref(false)
const splitByAudioLoading = ref(false)
const batchImageErrors = ref([])
const serverGenerationJobs = ref([])
const activeImageJobs = computed(() => {
  return serverGenerationJobs.value.filter(j =>
    Number(j.episode_id) === Number(currentEpisodeId.value) &&
    j.kind === 'storyboard_images' &&
    activeGenerationJob(j)
  )
})
const activeImageJob = computed(() => {
  return activeImageJobs.value.find(j => j.status === 'running') || activeImageJobs.value[0] || null
})
const activeImageJobOptions = computed(() => {
  const opt = activeImageJob.value?.options
  if (!opt) return null
  if (typeof opt === 'string') {
    try { return JSON.parse(opt) } catch (_) { return null }
  }
  return opt
})
const singleShotImageInfo = computed(() => {
  const opt = activeImageJobOptions.value
  if (!opt || !Array.isArray(opt.storyboard_ids) || opt.storyboard_ids.length !== 1) return null
  const sbId = opt.storyboard_ids[0]
  const sb = (storyboards.value || []).find(s => Number(s.id) === Number(sbId))
  const sbNum = sb ? (sb.storyboard_number || sb.shot_number || '') : ''
  const slots = opt.slots || []
  let slotText = '分镜图'
  if (slots.includes('first') && slots.includes('last')) slotText = '首尾帧'
  else if (slots.includes('first')) slotText = '首帧'
  else if (slots.includes('last')) slotText = '尾帧'
  const queuedCount = activeImageJobs.value.filter(j => j.status === 'queued').length
  return { sbId, sbNum, slotText, queuedCount }
})
const batchVideoRunning = ref(false)
const batchVideoStopping = ref(false)
const batchVideoProgress = ref({ current: 0, total: 0, failed: 0 })
const batchVideoErrors = ref([])
const serverVideoBatch = ref(null)
const batchVideoSubmitting = ref(false)
const videoFrameContiguity = ref(localStorage.getItem('videoFrameContiguity') !== 'false')

// ── Composable: Storyboard State & Media Cache ────────────────────────
const {
  sbCharacterIds,
  sbPropIds,
  sbSceneId,
  sbDialogue,
  sbNarration,
  sbBgmPrompt,
  sbShotType,
  sbTitle,
  sbLocation,
  sbTime,
  sbDuration,
  sbAction,
  sbResult,
  sbAtmosphere,
  sbAngle,
  sbAngleH,
  sbAngleV,
  sbAngleS,
  sbMovement,
  sbLighting,
  sbDof,
  sbLayoutDescription,
  regeneratingLayoutSbIds,
  sbCreationMode,
  sbUniversalSegmentText,
  sbImages,
  sbVideos,
  sbVideoErrors,
  sbSelectedImgId,
  sbSelectedLastImgId,
  sbSelectedVideoId,
  generatingSbImageIds,
  generatingSbFirstImageIds,
  generatingSbLastImageIds,
  generatingSbVideoIds,
  generatingUniversalSegmentIds,
  upscalingSbIds,
  ttsSbIds,
  ttsSbNarrationIds,
  linkingTailFrameIds,
  linkingFirstFrameIds,
  usingPrevTailAsFirstIds,
  sbDialogueAudioPaths,
  sbNarrationAudioPaths,
  sbImageUploadSlotById,
  storyboardCount,
  videoDuration,
  storyboardIncludeNarration,
  storyboardUniversalOmni,
  storyboardUseFirstLastFrame,
  exportingStoryboardSheet,
  lastFrameUseFirstLayoutLock,
  gridMode,
  baseUrl,
  previewImageUrl,
  imageUrl,
  assetImageUrl,
  hasAssetImage,
  openImagePreview,
  closeImagePreview,
  assetVideoUrl,
  isHttpVideoUrl,
  recordHasPlayableVideoUrl,
  sbMainVideoPlayerKey,
  clipSecondsForStoryboardEstimate,
  shotCountEstimateFromDurationSec,
  estimateVideoDurationSecFromCharLen,
  scriptStoryboardEstimate,
  scriptEstimateVideoDurationHint,
  scriptEstimateVideoDurationTitle,
  scriptEstimateStoryboardHint,
  scriptEstimateStoryboardTitle,
  scriptTextTrimmedForEstimate,
  userFilledStoryboardCount,
  userFilledVideoDuration,
  getVideoDurationForApi,
  getStoryboardCountForApi,
  isSbUniversalMode,
  uploadingSbImageSlot,
  frameTypeForSlot,
  resolveSbImageById,
  getSbFirstImage,
  getSbLastImage,
  hasSbImage,
  hasSbFirstLastPair,
  missingSbImageSlots,
  getSbAllImages,
  getSbImage,
  getQuadGridImage,
  getSbAllVideos,
  getSbVideo,
  getNextStoryboard,
  getPrevStoryboard,
  canUsePrevTailAsFirst,
  getVideoStripItems,
  onSelectSbMainVideo,
  getSbVideoError,
  getSbResumableFailedVideo,
  isSbVideoGenerating,
  buildSbGenMeta,
  getSbCharacterIds,
  setSbCharacterIds,
  onStoryboardCharacterChange,
  charactersAvailableToAddToSb,
  onSbAddCharacterCommand,
  getSbPropIds,
  setSbPropIds,
  onStoryboardPropChange,
  onStoryboardSceneChange,
  getSbSceneId,
  setSbSceneId,
  getSbSelectedScene,
  getSbSelectedCharacters,
  getSbSelectedProps,
  getMovementLabel,
  onStoryboardUseFirstLastFrameChange,
  onLastFrameLayoutLockChange,
  restoreSelectionsFromBackend,
  loadStoryboardMedia,
  loadSingleStoryboardMedia,
  syncStoryboardStateFromEpisode,
} = useStoryboardState({
  store,
  dramaId,
  currentEpisodeId,
  genStore,
  scriptContent,
  shotDurationMin,
  shotDurationMax,
  videoClipDuration,
  serverVideoBatch,
  saveProjectSettings,
})

function getGeneratingSetsBag() {
  return {
    generatingCharIds: assetWorkbenchRef.value?.generatingCharIds || new Set(),
    generatingPropIds: assetWorkbenchRef.value?.generatingPropIds || new Set(),
    generatingSceneIds: assetWorkbenchRef.value?.generatingSceneIds || new Set(),
    generatingSbImageIds,
    generatingSbFirstImageIds,
    generatingSbLastImageIds,
    generatingSbVideoIds,
  }
}

async function recoverAndSyncEpisodeTasks(epId) {
  const did = dramaId.value
  const eid = epId ?? currentEpisodeId.value
  if (!did || !eid) return
  const ctx = buildEpisodeContext(store, did, eid)
  await genStore.recoverPendingForEpisode({
    ...ctx,
    ElMessage,
    callbacks: {
      onStoryboardMedia: (sbId) => loadSingleStoryboardMedia(sbId),
      onDramaRefresh: () => loadDrama(),
      onEpisodeMergeComplete: () => {
        store.setVideoStatus('done', did, eid)
        store.setVideoProgress(100, did, eid)
      },
      onEpisodeMergeFailed: (err) => {
        store.setVideoStatus('error', did, eid)
        finalMergeRef.value?.setVideoErrorMsg(err || '视频生成失败')
      },
    },
  })
  syncGeneratingSetsFromStore(genStore, did, eid, getGeneratingSetsBag())
  const mergeRunning = genStore.getRunningForEpisode(did, eid).some(
    (t) => t.resourceType === GEN_RESOURCE.EPISODE_MERGE
  )
  if (mergeRunning) {
    store.setVideoStatus('generating', did, eid)
  }
}

function onEpisodeSelect(epId) {
  if (epId == null) {
    store.setCurrentEpisode(null)
    store.setScriptContent('')
    scriptTitle.value = ''
    syncStoryboardStateFromEpisode(null)
    return
  }
  const list = store.drama?.episodes || []
  const ep = list.find((e) => Number(e.id) === Number(epId))
  if (!ep) return
  store.setCurrentEpisode(ep)
  store.setScriptContent(ep.script_content || '')
  scriptTitle.value = ep.title || '第' + (ep.episode_number || 0) + '集'
  syncStoryboardStateFromEpisode(ep)
  loadStoryboardMedia()
  recoverAndSyncEpisodeTasks(epId)
}

async function loadDrama() {
  if (!store.dramaId) return
  try {
    let d = await dramaAPI.get(store.dramaId)
    d = await backfillDramaStylePromptMetadataIfNeeded(dramaAPI, store.dramaId, d)
    store.setDrama(d)
    storyInput.value = (d.description || '').toString().trim()
    storyStyle.value = (d.metadata && d.metadata.story_style) ? d.metadata.story_style : ''
    storyType.value = d.genre || ''
    generationStyle.value = d.style || ''
    narrativeStyle.value = d.metadata?.narrative_style ? { ...d.metadata.narrative_style, preset: d.metadata.narrative_style.preset === 'dialogue_fast' ? 'balanced' : d.metadata.narrative_style.preset, speech_rate: 1, speech_mode: 'fixed' } : { preset: 'balanced', speech_rate: 1, speech_mode: 'fixed' }
    if ((d.style || '') === CUSTOM_STYLE_VALUE) {
      customStylePrompt.value = (d.metadata?.style_prompt_zh || d.metadata?.style_prompt_en || '').toString()
    } else {
      customStylePrompt.value = ''
    }
    projectAspectRatio.value = (d.metadata && d.metadata.aspect_ratio) ? d.metadata.aspect_ratio : '16:9'
    videoClipDuration.value = (d.metadata && d.metadata.video_clip_duration) ? Number(d.metadata.video_clip_duration) : 5
    const savedRange = d.metadata?.shot_duration_range
    shotDurationMin.value = Math.max(4, Math.min(30, Number(savedRange?.min) || 4))
    shotDurationMax.value = Math.max(shotDurationMin.value, Math.min(30, Number(savedRange?.max) || 30))
    videoClipDuration.value = Math.round((shotDurationMin.value + shotDurationMax.value) / 2)
    storyboardIncludeNarration.value = !!(d.metadata && d.metadata.storyboard_include_narration)
    // 全能分镜不再提供项目级开关，始终默认启用；单镜 FL2VA 由分镜配置覆盖。
    storyboardUniversalOmni.value = true
    storyboardUseFirstLastFrame.value = !!(d.metadata && d.metadata.storyboard_use_first_last_frame)
    lastFrameUseFirstLayoutLock.value = d.metadata?.last_frame_use_first_layout_lock !== false
    if (d.metadata && d.metadata.video_frame_contiguity !== undefined) {
      videoFrameContiguity.value = !!d.metadata.video_frame_contiguity
    }
    if (storyboardUseFirstLastFrame.value && gridMode.value !== 'single') {
      gridMode.value = 'single'
    }
    const list = d.episodes || []
    const currentId = selectedEpisodeId.value
    let ep = currentId != null ? list.find((e) => Number(e.id) === Number(currentId)) : null
    if (!ep) {
      const wantNum = savedCurrentEpisodeNumber.value
      ep = list.find((e) => Number(e.episode_number) === Number(wantNum)) || list[0] || null
    }
    store.setCurrentEpisode(ep)
    if (ep) {
      store.setScriptContent(ep.script_content || '')
      scriptTitle.value = ep.title || '第' + (ep.episode_number || 0) + '集'
      selectedEpisodeId.value = ep.id
    } else {
      store.setScriptContent('')
      scriptTitle.value = ''
      selectedEpisodeId.value = null
    }
    syncStoryboardStateFromEpisode(ep)
    await loadStoryboardMedia()
    await recoverAndSyncEpisodeTasks(ep?.id)
  } catch (e) {
    ElMessage.error(e.message || '加载失败')
  }
}

/**
 * @param {boolean} includeGenerationStyle - 仅在选择「画面风格」为 true：写入 dramas.style 与 style_prompt_*。
 * 其它项目设置改为 false，避免界面未刷新时仍用旧的 generationStyle 覆盖外部已更新的画风（如直接调 API PUT outline）。
 */
function saveShotDurationRange() {
  if (!Number.isInteger(shotDurationMin.value) || !Number.isInteger(shotDurationMax.value)) return
  videoClipDuration.value = Math.round((shotDurationMin.value + shotDurationMax.value) / 2)
  saveProjectSettings(false)
}

async function saveProjectSettings(includeGenerationStyle = false) {
  if (!store.dramaId) return
  const metadata = {
    story_style: storyStyle.value || undefined,
    aspect_ratio: projectAspectRatio.value || '16:9',
    video_clip_duration: videoClipDuration.value || 5,
    shot_duration_range: { min: shotDurationMin.value, max: shotDurationMax.value },
    storyboard_include_narration: !!storyboardIncludeNarration.value,
    storyboard_universal_omni: !!storyboardUniversalOmni.value,
    storyboard_use_first_last_frame: !!storyboardUseFirstLastFrame.value,
    last_frame_use_first_layout_lock: !!lastFrameUseFirstLayoutLock.value,
    video_frame_contiguity: !!videoFrameContiguity.value,
    h3_default_continuity: videoFrameContiguity.value ? 'auto' : 'off',
  }
  if (includeGenerationStyle) {
    Object.assign(metadata, projectStylePromptMetadata())
  }
  const payload = {
    genre: storyType.value || undefined,
    metadata,
  }
  if (includeGenerationStyle) {
    payload.style = generationStyle.value || undefined
  }
  dramaAPI.saveOutline(store.dramaId, payload).catch(e => console.error('Settings auto-save failed', e))
}

watch(videoFrameContiguity, (val) => {
  try {
    localStorage.setItem('videoFrameContiguity', String(val))
  } catch (_) {}
  saveProjectSettings(false)
})

function onNarrativeStyleSaved(settings) {
  narrativeStyle.value = { ...settings }
  if (store.drama) store.drama.metadata = { ...store.drama.metadata, narrative_style: { ...settings, speech_rate: 1, speech_mode: 'fixed' }, tts_dubbing: { ...store.drama.metadata?.tts_dubbing, speed: 1 } }
  if (dubbingVoiceProfile.value) dubbingVoiceProfile.value = { ...dubbingVoiceProfile.value, speed: 1 }
}
function onDubbingProfile(profile) {
  dubbingVoiceProfile.value = profile
  if (profile && store.drama?.metadata?.narrative_style) onNarrativeStyleSaved({ ...narrativeStyle.value, speech_rate: 1, speech_mode: 'fixed' })
}

/** 生成期间轻量刷新分镜列表（只更新指定集 storyboards，不重载整个 drama） */
async function refreshStoryboardsForEpisode(episodeId) {
  if (!episodeId) return
  try {
    const res = await dramaAPI.getStoryboards(episodeId)
    const list = Array.isArray(res) ? res : (res?.storyboards ?? null)
    if (!Array.isArray(list)) return
    if (Number(store.currentEpisode?.id) === Number(episodeId)) {
      store.currentEpisode.storyboards = list
    }
    const epInDrama = store.drama?.episodes?.find((e) => Number(e.id) === Number(episodeId))
    if (epInDrama) {
      epInDrama.storyboards = list
    }
  } catch (_) { /* 静默忽略，不影响主流程 */ }
}

/** @deprecated 使用 refreshStoryboardsForEpisode */
async function refreshStoryboardsOnly() {
  return refreshStoryboardsForEpisode(currentEpisodeId.value)
}

const dubbingVoiceProfile = ref({})
const speechSummaries = ref({})

watch(dramaId, () => { speechSummaries.value = {} }, { immediate: true })

function resolvePollMeta(meta = {}) {
  return {
    dramaId: meta.dramaId ?? dramaId.value,
    episodeId: meta.episodeId ?? currentEpisodeId.value,
    dramaTitle: meta.dramaTitle ?? store.drama?.title,
    episodeNumber: meta.episodeNumber ?? store.currentEpisode?.episode_number,
    resourceType: meta.resourceType || 'unknown',
    resourceId: meta.resourceId,
    label: meta.label,
    ...meta,
  }
}

function pollTask(taskId, onDone, meta = {}) {
  return genStore.pollTask(taskId, resolvePollMeta(meta), onDone, { ElMessage })
}

// ── Composable: Full Pipeline ─────────────────────────
const {
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
} = useFullPipeline({
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
  getFinalizeMergeOptions: () => finalMergeRef.value?.getFinalizeMergeOptions?.(),
  backgroundMusicPanel: {
    get value() {
      return {
        flush: () => finalMergeRef.value?.flushBackgroundMusic?.() ?? finalMergeRef.value?.backgroundMusicPanel?.flush?.()
      }
    }
  },
  batchImageRunning,
  batchImageStopping,
  batchImageProgress,
  batchImageErrors,
  generatingSbFirstImageIds,
  generatingSbLastImageIds,
  generatingSbImageIds,
  universalOmniPolishRunning,
  universalOmniPolishProgress,
})

const {
  navSteps,
  allActiveTaskItems,
  runningTasksCount,
  waitingTasksCount,
  allActiveTaskLabels,
  cancelActiveTask,
  getTaskTargetAnchor,
  handleTaskItemClick,
} = useTaskNavigation({
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
  stopBatchImageGeneration: () => storyboardWorkbenchRef.value?.stopBatchImageGeneration?.(),
  stopBatchVideoGeneration: () => storyboardWorkbenchRef.value?.stopBatchVideoGeneration?.(),
  syncGeneratingSetsFromStore,
  getGeneratingSetsBag,
  loadSingleStoryboardMedia,
  generationJobsPanel,
  scrollToAnchor,
})

const agentContext = useAgentContext()
watch(currentEpisode, (episode) => {
  agentContext.setEpisodeId(episode?.id ?? null)
}, { immediate: true })

function onAgentChanged(event) {
  if (Number(event.detail?.dramaId) !== Number(dramaId.value)) return
  loadDrama()
}
window.addEventListener('lmd-agent-changed', onAgentChanged)

onBeforeUnmount(() => {
  window.removeEventListener('lmd-agent-changed', onAgentChanged)
  agentContext.clear()
})

function applyRouteToStore() {
  const id = route.params.id
  if (id && id !== 'new') {
    store.setDrama({ id: Number(id) })
    if (route.query.episode) {
      selectedEpisodeId.value = Number(route.query.episode)
    }
    loadDrama()
  } else {
    store.reset()
    storyInput.value = ''
    scriptTitle.value = ''
    selectedEpisodeId.value = null
    savedCurrentEpisodeNumber.value = 1
    storyStyle.value = ''
    storyType.value = ''
    scriptLanguage.value = 'zh'
    scriptStoryboardStyle.value = ''
    generationStyle.value = ''
    narrativeStyle.value = { preset: 'balanced', speech_rate: 1, speech_mode: 'fixed' }
    customStylePrompt.value = ''
  }
}

onMounted(async () => {
  loadPipelineConcurrency()
  applyRouteToStore()
})

watch(() => route.params.id, () => {
  applyRouteToStore()
})

// 剧本分集切换时同步 URL query 参数（?episode=<episode_id>），使刷新/分享页面仍保持当前选中集
// 同时监听 query 变化，支持浏览器前进/后退时自动切换对应集次
watch(
  () => selectedEpisodeId.value,
  (newId) => {
    if (!dramaId.value) return
    const currentInQuery = route.query.episode != null ? Number(route.query.episode) : null
    const desired = newId != null ? Number(newId) : null
    if (currentInQuery !== desired) {
      const newQuery = { ...route.query }
      if (desired != null) {
        newQuery.episode = String(desired)
      } else {
        delete newQuery.episode
      }
      router.replace({ query: newQuery }).catch(() => {})
    }
  },
  { flush: 'post' }
)

watch(
  () => route.query.episode,
  (newEp) => {
    if (!dramaId.value) return
    const newVal = newEp != null ? Number(newEp) : null
    const currentSel = selectedEpisodeId.value != null ? Number(selectedEpisodeId.value) : null
    if (currentSel !== newVal) {
      onEpisodeSelect(newVal)
    }
  }
)

// Provide context for StoryboardCard, ScriptWorkbench and child components
provide('filmCreateContext', {
  // 剧本工作台全局共享参数
  storyInput,
  storyStyle,
  storyType,
  storyEpisodeCount,
  storyGenerating,
  savedCurrentEpisodeNumber,
  narrativeStyleSaving,
  onNarrativeStyleSaved,
  generationStyle,
  customStylePrompt,
  generationStyleOptions,
  shotDurationMin,
  shotDurationMax,
  saveShotDurationRange,
  onStoryboardUseFirstLastFrameChange,
  scriptLanguage,
  pipelineRunning,
  pipelinePaused,
  referenceBatchRunning,
  referenceSuggestionsRunning,
  savingReferenceModeIds,
  onStartEndToEndFullPipeline,
  isStoryGenRunning,
  selectedEpisodeId,
  onEpisodeSelect,
  scriptTitle,
  scriptContent,
  scriptGenerating,
  currentEpisodeId,
  saveProjectSettings,
  dramaId,
  characters,
  scenes,
  props,
  narrativeStyle,
  projectAspectRatio,
  videoResolution,
  videoFrameContiguity,
  storyboardIncludeNarration,
  storyboardUniversalOmni,
  storyboardUseFirstLastFrame,
  lastFrameUseFirstLayoutLock,
  gridMode,
  videoClipDuration,
  shotDurationMin,
  shotDurationMax,
  sbImages,
  sbVideos,
  sbVideoErrors,
  sbSelectedImgId,
  sbSelectedLastImgId,
  sbSelectedVideoId,
  sbCharacterIds,
  sbPropIds,
  sbSceneId,
  sbDialogue,
  sbNarration,
  sbBgmPrompt,
  sbShotType,
  sbTitle,
  sbLocation,
  sbTime,
  sbDuration,
  sbAction,
  sbResult,
  sbAtmosphere,
  sbAngle,
  sbAngleH,
  sbAngleV,
  sbAngleS,
  sbMovement,
  sbLighting,
  sbDof,
  sbLayoutDescription,
  sbCreationMode,
  sbUniversalSegmentText,
  generatingSbImageIds,
  generatingSbFirstImageIds,
  generatingSbLastImageIds,
  generatingSbVideoIds,
  generatingUniversalSegmentIds,
  upscalingSbIds,
  linkingFirstFrameIds,
  linkingTailFrameIds,
  ttsSbIds,
  ttsSbNarrationIds,
  usingPrevTailAsFirstIds,
  batchImageRunning,
  batchImageStopping,
  batchImageProgress,
  batchImageErrors,
  batchVideoRunning,
  batchVideoStopping,
  batchVideoProgress,
  batchVideoErrors,
  serverVideoBatch,
  batchVideoSubmitting,
  directorGenerating,
  storyboardGenerating,
  universalOmniPolishRunning,
  universalOmniPolishProgress,
  storyboardCount,
  videoDuration,
  scriptEstimateStoryboardTitle,
  scriptEstimateStoryboardHint,
  scriptEstimateVideoDurationTitle,
  scriptEstimateVideoDurationHint,
  storyboardJobsPanel,
  onGenerationJobsUpdated,
  loadStoryboardMedia,
  loadSingleStoryboardMedia,
  restoreSelectionsFromBackend,
  refreshStoryboardsOnly,
  refreshStoryboardsForEpisode,
  pollTask,
  getSelectedStylePrompt,
  getSelectedStylePromptZh,
  onStoryboardCharacterChange,
  onStoryboardPropChange,
  getMovementLabel,
  getSbCharacterIds,
  setSbCharacterIds,
  onStoryboardSceneChange,
  getSbSceneId,
  setSbSceneId,
  getSbPropIds,
  setSbPropIds,
  getSbSelectedCharacters,
  getSbSelectedScene,
  getSbSelectedProps,
  charactersAvailableToAddToSb,
  onSbAddCharacterCommand,
  imageUrl,
  assetImageUrl,
  assetVideoUrl,
  previewImageUrl,
  openImagePreview,
  closeImagePreview,
  getSbFirstImage,
  getSbLastImage,
  getSbImage,
  getSbAllImages,
  getQuadGridImage,
  getSbAllVideos,
  getSbVideo,
  hasAssetImage,
  hasSbImage,
  hasSbFirstLastPair,
  missingSbImageSlots,
  canUsePrevTailAsFirst,
  getVideoStripItems,
  onSelectSbMainVideo,
  getSbVideoError,
  getSbResumableFailedVideo,
  getPrevStoryboard,
  getNextStoryboard,
  isSbVideoGenerating,
  sbMainVideoPlayerKey,
  isHttpVideoUrl,
  recordHasPlayableVideoUrl,
  buildSbGenMeta,
  baseUrl,
  genStore,

  // 全局/基础上下文（供 AssetWorkbench 等组件）
  store,
  loadDrama,
  getSelectedStyle,
  submitGenerationJob,
  serverGenerationJobs,
  generationJobsPanel,
  storyboards,
  onReferenceModeSaving,
  onDubbingProfile,
})
</script>

<style scoped>
.film-create {
  min-height: 100vh;
  background: #16171e;
  background-image:
    radial-gradient(ellipse 80% 50% at 60% -5%, rgba(99, 102, 241, 0.13) 0%, transparent 65%),
    radial-gradient(ellipse 50% 40% at 90% 50%, rgba(139, 92, 246, 0.07) 0%, transparent 55%),
    radial-gradient(ellipse 45% 35% at 5% 75%, rgba(79, 70, 229, 0.06) 0%, transparent 55%),
    linear-gradient(180deg, #16171e 0%, #1a1b24 40%, #1e1f29 100%);
  color: #e4e4e7;
}
html.light .film-create {
  background: #f8f7ff;
  background-image:
    radial-gradient(ellipse 80% 50% at 10% -10%, rgba(139, 92, 246, 0.08) 0%, transparent 50%),
    radial-gradient(ellipse 50% 40% at 85% 110%, rgba(99, 102, 241, 0.06) 0%, transparent 50%);
  color: #1e1b4b;
}
.header {
  background: rgba(20, 21, 28, 0.78);
  backdrop-filter: blur(20px) saturate(1.2);
  -webkit-backdrop-filter: blur(20px) saturate(1.2);
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  padding: 10px 28px;
  position: sticky;
  top: 0;
  z-index: 200;
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.15), 0 4px 20px rgba(0, 0, 0, 0.2);
  margin-left: 180px;
  transition: margin-left 0.25s cubic-bezier(.4,0,.2,1);
}
.sidebar-collapsed .header {
  margin-left: 48px;
}
html.light .header {
  background: rgba(255, 255, 255, 0.82) !important;
  border-bottom-color: rgba(139, 92, 246, 0.1) !important;
  box-shadow: 0 1px 0 rgba(139,92,246,0.06), 0 4px 20px rgba(139, 92, 246, 0.05) !important;
}
.header-inner {
  display: flex;
  align-items: center;
  gap: 16px;
}
.logo {
  margin: 0;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 1px;
  line-height: 1;
  transition: filter 0.3s;
}
.logo:hover { filter: drop-shadow(0 0 10px rgba(139, 92, 246, 0.5)); }
.logo-main {
  font-size: 1.05rem;
  font-weight: 700;
  background: linear-gradient(135deg, #d0d5e8 0%, #a8b0cc 50%, #8890b0 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  letter-spacing: -0.01em;
  filter: drop-shadow(0 0 8px rgba(160, 170, 200, 0.15));
}
.logo-sub {
  font-size: 0.65rem;
  font-weight: 400;
  letter-spacing: 0.04em;
  color: #52525e;
  -webkit-text-fill-color: #52525e;
  text-transform: uppercase;
}
html.light .logo-main {
  background: linear-gradient(135deg, #6d28d9, #4f46e5);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}
html.light .logo-sub {
  color: #9ca3af;
  -webkit-text-fill-color: #9ca3af;
}
.breadcrumb-sep {
  color: #3a3a44;
  font-size: 0.9rem;
  font-weight: 300;
  flex-shrink: 0;
  user-select: none;
}
html.light .breadcrumb-sep { color: #d1d5db; }
.page-title {
  font-size: 0.82rem;
  font-weight: 500;
  color: #7a7a88;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: 6px;
  padding: 4px 12px;
  max-width: 220px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
html.light .page-title {
  color: #6b7280;
  background: rgba(99, 102, 241, 0.04);
  border-color: rgba(99, 102, 241, 0.1);
}
.header-episode-select {
  flex-shrink: 0;
}
.btn-back-drama {
  flex-shrink: 0;
}
.header-actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
.btn-theme {
  --el-button-bg-color: rgba(255, 255, 255, 0.04);
  --el-button-border-color: rgba(255, 255, 255, 0.08);
  --el-button-text-color: #8b8b96;
  --el-button-hover-bg-color: rgba(255, 255, 255, 0.08);
  --el-button-hover-border-color: rgba(255, 255, 255, 0.18);
  --el-button-hover-text-color: #c8c8d0;
  transition: all 0.2s ease;
}
html.light .btn-theme {
  --el-button-bg-color: rgba(99, 102, 241, 0.04);
  --el-button-border-color: rgba(99, 102, 241, 0.12);
  --el-button-text-color: #6b7280;
  --el-button-hover-bg-color: rgba(99, 102, 241, 0.08);
  --el-button-hover-border-color: rgba(99, 102, 241, 0.3);
  --el-button-hover-text-color: #4f46e5;
}
/* ===== 左侧固定侧边栏 ===== */
.quick-nav {
  position: fixed;
  left: 0;
  top: 0;
  bottom: 0;
  z-index: 210;
  display: flex;
  flex-direction: column;
  padding: 14px 0 10px;
  background: linear-gradient(180deg, #131318 0%, #111116 50%, #0f0f14 100%);
  border-right: 1px solid rgba(255, 255, 255, 0.06);
  box-shadow: 1px 0 0 rgba(255,255,255,0.02), 4px 0 24px rgba(0, 0, 0, 0.4);
  width: 180px;
  overflow-y: auto;
  overflow-x: hidden;
  transition: width 0.25s cubic-bezier(.4,0,.2,1), padding 0.25s cubic-bezier(.4,0,.2,1);
}
html.light .quick-nav {
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.98) 0%, rgba(248, 247, 255, 0.99) 100%);
  border-right-color: rgba(139, 92, 246, 0.1);
  box-shadow: 1px 0 0 rgba(139,92,246,0.06), 4px 0 20px rgba(139, 92, 246, 0.04);
}
.quick-nav::-webkit-scrollbar { width: 4px; }
.quick-nav::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 4px; }
.quick-nav::-webkit-scrollbar-track { background: transparent; }
.quick-nav.collapsed {
  width: 48px;
  padding: 12px 0;
}
.quick-nav.collapsed .nav-steps,
.quick-nav.collapsed .nav-group {
  display: none;
}
@media (max-width: 768px) {
  .quick-nav { width: 48px; padding: 12px 0; }
  .quick-nav .nav-steps, .quick-nav .nav-group { display: none; }
  .quick-nav .nav-sidebar-title { display: none; }
  .quick-nav .nav-sidebar-header { justify-content: center; padding: 0 4px 8px; }
  .header, .main { margin-left: 48px !important; }
  .main { padding: 16px 12px 48px; }
  .asset-list-two { grid-template-columns: 1fr; }
}

.nav-sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  margin-bottom: 8px;
  flex-shrink: 0;
}
html.light .nav-sidebar-header { border-bottom-color: rgba(139, 92, 246, 0.12); }
.quick-nav.collapsed .nav-sidebar-header {
  justify-content: center;
  padding: 0 4px 8px;
}
.nav-sidebar-title {
  font-size: 13px;
  font-weight: 600;
  color: #7a7a88;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  white-space: nowrap;
  overflow: hidden;
}
html.light .nav-sidebar-title { color: #7c3aed; }
.nav-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  cursor: pointer;
  color: #5a5a66;
  transition: color 0.15s, background 0.15s;
  border-radius: 6px;
  flex-shrink: 0;
  font-size: 16px;
}
.nav-toggle:hover { color: #c8c8d0; background: rgba(255,255,255,0.06); }
html.light .nav-toggle { color: #9ca3af; }
html.light .nav-toggle:hover { color: #374151; background: rgba(0,0,0,0.05); }

/* ─── Steps ─── */
.nav-steps {
  display: flex;
  flex-direction: column;
  padding: 0 10px 0 10px;
}
.nav-step {
  display: flex;
  align-items: stretch;
  gap: 8px;
  cursor: pointer;
  border-radius: 6px;
  padding: 3px 6px 3px 0;
  transition: background 0.2s ease;
  user-select: none;
}
.nav-step:hover { background: rgba(255,255,255,0.04); }
html.light .nav-step:hover { background: rgba(99,102,241,0.05); }

/* connector column */
.step-connector-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 20px;
  flex-shrink: 0;
}
.step-line {
  width: 2px;
  flex: 1;
  min-height: 6px;
  background: rgba(255,255,255,0.1);
  border-radius: 1px;
  transition: background 0.3s;
}
html.light .step-line { background: rgba(0,0,0,0.1); }
.step-line.filled { background: rgba(34, 197, 94, 0.5); }

/* dot */
.step-dot {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 700;
  transition: all 0.25s;
  border: 2px solid transparent;
}
.dot-pending {
  background: rgba(39,39,42,0.6);
  border-color: rgba(63,63,70,0.4);
  color: #52525b;
}
html.light .dot-pending {
  background: rgba(229,231,235,0.6);
  border-color: rgba(156,163,175,0.3);
  color: #9ca3af;
}
.dot-partial {
  background: rgba(245, 158, 11, 0.12);
  border-color: rgba(245, 158, 11, 0.45);
  color: #f59e0b;
}
.dot-generating {
  background: rgba(139, 92, 246, 0.15);
  border-color: rgba(139, 92, 246, 0.5);
  color: #a78bfa;
  box-shadow: 0 0 8px rgba(139, 92, 246, 0.2);
}
.dot-done {
  background: rgba(34, 197, 94, 0.12);
  border-color: rgba(34, 197, 94, 0.5);
  color: #22c55e;
  box-shadow: 0 0 6px rgba(34, 197, 94, 0.15);
}
.dot-icon { font-size: 13px; }
.dot-num { font-size: 11px; line-height: 1; }

/* step body */
.step-body {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  padding: 3px 0;
  min-width: 0;
}
.step-label {
  flex: 1;
  font-size: 13px;
  font-weight: 500;
  color: #71717a;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: color 0.2s ease;
}
html.light .step-label { color: #6b7280; }
.nav-step:hover .step-label { color: #d4d4d8; }
html.light .nav-step:hover .step-label { color: #1e1b4b; }
.status-done .step-label { color: #6ee7b7; }
html.light .status-done .step-label { color: #059669; }
.status-generating .step-label { color: #c4b5fd; }
html.light .status-generating .step-label { color: #7c3aed; }
.status-partial .step-label { color: #fbbf24; }
html.light .status-partial .step-label { color: #d97706; }

.step-count {
  font-size: 10px;
  color: #52525b;
  background: rgba(255,255,255,0.04);
  border-radius: 10px;
  padding: 1px 5px;
  flex-shrink: 0;
  font-weight: 500;
}
html.light .step-count { background: rgba(0,0,0,0.04); color: #9ca3af; }

.step-badge {
  display: flex;
  align-items: center;
  font-size: 11px;
  flex-shrink: 0;
}
.partial-badge { color: #f59e0b; }
.gen-badge { color: #a78bfa; }

/* spin animation */
@keyframes navSpin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
.spin { animation: navSpin 1s linear infinite; display: inline-flex; }

/* sub-toggle & sub-list */
.nav-group { margin-top: 4px; }
.nav-sub-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  font-size: 12px;
  color: #5a5a66;
  cursor: pointer;
  transition: color 0.15s;
  border-top: 1px solid rgba(255,255,255,0.04);
}
html.light .nav-sub-toggle { border-top-color: rgba(0,0,0,0.07); color: #9ca3af; }
.nav-sub-toggle:hover { color: #e4e4e7; }
html.light .nav-sub-toggle:hover { color: #374151; }
.nav-sub-list {
  background: rgba(0,0,0,0.15);
  padding: 4px 0;
  border-radius: 0 0 6px 6px;
}
html.light .nav-sub-list { background: rgba(99,102,241,0.03); }
.nav-sub-item {
  padding: 4px 10px 4px 26px;
  font-size: 11.5px;
  color: #52525b;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: color 0.15s, background 0.15s;
  border-radius: 4px;
  margin: 0 4px;
}
html.light .nav-sub-item { color: #9ca3af; }
.nav-sub-item:hover { color: #d4d4d8; background: rgba(255,255,255,0.04); }
html.light .nav-sub-item:hover { color: #1e1b4b; background: rgba(99,102,241,0.06); }

.main {
  margin-left: 180px;
  margin-right: 0;
  padding: 24px 32px 48px;
  transition: margin-left 0.25s cubic-bezier(.4,0,.2,1);
}
.sidebar-collapsed .main {
  margin-left: 48px;
}
.section,
:deep(.section) {
  margin-bottom: 24px;
}
.card,
:deep(.card) {
  background: #1e1f28;
  border-radius: 14px;
  padding: 22px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.15);
  transition: border-color 0.3s ease, box-shadow 0.3s ease, transform 0.3s ease;
}
.card:hover,
:deep(.card:hover) {
  border-color: rgba(255, 255, 255, 0.1);
  box-shadow: 0 6px 28px rgba(0, 0, 0, 0.25);
}
html.light .card,
html.light :deep(.card) {
  background: rgba(255, 255, 255, 0.75);
  backdrop-filter: blur(16px) saturate(1.3);
  -webkit-backdrop-filter: blur(16px) saturate(1.3);
  border-color: rgba(139, 92, 246, 0.08);
  box-shadow: 0 1px 0 rgba(255,255,255,0.8) inset, 0 4px 20px rgba(99, 102, 241, 0.05);
}
html.light .card:hover,
html.light :deep(.card:hover) {
  border-color: rgba(139, 92, 246, 0.18);
  box-shadow: 0 1px 0 rgba(255,255,255,0.8) inset, 0 8px 36px rgba(99, 102, 241, 0.08);
}
.section-title,
:deep(.section-title) {
  font-size: 1.05rem;
  margin: 0 0 4px;
  color: #f4f4f5;
  font-weight: 600;
  letter-spacing: -0.01em;
}
html.light .section-title,
html.light :deep(.section-title) { color: #1e1b4b; }
.pipeline-section {
  padding: 12px 16px !important;
}
.one-click-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.one-click-label {
  font-size: 14px;
  color: var(--el-text-color-primary);
  white-space: nowrap;
  font-weight: 600;
}
.pipeline-status {
  margin-top: 12px;
  padding: 12px;
  background: var(--el-fill-color-light);
  border-radius: 8px;
  font-size: 13px;
}
.pipeline-current-step {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  color: var(--el-text-color-primary);
  font-weight: 500;
  font-size: 13px;
}
.pipeline-step-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 44px;
  padding: 1px 7px;
  border-radius: 10px;
  background: var(--el-color-primary);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  flex-shrink: 0;
}
.pipeline-active-tasks {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
.pipeline-task-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 10px 2px 6px;
  border-radius: 12px;
  background: rgba(64, 158, 255, 0.12);
  border: 1px solid rgba(64, 158, 255, 0.3);
  color: var(--el-color-primary);
  font-size: 12px;
  white-space: nowrap;
}
.pipeline-task-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--el-color-primary);
  flex-shrink: 0;
  animation: pipeline-dot-pulse 1.2s ease-in-out infinite;
}
@keyframes pipeline-dot-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.75); }
}
.pipeline-error-log {
  margin-top: 0;
  padding: 12px;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 8px;
  font-size: 13px;
  color: #fca5a5;
  max-height: 200px;
  overflow-y: auto;
}
.pipeline-status .pipeline-error-log {
  margin-top: 8px;
}
.pipeline-error-title {
  font-weight: 600;
  margin-bottom: 8px;
}
.pipeline-error-line {
  margin-bottom: 4px;
  word-break: break-all;
}
/* 阶段间倒计时 */
.pipeline-countdown {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  margin: 10px 0 8px;
  padding: 12px 14px;
  background: rgba(103, 194, 58, 0.08);
  border: 1px solid rgba(103, 194, 58, 0.35);
  border-radius: 10px;
}
.pipeline-countdown-ring {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-width: 54px;
  height: 54px;
  border-radius: 50%;
  background: rgba(103, 194, 58, 0.15);
  border: 2px solid rgba(103, 194, 58, 0.6);
  flex-shrink: 0;
}
.pipeline-countdown-num {
  font-size: 22px;
  font-weight: 700;
  color: var(--el-color-success);
  line-height: 1;
}
.pipeline-countdown-unit {
  font-size: 11px;
  color: var(--el-color-success);
  opacity: 0.8;
}
.pipeline-countdown-body {
  flex: 1;
  min-width: 0;
}
.pipeline-countdown-msg {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--el-text-color-primary);
  line-height: 1.5;
}
.pipeline-countdown-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.pipeline-countdown-paused {
  font-size: 12px;
  color: var(--el-color-warning);
}

.image-preview-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  z-index: 9999;
  background: rgba(10, 10, 15, 0.88);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.image-preview-img {
  max-width: 90vw;
  max-height: 90vh;
  object-fit: contain;
  cursor: pointer;
  pointer-events: auto;
}

/* 左侧导航段落标签 */
.nav-segment-label {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 6px 12px 2px;
  font-size: 10px;
  font-weight: 700;
  color: #a78bfa;
  letter-spacing: 0.5px;
  text-transform: uppercase;
}
.nav-segment-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #8b5cf6;
  flex-shrink: 0;
}
</style>
