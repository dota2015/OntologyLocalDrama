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
                :rows="3"
                placeholder="例如：一个少女在森林里遇见会说话的狐狸，一起寻找失落的宝石..."
                class="story-textarea"
              />

              <!-- 全自动生成前置全局参数 -->
              <div class="pipeline-config-box" style="margin-top: 10px; display: flex; flex-direction: column; gap: 8px; background: var(--el-fill-color-lighter, #f8fafc); border: 1px solid var(--el-border-color-lighter, #e2e8f0); padding: 10px 14px; border-radius: 8px;">
                <!-- 第一行：剧作与语速控制 -->
                <div class="row gap" style="flex-wrap: wrap; align-items: center;">
                  <span style="font-weight: 600; font-size: 13px; color: var(--el-text-color-primary);">剧作设定：</span>
                  <el-select v-model="storyStyle" placeholder="故事风格" clearable style="width: 110px" @change="() => saveProjectSettings(false)">
                    <el-option label="现代" value="modern" />
                    <el-option label="古风" value="ancient" />
                    <el-option label="奇幻" value="fantasy" />
                    <el-option label="日常" value="daily" />
                  </el-select>
                  <el-select v-model="storyType" placeholder="剧本类型" clearable style="width: 110px" @change="() => saveProjectSettings(false)">
                    <el-option label="剧情" value="drama" />
                    <el-option label="喜剧" value="comedy" />
                    <el-option label="冒险" value="adventure" />
                  </el-select>
                  <div style="display:flex;align-items:center;gap:6px;font-size:13px">
                    <span>集数</span>
                    <el-input-number
                      v-model="storyEpisodeCount"
                      :min="1"
                      :step="1"
                      :precision="0"
                      controls-position="right"
                      style="width: 90px"
                    />
                  </div>
                  <span style="color:var(--el-border-color);margin:0 4px">|</span>
                  <NarrativeStyleSettings
                    v-model="narrativeStyle"
                    :drama-id="dramaId"
                    :disabled="pipelineRunning || isStoryGenRunning || narrativeStyleSaving"
                    @saving="narrativeStyleSaving = $event"
                    @saved="onNarrativeStyleSaved"
                  />
                </div>

                <!-- 第二行：分镜视听参数（从分镜区提上来） -->
                <div class="row gap" style="flex-wrap: wrap; align-items: center;">
                  <span style="font-weight: 600; font-size: 13px; color: var(--el-text-color-primary);">视听分镜：</span>
                  <el-tooltip content="显示本地生成的输入画布尺寸，按 32 像素对齐。H3 使用原生约百万像素、23 步；Wan 经典首尾帧模式跟随首帧比例，尺寸可能不同。这里不含下载后的缩放。" placement="top">
                    <el-select v-model="projectAspectRatio" style="width: 220px" @change="() => saveProjectSettings(false)">
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
                  <div style="display:flex;align-items:center;gap:6px;font-size:13px">
                    <span>单镜时长</span>
                    <el-input-number v-model="shotDurationMin" :min="4" :max="shotDurationMax" :step="1" size="small" style="width:85px" @change="saveShotDurationRange" />
                    <span>至</span>
                    <el-input-number v-model="shotDurationMax" :min="shotDurationMin" :max="15" :step="1" size="small" style="width:85px" @change="saveShotDurationRange" />
                    <span>秒</span>
                  </div>
                  <el-checkbox v-model="storyboardUseFirstLastFrame" @change="onStoryboardUseFirstLastFrameChange">
                    首尾帧参考图
                  </el-checkbox>
                  <el-checkbox v-model="storyboardIncludeNarration" @change="() => saveProjectSettings(false)">
                    按需补充旁白
                  </el-checkbox>
                  <el-select v-model="scriptLanguage" placeholder="分镜语言" clearable style="width: 100px">
                    <el-option label="中文" value="zh" />
                    <el-option label="英文" value="en" />
                  </el-select>
                </div>
              </div>

              <!-- 操作按钮区：模式一（全体全流程） vs 模式二步骤一（分步手动剧本） -->
              <div class="row gap" style="margin-top: 14px; flex-wrap: wrap; align-items: center;">
                <!-- 模式一：全体全流程 -->
                <el-button
                  type="primary"
                  size="large"
                  :loading="pipelineRunning && !pipelinePaused"
                  :disabled="pipelineRunning || referenceBatchRunning || referenceSuggestionsRunning || savingReferenceModeIds.size > 0"
                  title="确定各种生成参数后一键全自动生成：梗概 ➔ 剧本 ➔ 资产提取 ➔ 参考图 ➔ 分镜首尾帧 ➔ 分镜视频 ➔ 配音成片（用户输入故事后静待成片）"
                  @click="onStartEndToEndFullPipeline"
                >
                  🚀 全体全流程一键成片
                </el-button>

                <span style="color:var(--el-border-color);margin:0 6px">｜</span>

                <!-- 模式二步骤一：分步手动生成剧本 -->
                <el-button
                  size="large"
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
              <div class="row gap" style="margin-bottom: 10px; flex-wrap: wrap;">
                <el-select
                  v-model="selectedEpisodeId"
                  placeholder="选择集数"
                  clearable
                  style="width: 130px"
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
                <el-input v-model="scriptTitle" placeholder="集标题" style="width: 150px" :disabled="episodeScriptGenerating" />
                <el-button v-if="dramaId" style="margin-left: auto" @click="onAddEpisode">
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
              <div class="row gap" style="margin-top: 8px; flex-wrap: wrap;">
                <el-button
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
import { inject } from 'vue'
import { DocumentAdd, Plus, Document } from '@element-plus/icons-vue'
import { useFilmStore } from '@/stores/film'
import StylePickerButton from '@/components/StylePickerButton.vue'
import NarrativeStyleSettings from '@/components/NarrativeStyleSettings.vue'

const store = useFilmStore()
const ctx = inject('filmCreateContext', {})

// 双向响应式状态绑定
const scriptWorkbenchMode = ctx.scriptWorkbenchMode
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
const onGenerateStory = ctx.onGenerateStory
const selectedEpisodeId = ctx.selectedEpisodeId
const episodeScriptGenerating = ctx.episodeScriptGenerating
const onEpisodeSelect = ctx.onEpisodeSelect
const scriptTitle = ctx.scriptTitle
const onAddEpisode = ctx.onAddEpisode
const scriptContent = ctx.scriptContent
const scriptGenerating = ctx.scriptGenerating
const currentEpisodeId = ctx.currentEpisodeId
const onGenerateScript = ctx.onGenerateScript
const onRegenerateEpisodeScript = ctx.onRegenerateEpisodeScript
const openSelectScriptDialog = ctx.openSelectScriptDialog
const selectPreviewEpisodeId = ctx.selectPreviewEpisodeId
const showSelectScriptDialog = ctx.showSelectScriptDialog
const loadSelectScriptList = ctx.loadSelectScriptList
const selectScriptLoading = ctx.selectScriptLoading
const selectScriptImporting = ctx.selectScriptImporting
const selectableScriptDramas = ctx.selectableScriptDramas
const selectScriptDramas = ctx.selectScriptDramas
const onPickScriptFromDialog = ctx.onPickScriptFromDialog
const saveProjectSettings = ctx.saveProjectSettings
const dramaId = ctx.dramaId
const showNovelImport = ctx.showNovelImport
const novelImportReset = ctx.novelImportReset
const novelImportMode = ctx.novelImportMode
const novelText = ctx.novelText
const onNovelFileChange = ctx.onNovelFileChange
const novelFileName = ctx.novelFileName
const novelMaxChapters = ctx.novelMaxChapters
const novelAiSummarize = ctx.novelAiSummarize
const novelImporting = ctx.novelImporting
const onImportNovel = ctx.onImportNovel
</script>

<style scoped>
.script-workbench-unified {
  margin-bottom: 0;
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
