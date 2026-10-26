<template>
  <div class="storyboard-workbench">
    <!-- 分镜图上传图片用，单例放在外层避免 v-for 导致 ref 为数组 -->
    <input
      ref="sbImageFileInput"
      type="file"
      accept="image/jpeg,image/png,image/gif,image/webp"
      style="display: none"
      @change="onSbImageFileChange"
    />

    <!-- 5. 分镜生成 -->
    <section id="anchor-storyboard" class="section card">
      <h2 class="section-title">
        <span>5. 分镜生成</span>
        <span class="step-desc">根据剧本、角色、场景自动生成分镜头脚本</span>
      </h2>
      <!-- 分镜模块后台任务与进度提示 -->
      <GenerationJobs ref="storyboardJobsPanel" :drama-id="dramaId" :episode-id="currentEpisodeId" kinds="storyboards,omni_polish,storyboard_images" @updated="onGenerationJobsUpdated" />
      <StoryboardBatchToolbar
        v-model:storyboard-count="storyboardCount"
        v-model:video-duration="videoDuration"
        v-model:grid-mode="gridMode"
        v-model:storyboard-universal-omni="storyboardUniversalOmni"
        :storyboard-use-first-last-frame="storyboardUseFirstLastFrame"
        :has-storyboards="storyboards.length > 0"
        :has-episode="!!currentEpisodeId"
        :script-estimate-storyboard-title="scriptEstimateStoryboardTitle"
        :script-estimate-storyboard-hint="scriptEstimateStoryboardHint"
        :script-estimate-video-duration-title="scriptEstimateVideoDurationTitle"
        :script-estimate-video-duration-hint="scriptEstimateVideoDurationHint"
        :director-generating="directorGenerating"
        :storyboard-generating="storyboardGenerating"
        :universal-omni-polish-running="universalOmniPolishRunning"
        :inferring-params="inferringParams"
        :auditing-invariants="auditingInvariants"
        :batch-image-running="batchImageRunning"
        :batch-video-running="batchVideoRunning"
        :batch-image-stopping="batchImageStopping"
        :batch-video-stopping="batchVideoStopping"
        :batch-dubbing-starting="batchDubbingStarting"
        :pipeline-running="pipelineRunning"
        :single-shot-image-info="singleShotImageInfo"
        :batch-image-progress="batchImageProgress"
        :batch-video-progress="batchVideoProgress"
        :batch-image-errors="batchImageErrors"
        :batch-video-errors="batchVideoErrors"
        :batch-video-submitting="batchVideoSubmitting"
        :exporting-storyboard-sheet="exportingStoryboardSheet"
        @save-settings="saveProjectSettings"
        @director-generate="onDirectorAgentGenerate"
        @add-storyboard="onAddSingleStoryboard"
        @batch-infer-params="onBatchInferParams"
        @audit-invariants="onAuditInvariants"
        @start-batch-image="startBatchImageGeneration"
        @start-batch-video="startBatchVideoGeneration"
        @start-batch-dubbing="startBatchDubbing"
        @stop-batch-image="stopBatchImageGeneration"
        @stop-batch-video="stopBatchVideoGeneration"
        @export-storyboard-sheet="onExportStoryboardSheet"
        @export-narration-srt="onExportNarrationSrt"
        @clear-batch-image-errors="batchImageErrors = []"
        @clear-batch-video-errors="clearBatchVideoErrors"
        @retry-failed-batch-videos="retryFailedBatchVideos"
      >
        <template #batch-speech>
          <BatchSpeechGeneration
            :drama-id="dramaId"
            :episode-id="currentEpisodeId"
            :disabled="pipelineRunning || storyboardGenerating || universalOmniPolishRunning"
            @updated="onBatchSpeechUpdated"
          />
        </template>
      </StoryboardBatchToolbar>
      <div v-if="storyboardGenerating || universalOmniPolishRunning" class="storyboard-generating-tip">
        <el-icon class="is-loading"><Loading /></el-icon>
        <span v-if="universalOmniPolishRunning">
          正在润色全能提示词：第 {{ universalOmniPolishProgress.current }} / {{ universalOmniPolishProgress.total }} 镜
          <template v-if="universalOmniPolishProgress.label">（{{ universalOmniPolishProgress.label }}）</template>
          …
        </span>
        <span v-else>正在分析剧本并拆解分镜，请稍候...</span>
      </div>
      <div v-if="sbTruncatedWarning && !sbTruncatedDismissed && storyboards.length > 0" class="sb-truncated-warning">
        <el-icon><WarningFilled /></el-icon>
        <span>检测到分镜可能不完整（AI 输出被截断），请确认分镜数量是否符合预期，必要时可重新生成。</span>
        <el-button size="small" text @click="sbTruncatedDismissed = true">关闭</el-button>
      </div>
      <template v-if="storyboards.length > 0">
        <template v-for="(sb, i) in storyboards" :key="sb.id">
          <StoryboardCard :sb="sb" :index="i" :storyboards="storyboards" />
        </template>
      </template>
      <!-- 分镜生成中提示条 -->
      <div v-if="storyboardGenerating || universalOmniPolishRunning" class="sb-generating-tip">
        <span class="sb-gen-dot" /><span class="sb-gen-dot" /><span class="sb-gen-dot" />
        <span v-if="universalOmniPolishRunning" class="sb-gen-text">
          全能片段润色中 {{ universalOmniPolishProgress.current }}/{{ universalOmniPolishProgress.total }}
          <template v-if="universalOmniPolishProgress.label"> · {{ universalOmniPolishProgress.label }}</template>
        </span>
        <span v-else class="sb-gen-text">分镜持续生成中，客官稍等片刻…</span>
      </div>
      <div v-else-if="storyboards.length === 0" class="empty-tip">请先生成分镜</div>
    </section>

    <StoryboardSpeechEditor ref="speechEditor" :drama-id="dramaId" @saved="onSpeechSaved" />

    <!-- 分镜提示词编辑弹窗 -->
    <el-dialog
      v-model="showSbPromptDialog"
      :title="`分镜 ${sbPromptTarget?.storyboard_number ?? ''} · ${sbPromptActiveTab === 'image' ? '编辑图片提示词' : '编辑视频提示词'}`"
      width="720px"
      @close="sbPromptTarget = null"
    >
      <el-tabs v-model="sbPromptActiveTab" class="sb-prompt-tabs">
        <el-tab-pane label="🖼 图片提示词" name="image">
          <el-form v-if="sbPromptTarget" label-width="0" class="sb-prompt-dialog-form">
            <el-form-item label="">
              <div style="width:100%">
                <div style="font-size:12px; color:#6b7280; margin-bottom:4px;">原始提示词（分镜生成时写入，仅供参考）</div>
                <el-input
                  v-model="sbPromptImageText"
                  type="textarea"
                  :rows="4"
                  placeholder="分镜生成时由 AI 写入的原始描述"
                />
              </div>
            </el-form-item>
            <el-form-item label="">
              <div style="width:100%">
                <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                  <span style="font-size:12px; color:#6b7280;">通用优化提示词（🎬 导演本体优化，注入角色锚点/道具真实尺度/场景地标）</span>
                  <el-button
                    size="small"
                    type="warning"
                    plain
                    :loading="sbPromptPolishing"
                    @click="onPolishSbPrompt"
                  >{{ sbPromptPolishedText ? '🎬 重新导演优化' : '🎬 导演本体优化' }}</el-button>
                </div>
                <el-input
                  v-model="sbPromptPolishedText"
                  type="textarea"
                  :rows="6"
                  placeholder="点击「导演本体优化」生成高契约度提示词（融入角色外貌、道具物理尺度与场景地标）"
                />
              </div>
            </el-form-item>
            <div class="sb-prompt-section-title" style="margin-top:10px; display:flex; align-items:center; gap:6px;">
              <span>💡 🎬 导演定向微调指导（直指微调元素，携带本体与连戏快照上下文）</span>
            </div>
            <el-form-item label="">
              <div style="width:100%">
                <el-input
                  v-model="sbPromptUserFeedback"
                  type="textarea"
                  :rows="2"
                  placeholder="输入针对特定元素的定向微调指令（如：聚焦手持佩剑近景特写，剑身有微光，神情坚毅，冷峻侧光等）"
                />
              </div>
            </el-form-item>
          </el-form>
        </el-tab-pane>

        <el-tab-pane label="🎬 视频提示词" name="video">
          <el-form v-if="sbPromptTarget" label-width="0" class="sb-prompt-dialog-form">
            <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;">
              <span style="font-size:12px; color:#6b7280;">视频生成提示词（用于分镜生视频）</span>
              <div style="display:flex; align-items:center; gap:8px;">
                <el-button
                  size="small"
                  type="info"
                  plain
                  :loading="sbPromptRebuilding"
                  @click="onRebuildSbVideoPrompt"
                >按分镜参数重建</el-button>
                <el-button
                  size="small"
                  type="warning"
                  plain
                  :loading="sbPromptVideoPolishing"
                  @click="onPolishSbVideoPrompt"
                >{{ sbPromptVideoPolishing ? 'AI 润色中…' : 'AI 润色优化' }}</el-button>
              </div>
            </div>
            <el-form-item label="">
              <el-input
                v-model="sbPromptVideoText"
                type="textarea"
                :rows="12"
                placeholder="视频生成提示词（可点击「AI 润色优化」进行二次润色，或点击「按分镜参数重建」重构）"
              />
            </el-form-item>
            <div class="sb-prompt-section-title" style="margin-top:10px; display:flex; align-items:center; gap:6px;">
              <span>💡 AI 视频优化指导意见（选填，对「AI 润色优化」生效）</span>
            </div>
            <el-form-item label="">
              <div style="width:100%">
                <el-input
                  v-model="sbPromptUserFeedback"
                  type="textarea"
                  :rows="2"
                  placeholder="输入修改指导（如：增强受击紧张感，镜头缓慢推进，避免过快运动等）"
                />
              </div>
            </el-form-item>
          </el-form>
        </el-tab-pane>
      </el-tabs>
      <template #footer>
        <el-button @click="showSbPromptDialog = false">取消</el-button>
        <el-button type="primary" :loading="sbPromptSaving" @click="onSaveSbPromptDialog">保存</el-button>
      </template>
    </el-dialog>

    <!-- 分镜 AI 拆分弹窗 -->
    <el-dialog
      v-model="showSplitDialog"
      :title="`✂ 分镜 ${splitTarget?.storyboard_number ?? ''} · AI 智能拆分`"
      width="580px"
      @close="splitTarget = null"
    >
      <div v-if="splitTarget" class="sb-split-dialog-body">
        <div class="sb-split-info-card">
          <div class="sb-split-info-row">
            <span class="sb-split-info-label">原镜头：</span>
            <span class="sb-split-info-val">第 {{ splitTarget.storyboard_number }} 镜 · {{ splitTarget.title || '未命名' }}（时长约 {{ splitTarget.duration || 5 }} 秒）</span>
          </div>
          <div class="sb-split-info-row" style="margin-top:6px;">
            <span class="sb-split-info-label">原动作：</span>
            <span class="sb-split-info-val" style="color:#4b5563;">{{ splitTarget.action || '无动作描述' }}</span>
          </div>
        </div>

        <el-form label-position="top" style="margin-top:14px;">
          <el-form-item label="拆分数量（目标子分镜数）">
            <el-radio-group v-model="splitCount">
              <el-radio-button :value="2">拆为 2 镜</el-radio-button>
              <el-radio-button :value="3">拆为 3 镜</el-radio-button>
              <el-radio-button :value="4">拆为 4 镜</el-radio-button>
            </el-radio-group>
            <div style="font-size:12px; color:#6b7280; margin-top:4px;">
              AI 将按专业视听语言（单一动作单元 + 视听节奏层次）将该镜头拆分为连续镜头，后续分镜序号自动顺延。
            </div>
          </el-form-item>

          <el-form-item label="拆分指导意见 / 侧重方向（选填）">
            <el-input
              v-model="splitInstruction"
              type="textarea"
              :rows="3"
              placeholder="例如：把红狼撑起上身和蜂医倒地抽搐分成两个独立镜头，突出两人危急状态；或特写关键道具等。"
            />
          </el-form-item>
        </el-form>
      </div>
      <template #footer>
        <el-button @click="showSplitDialog = false">取消</el-button>
        <el-button
          type="primary"
          :loading="splitLoading"
          @click="onExecuteAiSplit"
        >🤖 开始 AI 拆镜</el-button>
      </template>
    </el-dialog>

    <!-- 首尾帧提示词编辑器（显示最终发给AI的完整提示词，支持编辑保存） -->
    <el-dialog
      v-model="showFramePromptEditor"
      :title="`${editingFramePromptSlot === 'last' ? '尾帧' : '首帧'}图生提示词 · 编辑`"
      width="720px"
      destroy-on-close
    >
      <div class="frame-prompt-editor-body" v-loading="editingFramePromptLoading" element-loading-text="正在读取或生成帧提示词，请稍候…">
        <div class="frame-prompt-editor-hint">
          此提示词将直接发给AI生成首/尾帧图片。支持编辑后保存，保存后点击「生成」即可使用新提示词。
        </div>

        <!-- 空间布局锚点（生成分镜时 AI 输出的最高优先级站位合同） -->
        <div v-if="editingFramePromptSb?.layout_description" class="frame-layout-anchor">
          <div class="frame-layout-anchor-label">本分镜空间布局锚点（首尾帧强制一致合同，最高优先级）</div>
          <div class="frame-layout-anchor-text">{{ editingFramePromptSb.layout_description }}</div>
          <div class="frame-layout-anchor-note">首帧必须严格按此生成初始站位；尾帧必须在完全相同的左右位置、距离、构图下仅演化姿态/表情/结果。</div>
        </div>

        <el-input
          v-model="editingFramePromptText"
          type="textarea"
          :rows="14"
          placeholder="在此编辑最终发给AI生图的完整提示词..."
          class="frame-prompt-editor-textarea"
          :disabled="editingFramePromptLoading || editingFramePromptRegenerating"
        />
      </div>
      <template #footer>
        <el-button @click="showFramePromptEditor = false">关闭</el-button>
        <el-button :disabled="editingFramePromptLoading" :loading="editingFramePromptRegenerating" @click="regenerateEditingFramePrompt">重新生成</el-button>
        <el-button type="primary" :disabled="editingFramePromptLoading || editingFramePromptRegenerating" :loading="editingFramePromptSaving" @click="saveEditingFramePrompt">保存</el-button>
      </template>
    </el-dialog>

    <!-- 分镜视频参数编辑弹窗 -->
    <el-dialog
      v-model="showVideoParamsDialog"
      :title="`分镜 ${videoParamsTarget?.storyboard_number ?? ''} · 视频参数`"
      width="860px"
      destroy-on-close
      @close="onVideoParamsDialogClosed"
    >
      <el-form v-if="videoParamsTarget" label-width="115px" size="small" class="vp-dialog-form">
        <el-form-item label="创作模式">
          <el-radio-group
            :model-value="sbCreationMode[videoParamsTarget.id] === 'universal' ? 'universal' : 'classic'"
            size="small"
            @change="(v) => setSbCreationModeId(videoParamsTarget.id, v)"
          >
            <el-radio-button value="classic">经典分镜</el-radio-button>
            <el-radio-button value="universal">全能模式</el-radio-button>
          </el-radio-group>
          <div class="vp-mode-hint">全能模式：中间为片段描述；生视频时使用 <strong>AI 配置里当前启用的视频</strong>（接口规范 <code>kling_omni</code> / <code>volcengine_omni</code>，或「低价 Seedance2」，或勾选「确认支持全能模式」）并合并场景/角色/道具等参考图（不含经典分镜主图）。经典字段保留，可随时切回。</div>
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="标题">
              <el-input v-model="sbTitle[videoParamsTarget.id]" placeholder="镜头标题" />
            </el-form-item>
          </el-col>
          <el-col :span="6">
            <el-form-item label="地点">
              <el-input v-model="sbLocation[videoParamsTarget.id]" placeholder="场景地点" />
            </el-form-item>
          </el-col>
          <el-col :span="6">
            <el-form-item label="时间">
              <el-input v-model="sbTime[videoParamsTarget.id]" placeholder="清晨/午后" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="6">
            <el-form-item label="时长(秒)">
              <el-input-number v-model="sbDuration[videoParamsTarget.id]" :min="1" :max="60" style="width:100%" />
            </el-form-item>
          </el-col>
          <el-col :span="6">
            <el-form-item label="景别">
              <el-select v-model="sbShotType[videoParamsTarget.id]" placeholder="景别" style="width:100%">
                <el-option label="大远景" value="大远景" />
                <el-option label="远景" value="远景" />
                <el-option label="中景" value="中景" />
                <el-option label="近景" value="近景" />
                <el-option label="特写" value="特写" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="6">
            <el-form-item label="运镜">
              <el-select v-model="sbMovement[videoParamsTarget.id]" placeholder="运镜（推荐动态）" style="width:100%" clearable filterable>
                <el-option-group label="基础运镜">
                  <el-option label="固定（少用）" value="static" />
                  <el-option label="推镜" value="push" />
                  <el-option label="拉镜" value="pull" />
                  <el-option label="横摇（左/右）" value="pan" />
                  <el-option label="纵摇（上/下）" value="tilt" />
                  <el-option label="跟镜/跟踪" value="tracking" />
                  <el-option label="升镜（吊臂上升）" value="crane_up" />
                  <el-option label="降镜（吊臂下降）" value="crane_dn" />
                  <el-option label="环绕/轨道" value="orbit" />
                  <el-option label="手持/晃动" value="handheld" />
                </el-option-group>
                <el-option-group label="进阶运镜">
                  <el-option label="变焦（zoom in/out）" value="zoom" />
                  <el-option label="旋转/滚镜（roll）" value="roll" />
                  <el-option label="甩镜/急摇" value="whip_pan" />
                  <el-option label="螺旋上升/下降" value="spiral" />
                </el-option-group>
                <el-option-group label="电影化组合镜头">
                  <el-option label="希区柯克镜头（推+变焦）" value="hitchcock_zoom" />
                  <el-option label="子弹时间（环绕+升格）" value="bullet_time" />
                  <el-option label="荷兰角+运镜" value="dutch_angle_move" />
                  <el-option label="推轨复合（dolly+track）" value="dolly_track" />
                  <el-option label="升格环绕（slow-mo orbit）" value="slowmo_orbit" />
                </el-option-group>
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="6">
            <el-form-item label="氛围">
              <el-input v-model="sbAtmosphere[videoParamsTarget.id]" placeholder="氛围/情绪" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="镜头视角">
              <div style="display:flex;gap:4px;flex-wrap:wrap">
                <el-select v-model="sbAngleS[videoParamsTarget.id]" placeholder="景别" style="width:76px">
                  <el-option label="特写" value="close_up" />
                  <el-option label="中景" value="medium" />
                  <el-option label="远景" value="wide" />
                </el-select>
                <el-select v-model="sbAngleV[videoParamsTarget.id]" placeholder="俯仰" style="width:86px">
                  <el-option label="平视" value="eye_level" />
                  <el-option label="低角仰拍" value="low" />
                  <el-option label="高角俯拍" value="high" />
                  <el-option label="虫眼仰视" value="worm" />
                </el-select>
                <el-select v-model="sbAngleH[videoParamsTarget.id]" placeholder="方向" style="width:80px">
                  <el-option label="正面" value="front" />
                  <el-option label="前左45°" value="front_left" />
                  <el-option label="左侧" value="left" />
                  <el-option label="后左135°" value="back_left" />
                  <el-option label="背面" value="back" />
                  <el-option label="后右135°" value="back_right" />
                  <el-option label="右侧" value="right" />
                  <el-option label="前右45°" value="front_right" />
                </el-select>
                <span v-if="sbAngleS[videoParamsTarget.id] && sbAngleV[videoParamsTarget.id] && sbAngleH[videoParamsTarget.id]"
                      style="font-size:11px;color:#6b7280;background:#f3f4f6;padding:2px 6px;border-radius:4px;white-space:nowrap">
                  {{ angleToPromptFragment(sbAngleH[videoParamsTarget.id], sbAngleV[videoParamsTarget.id], sbAngleS[videoParamsTarget.id]).label }}
                </span>
              </div>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="灯光">
              <el-select v-model="sbLighting[videoParamsTarget.id]" placeholder="灯光风格" style="width:100%" clearable>
                <el-option label="自然光" value="natural" />
                <el-option label="顺光" value="front" />
                <el-option label="侧光" value="side" />
                <el-option label="逆光" value="backlit" />
                <el-option label="顶光" value="top" />
                <el-option label="底光" value="under" />
                <el-option label="柔光" value="soft" />
                <el-option label="戏剧光" value="dramatic" />
                <el-option label="黄金时段" value="golden_hour" />
                <el-option label="蓝调时刻" value="blue_hour" />
                <el-option label="夜景" value="night" />
                <el-option label="霓虹" value="neon" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="景深">
              <el-select v-model="sbDof[videoParamsTarget.id]" placeholder="景深" style="width:100%" clearable>
                <el-option label="极浅景深" value="extreme_shallow" />
                <el-option label="浅景深" value="shallow" />
                <el-option label="中景深" value="medium" />
                <el-option label="深景深（全焦）" value="deep" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>

        <!-- 空间布局锚点：生成分镜时 AI 输出的最高优先级人物站位合同（首尾帧强制一致核心） -->
        <el-form-item label="空间布局锚点（首尾帧人物站位合同）">
          <div style="display:flex; gap:8px; align-items:flex-start; width:100%">
            <el-input
              v-model="sbLayoutDescription[videoParamsTarget.id]"
              type="textarea"
              :rows="3"
              placeholder="例如：女主站画面左三分之一正对镜头，男主站右后侧侧身看向女主，中景，双人构图，平衡稳定"
              style="flex:1"
            />
            <el-button
              size="small"
              :loading="regeneratingLayoutSbIds.has(videoParamsTarget.id)"
              @click="onRegenerateLayoutDescription(videoParamsTarget)"
              style="margin-top:4px; white-space:nowrap"
            >
              AI 重新生成/优化
            </el-button>
          </div>
          <div style="font-size:11px;color:#64748b;margin-top:4px;line-height:1.35">
            最高优先级空间合同（用于首尾帧站位锁定）。AI 可参考上下分镜一键重新生成/优化，点击右侧按钮触发。
          </div>
        </el-form-item>

        <el-form-item label="动作">
          <el-input v-model="sbAction[videoParamsTarget.id]" type="textarea" :rows="2" placeholder="动作描述" />
        </el-form-item>
        <el-form-item label="对白">
          <el-input v-model="sbDialogue[videoParamsTarget.id]" type="textarea" :rows="2" placeholder="角色对白" />
          <span style="font-size:12px;color:var(--el-text-color-secondary)">也可在分镜卡片点「编辑文本」逐句选择说话人物；人物音色在人物编辑中设置。</span>
        </el-form-item>
        <el-form-item label="解说旁白">
          <el-input v-model="sbNarration[videoParamsTarget.id]" type="textarea" :rows="2" class="sb-narration-input" placeholder="画外解说 / 纪录片式旁白（与对白分开）" />
        </el-form-item>
        <el-form-item label="背景音乐/配乐">
          <el-input v-model="sbBgmPrompt[videoParamsTarget.id]" type="textarea" :rows="2" placeholder="无对白镜头配乐描述（如：低沉紧迫的战术电子脉冲与心跳低音），H3 将据此原生合成背景音乐" />
          <span style="font-size:12px;color:var(--el-text-color-secondary)">💡 无对白镜头建议填写；H3 等音视频大模型将直接根据此描述原生生成极具电影感与情绪张力的背景音乐。</span>
        </el-form-item>
        <el-form-item v-if="canSplitSbByAudio(videoParamsTarget)" label="多角色对白">
          <div class="sb-split-audio-row">
            <p class="sb-split-audio-tip">
              本镜含多句对白或「对白+旁白」，Seedance 同镜易串音。可拆成多条分镜（每条仅一人说话或仅旁白），再分别生视频。
            </p>
            <el-button
              type="warning"
              plain
              :loading="splitByAudioLoading"
              @click="onSplitSbByAudio(videoParamsTarget)"
            >
              按对白拆镜
            </el-button>
          </div>
        </el-form-item>
        <el-form-item label="画面结果">
          <el-input v-model="sbResult[videoParamsTarget.id]" type="textarea" :rows="2" placeholder="动作完成后的画面结果" />
        </el-form-item>
        <el-form-item label="视频提示词">
          <div class="vp-video-prompt-hint">保存后将根据上方字段，由系统按最新规则自动生成（含角色音色锚点）。</div>
          <el-input
            v-if="videoParamsTarget?.video_prompt"
            :model-value="videoParamsTarget.video_prompt"
            type="textarea"
            :rows="3"
            readonly
            style="color:#6b7280;margin-top:8px"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button
          type="warning"
          plain
          :loading="inferringParams"
          title="根据动作、场景、时间与氛围智能推断本镜视角、灯光、景深与运镜"
          @click="onInferCurrentShotParams"
        >
          ⚡ 智能推断本镜参数
        </el-button>
        <el-button @click="showVideoParamsDialog = false">取消</el-button>
        <el-button type="primary" :loading="videoParamsSaving" @click="onSaveVideoParams">保存并更新</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, nextTick, inject, provide, onBeforeUnmount } from 'vue'
import { ElMessage, ElMessageBox, ElNotification, ElLoading } from 'element-plus'
import { Loading, WarningFilled } from '@element-plus/icons-vue'
import StoryboardBatchToolbar from './StoryboardBatchToolbar.vue'
import StoryboardCard from './StoryboardCard.vue'
import BatchSpeechGeneration from '../BatchSpeechGeneration.vue'
import StoryboardSpeechEditor from '../StoryboardSpeechEditor.vue'
import GenerationJobs from '../GenerationJobs.vue'
import { storyboardsAPI } from '@/api/storyboards'
import { imagesAPI } from '@/api/images'
import { videosAPI } from '@/api/videos'
import { ontologyAPI } from '@/api/ontology'
import { dramaAPI } from '@/api/drama'
import { uploadAPI } from '@/api/upload'
import { taskAPI } from '@/api/task'
import { aiAPI } from '@/api/ai'
import { generationJobsAPI, activeGenerationJob } from '@/api/generationJobs'
import { orderedVideoShots } from '@/utils/h3VideoBatch'
import { createVideoBatchMonitor } from '@/utils/videoBatchMonitor'
import { shotSpeechStatus, automaticVideoModel, meaningfulSpeech } from '@/utils/shotSpeech'
import { missingStoryboardImageSlots } from '@/utils/storyboardImageBatch'
import { exportStoryboardSheet } from '@/utils/exportStoryboardSheet'
import { GEN_RESOURCE } from '@/stores/generationTaskStore'
import { useAgentContext } from '@/stores/agentContext'
import { canUseUniversalOmniVideoApi } from '@/utils/videoOmniSupport'

const ctx = inject('filmCreateContext', {})

// 共享状态与方法解构
const store = ctx.store
const dramaId = ctx.dramaId
const currentEpisodeId = ctx.currentEpisodeId
const storyboards = ctx.storyboards || computed(() => store?.storyboards || [])
const pipelineRunning = ctx.pipelineRunning
const generationJobsPanel = ctx.generationJobsPanel
const storyboardJobsPanel = ctx.storyboardJobsPanel || ref(null)
const dubbingPanel = ctx.dubbingPanel
const onGenerationJobsUpdated = ctx.onGenerationJobsUpdated
const characters = ctx.characters
const scenes = ctx.scenes
const props = ctx.props
const narrativeStyle = ctx.narrativeStyle
const projectAspectRatio = ctx.projectAspectRatio
const videoResolution = ctx.videoResolution
const videoFrameContiguity = ctx.videoFrameContiguity
const saveProjectSettings = ctx.saveProjectSettings
const loadDrama = ctx.loadDrama
const loadStoryboardMedia = ctx.loadStoryboardMedia
const loadSingleStoryboardMedia = ctx.loadSingleStoryboardMedia
const restoreSelectionsFromBackend = ctx.restoreSelectionsFromBackend
const refreshStoryboardsOnly = ctx.refreshStoryboardsOnly
const refreshStoryboardsForEpisode = ctx.refreshStoryboardsForEpisode
const pollTask = ctx.pollTask
const getSelectedStyle = ctx.getSelectedStyle
const getSelectedStylePrompt = ctx.getSelectedStylePrompt
const getSelectedStylePromptZh = ctx.getSelectedStylePromptZh
const scriptEstimateStoryboardTitle = ctx.scriptEstimateStoryboardTitle
const scriptEstimateStoryboardHint = ctx.scriptEstimateStoryboardHint
const scriptEstimateVideoDurationTitle = ctx.scriptEstimateVideoDurationTitle
const scriptEstimateVideoDurationHint = ctx.scriptEstimateVideoDurationHint
const storyboardCount = ctx.storyboardCount
const videoDuration = ctx.videoDuration
const storyboardIncludeNarration = ctx.storyboardIncludeNarration
const storyboardUniversalOmni = ctx.storyboardUniversalOmni
const storyboardUseFirstLastFrame = ctx.storyboardUseFirstLastFrame
const lastFrameUseFirstLayoutLock = ctx.lastFrameUseFirstLayoutLock
const gridMode = ctx.gridMode
const videoClipDuration = ctx.videoClipDuration
const shotDurationMin = ctx.shotDurationMin
const shotDurationMax = ctx.shotDurationMax
const submitGenerationJob = ctx.submitGenerationJob
const serverGenerationJobs = ctx.serverGenerationJobs
const batchImageRunning = ctx.batchImageRunning
const batchImageStopping = ctx.batchImageStopping
const batchImageProgress = ctx.batchImageProgress
const batchImageErrors = ctx.batchImageErrors
const batchVideoRunning = ctx.batchVideoRunning
const batchVideoStopping = ctx.batchVideoStopping
const batchVideoProgress = ctx.batchVideoProgress
const batchVideoErrors = ctx.batchVideoErrors
const serverVideoBatch = ctx.serverVideoBatch
const batchVideoSubmitting = ctx.batchVideoSubmitting
const generatingSbImageIds = ctx.generatingSbImageIds
const generatingSbFirstImageIds = ctx.generatingSbFirstImageIds
const generatingSbLastImageIds = ctx.generatingSbLastImageIds
const generatingSbVideoIds = ctx.generatingSbVideoIds
const generatingUniversalSegmentIds = ctx.generatingUniversalSegmentIds
const sbImages = ctx.sbImages
const sbVideos = ctx.sbVideos
const sbVideoErrors = ctx.sbVideoErrors
const sbSelectedImgId = ctx.sbSelectedImgId
const sbSelectedLastImgId = ctx.sbSelectedLastImgId
const sbSelectedVideoId = ctx.sbSelectedVideoId
const sbCharacterIds = ctx.sbCharacterIds
const sbPropIds = ctx.sbPropIds
const sbSceneId = ctx.sbSceneId
const sbDialogue = ctx.sbDialogue
const sbNarration = ctx.sbNarration
const sbBgmPrompt = ctx.sbBgmPrompt
const sbShotType = ctx.sbShotType
const sbTitle = ctx.sbTitle
const sbLocation = ctx.sbLocation
const sbTime = ctx.sbTime
const sbDuration = ctx.sbDuration
const sbAction = ctx.sbAction
const sbResult = ctx.sbResult
const sbAtmosphere = ctx.sbAtmosphere
const sbAngle = ctx.sbAngle
const sbAngleH = ctx.sbAngleH
const sbAngleV = ctx.sbAngleV
const sbAngleS = ctx.sbAngleS
const sbMovement = ctx.sbMovement
const sbLighting = ctx.sbLighting
const sbDof = ctx.sbDof
const sbLayoutDescription = ctx.sbLayoutDescription
const sbCreationMode = ctx.sbCreationMode
const sbUniversalSegmentText = ctx.sbUniversalSegmentText
const directorGenerating = ctx.directorGenerating
const storyboardGenerating = ctx.storyboardGenerating
const universalOmniPolishRunning = ctx.universalOmniPolishRunning
const universalOmniPolishProgress = ctx.universalOmniPolishProgress
const previewImageUrl = ctx.previewImageUrl
const openImagePreview = ctx.openImagePreview
const closeImagePreview = ctx.closeImagePreview
const assetImageUrl = ctx.assetImageUrl
const assetVideoUrl = ctx.assetVideoUrl
const imageUrl = ctx.imageUrl
const hasAssetImage = ctx.hasAssetImage
const isHttpVideoUrl = ctx.isHttpVideoUrl
const recordHasPlayableVideoUrl = ctx.recordHasPlayableVideoUrl
const getSbVideo = ctx.getSbVideo
const getSbAllVideos = ctx.getSbAllVideos
const getSbFirstImage = ctx.getSbFirstImage
const getSbLastImage = ctx.getSbLastImage
const getSbImage = ctx.getSbImage
const getSbAllImages = ctx.getSbAllImages
const getQuadGridImage = ctx.getQuadGridImage
const hasSbImage = ctx.hasSbImage
const hasSbFirstLastPair = ctx.hasSbFirstLastPair
const missingSbImageSlots = ctx.missingSbImageSlots
const canUsePrevTailAsFirst = ctx.canUsePrevTailAsFirst
const getVideoStripItems = ctx.getVideoStripItems
const onSelectSbMainVideo = ctx.onSelectSbMainVideo
const getSbVideoError = ctx.getSbVideoError
const getSbResumableFailedVideo = ctx.getSbResumableFailedVideo
const getNextStoryboard = ctx.getNextStoryboard
const getPrevStoryboard = ctx.getPrevStoryboard
const buildSbGenMeta = ctx.buildSbGenMeta
const isSbVideoGenerating = ctx.isSbVideoGenerating
const onStoryboardUseFirstLastFrameChange = ctx.onStoryboardUseFirstLastFrameChange
const onLastFrameLayoutLockChange = ctx.onLastFrameLayoutLockChange
const onStoryboardCharacterChange = ctx.onStoryboardCharacterChange
const onStoryboardPropChange = ctx.onStoryboardPropChange
const onStoryboardSceneChange = ctx.onStoryboardSceneChange
const getSbCharacterIds = ctx.getSbCharacterIds
const setSbCharacterIds = ctx.setSbCharacterIds
const charactersAvailableToAddToSb = ctx.charactersAvailableToAddToSb
const onSbAddCharacterCommand = ctx.onSbAddCharacterCommand
const getSbPropIds = ctx.getSbPropIds
const setSbPropIds = ctx.setSbPropIds
const getSbSelectedCharacters = ctx.getSbSelectedCharacters
const getSbSelectedScene = ctx.getSbSelectedScene
const getSbSelectedProps = ctx.getSbSelectedProps
const baseUrl = ctx.baseUrl || ref('')
const genStore = ctx.genStore

const agentContext = useAgentContext()

// 本地状态
const sbTruncatedWarning = ref(false)
const sbTruncatedDismissed = ref(false)
const uploadingSbImageId = ref(null)
const sbImageFileInput = ref(null)
const sbImageUploadForId = ref(null)
const dragOverSbId = ref(null)
const sbImageUploadSlotById = ref({})
const exportingStoryboardSheet = ref(false)
const inferringParams = ref(false)
const auditingInvariants = ref(false)
const regeneratingLayoutSbIds = reactive(new Set())

// 分镜提示词弹窗
const showSbPromptDialog = ref(false)
const sbPromptTarget = ref(null)
const sbPromptActiveTab = ref('image')  // 'image' | 'video'
const sbPromptImageText = ref('')       // 原始 image_prompt
const sbPromptPolishedText = ref('')    // AI 优化后 polished_prompt
const sbPromptVideoText = ref('')       // video_prompt
const sbPromptSaving = ref(false)
const sbPromptPolishing = ref(false)
const sbPromptRebuilding = ref(false)
const sbPromptVideoPolishing = ref(false)
const sbPromptUserFeedback = ref('')     // 用户调整意见 / AI 优化指导

// 分镜 AI 拆分弹窗
const showSplitDialog = ref(false)
const splitTarget = ref(null)
const splitCount = ref(2)
const splitInstruction = ref('')
const splitLoading = ref(false)
const splitByAudioLoading = ref(false)

// 首尾帧提示词编辑器
const showFramePromptEditor = ref(false)
const editingFramePromptSb = ref(null)
const editingFramePromptSlot = ref('first') // 'first' | 'last'
const editingFramePromptText = ref('')
const editingFramePromptSaving = ref(false)
const editingFramePromptRegenerating = ref(false)
const editingFramePromptLoading = ref(false)
let framePromptEditorRequest = 0

// 分镜视频参数编辑弹窗
const showVideoParamsDialog = ref(false)
const videoParamsTarget = ref(null)
const videoParamsSaving = ref(false)

// 编辑提示词行内状态
const editingSbVideoPromptId = ref(null)
const editingSbVideoPromptText = ref('')
const editingSbImagePromptId = ref(null)
const editingSbImagePromptText = ref('')

// 操作 loading 状态 Sets
const upscalingSbIds = reactive(new Set())
const ttsSbIds = reactive(new Set())
const ttsSbNarrationIds = reactive(new Set())
const linkingTailFrameIds = reactive(new Set())
const linkingFirstFrameIds = reactive(new Set())
const usingPrevTailAsFirstIds = reactive(new Set())
const savingVideoModelIds = reactive(new Set())

// 对白与旁白 TTS 路径缓存
const sbDialogueAudioPaths = ref({})
const sbNarrationAudioPaths = ref({})
let sbTtsPreviewAudio = null

// 语音与配音组件引用
const speechEditor = ref(null)
const speechSummaries = ref({})
const batchDubbingStarting = ref(false)
const videoModelConfigs = ref([])

const videoModelChoices = computed(() => videoModelConfigs.value.flatMap(c =>
  (Array.isArray(c.model) ? c.model : [c.model]).filter(Boolean).map(model => ({ model, label: c.name + ' · ' + model }))))

const activeImageJobs = computed(() => {
  const jobs = serverGenerationJobs?.value || []
  return jobs.filter(j =>
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

// ── Functions required by Unit Tests (Declared as top-level functions) ──

async function openFramePromptEditor(sb, slot) {
  if (!sb?.id) return
  const request = ++framePromptEditorRequest
  editingFramePromptSb.value = sb
  editingFramePromptSlot.value = slot
  editingFramePromptText.value = ''
  showFramePromptEditor.value = true
  editingFramePromptLoading.value = true
  // 异步加载最终发给AI的真实提示词
  try {
    const pro = await ensureProfessionalFramePrompt(sb, slot)
    if (request === framePromptEditorRequest && showFramePromptEditor.value) editingFramePromptText.value = pro || ''
  } catch (e) {
    if (request === framePromptEditorRequest && showFramePromptEditor.value) {
      editingFramePromptText.value = slot === 'last' ? buildLastFrameImagePrompt(sb.id) : buildFirstFrameImagePrompt(sb.id)
    }
  } finally {
    if (request === framePromptEditorRequest) editingFramePromptLoading.value = false
  }
}

async function submitShotImageJob(sb, slots, force = true) {
  if (!dramaId.value || !sb?.id) return
  const jobs = typeof serverGenerationJobs !== 'undefined' ? (serverGenerationJobs.value || []) : []
  const isActive = typeof activeGenerationJob === 'function' ? activeGenerationJob : () => false
  const activeJobs = jobs.filter(j =>
    Number(j.episode_id) === Number(currentEpisodeId.value) && isActive(j)
  )
  const pipelineJob = activeJobs.find(j => ['pipeline', 'repair'].includes(j.kind))
  if (pipelineJob) {
    ElMessage.warning('全流程后台任务正在进行中，请等待其完成或先停止')
    return
  }
  const alreadyQueued = activeJobs.some(j => {
    let opt = j.options
    if (typeof opt === 'string') { try { opt = JSON.parse(opt) } catch (_) {} }
    const sbIds = opt?.storyboard_ids || []
    const jSlots = opt?.slots || (storyboardUseFirstLastFrame.value ? ['first', 'last'] : ['image'])
    return sbIds.includes(sb.id) && slots.some(s => jSlots.includes(s))
  })
  if (alreadyQueued) {
    const slotName = slots.includes('first') && slots.includes('last') ? '首尾帧' : slots.includes('first') ? '首帧' : slots.includes('last') ? '尾帧' : '图片'
    ElMessage.info(`分镜 #${sb.storyboard_number ?? sb.id} 的${slotName}已在生成或排队中，无需重复提交`)
    return
  }

  if (typeof generatingSbFirstImageIds !== 'undefined' && slots.includes('first')) generatingSbFirstImageIds.add(sb.id)
  if (typeof generatingSbLastImageIds !== 'undefined' && slots.includes('last')) generatingSbLastImageIds.add(sb.id)
  if (typeof generatingSbImageIds !== 'undefined' && slots.includes('image')) generatingSbImageIds.add(sb.id)
  try {
    const selected = sbCharacterIds.value[sb.id]
    if (Array.isArray(selected)) await storyboardsAPI.update(sb.id, { character_ids: selected })
    const slotName = slots.includes('first') && slots.includes('last') ? '首尾帧' : slots.includes('first') ? '首帧' : slots.includes('last') ? '尾帧' : '图片'
    await submitGenerationJob('storyboard_images', { storyboard_ids: [sb.id], slots, force })
    if (activeJobs.length > 0) {
      ElMessage.success(`分镜 #${sb.storyboard_number ?? sb.id} ${slotName}已加入后台队列（排在第 ${activeJobs.length} 位）`)
    } else {
      ElMessage.success(`分镜 #${sb.storyboard_number ?? sb.id} ${slotName}生成任务已提交`)
    }
  } catch(e) {
    if (typeof generatingSbFirstImageIds !== 'undefined' && slots.includes('first')) generatingSbFirstImageIds.delete(sb.id)
    if (typeof generatingSbLastImageIds !== 'undefined' && slots.includes('last')) generatingSbLastImageIds.delete(sb.id)
    if (typeof generatingSbImageIds !== 'undefined' && slots.includes('image')) generatingSbImageIds.delete(sb.id)
    ElMessage.error(e.message || '任务提交失败')
  }
}

async function onGenerateSbFramePair(sb) {
  return hasSbFirstLastPair(sb) ? submitShotImageJob(sb, ['last'], true) : submitShotImageJob(sb, ['first','last'], false)
}

async function onGenerateSbFrameImage(sb, slot) {
  return submitShotImageJob(sb, [slot])
}

async function onGenerateSbImage(sb) {
  return submitShotImageJob(sb, ['image'])
}

async function startBatchImageGeneration() {
  if (!currentEpisodeId.value || batchImageRunning.value || pipelineRunning.value) return
  try { await submitGenerationJob('storyboard_images') }
  catch(e){ElMessage.error(e.message || '图片批量任务提交失败')}
}

async function stopBatchImageGeneration() {
  const job = serverGenerationJobs.value.find(j => j.kind === 'storyboard_images' && Number(j.episode_id) === Number(currentEpisodeId.value) && activeGenerationJob(j))
  if (!job) return
  try {await generationJobsAPI.control(dramaId.value,job.id,'stop');await generationJobsPanel.value?.refresh()}
  catch(e){ElMessage.error(e.message)}
}

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
    const todo = orderedVideoShots(store.storyboards || []).filter(sb => {
      if (filterIds && !filterIds.has(Number(sb.id))) return false
      if (!filterIds && (sbVideos.value[sb.id] || []).some(v => v.status === 'completed' && recordHasPlayableVideoUrl(v))) return false
      if (isSbUniversalMode(sb.id)) return sbCanSubmitVideo(sb) && collectSbOmniReferenceAbsoluteUrls(sb).length > 0
      return !!getSbFirstFrameUrl(sb)
    })
    if (!todo.length) {
      ElMessage.info('没有需要生成视频的分镜（分镜缺少图片，或视频已全部生成）')
      return
    }
    // Snapshot all selected inputs once. The server submits each shot after its predecessor finishes.
    const shots = todo.map(sb => {
      const universal = isSbUniversalMode(sb.id)
      const refs = universal ? collectSbOmniReferenceAbsoluteUrls(sb) : []
      const { first, last } = sbVideoFirstLastUrls(sb, universal, null)
      let referenceUrls = universal ? refs : [first].filter(Boolean)
      if (!universal && last && !referenceUrls.includes(last)) referenceUrls.push(last)
      return {
        storyboard_id: sb.id, model: selectedShotModel(sb), prompt: buildSbVideoPromptForApi(sb),
        image_url: universal ? refs[0] : first, first_frame_url: first, last_frame_url: last,
        reference_image_urls: referenceUrls, universal,
        style: getSelectedStyle(), aspect_ratio: projectAspectRatio.value || '16:9',
        resolution: videoResolution.value || undefined, duration: getSbVideoDurationForApi(sb),
      }
    })
    const batch = await videosAPI.createBatch(episodeId, { drama_id: did, shots, continuity: videoFrameContiguity.value })
    if (currentEpisodeId.value === episodeId && dramaId.value === did) applyVideoBatchStatus(batch)
    ElMessage.success('已加入后台队列，刷新或关闭页面不影响生成')
  } catch (e) {
    ElMessage.error(e.message || '批量任务提交失败')
  } finally {
    batchVideoSubmitting.value = false
    if (currentEpisodeId.value === episodeId) batchVideoRunning.value = ['running', 'stopping'].includes(serverVideoBatch.value?.status)
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

async function clearBatchVideoErrors() {
  batchVideoErrors.value = []
  if (currentEpisodeId.value) {
    try {
      await videosAPI.clearBatch(currentEpisodeId.value, serverVideoBatch.value?.id)
      serverVideoBatch.value = null
    } catch (_) {}
  }
}

async function retryFailedBatchVideos() {
  if (!currentEpisodeId.value || batchVideoRunning.value || batchVideoSubmitting.value) return
  const failedItems = (serverVideoBatch.value?.items || []).filter(i => i.status === 'failed')
  const failedSbIds = new Set(failedItems.map(i => Number(i.storyboard_id)))
  if (!failedSbIds.size) {
    ElMessage.info('暂无需要重试的失败分镜')
    return
  }
  batchVideoErrors.value = []
  await startBatchVideoGeneration({ filterIds: failedSbIds })
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

const videoBatchMonitor = createVideoBatchMonitor({
  getBatch: episodeId => videosAPI.getBatch(episodeId),
  onStatus: async (batch, episodeId) => {
    if (batchVideoSubmitting.value || Number(currentEpisodeId.value) !== Number(episodeId)) return
    const old = serverVideoBatch.value
    applyVideoBatchStatus(batch)
    if (old?.id === batch?.id && ['running', 'stopping'].includes(old?.status) && !batchVideoRunning.value) {
      if (batch.status === 'completed') ElMessage.success('后台批量生成分镜视频已完成')
      else if (batch.status === 'completed_with_errors') ElMessage.warning(`后台批量生成结束，${batch.failed} 条失败，可再次点击批量生成补齐`)
    }
    const oldItems = new Map((old?.items || []).map(i => [i.id, i.status]))
    const changed = (batch?.items || []).filter(i => i.video_gen_id && oldItems.get(i.id) !== i.status)
    await Promise.allSettled(changed.map(i => loadSingleStoryboardMedia(i.storyboard_id)))
  },
})

watch(currentEpisodeId, episodeId => {
  applyVideoBatchStatus(null)
  videoBatchMonitor.watch(episodeId)
}, { immediate: true })

onBeforeUnmount(() => {
  videoBatchMonitor.dispose()
})

// ── Additional Storyboard Methods & Handlers ──

async function getCachedFramePromptFromDb(sbId, slot) {
  const frameType = slot === 'last' ? 'last' : 'first'
  try {
    const res = await storyboardsAPI.getFramePrompts(sbId)
    const row = (res?.frame_prompts || []).find((r) => r.frame_type === frameType)
    return row?.prompt?.trim() || ''
  } catch (_) {
    return ''
  }
}

async function ensureProfessionalFramePrompt(sb, slot, { forceRegenerate = false } = {}) {
  const frameType = slot === 'last' ? 'last' : 'first'
  if (!forceRegenerate) {
    const cached = await getCachedFramePromptFromDb(sb.id, slot)
    if (cached) return cached
  }
  try {
    const genRes = await storyboardsAPI.generateFramePrompt(sb.id, { frame_type: frameType })
    if (!genRes?.task_id) throw new Error('帧提示词任务未创建')
    const pollRes = await pollTask(genRes.task_id)
    if (pollRes?.status !== 'completed') {
      throw new Error(pollRes?.error || '帧提示词生成失败')
    }
    const fromTask = pollRes.result?.response?.single_frame?.prompt
    if (fromTask && String(fromTask).trim()) return String(fromTask).trim()
    const cached2 = await getCachedFramePromptFromDb(sb.id, slot)
    if (cached2) return cached2
  } catch (e) {
    console.warn('[首尾帧] 专业帧提示词生成失败，使用拼接回退', e?.message)
  }
  return slot === 'last' ? buildLastFrameImagePrompt(sb.id) : buildFirstFrameImagePrompt(sb.id)
}

async function saveEditingFramePrompt() {
  const sb = editingFramePromptSb.value
  const slot = editingFramePromptSlot.value
  if (!sb?.id || !slot) return
  const text = (editingFramePromptText.value || '').trim()
  if (!text) {
    ElMessage.warning('提示词不能为空')
    return
  }
  editingFramePromptSaving.value = true
  try {
    await storyboardsAPI.saveFramePrompt(sb.id, {
      frame_type: slot === 'last' ? 'last' : 'first',
      prompt: text,
    })
    ElMessage.success('帧提示词已保存')
    showFramePromptEditor.value = false
  } catch (e) {
    ElMessage.error(e.message || '保存失败')
  } finally {
    editingFramePromptSaving.value = false
  }
}

async function regenerateEditingFramePrompt() {
  const sb = editingFramePromptSb.value
  const slot = editingFramePromptSlot.value
  if (!sb?.id || !slot) return
  editingFramePromptRegenerating.value = true
  try {
    const text = await ensureProfessionalFramePrompt(sb, slot, { forceRegenerate: true })
    editingFramePromptText.value = text || ''
    ElMessage.success('已重新生成专业帧提示词')
  } catch (e) {
    ElMessage.error(e.message || '重新生成失败')
  } finally {
    editingFramePromptRegenerating.value = false
  }
}

function onUploadSbImageClick(sb, slot = 'first') {
  if (!sb?.id) return
  sbImageUploadForId.value = sb.id
  sbImageUploadSlotById.value = { ...sbImageUploadSlotById.value, [sb.id]: slot }
  if (!storyboardUseFirstLastFrame.value) {
    uploadingSbImageId.value = sb.id
  }
  if (sbImageFileInput.value) {
    sbImageFileInput.value.value = ''
    sbImageFileInput.value.click()
  }
}

function frameTypeForSlot(slot) {
  return slot === 'last' ? 'storyboard_last' : 'storyboard_first'
}

function uploadingSbImageSlot(sbId) {
  return sbImageUploadSlotById.value[sbId] || null
}

async function doUploadSbImage(sbId, file, slot = 'first') {
  if (!file || !sbId || !dramaId.value) return
  const useSlot = storyboardUseFirstLastFrame.value ? slot : 'first'
  if (storyboardUseFirstLastFrame.value) {
    sbImageUploadSlotById.value = { ...sbImageUploadSlotById.value, [sbId]: useSlot }
  } else {
    uploadingSbImageId.value = sbId
  }
  try {
    const res = await uploadAPI.uploadImage(file, { dramaId: dramaId.value })
    const url = res?.url || res?.path
    const localPath = res?.local_path
    if (!url && !localPath) {
      ElMessage.error('上传未返回地址')
      return
    }
    const uploaded = await imagesAPI.upload({
      storyboard_id: sbId,
      drama_id: dramaId.value,
      image_url: url || '',
      local_path: localPath || undefined,
      frame_type: storyboardUseFirstLastFrame.value ? frameTypeForSlot(useSlot) : undefined,
    })
    ElMessage.success(useSlot === 'last' ? '尾帧上传成功' : '首帧上传成功')
    if (uploaded?.id) {
      const sb = (store.storyboards || []).find((b) => b.id === sbId)
      if (sb) onSelectSbFrameImage(sb, uploaded, useSlot)
    } else if (!storyboardUseFirstLastFrame.value) {
      const { [sbId]: _r, ...rest } = sbSelectedImgId.value
      sbSelectedImgId.value = rest
    }
    await loadSingleStoryboardMedia(sbId)
    restoreSelectionsFromBackend()
  } catch (e) {
    ElMessage.error(e.message || '上传失败')
  } finally {
    uploadingSbImageId.value = null
    const next = { ...sbImageUploadSlotById.value }
    delete next[sbId]
    sbImageUploadSlotById.value = next
  }
}

function onSbImageFileChange(ev) {
  const file = ev.target?.files?.[0]
  const sid = sbImageUploadForId.value
  if (!file || !sid) {
    ev.target.value = ''
    return
  }
  const slot = sbImageUploadSlotById.value[sid] || 'first'
  doUploadSbImage(sid, file, slot).finally(() => {
    sbImageUploadForId.value = null
    ev.target.value = ''
  })
}

/** 获取缩略图条数据：按时间顺序从左往右展示全部已生成图片，点击切换且不改变历史顺序 */
function getStripItems(storyboardId) {
  const allImgs = getSbAllImages(storyboardId)
  if (!allImgs.length) return []
  const firstImg = storyboardUseFirstLastFrame.value ? getSbFirstImage(storyboardId) : getSbImage(storyboardId)
  const lastImg = storyboardUseFirstLastFrame.value ? getSbLastImage(storyboardId) : null
  // 严格按创建时间从早到晚排序（从左往右展示，先后顺序固定）
  const sorted = [...allImgs].sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0))
  return sorted.map((img, idx) => {
    const isFirst = !!(firstImg && firstImg.id === img.id)
    const isLast = !!(lastImg && lastImg.id === img.id)
    const isActive = isFirst || isLast
    let frameBadge = null
    if (isFirst && isLast) frameBadge = '首/尾'
    else if (isFirst) frameBadge = storyboardUseFirstLastFrame.value ? '首' : '当前'
    else if (isLast) frameBadge = '尾'
    else if (img.frame_type === 'storyboard_first') frameBadge = '首'
    else if (img.frame_type === 'storyboard_last') frameBadge = '尾'

    return {
      key: `img-${img.id}`,
      src: assetImageUrl(img),
      type: 'img',
      img,
      isActive,
      isFirst,
      isLast,
      label: quadPanelLabel(img.frame_type) || (isActive ? '当前' : `第${idx + 1}版`),
      frameBadge,
      prompt: img.prompt || '',
    }
  })
}

function stripItemTitle(sbId, item) {
  const lines = [item.label, item.prompt].filter(Boolean)
  if (item.isActive) {
    lines.unshift('【当前选中】')
  } else if (storyboardUseFirstLastFrame.value) {
    lines.unshift('点击：设为首帧或尾帧')
  } else {
    lines.unshift('点击设为主图')
  }
  return lines.join('\n\n')
}

async function onStripItemClick(sb, item) {
  if (!storyboardUseFirstLastFrame.value) {
    onSelectStripItem(sb, item)
    return
  }
  try {
    await ElMessageBox.confirm('将此图绑定到哪个槽位？', '设置参考帧', {
      confirmButtonText: '设为首帧',
      cancelButtonText: '设为尾帧',
      distinguishCancelAndClose: true,
      type: 'info',
    })
    onSelectSbFrameImage(sb, item.img, 'first')
    ElMessage.success('已设为首帧')
  } catch (action) {
    if (action === 'cancel') {
      onSelectSbFrameImage(sb, item.img, 'last')
      ElMessage.success('已设为尾帧')
    }
  }
}

/** 宫格子图位置标签 */
function quadPanelLabel(frameType) {
  const map = {
    quad_panel_0: '左上', quad_panel_1: '右上', quad_panel_2: '左下', quad_panel_3: '右下',
    nine_panel_0: '左上', nine_panel_1: '中上', nine_panel_2: '右上',
    nine_panel_3: '左中', nine_panel_4: '中间', nine_panel_5: '右中',
    nine_panel_6: '左下', nine_panel_7: '中下', nine_panel_8: '右下',
  }
  return map[frameType] || null
}

/** 获取分镜主图的本地路径（用于超分辨率判断） */
function getSbLocalImage(sb) {
  const img = getSbImage(sb.id)
  return img?.local_path || sb.local_path || null
}

async function onSaveSbNarrationField(sb) {
  if (!sb?.id) return
  const next = (sbNarration.value[sb.id] || '').toString().trim()
  const prev = (sb.narration || '').toString().trim()
  if (next === prev) return
  try {
    await storyboardsAPI.update(sb.id, { narration: next || null })
    const list = store.currentEpisode?.storyboards
    if (Array.isArray(list)) {
      const row = list.find((x) => Number(x.id) === Number(sb.id))
      if (row) row.narration = next || null
    }
  } catch (_) { /* 静默失败，避免打断输入 */ }
}

function onSelectStripItem(sb, item) {
  onSelectSbMainImage(sb, item.img)
}

function onSelectSbFrameImage(sb, img, slot) {
  if (!sb?.id || !img) return
  const isLast = slot === 'last'

  if (isLast) {
    sbSelectedLastImgId.value = { ...sbSelectedLastImgId.value, [sb.id]: img.id }
  } else {
    sbSelectedImgId.value = { ...sbSelectedImgId.value, [sb.id]: img.id }
  }

  const list = store.currentEpisode?.storyboards
  if (Array.isArray(list)) {
    const row = list.find((x) => Number(x.id) === Number(sb.id))
    if (row) {
      const now = new Date().toISOString()
      if (isLast) {
        row.last_frame_image_id = img.id
        row.last_frame_image_url = img.image_url || null
        row.last_frame_local_path = img.local_path || null
      } else {
        row.first_frame_image_id = img.id
        row.image_url = img.image_url || null
        row.local_path = img.local_path || null
      }
      row.updated_at = now
    }
  }

  const patch = { updated_at: new Date().toISOString() }
  if (isLast) {
    patch.last_frame_image_id = img.id
    patch.last_frame_image_url = img.image_url || null
    patch.last_frame_local_path = img.local_path || undefined
  } else {
    patch.image_url = img.image_url || null
    patch.local_path = img.local_path || undefined
    patch.first_frame_image_id = img.id
  }

  storyboardsAPI.update(sb.id, patch).catch((e) => console.warn('[参考帧] 保存失败', e))
}

function onSelectSbMainImage(sb, img) {
  onSelectSbFrameImage(sb, img, 'first')
}

async function onRemoveSbHistoryImage(storyboardId, imageGenId) {
  if (!storyboardId || !imageGenId) return
  try {
    await ElMessageBox.confirm('确定删除这张历史参考图？此操作不可恢复。', '删除历史图', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
      distinguishCancelAndClose: true,
    })
    await imagesAPI.delete(imageGenId)
    await loadSingleStoryboardMedia(storyboardId)
    ElMessage.success('历史图已删除')
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') {
      ElMessage.error(err?.message || '删除失败')
    }
  }
}

async function onRemoveSbHistoryVideo(storyboardId, videoGenId) {
  if (!storyboardId || !videoGenId) return
  try {
    await ElMessageBox.confirm('确定删除该分镜视频？此操作不可恢复。', '删除分镜视频', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
      distinguishCancelAndClose: true,
    })
    const wasSelected = sbSelectedVideoId.value[storyboardId] === videoGenId
    delete sbSelectedVideoId.value[storyboardId]
    await videosAPI.delete(videoGenId)
    await loadSingleStoryboardMedia(storyboardId)
    const remaining = getSbAllVideos(storyboardId)
    const nextCurrent = remaining[0] || null
    const row = (store.storyboards || []).find((b) => b.id === storyboardId)
    if (row && (wasSelected || row.selected_video_id === videoGenId)) {
      row.selected_video_id = nextCurrent ? nextCurrent.id : null
      row.video_url = nextCurrent ? (nextCurrent.video_url || '') : null
      await storyboardsAPI.update(storyboardId, {
        selected_video_id: nextCurrent ? nextCurrent.id : null,
        video_url: nextCurrent ? (nextCurrent.video_url || null) : null,
      }).catch(() => {})
    }
    ElMessage.success('分镜视频已删除')
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') {
      ElMessage.error(err?.message || '删除失败')
    }
  }
}

function buildFirstFrameImagePrompt(sbId) {
  const sbRow = (store.storyboards || []).find((b) => b.id === sbId)
  return (sbRow?.polished_prompt || sbRow?.image_prompt || sbRow?.description || '').toString().trim()
}

function buildLastFrameImagePrompt(sbId) {
  const parts = []
  const loc = (sbLocation.value[sbId] || '').toString().trim()
  const time = (sbTime.value[sbId] || '').toString().trim()
  if (loc) parts.push(time ? loc + '，' + time : loc)
  const shotType = (sbShotType.value[sbId] || '').toString().trim()
  if (shotType) parts.push(shotType)
  const angleH = sbAngleH.value[sbId] || ''
  const angleV = sbAngleV.value[sbId] || ''
  const angleS = sbAngleS.value[sbId] || ''
  if (angleH && angleV && angleS) {
    const { label } = angleToPromptFragment(angleH, angleV, angleS)
    parts.push(label)
  }
  const result = (sbResult.value[sbId] || '').toString().trim()
  const action = (sbAction.value[sbId] || '').toString().trim()
  if (result) parts.push(result)
  else if (action) parts.push(action)
  const atmosphere = (sbAtmosphere.value[sbId] || '').toString().trim()
  if (atmosphere) parts.push(atmosphere)
  const style = getSelectedStylePromptZh?.() || getSelectedStylePrompt?.() || ''
  if (style) parts.push(style)
  parts.push('尾帧静止画面，展示动作完成后的最终状态与情绪余韵')
  return parts.join('，')
}

async function onUpscaleSbImage(sb) {
  if (!sb?.id || upscalingSbIds.has(sb.id)) return
  upscalingSbIds.add(sb.id)
  try {
    await storyboardsAPI.upscale(sb.id)
    ElMessage.success('超分完成，图片已更新为高清版本')
    await loadSingleStoryboardMedia(sb.id)
  } catch (e) {
    ElMessage.error(e.message || '超分辨率失败')
  } finally {
    upscalingSbIds.delete(sb.id)
  }
}

function normalizeAudioRelPath(raw) {
  return String(raw != null ? raw : '').trim().replace(/^\//, '')
}

function sbDialogueAudioRelPath(sb) {
  if (!sb?.id) return ''
  const fromCache = sbDialogueAudioPaths.value[sb.id]
  const fromRow = sb.audio_local_path
  const raw = (fromCache != null && String(fromCache).trim() !== '') ? fromCache : (fromRow != null ? fromRow : '')
  return normalizeAudioRelPath(raw)
}

function sbNarrationAudioRelPath(sb) {
  if (!sb?.id) return ''
  const fromCache = sbNarrationAudioPaths.value[sb.id]
  const fromRow = sb.narration_audio_local_path
  const raw = (fromCache != null && String(fromCache).trim() !== '') ? fromCache : (fromRow != null ? fromRow : '')
  return normalizeAudioRelPath(raw)
}

function playSbTtsFromRel(rel) {
  if (!rel) return
  const url = `/static/${rel}`
  try {
    if (sbTtsPreviewAudio) {
      sbTtsPreviewAudio.pause()
      sbTtsPreviewAudio = null
    }
    const a = new Audio(url)
    sbTtsPreviewAudio = a
    a.addEventListener('ended', () => {
      if (sbTtsPreviewAudio === a) sbTtsPreviewAudio = null
    })
    a.play().catch(() => {
      ElMessage.warning('无法播放音频，请检查文件是否存在')
      if (sbTtsPreviewAudio === a) sbTtsPreviewAudio = null
    })
  } catch (_) {
    ElMessage.warning('无法播放音频')
  }
}

function playSbDialogueTts(sb) {
  playSbTtsFromRel(sbDialogueAudioRelPath(sb))
}

function playSbNarrationTts(sb) {
  playSbTtsFromRel(sbNarrationAudioRelPath(sb))
}

async function onTtsSbDialogue(sb) {
  if (!sb?.id || ttsSbIds.has(sb.id)) return
  if (!sb.dialogue?.trim()) {
    ElMessage.warning('该分镜没有对白内容')
    return
  }
  ttsSbIds.add(sb.id)
  try {
    const res = await fetch('/api/v1/audio/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storyboard_id: sb.id, text: sb.dialogue, tts_kind: 'dialogue' }),
    })
    const data = await res.json()
    const businessOk = data.success === true || Number(data.code) === 200
    if (!res.ok || !businessOk) {
      throw new Error(data.error?.message || data.message || '配音失败')
    }
    if (data.data?.local_path) {
      sbDialogueAudioPaths.value = { ...sbDialogueAudioPaths.value, [sb.id]: data.data.local_path }
      sb.audio_local_path = data.data.local_path
      ElMessage.success('配音已生成')
    }
  } catch (e) {
    ElMessage.error(e.message || 'TTS 配音失败')
  } finally {
    ttsSbIds.delete(sb.id)
  }
}

async function onTtsSbNarration(sb) {
  if (!sb?.id || ttsSbNarrationIds.has(sb.id)) return
  const text = ((sbNarration.value[sb.id] ?? sb.narration) || '').toString().trim()
  if (!text) {
    ElMessage.warning('该分镜没有解说旁白内容')
    return
  }
  ttsSbNarrationIds.add(sb.id)
  try {
    const res = await fetch('/api/v1/audio/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storyboard_id: sb.id, text, tts_kind: 'narration' }),
    })
    const data = await res.json()
    const businessOk = data.success === true || Number(data.code) === 200
    if (!res.ok || !businessOk) {
      throw new Error(data.error?.message || data.message || '解说配音失败')
    }
    if (data.data?.local_path) {
      sbNarrationAudioPaths.value = { ...sbNarrationAudioPaths.value, [sb.id]: data.data.local_path }
      sb.narration_audio_local_path = data.data.local_path
      ElMessage.success('解说配音已生成')
    }
  } catch (e) {
    ElMessage.error(e.message || '解说 TTS 失败')
  } finally {
    ttsSbNarrationIds.delete(sb.id)
  }
}

function formatSrtTimestamp(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const z = Math.floor(ms % 1000)
  const p2 = (n) => String(n).padStart(2, '0')
  return `${p2(h)}:${p2(m)}:${p2(s)},${String(z).padStart(3, '0')}`
}

async function onExportStoryboardSheet() {
  const boards = storyboards.value || []
  if (!boards.length) {
    ElMessage.warning('暂无分镜')
    return
  }
  const epNum = store.currentEpisode?.episode_number
  const dramaTitle = (store.drama?.title || 'project').replace(/[\\/:*?"<>|]/g, '_')
  const epLabel = epNum != null ? `第${epNum}集` : `ep${currentEpisodeId.value || '1'}`
  const filenameBase = `${dramaTitle}-${epLabel}-分镜表`
  const useFirstLast = !!storyboardUseFirstLastFrame.value

  exportingStoryboardSheet.value = true
  const framePromptBySbId = {}
  try {
    await Promise.all(
      boards.map(async (sb) => {
        try {
          const res = await storyboardsAPI.getFramePrompts(sb.id)
          const fps = res?.frame_prompts || []
          framePromptBySbId[sb.id] = {
            first: fps.find((r) => r.frame_type === 'first')?.prompt?.trim() || '',
            last: fps.find((r) => r.frame_type === 'last')?.prompt?.trim() || '',
          }
        } catch (_) {
          framePromptBySbId[sb.id] = { first: '', last: '' }
        }
      })
    )
  } finally {
    exportingStoryboardSheet.value = false
  }

  function resolveFirstFramePrompt(sbId) {
    const cached = framePromptBySbId[sbId]?.first
    if (cached) return cached
    const imgPrompt = getSbFirstImage(sbId)?.prompt?.trim()
    if (imgPrompt) return imgPrompt
    if (useFirstLast) return buildFirstFrameImagePrompt(sbId)
    return ''
  }

  function resolveLastFramePrompt(sbId) {
    const cached = framePromptBySbId[sbId]?.last
    if (cached) return cached
    const imgPrompt = getSbLastImage(sbId)?.prompt?.trim()
    if (imgPrompt) return imgPrompt
    if (useFirstLast) return buildLastFrameImagePrompt(sbId)
    return ''
  }

  const result = exportStoryboardSheet(
    {
      storyboards: boards,
      getScene: (sbId) => getSbSelectedScene(sbId),
      getCharacters: (sbId) => getSbSelectedCharacters(sbId),
      getProps: (sbId) => getSbSelectedProps(sbId),
      getMovementLabel,
      getFirstFramePrompt: resolveFirstFramePrompt,
      getLastFramePrompt: resolveLastFramePrompt,
      getField(sb, key) {
        const id = sb.id
        const map = {
          title: sbTitle.value[id],
          location: sbLocation.value[id],
          time: sbTime.value[id],
          duration: sbDuration.value[id] ?? sb.duration,
          dialogue: sbDialogue.value[id],
          narration: sbNarration.value[id],
          action: sbAction.value[id],
          result: sbResult.value[id],
          atmosphere: sbAtmosphere.value[id],
          shot_type: sbShotType.value[id],
          movement: sbMovement.value[id],
          layout_description: sbLayoutDescription.value[id],
          universal_segment_text: sbUniversalSegmentText.value[id],
        }
        if (Object.prototype.hasOwnProperty.call(map, key)) {
          const v = map[key]
          return v != null && v !== '' ? v : sb[key]
        }
        return sb[key]
      },
    },
    filenameBase
  )

  if (!result.ok) {
    ElMessage.warning('当前分镜没有可导出的内容')
    return
  }
  ElMessage.success(`已导出分镜表（${result.count} 个镜头）`)
}

function onExportNarrationSrt() {
  const boards = storyboards.value || []
  if (!boards.length) {
    ElMessage.warning('暂无分镜')
    return
  }
  let tMs = 0
  const lines = []
  let idx = 1
  for (const sb of boards) {
    const durSec = Number(sbDuration.value[sb.id] ?? sb.duration)
    const sec = Number.isFinite(durSec) && durSec > 0 ? durSec : 5
    const durMs = Math.round(sec * 1000)
    const text = ((sbNarration.value[sb.id] ?? sb.narration) || '').toString().trim()
    if (text) {
      const start = formatSrtTimestamp(tMs)
      const end = formatSrtTimestamp(tMs + durMs)
      lines.push(String(idx++), `${start} --> ${end}`, text, '')
    }
    tMs += durMs
  }
  if (!lines.length) {
    ElMessage.warning('当前分镜没有可导出的解说文案')
    return
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `narration-${currentEpisodeId.value || 'episode'}.srt`
  a.click()
  URL.revokeObjectURL(a.href)
  ElMessage.success('已下载解说 SRT')
}

function isSbUniversalMode(sbId) {
  return sbCreationMode.value[sbId] === 'universal'
}

function setSbCreationModeId(sbId, mode) {
  if (sbId == null) return
  const m = mode === 'universal' ? 'universal' : 'classic'
  sbCreationMode.value = { ...sbCreationMode.value, [sbId]: m }
}

async function onToggleSbUniversalMode(sb) {
  if (!sb?.id) return
  const cur = isSbUniversalMode(sb.id) ? 'universal' : 'classic'
  const next = cur === 'universal' ? 'classic' : 'universal'
  sbCreationMode.value = { ...sbCreationMode.value, [sb.id]: next }
  try {
    await storyboardsAPI.update(sb.id, { creation_mode: next })
    const list = store.currentEpisode?.storyboards
    if (Array.isArray(list)) {
      const row = list.find((x) => Number(x.id) === Number(sb.id))
      if (row) row.creation_mode = next
    }
  } catch (e) {
    sbCreationMode.value = { ...sbCreationMode.value, [sb.id]: cur }
    ElMessage.error(e.message || '保存失败')
  }
}

async function onSaveUniversalSegmentField(sb) {
  if (!sb?.id) return
  const next = (sbUniversalSegmentText.value[sb.id] || '').toString()
  const prev = (sb.universal_segment_text || '').toString()
  if (next === prev) return
  try {
    await storyboardsAPI.update(sb.id, { universal_segment_text: next.trim() || null })
    const list = store.currentEpisode?.storyboards
    if (Array.isArray(list)) {
      const row = list.find((x) => Number(x.id) === Number(sb.id))
      if (row) row.universal_segment_text = next.trim() || null
    }
  } catch (_) { /* 静默失败，避免打断输入 */ }
}

function universalSegmentDurationSecForSb(sb) {
  const dUi = Number(sbDuration.value[sb?.id])
  const dRow = Number(sb?.duration)
  const dProj = Number(videoClipDuration?.value)
  return Number.isFinite(dUi) && dUi > 0
    ? dUi
    : Number.isFinite(dRow) && dRow > 0
      ? dRow
      : Number.isFinite(dProj) && dProj > 0
        ? dProj
        : 5
}

function getSbVideoDurationForApi(sb) {
  const perSb = Number(sbDuration.value[sb?.id] ?? sb?.duration)
  if (Number.isFinite(perSb) && perSb > 0) return perSb
  const clip = Number(videoClipDuration?.value)
  if (Number.isFinite(clip) && clip > 0) return clip
  return undefined
}

function buildUniversalSegmentFieldOverrides(sb) {
  if (!sb?.id) return {}
  const id = sb.id
  const trimOrNull = (v) => {
    const s = (v ?? '').toString().trim()
    return s || null
  }
  return {
    title: trimOrNull(sbTitle.value[id] ?? sb.title),
    description: trimOrNull(sb.description),
    location: trimOrNull(sbLocation.value[id] ?? sb.location),
    time: trimOrNull(sbTime.value[id] ?? sb.time),
    action: trimOrNull(sbAction.value[id] ?? sb.action),
    dialogue: trimOrNull(sbDialogue.value[id] ?? sb.dialogue),
    narration: trimOrNull(sbNarration.value[id] ?? sb.narration),
    result: trimOrNull(sbResult.value[id] ?? sb.result),
    atmosphere: trimOrNull(sbAtmosphere.value[id] ?? sb.atmosphere),
    shot_type: trimOrNull(sbShotType.value[id] ?? sb.shot_type),
    movement: trimOrNull(sbMovement.value[id] ?? sb.movement),
    layout_description: trimOrNull(sbLayoutDescription.value[id] ?? sb.layout_description),
  }
}

function universalSegmentAtImageToGrokTags(text) {
  return (text || '').replace(/@图片(\d+)/g, '<IMAGE_$1>')
}

function onUniversalSegmentToGrokVideoTags(sb) {
  if (!sb?.id) return
  const raw = (sbUniversalSegmentText.value[sb.id] ?? '').toString()
  if (!raw.trim()) {
    ElMessage.warning('请先填写或生成片段描述')
    return
  }
  const next = universalSegmentAtImageToGrokTags(raw)
  if (next === raw) {
    ElMessage.info('未找到 @图片N 标记，无需转换')
    return
  }
  sbUniversalSegmentText.value = { ...sbUniversalSegmentText.value, [sb.id]: next }
  void onSaveUniversalSegmentField(sb)
  ElMessage.success('已改为 Grok 视频占位符格式（<IMAGE_N>）')
}

function onUniversalSegmentPromptMenu(sb, cmd) {
  if (cmd === 'generate') onGenerateUniversalSegmentPrompt(sb, {})
  else if (cmd === 'generate-force') onGenerateUniversalSegmentPrompt(sb, { forceWithoutReferenceImages: true })
  else if (cmd === 'polish') onPolishUniversalSegmentPromptStream(sb, {})
  else if (cmd === 'polish-force') onPolishUniversalSegmentPromptStream(sb, { forceWithoutReferenceImages: true })
  else if (cmd === 'to-grok-video-tags') onUniversalSegmentToGrokVideoTags(sb)
}

async function onGenerateUniversalSegmentPrompt(sb, opts = {}) {
  if (!sb?.id || generatingUniversalSegmentIds.has(sb.id)) return
  const force = !!opts.forceWithoutReferenceImages
  generatingUniversalSegmentIds.add(sb.id)
  let live = ''
  try {
    const durationSec = universalSegmentDurationSecForSb(sb)
    const data = await storyboardsAPI.generateUniversalSegmentPromptStream(
      sb.id,
      {
        duration: durationSec,
        field_overrides: buildUniversalSegmentFieldOverrides(sb),
        ...(force ? { force_without_reference_images: true } : {}),
      },
      (delta) => {
        live += delta
        sbUniversalSegmentText.value = { ...sbUniversalSegmentText.value, [sb.id]: live }
      }
    )
    const text = (data?.universal_segment_text ?? '').toString().trim()
    if (!text) {
      ElMessage.warning('未收到完整生成结果，请重试')
      return
    }
    sbUniversalSegmentText.value = { ...sbUniversalSegmentText.value, [sb.id]: text }
    const list = store.currentEpisode?.storyboards
    if (Array.isArray(list)) {
      const row = list.find((x) => Number(x.id) === Number(sb.id))
      if (row) row.universal_segment_text = text
    }
    ElMessage.success(force ? '已强制生成全能片段提示词（无图模式）' : '已根据分镜生成全能片段提示词')
  } catch (e) {
    ElMessage.error(e.message || '生成失败，请检查文本模型配置')
  } finally {
    generatingUniversalSegmentIds.delete(sb.id)
  }
}

async function onPolishUniversalSegmentPromptStream(sb, opts = {}) {
  if (!sb?.id || generatingUniversalSegmentIds.has(sb.id)) return
  const force = !!opts.forceWithoutReferenceImages
  const draft = sbUniversalSegmentTrimmed(sb)
  if (!draft) {
    ElMessage.warning('请先填写或生成片段描述后再润色')
    return
  }
  generatingUniversalSegmentIds.add(sb.id)
  let live = ''
  try {
    const durationSec = universalSegmentDurationSecForSb(sb)
    const data = await storyboardsAPI.polishUniversalSegmentPromptStream(
      sb.id,
      {
        duration: durationSec,
        draft_universal_segment_text: draft,
        field_overrides: buildUniversalSegmentFieldOverrides(sb),
        ...(force ? { force_without_reference_images: true } : {}),
      },
      (delta) => {
        live += delta
        sbUniversalSegmentText.value = { ...sbUniversalSegmentText.value, [sb.id]: live }
      }
    )
    const text = (data?.universal_segment_text ?? '').toString().trim()
    if (!text) {
      ElMessage.warning('未收到完整润色结果，请重试')
      return
    }
    sbUniversalSegmentText.value = { ...sbUniversalSegmentText.value, [sb.id]: text }
    const list = store.currentEpisode?.storyboards
    if (Array.isArray(list)) {
      const row = list.find((x) => Number(x.id) === Number(sb.id))
      if (row) row.universal_segment_text = text
    }
    ElMessage.success(force ? '全能片段已强制润色并保存（无图模式）' : '全能片段提示词已润色并保存')
  } catch (e) {
    ElMessage.error(e.message || '润色失败，请检查文本模型配置')
  } finally {
    generatingUniversalSegmentIds.delete(sb.id)
  }
}

function getSbFirstFrameUrl(sb) {
  const img = storyboardUseFirstLastFrame.value ? getSbFirstImage(sb.id) : getSbImage(sb.id)
  if (img && (img.image_url || img.local_path)) return assetImageUrl(img)
  if (sb.composed_image || sb.image_url) return imageUrl(sb.composed_image || sb.image_url)
  return ''
}

function getSbLastFrameUrl(sb) {
  const img = getSbLastImage(sb.id)
  if (img && (img.image_url || img.local_path)) return assetImageUrl(img)
  if (sb.last_frame_image_url || sb.last_frame_local_path) {
    return assetImageUrl({ image_url: sb.last_frame_image_url, local_path: sb.last_frame_local_path })
  }
  return ''
}

function sbVideoFirstLastUrls(sb, universal, contiguityFirstFrameUrl) {
  let first =
    contiguityFirstFrameUrl ||
    (universal ? '' : toAbsoluteImageUrl(getSbFirstFrameUrl(sb) || ''))
  if (!first && !universal) {
    first = toAbsoluteImageUrl(getSbFirstFrameUrl(sb) || '')
  }
  let last = undefined
  if (storyboardUseFirstLastFrame.value && !universal) {
    const lu = getSbLastFrameUrl(sb)
    if (lu) last = toAbsoluteImageUrl(lu)
  }
  return { first: first || undefined, last }
}

async function getMainImageUrlForVideo(sb) {
  return getSbFirstFrameUrl(sb)
}

function toAbsoluteImageUrl(url) {
  if (!url || !String(url).trim()) return ''
  const s = String(url).trim()
  if (s.startsWith('http://') || s.startsWith('https://')) return s
  const base = (baseUrl.value || '').replace(/\/$/, '') || (typeof window !== 'undefined' ? window.location.origin : '')
  return base ? base + (s.startsWith('/') ? s : '/' + s) : s
}

function sbUniversalSegmentTrimmed(sb) {
  if (!sb?.id) return ''
  return (sbUniversalSegmentText.value[sb.id] ?? sb.universal_segment_text ?? '').toString().trim()
}

function sbCanSubmitVideo(sb) {
  if (!sb) return false
  const vp = (sb.video_prompt || '').toString().trim()
  if (vp) return true
  if (isSbUniversalMode(sb.id)) return !!sbUniversalSegmentTrimmed(sb)
  return false
}

function buildSbVideoPromptForApi(sb, { preferClassicPrompt = false } = {}) {
  const vp = (sb.video_prompt || '').toString().trim()
  const seg = sbUniversalSegmentTrimmed(sb)
  if (preferClassicPrompt) return vp || seg
  if (isSbUniversalMode(sb.id)) {
    if (seg) return seg
    return vp
  }
  return vp
}

function getSbUniversalOmniRefSlots(sb) {
  if (!sb?.id) return []
  const out = []
  let idx = 1
  const scene = getSbSelectedScene(sb.id)
  if (scene && hasAssetImage(scene)) {
    out.push({
      index: idx++,
      kind: 'scene',
      name: (scene.name || '场景').toString(),
      thumbUrl: assetImageUrl(scene),
    })
  }
  for (const c of getSbSelectedCharacters(sb.id)) {
    if (hasAssetImage(c)) {
      out.push({
        index: idx++,
        kind: 'character',
        name: (c.name || '角色').toString(),
        thumbUrl: assetImageUrl(c),
      })
    }
  }
  for (const p of getSbSelectedProps(sb.id)) {
    if (hasAssetImage(p)) {
      out.push({
        index: idx++,
        kind: 'prop',
        name: (p.name || '物品').toString(),
        thumbUrl: assetImageUrl(p),
      })
    }
  }
  return out
}

function collectSbOmniReferenceAbsoluteUrls(sb) {
  if (!sb?.id) return []
  const urls = []
  const seen = new Set()
  function pushAbs(u) {
    const abs = toAbsoluteImageUrl(u)
    if (!abs || seen.has(abs)) return
    seen.add(abs)
    urls.push(abs)
  }
  const scene = getSbSelectedScene(sb.id)
  if (scene && hasAssetImage(scene)) pushAbs(assetImageUrl(scene))
  for (const c of getSbSelectedCharacters(sb.id)) {
    if (hasAssetImage(c)) pushAbs(assetImageUrl(c))
  }
  for (const p of getSbSelectedProps(sb.id)) {
    if (hasAssetImage(p)) pushAbs(assetImageUrl(p))
  }
  return urls.slice(0, 10)
}

function collectSbSceneOnlyReferenceAbsoluteUrls(sb) {
  if (!sb?.id) return []
  const scene = getSbSelectedScene(sb.id)
  if (scene && hasAssetImage(scene)) {
    const abs = toAbsoluteImageUrl(assetImageUrl(scene))
    return abs ? [abs] : []
  }
  return []
}

let activeVideoAiConfigCache = null
let activeVideoAiConfigCacheAt = 0
const ACTIVE_VIDEO_AI_CONFIG_TTL_MS = 15000

async function getActiveVideoAiConfig(preferredModel) {
  if (preferredModel) {
    if (!videoModelConfigs.value.length) await loadVideoModelChoices()
    const selected = videoModelConfigs.value.find(c => (Array.isArray(c.model) ? c.model : [c.model]).includes(preferredModel))
    if (selected) return selected
  }
  const now = Date.now()
  if (activeVideoAiConfigCache && now - activeVideoAiConfigCacheAt < ACTIVE_VIDEO_AI_CONFIG_TTL_MS) {
    return activeVideoAiConfigCache
  }
  try {
    const rows = await aiAPI.list('video')
    const list = Array.isArray(rows) ? rows : []
    const active = list.filter((c) => c.is_active !== false)
    activeVideoAiConfigCache = active.find((c) => c.is_default) || active[0] || null
  } catch {
    activeVideoAiConfigCache = null
  }
  activeVideoAiConfigCacheAt = now
  return activeVideoAiConfigCache
}

async function confirmUniversalNonSeedance2Video() {
  await ElMessageBox.confirm(
    '你当前视频模型不支持多图参考，全能模式将降级：优先用分镜主图，否则仅传场景参考图。是否继续？',
    '全能模式与模型不匹配',
    { confirmButtonText: '继续', cancelButtonText: '取消', type: 'warning' }
  )
}

function onEditSbImagePrompt(sb) {
  if (!sb?.id) return
  editingSbImagePromptId.value = sb.id
  editingSbImagePromptText.value = (sb.image_prompt || '').toString()
}

async function onOpenSbPromptDialog(sb, initialTab = 'image') {
  if (!sb?.id) return
  agentContext.setFocusedTarget({
    type: 'storyboard',
    id: sb.id,
    number: sb.storyboard_number,
    title: sb.title || `第${sb.storyboard_number}镜`,
  })
  sbPromptActiveTab.value = initialTab === 'video' ? 'video' : 'image'
  sbPromptTarget.value = sb
  sbPromptUserFeedback.value = ''
  sbPromptImageText.value = (sb.image_prompt || '').toString()
  sbPromptPolishedText.value = (sb.polished_prompt || '').toString()
  const rawVideo = (sb.video_prompt || '').toString()
  sbPromptVideoText.value = formatVideoPromptForEdit(rawVideo)
  showSbPromptDialog.value = true
  try {
    const fresh = await storyboardsAPI.get(sb.id)
    if (fresh?.id) {
      sbPromptTarget.value = fresh
      sbPromptImageText.value = (fresh.image_prompt || '').toString()
      sbPromptPolishedText.value = (fresh.polished_prompt || '').toString()
      sbPromptVideoText.value = formatVideoPromptForEdit((fresh.video_prompt || '').toString())
    }
  } catch (_) {}
}

function formatVideoPromptForEdit(text) {
  if (!text) return ''
  return text
    .replace(/([。；])\s*(主体|运动|环境|运镜|美学|声音|时长)：/g, '$1\n$2：')
    .replace(/^\s+|\s+$/g, '')
}

async function onPolishSbPrompt() {
  const sb = sbPromptTarget.value
  if (!sb?.id) return
  sbPromptPolishing.value = true
  try {
    const res = await storyboardsAPI.polishPrompt(sb.id, {
      user_feedback: sbPromptUserFeedback.value.trim() || undefined,
    })
    if (res?.polished_prompt) {
      sbPromptPolishedText.value = res.polished_prompt
      ElMessage.success('通用优化提示词已生成')
    }
  } catch (e) {
    ElMessage.error(e.message || '生成失败，请检查文本模型配置')
  } finally {
    sbPromptPolishing.value = false
  }
}

async function onRebuildSbVideoPrompt() {
  const sb = sbPromptTarget.value
  if (!sb?.id) return
  sbPromptRebuilding.value = true
  try {
    const res = await storyboardsAPI.rebuildVideoPrompt(sb.id)
    if (res?.video_prompt) {
      sbPromptVideoText.value = formatVideoPromptForEdit(res.video_prompt)
      ElMessage.success('已按最新分镜参数重建视频提示词')
    }
  } catch (e) {
    ElMessage.error(e.message || '重建失败')
  } finally {
    sbPromptRebuilding.value = false
  }
}

async function onPolishSbVideoPrompt() {
  const sb = sbPromptTarget.value
  if (!sb?.id) return
  sbPromptVideoPolishing.value = true
  const initialText = sbPromptVideoText.value
  sbPromptVideoText.value = ''
  try {
    const res = await storyboardsAPI.polishClassicVideoPromptStream(
      sb.id,
      {
        draft_video_prompt: initialText,
        user_feedback: sbPromptUserFeedback.value.trim() || undefined,
      },
      (delta) => {
        sbPromptVideoText.value += delta
      }
    )
    if (res?.video_prompt) {
      sbPromptVideoText.value = formatVideoPromptForEdit(res.video_prompt)
      ElMessage.success('视频提示词已由 AI 润色优化')
    }
  } catch (e) {
    if (!sbPromptVideoText.value) {
      sbPromptVideoText.value = initialText
    }
    ElMessage.error(e.message || '润色失败，请检查文本模型配置')
  } finally {
    sbPromptVideoPolishing.value = false
  }
}

async function onSaveSbPromptDialog() {
  const sb = sbPromptTarget.value
  if (!sb?.id) return
  sbPromptSaving.value = true
  try {
    const normalizedVideo = (sbPromptVideoText.value || '').replace(/\s+/g, ' ').trim()
    const patch = {
      image_prompt: sbPromptImageText.value.trim() || null,
      polished_prompt: sbPromptPolishedText.value.trim() || null,
      video_prompt: normalizedVideo || null,
    }
    await storyboardsAPI.update(sb.id, patch)
    Object.assign(sb, patch)
    const list = store.currentEpisode?.storyboards
    if (Array.isArray(list)) {
      const row = list.find((x) => Number(x.id) === Number(sb.id))
      if (row) Object.assign(row, patch)
    }
    showSbPromptDialog.value = false
    ElMessage.success('提示词已保存')
  } catch (e) {
    ElMessage.error(e.message || '保存失败')
  } finally {
    sbPromptSaving.value = false
  }
}

async function onSaveSbImagePrompt(sb) {
  if (!sb?.id) return
  const val = (editingSbImagePromptText.value || '').toString().trim() || null
  try {
    await storyboardsAPI.update(sb.id, { image_prompt: val })
    sb.image_prompt = val
    const list = store.currentEpisode?.storyboards
    if (Array.isArray(list)) {
      const row = list.find((x) => Number(x.id) === Number(sb.id))
      if (row) row.image_prompt = val
    }
    editingSbImagePromptId.value = null
    ElMessage.success('图片提示词已保存')
  } catch (e) {
    ElMessage.error(e.message || '保存失败')
  }
}

function onEditSbVideoPrompt(sb) {
  if (!sb?.id) return
  editingSbVideoPromptId.value = sb.id
  editingSbVideoPromptText.value = (sb.video_prompt || '').toString()
}

function angleToPromptFragment(h, v, s) {
  const hDesc = { front:'shooting from the front', front_left:'shooting from front-left at 45-degree angle', left:'shooting from the left side, profile view', back_left:'shooting from back-left at 135-degree angle', back:"shooting from behind, character's back to camera", back_right:'shooting from back-right at 135-degree angle', right:'shooting from the right side, profile view', front_right:'shooting from front-right at 45-degree angle' }
  const vDesc = { worm:"extreme low-angle worm's eye view, camera near ground pointing sharply upward, strong upward perspective distortion, background shows sky/ceiling", low:'low-angle upward shot, camera below eye-line, slight upward tilt, empowering perspective', eye_level:'eye-level shot, neutral perspective, natural horizontal framing', high:"high-angle bird's eye view, camera above looking down, background shows floor/ground with downward perspective distortion" }
  const sDesc = { close_up:'close-up shot (face/bust framing), subject fills most of frame, shallow depth of field, background softly blurred', medium:'medium shot (waist-up to full body), character and immediate surroundings visible, moderate depth of field', wide:'wide shot (full body with environment), subject small relative to scene, deep depth of field, environment context prominent' }
  const hLabel = { front:'正面', front_left:'前左', left:'左侧', back_left:'后左', back:'背面', back_right:'后右', right:'右侧', front_right:'前右' }
  const vLabel = { worm:'虫眼仰', low:'仰拍', eye_level:'平视', high:'俯拍' }
  const sLabel = { close_up:'特写', medium:'中景', wide:'远景' }
  const fragment = [sDesc[s] || sDesc.medium, vDesc[v] || vDesc.eye_level, hDesc[h] || hDesc.front].join(', ')
  const label = `${sLabel[s] || '中景'}·${vLabel[v] || '平视'}·${hLabel[h] || '正面'}`
  return { fragment, label }
}

async function onSaveSbVideoFields(sb) {
  if (!sb?.id) return
  try {
    const patch = {
      title: (sbTitle.value[sb.id] || '').toString().trim() || null,
      location: (sbLocation.value[sb.id] || '').toString().trim() || null,
      time: (sbTime.value[sb.id] || '').toString().trim() || null,
      duration: Number(sbDuration.value[sb.id]) || 5,
      action: (sbAction.value[sb.id] || '').toString().trim() || null,
      dialogue: (sbDialogue.value[sb.id] || '').toString().trim() || null,
      narration: (sbNarration.value[sb.id] || '').toString().trim() || null,
      bgm_prompt: (sbBgmPrompt.value[sb.id] || '').toString().trim() || null,
      atmosphere: (sbAtmosphere.value[sb.id] || '').toString().trim() || null,
      result: (sbResult.value[sb.id] || '').toString().trim() || null,
      angle: (sbAngle.value[sb.id] || '').toString().trim() || null,
      angle_h: sbAngleH.value[sb.id] || null,
      angle_v: sbAngleV.value[sb.id] || null,
      angle_s: sbAngleS.value[sb.id] || null,
      movement: (sbMovement.value[sb.id] || '').toString().trim() || null,
      lighting_style: sbLighting.value[sb.id] || null,
      depth_of_field: sbDof.value[sb.id] || null,
      shot_type: (sbShotType.value[sb.id] || '').toString().trim() || null,
      layout_description: (sbLayoutDescription.value[sb.id] || '').toString().trim() || null,
      creation_mode: sbCreationMode.value[sb.id] === 'universal' ? 'universal' : 'classic',
      universal_segment_text: (sbUniversalSegmentText.value[sb.id] || '').toString().trim() || null,
    }
    await storyboardsAPI.update(sb.id, patch)
    const rebuilt = await storyboardsAPI.rebuildVideoPrompt(sb.id)
    const newVp = (rebuilt?.video_prompt && String(rebuilt.video_prompt).trim()) || ''
    if (newVp) {
      patch.video_prompt = newVp
      videoParamsTarget.value = { ...sb, ...patch }
    }
    Object.assign(sb, patch)
    const list = store.currentEpisode?.storyboards
    if (Array.isArray(list)) {
      const row = list.find((x) => Number(x.id) === Number(sb.id))
      if (row) Object.assign(row, patch)
    }
    ElMessage.success('已保存，视频提示词已按最新规则自动生成')
  } catch (e) {
    ElMessage.error(e.message || '保存失败')
  }
}

async function onSaveSbVideoPrompt(sb) {
  if (!sb?.id) return
  const val = (editingSbVideoPromptText.value || '').toString().trim() || null
  try {
    await storyboardsAPI.update(sb.id, { video_prompt: val })
    sb.video_prompt = val
    const list = store.currentEpisode?.storyboards
    if (Array.isArray(list)) {
      const row = list.find((x) => Number(x.id) === Number(sb.id))
      if (row) row.video_prompt = val
    }
    editingSbVideoPromptId.value = null
    ElMessage.success('视频提示词已保存')
  } catch (e) {
    ElMessage.error(e.message || '保存失败')
  }
}

function onOpenVideoParamsDialog(sb) {
  videoParamsTarget.value = sb
  if (sb?.id && (sbLayoutDescription.value[sb.id] === undefined || sbLayoutDescription.value[sb.id] === '') && sb.layout_description) {
    sbLayoutDescription.value = { ...sbLayoutDescription.value, [sb.id]: sb.layout_description }
  }
  showVideoParamsDialog.value = true
}

function onVideoParamsDialogClosed() {
  const sb = videoParamsTarget.value
  if (!sb?.id) return
  const row = (storyboards.value || []).find((x) => Number(x.id) === Number(sb.id))
  if (!row) return
  sbCreationMode.value = { ...sbCreationMode.value, [sb.id]: row.creation_mode === 'universal' ? 'universal' : 'classic' }
  sbUniversalSegmentText.value = { ...sbUniversalSegmentText.value, [sb.id]: (row.universal_segment_text ?? '').toString() }
}

function countDialogueLinesInSb(sb) {
  const raw = ((sbDialogue.value[sb.id] ?? sb.dialogue) || '').toString().trim()
  if (!raw) return 0
  const matches = raw.match(/[\u4e00-\u9fa5A-Za-z0-9·]{1,16}[：:]/g)
  return matches?.length || (raw ? 1 : 0)
}

function canSplitSbByAudio(sb) {
  if (!sb?.id) return false
  const dialogueCount = countDialogueLinesInSb(sb)
  const hasNarration = !!((sbNarration.value[sb.id] ?? sb.narration) || '').toString().trim()
  return dialogueCount + (hasNarration ? 1 : 0) >= 2
}

async function onSplitSbByAudio(sb) {
  if (!sb?.id) return
  try {
    await ElMessageBox.confirm(
      '将把本镜按「每句对白一条 + 旁白单独一条」拆成多个分镜，原镜变为第一条。已生成的视频不会保留。是否继续？',
      '按对白拆镜',
      { type: 'warning', confirmButtonText: '拆镜', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  splitByAudioLoading.value = true
  try {
    if (showVideoParamsDialog.value && videoParamsTarget.value?.id === sb.id) {
      await onSaveSbVideoFields(sb)
    }
    const res = await storyboardsAPI.splitByAudio(sb.id)
    const n = res?.storyboard_ids?.length ?? 0
    const summary = res?.plans_summary || ''
    showVideoParamsDialog.value = false
    await loadDrama()
    ElMessage.success(summary ? `已拆成 ${n} 条：${summary}` : `已拆成 ${n} 条分镜`)
  } catch (e) {
    ElMessage.error(e.message || '拆镜失败')
  } finally {
    splitByAudioLoading.value = false
  }
}

async function onSaveVideoParams() {
  const sb = videoParamsTarget.value
  if (!sb?.id) return
  videoParamsSaving.value = true
  try {
    await onSaveSbVideoFields(sb)
    showVideoParamsDialog.value = false
  } catch (e) {
    ElMessage.error(e.message || '保存失败')
  } finally {
    videoParamsSaving.value = false
  }
}

async function onBatchInferParams() {
  if (!currentEpisodeId.value) return
  inferringParams.value = true
  try {
    const res = await storyboardsAPI.batchInferParams(currentEpisodeId.value, false)
    await loadDrama()
    ElMessage.success(`摄影参数推断完成，已补全 ${res?.updated ?? 0} 条分镜`)
  } catch (e) {
    ElMessage.error(e.message || '推断失败')
  } finally {
    inferringParams.value = false
  }
}

async function onAuditInvariants() {
  if (!currentEpisodeId.value) return
  auditingInvariants.value = true
  try {
    const res = await ontologyAPI.validateInvariants(currentEpisodeId.value)
    const data = res?.data ?? res
    const audit = data?.audit || {}
    const stats = audit.stats || {}
    const violations = audit.violations || []
    const warnings = audit.warnings || []

    const totalErrors = violations.length
    const totalWarns = warnings.length

    let detailHtml = `
      <div style="font-size: 13px; line-height: 1.6;">
        <p><strong>语义版本:</strong> <code>${data.semantic_revision || 'N/A'}</code></p>
        <p><strong>运镜动感度:</strong> 固定镜头占比 ${(stats.static_ratio * 100 || 0).toFixed(1)}% (门禁上限 15%)</p>
        <p><strong>动感镜头数:</strong> ${stats.dynamic_shots || 0} / ${stats.total_shots || 0}</p>
        <p><strong>无对白已配BGM:</strong> ${stats.silent_with_bgm || 0} / ${stats.silent_shots || 0}</p>
    `

    if (totalErrors > 0) {
      detailHtml += `<p style="color: #f56c6c; margin-top: 8px;"><strong>❌ 质检不通过，发现 ${totalErrors} 处硬门禁冲突:</strong></p><ul style="padding-left: 18px; margin: 4px 0; color: #f56c6c;">`
      for (const v of violations.slice(0, 5)) {
        detailHtml += `<li>分镜 #${v.storyboard_number || '?'}: ${v.message || v.rule}</li>`
      }
      if (violations.length > 5) detailHtml += `<li>...以及其他 ${violations.length - 5} 项</li>`
      detailHtml += `</ul>`
    } else {
      detailHtml += `<p style="color: #67c23a; margin-top: 8px;"><strong>✅ 硬门禁 100% 通过（运镜动感、无对白BGM闭环契约均合格）</strong></p>`
    }

    if (totalWarns > 0) {
      detailHtml += `<p style="color: #e6a23c; margin-top: 6px;"><strong>⚠️ 建议项 (${totalWarns} 处):</strong></p><ul style="padding-left: 18px; margin: 4px 0; color: #e6a23c;">`
      for (const w of warnings.slice(0, 3)) {
        const prefix = w.asset_name
          ? `【${w.asset_type === 'prop' ? '道具' : w.asset_type === 'character' ? '角色' : '场地'} · ${w.asset_name}】: `
          : (w.storyboard_number ? `分镜 #${w.storyboard_number}: ` : '')
        detailHtml += `<li>${prefix}${w.message}</li>`
      }
      if (warnings.length > 3) detailHtml += `<li>...以及其他 ${warnings.length - 3} 项建议</li>`
      detailHtml += `</ul>`
    }
    detailHtml += `</div>`

    ElNotification({
      title: totalErrors === 0 ? '🛡️ 视听本体质检合格' : '⚠️ 视听本体质检未通过',
      message: detailHtml,
      dangerouslyUseHTMLString: true,
      type: totalErrors === 0 ? 'success' : 'warning',
      duration: 10000,
    })
  } catch (e) {
    ElMessage.error(e.message || '质检执行失败')
  } finally {
    auditingInvariants.value = false
  }
}

async function onDirectorRefineSingleShot(sb) {
  if (!sb?.id) return
  try {
    const { value: instruction } = await ElMessageBox.prompt(
      `请输入您对第 ${sb.storyboard_number ?? ''} 镜的导演微调意见。\n智能体将携带【不可变本体世界观（角色外貌/道具真实尺度/场景地标）】与【上一镜连戏快照】，直指您指定的元素进行定向微调：`,
      `🎬 导演智能体 · 定向微调镜头 ${sb.storyboard_number ?? ''}`,
      {
        confirmButtonText: '启动定向微调',
        cancelButtonText: '取消',
        inputPlaceholder: '例如：聚焦特写拔剑，神情严肃，侧逆光，微推运镜，无对白并配紧迫重低音BGM',
        inputType: 'textarea',
        inputPattern: /\S+/,
        inputErrorMessage: '请输入具体的导演调整指令',
      }
    )
    if (!instruction || !instruction.trim()) return

    const loadingInstance = ElLoading.service({
      lock: true,
      text: `🎬 导演智能体正在定向重构第 ${sb.storyboard_number ?? ''} 镜并校验视听契约...`,
      background: 'rgba(0, 0, 0, 0.7)',
    })
    try {
      const res = await ontologyAPI.directorRefineShot(sb.id, instruction.trim())
      const data = res?.data ?? res
      await loadDrama()
      ElNotification({
        title: `🎬 第 ${sb.storyboard_number ?? ''} 镜定向微调完成`,
        message: `已精准更新该镜头动作、运镜(${data?.storyboard?.movement || '动态'})、光影、BGM与生图提示词，时空连戏快照已同步！`,
        type: 'success',
        duration: 5000,
      })
    } finally {
      loadingInstance.close()
    }
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error(err.message || '定向微调失败')
    }
  }
}

async function onDirectorAgentGenerate() {
  if (!currentEpisodeId.value) return
  if (storyboards.value.length > 0) {
    try {
      await ElMessageBox.confirm(
        '导演智能体（Director Agent）将根据剧本及视听本体库（角色/道具/场景空间地标）执行【多步规划 ➔ 场面调度推演 ➔ SHACL运镜与BGM门禁自纠 ➔ 视听契约入库】闭环。当前已有分镜将被覆盖更新，是否继续？',
        '启动导演智能体',
        {
          confirmButtonText: '立即启动导演 Agent',
          cancelButtonText: '取消',
          type: 'warning',
        }
      )
    } catch {
      return
    }
  }

  directorGenerating.value = true
  try {
    const res = await ontologyAPI.directorGenerate(currentEpisodeId.value)
    const taskData = res?.data ?? res
    const taskId = taskData?.task_id
    if (!taskId) {
      throw new Error(taskData?.message || '未能创建导演智能体任务')
    }

    ElMessage.info('🎬 导演智能体推演已在后台启动，正在规划分镜与自纠质检...')
    pollDirectorTask(taskId)
  } catch (e) {
    ElMessage.error(e.message || '导演智能体启动失败')
    directorGenerating.value = false
  }
}

async function pollDirectorTask(taskId) {
  const maxAttempts = 120
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    try {
      const tr = await taskAPI.get(taskId)
      const task = tr?.data ?? tr
      if (!task) continue

      if (task.status === 'completed') {
        directorGenerating.value = false
        await loadDrama()
        const result = task.result || {}
        ElNotification({
          title: '🎬 导演智能体推演完成',
          message: `分镜生成已闭环完成！共生成 ${result.total_shots || 0} 个高质量运镜分镜，门禁通过率 100%，自纠修正 ${result.reflection_repairs || 0} 次。`,
          type: 'success',
          duration: 6000,
        })
        return
      }

      if (task.status === 'failed') {
        directorGenerating.value = false
        ElMessage.error(task.error || '导演智能体推演失败')
        return
      }
    } catch (err) {
      // transient poll error, continue
    }
  }
  directorGenerating.value = false
  ElMessage.warning('导演智能体推演任务仍在后台执行，请稍后刷新查看。')
}

async function onInferCurrentShotParams() {
  const sb = videoParamsTarget.value
  if (!sb?.id || !currentEpisodeId.value) return
  inferringParams.value = true
  try {
    const res = await storyboardsAPI.batchInferParams(currentEpisodeId.value, false)
    await loadDrama()
    const list = store.currentEpisode?.storyboards || []
    const refreshed = list.find((x) => Number(x.id) === Number(sb.id))
    if (refreshed) {
      videoParamsTarget.value = { ...refreshed }
      if (refreshed.lighting_style) sbLighting.value[sb.id] = refreshed.lighting_style
      if (refreshed.depth_of_field) sbDof.value[sb.id] = refreshed.depth_of_field
      if (refreshed.bgm_prompt) sbBgmPrompt.value[sb.id] = refreshed.bgm_prompt
      if (refreshed.movement) sbMovement.value[sb.id] = refreshed.movement
      if (refreshed.angle_h) sbAngleH.value[sb.id] = refreshed.angle_h
      if (refreshed.angle_v) sbAngleV.value[sb.id] = refreshed.angle_v
      if (refreshed.angle_s) sbAngleS.value[sb.id] = refreshed.angle_s
      if (refreshed.shot_type) sbShotType.value[sb.id] = refreshed.shot_type
    }
    ElMessage.success('本分镜视角、灯光、景深与运镜已智能推断补全')
  } catch (e) {
    ElMessage.error(e.message || '推断失败')
  } finally {
    inferringParams.value = false
  }
}

async function onRegenerateLayoutDescription(sb) {
  if (sb && typeof sb === 'object' && sb.__v_isRef) sb = sb.value
  if (!sb?.id) return
  regeneratingLayoutSbIds.add(sb.id)
  try {
    const res = await storyboardsAPI.regenerateLayoutDescription(sb.id)
    const newText = res?.layout_description || res?.data?.layout_description
    if (newText) {
      sbLayoutDescription.value = { ...sbLayoutDescription.value, [sb.id]: newText }
      if (videoParamsTarget.value && videoParamsTarget.value.id === sb.id) {
        videoParamsTarget.value = { ...videoParamsTarget.value, layout_description: newText }
      }
      try { await refreshStoryboardsOnly() } catch (_) {}
      ElMessage.success('布局描述已由 AI 重新优化并保存（已参考上下分镜连贯性）')
    } else {
      ElMessage.warning('AI 未返回有效的布局描述')
    }
  } catch (e) {
    ElMessage.error(e.message || '重新生成布局描述失败')
  } finally {
    regeneratingLayoutSbIds.delete(sb.id)
  }
}

async function onGenerateSbVideo(sb) {
  if (!dramaId.value || !sb?.id || !sbCanSubmitVideo(sb)) return
  const universal = isSbUniversalMode(sb.id)
  let universalOmniApi = universal
  if (universal) {
    const videoCfg = await getActiveVideoAiConfig(selectedShotModel(sb))
    if (!canUseUniversalOmniVideoApi(videoCfg)) {
      try {
        await confirmUniversalNonSeedance2Video()
      } catch {
        return
      }
      universalOmniApi = false
    }
  }
  const omniRefs = universalOmniApi ? collectSbOmniReferenceAbsoluteUrls(sb) : []
  const sceneOnlyRefs = universal && !universalOmniApi ? collectSbSceneOnlyReferenceAbsoluteUrls(sb) : []
  const hasClassicFrame = !!getSbFirstFrameUrl(sb)
  let hasAnyImage = false
  if (universalOmniApi) {
    hasAnyImage = omniRefs.length > 0
  } else if (universal) {
    hasAnyImage = hasClassicFrame || sceneOnlyRefs.length > 0
  } else {
    hasAnyImage = hasClassicFrame
  }
  if (!hasAnyImage) {
    if (!universal) {
      await ElMessageBox.alert(
        '当前为传统模式，生视频需要分镜参考图。请先生成或上传分镜图片后再试。',
        '传统模式缺少分镜图',
        { confirmButtonText: '知道了', type: 'warning' }
      )
      return
    }
    try {
      await ElMessageBox.confirm(
        universalOmniApi
          ? '当前没有可用的参考图（场景/角色/道具等；不含经典分镜主图），将按纯文案提交 Omni-Video（模型以 AI 配置为准），效果可能不稳定。确认继续？'
          : '当前没有分镜主图且无场景参考图，将仅按文字提示词生成视频，效果可能不稳定。确认继续？',
        universalOmniApi ? '全能模式无参考图' : '全能降级无参考图',
        { confirmButtonText: '继续生成', cancelButtonText: '取消', type: 'warning' }
      )
    } catch {
      return
    }
  }
  generatingSbVideoIds.add(sb.id)
  const meta = buildSbGenMeta(sb, GEN_RESOURCE.SB_VIDEO, '分镜视频')
  genStore.markRunning(meta)
  sbVideoErrors.value[sb.id] = ''
  if (sbSelectedVideoId.value[sb.id] != null) {
    const next = { ...sbSelectedVideoId.value }
    delete next[sb.id]
    sbSelectedVideoId.value = next
  }
  storyboardsAPI.update(sb.id, { video_url: null }).catch(() => {})
  let genResTaskId = null
  try {
    let absoluteUrl = ''
    let referenceUrls = undefined
    if (universalOmniApi) {
      referenceUrls = omniRefs.length ? omniRefs : undefined
      absoluteUrl = omniRefs[0] || ''
    } else if (universal) {
      const firstFrameUrl = await getMainImageUrlForVideo(sb)
      absoluteUrl = toAbsoluteImageUrl(firstFrameUrl)
      if (absoluteUrl) {
        referenceUrls = sceneOnlyRefs.length ? sceneOnlyRefs : [absoluteUrl]
      } else {
        referenceUrls = sceneOnlyRefs.length ? sceneOnlyRefs : undefined
        absoluteUrl = sceneOnlyRefs[0] || ''
      }
    } else {
      const firstFrameUrl = await getMainImageUrlForVideo(sb)
      absoluteUrl = toAbsoluteImageUrl(firstFrameUrl)
      referenceUrls = absoluteUrl ? [absoluteUrl] : undefined
    }
    const { first: vFirst, last: vLast } = sbVideoFirstLastUrls(sb, universalOmniApi, null)
    if (!universalOmniApi && vLast && referenceUrls && !referenceUrls.includes(vLast)) {
      referenceUrls = [...referenceUrls, vLast]
    }
    const preferClassicPrompt = universal && !universalOmniApi
    const res = await videosAPI.create({
      drama_id: dramaId.value,
      storyboard_id: sb.id,
      model: selectedShotModel(sb),
      prompt: buildSbVideoPromptForApi(sb, { preferClassicPrompt }),
      image_url: universalOmniApi ? undefined : ((vFirst || absoluteUrl) || undefined),
      first_frame_url: universalOmniApi ? undefined : (vFirst || absoluteUrl || undefined),
      last_frame_url: universalOmniApi ? undefined : vLast,
      reference_image_urls: referenceUrls,
      style: getSelectedStyle(),
      aspect_ratio: projectAspectRatio.value || '16:9',
      resolution: videoResolution.value || undefined,
      duration: getSbVideoDurationForApi(sb),
    })
    if (res?.task_id) {
      genResTaskId = res.task_id
      const pollRes = await pollTask(res.task_id, () => loadSingleStoryboardMedia(sb.id), meta)
      if (pollRes?.status === 'failed') {
        sbVideoErrors.value[sb.id] = pollRes.error || '视频生成失败'
      } else if (pollRes?.status === 'completed') {
        sbVideoErrors.value[sb.id] = ''
        ElMessage.success('视频生成完成')
      } else if (pollRes?.status === 'cancelled') {
        sbVideoErrors.value[sb.id] = '用户已取消'
      }
    } else {
      await loadSingleStoryboardMedia(sb.id)
      ElMessage.success('视频生成已提交，请稍后查看')
    }
  } catch (e) {
    sbVideoErrors.value[sb.id] = e.message || '提交失败'
    ElMessage.error(e.message || '提交失败')
  } finally {
    generatingSbVideoIds.delete(sb.id)
    if (!genStore.isCancelledTask?.(genResTaskId)) {
      genStore.markDone(meta)
    }
    await loadSingleStoryboardMedia(sb.id)
  }
}

async function onResumeSbVideoPoll(sb) {
  if (!sb?.id || isSbVideoGenerating(sb.id)) return
  const failed = getSbResumableFailedVideo(sb.id)
  if (!failed?.id) {
    ElMessage.warning('当前失败记录无法继续查询，请重新生成')
    return
  }
  generatingSbVideoIds.add(sb.id)
  const meta = buildSbGenMeta(sb, GEN_RESOURCE.SB_VIDEO, '继续查询')
  genStore.markRunning(meta)
  sbVideoErrors.value[sb.id] = ''
  try {
    const res = await videosAPI.resumePoll(failed.id)
    const taskId = res?.task_id
    if (!taskId) {
      throw new Error('未返回任务 ID')
    }
    const pollRes = await pollTask(taskId, () => loadSingleStoryboardMedia(sb.id), meta)
    if (pollRes?.status === 'failed') {
      sbVideoErrors.value[sb.id] = pollRes.error || '继续查询失败'
    } else if (pollRes?.status === 'completed') {
      sbVideoErrors.value[sb.id] = ''
      ElMessage.success('视频查询完成')
    } else if (pollRes?.status === 'cancelled') {
      sbVideoErrors.value[sb.id] = '用户已取消'
    }
  } catch (e) {
    sbVideoErrors.value[sb.id] = e.message || '继续查询失败'
    ElMessage.error(e.message || '继续查询失败')
  } finally {
    generatingSbVideoIds.delete(sb.id)
    if (!genStore.isCancelledTask?.(failed?.task_id)) {
      genStore.markDone(meta)
    }
    await loadSingleStoryboardMedia(sb.id)
  }
}

async function onLinkTailFrameToNext(sb) {
  if (!dramaId.value || !sb?.id) return
  const nextSb = getNextStoryboard(sb.id)
  if (!nextSb) {
    ElMessage.warning('已是最后一个分镜，没有下一个分镜可衔接')
    return
  }
  const video = getSbVideo(sb.id)
  if (!video) {
    ElMessage.warning('当前分镜没有视频')
    return
  }
  try {
    await ElMessageBox.confirm(
      `确定将 #${sb.storyboard_number ?? sb.id} 视频的尾帧设为 #${nextSb.storyboard_number ?? nextSb.id} 的首帧？\n原首帧将自动进入历史。`,
      '尾帧衔接',
      { confirmButtonText: '确认执行', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    return
  }
  linkingTailFrameIds.add(sb.id)
  try {
    const data = await storyboardsAPI.linkTailFrame(sb.id, { drama_id: dramaId.value })
    if (data?.error) {
      throw new Error(data.error)
    }
    ElMessage.success(`已将尾帧设为 #${nextSb.storyboard_number ?? nextSb.id} 的首帧`)
    await Promise.all([
      loadSingleStoryboardMedia(sb.id),
      loadSingleStoryboardMedia(nextSb.id)
    ])
  } catch (e) {
    ElMessage.error(e.message || '尾帧衔接失败')
  } finally {
    linkingTailFrameIds.delete(sb.id)
  }
}

async function onLinkFirstFrameToPrev(sb) {
  if (!dramaId.value || !sb?.id) return
  const prevSb = getPrevStoryboard(sb.id)
  if (!prevSb) {
    ElMessage.warning('已是第一个分镜，没有上一个分镜可衔接')
    return
  }
  const video = getSbVideo(sb.id)
  if (!video) {
    ElMessage.warning('当前分镜没有视频')
    return
  }
  try {
    await ElMessageBox.confirm(
      `确定将 #${sb.storyboard_number ?? sb.id} 视频的首帧设为 #${prevSb.storyboard_number ?? prevSb.id} 的尾帧？\n原尾帧将自动进入历史。`,
      '首帧衔接',
      { confirmButtonText: '确认执行', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    return
  }
  linkingFirstFrameIds.add(sb.id)
  try {
    const data = await storyboardsAPI.linkFirstFrame(sb.id, { drama_id: dramaId.value })
    if (data?.error) {
      throw new Error(data.error)
    }
    ElMessage.success(`已将首帧设为 #${prevSb.storyboard_number ?? prevSb.id} 的尾帧`)
    await Promise.all([
      loadSingleStoryboardMedia(sb.id),
      loadSingleStoryboardMedia(prevSb.id)
    ])
  } catch (e) {
    ElMessage.error(e.message || '首帧衔接失败')
  } finally {
    linkingFirstFrameIds.delete(sb.id)
  }
}

async function onUsePrevTailAsFirst(sb) {
  if (!dramaId.value || !sb?.id) return
  const prevSb = getPrevStoryboard(sb.id)
  if (!prevSb) {
    ElMessage.warning('已是第一个分镜，没有上一分镜可取尾帧')
    return
  }
  const prevLastImg = getSbLastImage(prevSb.id)
  if (!prevLastImg) {
    ElMessage.warning(`上一分镜 #${prevSb.storyboard_number ?? prevSb.id} 尚无尾帧图片`)
    return
  }

  usingPrevTailAsFirstIds.add(sb.id)
  try {
    const uploaded = await imagesAPI.upload({
      storyboard_id: sb.id,
      drama_id: dramaId.value,
      image_url: prevLastImg.image_url || '',
      local_path: prevLastImg.local_path || undefined,
      prompt: `上镜尾帧（直接复用 #${prevSb.storyboard_number ?? prevSb.id} 尾帧高清原图）`,
      frame_type: 'storyboard_first'
    })
    if (uploaded?.id) {
      onSelectSbFrameImage(sb, uploaded, 'first')
    }
    ElMessage.success(`已将 #${prevSb.storyboard_number ?? prevSb.id} 尾帧设为本分镜首帧（高清原图）`)

    await Promise.all([
      refreshStoryboardsOnly(),
      loadSingleStoryboardMedia(sb.id)
    ])
    delete sbSelectedImgId.value[sb.id]
  } catch (e) {
    ElMessage.error(e.message || '上镜尾帧设置失败')
  } finally {
    usingPrevTailAsFirstIds.delete(sb.id)
  }
}

async function startBatchDubbing() {
  if (batchDubbingStarting.value) return
  batchDubbingStarting.value = true
  try { await dubbingPanel?.value?.generateAllAudio() }
  finally { batchDubbingStarting.value = false }
}

function speechStatus(sb) { return shotSpeechStatus(sb, speechSummaries.value[sb.id]) }
function defaultShotModel(sb) { return automaticVideoModel(videoModelConfigs.value, speechStatus(sb)) }
function selectedShotModel(sb) { return sb.video_model || defaultShotModel(sb) || undefined }
function videoModelLabel(model) {
  if (/wan2[._-]?2/i.test(model || '')) return 'Wan2.2'
  if (/minimax[_-]?h3/i.test(model || '')) return 'H3'
  return model || '服务默认模型'
}

async function loadVideoModelChoices() {
  try {
    const rows = await aiAPI.list('video')
    videoModelConfigs.value = (Array.isArray(rows) ? rows : []).filter(c => c.is_active !== false && c.is_active !== 0)
  } catch (e) { ElMessage.error(e.message || '视频模型列表加载失败') }
}

async function setShotVideoModel(sb, model) {
  savingVideoModelIds.add(sb.id)
  try {
    await storyboardsAPI.update(sb.id, { video_model: model || null })
    sb.video_model = model || null
    ElMessage.success('分镜视频模型已保存')
  } catch (e) { ElMessage.error(e.message || '视频模型保存失败') }
  finally { savingVideoModelIds.delete(sb.id) }
}

function rememberSpeechSummary(shot) {
  speechSummaries.value[shot.id || shot.storyboard_id] = {
    dialogue: shot.segments.some(s => s.kind === 'dialogue'),
    narration: shot.segments.some(s => s.kind === 'narration') || meaningfulSpeech(shot.narration),
    pending: !!shot.extraction_pending,
    sourceDialogue: shot.dialogue || '', sourceNarration: shot.narration || '', sourceUniversal: shot.universal_segment_text || '',
  }
}

function onSpeechSaved(data) {
  const sb = storyboards.value.find(s => Number(s.id) === Number(data.storyboard_id))
  if (!sb) return
  sb.dialogue = data.dialogue
  sb.narration = data.narration
  sbDialogue.value[sb.id] = data.dialogue
  sbNarration.value[sb.id] = data.narration
  rememberSpeechSummary({ ...data, id: sb.id, universal_segment_text: sb.universal_segment_text })
}

async function onBatchSpeechUpdated() {
  await refreshStoryboardsOnly()
  for (const sb of storyboards.value) {
    sbDialogue.value[sb.id] = sb.dialogue || ''
    sbNarration.value[sb.id] = sb.narration || ''
  }
  await dubbingPanel?.value?.refresh()
}

watch(dramaId, () => { speechSummaries.value = {}; loadVideoModelChoices() }, { immediate: true })

function onOpenSplitDialog(sb) {
  if (!sb?.id) return
  splitTarget.value = sb
  splitCount.value = 2
  splitInstruction.value = ''
  showSplitDialog.value = true
}

async function onExecuteAiSplit() {
  const sb = splitTarget.value
  if (!sb?.id) return
  splitLoading.value = true
  try {
    const res = await storyboardsAPI.aiSplit(sb.id, {
      split_count: splitCount.value,
      instruction: splitInstruction.value.trim() || undefined,
    })
    ElMessage.success(res?.message || `分镜已拆分为 ${res?.count || 2} 个连续镜头`)
    showSplitDialog.value = false
    await loadDrama()
  } catch (e) {
    ElMessage.error(e.message || 'AI 拆分分镜失败，请检查文本模型配置')
  } finally {
    splitLoading.value = false
  }
}

async function onAddSingleStoryboard() {
  const epId = currentEpisodeId.value
  if (!epId) {
    ElMessage.warning('请先选择或创建集数')
    return
  }
  const list = store.storyboards || []
  const maxNum = list.reduce((m, s) => Math.max(m, Number(s.storyboard_number) || 0), 0)
  const nextNum = maxNum + 1
  try {
    const sb = await storyboardsAPI.create({
      episode_id: epId,
      storyboard_number: nextNum,
      title: `镜头 ${nextNum}`,
      duration: 5,
    })
    await loadDrama()
    ElMessage.success(`已添加分镜 ${nextNum}`)
    if (sb?.id) {
      nextTick(() => {
        const el = document.getElementById(`sb-${sb.id}`)
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      })
    }
  } catch (e) {
    ElMessage.error(e.message || '添加分镜失败')
  }
}

async function onInsertStoryboardBefore(sb) {
  if (!sb?.id) return
  try {
    const inserted = await storyboardsAPI.insertBefore(sb.id)
    await loadDrama()
    ElMessage.success('已插入新分镜')
    if (inserted?.id) {
      nextTick(() => {
        const el = document.getElementById(`sb-${inserted.id}`)
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      })
    }
  } catch (e) {
    ElMessage.error(e.message || '插入分镜失败')
  }
}

async function onDeleteSingleStoryboard(sbId) {
  if (!sbId) return
  try {
    await ElMessageBox.confirm('确定要删除该分镜吗？删除后将无法恢复。', '删除分镜', {
      type: 'warning',
      confirmButtonText: '确定删除',
      cancelButtonText: '取消',
    })
    await storyboardsAPI.delete(sbId)
    await loadDrama()
    ElMessage.success('分镜已删除')
  } catch (e) {
    if (e !== 'cancel') {
      ElMessage.error(e.message || '删除分镜失败')
    }
  }
}

function getFirstImageFile(dataTransfer) {
  if (!dataTransfer?.files?.length) return null
  const file = Array.from(dataTransfer.files).find((f) => f.type.startsWith('image/'))
  return file || null
}

function onSbImageDragOver(e, sbId) {
  e.preventDefault()
  e.stopPropagation()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  dragOverSbId.value = sbId
}

function onSbImageDragLeave(e, sbId) {
  e.preventDefault()
  if (e.relatedTarget && e.currentTarget.contains(e.relatedTarget)) return
  if (sbId != null && dragOverSbId.value !== sbId) return
  dragOverSbId.value = null
}

function onSbImageDrop(e, sb) {
  e.preventDefault()
  e.stopPropagation()
  dragOverSbId.value = null
  const file = getFirstImageFile(e.dataTransfer)
  if (file && sb?.id) doUploadSbImage(sb.id, file)
}

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

// 供子组件使用的完整上下文
provide('filmCreateContext', {
  ...ctx,
  speechEditor,
  onSpeechSaved,
  onBatchSpeechUpdated,
  onOpenSbPromptDialog,
  onOpenSplitDialog,
  onOpenVideoParamsDialog,
  onDirectorRefineSingleShot,
  onDirectorAgentGenerate,
  onAddSingleStoryboard,
  onInsertStoryboardBefore,
  onDeleteSingleStoryboard,
  onExportStoryboardSheet,
  onExportNarrationSrt,
  onBatchInferParams,
  onAuditInvariants,
  startBatchImageGeneration,
  stopBatchImageGeneration,
  startBatchVideoGeneration,
  stopBatchVideoGeneration,
  clearBatchVideoErrors,
  retryFailedBatchVideos,
  startBatchDubbing,
  submitShotImageJob,
  onGenerateSbImage,
  onGenerateSbFramePair,
  onGenerateSbFrameImage,
  onGenerateSbVideo,
  onResumeSbVideoPoll,
  onUploadSbImageClick,
  doUploadSbImage,
  onSbImageFileChange,
  onUpscaleSbImage,
  onSelectStripItem,
  onSelectSbFrameImage,
  onSelectSbMainImage,
  onRemoveSbHistoryImage,
  onRemoveSbHistoryVideo,
  openFramePromptEditor,
  showSbFramePromptPreview: openFramePromptEditor,
  saveEditingFramePrompt,
  regenerateEditingFramePrompt,
  onLinkTailFrameToNext,
  onLinkFirstFrameToPrev,
  onUsePrevTailAsFirst,
  canUsePrevTailAsFirst,
  getSbFirstImage,
  getSbLastImage,
  getSbImage,
  getSbLocalImage,
  getSbAllImages,
  getQuadGridImage,
  getSbAllVideos,
  getSbVideo,
  getNextStoryboard,
  getPrevStoryboard,
  getVideoStripItems,
  onSelectSbMainVideo,
  getSbVideoError,
  getSbResumableFailedVideo,
  getStripItems,
  stripItemTitle,
  onStripItemClick,
  quadPanelLabel,
  isSbVideoGenerating,
  hasSbImage,
  hasSbFirstLastPair,
  missingSbImageSlots,
  onStoryboardUseFirstLastFrameChange,
  onLastFrameLayoutLockChange,
  onStoryboardCharacterChange,
  onStoryboardPropChange,
  onStoryboardSceneChange,
  getSbCharacterIds,
  setSbCharacterIds,
  charactersAvailableToAddToSb,
  onSbAddCharacterCommand,
  getSbPropIds,
  setSbPropIds,
  getSbSelectedCharacters,
  getSbSelectedScene,
  getSbSelectedProps,
  onSaveSbNarrationField,
  isSbUniversalMode,
  setSbCreationModeId,
  onToggleSbUniversalMode,
  onSaveUniversalSegmentField,
  universalSegmentDurationSecForSb,
  getSbVideoDurationForApi,
  buildUniversalSegmentFieldOverrides,
  universalSegmentAtImageToGrokTags,
  onUniversalSegmentToGrokVideoTags,
  onUniversalSegmentPromptMenu,
  onGenerateUniversalSegmentPrompt,
  onPolishUniversalSegmentPromptStream,
  getMainImageUrlForVideo,
  toAbsoluteImageUrl,
  sbUniversalSegmentTrimmed,
  sbCanSubmitVideo,
  buildSbVideoPromptForApi,
  getSbUniversalOmniRefSlots,
  collectSbOmniReferenceAbsoluteUrls,
  collectSbSceneOnlyReferenceAbsoluteUrls,
  getActiveVideoAiConfig,
  confirmUniversalNonSeedance2Video,
  onEditSbImagePrompt,
  onEditSbVideoPrompt,
  formatVideoPromptForEdit,
  onPolishSbPrompt,
  onRebuildSbVideoPrompt,
  onPolishSbVideoPrompt,
  onSaveSbPromptDialog,
  onSaveSbImagePrompt,
  angleToPromptFragment,
  onSaveSbVideoFields,
  onSaveSbVideoPrompt,
  onVideoParamsDialogClosed,
  countDialogueLinesInSb,
  canSplitSbByAudio,
  onSplitSbByAudio,
  onSaveVideoParams,
  onInferCurrentShotParams,
  onRegenerateLayoutDescription,
  onTtsSbDialogue,
  playSbDialogueTts,
  sbDialogueAudioRelPath,
  onTtsSbNarration,
  playSbNarrationTts,
  sbNarrationAudioRelPath,
  loadVideoModelChoices,
  setShotVideoModel,
  videoModelLabel,
  defaultShotModel,
  selectedShotModel,
  speechStatus,
  onSbImageDragOver,
  onSbImageDragLeave,
  onSbImageDrop,
  uploadingSbImageSlot,
  dragOverSbId,
  uploadingSbImageId,
  upscalingSbIds,
  ttsSbIds,
  ttsSbNarrationIds,
  linkingFirstFrameIds,
  linkingTailFrameIds,
  usingPrevTailAsFirstIds,
  savingVideoModelIds,
  videoModelChoices,
  getMovementLabel,
})
</script>

<style scoped>
.storyboard-workbench {
  display: contents;
}

.sb-split-dialog-body { padding: 4px 0; }
.sb-split-info-card { background: #18181b; border: 1px solid #27272a; border-radius: 8px; padding: 12px; font-size: 13px; line-height: 1.5; }
.sb-split-info-row { display: flex; align-items: flex-start; gap: 6px; }
.sb-split-info-label { font-weight: 600; color: #a1a1aa; flex-shrink: 0; }
.sb-split-info-val { color: #f4f4f5; }

.sb-video-prompt-label {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 10px 0 6px;
}
.sb-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--el-color-primary);
  flex-shrink: 0;
}
.sb-video-prompt-label > span:not(.sb-dot) { font-size: 0.85rem; color: #e4e4e7; }
.sb-video-params-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.sb-video-params-bar .sb-video-prompt-text {
  flex: 1;
  margin-bottom: 0;
}
.sb-video-prompt-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.sb-video-prompt-row .sb-video-prompt-text {
  flex: 1;
}
.vp-dialog-form .el-form-item {
  margin-bottom: 12px;
}
.sb-video-prompt-text {
  font-size: 0.85rem;
  color: #a1a1aa;
  line-height: 1.4;
  margin-bottom: 6px;
}
.sb-video-prompt-text--preview {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sb-video-prompt-edit {
  margin-bottom: 8px;
}
.sb-video-prompt-edit .el-textarea { margin-bottom: 8px; }
.sb-video-prompt-edit-actions { display: flex; gap: 8px; }
.sb-generate-video-btn { margin-top: 8px; }
.sb-prompt-label { display: flex; align-items: center; gap: 8px; margin: 10px 0 6px; }
.sb-prompt-label .sb-dot { flex-shrink: 0; }
.sb-prompt-label > span:not(.sb-dot) { font-size: 0.85rem; color: #e4e4e7; }
.sb-prompt-row { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 6px; }
.sb-prompt-row .sb-prompt-text { flex: 1; min-width: 0; font-size: 0.85rem; color: #a1a1aa; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.sb-image-prompt-edit .el-textarea { margin-bottom: 6px; }
.sb-prompt-edit-actions { display: flex; gap: 8px; }
.sb-video-fields-collapse { margin: 8px 0; }
.sb-video-fields-collapse .el-collapse-item__header { font-size: 0.9rem; }
.sb-prompt-section-title { font-size: 0.9rem; font-weight: 600; color: #e4e4e7; margin-bottom: 8px; }
.sb-prompt-section-title--row { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.vp-video-prompt-hint { font-size: 12px; color: #909399; line-height: 1.5; }
.sb-split-audio-tip { font-size: 12px; color: #64748b; line-height: 1.45; margin: 0 0 8px; }
.sb-split-audio-row { display: flex; flex-direction: column; align-items: flex-start; }
.sb-prompt-dialog-form .el-form-item { margin-bottom: 10px; }
.sb-collapse-title { color: #a1a1aa; }
.sb-video-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 16px; padding: 8px 0; }
.sb-field { display: flex; flex-direction: column; gap: 4px; }
.sb-field-full { grid-column: 1 / -1; }
.sb-field-label { font-size: 0.8rem; color: #a1a1aa; }
.sb-field-select { width: 100%; }
.sb-video-fields-actions { grid-column: 1 / -1; margin-top: 8px; }

.sb-truncated-warning {
  margin: 10px 0 16px;
  padding: 10px 14px;
  background: rgba(234, 179, 8, 0.12);
  border: 1px solid rgba(234, 179, 8, 0.35);
  border-radius: 8px;
  display: flex;
  align-items: center;
  gap: 10px;
  color: #fbbf24;
  font-size: 0.875rem;
}
.sb-truncated-warning .el-icon {
  font-size: 1.1rem;
  flex-shrink: 0;
}
.sb-truncated-warning span {
  flex: 1;
}

.sb-generating-tip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  margin-top: 12px;
  background: rgba(99, 102, 241, 0.08);
  border: 1px dashed rgba(99, 102, 241, 0.35);
  border-radius: 8px;
}
.sb-gen-text {
  font-size: 0.85rem;
  color: #a5b4fc;
}
.sb-gen-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #6366f1;
  animation: sb-pulse 1.2s infinite ease-in-out;
}
.sb-gen-dot:nth-child(1) { animation-delay: 0s; }
.sb-gen-dot:nth-child(2) { animation-delay: 0.2s; }
.sb-gen-dot:nth-child(3) { animation-delay: 0.4s; }

@keyframes sb-pulse {
  0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
  40% { transform: scale(1); opacity: 1; }
}

.sb-config-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px;
  margin-bottom: 12px;
}
.sb-config-item {
  display: flex;
  align-items: center;
  gap: 8px;
}
.sb-config-label {
  font-size: 0.85rem;
  color: #a1a1aa;
  white-space: nowrap;
}
.sb-config-input {
  width: 110px;
}
.sb-config-hint {
  font-size: 0.8rem;
  color: #71717a;
}
.sb-config-hint--estimate {
  color: #a1a1aa;
  cursor: help;
}
.sb-config-divider {
  width: 1px;
  height: 16px;
  background: #3f3f46;
}
.sb-narration-export-row :deep(.el-checkbox__label) {
  font-size: 0.85rem;
}
.sb-narration-export-row :deep(.el-checkbox) {
  margin-right: 0;
}
.sb-export-srt-btn.el-button--primary.is-plain {
  color: #38bdf8;
  border-color: rgba(56, 189, 248, 0.4);
  background: rgba(56, 189, 248, 0.08);
}
.sb-export-srt-btn.el-button--primary.is-plain:hover {
  color: #fff;
  background: #0284c7;
  border-color: #0284c7;
}
html.light .sb-export-srt-btn.el-button--primary.is-plain {
  color: #0284c7;
  border-color: rgba(2, 132, 199, 0.45);
  background: rgba(2, 132, 199, 0.08);
}
.sb-narration-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}
.sb-narration-input :deep(.el-textarea__inner) {
  font-size: 0.82rem;
  line-height: 1.45;
  color: #cbd5e1;
}
.sb-narration-input :deep(.el-textarea__inner::placeholder) {
  color: #64748b;
}

.frame-prompt-editor-body {
  padding: 4px 0;
}
.frame-prompt-editor-hint {
  font-size: 13px;
  color: #a1a1aa;
  margin-bottom: 12px;
  line-height: 1.5;
}
.frame-prompt-editor-textarea :deep(.el-textarea__inner) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.6;
}

.frame-layout-anchor {
  background: rgba(99, 102, 241, 0.08);
  border: 1px solid rgba(99, 102, 241, 0.35);
  border-radius: 6px;
  padding: 8px 12px;
  margin-bottom: 12px;
}
.frame-layout-anchor-label {
  font-size: 12px;
  font-weight: 600;
  color: #818cf8;
  margin-bottom: 4px;
}
.frame-layout-anchor-text {
  font-size: 13px;
  color: #e2e8f0;
  line-height: 1.5;
}
.frame-layout-anchor-note {
  font-size: 11px;
  color: #94a3b8;
  margin-top: 4px;
}

.empty-tip {
  color: #5a5a66;
  font-size: 0.9rem;
  padding: 16px 0;
}
html.light .empty-tip {
  color: #9ca3af;
}

.storyboard-generating-tip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  margin-top: 12px;
  background: rgba(99, 102, 241, 0.08);
  border: 1px dashed rgba(99, 102, 241, 0.35);
  border-radius: 8px;
  font-size: 0.85rem;
  color: #a5b4fc;
}
</style>
