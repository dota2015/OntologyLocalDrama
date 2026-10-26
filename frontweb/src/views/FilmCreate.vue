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
      <ScriptWorkbench />

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
      <AssetWorkbench />

      <!-- 5. 分镜生成工作台 -->
      <StoryboardWorkbench />

      <DialogueDubbingPanel
        ref="dubbingPanel"
        @profile="onDubbingProfile"
        :drama-id="dramaId"
        :episode-id="currentEpisodeId"
        @updated="onDubbingUpdated"
        @merge="onMergeWithDubbing"
      />

      <!-- 7. 视频配置 + AI 模型配置 -->
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
          <!--
          <el-form-item label="配乐">
            <el-select v-model="videoMusic" placeholder="无" clearable style="width: 160px">
              <el-option label="无" value="" />
            </el-select>
          </el-form-item>
          <el-form-item label="音效">
            <el-select v-model="videoSfx" placeholder="无" clearable style="width: 160px">
              <el-option label="无" value="" />
            </el-select>
          </el-form-item>
          <el-form-item label="画质">
            <el-select v-model="videoQuality" style="width: 120px">
              <el-option label="高" value="high" />
              <el-option label="中" value="medium" />
            </el-select>
          </el-form-item>
          -->
          <el-form-item label="字幕">
            <div class="video-option-row">
              <el-switch v-model="videoSubtitle" />
              <span v-if="videoSubtitle" class="video-option-hint">开启后，合成整集时会检测解说旁白：若有文案则自动生成 SRT、按分镜时长合成旁白语音（过长加速 / 过短补静音）、与成片对齐后烧录字幕并混音。</span>
            </div>
          </el-form-item>
          <el-form-item label="对白烧录">
            <div class="video-option-row">
              <el-switch v-model="videoBurnDialogue" />
              <span v-if="videoBurnDialogue" class="video-option-hint">开启后，将把各镜对白 TTS 按分镜时长对齐并替换视频原声（有配音的镜头原声会替换；无对白及旁白的镜头保留原有音乐、音效）。可与旁白同时开启。可在上方「批量配音」中重配。</span>
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
        <p class="config-tip">文本/图片/视频使用的模型以「<el-link type="primary" underline="never" @click="showAiConfigDialog = true">AI 配置</el-link>」中设为默认的为准。</p>
      </section>

      <!-- 8. 合成视频 -->
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
import { ref, computed, onMounted, onBeforeUnmount, watch, reactive, nextTick, provide } from 'vue'
import GenerationJobs from '@/components/GenerationJobs.vue'
import { generationJobsAPI, activeGenerationJob } from '@/api/generationJobs'
import { useAgentContext } from '@/stores/agentContext'
import { useRoute, useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import { ElLoading, ElMessage, ElMessageBox, ElNotification } from 'element-plus'
import { ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Setting, Plus, Minus, Sunny, Moon, MagicStick, Upload, Delete, Check, Loading, WarningFilled, User, Box, Picture, Film, VideoCamera, Document, InfoFilled, Refresh, ZoomIn, QuestionFilled, DocumentAdd, Expand, Fold, VideoPlay, Grid, Close } from '@element-plus/icons-vue'
import { useTheme } from '@/composables/useTheme'
import { useFilmStore } from '@/stores/film'
import { useGenerationTaskStore, GEN_RESOURCE } from '@/stores/generationTaskStore'
import { syncGeneratingSetsFromStore, buildEpisodeContext, buildExtractTaskMeta, isEpisodeExtractRunning } from '@/composables/useGenerationTaskSync'
import { dramaAPI } from '@/api/drama'
import { generationAPI } from '@/api/generation'
import { aiAPI } from '@/api/ai'
import { characterAPI } from '@/api/characters'
import { propAPI } from '@/api/props'
import { sceneAPI } from '@/api/scenes'
import { taskAPI } from '@/api/task'
import { imagesAPI } from '@/api/images'
import { videosAPI } from '@/api/videos'
import { storyboardsAPI } from '@/api/storyboards'
import { ontologyAPI } from '@/api/ontology'
import { uploadAPI } from '@/api/upload'
import { generationSettingsAPI } from '@/api/prompts'
import { parseScriptIntoEpisodes, episodesListToPlainScript } from '@/utils/scriptEpisodes'
import { canUseUniversalOmniVideoApi } from '@/utils/videoOmniSupport'
import StylePickerButton from '@/components/StylePickerButton.vue'
import AIConfigContent from '@/components/AIConfigContent.vue'
import DialogueDubbingPanel from '@/components/DialogueDubbingPanel.vue'
import BackgroundMusicSettings from '@/components/BackgroundMusicSettings.vue'
import H3ShotSettings from '@/components/H3ShotSettings.vue'
import NarrativeStyleSettings from '@/components/NarrativeStyleSettings.vue'
import ShotSpeechDelivery from '@/components/ShotSpeechDelivery.vue'
import { isH3VideoModel, videoBatchConcurrency, orderedVideoShots } from '@/utils/h3VideoBatch'
import { missingStoryboardImageSlots } from '@/utils/storyboardImageBatch'
import { meaningfulSpeech, shotSpeechStatus, automaticVideoModel } from '@/utils/shotSpeech'
import SidebarActiveTasks from '@/components/filmCreate/SidebarActiveTasks.vue'
import StoryboardWorkbench from '@/components/filmCreate/StoryboardWorkbench.vue'
import ScriptWorkbench from '@/components/filmCreate/ScriptWorkbench.vue'
import AssetWorkbench from '@/components/filmCreate/AssetWorkbench.vue'
import {
  generationStyleOptions,
  getStylePromptEn,
  getStylePromptZh,
  stylePromptMetadataForSave,
  backfillDramaStylePromptMetadataIfNeeded,
  CUSTOM_STYLE_VALUE,
} from '@/constants/styleOptions'
import { useNavigation } from '@/composables/filmCreate/useNavigation'
import { runGenerateStoryFromPremise } from '@/composables/useStoryGeneration'
import { useCharacters } from '@/composables/filmCreate/useCharacters'
import { useProps as usePropsComposable } from '@/composables/filmCreate/useProps'
import { useScenes } from '@/composables/filmCreate/useScenes'
import { useFullPipeline } from '@/composables/filmCreate/useFullPipeline'

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
  if (!open) invalidateActiveVideoAiConfigCache()
})
const storyInput = ref('')
const storyStyle = ref('')
const storyType = ref('')
const storyEpisodeCount = ref(1)
const storyGenerating = ref(false)
/** 剧本工作台：create 创作 | select 选择预览 */
const scriptWorkbenchMode = ref('create')
const showSelectScriptDialog = ref(false)
const selectScriptLoading = ref(false)
const selectScriptImporting = ref(false)
const selectScriptDramas = ref([])
/** 选择剧本弹窗列表：排除当前打开的项目，避免误点「导入」到自身 */
const selectableScriptDramas = computed(() => {
  const cur = store.dramaId
  const list = selectScriptDramas.value || []
  if (cur == null) return list
  return list.filter((d) => Number(d.id) !== Number(cur))
})
const selectPreviewEpisodeId = ref('')
// P1-2: 小说导入
const showNovelImport = ref(false)
const novelImportMode = ref('text')
const novelText = ref('')
const novelFileName = ref('')
const novelFileContent = ref('')
const novelMaxChapters = ref(10)
const novelAiSummarize = ref(false)
const novelImporting = ref(false)
const scriptTitle = ref('')
const selectedEpisodeId = ref(null)
/** 保存剧本后用于恢复选中集（后端重插后 id 会变，用 episode_number 匹配） */
const savedCurrentEpisodeNumber = ref(1)
const scriptLanguage = ref('zh')
const scriptStoryboardStyle = ref('')
const scriptGenerating = ref(false)
const episodeScriptGenerating = ref(false)
const isStoryGenRunning = computed(() => {
  if (storyGenerating.value || scriptGenerating.value || episodeScriptGenerating.value) return true
  return genStore.getAllRunningTasks().some(
    (t) => Number(t.dramaId) === Number(dramaId.value) && t.resourceType === GEN_RESOURCE.GENERATE_STORY
  )
})
const generationStyle = ref('')
const characterStagesUploading=ref(false)
const narrativeStyleSaving = ref(false)
const narrativeStyle = ref({ preset: 'dialogue_fast', speech_rate: 1.25, speech_mode: 'auto' })
const customStylePrompt = ref('')
const projectAspectRatio = ref('16:9')
const shotDurationMin = ref(4)
const shotDurationMax = ref(5)
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

const scriptContent = computed({
  get: () => store.scriptContent,
  set: (v) => store.setScriptContent(v)
})
const videoResolution = storeVideoResolution
const videoMusic = ref('')
const videoSfx = ref('')
const videoQuality = ref('high')
const videoSubtitle = ref(false)
/** 合成整集时把各镜对白 TTS（audio_local_path）按分镜时长对齐并混入成片 */
const videoBurnDialogue = ref(false)
const videoWatermark = ref(false)
/** 水印开启时烧录到成片右下角 */
const videoWatermarkText = ref('')
/** 片尾 1 秒黑屏缓冲（防止社交平台播放器切断最后 1~2 秒） */
const videoTailBlack = ref(true)

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
/** 当前集合成视频的播放地址（用于按钮下方预览） */
const currentEpisodeVideoUrl = computed(() => {
  const url = currentEpisode.value?.video_url
  if (!url || !String(url).trim()) return ''
  const s = String(url).trim()
  if (s.startsWith('http://') || s.startsWith('https://')) return s
  return '/static/' + s.replace(/^\//, '')
})

const storyboardGenerating = computed(() =>
  isEpisodeExtractRunning(genStore, dramaId.value, currentEpisodeId.value, GEN_RESOURCE.GENERATE_STORYBOARD)
)
/** 分镜批量生成结束后，按镜序逐个润色全能片段（仅勾选全能模式且各镜为 universal 且有正文时） */
const universalOmniPolishRunning = ref(false)
const universalOmniPolishAbort = ref(false)
const universalOmniPolishProgress = ref({ current: 0, total: 0, label: '' })
const sbTruncatedWarning = ref(false)
const sbTruncatedDismissed = ref(false)
const videoErrorMsg = ref('')


// ── Composable: Characters ────────────────────────────
const characterVoiceEditor = ref(null)
const {
  showEditCharacter, editCharacterForm, editCharacterSaving, editCharacterPromptGenerating,
  extractingCharAppearance, extractingAnchors, addCharRefImage, addCharRefFileInput,
  aiCompletingCharacter, onAiCompleteCharacter,
  charactersGenerating, generatingCharIds, sd2CertifyingId, showCharSd2Cert, charSd2CertPayload,
  sd2VoiceUploadingId,
  showCharLibrary, charLibraryList, charLibraryLoading, charLibraryPage, charLibraryPageSize,
  charLibraryTotal, charLibraryKeyword, charLibraryTab,
  dramaAllCharList, dramaAllCharLoading, dramaAllCharPage, dramaAllCharPageSize, dramaAllCharTotal, dramaAllCharKeyword,
  showEditCharLibrary, editCharLibraryForm,
  editCharLibrarySaving, addingCharToLibraryId, addingCharToMaterialId, addingCharFromLibraryId,
  charRoleLabel, onGenerateCharacters: onGenerateCharactersRaw, openAddCharacter, stopCharacterPromptPoll, editCharacter,
  saveCharRefImageIfAny, submitEditCharacter, doGenerateCharacterPrompt, doExtractCharFromImage,
  extractIdentityAnchors, clearCharRefImage, onCloseCharDialog, onDeleteCharacter, onGenerateCharacterImage, onSd2CertifyCharacter, onSd2CertifyRefresh, sd2ActionLabel, onSd2PrimaryAction, openCharSd2CertDialog,
  onSd2VoicePrimaryAction, onSd2VoiceReplace, sd2VoiceActionLabel, playSd2Voice,
  loadCharLibraryList, debouncedLoadCharLibrary, loadDramaAllCharList, debouncedLoadDramaAllCharList,
  onCharLibraryDialogOpen, onCharLibraryTabChange, isCharAddToEpisodeLoading,
  openEditCharLibrary, submitEditCharLibrary,
  onDeleteCharLibrary, onAddCharacterToLibrary, onAddCharacterToMaterialLibrary,
  onAddCharFromLibrary, onAddDramaCharToEpisode,
} = useCharacters({ store, dramaId, currentEpisodeId, getSelectedStyle, loadDrama, pollTask, pollUntilResourceHasImage, hasAssetImage, beforeSaveCharacter: () => characterVoiceEditor.value?.save() })

// ── Composable: Props ──────────────────────────────────
const {
  showAddProp, addPropSaving, addPropForm,
  showEditProp, editPropForm, editPropSaving, editPropPromptGenerating,
  extractingPropDesc, addPropRefImage, addPropRefFileInput,
  aiCompletingProp, onAiCompleteProp,
  addPropAddRefImage, addPropAddRefFileInput, extractingPropAddDesc,
  propsExtracting, generatingPropIds,
  showPropLibrary, propLibraryList, propLibraryLoading, propLibraryPage, propLibraryPageSize,
  propLibraryTotal, propLibraryKeyword, propLibraryTab,
  dramaAllPropList, dramaAllPropLoading, dramaAllPropPage, dramaAllPropPageSize, dramaAllPropTotal, dramaAllPropKeyword,
  showEditPropLibrary, editPropLibraryForm,
  editPropLibrarySaving, addingPropToLibraryId, addingPropToMaterialId, addingPropFromLibraryId,
  onExtractProps: onExtractPropsRaw, stopPropPromptPoll, editProp, doGeneratePropPrompt, savePropRefImageIfAny,
  clearPropRefImage, doExtractPropFromImage, submitEditProp, submitAddProp,
  onClosePropDialog, onDeleteProp, onGeneratePropImage,
  loadPropLibraryList, debouncedLoadPropLibrary, loadDramaAllPropList, debouncedLoadDramaAllPropList,
  onPropLibraryDialogOpen, onPropLibraryTabChange, isPropAddToEpisodeLoading,
  openEditPropLibrary, submitEditPropLibrary,
  onDeletePropLibrary, onAddPropToLibrary, onAddPropToMaterialLibrary,
  onAddPropFromLibrary, onAddDramaPropToEpisode,
  doExtractFromRef2,
} = usePropsComposable({ store, dramaId, currentEpisodeId, getSelectedStyle, loadDrama, pollTask, pollUntilResourceHasImage, hasAssetImage })

// ── Composable: Scenes ─────────────────────────────────
const {
  showEditScene, editSceneForm, editSceneSaving, editScenePromptGenerating,
  extractingSceneDesc, addSceneRefImage, addSceneRefFileInput,
  aiCompletingScene, onAiCompleteScene,
  scenesExtracting, generatingSceneIds,
  // 场景多视角额外 state（由 FilmCreate 管理）
  showSceneLibrary, sceneLibraryList, sceneLibraryLoading, sceneLibraryPage, sceneLibraryPageSize,
  sceneLibraryTotal, sceneLibraryKeyword, sceneLibraryTab,
  dramaAllSceneList, dramaAllSceneLoading, dramaAllScenePage, dramaAllScenePageSize, dramaAllSceneTotal, dramaAllSceneKeyword,
  showEditSceneLibrary, editSceneLibraryForm,
  editSceneLibrarySaving, addingSceneToLibraryId, addingSceneToMaterialId, addingSceneFromLibraryId,
  onExtractScenes: onExtractScenesRaw, openAddScene, stopScenePromptPoll, editScene, doGenerateScenePrompt, doGenerateSceneSinglePrompt,
  saveSceneRefImageIfAny, clearSceneRefImage, doExtractSceneFromImage, submitEditScene,
  onCloseSceneDialog, onDeleteScene, onGenerateSceneImage,
  loadSceneLibraryList, debouncedLoadSceneLibrary, loadDramaAllSceneList, debouncedLoadDramaAllSceneList,
  onSceneLibraryDialogOpen, onSceneLibraryTabChange, isSceneAddToEpisodeLoading,
  openEditSceneLibrary, submitEditSceneLibrary,
  onDeleteSceneLibrary, onAddSceneToLibrary, onAddSceneToMaterialLibrary,
  onAddSceneFromLibrary, onAddDramaSceneToEpisode,
} = useScenes({ store, dramaId, currentEpisodeId, getSelectedStyle, scriptLanguage, loadDrama, pollTask, pollUntilResourceHasImage, hasAssetImage, dramaAPI })

async function onGenerateCharacters() {
  trackFilmCreateAction('generate_characters_click')
  const beforeCount = (store.currentEpisode?.characters || []).length
  try {
    await onGenerateCharactersRaw()
    const afterCount = (store.currentEpisode?.characters || []).length
    trackFilmCreateAction('generate_characters_complete', {
      extra: { before_count: beforeCount, after_count: afterCount },
    })
  } catch (e) {
    trackFilmCreateAction('generate_characters_failed', {
      extra: { message: String(e?.message || 'failed').slice(0, 120) },
    })
    throw e
  }
}

async function onExtractProps() {
  trackFilmCreateAction('extract_props_click')
  const beforeCount = (store.props || []).length
  try {
    await onExtractPropsRaw()
    const afterCount = (store.props || []).length
    trackFilmCreateAction('extract_props_complete', {
      extra: { before_count: beforeCount, after_count: afterCount },
    })
  } catch (e) {
    trackFilmCreateAction('extract_props_failed', {
      extra: { message: String(e?.message || 'failed').slice(0, 120) },
    })
    throw e
  }
}

async function onExtractScenes() {
  trackFilmCreateAction('extract_scenes_click')
  const beforeCount = (store.currentEpisode?.scenes || []).length
  try {
    await onExtractScenesRaw()
    const afterCount = (store.currentEpisode?.scenes || []).length
    trackFilmCreateAction('extract_scenes_complete', {
      extra: { before_count: beforeCount, after_count: afterCount },
    })
  } catch (e) {
    trackFilmCreateAction('extract_scenes_failed', {
      extra: { message: String(e?.message || 'failed').slice(0, 120) },
    })
    throw e
  }
}



// 批量参考图与参考模式运行状态（供 ScriptWorkbench 与 AssetWorkbench 共享）
const referenceBatchRunning = ref(false)
const referenceSuggestionsRunning = ref(false)
const savingReferenceModeIds = reactive(new Set())
function onReferenceModeSaving(kind, id, saving) {
  const key = `${kind}:${id}`
  if (saving) savingReferenceModeIds.add(key)
  else savingReferenceModeIds.delete(key)
}

// 分镜行内编辑状态（按 storyboard id 存储）
// navCollapsed/storyboardMenuExpanded/toggleNav → 已移至 useNavigation composable

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
  const charGen = charactersGenerating.value || generatingCharIds.size > 0
    || epRunning.some((t) => t.resourceType === GEN_RESOURCE.CHAR_IMAGE || t.resourceType === GEN_RESOURCE.EXTRACT_CHARACTERS)
  const charStatus = charGen ? 'generating' : charDone ? 'done' : charList.length > 0 ? 'partial' : 'pending'

  // 道具
  const propList = props.value || []
  const propDone = propList.length > 0 && propList.every(p => hasAssetImage(p))
  const propGen = propsExtracting.value || generatingPropIds.size > 0
    || epRunning.some((t) => t.resourceType === GEN_RESOURCE.PROP_IMAGE || t.resourceType === GEN_RESOURCE.EXTRACT_PROPS)
  const propStatus = propGen ? 'generating' : propDone ? 'done' : propList.length > 0 ? 'partial' : 'pending'

  // 场景
  const sceneList = scenes.value || []
  const sceneDone = sceneList.length > 0 && sceneList.every(s => hasAssetImage(s))
  const sceneGen = scenesExtracting.value || generatingSceneIds.size > 0
    || epRunning.some((t) => t.resourceType === GEN_RESOURCE.SCENE_IMAGE || t.resourceType === GEN_RESOURCE.EXTRACT_SCENES)
  const sceneStatus = sceneGen ? 'generating' : sceneDone ? 'done' : sceneList.length > 0 ? 'partial' : 'pending'

  // 分镜脚本
  const sbList = storyboards.value || []
  const sbScriptDone = sbList.length > 0
  const sbScriptGen = storyboardGenerating.value || universalOmniPolishRunning.value || serverGenerationJobs.value.some(j=>Number(j.episode_id)===Number(currentEpisodeId.value) && j.kind==='storyboards' && activeGenerationJob(j))
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
    addItem({
      id: `gen:${t.key || t.taskId || t.label}`,
      label: t.label || '任务进行中...',
      kind: 'genStore',
      task: t,
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
        const isWaiting = imgJob.status === 'queued'
        if (isSingleShot) {
          const sbId = opt.storyboard_ids[0]
          const sb = (storyboards.value || []).find(s => Number(s.id) === Number(sbId))
          const sbNum = sb ? (sb.storyboard_number || sb.shot_number || '') : ''
          const numStr = sbNum ? ('#' + sbNum + ' ') : ''
          const slots = opt.slots || []
          let slotText = '分镜图'
          if (slots.includes('first') && slots.includes('last')) slotText = '首尾帧'
          else if (slots.includes('first')) slotText = '首帧'
          else if (slots.includes('last')) slotText = '尾帧'
          const imgJobTime = imgJob.created_at ? new Date(imgJob.created_at).getTime() : 0
          addItem({
            id: `job:${imgJob.id}`,
            label: `分镜 ${numStr}${slotText}${isWaiting ? ' (排队中)' : '生成中...'}`,
            kind: 'serverImageJob',
            job: imgJob,
            storyboardId: sbId,
            isWaiting,
            createdAt: imgJobTime,
          })
        } else {
          const imgJobTime = imgJob.created_at ? new Date(imgJob.created_at).getTime() : 0
          addItem({
            id: `job:${imgJob.id}`,
            label: `${storyboardUseFirstLastFrame.value ? '批量生成首尾帧' : '批量生成分镜图'}${isWaiting ? ' (排队中)' : '...'}`,
            kind: 'serverImageJob',
            job: imgJob,
            isWaiting,
            createdAt: imgJobTime,
          })
        }
      }
    } else {
      addItem({ id: 'batch-image', label: '批量生成分镜图...', kind: 'batchImage', isWaiting: false })
    }
  }
  if (batchVideoRunning.value) {
    const batchItems = serverVideoBatch.value?.items
    if (Array.isArray(batchItems) && batchItems.length > 0) {
      const activeShots = batchItems.filter((i) => i.status === 'running' || i.status === 'pending')
      if (activeShots.length > 0) {
        for (const shot of activeShots) {
          const isWaiting = shot.status === 'pending'
          const numStr = shot.storyboard_number != null ? `#${shot.storyboard_number}` : (shot.storyboard_id ? `#${shot.storyboard_id}` : '')
          const shotTime = shot.created_at ? new Date(shot.created_at).getTime() : 0
          addItem({
            id: `batch-video-shot-${shot.id || shot.storyboard_id}`,
            label: `分镜 ${numStr} 视频${isWaiting ? '排队中' : '生成中...'}`,
            kind: 'batchVideo',
            shot,
            storyboardId: shot.storyboard_id,
            storyboardNumber: shot.storyboard_number,
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
      const p = batchVideoProgress.value
      const suffix = p?.total ? ` ${p.current}/${p.total}` : ''
      addItem({ id: 'batch-video', label: `批量生成分镜视频${suffix}...`, kind: 'batchVideo', isWaiting: false })
    }
  }
  return items.sort((a, b) => {
    if (a.isWaiting !== b.isWaiting) {
      return a.isWaiting ? 1 : -1
    }
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
      const job=serverGenerationJobs.value.find(j=>j.kind==='omni_polish' && Number(j.episode_id)===Number(currentEpisodeId.value) && activeGenerationJob(j))
      if(job) await generationJobsAPI.control(dramaId.value,job.id,'stop')
      await generationJobsPanel.value?.refresh(); return
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
  scrollToAnchor(anchorId)
  const el = document.getElementById(anchorId)
  if (el) {
    el.classList.add('sb-highlight-pulse')
    setTimeout(() => {
      el.classList.remove('sb-highlight-pulse')
    }, 2500)
  }
}
const sbCharacterIds = ref({})  // sbId -> number[] 多选角色
const sbPropIds = ref({})       // sbId -> number[] 多选物品
const sbSceneId = ref({})
const sbDialogue = ref({})
const sbNarration = ref({})
const sbBgmPrompt = ref({})   // 背景音乐/配乐描述（无对白镜头专供 H3 等模型生成）
const sbShotType = ref({})
/** 视频提示词组成（可编辑），key 为分镜 id */
const sbTitle = ref({})
const sbLocation = ref({})
const sbTime = ref({})
const sbDuration = ref({})
const sbAction = ref({})
const sbResult = ref({})
const sbAtmosphere = ref({})
const sbAngle = ref({})
const sbAngleH = ref({})   // 结构化视角：水平方向
const sbAngleV = ref({})   // 结构化视角：俯仰角度
const sbAngleS = ref({})   // 结构化视角：景别
const sbMovement = ref({})
const sbLighting = ref({})   // 灯光风格
const sbDof = ref({})        // 景深
const sbLayoutDescription = ref({})  // 空间布局与人物站位描述（生成分镜时 AI 输出的最高优先级合同，用于首尾帧强制一致）
const regeneratingLayoutSbIds = reactive(new Set())  // 正在 AI 重新生成布局描述的分镜 id 集合
/** 分镜创作模式：classic | universal（默认 classic，存库 storyboards.creation_mode） */
const sbCreationMode = ref({})
/** 全能模式片段描述（存库 universal_segment_text，与经典参考图字段独立） */
const sbUniversalSegmentText = ref({})
// 分镜图片/视频列表（由 /images?storyboard_id=xx 和 /videos?storyboard_id=xx 拉取）
const sbImages = ref({})
const sbVideos = ref({})
const sbVideoErrors = ref({})
const generatingSbImageIds = reactive(new Set())
const generatingSbVideoIds = reactive(new Set())
const generatingUniversalSegmentIds = reactive(new Set())
// 批量生成分镜图
const batchImageRunning = ref(false)
const batchImageStopping = ref(false)
const batchImageProgress = ref({ current: 0, total: 0, failed: 0 })
const inferringParams = ref(false)
const auditingInvariants = ref(false)
const directorGenerating = ref(false)
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
// 批量生成分镜视频
const batchVideoRunning = ref(false)
const batchVideoStopping = ref(false)
const batchVideoProgress = ref({ current: 0, total: 0, failed: 0 })
const batchVideoErrors = ref([])
const serverVideoBatch = ref(null)
const batchVideoSubmitting = ref(false)
// P0-1: 连贯帧模式
const videoFrameContiguity = ref(false)
// P0-3: 分镜超分辨率 loading set
const upscalingSbIds = reactive(new Set())
// P2-4: TTS 状态
const ttsSbIds = reactive(new Set())
const ttsSbNarrationIds = reactive(new Set())
// 尾帧衔接 loading 状态
const linkingTailFrameIds = reactive(new Set())
// 首帧衔接 loading 状态
const linkingFirstFrameIds = reactive(new Set())
// “上镜尾帧”（将上一分镜尾帧图片直接设为当前首帧）loading 状态
const usingPrevTailAsFirstIds = reactive(new Set())
/** 对白 TTS 路径缓存（与 storyboards.audio_local_path 一致） */
const sbDialogueAudioPaths = ref({})
/** 解说旁白 TTS 路径缓存（与 storyboards.narration_audio_local_path 一致） */
const sbNarrationAudioPaths = ref({})

// 公共库弹窗状态已移至各 composable
const storyboardCount = ref(null) // 分镜数量
const videoDuration = ref(null) // 视频总长度
/** 分镜生成时是否要求 AI 输出 narration（解说旁白） */
const storyboardIncludeNarration = ref(false)
/** 分镜生成是否使用全能模式（universal_segment_text，对接 Seedance / 可灵 Omni） */
const storyboardUniversalOmni = ref(false)
const storyboardUseFirstLastFrame = ref(false)
const exportingStoryboardSheet = ref(false)
/** 生成尾帧时是否注入首帧作站位/构图参考（默认开启） */
const lastFrameUseFirstLayoutLock = ref(true)
const gridMode = ref('single') // 序列图模式：single / quad_grid / nine_grid

// ── 剧本长度 → 估算总时长；自动分镜数与项目「每段秒数」(videoClipDuration) 对齐 ──

/** 用于估算的每段时长（秒），与一键成片处「X秒/段」一致 */
function clipSecondsForStoryboardEstimate() {
  const c = (Number(shotDurationMin.value) + Number(shotDurationMax.value)) / 2
  return Math.max(2, Math.min(60, Number.isFinite(c) && c > 0 ? c : 5))
}

/** 由估算总时长与每段秒数得镜数中枢与宽松参考区间（±1 镜） */
function shotCountEstimateFromDurationSec(sec) {
  const s = Math.max(10, Math.min(600, Math.round(Number(sec) || 0)))
  const clip = clipSecondsForStoryboardEstimate()
  const ideal = s / clip
  const locked = Math.max(1, Math.min(200, Math.round(ideal)))
  const minR = Math.max(1, locked - 1)
  const maxR = Math.min(200, locked + 1)
  const range = minR >= maxR ? { min: locked, max: locked } : { min: minR, max: maxR }
  return { locked, range, clip }
}

/** 由剧本字符数粗估成片总时长（短剧偏长镜）：秒数 = round(10 + (字数/600)×60)，夹在 10–600s */
function estimateVideoDurationSecFromCharLen(charLen) {
  const len = Math.max(0, Math.floor(Number(charLen) || 0))
  if (len < 1) return null
  const raw = Math.round(10 + (len / 600) * 60)
  return Math.min(600, Math.max(10, raw))
}

/** 当前剧本下的估算：总秒数、镜数中枢、镜数区间、采用的每段秒数 */
const scriptStoryboardEstimate = computed(() => {
  const script = (scriptContent.value || '').toString().trim()
  const len = script.length
  if (!len) return null
  const sec = estimateVideoDurationSecFromCharLen(len)
  if (sec == null) return null
  const { locked, range, clip } = shotCountEstimateFromDurationSec(sec)
  return { sec, locked, range, clip, len }
})

const scriptEstimateVideoDurationHint = computed(() => {
  const e = scriptStoryboardEstimate.value
  if (!e) return ''
  return `（约 ${e.sec}s）`
})

const scriptEstimateVideoDurationTitle = computed(() => {
  const e = scriptStoryboardEstimate.value
  if (!e) return ''
  return `按当前剧本文本约 ${e.len} 个字符（含标点；常见汉字在浏览器里一字一算，并非按 UTF-8 字节翻倍）、短剧公式 round(10+(字符/600)×60) 粗估总时长约 ${e.sec} 秒；未填输入框时该值会作为约束传给生成接口。仅供参考`
})

const scriptEstimateStoryboardHint = computed(() => {
  const e = scriptStoryboardEstimate.value
  if (!e) return ''
  if (e.range && e.range.min !== e.range.max) {
    return `（约 ${e.locked} 镜，参考 ${e.range.min}–${e.range.max}）`
  }
  return `（约 ${e.locked} 镜）`
})

const scriptEstimateStoryboardTitle = computed(() => {
  const e = scriptStoryboardEstimate.value
  if (!e) return ''
  return `按估算时长 ${e.sec}s ÷ 时长范围中值 ${e.clip} 秒四舍五入粗估约 ${e.locked} 镜；旁注区间为 ±1 镜供参考。调整单镜时长范围会同步改变本估算；实际每镜由 AI 分配。`
})

function scriptTextTrimmedForEstimate() {
  return (scriptContent.value || '').toString().trim()
}

function userFilledStoryboardCount() {
  const v = storyboardCount.value
  return v != null && Number.isFinite(Number(v)) && Number(v) >= 1
}

function userFilledVideoDuration() {
  const v = videoDuration.value
  return v != null && Number.isFinite(Number(v)) && Number(v) >= 10
}

/** 请求后端的视频总时长：仅未手动填时传剧本估算 */
function getVideoDurationForApi() {
  if (userFilledVideoDuration()) return Math.round(Number(videoDuration.value))
  const len = scriptTextTrimmedForEstimate().length
  if (len < 1) return undefined
  return estimateVideoDurationSecFromCharLen(len) ?? undefined
}

/** 请求后端的分镜数量：仅未手动填时按「估算总时长 ÷ 每段秒数」推算，与项目 X秒/段 一致 */
function getStoryboardCountForApi() {
  if (userFilledStoryboardCount()) return Math.round(Number(storyboardCount.value))
  const sec = getVideoDurationForApi()
  if (sec == null || !Number.isFinite(sec)) return undefined
  return shotCountEstimateFromDurationSec(sec).locked
}



const baseUrl = ref('')
const previewImageUrl = ref(null)
function imageUrl(url) {
  if (!url) return ''
  if (url.startsWith('http')) return url
  const base = (baseUrl.value || '').replace(/\/$/, '')
  return base ? base + '/' + url.replace(/^\//, '') : url
}
/** 优先使用本地地址，避免远程图失效。item 为 { image_url, local_path } 或字符串 url */
function assetImageUrl(item) {
  if (!item) return ''
  if (typeof item === 'string') return imageUrl(item)
  const localPath = item.local_path && String(item.local_path).trim()
  if (localPath) {
    const p = localPath.replace(/^\//, '')
    return '/static/' + p
  }
  if (item.image_url) return imageUrl(item.image_url)
  return ''
}
function hasAssetImage(item) {
  if (!item) return false
  return !!(item.image_url || item.local_path)
}
function getSelectedStyle() {
  return getSelectedStylePrompt()
}
function openImagePreview(url) {
  previewImageUrl.value = url
}
function closeImagePreview() {
  previewImageUrl.value = null
}
/** 视频地址：优先 local_path（/static/），否则 video_url */
function assetVideoUrl(item) {
  if (!item) return ''
  const localPath = item.local_path && String(item.local_path).trim()
  if (localPath) return '/static/' + localPath.replace(/^\//, '')
  if (item.video_url) return imageUrl(item.video_url)
  return ''
}
/** 远程视频须为 http(s)，避免上游 FAILURE 时把错误文案写入 video_url */
function isHttpVideoUrl(url) {
  if (!url || typeof url !== 'string') return false
  const t = url.trim()
  return t.startsWith('http://') || t.startsWith('https://')
}
/** 列表项是否具备可播放地址（避免仅有空白 local_path 时外层有卡片、内层无 <video>） */
function recordHasPlayableVideoUrl(i) {
  if (!i) return false
  const lp = i.local_path && String(i.local_path).trim()
  if (lp) return true
  return isHttpVideoUrl(i.video_url)
}
/** 主播放器强制随记录/地址重建，避免重新生成后 <video> 仍缓存旧 src */
function sbMainVideoPlayerKey(sbId) {
  const v = getSbVideo(sbId)
  if (!v) return ''
  const src = assetVideoUrl(v)
  return `${v.id}:${v.updated_at || ''}:${src.slice(0, 160)}`
}
function onStoryboardUseFirstLastFrameChange() {
  if (storyboardUseFirstLastFrame.value && gridMode.value !== 'single') {
    gridMode.value = 'single'
    ElMessage.info('首尾帧模式已开启，序列图已切换为单张')
  }
  saveProjectSettings(false)
}

function uploadingSbImageSlot(sbId) {
  return sbImageUploadSlotById.value[sbId] || null
}

function frameTypeForSlot(slot) {
  return slot === 'last' ? 'storyboard_last' : 'storyboard_first'
}

function resolveSbImageById(storyboardId, imageId) {
  if (imageId == null) return null
  const images = getSbAllImages(storyboardId)
  return images.find((i) => i.id === imageId) || null
}

/** 首帧图（首尾帧模式下严格优先服务器绑定的 first_frame_image_id） */
function getSbFirstImage(storyboardId) {
  const images = getSbAllImages(storyboardId)
  const sb = (store.storyboards || []).find((b) => b.id === storyboardId)

  // 最高权威：服务器已绑定的首帧
  if (sb?.first_frame_image_id != null) {
    const bound = resolveSbImageById(storyboardId, sb.first_frame_image_id)
    if (bound) return bound
  }

  const sel = sbSelectedImgId.value[storyboardId]
  if (sel != null) {
    const found = images.find((i) => i.id === sel)
    if (found) return found
  }

  const typed = images.find((i) => i.frame_type === 'storyboard_first')
  if (typed) return typed
  // 不再回退到 images[0]，避免把尾帧图片误显示为首帧
  return null
}

/** 尾帧图（首尾帧模式下严格优先服务器绑定的 last_frame_image_id） */
function getSbLastImage(storyboardId) {
  const images = getSbAllImages(storyboardId)
  const sb = (store.storyboards || []).find((b) => b.id === storyboardId)

  // 最高权威：服务器已绑定的尾帧（后端 bindStoryboardFrameImage 正确写入的 last_frame_image_id）
  if (sb?.last_frame_image_id != null) {
    const bound = resolveSbImageById(storyboardId, sb.last_frame_image_id)
    if (bound) return bound
  }

  // 仅在没有服务器绑定时才考虑手动选择（首尾帧生成后我们会主动清除手动选择）
  const sel = sbSelectedLastImgId.value[storyboardId]
  if (sel != null) {
    const found = images.find((i) => i.id === sel)
    if (found) return found
  }

  const typed = images.find((i) => i.frame_type === 'storyboard_last')
  if (typed) return typed

  if (sb?.last_frame_image_url || sb?.last_frame_local_path) {
    return {
      id: sb.last_frame_image_id,
      image_url: sb.last_frame_image_url,
      local_path: sb.last_frame_local_path,
      frame_type: 'storyboard_last',
    }
  }
  return null
}

/** 该分镜是否有图（接口拉取的或 composed_image） */
function hasSbImage(sb) {
  if (storyboardUseFirstLastFrame.value && !isSbUniversalMode(sb.id)) {
    return !!(getSbFirstImage(sb.id) || (sb && (sb.composed_image || sb.image_url)))
  }
  return !!(getSbImage(sb.id) || (sb && (sb.composed_image || sb.image_url)))
}

function hasSbFirstLastPair(sb) {
  return !!(getSbFirstImage(sb.id) && getSbLastImage(sb.id))
}

function missingSbImageSlots(sb, useFirstLast = storyboardUseFirstLastFrame.value && !isSbUniversalMode(sb.id)) {
  return missingStoryboardImageSlots({
    useFirstLast,
    hasFirst: !!(getSbFirstImage(sb.id) || sb.composed_image || sb.image_url),
    hasLast: !!getSbLastImage(sb.id),
    hasImage: hasSbImage(sb),
  })
}
/** 取该分镜下所有已完成的非四宫格图片列表 */
function getSbAllImages(storyboardId) {
  const list = sbImages.value[storyboardId]
  if (!Array.isArray(list)) return []
  return list.filter((i) => i.status === 'completed' && i.frame_type !== 'quad_grid' && i.frame_type !== 'nine_grid' && (i.image_url || i.local_path))
}
/** 取当前主图（首尾帧模式下等同首帧） */
function getSbImage(storyboardId) {
  if (storyboardUseFirstLastFrame.value) return getSbFirstImage(storyboardId)
  const images = getSbAllImages(storyboardId)
  if (!images.length) return null
  const selectedId = sbSelectedImgId.value[storyboardId]
  if (selectedId != null) {
    const found = images.find((i) => i.id === selectedId)
    if (found) return found
  }
  return images[0]
}
/** 取该分镜下的四宫格整图记录 */
/** 取该分镜下的四宫格整图记录 */
function getQuadGridImage(storyboardId) {
  const list = sbImages.value[storyboardId]
  if (!Array.isArray(list)) return null
  return list.find((i) => i.status === 'completed' && (i.frame_type === 'quad_grid' || i.frame_type === 'nine_grid') && (i.image_url || i.local_path)) || null
}
/** 取该分镜所有已完成的视频记录 */
function getSbAllVideos(storyboardId) {
  const list = sbVideos.value[storyboardId]
  if (!Array.isArray(list)) return []
  return list.filter((i) => i.status === 'completed' && recordHasPlayableVideoUrl(i))
}
/** 取该分镜当前选中的视频（尊重 sbSelectedVideoId，否则回退到 sb.selected_video_id / sb.video_url，最后默认第一条） */
function getSbVideo(storyboardId) {
  const all = getSbAllVideos(storyboardId)
  if (all.length === 0) return null
  const selectedId = sbSelectedVideoId.value[storyboardId]
  if (selectedId != null) {
    const found = all.find((v) => v.id === selectedId)
    if (found) return found
  }
  const boards = store.storyboards || []
  const sb = boards.find((b) => b.id === storyboardId)
  if (sb?.selected_video_id != null) {
    const found = all.find((v) => v.id === sb.selected_video_id)
    if (found) return found
  }
  if (sb?.video_url) {
    const found = all.find((v) => v.video_url === sb.video_url || v.local_path === sb.video_url)
    if (found) return found
  }
  return all[0]
}
/** 取下一个分镜（按 storyboard_number 顺序） */
function getNextStoryboard(storyboardId) {
  const list = store.storyboards || []
  const idx = list.findIndex((s) => s.id === storyboardId)
  if (idx === -1 || idx === list.length - 1) return null
  return list[idx + 1]
}

/** 取上一个分镜（按 storyboard_number 顺序，用于“上镜尾帧”快速衔接） */
function getPrevStoryboard(storyboardId) {
  const list = store.storyboards || []
  const idx = list.findIndex((s) => s.id === storyboardId)
  if (idx === -1 || idx === 0) return null
  return list[idx - 1]
}

/** 辅助判断：当前分镜是否有“上一镜尾帧”可用于快速替换首帧 */
function canUsePrevTailAsFirst(sb) {
  const p = getPrevStoryboard(sb?.id)
  return !!(p && getSbLastImage(p.id))
}

/** 视频历史条：按时间顺序从左往右展示全部已完成视频，点击切换当前视频且不改变排列顺序 */
function getVideoStripItems(storyboardId) {
  const all = getSbAllVideos(storyboardId)
  if (!all.length) return []
  const current = getSbVideo(storyboardId)
  // 严格按创建时间从早到晚排序（从左往右展示，时间先后顺序固定）
  const sorted = [...all].sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0))
  return sorted.map((v, idx) => {
    const isActive = !!(current && v.id === current.id)
    return {
      key: `vid-${v.id}`,
      video: v,
      src: assetVideoUrl(v),
      isActive,
      label: isActive ? `版${idx + 1}(当前)` : `第${idx + 1}版`,
    }
  })
}
/** 选中某条历史视频为当前视频，并持久化到分镜记录供合成视频使用 */
function onSelectSbMainVideo(sb, video) {
  const vUrl = video.video_url || ''
  sbSelectedVideoId.value = { ...sbSelectedVideoId.value, [sb.id]: video.id }
  const row = (store.storyboards || []).find((b) => b.id === sb.id)
  if (row) {
    row.selected_video_id = video.id
    row.video_url = vUrl
  }
  storyboardsAPI.update(sb.id, {
    selected_video_id: video.id,
    video_url: vUrl || null,
  }).catch(e => console.warn('[主视频] 保存后端失败', e))
}
/** 取该分镜最近一次视频生成的错误信息（从 API 返回的记录或本地即时错误） */
function getSbVideoError(storyboardId) {
  if (sbVideoErrors.value[storyboardId]) return sbVideoErrors.value[storyboardId]
  const list = sbVideos.value[storyboardId]
  if (!Array.isArray(list) || list.length === 0) return ''
  // 最新任务若在处理中或已可播，不应显示过往失败错误
  if (list[0] && (list[0].status === 'processing' || (list[0].status === 'completed' && recordHasPlayableVideoUrl(list[0])))) return ''
  const hasCompleted = list.some((i) => i.status === 'completed' && recordHasPlayableVideoUrl(i))
  if (hasCompleted) return ''
  const bogusCompleted = list.find(
    (i) => i.status === 'completed' && i.video_url && !recordHasPlayableVideoUrl(i)
  )
  if (bogusCompleted) {
    const u = String(bogusCompleted.video_url || '').trim()
    if (u) return u
    if (bogusCompleted.error_msg) return bogusCompleted.error_msg
  }
  const failed = list.filter((i) => i.status === 'failed' && i.error_msg)
  if (failed.length === 0) return ''
  return failed[0].error_msg
}

/** 可「继续查询」的失败记录：有上游 task 且后端标记 can_resume_poll */
function getSbResumableFailedVideo(storyboardId) {
  const list = sbVideos.value[storyboardId]
  if (!Array.isArray(list) || list.length === 0) return null
  return list.find((i) => i.status === 'failed' && i.can_resume_poll) || null
}

async function loadStoryboardMedia() {
  const boards = store.storyboards || []
  if (boards.length === 0) {
    sbImages.value = {}
    sbVideos.value = {}
    return
  }
  const nextImages = { ...sbImages.value }
  const nextVideos = { ...sbVideos.value }
  await Promise.all(
    boards.map(async (sb) => {
      try {
        const [imgRes, vidRes] = await Promise.all([
          imagesAPI.list({ storyboard_id: sb.id, page: 1, page_size: 100 }),
          videosAPI.list({ storyboard_id: sb.id, page: 1, page_size: 50 })
        ])
        nextImages[sb.id] = (imgRes && imgRes.items) ? imgRes.items : []
        nextVideos[sb.id] = (vidRes && vidRes.items) ? vidRes.items : []
      } catch (_) {
        nextImages[sb.id] = []
        nextVideos[sb.id] = []
      }
    })
  )
  sbImages.value = nextImages
  sbVideos.value = nextVideos
  // 从后端恢复主图选择
  restoreSelectionsFromBackend()
}

function getGeneratingSetsBag() {
  return {
    generatingCharIds,
    generatingPropIds,
    generatingSceneIds,
    generatingSbImageIds,
    generatingSbFirstImageIds,
    generatingSbLastImageIds,
    generatingSbVideoIds,
  }
}

function buildSbGenMeta(sb, resourceType, labelPrefix) {
  const num = sb?.storyboard_number ?? sb?.id
  const epNum = store.currentEpisode?.episode_number
  const dramaTitle = store.drama?.title || ''
  const epLabel = dramaTitle ? `${dramaTitle} · 第${epNum ?? ''}集` : `第${epNum ?? ''}集`
  return {
    dramaId: dramaId.value,
    episodeId: currentEpisodeId.value,
    dramaTitle,
    episodeNumber: epNum,
    resourceType,
    resourceId: sb.id,
    label: `${epLabel} ${labelPrefix} #${num}`,
  }
}

/** 分镜视频是否正在生成（单条点击、批量、一键成片、任务恢复均覆盖） */
function isSbVideoGenerating(sbId) {
  if (serverVideoBatch.value?.items?.some(i => Number(i.storyboard_id) === Number(sbId) && ['pending', 'running'].includes(i.status))) return true
  if (generatingSbVideoIds.has(sbId)) return true
  const list = sbVideos.value[sbId]
  if (Array.isArray(list) && list.some((i) => i.status === 'processing')) {
    const hasCompleted = list.some((i) => i.status === 'completed' && recordHasPlayableVideoUrl(i))
    if (!hasCompleted) return true
  }
  if (sbId == null || dramaId.value == null || currentEpisodeId.value == null) return false
  return genStore.isRunning({
    dramaId: dramaId.value,
    episodeId: currentEpisodeId.value,
    resourceType: GEN_RESOURCE.SB_VIDEO,
    resourceId: sbId,
  })
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
        videoErrorMsg.value = err || '视频生成失败'
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

/** 只刷新单条分镜的图片/视频，避免每次单图操作都全量请求所有分镜 */
async function loadSingleStoryboardMedia(sbId) {
  if (!sbId) return
  try {
    const [imgRes, vidRes] = await Promise.all([
      imagesAPI.list({ storyboard_id: sbId, page: 1, page_size: 100 }),
      videosAPI.list({ storyboard_id: sbId, page: 1, page_size: 50 })
    ])
    sbImages.value = {
      ...sbImages.value,
      [sbId]: (imgRes && imgRes.items) ? imgRes.items : []
    }
    sbVideos.value = {
      ...sbVideos.value,
      [sbId]: (vidRes && vidRes.items) ? vidRes.items : []
    }
    restoreSelectionsFromBackend()
  } catch (_) {
    // 静默忽略，不影响其他分镜的显示
  }
}

// ── 主图选择 ─────────────────────────────────────────────────────────

const sbSelectedImgId = ref({})   // sbId → 选中的首帧/主图 image_generation.id
const sbSelectedLastImgId = ref({}) // sbId → 选中的尾帧 image_generation.id
const sbSelectedVideoId = ref({}) // sbId → 选中的 video_generation.id
const generatingSbFirstImageIds = reactive(new Set())
const generatingSbLastImageIds = reactive(new Set())
/** sbId → 'first' | 'last'，上传目标槽位 */
const sbImageUploadSlotById = ref({})

/**
 * 从后端 storyboard.image_url / local_path 恢复主图选择状态。
 * 与 image_generation 记录比对，找到匹配的记录并恢复 sbSelectedImgId。
 */
function restoreSelectionsFromBackend() {
  const boards = store.storyboards || []
  for (const sb of boards) {
    const images = getSbAllImages(sb.id)
    if (sbSelectedImgId.value[sb.id] == null) {
      if (sb.first_frame_image_id != null) {
        sbSelectedImgId.value = { ...sbSelectedImgId.value, [sb.id]: sb.first_frame_image_id }
      } else {
        const sbPath = (sb.local_path || '').trim()
        const sbUrl = (sb.image_url || '').trim()
        if (sbPath || sbUrl) {
          const matched = images.find(
            (img) =>
              (sbPath && img.local_path && img.local_path === sbPath) ||
              (sbUrl && img.image_url && img.image_url === sbUrl)
          )
          if (matched) {
            sbSelectedImgId.value = { ...sbSelectedImgId.value, [sb.id]: matched.id }
          }
        }
      }
    }
    if (sbSelectedLastImgId.value[sb.id] == null && sb.last_frame_image_id != null) {
      sbSelectedLastImgId.value = { ...sbSelectedLastImgId.value, [sb.id]: sb.last_frame_image_id }
    }
    if (sbSelectedVideoId.value[sb.id] == null) {
      const vids = getSbAllVideos(sb.id)
      if (sb.selected_video_id != null) {
        const found = vids.find((v) => v.id === sb.selected_video_id)
        if (found) {
          sbSelectedVideoId.value = { ...sbSelectedVideoId.value, [sb.id]: sb.selected_video_id }
        }
      } else if (sb.video_url) {
        const matched = vids.find(
          (v) => (v.video_url && v.video_url === sb.video_url) || (v.local_path && v.local_path === sb.video_url)
        )
        if (matched) {
          sbSelectedVideoId.value = { ...sbSelectedVideoId.value, [sb.id]: matched.id }
        }
      }
    }
  }
}





function syncStoryboardStateFromEpisode(ep) {
  const boards = ep?.storyboards || []
  const nextCharIds = {}
  const nextPropIds = {}
  const nextScene = {}
  const nextDialogue = {}
  const nextNarration = {}
  const nextBgmPrompt = {}
  const nextShot = {}
  const nextTitle = {}
  const nextLocation = {}
  const nextTime = {}
  const nextDuration = {}
  const nextAction = {}
  const nextResult = {}
  const nextAtmosphere = {}
  const nextAngle = {}
  const nextAngleH = {}
  const nextAngleV = {}
  const nextAngleS = {}
  const nextMovement = {}
  const nextLighting = {}
  const nextDof = {}
  const nextLayoutDescription = {}
  const nextCreationMode = {}
  const nextUniversalSegment = {}
  for (const sb of boards) {
    nextScene[sb.id] = sb.scene_id ?? null
    nextDialogue[sb.id] = sb.dialogue ?? ''
    nextNarration[sb.id] = sb.narration ?? ''
    nextBgmPrompt[sb.id] = (sb.bgm_prompt ?? '').toString()
    nextShot[sb.id] = (sb.shot_type ?? '').toString() || ''
    nextTitle[sb.id] = (sb.title ?? '').toString()
    nextLocation[sb.id] = (sb.location ?? '').toString()
    nextTime[sb.id] = (sb.time ?? '').toString()
    nextDuration[sb.id] = sb.duration != null ? Number(sb.duration) : 5
    nextAction[sb.id] = (sb.action ?? '').toString()
    nextResult[sb.id] = (sb.result ?? '').toString()
    nextAtmosphere[sb.id] = (sb.atmosphere ?? '').toString()
    nextAngle[sb.id] = (sb.angle ?? '').toString()
    nextAngleH[sb.id] = sb.angle_h || ''
    nextAngleV[sb.id] = sb.angle_v || ''
    nextAngleS[sb.id] = sb.angle_s || ''
    nextMovement[sb.id] = (sb.movement ?? '').toString()
    nextLighting[sb.id] = sb.lighting_style || ''
    nextDof[sb.id] = sb.depth_of_field || ''
    nextLayoutDescription[sb.id] = (sb.layout_description ?? '').toString()
    const charList = Array.isArray(sb.characters) ? sb.characters : (sb.characters != null ? [sb.characters] : [])
    nextCharIds[sb.id] = charList.map((c) => (typeof c === 'object' && c != null ? Number(c.id) : Number(c))).filter((n) => Number.isFinite(n))
    nextPropIds[sb.id] = Array.isArray(sb.prop_ids) ? sb.prop_ids : []
    nextCreationMode[sb.id] = sb.creation_mode === 'universal' ? 'universal' : 'classic'
    nextUniversalSegment[sb.id] = (sb.universal_segment_text ?? '').toString()
  }
  sbCharacterIds.value = nextCharIds
  sbPropIds.value = nextPropIds
  sbSceneId.value = nextScene
  sbDialogue.value = nextDialogue
  sbNarration.value = nextNarration
  sbBgmPrompt.value = nextBgmPrompt
  sbShotType.value = nextShot
  sbTitle.value = nextTitle
  sbLocation.value = nextLocation
  sbTime.value = nextTime
  sbDuration.value = nextDuration
  sbAction.value = nextAction
  sbResult.value = nextResult
  sbAtmosphere.value = nextAtmosphere
  sbAngle.value = nextAngle
  sbAngleH.value = nextAngleH
  sbAngleV.value = nextAngleV
  sbAngleS.value = nextAngleS
  sbMovement.value = nextMovement
  sbLighting.value = nextLighting
  sbDof.value = nextDof
  sbLayoutDescription.value = nextLayoutDescription
  sbCreationMode.value = nextCreationMode
  sbUniversalSegmentText.value = nextUniversalSegment
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
    // 恢复「故事生成」框的梗概（项目 description 存的是故事梗概）
    storyInput.value = (d.description || '').toString().trim()
    storyStyle.value = (d.metadata && d.metadata.story_style) ? d.metadata.story_style : ''
    storyType.value = d.genre || ''
    generationStyle.value = d.style || ''
    narrativeStyle.value = d.metadata?.narrative_style ? { ...d.metadata.narrative_style } : { preset: 'balanced', speech_rate: d.metadata?.tts_dubbing?.speed || 1 }
    if ((d.style || '') === CUSTOM_STYLE_VALUE) {
      customStylePrompt.value = (d.metadata?.style_prompt_zh || d.metadata?.style_prompt_en || '').toString()
    } else {
      customStylePrompt.value = ''
    }
    projectAspectRatio.value = (d.metadata && d.metadata.aspect_ratio) ? d.metadata.aspect_ratio : '16:9'
    videoClipDuration.value = (d.metadata && d.metadata.video_clip_duration) ? Number(d.metadata.video_clip_duration) : 5
    const savedRange = d.metadata?.shot_duration_range
    shotDurationMin.value = Math.max(4, Math.min(15, Number(savedRange?.min) || 4))
    shotDurationMax.value = Math.max(shotDurationMin.value, Math.min(15, Number(savedRange?.max) || videoClipDuration.value || 5))
    videoClipDuration.value = Math.round((shotDurationMin.value + shotDurationMax.value) / 2)
    storyboardIncludeNarration.value = !!(d.metadata && d.metadata.storyboard_include_narration)
    storyboardUniversalOmni.value = !!(d.metadata && d.metadata.storyboard_universal_omni)
    storyboardUseFirstLastFrame.value = !!(d.metadata && d.metadata.storyboard_use_first_last_frame)
    lastFrameUseFirstLayoutLock.value = d.metadata?.last_frame_use_first_layout_lock !== false
    if (storyboardUseFirstLastFrame.value && gridMode.value !== 'single') {
      gridMode.value = 'single'
    }
    const list = d.episodes || []
    // 优先保持当前选中的集（按 id 在最新列表中查找），避免 AI 生成角色等操作后误切到其他集
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

const EMPTY_ARR = []
/** 当前分镜已选角色 id 列表（供 el-select 绑定） */
function getSbCharacterIds(sbId) {
  const arr = sbCharacterIds.value[sbId]
  return Array.isArray(arr) && arr.length > 0 ? arr : EMPTY_ARR
}

/** 运镜值的简短中文标签（用于分镜控制栏显示） */
function getMovementLabel(m) {
  if (!m) return ''
  const map = {
    static: '固定',
    push: '推镜',
    pull: '拉镜',
    pan: '横摇',
    tilt: '纵摇',
    tracking: '跟镜',
    crane_up: '升镜',
    crane_dn: '降镜',
    orbit: '环绕',
    handheld: '手持',
    zoom: '变焦',
    roll: '旋转',
    whip_pan: '甩镜',
    spiral: '螺旋',
    hitchcock_zoom: '希区柯克',
    bullet_time: '子弹时间',
    dutch_angle_move: '荷兰角',
    dolly_track: '推轨',
    slowmo_orbit: '升格环绕'
  }
  return map[m] || m
}

function setSbCharacterIds(sbId, v) {
  const next = Array.isArray(v) ? v : []
  sbCharacterIds.value = { ...sbCharacterIds.value, [sbId]: next }
  onStoryboardCharacterChange(sbId)
}

/** 当前分镜尚未勾选的角色（供缩略图旁「+」下拉添加） */
function charactersAvailableToAddToSb(sbId) {
  const all = characters.value ?? []
  const cur = new Set((getSbCharacterIds(sbId) || []).map((x) => Number(x)))
  return all.filter((c) => c && !cur.has(Number(c.id)))
}

function onSbAddCharacterCommand(sbId, charId) {
  const id = Number(charId)
  if (!Number.isFinite(id)) return
  const cur = [...(getSbCharacterIds(sbId) || [])]
  if (cur.some((x) => Number(x) === id)) return
  cur.push(id)
  setSbCharacterIds(sbId, cur)
}

/** 当前分镜已选物品 id 列表 */
function getSbPropIds(sbId) {
  const arr = sbPropIds.value[sbId]
  return Array.isArray(arr) && arr.length > 0 ? arr : EMPTY_ARR
}

function setSbPropIds(sbId, v) {
  sbPropIds.value = { ...sbPropIds.value, [sbId]: Array.isArray(v) ? v : [] }
  onStoryboardPropChange(sbId)
}

function onStoryboardPropChange(sbId) {
  const ids = sbPropIds.value[sbId] || []
  storyboardsAPI.update(sbId, { prop_ids: ids }).catch(() => {})
}

/** 当前分镜选中的场景对象（用于下方缩略图） */
function getSbSelectedScene(sbId) {
  const sceneId = sbSceneId.value[sbId]
  if (sceneId == null) return null
  const list = scenes.value ?? []
  return list.find((s) => Number(s.id) === Number(sceneId)) || null
}

/** 当前分镜选中的角色对象列表（用于下方缩略图） */
function getSbSelectedCharacters(sbId) {
  const ids = getSbCharacterIds(sbId)
  if (!ids.length) return []
  const list = characters.value ?? []
  return ids.map((id) => list.find((c) => Number(c.id) === Number(id))).filter(Boolean)
}

/** 当前分镜选中的物品对象列表（用于下方缩略图） */
function getSbSelectedProps(sbId) {
  const ids = getSbPropIds(sbId)
  if (!ids.length) return []
  const list = props.value ?? []
  return ids.map((id) => list.find((p) => Number(p.id) === Number(id))).filter(Boolean)
}

async function onStoryboardCharacterChange(sbId) {
  const ids = sbCharacterIds.value[sbId] || []
  try {
    await storyboardsAPI.update(sbId, { character_ids: ids })
    // 首/尾帧提示词保留（含用户手动保存版）；图生时后端会按当前勾选做 sanitize
  } catch (e) {
    console.warn('[分镜] 保存角色失败', e)
  }
}

function onLastFrameLayoutLockChange() {
  saveProjectSettings()
}

function onStoryboardSceneChange(sbId) {
  const sceneId = sbSceneId.value[sbId] ?? null
  storyboardsAPI.update(sbId, { scene_id: sceneId }).catch(() => {})
}

function updateStoryboardDialogue(sbId) {
  // 可在此防抖后调用后端更新 dialogue
}

/** 将当前剧本内容保存到后端（创建/更新项目与集数），供「保存剧本」与「AI 生成」后自动保存共用 */
async function saveScriptToBackend(content) {
  const trimmed = (content ?? '').toString().trim()
  if (!trimmed) return
  const parsed = parseScriptIntoEpisodes(trimmed)
  const multiFromMarkers = parsed.split && parsed.episodes.length >= 2
  const toPayload = (list) =>
    list.map((e, i) => ({
      episode_number: i + 1,
      title: (e.title && String(e.title).trim()) || '第' + (i + 1) + '集',
      script_content: e.script_content ?? '',
      description: null,
      duration: 0,
    }))

  let dramaId = store.dramaId
  const curEp = store.currentEpisode
  if (!dramaId) {
    const drama = await dramaAPI.create({
      title: scriptTitle.value || '新故事',
      description: storyInput.value?.trim() || trimmed.slice(0, 200),
      genre: storyType.value || undefined,
      style: generationStyle.value || undefined,
      metadata: {
        ...projectStylePromptMetadata(),
        story_style: storyStyle.value || undefined,
        narrative_style: { ...narrativeStyle.value },
        aspect_ratio: projectAspectRatio.value || '16:9',
      },
    })
    store.setDrama(drama)
    dramaId = drama.id
    savedCurrentEpisodeNumber.value = 1
    const first = parsed.episodes[0] || { title: '', script_content: trimmed }
    const episodes = multiFromMarkers
      ? toPayload(parsed.episodes)
      : [
          {
            episode_number: 1,
            title: scriptTitle.value || first.title || '第1集',
            script_content: first.script_content || trimmed,
          },
        ]
    await dramaAPI.saveEpisodes(dramaId, episodes)
    await loadDrama()
    if (route.params.id === 'new') {
      router.replace('/film/' + dramaId)
    }
    if (multiFromMarkers) {
      ElMessage.success(`已按「第N集/章/节」拆分为 ${episodes.length} 集`)
    }
    return { created: true }
  }
  if (multiFromMarkers && !curEp?.id) {
    savedCurrentEpisodeNumber.value = 1
    const payload = toPayload(parsed.episodes)
    await dramaAPI.saveEpisodes(dramaId, payload)
    if (storyInput.value?.trim()) {
      await dramaAPI.saveOutline(dramaId, {
        summary: storyInput.value.trim(),
        genre: storyType.value || undefined,
        style: generationStyle.value || undefined,
        metadata: {
          ...projectStylePromptMetadata(),
          story_style: storyStyle.value || undefined,
        narrative_style: { ...narrativeStyle.value },
          aspect_ratio: projectAspectRatio.value || '16:9',
        },
      }).catch(() => {})
    }
    await loadDrama()
    ElMessage.success(`已按「第N集/章/节」拆分为 ${payload.length} 集`)
    return { created: false, splitEpisodes: true }
  }
  savedCurrentEpisodeNumber.value = curEp?.episode_number ?? 1
  const first = parsed.episodes[0]
  const singleTitle = first?.title && String(first.title).trim()
  const singleBody = parsed.episodes.length === 1 && singleTitle ? first.script_content : trimmed
  if (curEp?.id) {
    await dramaAPI.saveEpisodeScript(curEp.id, {
      title: scriptTitle.value || singleTitle || '第' + curEp.episode_number + '集',
      script_content: singleBody,
    })
  } else {
    await dramaAPI.saveEpisodes(dramaId, [{ episode_number: 1, title: scriptTitle.value || '第1集', script_content: trimmed }])
  }
  if (storyInput.value?.trim()) {
    await dramaAPI.saveOutline(dramaId, {
      summary: storyInput.value.trim(),
      genre: storyType.value || undefined,
      style: generationStyle.value || undefined,
      metadata: {
        ...projectStylePromptMetadata(),
        story_style: storyStyle.value || undefined,
        narrative_style: { ...narrativeStyle.value },
        aspect_ratio: projectAspectRatio.value || '16:9',
      },
    }).catch(() => {})
  }
  await loadDrama()
  return { created: false }
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

function onNarrativeStyleSaved(settings) {
  narrativeStyle.value = { ...settings }
  if (store.drama) store.drama.metadata = { ...store.drama.metadata, narrative_style: { ...settings }, tts_dubbing: { ...store.drama.metadata?.tts_dubbing, speed: settings.speech_rate } }
  if (dubbingVoiceProfile.value) dubbingVoiceProfile.value = { ...dubbingVoiceProfile.value, speed: settings.speech_rate }
}
function onDubbingProfile(profile) {
  dubbingVoiceProfile.value = profile
  if (profile?.speed && store.drama?.metadata?.narrative_style) onNarrativeStyleSaved({ ...narrativeStyle.value, speech_rate: profile.speed, speech_mode: profile.speed !== narrativeStyle.value.speech_rate ? 'fixed' : narrativeStyle.value.speech_mode })
}

async function onGenerateStory() {
  trackFilmCreateAction('generate_script_click')
  await runGenerateStoryFromPremise({
    premise: storyInput.value,
    narrativeStyle: { ...narrativeStyle.value },
    storyStyle: storyStyle.value,
    storyType: storyType.value,
    storyEpisodeCount: storyEpisodeCount.value,
    scriptTitle: scriptTitle.value,
    generationStyle: generationStyle.value,
    customStylePrompt: customStylePrompt.value,
    projectAspectRatio: projectAspectRatio.value,
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
    onComplete: ({ episodeCount }) => {
      trackFilmCreateAction('generate_script_complete', {
        extra: { episode_count: episodeCount },
      })
    },
  })
}

function openSelectScriptDialog() {
  showSelectScriptDialog.value = true
}

async function loadSelectScriptList() {
  selectScriptLoading.value = true
  try {
    const res = await dramaAPI.list({ page: 1, page_size: 100 })
    const items = res?.items ?? []
    selectScriptDramas.value = items.filter((d) => d?.metadata?.script_template === true)
  } catch {
    selectScriptDramas.value = []
  } finally {
    selectScriptLoading.value = false
  }
}

/**
 * 将源剧本的梗概 + 各集剧本写入当前工程（不跳转、不导入角色/分镜/视频）。
 * 在「新建故事」且尚未落库时，会创建新项目并跳转。
 */
async function onPickScriptFromDialog(sourceId) {
  if (!sourceId || selectScriptImporting.value) return
  const srcNum = Number(sourceId)
  const routeId = route.params.id
  const targetFromRoute = routeId && routeId !== 'new' ? Number(routeId) : null
  const targetId = store.dramaId ?? targetFromRoute ?? null

  if (targetId != null && Number(targetId) === srcNum) {
    ElMessage.info('当前打开的就是该项目')
    return
  }

  if (targetId != null) {
    try {
      await ElMessageBox.confirm(
        '将把所选剧本的「故事梗概」与「各集剧本正文」写入当前工程。不会导入角色、场景、分镜与视频。若源剧本集数更少，多出来的分集将从本工程移除（原分镜可能失效）。是否继续？',
        '导入剧本到当前工程',
        { type: 'warning', confirmButtonText: '导入', cancelButtonText: '取消' }
      )
    } catch {
      return
    }
  }

  selectScriptImporting.value = true
  try {
    const src = await dramaAPI.get(srcNum)
    const rawEps = [...(src.episodes || [])].sort(
      (a, b) => (Number(a.episode_number) || 0) - (Number(b.episode_number) || 0)
    )
    const summary = (src.description || '').toString().trim()
    const episodesPayload = rawEps.map((ep, i) => ({
      episode_number: ep.episode_number != null ? Number(ep.episode_number) : i + 1,
      title: (ep.title || '').toString(),
      script_content: ep.script_content ?? '',
      description: ep.description ?? null,
      duration: ep.duration ?? 0,
    }))

    if (!targetId) {
      if (episodesPayload.length === 0 && !summary) {
        ElMessage.warning('所选剧本没有可导入的梗概或分集正文')
        return
      }
      const title = (src.title || '新故事').toString().trim() || '新故事'
      const created = await dramaAPI.create({
        title,
        description: summary || undefined,
        metadata: {},
      })
      const workId = created.id
      store.setDrama({ id: workId })
      if (episodesPayload.length > 0) {
        await dramaAPI.saveEpisodes(workId, episodesPayload)
      }
      if (summary) {
        await dramaAPI.saveOutline(workId, { summary }).catch(() => {})
      }
      showSelectScriptDialog.value = false
      router.replace('/film/' + workId)
      ElMessage.success('已根据所选剧本创建项目并导入梗概与正文')
      scriptWorkbenchMode.value = 'select'
      return
    }

    if (summary) {
      await dramaAPI.saveOutline(targetId, { summary }).catch(() => {})
    }
    if (episodesPayload.length > 0) {
      await dramaAPI.saveEpisodes(targetId, episodesPayload)
    } else if (!summary) {
      ElMessage.warning('所选剧本没有可导入的梗概或分集正文')
      return
    }

    showSelectScriptDialog.value = false
    await loadDrama()
    ElMessage.success('已导入故事梗概与剧本（当前工程未切换）')
    scriptWorkbenchMode.value = 'select'
  } catch (e) {
    ElMessage.error(e.message || '导入失败')
  } finally {
    selectScriptImporting.value = false
  }
}

watch(
  () => [store.drama?.episodes, selectedEpisodeId.value],
  () => {
    const eps = store.drama?.episodes || []
    if (eps.length > 1) {
      const cur = selectedEpisodeId.value
      const hit = cur != null && eps.some((e) => Number(e.id) === Number(cur))
      selectPreviewEpisodeId.value = hit ? String(cur) : String(eps[0].id)
    } else {
      selectPreviewEpisodeId.value = ''
    }
  },
  { deep: true, immediate: true }
)

function novelImportReset() {
  novelText.value = ''
  novelFileName.value = ''
  novelFileContent.value = ''
}

function onNovelFileChange(file) {
  novelFileName.value = file.name
  const reader = new FileReader()
  reader.onload = (ev) => { novelFileContent.value = ev.target.result }
  reader.readAsText(file.raw || file, 'utf-8')
}

async function onImportNovel() {
  const text = novelImportMode.value === 'file' ? novelFileContent.value : novelText.value
  if (!text?.trim()) {
    ElMessage.warning('请输入或上传小说内容')
    return
  }
  novelImporting.value = true
  try {
    const formData = new FormData()
    if (novelImportMode.value === 'file' && novelFileContent.value) {
      const blob = new Blob([novelFileContent.value], { type: 'text/plain' })
      formData.append('file', blob, novelFileName.value || 'novel.txt')
    } else {
      formData.append('text', text)
    }
    formData.append('title', scriptTitle.value || '导入小说')
    formData.append('max_chapters', String(novelMaxChapters.value))
    formData.append('ai_summarize', String(novelAiSummarize.value))
    const { default: axios } = await import('axios')
    const baseURL = (await import('@/utils/request')).default.defaults.baseURL || '/api/v1'
    const res = await axios.post(`${baseURL}/dramas/import-novel`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    })
    let chapters = res.data?.data?.chapters || res.data?.chapters || []
    if (!chapters.length) {
      ElMessage.warning('未能识别到章节内容')
      return
    }
    // 若后端只识别出 1 章，但正文里有多处「第N集」行首标题，用前端规则再拆（与保存剧本一致）
    const clientParsed = parseScriptIntoEpisodes(text)
    if (clientParsed.split && clientParsed.episodes.length > chapters.length) {
      chapters = clientParsed.episodes.map((e, i) => ({
        index: i + 1,
        title: e.title,
        content: e.script_content,
        script: e.script_content,
      }))
    }
    const toEpisodeRow = (ch, i) => ({
      episode_number: i + 1,
      title: (ch.title && String(ch.title).trim()) || '第' + (i + 1) + '集',
      script_content: String(ch.script ?? ch.content ?? '').trimEnd(),
      description: null,
      duration: 0,
    })
    const rows = chapters.map(toEpisodeRow)
    const plainScript = episodesListToPlainScript(
      rows.map((r) => ({ title: r.title, script_content: r.script_content }))
    )
    if (store.dramaId && rows.length >= 2) {
      await dramaAPI.saveEpisodes(store.dramaId, rows)
      await loadDrama()
      ElMessage.success(`已导入并拆分为 ${rows.length} 集`)
    } else {
      store.setScriptContent(plainScript || rows[0]?.script_content || '')
      ElMessage.success(
        rows.length >= 2
          ? `已导入 ${rows.length} 个章节（保存剧本时将写入多集）`
          : `成功导入 ${rows.length} 个章节，请继续编辑剧本`
      )
    }
    showNovelImport.value = false
    novelImportReset()
  } catch (e) {
    ElMessage.error(e.message || '导入失败')
  } finally {
    novelImporting.value = false
  }
}

async function onRegenerateEpisodeScript() {
  const episodeId = currentEpisodeId.value
  if (!episodeId || episodeScriptGenerating.value) return
  const projectId = dramaId.value
  const originalContent = scriptContent.value
  const originalTitle = scriptTitle.value
  episodeScriptGenerating.value = true
  try {
    const draft = await dramaAPI.generateEpisodeScript(episodeId, { premise: storyInput.value })
    if (Number(currentEpisodeId.value) !== Number(episodeId) || Number(dramaId.value) !== Number(projectId)
        || scriptContent.value !== originalContent || scriptTitle.value !== originalTitle) {
      ElMessage.info('当前集或编辑内容已变化，未替换编辑框；需要时请重新生成。')
      return
    }
    scriptContent.value = draft.script_content
    scriptTitle.value = draft.title
    ElMessage.success(`第${draft.episode_number}集草稿已生成，请检查后点击「保存当前集」。已有分镜需另行重新生成。`)
  } catch (e) {
    ElMessage.error(e.message || '当前集剧本生成失败，原剧本已保留')
  } finally {
    episodeScriptGenerating.value = false
  }
}

async function onGenerateScript() {
  trackFilmCreateAction('save_script_click')
  const content = (scriptContent.value ?? store.scriptContent ?? '').toString().trim()
  if (!content) {
    ElMessage.warning('请先在「故事生成」中点击 AI 生成，或手动输入剧本内容')
    return
  }
  scriptGenerating.value = true
  try {
    const result = await saveScriptToBackend(content)
    if (result?.created) {
      ElMessage.success('项目已创建，剧本已保存')
    } else {
      ElMessage.success('剧本已保存')
    }
    trackFilmCreateAction('save_script_complete', {
      extra: { created_project: !!result?.created },
    })
  } catch (e) {
    ElMessage.error(e.message || '保存失败')
  } finally {
    scriptGenerating.value = false
  }
}

async function onAddEpisode() {
  if (!store.dramaId) return
  const list = store.drama?.episodes || []
  const nextNum = list.length > 0
    ? Math.max(...list.map((e) => Number(e.episode_number) || 0), 0) + 1
    : 1
  const updated = list.map((ep, i) => ({
    episode_number: ep.episode_number ?? i + 1,
    title: ep.title || '第' + (ep.episode_number ?? i + 1) + '集',
    script_content: ep.script_content || '',
    description: ep.description,
    duration: ep.duration
  }))
  updated.push({
    episode_number: nextNum,
    title: '第' + nextNum + '集',
    script_content: '',
    description: null,
    duration: 0
  })
  try {
    await dramaAPI.saveEpisodes(store.dramaId, updated)
    savedCurrentEpisodeNumber.value = nextNum
    await loadDrama()
    ElMessage.success('已添加第' + nextNum + '集')
  } catch (e) {
    ElMessage.error(e.message || '添加失败')
  }
}





async function onDirectorFullPipeline() {
  if (!dramaId.value) return
  const premise = (storyInput.value || store.drama?.description || store.drama?.summary || '').trim()
  if (!premise) {
    ElMessage.warning('请先在上方输入故事梗概，导演智能体将以此为原点创编全套剧作与视听资产！')
    return
  }

  try {
    await ElMessageBox.confirm(
      `将启动【全生命周期导演智能体（Full-Lifecycle Director Agent）】执行全流程闭环：\n\n1. 【剧作阶段】依据故事梗概规划并创作 ${storyEpisodeCount.value || 3} 集剧本正文；\n2. 【世界观本体】自动抽取核心角色（外貌锚点）、道具（真实物理尺度与时代校验）、场地场景（空间地标）；\n3. 【视听导演调度】编排全集高流动感运镜（固定镜头<15%），并为无对白镜头配齐原生 BGM 提示词（供 H3）；\n4. 【SHACL门禁自检】门禁规则审查，自省纠错直到 100% 合格入库。\n\n是否立即启动导演智能体全流程创作？`,
      '启动导演智能体全生命周期推演',
      {
        confirmButtonText: '立即启动全流程推演',
        cancelButtonText: '取消',
        type: 'warning',
        distinguishCancelAndClose: true,
      }
    )
  } catch {
    return
  }

  directorGenerating.value = true
  try {
    const res = await ontologyAPI.directorFullPipeline(dramaId.value, {
      premise,
      episode_count: storyEpisodeCount.value || 3,
      style: storyStyle.value || 'modern',
      genre: storyType.value || 'drama',
    })
    const taskData = res?.data ?? res
    const taskId = taskData?.task_id
    if (!taskId) throw new Error(taskData?.message || '未能创建全流程导演智能体任务')

    ElMessage.info('🎬 全流程导演智能体推演已在后台启动，正在规划剧本、抽取本体资产并编排动态分镜...')
    pollDirectorFullPipelineTask(taskId)
  } catch (e) {
    ElMessage.error(e.message || '全流程导演智能体启动失败')
    directorGenerating.value = false
  }
}

async function pollDirectorFullPipelineTask(taskId) {
  const maxAttempts = 180
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 2500))
    try {
      const tr = await taskAPI.get(taskId)
      const task = tr?.data ?? tr
      if (!task) continue

      if (task.status === 'completed') {
        directorGenerating.value = false
        await loadDrama()
        const result = task.result || {}
        ElNotification({
          title: '🎬 全生命周期导演推演完成',
          message: result.summary || `全流程闭环推演完成！剧本、角色、道具尺度、场景及全集 ${result.total_shots || 0} 个高质量运镜分镜已全部就绪。`,
          type: 'success',
          duration: 10000,
        })
        return
      }

      if (task.status === 'failed') {
        directorGenerating.value = false
        ElMessage.error(task.error || '全流程导演智能体推演失败')
        return
      }
    } catch (err) {
      // transient poll error, continue
    }
  }
  directorGenerating.value = false
  ElMessage.warning('全流程导演智能体推演任务仍在后台执行，请稍后刷新查看。')
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

const dubbingPanel = ref(null)
const backgroundMusicPanel = ref(null)
const dubbingVoiceProfile = ref({})
const speechSummaries = ref({})

function rememberSpeechSummary(shot) {
  speechSummaries.value[shot.id || shot.storyboard_id] = {
    dialogue: shot.segments.some(s => s.kind === 'dialogue'),
    narration: shot.segments.some(s => s.kind === 'narration') || meaningfulSpeech(shot.narration),
    pending: !!shot.extraction_pending,
    sourceDialogue: shot.dialogue || '', sourceNarration: shot.narration || '', sourceUniversal: shot.universal_segment_text || '',
  }
}

watch(dramaId, () => { speechSummaries.value = {} }, { immediate: true })

function onDubbingUpdated(shots) {
  const paths = {}
  for (const shot of shots || []) {
    rememberSpeechSummary(shot)
    if (shot.audio_local_path) paths[shot.id] = shot.audio_local_path
    if (shot.narration_audio_local_path) sbNarrationAudioPaths.value[shot.id] = shot.narration_audio_local_path
  }
  sbDialogueAudioPaths.value = { ...sbDialogueAudioPaths.value, ...paths }
  for (const sb of storyboards.value) {
    if (paths[sb.id]) sb.audio_local_path = paths[sb.id]
  }
}

function onMergeWithDubbing(options) {
  videoBurnDialogue.value = !!options.dialogue
  videoSubtitle.value = !!options.narration
  onGenerateVideo()
}

function getFinalizeMergeOptions() {
  return {
    burn_narration_subtitles: !!videoSubtitle.value,
    burn_dialogue_audio: !!videoBurnDialogue.value,
    watermark_text: videoWatermark.value ? String(videoWatermarkText.value || '').trim().slice(0, 200) : '',
    tail_black_seconds: videoTailBlack.value ? 1.0 : 0,
  }
}

async function onGenerateVideo() {
  if (!currentEpisodeId.value) return
  try { await backgroundMusicPanel.value?.flush() }
  catch (e) { ElMessage.error(e.message); return }
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

/** 无 task_id 时轮询刷新直到资源出现图片或超时（用于角色/道具/场景图生成） */
async function pollUntilResourceHasImage(checker, maxAttempts = 20, intervalMs = 3000) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, intervalMs))
    await loadDrama()
    if (checker()) return
  }
}

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
    narrativeStyle.value = { preset: 'dialogue_fast', speech_rate: 1.25, speech_mode: 'auto' }
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
  // 剧本工作台状态与方法
  scriptWorkbenchMode,
  storyInput,
  storyStyle,
  storyType,
  storyEpisodeCount,
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
  onGenerateStory,
  selectedEpisodeId,
  episodeScriptGenerating,
  onEpisodeSelect,
  scriptTitle,
  onAddEpisode,
  scriptContent,
  scriptGenerating,
  currentEpisodeId,
  onGenerateScript,
  onRegenerateEpisodeScript,
  openSelectScriptDialog,
  selectPreviewEpisodeId,
  showSelectScriptDialog,
  loadSelectScriptList,
  selectScriptLoading,
  selectScriptImporting,
  selectableScriptDramas,
  selectScriptDramas,
  onPickScriptFromDialog,
  saveProjectSettings,
  showNovelImport,
  novelImportReset,
  novelImportMode,
  novelText,
  onNovelFileChange,
  novelFileName,
  novelMaxChapters,
  novelAiSummarize,
  novelImporting,
  onImportNovel,
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
  dubbingPanel,
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
  characterStagesUploading,

  // 角色状态与方法
  characterVoiceEditor,
  charactersGenerating,
  generatingCharIds,
  sd2CertifyingId,
  showCharSd2Cert,
  charSd2CertPayload,
  sd2VoiceUploadingId,
  showCharLibrary,
  charLibraryList,
  charLibraryLoading,
  charLibraryPage,
  charLibraryPageSize,
  charLibraryTotal,
  charLibraryKeyword,
  charLibraryTab,
  dramaAllCharList,
  dramaAllCharLoading,
  dramaAllCharPage,
  dramaAllCharPageSize,
  dramaAllCharTotal,
  dramaAllCharKeyword,
  showEditCharLibrary,
  editCharLibraryForm,
  editCharLibrarySaving,
  addingCharToLibraryId,
  addingCharToMaterialId,
  charRoleLabel,
  onGenerateCharacters,
  openAddCharacter,
  editCharacter,
  showEditCharacter,
  editCharacterForm,
  editCharacterSaving,
  editCharacterPromptGenerating,
  extractingCharAppearance,
  extractingAnchors,
  addCharRefImage,
  addCharRefFileInput,
  aiCompletingCharacter,
  onAiCompleteCharacter,
  doGenerateCharacterPrompt,
  doExtractCharFromImage,
  extractIdentityAnchors,
  clearCharRefImage,
  onCloseCharDialog,
  onDeleteCharacter,
  onGenerateCharacterImage,
  sd2ActionLabel,
  onSd2PrimaryAction,
  onSd2VoicePrimaryAction,
  onSd2VoiceReplace,
  sd2VoiceActionLabel,
  playSd2Voice,
  loadCharLibraryList,
  debouncedLoadCharLibrary,
  loadDramaAllCharList,
  debouncedLoadDramaAllCharList,
  onCharLibraryDialogOpen,
  onCharLibraryTabChange,
  isCharAddToEpisodeLoading,
  openEditCharLibrary,
  submitEditCharLibrary,
  onDeleteCharLibrary,
  onAddCharacterToLibrary,
  onAddCharacterToMaterialLibrary,
  onAddCharFromLibrary,
  onAddDramaCharToEpisode,
  submitEditCharacter,

  // 道具状态与方法
  showAddProp,
  addPropSaving,
  addPropForm,
  showEditProp,
  editPropForm,
  editPropSaving,
  editPropPromptGenerating,
  extractingPropDesc,
  addPropRefImage,
  addPropRefFileInput,
  aiCompletingProp,
  onAiCompleteProp,
  addPropAddRefImage,
  addPropAddRefFileInput,
  extractingPropAddDesc,
  propsExtracting,
  generatingPropIds,
  showPropLibrary,
  propLibraryList,
  propLibraryLoading,
  propLibraryPage,
  propLibraryPageSize,
  propLibraryTotal,
  propLibraryKeyword,
  propLibraryTab,
  dramaAllPropList,
  dramaAllPropLoading,
  dramaAllPropPage,
  dramaAllPropPageSize,
  dramaAllPropTotal,
  dramaAllPropKeyword,
  showEditPropLibrary,
  editPropLibraryForm,
  editPropLibrarySaving,
  addingPropToLibraryId,
  addingPropToMaterialId,
  onExtractProps,
  editProp,
  doGeneratePropPrompt,
  clearPropRefImage,
  doExtractPropFromImage,
  submitEditProp,
  submitAddProp,
  onClosePropDialog,
  onDeleteProp,
  onGeneratePropImage,
  loadPropLibraryList,
  debouncedLoadPropLibrary,
  loadDramaAllPropList,
  debouncedLoadDramaAllPropList,
  onPropLibraryDialogOpen,
  onPropLibraryTabChange,
  isPropAddToEpisodeLoading,
  openEditPropLibrary,
  submitEditPropLibrary,
  onDeletePropLibrary,
  onAddPropToLibrary,
  onAddPropToMaterialLibrary,
  onAddPropFromLibrary,
  onAddDramaPropToEpisode,
  doExtractFromRef2,

  // 场景状态与方法
  showEditScene,
  editSceneForm,
  editSceneSaving,
  editScenePromptGenerating,
  extractingSceneDesc,
  addSceneRefImage,
  addSceneRefFileInput,
  aiCompletingScene,
  onAiCompleteScene,
  scenesExtracting,
  generatingSceneIds,
  showSceneLibrary,
  sceneLibraryList,
  sceneLibraryLoading,
  sceneLibraryPage,
  sceneLibraryPageSize,
  sceneLibraryTotal,
  sceneLibraryKeyword,
  sceneLibraryTab,
  dramaAllSceneList,
  dramaAllSceneLoading,
  dramaAllScenePage,
  dramaAllScenePageSize,
  dramaAllSceneTotal,
  dramaAllSceneKeyword,
  showEditSceneLibrary,
  editSceneLibraryForm,
  editSceneLibrarySaving,
  addingSceneToLibraryId,
  addingSceneToMaterialId,
  onExtractScenes,
  openAddScene,
  editScene,
  doGenerateScenePrompt,
  doGenerateSceneSinglePrompt,
  clearSceneRefImage,
  doExtractSceneFromImage,
  submitEditScene,
  onCloseSceneDialog,
  onDeleteScene,
  onGenerateSceneImage,
  loadSceneLibraryList,
  debouncedLoadSceneLibrary,
  loadDramaAllSceneList,
  debouncedLoadDramaAllSceneList,
  onSceneLibraryDialogOpen,
  onSceneLibraryTabChange,
  isSceneAddToEpisodeLoading,
  openEditSceneLibrary,
  submitEditSceneLibrary,
  onDeleteSceneLibrary,
  onAddSceneToLibrary,
  onAddSceneToMaterialLibrary,
  onAddSceneFromLibrary,
  onAddDramaSceneToEpisode,
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
.section {
  margin-bottom: 24px;
}
.card {
  background: #1e1f28;
  border-radius: 14px;
  padding: 22px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.15);
  transition: border-color 0.3s ease, box-shadow 0.3s ease, transform 0.3s ease;
}
.card:hover {
  border-color: rgba(255, 255, 255, 0.1);
  box-shadow: 0 6px 28px rgba(0, 0, 0, 0.25);
}
html.light .card {
  background: rgba(255, 255, 255, 0.75);
  backdrop-filter: blur(16px) saturate(1.3);
  -webkit-backdrop-filter: blur(16px) saturate(1.3);
  border-color: rgba(139, 92, 246, 0.08);
  box-shadow: 0 1px 0 rgba(255,255,255,0.8) inset, 0 4px 20px rgba(99, 102, 241, 0.05);
}
html.light .card:hover {
  border-color: rgba(139, 92, 246, 0.18);
  box-shadow: 0 1px 0 rgba(255,255,255,0.8) inset, 0 8px 36px rgba(99, 102, 241, 0.08);
}
.section-title {
  font-size: 1.05rem;
  margin: 0 0 4px;
  color: #f4f4f5;
  font-weight: 600;
  letter-spacing: -0.01em;
}
html.light .section-title { color: #1e1b4b; }
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
/* 批量生成分镜图/视频 */
.sb-batch-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
}
.sb-batch-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.batch-status {
  margin-top: 12px;
  padding: 12px 16px;
  background: var(--el-fill-color-light);
  border-radius: 8px;
  font-size: 13px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.batch-progress {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--el-text-color-primary);
  font-weight: 500;
}
.batch-failed {
  color: var(--el-color-danger);
  font-size: 12px;
}
.batch-stopping {
  color: var(--el-color-warning);
  font-size: 12px;
}
.batch-error-log {
  padding: 10px 12px;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 6px;
  font-size: 13px;
  color: #fca5a5;
  max-height: 160px;
  overflow-y: auto;
}
.batch-error-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}
.batch-error-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.batch-error-title {
  font-weight: 600;
  color: #f87171;
}
.batch-error-line {
  margin-bottom: 3px;
  word-break: break-all;
}
.section-desc {
  color: #52525b;
  font-size: 0.82rem;
  margin: 0 0 14px;
  line-height: 1.5;
}
html.light .section-desc { color: #6b7280; }
.story-textarea {
  margin-bottom: 12px;
}
.row { display: flex; flex-wrap: wrap; align-items: center; }
.gap { gap: 12px; }
.sb-image-error {
  width: 100%;
  flex: 1;
  background: #450a0a;
  color: #f87171;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
  text-align: center;
  font-size: 0.85rem;
  overflow: hidden;
  margin-bottom: 8px;
}
.image-preview-overlay {
  position: fixed;
  inset: 0;
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
.extra-thumb-remove {
  position: absolute;
  top: 1px;
  right: 1px;
  width: 16px;
  height: 16px;
  background: rgba(239,68,68,0.85);
  color: #fff;
  border: none;
  border-radius: 50%;
  font-size: 11px;
  line-height: 16px;
  text-align: center;
  cursor: pointer;
  padding: 0;
  opacity: 0;
  transition: opacity 0.15s;
}
.thumb-preview-btn {
  position: absolute;
  top: 1px;
  left: 1px;
  width: 16px;
  height: 16px;
  background: rgba(59,130,246,0.85);
  color: #fff;
  border: none;
  border-radius: 50%;
  font-size: 9px;
  line-height: 1;
  text-align: center;
  cursor: pointer;
  padding: 0;
  opacity: 0;
  transition: opacity 0.15s;
  display: flex;
  align-items: center;
  justify-content: center;
}
.thumb-preview-btn .el-icon,
.thumb-preview-btn svg {
  width: 10px;
  height: 10px;
}
.sb-img-thumb:hover .extra-thumb-remove,
.sb-img-thumb:hover .thumb-preview-btn { opacity: 1; }
.sb-video-thumb:hover .extra-thumb-remove { opacity: 1; }
.empty-tip {
  color: #5a5a66;
  font-size: 0.9rem;
  padding: 16px 0;
}
html.light .empty-tip {
  color: #9ca3af;
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
