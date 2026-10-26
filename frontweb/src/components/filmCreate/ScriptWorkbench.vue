<template>
  <div class="script-workbench-container">
    <section class="section card script-workbench-unified">
      <el-tabs v-model="scriptWorkbenchMode" class="script-workbench-tabs">
        <el-tab-pane label="创作剧本" name="create">
          <div class="script-pane-inner">
            <div class="script-sub-block">
              <div class="section-header-row" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
                <div>
                  <h2 class="section-title" style="margin-bottom:4px">故事生成与全局配置</h2>
                  <p class="section-desc" style="margin:0">输入一段故事梗概，确定各项生成参数，一键启动全体全流程；或先单步生成剧本</p>
                </div>
                <el-button plain size="small" @click="showNovelImport = true">
                  <el-icon><DocumentAdd /></el-icon>
                  导入小说/长文
                </el-button>
              </div>
              <el-input
                v-model="storyInput"
                type="textarea"
                :rows="8"
                placeholder="例如：一个少女在森林里遇见会说话的狐狸，一起寻找失落的宝石..."
                class="story-textarea"
              />

              <!-- 全自动生成前置全局参数 -->
              <div class="pipeline-config-box">
                <!-- 第一行：剧作设定与叙事风格 -->
                <div class="pipeline-config-row">
                  <div class="config-cluster">
                    <span class="config-cluster-label">剧作设定：</span>
                    <el-select v-model="storyStyle" placeholder="故事风格" clearable style="width: 105px" @change="() => saveProjectSettings(false)">
                      <el-option label="现代" value="modern" />
                      <el-option label="古风" value="ancient" />
                      <el-option label="奇幻" value="fantasy" />
                      <el-option label="日常" value="daily" />
                    </el-select>
                    <el-select v-model="storyType" placeholder="剧本类型" clearable style="width: 105px" @change="() => saveProjectSettings(false)">
                      <el-option label="剧情" value="drama" />
                      <el-option label="喜剧" value="comedy" />
                      <el-option label="冒险" value="adventure" />
                    </el-select>
                    <div class="config-input-inline">
                      <span class="inline-sublabel">集数</span>
                      <el-input-number
                        v-model="storyEpisodeCount"
                        :min="1"
                        :step="1"
                        :precision="0"
                        controls-position="right"
                        style="width: 85px"
                      />
                    </div>
                  </div>

                  <div class="config-divider" />

                  <div class="config-cluster">
                    <NarrativeStyleSettings
                      v-model="narrativeStyle"
                      :drama-id="dramaId"
                      :disabled="pipelineRunning || isStoryGenRunning || narrativeStyleSaving"
                      @saving="narrativeStyleSaving = $event"
                      @saved="onNarrativeStyleSaved"
                    />
                  </div>
                </div>

                <!-- 第二行：分镜视听参数（从分镜区提上来） -->
                <div class="pipeline-config-row">
                  <div class="config-cluster">
                    <span class="config-cluster-label">视听分镜：</span>
                    <el-tooltip content="显示本地生成的输入画布尺寸，按 32 像素对齐。H3 使用原生约百万像素、23 步；Wan 经典首尾帧模式跟随首帧比例，尺寸可能不同。这里不含下载后的缩放。" placement="top">
                      <el-select v-model="projectAspectRatio" style="width: 195px" @change="() => saveProjectSettings(false)">
                        <el-option label="16:9 横屏（1344×768）" value="16:9" />
                        <el-option label="9:16 竖屏（768×1344）" value="9:16" />
                        <el-option label="3:4 竖版（864×1152）" value="3:4" />
                        <el-option label="1:1 方形（992×992）" value="1:1" />
                        <el-option label="4:3 标准（1152×864）" value="4:3" />
                        <el-option label="21:9 宽银幕（1536×672）" value="21:9" />
                      </el-select>
                    </el-tooltip>
                    <StylePickerButton
                      v-model="generationStyle"
                      v-model:custom-prompt="customStylePrompt"
                      :options="generationStyleOptions"
                      @change="() => saveProjectSettings(true)"
                    />
                    <div class="config-input-inline">
                      <span class="inline-sublabel">单镜时长</span>
                      <el-input-number v-model="shotDurationMin" :min="4" :max="shotDurationMax" :step="1" size="small" style="width:75px" @change="saveShotDurationRange" />
                      <span class="inline-sublabel">至</span>
                      <el-input-number v-model="shotDurationMax" :min="shotDurationMin" :max="15" :step="1" size="small" style="width:75px" @change="saveShotDurationRange" />
                      <span class="inline-sublabel">秒</span>
                    </div>
                  </div>

                  <div class="config-divider" />

                  <div class="config-cluster">
                    <el-checkbox v-model="storyboardUseFirstLastFrame" @change="onStoryboardUseFirstLastFrameChange">
                      首尾帧参考图
                    </el-checkbox>
                    <el-checkbox v-model="storyboardIncludeNarration" @change="() => saveProjectSettings(false)">
                      按需补充旁白
                    </el-checkbox>
                    <el-select v-model="scriptLanguage" placeholder="分镜语言" clearable style="width: 95px">
                      <el-option label="中文" value="zh" />
                      <el-option label="英文" value="en" />
                    </el-select>
                  </div>
                </div>
              </div>

              <!-- 操作按钮区：模式一（全体全流程） vs 模式二步骤一（分步手动剧本） -->
              <div class="pipeline-action-bar">
                <!-- 模式一：全体全流程 -->
                <el-button
                  type="primary"
                  size="large"
                  class="action-btn-primary"
                  :loading="pipelineRunning && !pipelinePaused"
                  :disabled="pipelineRunning || referenceBatchRunning || referenceSuggestionsRunning || savingReferenceModeIds.size > 0"
                  title="确定各种生成参数后一键全自动生成：梗概 ➔ 剧本 ➔ 资产提取 ➔ 参考图 ➔ 分镜首尾帧 ➔ 分镜视频 ➔ 配音成片（用户输入故事后静待成片）"
                  @click="onStartEndToEndFullPipeline"
                >
                  🚀 全体全流程一键成片
                </el-button>

                <!-- 模式二步骤一：分步手动生成剧本 -->
                <el-button
                  size="large"
                  class="action-btn-secondary"
                  :loading="isStoryGenRunning"
                  :disabled="narrativeStyleSaving"
                  title="由导演智能体依据梗概创编全剧分集剧本，检查确认后可在下方各步骤继续分步手动制作"
                  @click="onGenerateStory"
                >
                  🎬 导演生成分集剧本
                </el-button>
              </div>
            </div>
            <div class="script-sub-divider" />
            <div id="anchor-script" class="script-sub-block">
              <h2 class="section-title">剧本</h2>
              <div class="script-toolbar">
                <el-select
                  v-model="selectedEpisodeId"
                  placeholder="选择集数"
                  clearable
                  style="width: 140px"
                  :disabled="!dramaId || episodeScriptGenerating"
                  @change="onEpisodeSelect"
                >
                  <el-option
                    v-for="ep in (store.drama?.episodes || [])"
                    :key="ep.id"
                    :label="ep.title || '第' + (ep.episode_number || 0) + '集'"
                    :value="ep.id"
                  />
                </el-select>
                <el-input v-model="scriptTitle" placeholder="集标题" style="width: 160px" :disabled="episodeScriptGenerating" />
                <el-button v-if="dramaId" class="script-add-ep-btn" @click="onAddEpisode">
                  <el-icon><Plus /></el-icon>添加一集
                </el-button>
              </div>
              <el-input
                v-model="scriptContent"
                :disabled="episodeScriptGenerating"
                type="textarea"
                :rows="8"
                placeholder="剧本内容将显示在这里，可直接编辑..."
                class="story-textarea"
              />
              <div class="script-bottom-actions">
                <el-button
                  type="primary"
                  plain
                  :loading="scriptGenerating"
                  :disabled="episodeScriptGenerating || (!!dramaId && (store.drama?.episodes?.length > 0) && !currentEpisodeId)"
                  @click="onGenerateScript"
                >
                  保存当前集
                </el-button>
                <el-button
                  :loading="episodeScriptGenerating"
                  :disabled="!currentEpisodeId || isStoryGenRunning"
                  @click="onRegenerateEpisodeScript"
                >
                  重新生成当前集
                </el-button>
                <span class="section-desc" style="margin: 0">仅生成所选集的草稿，检查后点击「保存当前集」。</span>
              </div>
            </div>
          </div>
        </el-tab-pane>
        <el-tab-pane label="选择剧本" name="select">
          <p class="section-desc script-mode-hint">
            从剧本库选择后，仅把「故事梗概」与「各集剧本正文」写入当前工程，不会导入角色、分镜、图片或视频。
          </p>
          <el-button type="primary" @click="openSelectScriptDialog">
            <el-icon><Document /></el-icon>
            从已有剧本中选择…
          </el-button>
          <div v-if="dramaId && (store.drama?.episodes?.length || storyInput)" class="script-preview-wrap">
            <h3 class="preview-block-title">故事梗概</h3>
            <el-input
              :model-value="storyInput"
              type="textarea"
              :rows="3"
              readonly
              class="story-textarea"
            />
            <template v-if="(store.drama?.episodes || []).length > 1">
              <h3 class="preview-block-title">分集剧本</h3>
              <el-tabs v-model="selectPreviewEpisodeId" class="preview-ep-tabs">
                <el-tab-pane
                  v-for="ep in (store.drama?.episodes || [])"
                  :key="ep.id"
                  :label="ep.title || ('第' + (ep.episode_number || 0) + '集')"
                  :name="String(ep.id)"
                >
                  <el-input
                    :model-value="ep.script_content || ''"
                    type="textarea"
                    :rows="12"
                    readonly
                    class="story-textarea"
                  />
                </el-tab-pane>
              </el-tabs>
            </template>
            <template v-else>
              <h3 class="preview-block-title">剧本正文</h3>
              <el-input
                :model-value="scriptContent"
                type="textarea"
                :rows="12"
                readonly
                class="story-textarea"
              />
            </template>
            <div class="preview-actions">
              <el-button type="primary" plain @click="scriptWorkbenchMode = 'create'">切换到创作剧本以编辑</el-button>
            </div>
          </div>
          <p v-else class="script-select-empty">尚未选择剧本，请点击上方按钮</p>
        </el-tab-pane>
      </el-tabs>
    </section>

    <!-- 选择剧本对话框 -->
    <el-dialog
      v-model="showSelectScriptDialog"
      title="从剧本库导入"
      width="640px"
      destroy-on-close
      @open="loadSelectScriptList"
    >
      <div v-loading="selectScriptLoading || selectScriptImporting" class="select-script-list">
        <div
          v-for="d in selectableScriptDramas"
          :key="d.id"
          class="select-script-item"
          :class="{ disabled: selectScriptImporting }"
          @click="!selectScriptImporting && onPickScriptFromDialog(d.id)"
        >
          <div class="select-script-title">{{ d.title || '未命名' }}</div>
          <div class="select-script-desc">{{ (d.description || '暂无简介').slice(0, 200) }}{{ (d.description && d.description.length > 200) ? '…' : '' }}</div>
        </div>
        <div v-if="!selectScriptLoading && selectScriptDramas.length === 0" class="select-script-empty">剧本库为空，请先在「剧本管理」创建剧本</div>
        <div v-else-if="!selectScriptLoading && selectableScriptDramas.length === 0" class="select-script-empty">没有可导入的其他剧本</div>
      </div>
    </el-dialog>

    <!-- 导入小说弹窗 -->
    <el-dialog v-model="showNovelImport" title="导入小说/长文" width="600px" @close="novelImportReset">
      <div class="novel-import-dialog">
        <p style="color:#6b7280;font-size:13px;margin-bottom:12px">支持粘贴小说文本或上传 txt 文件，AI 自动识别章节并转换为剧本集数</p>
        <el-tabs v-model="novelImportMode">
          <el-tab-pane label="粘贴文本" name="text">
            <el-input
              v-model="novelText"
              type="textarea"
              :rows="10"
              placeholder="粘贴小说正文，AI 会自动识别章节..."
            />
          </el-tab-pane>
          <el-tab-pane label="上传文件" name="file">
            <el-upload
              drag
              :auto-upload="false"
              :on-change="onNovelFileChange"
              accept=".txt,.md"
              :show-file-list="false"
            >
              <el-icon class="el-icon--upload"><DocumentAdd /></el-icon>
              <div class="el-upload__text">拖拽 .txt / .md 文件到此处，或<em>点击上传</em></div>
            </el-upload>
            <div v-if="novelFileName" style="margin-top:8px;font-size:13px;color:#409eff">已选择：{{ novelFileName }}</div>
          </el-tab-pane>
        </el-tabs>
        <div class="novel-import-options" style="margin-top:12px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <div style="display:flex;align-items:center;gap:6px;font-size:13px">
            <span>最多导入集数：</span>
            <el-input-number v-model="novelMaxChapters" :min="1" :max="20" size="small" style="width:100px" />
          </div>
          <el-checkbox v-model="novelAiSummarize" size="small">AI 转换为剧本格式（会消耗 Token）</el-checkbox>
        </div>
      </div>
      <template #footer>
        <el-button @click="showNovelImport = false">取消</el-button>
        <el-button type="primary" :loading="novelImporting" @click="onImportNovel">开始导入</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, watch, inject } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { DocumentAdd, Plus, Document } from '@element-plus/icons-vue'
import { useFilmStore } from '@/stores/film'
import { dramaAPI } from '@/api/drama'
import { runGenerateStoryFromPremise } from '@/composables/useStoryGeneration'
import { parseScriptIntoEpisodes, episodesListToPlainScript } from '@/utils/scriptEpisodes'
import { stylePromptMetadataForSave } from '@/constants/styleOptions'
import StylePickerButton from '@/components/StylePickerButton.vue'
import NarrativeStyleSettings from '@/components/NarrativeStyleSettings.vue'

const store = useFilmStore()
const router = useRouter()
const route = useRoute()
const ctx = inject('filmCreateContext', {})

// 剧本工作台内部 UI 模式
const scriptWorkbenchMode = ref('create')

// 从上下文继承的双向响应式参数
const storyInput = ctx.storyInput
const storyStyle = ctx.storyStyle
const storyType = ctx.storyType
const storyEpisodeCount = ctx.storyEpisodeCount
const narrativeStyle = ctx.narrativeStyle
const narrativeStyleSaving = ctx.narrativeStyleSaving
const onNarrativeStyleSaved = ctx.onNarrativeStyleSaved
const projectAspectRatio = ctx.projectAspectRatio
const generationStyle = ctx.generationStyle
const customStylePrompt = ctx.customStylePrompt
const generationStyleOptions = ctx.generationStyleOptions
const shotDurationMin = ctx.shotDurationMin
const shotDurationMax = ctx.shotDurationMax
const saveShotDurationRange = ctx.saveShotDurationRange
const storyboardUseFirstLastFrame = ctx.storyboardUseFirstLastFrame
const onStoryboardUseFirstLastFrameChange = ctx.onStoryboardUseFirstLastFrameChange
const storyboardIncludeNarration = ctx.storyboardIncludeNarration
const scriptLanguage = ctx.scriptLanguage
const pipelineRunning = ctx.pipelineRunning
const pipelinePaused = ctx.pipelinePaused
const referenceBatchRunning = ctx.referenceBatchRunning
const referenceSuggestionsRunning = ctx.referenceSuggestionsRunning
const savingReferenceModeIds = ctx.savingReferenceModeIds
const onStartEndToEndFullPipeline = ctx.onStartEndToEndFullPipeline
const isStoryGenRunning = ctx.isStoryGenRunning
const selectedEpisodeId = ctx.selectedEpisodeId
const onEpisodeSelect = ctx.onEpisodeSelect
const scriptTitle = ctx.scriptTitle
const scriptContent = ctx.scriptContent
const scriptGenerating = ctx.scriptGenerating
const storyGenerating = ctx.storyGenerating
const currentEpisodeId = ctx.currentEpisodeId
const saveProjectSettings = ctx.saveProjectSettings
const dramaId = ctx.dramaId
const loadDrama = ctx.loadDrama || (() => {})
const pollTask = ctx.pollTask || (() => Promise.resolve(null))

// 集剧本重新生成状态
const episodeScriptGenerating = ref(false)

// 选择剧本库弹窗状态
const showSelectScriptDialog = ref(false)
const selectScriptLoading = ref(false)
const selectScriptImporting = ref(false)
const selectScriptDramas = ref([])
const selectPreviewEpisodeId = ref('')

const selectableScriptDramas = computed(() => {
  const cur = store.dramaId
  const list = selectScriptDramas.value || []
  if (cur == null) return list
  return list.filter((d) => Number(d.id) !== Number(cur))
})

// 小说/长文导入状态
const showNovelImport = ref(false)
const novelImportMode = ref('text')
const novelText = ref('')
const novelFileName = ref('')
const novelFileContent = ref('')
const novelMaxChapters = ref(10)
const novelAiSummarize = ref(false)
const novelImporting = ref(false)

function projectStylePromptMetadata() {
  return stylePromptMetadataForSave(generationStyle?.value, customStylePrompt?.value)
}

async function onGenerateStory() {
  await runGenerateStoryFromPremise({
    premise: storyInput?.value,
    narrativeStyle: { ...(narrativeStyle?.value || {}) },
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
    savedCurrentEpisodeNumber: ctx.savedCurrentEpisodeNumber || ref(1),
    selectedEpisodeId,
    onEpisodeSelect,
    storyGenerating,
    scriptGenerating,
    pollTask,
    replaceRouteWhenNew: true,
    skipPostLoad: false,
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
  () => [store.drama?.episodes, selectedEpisodeId?.value],
  () => {
    const eps = store.drama?.episodes || []
    if (eps.length > 1) {
      const cur = selectedEpisodeId?.value
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
    formData.append('title', scriptTitle?.value || '导入小说')
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
  const episodeId = currentEpisodeId?.value
  if (!episodeId || episodeScriptGenerating.value) return
  const projectId = dramaId?.value
  const originalContent = scriptContent?.value
  const originalTitle = scriptTitle?.value
  episodeScriptGenerating.value = true
  try {
    const draft = await dramaAPI.generateEpisodeScript(episodeId, { premise: storyInput?.value })
    if (Number(currentEpisodeId?.value) !== Number(episodeId) || Number(dramaId?.value) !== Number(projectId)
        || scriptContent?.value !== originalContent || scriptTitle?.value !== originalTitle) {
      ElMessage.info('当前集或编辑内容已变化，未替换编辑框；需要时请重新生成。')
      return
    }
    if (scriptContent) scriptContent.value = draft.script_content
    if (scriptTitle) scriptTitle.value = draft.title
    ElMessage.success(`第${draft.episode_number}集草稿已生成，请检查后点击「保存当前集」。已有分镜需另行重新生成。`)
  } catch (e) {
    ElMessage.error(e.message || '当前集剧本生成失败，原剧本已保留')
  } finally {
    episodeScriptGenerating.value = false
  }
}

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

  let dramaIdVal = store.dramaId
  const curEp = store.currentEpisode
  if (!dramaIdVal) {
    const drama = await dramaAPI.create({
      title: scriptTitle?.value || '新故事',
      description: storyInput?.value?.trim() || trimmed.slice(0, 200),
      genre: storyType?.value || undefined,
      style: generationStyle?.value || undefined,
      metadata: {
        ...projectStylePromptMetadata(),
        story_style: storyStyle?.value || undefined,
        narrative_style: { ...(narrativeStyle?.value || {}) },
        aspect_ratio: projectAspectRatio?.value || '16:9',
      },
    })
    store.setDrama(drama)
    dramaIdVal = drama.id
    if (ctx.savedCurrentEpisodeNumber) ctx.savedCurrentEpisodeNumber.value = 1
    const first = parsed.episodes[0] || { title: '', script_content: trimmed }
    const episodes = multiFromMarkers
      ? toPayload(parsed.episodes)
      : [
          {
            episode_number: 1,
            title: scriptTitle?.value || first.title || '第1集',
            script_content: first.script_content || trimmed,
          },
        ]
    await dramaAPI.saveEpisodes(dramaIdVal, episodes)
    await loadDrama()
    if (route.params.id === 'new') {
      router.replace('/film/' + dramaIdVal)
    }
    if (multiFromMarkers) {
      ElMessage.success(`已按「第N集/章/节」拆分为 ${episodes.length} 集`)
    }
    return { created: true }
  }
  if (multiFromMarkers && !curEp?.id) {
    if (ctx.savedCurrentEpisodeNumber) ctx.savedCurrentEpisodeNumber.value = 1
    const payload = toPayload(parsed.episodes)
    await dramaAPI.saveEpisodes(dramaIdVal, payload)
    if (storyInput?.value?.trim()) {
      await dramaAPI.saveOutline(dramaIdVal, {
        summary: storyInput.value.trim(),
        genre: storyType?.value || undefined,
        style: generationStyle?.value || undefined,
        metadata: {
          ...projectStylePromptMetadata(),
          story_style: storyStyle?.value || undefined,
          narrative_style: { ...(narrativeStyle?.value || {}) },
          aspect_ratio: projectAspectRatio?.value || '16:9',
        },
      }).catch(() => {})
    }
    await loadDrama()
    ElMessage.success(`已按「第N集/章/节」拆分为 ${payload.length} 集`)
    return { created: false, splitEpisodes: true }
  }
  if (ctx.savedCurrentEpisodeNumber) ctx.savedCurrentEpisodeNumber.value = curEp?.episode_number ?? 1
  const first = parsed.episodes[0]
  const singleTitle = first?.title && String(first.title).trim()
  const singleBody = parsed.episodes.length === 1 && singleTitle ? first.script_content : trimmed
  if (curEp?.id) {
    await dramaAPI.saveEpisodeScript(curEp.id, {
      title: scriptTitle?.value || singleTitle || '第' + curEp.episode_number + '集',
      script_content: singleBody,
    })
  } else {
    await dramaAPI.saveEpisodes(dramaIdVal, [{ episode_number: 1, title: scriptTitle?.value || '第1集', script_content: trimmed }])
  }
  if (storyInput?.value?.trim()) {
    await dramaAPI.saveOutline(dramaIdVal, {
      summary: storyInput.value.trim(),
      genre: storyType?.value || undefined,
      style: generationStyle?.value || undefined,
      metadata: {
        ...projectStylePromptMetadata(),
        story_style: storyStyle?.value || undefined,
        narrative_style: { ...(narrativeStyle?.value || {}) },
        aspect_ratio: projectAspectRatio?.value || '16:9',
      },
    }).catch(() => {})
  }
  await loadDrama()
  return { created: false }
}

async function onGenerateScript() {
  const content = (scriptContent?.value ?? store.scriptContent ?? '').toString().trim()
  if (!content) {
    ElMessage.warning('请先在「故事生成」中点击 AI 生成，或手动输入剧本内容')
    return
  }
  if (scriptGenerating) scriptGenerating.value = true
  try {
    const result = await saveScriptToBackend(content)
    if (result?.created) {
      ElMessage.success('项目已创建，剧本已保存')
    } else {
      ElMessage.success('剧本已保存')
    }
  } catch (e) {
    ElMessage.error(e.message || '保存失败')
  } finally {
    if (scriptGenerating) scriptGenerating.value = false
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
    if (ctx.savedCurrentEpisodeNumber) ctx.savedCurrentEpisodeNumber.value = nextNum
    await loadDrama()
    ElMessage.success('已添加第' + nextNum + '集')
  } catch (e) {
    ElMessage.error(e.message || '添加失败')
  }
}

defineExpose({
  episodeScriptGenerating,
  onGenerateStory,
  onGenerateScript,
  onRegenerateEpisodeScript,
  onPickScriptFromDialog,
  onImportNovel,
  onAddEpisode,
})
</script>

<style scoped>
/* 通用弹性工具类兜底 */
.row {
  display: flex;
  align-items: center;
}
.gap {
  gap: 10px;
}

/* 全局参数配置卡片 */
.pipeline-config-box {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: var(--bg-inner, #1c1c1e);
  border: 1px solid var(--border-color, #27272a);
  padding: 12px 14px;
  border-radius: 8px;
}
:global(html.light) .pipeline-config-box {
  background: var(--bg-inner, #f8fafc);
  border-color: var(--border-color, #e2e8f0);
}
.pipeline-config-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 16px;
}
.config-cluster {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.config-cluster-label {
  font-weight: 600;
  font-size: 13px;
  color: var(--text-bright, #fafafa);
  white-space: nowrap;
}
:global(html.light) .config-cluster-label {
  color: var(--text-primary, #18181b);
}
.config-input-inline {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
.inline-sublabel {
  font-size: 13px;
  color: var(--text-muted, #a1a1aa);
  white-space: nowrap;
}
:global(html.light) .inline-sublabel {
  color: var(--text-muted, #52525b);
}
.config-divider {
  width: 1px;
  height: 18px;
  background: var(--border-muted, #3f3f46);
  flex-shrink: 0;
}
:global(html.light) .config-divider {
  background: var(--border-muted, #d4d4d8);
}
@media (max-width: 900px) {
  .config-divider {
    display: none;
  }
}
.pipeline-action-bar {
  margin-top: 14px;
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}
.action-btn-primary {
  font-weight: 600;
  padding: 12px 20px;
}
.action-btn-secondary {
  padding: 12px 18px;
}
.script-toolbar {
  margin-bottom: 10px;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.script-add-ep-btn {
  margin-left: auto;
}
.script-bottom-actions {
  margin-top: 10px;
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.script-workbench-unified {
  /* 保持与后续卡片的标准间距 */
}
.script-workbench-tabs :deep(.el-tabs__header) {
  margin-bottom: 16px;
}
.script-workbench-tabs :deep(.el-tabs__nav-wrap::after) {
  height: 1px;
}
.script-workbench-tabs :deep(.el-tabs__item) {
  font-size: 15px;
  font-weight: 600;
}
.script-pane-inner {
  display: flex;
  flex-direction: column;
  gap: 0;
}
.script-sub-block {
  padding-top: 4px;
}
.script-sub-divider {
  margin: 20px 0;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}
:global(html.light) .script-sub-divider {
  border-top-color: rgba(0, 0, 0, 0.08);
}
.script-mode-hint {
  margin-top: 0;
  margin-bottom: 12px;
}
.script-preview-wrap {
  margin-top: 20px;
}
.preview-block-title {
  margin: 16px 0 8px;
  font-size: 0.95rem;
  font-weight: 600;
  color: #a1a1aa;
}
:global(html.light) .preview-block-title {
  color: #64748b;
}
.preview-block-title:first-of-type {
  margin-top: 0;
}
.preview-actions {
  margin-top: 16px;
}
.script-select-empty {
  margin-top: 16px;
  color: #71717a;
  font-size: 14px;
}
.select-script-list {
  min-height: 120px;
  max-height: 420px;
  overflow-y: auto;
}
.select-script-item {
  padding: 12px 14px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  margin-bottom: 8px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.select-script-item:hover {
  background: rgba(255, 255, 255, 0.06);
  border-color: rgba(99, 102, 241, 0.35);
}
.select-script-item.disabled,
.select-script-item.disabled:hover {
  cursor: not-allowed;
  opacity: 0.55;
  border-color: rgba(255, 255, 255, 0.06);
  background: transparent;
}
:global(html.light) .select-script-item {
  border-color: rgba(99, 102, 241, 0.15);
}
:global(html.light) .select-script-item:hover {
  background: rgba(99, 102, 241, 0.06);
}
.select-script-title {
  font-weight: 600;
  color: #e4e4e7;
  margin-bottom: 6px;
}
:global(html.light) .select-script-title {
  color: #1e1b4b;
}
.select-script-desc {
  font-size: 13px;
  color: #9ca0b2;
  line-height: 1.45;
}
.select-script-empty {
  text-align: center;
  color: #71717a;
  padding: 24px;
}
.preview-ep-tabs {
  margin-top: 4px;
}
</style>
