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
      <GenerationJobs ref="storyboardJobsPanel" :drama-id="dramaId" :episode-id="currentEpisodeId" kinds="storyboards,omni_polish" @updated="onGenerationJobsUpdated" />
      <StoryboardBatchToolbar
        v-model:storyboard-count="storyboardCount"
        v-model:video-duration="videoDuration"
        v-model:grid-mode="gridMode"
        v-model:video-frame-contiguity="videoFrameContiguity"
        :storyboard-use-first-last-frame="storyboardUseFirstLastFrame"
        :has-storyboards="storyboards.length > 0"
        :has-episode="!!currentEpisodeId"
        :planning-warning="directorPlanningWarning"
        :script-estimate-storyboard-title="scriptEstimateStoryboardTitle"
        :script-estimate-storyboard-hint="scriptEstimateStoryboardHint"
        :script-estimate-video-duration-title="scriptEstimateVideoDurationTitle"
        :script-estimate-video-duration-hint="scriptEstimateVideoDurationHint"
        :director-generating="isAnyDirectorGenerating"
        :storyboard-generating="storyboardGenerating"
        :universal-omni-polish-running="universalOmniPolishRunning"
        :inferring-params="inferringParams"
        :auditing-invariants="auditingInvariants"
        :batch-image-running="batchImageRunning"
        :batch-video-running="batchVideoRunning"
        :batch-image-stopping="batchImageStopping"
        :batch-video-stopping="batchVideoStopping"
        :pipeline-running="pipelineRunning"
        :single-shot-image-info="singleShotImageInfo"
        :batch-image-progress="batchImageProgress"
        :batch-video-progress="batchVideoProgress"
        :batch-image-errors="batchImageErrors"
        :batch-video-errors="batchVideoErrors"
        :batch-video-submitting="batchVideoSubmitting"
        :exporting-storyboard-sheet="exportingStoryboardSheet"
        @save-settings="saveProjectSettings"
        @director-generate="onDirectorAgentGenerate()"
        @add-storyboard="onAddSingleStoryboard"
        @batch-infer-params="onBatchInferParams"
        @audit-invariants="onAuditInvariants"
        @start-batch-image="startBatchImageGeneration"
        @start-batch-video="startBatchVideoGeneration"
        @stop-batch-image="stopBatchImageGeneration"
        @stop-batch-video="stopBatchVideoGeneration"
        @clear-media="onClearEpisodeMedia"
        @clear-storyboards="onClearEpisodeStoryboards"
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
            :disabled="pipelineRunning || storyboardGenerating || universalOmniPolishRunning || isAnyDirectorGenerating"
            @updated="onBatchSpeechUpdated"
          />
        </template>
      </StoryboardBatchToolbar>
      <div v-if="directorRunForDisplay" class="director-run-audit">
        <div class="director-run-audit__header">
          <el-tag size="small" :type="directorRunTagType(directorRunForDisplay.status)">
            {{ directorRunStatusLabel(directorRunForDisplay.status) }}
          </el-tag>
          <strong>导演分镜版本 {{ latestDirectorRunVersion }}</strong>
          <span class="director-run-audit__time">开始：{{ formatTaskTime(latestDirectorRun.created_at) }}</span>
          <span v-if="latestDirectorRun.completed_at" class="director-run-audit__time">完成：{{ formatTaskTime(latestDirectorRun.completed_at) }}</span>
          <span v-if="latestDirectorRunResult.total_shots" class="director-run-audit__badge">{{ latestDirectorRunResult.total_shots }} 镜</span>
          <span v-if="latestDirectorRunResult.planning_mode" class="director-run-audit__badge">规划：{{ latestDirectorRunResult.planning_mode }}</span>
          <span v-if="latestDirectorRunResult.reflection_repairs != null" class="director-run-audit__badge">ReAct 修复：{{ latestDirectorRunResult.reflection_repairs }} 次</span>
        </div>
        <div v-if="['pending', 'processing', 'running'].includes(directorRunForDisplay.status)" class="director-run-audit__progress">
          <el-progress :percentage="Math.max(0, Math.min(100, Number(effectiveDirectorProgress) || 0))" :stroke-width="8" :show-text="false" />
          <span>{{ effectiveDirectorMessage || '导演智能体正在后台推演...' }}</span>
        </div>
        <div v-if="latestDirectorRunResult.token_usage" class="director-run-audit__usage">
          <el-tooltip v-if="latestDirectorRunResult.token_usage" placement="top">
            <template #content>
              <div>累计本任务规划、生成与自纠请求；缓存和推理 Token 已包含在输入／输出中。</div>
              <div v-for="stage in latestDirectorRunResult.token_usage.stages" :key="`${stage.agent}/${stage.model}`">
                {{ stage.agent }} · {{ stage.model }}：{{ stage.total_tokens.toLocaleString() }} Token（{{ stage.requests }} 次请求）
              </div>
            </template>
            <span class="director-run-audit__usage-text">
              Token{{ latestDirectorRunResult.token_usage.unreported_requests ? '（已知部分）' : '' }}：{{ latestDirectorRunResult.token_usage.total_tokens.toLocaleString() }}
              · 输入 {{ latestDirectorRunResult.token_usage.input_tokens.toLocaleString() }}
              / 输出 {{ latestDirectorRunResult.token_usage.output_tokens.toLocaleString() }}
              · {{ latestDirectorRunResult.token_usage.requests }} 次请求
              <template v-if="latestDirectorRunResult.token_usage.unreported_requests">（{{ latestDirectorRunResult.token_usage.unreported_requests }} 次未返回用量）</template>
            </span>
          </el-tooltip>
        </div>
        <el-alert v-if="directorRunForDisplay.status === 'failed' && latestDirectorRun.error" :title="latestDirectorRun.error" type="error" :closable="false" show-icon />
        <div v-if="directorRunForDisplay.status === 'failed' && latestDirectorRun.checkpoint?.available" class="director-run-audit__checkpoint">
          <div>
            <strong>已保存断点</strong>
            <span>{{ latestDirectorRun.checkpoint.stage }} · {{ latestDirectorRun.checkpoint.completed_shots }} 镜初稿</span>
            <small>继续任务会沿用原规划；需要改变镜头数量或节奏，请重新生成。</small>
          </div>
          <el-button type="primary" size="small" :disabled="isAnyDirectorGenerating" :loading="directorGenerating" @click="onDirectorAgentGenerate(latestDirectorRun.id)">继续失败任务</el-button>
        </div>
        <div class="director-run-audit__id" :title="latestDirectorRun.id">任务 {{ latestDirectorRun.id }}</div>
      </div>
      <div v-if="storyboardGenerating || universalOmniPolishRunning || isAnyDirectorGenerating" class="storyboard-generating-tip">
        <el-icon class="is-loading"><Loading /></el-icon>
        <span v-if="isAnyDirectorGenerating">
          🎬 导演智能体推演中{{ effectiveDirectorProgress ? ` (${effectiveDirectorProgress}%)` : '' }}：{{ effectiveDirectorMessage || '正在规划场面调度、机位构图与动感运镜，请稍候...' }}
        </span>
        <span v-else-if="universalOmniPolishRunning">
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
      <div v-if="storyboards.length > 0" class="storyboard-cards-list">
        <template v-for="(sb, i) in storyboards" :key="sb.id">
          <StoryboardCard :sb="sb" :index="i" :storyboards="storyboards" />
        </template>
      </div>
      <div v-if="storyboards.length === 0 && !storyboardGenerating && !universalOmniPolishRunning && !isAnyDirectorGenerating" class="empty-tip">请先生成分镜</div>
    </section>

    <StoryboardSpeechEditor ref="speechEditor" :drama-id="dramaId" @saved="onSpeechSaved" />

    <!-- 分镜提示词编辑弹窗 -->
    <el-dialog
      v-model="showSbPromptDialog"
      :title="`分镜 ${sbPromptTarget?.storyboard_number ?? ''} · ${sbPromptActiveTab === 'image' ? '编辑图片提示词' : '编辑视频提示词与多模态时间线'}`"
      width="1160px"
      class="sb-prompt-dialog"
      top="3vh"
      @close="sbPromptTarget = null"
    >
      <el-tabs v-model="sbPromptActiveTab" class="sb-prompt-tabs">
        <el-tab-pane label="🖼 图片提示词与构图槽位" name="image">
          <el-form v-if="sbPromptTarget" label-width="0" class="sb-prompt-dialog-form">
            <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;">
              <el-radio-group v-model="sbPromptImageSubTab" size="small">
                <el-radio-button label="slots">📋 首帧构图与视觉槽位 (Visual Slots)</el-radio-button>
                <el-radio-button label="preview">📝 图片提示词分层预览 (Prompt Text)</el-radio-button>
              </el-radio-group>
              <div style="display:flex; align-items:center; gap:8px;">
                <el-button
                  size="small"
                  type="info"
                  plain
                  :loading="sbPromptImageRebuilding"
                  @click="onRebuildSbImagePrompt"
                >按分镜参数重新编译</el-button>
                <el-button
                  size="small"
                  type="warning"
                  plain
                  :loading="sbPromptPolishing"
                  @click="onPolishSbPrompt"
                >{{ sbPromptPolishedText ? '🎬 重新导演优化' : '🎬 导演本体优化' }}</el-button>
              </div>
            </div>

            <!-- 子视图 1：结构化首帧构图与视觉槽位 -->
            <div v-show="sbPromptImageSubTab === 'slots'" class="sb-slots-view">
              <div v-if="sbPromptVisualSlots" class="sb-slots-timeline-container">
                <!-- 1. 场景空间与环境纵深卡片 -->
                <div class="sb-slot-shot-card">
                  <div class="sb-slot-shot-header">
                    <div class="sb-slot-shot-title">
                      <span class="sb-slot-shot-badge" style="background:#0284c7;">🏞️ 场景空间与三层纵深</span>
                      <el-input v-model="sbPromptVisualSlots.location" size="small" style="width:240px;" placeholder="场景位置" @input="syncVisualSlotsToPromptPreview" />
                    </div>
                    <div style="display:flex; align-items:center; gap:6px;">
                      <span style="font-size:12px; color:#6b7280;">时间与光照:</span>
                      <el-input v-model="sbPromptVisualSlots.time" size="small" style="width:130px;" placeholder="如：阴天白昼" @input="syncVisualSlotsToPromptPreview" />
                    </div>
                  </div>
                  <div class="sb-slot-action-row">
                    <span class="sb-slot-field-label">空间三层纵深（前景遮挡/中景聚焦/后景灭点）：</span>
                    <el-input
                      v-model="sbPromptVisualSlots.environment_depth"
                      size="small"
                      placeholder="空间三层纵深层次分明：前景轻微遮挡虚化引线，中景主体聚焦清晰，后景延伸至深邃视觉灭点"
                      @input="syncVisualSlotsToPromptPreview"
                    />
                  </div>
                  <div style="display:flex; align-items:center; gap:8px; margin-top:6px;">
                    <span class="sb-slot-field-label" style="width:105px; flex-shrink:0;">视听构图关系：</span>
                    <el-select
                      v-model="sbPromptVisualSlots.dialogue_framing"
                      size="small"
                      filterable
                      allow-create
                      default-first-option
                      style="flex:1;"
                      placeholder="选择或输入构图关系"
                      @change="syncVisualSlotsToPromptPreview"
                    >
                      <el-option value="two_shot_face_to_face" label="two_shot_face_to_face (双人面对面对视中景)" />
                      <el-option value="over_the_shoulder" label="over_the_shoulder (经典过肩拍，前虚后实)" />
                      <el-option value="single_reaction_offscreen" label="single_reaction_offscreen (单人近景目光看画外)" />
                      <el-option value="joint_observation" label="joint_observation (双人同向警戒或看大屏)" />
                      <el-option value="solo_action" label="solo_action (单人动作无对话)" />
                    </el-select>
                  </div>
                </div>

                <!-- 2. 机位景别与摄影参数卡片 -->
                <div class="sb-slot-shot-card">
                  <div class="sb-slot-section-subtitle">🎥 机位景别与电影光学镜头参数：</div>
                  <div style="display:grid; grid-template-columns: repeat(5, 1fr); gap:10px; margin-top:6px;">
                    <div>
                      <span class="sb-slot-mini-label">景别</span>
                      <el-select v-model="sbPromptVisualSlots.shot_type" size="small" style="width:100%" @change="syncVisualSlotsToPromptPreview">
                        <el-option value="大远景" label="大远景 (Extreme Wide)" />
                        <el-option value="远景" label="远景 (Wide Shot)" />
                        <el-option value="中景" label="中景 (Medium Shot)" />
                        <el-option value="近景" label="近景 (Close-up)" />
                        <el-option value="特写" label="特写 (Extreme Close-up)" />
                      </el-select>
                    </div>
                    <div>
                      <span class="sb-slot-mini-label">俯仰角度</span>
                      <el-select v-model="sbPromptVisualSlots.angle_v" size="small" style="width:100%" @change="syncVisualSlotsToPromptPreview">
                        <el-option value="eye_level" label="平视 (Eye Level)" />
                        <el-option value="low" label="仰拍 (Low Angle)" />
                        <el-option value="high" label="俯拍 (High Angle)" />
                        <el-option value="worm" label="极低仰拍 (Worm's Eye)" />
                        <el-option value="top_down" label="顶拍 (Top Down)" />
                      </el-select>
                    </div>
                    <div>
                      <span class="sb-slot-mini-label">水平机位</span>
                      <el-select v-model="sbPromptVisualSlots.angle_h" size="small" style="width:100%" @change="syncVisualSlotsToPromptPreview">
                        <el-option value="front" label="正面 (Front)" />
                        <el-option value="front_left" label="前左 45°" />
                        <el-option value="front_right" label="前右 45°" />
                        <el-option value="left" label="左侧 (Left Profile)" />
                        <el-option value="right" label="右侧 (Right Profile)" />
                        <el-option value="back" label="背向 (Back View)" />
                      </el-select>
                    </div>
                    <div>
                      <span class="sb-slot-mini-label">景深</span>
                      <el-select v-model="sbPromptVisualSlots.depth_of_field" size="small" style="width:100%" @change="syncVisualSlotsToPromptPreview">
                        <el-option value="shallow" label="浅景深 (背景虚化)" />
                        <el-option value="medium" label="中景深 (自然过渡)" />
                        <el-option value="deep" label="大景深 (全景深清晰)" />
                        <el-option value="extreme_shallow" label="超浅景深 (特写微距)" />
                      </el-select>
                    </div>
                    <div>
                      <span class="sb-slot-mini-label">画面尺度</span>
                      <el-input v-model="sbPromptVisualSlots.angle_s" size="small" placeholder="medium / close_up" @input="syncVisualSlotsToPromptPreview" />
                    </div>
                  </div>
                  <div style="margin-top:8px;">
                    <span class="sb-slot-mini-label">电影级镜头规格</span>
                    <el-input v-model="sbPromptVisualSlots.cinematic_lens" size="small" placeholder="如：50mm经典电影大师镜头·f/2.8标准视场角·通透写实质感" @input="syncVisualSlotsToPromptPreview" />
                  </div>
                </div>

                <!-- 3. 出场角色构图、姿态与视线槽位 (Character Visual Slots) -->
                <div class="sb-slot-chars-container">
                  <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;">
                    <span class="sb-slot-section-subtitle" style="margin-bottom:0;">👤 出场角色空间站位、朝向与微表情槽位：</span>
                    <el-tag size="small" type="success">严格出场人数：{{ sbPromptVisualSlots.character_visuals?.length || 0 }} 人</el-tag>
                  </div>
                  <div v-if="sbPromptVisualSlots.character_visuals && sbPromptVisualSlots.character_visuals.length" style="display:flex; flex-direction:column; gap:8px;">
                    <div
                      v-for="(c, cIdx) in sbPromptVisualSlots.character_visuals"
                      :key="c.name || cIdx"
                      class="sb-slot-char-card"
                    >
                      <div class="sb-slot-char-name" style="font-weight:600; color:#1e293b; display:flex; align-items:center; gap:6px;">
                        <span>「{{ c.name }}」</span>
                        <span style="font-size:11px; color:#64748b; font-weight:normal;">出场角色 #{{ cIdx + 1 }}</span>
                      </div>
                      <div class="sb-slot-char-grid" style="grid-template-columns: repeat(4, 1fr); gap:8px; margin-top:4px;">
                        <div>
                          <span class="sb-slot-mini-label">角色 ID</span>
                          <el-input-number v-model="c.character_id" size="small" controls-position="right" style="width:100%" />
                        </div>
                        <div>
                          <span class="sb-slot-mini-label">景深层级</span>
                          <el-input v-model="c.depth_layer" size="small" placeholder="foreground / midground / background" @input="syncVisualSlotsToPromptPreview" />
                        </div>
                        <div>
                          <span class="sb-slot-mini-label">画面位置</span>
                          <el-input v-model="c.screen_position" size="small" placeholder="如：画面左侧前景" @input="syncVisualSlotsToPromptPreview" />
                        </div>
                        <div>
                          <span class="sb-slot-mini-label">环境锚点</span>
                          <el-input v-model="c.environmental_anchor" size="small" placeholder="如：破棚木柱旁" @input="syncVisualSlotsToPromptPreview" />
                        </div>
                      </div>
                      <div class="sb-slot-char-grid" style="grid-template-columns: repeat(4, 1fr); gap:8px; margin-top:6px;">
                        <div>
                          <span class="sb-slot-mini-label">空间站位锚点</span>
                          <el-input v-model="c.spatial_anchor" size="small" placeholder="画面左侧前景近景" @input="syncVisualSlotsToPromptPreview" />
                        </div>
                        <div>
                          <span class="sb-slot-mini-label">身体朝向</span>
                          <el-input v-model="c.facing" size="small" placeholder="3/4侧身面向搭档" @input="syncVisualSlotsToPromptPreview" />
                        </div>
                        <div>
                          <span class="sb-slot-mini-label">表情</span>
                          <el-input v-model="c.expression" size="small" placeholder="具体微表情" @input="syncVisualSlotsToPromptPreview" />
                        </div>
                        <div>
                          <span class="sb-slot-mini-label">头部姿态 head_pose</span>
                          <el-input v-model="c.head_pose" size="small" placeholder="头部转向搭档面部" @input="syncVisualSlotsToPromptPreview" />
                        </div>
                      </div>
                      <div class="sb-slot-char-grid" style="grid-template-columns: repeat(4, 1fr); gap:8px; margin-top:6px;">
                        <div>
                          <span class="sb-slot-mini-label">视线落点 gaze</span>
                          <el-input v-model="c.gaze" size="small" placeholder="目光锁定搭档双眼" @input="syncVisualSlotsToPromptPreview" />
                        </div>
                        <div>
                          <span class="sb-slot-mini-label">身体姿态与重心</span>
                          <el-input v-model="c.posture" size="small" placeholder="挺拔立姿微侧，重心稳固" @input="syncVisualSlotsToPromptPreview" />
                        </div>
                        <div>
                          <span class="sb-slot-mini-label">手部与肢体动作</span>
                          <el-input v-model="c.hands" size="small" placeholder="双手微弯自然悬于身侧" @input="syncVisualSlotsToPromptPreview" />
                        </div>
                        <div>
                          <span class="sb-slot-mini-label">头部与视线兼容字段</span>
                          <el-input v-model="c.head_gaze" size="small" placeholder="兼容旧数据" @input="syncVisualSlotsToPromptPreview" />
                        </div>
                      </div>
                      <div class="sb-slot-char-grid" style="grid-template-columns: 1fr 1fr; gap:8px; margin-top:6px;">
                        <div>
                          <span class="sb-slot-mini-label">道具交互</span>
                          <el-input v-model="c.prop_interaction" size="small" placeholder="与具体道具的接触关系" @input="syncVisualSlotsToPromptPreview" />
                        </div>
                        <div>
                          <span class="sb-slot-mini-label">本镜造型细节</span>
                          <el-input v-model="c.appearance_details" size="small" placeholder="服装、发型、污损等本镜细节" @input="syncVisualSlotsToPromptPreview" />
                        </div>
                      </div>
                    </div>
                  </div>
                  <div v-else class="sb-h3-empty-hint">
                    当前镜头未绑定出场角色。
                  </div>
                </div>

                <!-- 4. 光影影调与色彩氛围卡片 -->
                <div class="sb-slot-shot-card">
                  <div class="sb-slot-section-subtitle">💡 光影影调与色彩氛围 (Lighting & Chiaroscuro)：</div>
                  <div style="display:grid; grid-template-columns: 180px 1fr; gap:10px; margin-top:6px; align-items:center;">
                    <div>
                      <span class="sb-slot-mini-label">光影风格</span>
                      <el-select v-model="sbPromptVisualSlots.lighting_style" size="small" style="width:100%" @change="syncVisualSlotsToPromptPreview">
                        <el-option value="natural" label="自然漫反射光 (Natural)" />
                        <el-option value="side" label="高反差侧光 (Side Light)" />
                        <el-option value="backlit" label="轮廓逆光切边 (Backlit/Rim)" />
                        <el-option value="dramatic" label="经典戏剧光 (Dramatic Noir)" />
                        <el-option value="soft" label="柔光箱细腻漫射 (Soft)" />
                        <el-option value="golden_hour" label="暖金夕阳斜射 (Golden Hour)" />
                        <el-option value="blue_hour" label="幽蓝冷调暮光 (Blue Hour)" />
                        <el-option value="night" label="暗夜微光焦点 (Night)" />
                        <el-option value="neon" label="赛博霓虹反差光 (Neon)" />
                      </el-select>
                    </div>
                    <div>
                      <span class="sb-slot-mini-label">光影影调细节描述</span>
                      <el-input v-model="sbPromptVisualSlots.lighting_chiaroscuro" size="small" placeholder="如：幽蓝冷调暮光氛围，环境冷光与面部弱冷光交融" @input="syncVisualSlotsToPromptPreview" />
                    </div>
                  </div>
                </div>

                <div class="sb-slot-shot-card">
                  <div class="sb-slot-section-subtitle">🎞 起幅、落幅与下镜转场合同：</div>
                  <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; margin-top:6px;">
                    <el-input v-model="sbPromptVisualSlots.start_framing" type="textarea" :rows="2" placeholder="起幅构图" @input="syncVisualSlotsToPromptPreview" />
                    <el-input v-model="sbPromptVisualSlots.end_framing" type="textarea" :rows="2" placeholder="落幅构图" @input="syncVisualSlotsToPromptPreview" />
                    <el-input v-model="sbPromptVisualSlots.transition_to_next" type="textarea" :rows="2" placeholder="转入下一镜的连续性动作" @input="syncVisualSlotsToPromptPreview" />
                  </div>
                </div>

                <el-collapse>
                  <el-collapse-item title="尾帧角色视觉槽位（last_frame_visuals）" name="last-frame-slots">
                    <SlotTreeEditor v-model="sbPromptVisualSlots.last_frame_visuals" />
                  </el-collapse-item>
                  <el-collapse-item title="完整图片槽位数据（包含所有字段）" name="all-image-slots">
                    <SlotTreeEditor v-model="sbPromptVisualSlots" />
                  </el-collapse-item>
                </el-collapse>
              </div>

              <div v-else class="sb-slots-empty-card">
                <p style="color:#6b7280; font-size:13px; margin-bottom:10px;">当前分镜尚未解析出构图视觉槽位，您可以一键重新编译。</p>
                <el-button type="primary" size="small" :loading="sbPromptImageRebuilding" @click="onRebuildSbImagePrompt">按分镜参数合成视觉槽位</el-button>
              </div>
            </div>

            <!-- 子视图 2：分层结构化提示词卡片与文本预览 -->
            <div v-show="sbPromptImageSubTab === 'preview'" class="sb-preview-view">
              <!-- 结构化分层卡片展示 (替代黑乎乎一大坨文本) -->
              <div v-if="parsedImagePromptLayers.length" class="sb-image-prompt-layers-box">
                <div style="font-size:12px; font-weight:600; color:#374151; margin-bottom:8px; display:flex; align-items:center; justify-content:space-between;">
                  <span>分层结构化提示词预览 (按 5 层视听本体划分)</span>
                  <span style="font-size:11px; color:#9ca3af; font-weight:normal;">结构化分块提升模型理解度，杜绝文本黏连</span>
                </div>
                <div class="sb-image-prompt-layers-grid">
                  <div
                    v-for="layer in parsedImagePromptLayers"
                    :key="layer.title"
                    class="sb-image-layer-card"
                    :class="'layer--' + layer.key"
                  >
                    <div class="sb-image-layer-header">
                      <el-tag size="small" :type="layer.tagType" effect="dark" class="sb-image-layer-tag">
                        {{ layer.badge }}
                      </el-tag>
                    </div>
                    <div class="sb-image-layer-body">
                      {{ layer.content }}
                    </div>
                  </div>
                </div>
              </div>

              <!-- 原始与优化编辑框 -->
              <el-form-item label="" style="margin-top:12px;">
                <div style="width:100%">
                  <div style="font-size:12px; color:#6b7280; margin-bottom:4px;">图片提示词全文（支持自由编辑，保存后生效）：</div>
                  <el-input
                    v-model="sbPromptImageText"
                    type="textarea"
                    :rows="6"
                    placeholder="分镜生成时由 AI 写入的完整描述"
                  />
                </div>
              </el-form-item>
              <el-form-item label="">
                <div style="width:100%">
                  <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                    <span style="font-size:12px; color:#6b7280;">通用优化提示词（🎬 导演本体优化，注入角色锚点/道具真实尺度/场景地标）：</span>
                  </div>
                  <el-input
                    v-model="sbPromptPolishedText"
                    type="textarea"
                    :rows="4"
                    placeholder="点击上方「导演本体优化」生成高契约度提示词"
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
            </div>
          </el-form>
        </el-tab-pane>

        <el-tab-pane label="🎬 视频提示词与槽位" name="video">
          <el-form v-if="sbPromptTarget" label-width="0" class="sb-prompt-dialog-form">
            <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;">
              <strong style="font-size:13px;">📋 H3 权威多镜头时间线与语义槽位</strong>
            </div>

            <!-- 子视图 1：结构化多镜头时间线与语义槽位 -->
            <div class="sb-slots-view">
              <div v-if="sbPromptVideoSlots" class="sb-slots-timeline-container">
                <!-- MiniMax H3 多模态参考素材与声音绑定卡片 (Picture & Audio Slots) -->
                <div class="sb-slot-h3-media-card" v-loading="sbPromptH3Loading">
                  <div class="sb-slot-section-header">
                    <span class="sb-slot-section-title">🎬 MiniMax H3 多模态参考素材与声音绑定 (Picture & Audio Slots)</span>
                    <div class="sb-slot-h3-header-right">
                      <div style="display:flex; align-items:center; gap:6px;">
                        <span style="font-size:11.5px; color:#6b7280;">H3模式：</span>
                        <el-select
                          v-if="sbPromptH3Data"
                          v-model="sbPromptH3Data.engine_mode"
                          size="small"
                          style="width:160px;"
                        >
                          <el-option value="auto" label="⚡ 采用导演 Ref2VA 方案 (推荐)" />
                          <el-option value="fl2va" label="🎯 首帧强绑定 (FL2VA)" />
                          <el-option value="ref2va" label="🎭 角色多参考 (Ref2VA)" />
                        </el-select>
                        <span style="font-size:11.5px; color:#6b7280; margin-left:8px;">首帧：</span>
                        <el-select
                          v-if="sbPromptH3Data"
                          v-model="sbPromptH3Data.first_frame_policy_override"
                          size="small"
                          style="width:210px;"
                          :disabled="sbPromptH3Data.engine_mode === 'ref2va' || (sbPromptH3Data.engine_mode === 'auto' && sbPromptH3Data.agent_mode === 'ref2va')"
                        >
                          <el-option value="agent" label="采用 Agent 方案" />
                          <el-option value="generate_new" label="Qwen 生成新首帧" />
                          <el-option value="layout_lock" label="Qwen 布局锁定首帧" />
                          <el-option value="inherit_tail" label="继承上镜真实尾帧" />
                        </el-select>
                        <span style="font-size:11.5px; color:#6b7280; margin-left:8px;">尾帧：</span>
                        <el-select
                          v-if="sbPromptH3Data"
                          v-model="sbPromptH3Data.last_frame_policy_override"
                          size="small"
                          style="width:170px;"
                          :disabled="sbPromptH3Data.engine_mode === 'ref2va' || (sbPromptH3Data.engine_mode === 'auto' && sbPromptH3Data.agent_mode === 'ref2va')"
                        >
                          <el-option value="agent" label="采用 Agent 方案" />
                          <el-option value="none" label="不生成尾帧" />
                          <el-option value="generate_tail" label="Qwen 生成尾帧" />
                        </el-select>
                      </div>
                      <div v-if="sbPromptH3Data" style="font-size:11px; color:#94a3b8; text-align:right; margin-top:2px;">
                        <span v-if="sbPromptH3Data.engine_mode === 'auto'">⚡ 导演方案：{{ sbPromptH3Data.agent_mode?.toUpperCase() || '未规划' }} · </span>
                        <span v-else-if="sbPromptH3Data.engine_mode === 'fl2va'">🎯 首帧强绑定：100% 贴合分镜，无跳脸漂移 · </span>
                        <span v-else>🎭 角色多参考：不生成首尾帧，以人物卡、场景卡和声音参考保持一致 · </span>
                        <span>最终：{{ sbPromptH3Data.h3_generation_plan?.first_frame_policy || '未规划' }} / {{ sbPromptH3Data.h3_generation_plan?.last_frame_policy || '未规划' }}</span>
                      </div>
                    </div>
                  </div>

                  <!-- FL2VA 模式高亮提示 -->
                  <div v-if="sbPromptH3Data && sbPromptH3Data.engine_mode === 'fl2va'" style="margin: 8px 0; padding: 8px 12px; background: rgba(59, 130, 246, 0.08); border-left: 3px solid #3b82f6; border-radius: 4px; font-size: 12px; color: #1e40af; line-height: 1.5;">
                    <b>🎯 当前已开启【首帧强绑定模式 (FL2VA)】</b>：分镜首帧直接作为起始关键帧驱动视频生成，人物卡与场景卡已自动避让（避免特征打架导致的面部和构图漂移）。
                  </div>

                  <!-- 画面参考槽位 (<Picture N>) -->
                  <div class="sb-h3-media-subgroup">
                    <div class="sb-h3-subgroup-title">
                      <span>🖼️ 画面参考槽位（Picture 映射与保留度）：</span>
                      <span style="font-size:11px; color:#9ca3af; font-weight:normal;">模型通过 &lt;Picture N&gt; 索引画面，由 &lt;Subject N&gt; 锁定人物身份</span>
                    </div>
                    <div v-if="sbPromptH3Data && (sbPromptH3Data.references?.length || sbPromptH3Data.opening_anchor)" class="sb-h3-picture-grid">
                      <!-- 人物/场景/道具参考图 -->
                      <div
                        v-for="refItem in sbPromptH3Data.references"
                        :key="refItem.source"
                        class="sb-h3-picture-item"
                      >
                        <div class="sb-h3-pic-thumb-wrap">
                          <el-image
                            :src="refItem.url"
                            :preview-src-list="[refItem.url]"
                            fit="cover"
                            class="sb-h3-pic-thumb"
                          />
                          <span class="sb-h3-pic-tag">{{ refItem.tag || ('<Picture ' + refItem.index + '>') }}</span>
                        </div>
                        <div class="sb-h3-pic-info">
                          <div class="sb-h3-pic-name" :title="refItem.name">
                            {{ refItem.name }}
                            <el-tag v-if="refItem.subject_tag" size="small" type="success" effect="dark" class="sb-h3-mini-tag">{{ refItem.subject_tag }}</el-tag>
                          </div>
                          <div class="sb-h3-pic-meta">
                            <span class="sb-h3-badge-kind">{{ refItem.kind === 'character_sheet' ? '人物四视图' : refItem.kind === 'character_outfit' ? '人物新造型' : refItem.kind === 'scene' ? '场景环境' : '关键道具' }}</span>
                            <span class="sb-h3-badge-retention" :title="refItem.retention_role">{{ refItem.retention_role === 'partially_preserved' ? '五官继承' : '完全保留' }}</span>
                          </div>
                        </div>
                      </div>

                      <!-- 开场首帧构图锚点 (如果有) -->
                      <div v-if="sbPromptH3Data.opening_anchor" class="sb-h3-picture-item sb-h3-picture-item--opening">
                        <div class="sb-h3-pic-thumb-wrap">
                          <el-image
                            :src="sbPromptH3Data.opening_anchor.url"
                            :preview-src-list="[sbPromptH3Data.opening_anchor.url]"
                            fit="cover"
                            class="sb-h3-pic-thumb"
                          />
                          <span class="sb-h3-pic-tag">{{ sbPromptH3Data.opening_anchor.tag }}</span>
                        </div>
                        <div class="sb-h3-pic-info">
                          <div class="sb-h3-pic-name">本镜首帧构图锚点</div>
                          <div class="sb-h3-pic-meta">
                            <span class="sb-h3-badge-kind">开场构图与服装</span>
                            <span class="sb-h3-badge-retention">fully_preserved</span>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div v-else-if="!sbPromptH3Loading" class="sb-h3-empty-hint">
                      暂无关联人物或场景参考图。请先在资产库或分镜中勾选人物/场景并生成图片。
                    </div>
                  </div>

                  <!-- 声音参考槽位 (<Audio N>) -->
                  <div class="sb-h3-media-subgroup" style="margin-top:10px;">
                    <div class="sb-h3-subgroup-title">
                      <span>🎙️ 声音参考与对白标签（Audio 映射与说话人契约）：</span>
                      <span style="font-size:11px; color:#9ca3af; font-weight:normal;">每镜最多 3 个声音，通过 &lt;Audio N&gt; 索引音色，台词采用 &lt;d&gt;...&lt;/d&gt; 标签包裹</span>
                    </div>
                    <div v-if="sbPromptH3Data && sbPromptH3Data.voice_references?.length" class="sb-h3-audio-grid">
                      <div
                        v-for="voice in sbPromptH3Data.voice_references"
                        :key="voice.tag"
                        class="sb-h3-audio-item"
                      >
                        <div class="sb-h3-audio-header">
                          <span class="sb-h3-audio-tag">{{ voice.tag }}</span>
                          <span class="sb-h3-speaker-tag">{{ voice.speaker_tag }} {{ voice.speaker }}</span>
                          <el-tag v-if="voice.subject_tag" size="small" type="success" effect="plain" class="sb-h3-mini-tag">{{ voice.subject_tag }}</el-tag>
                          <span class="sb-h3-audio-kind">{{ voice.kind === 'narration' ? '画外旁白 (闭嘴)' : '角色对白' }}</span>
                          <span class="sb-h3-audio-voice-name" :title="voice.voice_id">{{ voice.voice_id }}</span>
                        </div>
                        <div class="sb-h3-audio-line" :title="voice.text">
                          <span class="sb-h3-d-tag">&lt;d&gt;[Chinese]</span> {{ voice.text }} <span class="sb-h3-d-tag">&lt;/d&gt;</span>
                        </div>
                      </div>
                    </div>
                    <div v-else-if="!sbPromptH3Loading" class="sb-h3-empty-hint">
                      本镜无台词或旁白提取，将作为无台词纯画面/动作音效镜头生成。
                    </div>
                  </div>
                </div>

                <!-- 顶部时间线控制栏 -->
                <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:4px; padding:0 2px;">
                  <div style="display:flex; align-items:center; gap:8px;">
                    <span style="font-size:13px; font-weight:600; color:#1e293b;">🎬 多镜头时间线切分 (Shot Timeline)</span>
                    <el-tag size="small" type="primary">{{ sbPromptVideoSlots.shots_timeline?.length || 1 }} 个切分镜头</el-tag>
                  </div>
                  <el-button size="small" type="primary" plain @click="addTimelineShot">➕ 添加分镜头切分</el-button>
                </div>
                <el-alert
                  v-if="!sbPromptVideoSlots.shots_timeline?.length"
                  title="该镜数据库中没有 shots_timeline；页面不会自动伪造导演时间线。请使用“导演微调”让 Agent 补齐，或在此手动添加。"
                  type="warning"
                  :closable="false"
                  show-icon
                  style="margin-bottom:8px;"
                />

                <!-- 镜头时间轴切分卡片 -->
                <div
                  v-for="(st, sIdx) in (sbPromptVideoSlots.shots_timeline || [])"
                  :key="st.shot_number || sIdx"
                  class="sb-slot-shot-card"
                >
                  <div class="sb-slot-shot-header">
                    <div class="sb-slot-shot-title">
                      <span class="sb-slot-shot-badge">镜头 {{ st.shot_number || (sIdx + 1) }}</span>
                      <span class="sb-slot-shot-time">
                        <el-icon style="margin-right:2px; vertical-align:-1px;"><Clock /></el-icon>
                        {{ st.timestamp ? `切镜时刻: ${st.timestamp}` : '起始建立 (00:00.000)' }}
                      </span>
                      <span v-if="st.duration" class="sb-slot-shot-dur">预计 {{ st.duration }} 秒</span>
                    </div>
                    <div class="sb-slot-shot-cam">
                      <span style="font-size:12px; color:#6b7280; margin-right:4px;">机位:</span>
                      <el-input v-if="st.camera" v-model="st.camera.shot_type" size="small" style="width:80px;" placeholder="景别" @input="syncSlotsToPromptPreview" />
                      <el-input v-if="st.camera" v-model="st.camera.movement" size="small" style="width:90px;" placeholder="运镜" @input="syncSlotsToPromptPreview" />
                      <el-button
                        v-if="sbPromptVideoSlots.shots_timeline && sbPromptVideoSlots.shots_timeline.length > 1"
                        size="small"
                        type="danger"
                        text
                        style="padding:0 4px; margin-left:6px;"
                        @click="removeTimelineShot(sIdx)"
                      >删除</el-button>
                    </div>
                  </div>

                  <!-- 镜头动作描述 -->
                  <div class="sb-slot-action-row">
                    <span class="sb-slot-field-label">镜头动作：</span>
                    <el-input
                      v-model="st.action"
                      type="textarea"
                      :rows="2"
                      size="small"
                      placeholder="该镜头发生的核心物理动作与场景变化"
                      @input="syncSlotsToPromptPreview"
                    />
                  </div>

                  <!-- 角色动态轨迹与姿态 -->
                  <div v-if="st.character_trajectories && st.character_trajectories.length" class="sb-slot-chars-container">
                    <div class="sb-slot-section-subtitle">角色轨迹与口型状态：</div>
                    <div
                      v-for="(c, cIdx) in st.character_trajectories"
                      :key="c.name || cIdx"
                      class="sb-slot-char-card"
                    >
                      <div class="sb-slot-char-name">「{{ c.name }}」</div>
                      <div class="sb-slot-char-grid">
                        <div class="sb-slot-char-item">
                          <span class="sb-slot-mini-label">起点</span>
                          <el-input v-model="c.start_anchor" size="small" placeholder="起始位置" @input="syncSlotsToPromptPreview" />
                        </div>
                        <div class="sb-slot-char-item">
                          <span class="sb-slot-mini-label">终点</span>
                          <el-input v-model="c.end_anchor" size="small" placeholder="终点位置" @input="syncSlotsToPromptPreview" />
                        </div>
                        <div class="sb-slot-char-item" style="flex:2;">
                          <span class="sb-slot-mini-label">终态姿态</span>
                          <el-input v-model="c.terminal_pose" size="small" placeholder="终态姿势" @input="syncSlotsToPromptPreview" />
                        </div>
                        <div class="sb-slot-char-item" style="flex:1.5;">
                          <span class="sb-slot-mini-label">口型状态</span>
                          <el-input v-model="c.mouth_state" size="small" placeholder="如：开口说话并同步口型 / 双唇紧闭" @input="syncSlotsToPromptPreview" />
                        </div>
                      </div>
                      <div class="sb-slot-char-grid" style="margin-top:6px;">
                        <div class="sb-slot-char-item"><span class="sb-slot-mini-label">运动轨迹</span><el-input v-model="c.trajectory" size="small" @input="syncSlotsToPromptPreview" /></div>
                        <div class="sb-slot-char-item"><span class="sb-slot-mini-label">面部表情</span><el-input v-model="c.facial_expression" size="small" @input="syncSlotsToPromptPreview" /></div>
                        <div class="sb-slot-char-item"><span class="sb-slot-mini-label">身体朝向</span><el-input v-model="c.facing" size="small" @input="syncSlotsToPromptPreview" /></div>
                        <div class="sb-slot-char-item"><span class="sb-slot-mini-label">头部姿态 head_pose</span><el-input v-model="c.head_pose" size="small" @input="syncSlotsToPromptPreview" /></div>
                      </div>
                      <div class="sb-slot-char-grid" style="margin-top:6px;">
                        <div class="sb-slot-char-item"><span class="sb-slot-mini-label">视线落点 gaze</span><el-input v-model="c.gaze" size="small" @input="syncSlotsToPromptPreview" /></div>
                        <div class="sb-slot-char-item"><span class="sb-slot-mini-label">注意对象</span><el-input v-model="c.attention_target" size="small" @input="syncSlotsToPromptPreview" /></div>
                        <div class="sb-slot-char-item"><span class="sb-slot-mini-label">视线动机</span><el-input v-model="c.gaze_motivation" size="small" @input="syncSlotsToPromptPreview" /></div>
                        <div class="sb-slot-char-item"><span class="sb-slot-mini-label">反应触发事件</span><el-input v-model="c.reaction_trigger" size="small" @input="syncSlotsToPromptPreview" /></div>
                      </div>
                    </div>
                  </div>

                  <!-- 台词与口型契约 -->
                  <div v-if="st.audio_lip_sync" class="sb-slot-dialogue-box">
                    <span class="sb-slot-field-label">对白契约：</span>
                    <div style="flex:1; display:flex; gap:8px; align-items:center;">
                      <el-input v-model="st.audio_lip_sync.speaker_name" size="small" style="width:100px;" placeholder="说话人" @input="syncSlotsToPromptPreview" />
                      <el-input v-model="st.audio_lip_sync.dialogue_content" size="small" style="flex:1;" placeholder="台词内容（若无台词可留空）" @input="syncSlotsToPromptPreview" />
                    </div>
                  </div>
                </div>

                <!-- 全局摄影与物理环境语义槽位 -->
                <div v-if="sbPromptVideoSlots.camera || sbPromptVideoSlots.environment_vfx" class="sb-slot-global-card">
                  <div class="sb-slot-section-subtitle">🎥 全局视听语义槽位 (机位契约与物理环境交互)：</div>
                  <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px; margin-top:8px;">
                    <div style="display:flex; align-items:center; gap:6px;">
                      <span class="sb-slot-mini-label" style="width:70px;">全局景别：</span>
                      <el-input v-if="sbPromptVideoSlots.camera" v-model="sbPromptVideoSlots.camera.shot_type" size="small" placeholder="如：中景、特写、全景" @input="syncSlotsToPromptPreview" />
                    </div>
                    <div style="display:flex; align-items:center; gap:6px;">
                      <span class="sb-slot-mini-label" style="width:70px;">全局运镜：</span>
                      <el-input v-if="sbPromptVideoSlots.camera" v-model="sbPromptVideoSlots.camera.movement" size="small" placeholder="如：tracking, push, static" @input="syncSlotsToPromptPreview" />
                    </div>
                    <div style="display:flex; align-items:center; gap:6px;">
                      <span class="sb-slot-mini-label" style="width:70px;">物理交互：</span>
                      <el-input v-if="sbPromptVideoSlots.environment_vfx" v-model="sbPromptVideoSlots.environment_vfx.physical_phenomena" size="small" placeholder="如：飞溅碎石、烟尘与火花" @input="syncSlotsToPromptPreview" />
                    </div>
                    <div style="display:flex; align-items:center; gap:6px;">
                      <span class="sb-slot-mini-label" style="width:70px;">结果收束：</span>
                      <el-input v-if="sbPromptVideoSlots.environment_vfx" v-model="sbPromptVideoSlots.environment_vfx.terminal_event" size="small" placeholder="终态事件/定格结果" @input="syncSlotsToPromptPreview" />
                    </div>
                  </div>
                </div>

                <!-- 环境声场与后期配乐 (H3 官方字段) -->
                <div v-if="sbPromptVideoSlots.h3_multimodal" class="sb-slot-soundscape-card">
                  <div class="sb-slot-section-subtitle">多模态声音设计 (MiniMax H3 / 声音槽位)：</div>
                  <div style="display:flex; flex-direction:column; gap:6px; margin-top:6px;">
                    <div style="display:flex; align-items:center; gap:8px;">
                      <span class="sb-slot-field-label" style="width:140px;">环境音效 (soundscape)：</span>
                      <el-input v-model="sbPromptVideoSlots.h3_multimodal.overall_soundscape" size="small" style="flex:1;" placeholder="环境音、物理碰撞声、环境底噪" @input="syncSlotsToPromptPreview" />
                    </div>
                    <div style="display:flex; align-items:center; gap:8px;">
                      <span class="sb-slot-field-label" style="width:140px;">配乐标签 (music)：</span>
                      <el-input v-model="sbPromptVideoSlots.h3_multimodal.non_diegetic_music" size="small" style="flex:1;" placeholder="情绪配乐描述，或 N/A" @input="syncSlotsToPromptPreview" />
                    </div>
                  </div>
                </div>

                <el-collapse v-model="sbSlotOpenSections">
                  <el-collapse-item title="Agent 导演决策槽位（semantic_slots，完整可编辑）" name="semantic-slots">
                    <SlotTreeEditor v-if="sbPromptSemanticSlots" v-model="sbPromptSemanticSlots" />
                  </el-collapse-item>
                  <el-collapse-item title="全局角色运动轨迹（video_slots.trajectories）" name="global-trajectories">
                    <SlotTreeEditor v-model="sbPromptVideoSlots.trajectories" />
                  </el-collapse-item>
                  <el-collapse-item title="完整视频槽位数据（camera / audio / timing / timeline / VFX / H3）" name="all-video-slots">
                    <SlotTreeEditor v-model="sbPromptVideoSlots" />
                  </el-collapse-item>
                </el-collapse>
              </div>

              <!-- 槽位未初始化提示 -->
              <div v-else class="sb-slots-empty-card">
                <p style="color:#6b7280; font-size:13px; margin-bottom:10px;">当前分镜尚未合成结构化镜头时间线槽位，您可以一键按分镜参数构建。</p>
                <p style="color:#b45309;font-size:12px;">请重新运行「导演生成分镜脚本」，由导演 Agent 补齐权威槽位。</p>
              </div>
            </div>
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

    <!-- 首尾帧提示词编辑器（显示当前可编辑提示词正文，支持编辑保存） -->
    <el-dialog
      v-model="showFramePromptEditor"
      :title="`${editingFramePromptSlot === 'last' ? '尾帧' : '首帧'}图生提示词 · 编辑`"
      width="720px"
      destroy-on-close
    >
      <div class="frame-prompt-editor-body" v-loading="editingFramePromptLoading" element-loading-text="正在读取或生成帧提示词，请稍候…">
        <div class="frame-prompt-editor-hint">
          这里是当前首/尾帧提示词正文，可编辑保存。提交时还会附加有序参考素材和本镜服装；最终提交内容请到「生成记录·实际输入」查看。
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
          placeholder="在此编辑当前首/尾帧提示词正文..."
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
          <div class="vp-mode-hint">全能模式：由 H3 Ref2VA 合并场景、角色、道具等参考图（不含经典分镜主图）。经典字段保留，可随时切回。</div>
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
              本镜含多句对白或「对白+旁白」，H3 同镜可能发生说话人串音。可拆成多条分镜（每条仅一人说话或仅旁白），再分别生视频。
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
import { directorPlanningInputs } from '@/utils/directorPlanningInputs'
import { ref, reactive, computed, watch, nextTick, inject, provide, onBeforeUnmount } from 'vue'
import { ElMessage, ElMessageBox, ElNotification, ElLoading } from 'element-plus'
import { Loading, WarningFilled, Clock } from '@element-plus/icons-vue'
import StoryboardBatchToolbar from './StoryboardBatchToolbar.vue'
import StoryboardCard from './StoryboardCard.vue'
import SlotTreeEditor from './SlotTreeEditor.vue'
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
import { canUseUniversalOmniVideoApi, isH3VideoAiConfig } from '@/utils/videoOmniSupport'
import { h3ShotInputPolicy } from '@/utils/h3ShotInputPolicy'

const ctx = inject('filmCreateContext', {})

// 共享状态与方法解构
const store = ctx.store
const dramaId = ctx.dramaId
const currentEpisodeId = ctx.currentEpisodeId
const storyboards = ctx.storyboards || computed(() => store?.storyboards || [])
const pipelineRunning = ctx.pipelineRunning
const generationJobsPanel = ctx.generationJobsPanel
const storyboardJobsPanel = ctx.storyboardJobsPanel || ref(null)
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
const directorTaskMessage = ref('')
const directorTaskProgress = ref(0)
const latestDirectorRun = ref(null)

function parseTaskResult(task) {
  const raw = task?.result
  if (!raw) return {}
  if (typeof raw === 'object') return raw
  try { return JSON.parse(raw) || {} } catch (_) { return {} }
}

const latestDirectorRunResult = computed(() => parseTaskResult(directorRunForDisplay.value))
const latestDirectorRunVersion = computed(() => {
  const result = latestDirectorRunResult.value
  return result.semantic_revision || result.version || (latestDirectorRun.value?.id ? latestDirectorRun.value.id.slice(0, 8) : '—')
})

function directorRunStatusLabel(status) {
  return ({ pending: '等待中', processing: '生成中', completed: '已成功', failed: '失败' })[status] || status || '未知'
}

function directorRunTagType(status) {
  return ({ pending: 'info', processing: 'warning', completed: 'success', failed: 'danger' })[status] || 'info'
}

function formatTaskTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false })
}

async function loadLatestDirectorRun(episodeId = currentEpisodeId?.value) {
  if (!episodeId) {
    latestDirectorRun.value = null
    return
  }
  try {
    const tasks = await taskAPI.listByResource(String(episodeId))
    latestDirectorRun.value = (tasks || []).find((task) => task.type === 'director_storyboard_generation') || null
    const task = latestDirectorRun.value
    if (task && ['pending', 'processing', 'running'].includes(task.status) && genStore) {
      const meta = {
        dramaId: dramaId.value,
        episodeId: Number(episodeId),
        dramaTitle: store.drama?.title,
        episodeNumber: store.currentEpisode?.episode_number,
        resourceType: GEN_RESOURCE.GENERATE_STORYBOARD,
        resourceId: Number(episodeId),
        label: `${store.currentEpisode?.title || '当前集'} 导演生成分镜`,
        taskId: task.id,
        taskType: task.type,
        serverStatus: task.status,
        progress: task.progress,
        message: task.message,
        result: task.result,
        startedAt: task.created_at ? new Date(task.created_at).getTime() : undefined,
      }
      genStore.markRunning(meta)
      void genStore.attachPollIfNeeded(task.id, meta, async () => {
        await loadDrama()
        await loadLatestDirectorRun(episodeId)
      }, { ElMessage, maxAttempts: Infinity, interval: 2000, showErrorToast: false, showTimeoutToast: false })
    }
  } catch (_) {
    latestDirectorRun.value = null
  }
}

const activeDirectorTask = computed(() => {
  if (!genStore || !currentEpisodeId?.value) return null
  const running = genStore.getRunningForEpisode(dramaId?.value, currentEpisodeId?.value) || []
  return running.find((t) => (
    t.resourceType === GEN_RESOURCE.GENERATE_STORYBOARD
    && (t.taskType === 'director_storyboard_generation' || String(t.label || '').includes('导演生成分镜'))
  ))
})

const directorRunForDisplay = computed(() => {
  if (!latestDirectorRun.value) return null
  if (!activeDirectorTask.value) return latestDirectorRun.value
  return {
    ...latestDirectorRun.value,
    status: activeDirectorTask.value.serverStatus || 'processing',
    progress: activeDirectorTask.value.progress,
    message: activeDirectorTask.value.message,
    result: activeDirectorTask.value.result ?? latestDirectorRun.value.result,
  }
})

watch(activeDirectorTask, (current, previous) => {
  if (!current && previous) loadLatestDirectorRun(currentEpisodeId?.value)
})

const effectiveDirectorMessage = computed(() => {
  return activeDirectorTask.value?.message || directorTaskMessage.value || latestDirectorRun.value?.message || ''
})

const effectiveDirectorProgress = computed(() => {
  return activeDirectorTask.value?.progress ?? latestDirectorRun.value?.progress ?? directorTaskProgress.value ?? 0
})

const isAnyDirectorGenerating = computed(() => {
  const latestStatus = latestDirectorRun.value?.status
  return Boolean(
    (directorGenerating && directorGenerating.value)
    || activeDirectorTask.value
    || latestStatus === 'pending'
    || latestStatus === 'processing'
    || latestStatus === 'running'
  )
})

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
const sbPromptImageSubTab = ref('slots') // 'slots' | 'preview'
const sbPromptVisualSlots = ref(null)    // 首帧构图与视觉槽位结构化对象
const sbPromptSemanticSlots = ref(null)  // Agent 原始 semantic_slots，决定 H3 模式、参考素材、声音与连戏
const sbPromptImageText = ref('')       // 原始 image_prompt
const sbPromptPolishedText = ref('')    // AI 优化后 polished_prompt
const sbPromptVideoSlots = ref(null)     // video_slots 结构化对象
const sbPromptH3Data = ref(null)         // H3 原生素材与声音绑定对象
const sbPromptH3Loading = ref(false)     // H3 素材加载中
const sbPromptSaving = ref(false)
const sbPromptPolishing = ref(false)
const sbPromptImageRebuilding = ref(false)
const sbPromptUserFeedback = ref('')     // 用户调整意见 / AI 优化指导
const sbSlotOpenSections = ref(['semantic-slots'])

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
  // 异步加载当前帧提示词正文
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
      // H3 以权威槽位为输入；具体首帧与参考素材由后端门禁。
      return sbCanSubmitVideo(sb)
    })
    if (!todo.length) {
      ElMessage.info('没有需要生成视频的分镜（缺少导演槽位，或视频已全部生成）')
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
        storyboard_id: sb.id, model: selectedShotModel(sb),
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
  loadLatestDirectorRun(episodeId)
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

function onUniversalSegmentPromptMenu(sb, cmd) {
  if (cmd === 'generate') onGenerateUniversalSegmentPrompt(sb, {})
  else if (cmd === 'generate-force') onGenerateUniversalSegmentPrompt(sb, { forceWithoutReferenceImages: true })
  else if (cmd === 'polish') onPolishUniversalSegmentPromptStream(sb, {})
  else if (cmd === 'polish-force') onPolishUniversalSegmentPromptStream(sb, { forceWithoutReferenceImages: true })
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
  if (!sb?.id) return false
  const semantic = parseSlotObject(sb.semantic_slots)
  let video = sb.video_slots
  if (typeof video === 'string') {
    try { video = JSON.parse(video) } catch (_) { video = null }
  }
  return !!(semantic && Object.keys(semantic).length && video && typeof video === 'object')
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

function invalidateActiveVideoAiConfigCache() {
  activeVideoAiConfigCache = null
  activeVideoAiConfigCacheAt = 0
}

async function confirmUniversalUnsupportedVideo() {
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
  sbPromptImageSubTab.value = 'slots'
  sbPromptTarget.value = sb
  sbPromptUserFeedback.value = ''
  sbPromptVisualSlots.value = ensureVisualSlots(sb)
  sbPromptSemanticSlots.value = parseSlotObject(sb.semantic_slots)
  sbPromptImageText.value = formatImagePromptForEdit((sb.image_prompt || '').toString())
  sbPromptPolishedText.value = formatImagePromptForEdit((sb.polished_prompt || '').toString())
  let rawSlots = sb.video_slots
  if (typeof rawSlots === 'string') {
    try { rawSlots = JSON.parse(rawSlots) } catch (_) { rawSlots = null }
  }
  sbPromptVideoSlots.value = ensureShotsTimeline(rawSlots ? JSON.parse(JSON.stringify(rawSlots)) : null)
  sbPromptH3Data.value = null
  if (dramaId.value && sb.id) {
    sbPromptH3Loading.value = true
    videosAPI.h3Inputs(dramaId.value, sb.id)
      .then((res) => { sbPromptH3Data.value = res })
      .catch((err) => console.warn('[H3素材槽位] 加载失败', err))
      .finally(() => { sbPromptH3Loading.value = false })
  }
  showSbPromptDialog.value = true
  try {
    const fresh = await storyboardsAPI.get(sb.id)
    if (fresh?.id) {
      sbPromptTarget.value = fresh
      sbPromptVisualSlots.value = ensureVisualSlots(fresh)
      sbPromptSemanticSlots.value = parseSlotObject(fresh.semantic_slots)
      sbPromptImageText.value = formatImagePromptForEdit((fresh.image_prompt || '').toString())
      sbPromptPolishedText.value = formatImagePromptForEdit((fresh.polished_prompt || '').toString())
      let freshSlots = fresh.video_slots
      if (typeof freshSlots === 'string') {
        try { freshSlots = JSON.parse(freshSlots) } catch (_) { freshSlots = null }
      }
      if (freshSlots) {
        sbPromptVideoSlots.value = ensureShotsTimeline(JSON.parse(JSON.stringify(freshSlots)))
      }
    }
  } catch (_) {}
}

function parseSlotObject(value) {
  if (!value) return {}
  if (value && typeof value === 'object' && !Array.isArray(value)) return JSON.parse(JSON.stringify(value))
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (_) {
    return {}
  }
}

function ensureShotsTimeline(slots) {
  // 页面只展示 Agent 已落库的真实槽位。缺失字段保持缺失，禁止在编辑器中
  // 静默合成动作、时间线、口型或视线计划后冒充导演决策。
  if (!slots || typeof slots !== 'object' || Array.isArray(slots)) return null
  const normalized = JSON.parse(JSON.stringify(slots))
  if (!Array.isArray(normalized.trajectories)) normalized.trajectories = []
  if (!Array.isArray(normalized.shots_timeline)) normalized.shots_timeline = []
  return normalized
}

function addTimelineShot() {
  if (!sbPromptVideoSlots.value) return
  if (!Array.isArray(sbPromptVideoSlots.value.shots_timeline)) {
    sbPromptVideoSlots.value.shots_timeline = []
  }
  const len = sbPromptVideoSlots.value.shots_timeline.length
  const nextNum = len + 1
  const prevDuration = sbPromptVideoSlots.value.timing?.duration || sbPromptTarget.value?.duration || 6
  const cutSec = Math.round((prevDuration / nextNum) * (nextNum - 1) * 2) / 2
  const mm = String(Math.floor(cutSec / 60)).padStart(2, '0')
  const ss = String(Math.floor(cutSec % 60)).padStart(2, '0')
  const timecode = `${mm}:${ss}.000`

  sbPromptVideoSlots.value.shots_timeline.push({
    shot_number: nextNum,
    timestamp: timecode,
    duration: 3,
    camera: {
      shot_type: '特写',
      movement: 'static',
      movement_description: '',
    },
    action: '镜头切至特写/反打，主体完成关键反应',
    result: '',
    character_trajectories: (sbPromptVideoSlots.value.trajectories || []).map((t) => ({
      ...t,
      shot_number: nextNum,
    })),
    audio_lip_sync: {
      mode: 'silent_ambient',
      speaker_name: '',
      dialogue_content: '',
      lip_sync_rule: '画内全员紧闭双唇，无台词口型',
    },
  })
  syncSlotsToPromptPreview()
}

function removeTimelineShot(index) {
  if (!sbPromptVideoSlots.value?.shots_timeline) return
  if (sbPromptVideoSlots.value.shots_timeline.length <= 1) {
    ElMessage.warning('至少需要保留一个镜头')
    return
  }
  sbPromptVideoSlots.value.shots_timeline.splice(index, 1)
  sbPromptVideoSlots.value.shots_timeline.forEach((st, idx) => {
    st.shot_number = idx + 1
    if (idx === 0) st.timestamp = null
  })
  syncSlotsToPromptPreview()
}

function syncSlotsToPromptPreview() {
  const slots = sbPromptVideoSlots.value
  if (!slots) return
  if (Array.isArray(slots.shots_timeline) && slots.shots_timeline.length > 0) {
    const h3Shots = slots.shots_timeline.map((st) => {
      let desc = ''
      const cam = st.camera?.shot_type || 'medium shot'
      const move = st.camera?.movement || 'tracking'
      if (!st.timestamp) {
        desc = `Live-action, cinematic. A ${cam} establishes the scene. The camera begins with ${move} as ${st.action || 'the action initiates'}.`
      } else {
        desc = `At ${st.timestamp}, the camera cuts to a ${cam}, where ${st.action || 'the movement resolves'}.`
        if (st.audio_lip_sync?.dialogue_content) {
          const spk = st.audio_lip_sync.speaker_name ? `${st.audio_lip_sync.speaker_name}: ` : ''
          const cleanDiag = String(st.audio_lip_sync.dialogue_content).replace(/^["“](.*)["”]$/, '$1')
          desc += ` Dialogue follows: ${spk}“${cleanDiag}”`
        }
      }
      return {
        shot_number: st.shot_number,
        timestamp: st.timestamp,
        description: desc.trim(),
      }
    })
    if (!slots.h3_multimodal) slots.h3_multimodal = {}
    slots.h3_multimodal.shots = h3Shots
    slots.h3_multimodal.integrated_multimodal_description = h3Shots
      .map((s) => (s.timestamp ? `[Shot ${s.shot_number}] At ${s.timestamp}, ${s.description.replace(/^At\s+[\d:.]+,\s*/, '')}` : `[Shot ${s.shot_number}] ${s.description}`))
      .join('\n')
  }
}

function formatImagePromptForEdit(text) {
  if (!text) return ''
  return text
    .replace(/([。；\n])\s*(【[^】]+】)/g, '$1\n$2')
    .replace(/([。；])\s*(【[^】]+】)/g, '$1\n$2')
    .replace(/^\s+|\s+$/g, '')
}

const parsedImagePromptLayers = computed(() => {
  const text = (sbPromptImageText.value || sbPromptPolishedText.value || '').trim()
  if (!text) return []

  const regex = /【([^】]+)】([\s\S]*?)(?=(?:【[^】]+】|$))/g
  const layers = []
  let match
  while ((match = regex.exec(text)) !== null) {
    const title = match[1].trim()
    const content = match[2].trim()
    let key = 'other'
    let badge = `【${title}】`
    let tagType = 'info'

    if (title.includes('场景') || title.includes('空间') || title.includes('环境') || title.includes('纵深')) {
      key = 'location'
      badge = '🏞️ ' + title
      tagType = 'primary'
    } else if (title.includes('机位') || title.includes('景别') || title.includes('镜头') || title.includes('视角')) {
      key = 'camera'
      badge = '🎥 ' + title
      tagType = 'warning'
    } else if (title.includes('角色') || title.includes('人物') || title.includes('姿态') || title.includes('构图')) {
      key = 'characters'
      badge = '👤 ' + title
      tagType = 'success'
    } else if (title.includes('光') || title.includes('影调') || title.includes('氛围')) {
      key = 'lighting'
      badge = '💡 ' + title
      tagType = 'warning'
    } else if (title.includes('摄影') || title.includes('风格') || title.includes('画质') || title.includes('美学')) {
      key = 'style'
      badge = '🎞️ ' + title
      tagType = 'info'
    }

    layers.push({
      key,
      title,
      badge,
      tagType,
      content,
    })
  }

  if (layers.length === 0 && text) {
    layers.push({
      key: 'general',
      title: '画面综合描述',
      badge: '🖼️ 画面综合描述',
      tagType: 'primary',
      content: text,
    })
  }

  return layers
})

function ensureVisualSlots(sb = {}) {
  if (!sb) return null
  let cv = sb.character_visuals
  if (typeof cv === 'string') {
    try { cv = JSON.parse(cv) } catch (_) { cv = null }
  }
  if (!Array.isArray(cv) || cv.length === 0) {
    cv = []
  } else {
    cv = JSON.parse(JSON.stringify(cv)).map((c, idx) => ({
      ...c,
      character_id: c.character_id,
      name: c.name || `角色${idx + 1}`,
      depth_layer: c.depth_layer || '',
      screen_position: c.screen_position || '',
      environmental_anchor: c.environmental_anchor || '',
      spatial_anchor: c.spatial_anchor || '',
      facing: c.facing || '',
      expression: c.expression || '',
      head_pose: c.head_pose || '',
      gaze: c.gaze || '',
      posture: c.posture || '',
      hands: c.hands || '',
      head_gaze: c.head_gaze || '',
      prop_interaction: c.prop_interaction || '',
      appearance_details: c.appearance_details || '',
    }))
  }

  let lastFrameVisuals = sb.last_frame_visuals
  if (typeof lastFrameVisuals === 'string') {
    try { lastFrameVisuals = JSON.parse(lastFrameVisuals) } catch (_) { lastFrameVisuals = [] }
  }
  if (!Array.isArray(lastFrameVisuals)) lastFrameVisuals = []

  const shotType = sb.shot_type || ''
  const angleH = sb.angle_h || ''
  const angleV = sb.angle_v || ''
  const dof = sb.depth_of_field || ''
  const lens = sb.cinematic_lens || ''

  let envDepth = sb.environment_depth

  return {
    location: sb.location || '',
    time: sb.time || '',
    environment_depth: envDepth,
    shot_type: shotType,
    angle_h: angleH,
    angle_v: angleV,
    angle_s: sb.angle_s || '',
    depth_of_field: dof,
    cinematic_lens: lens,
    character_visuals: cv,
    last_frame_visuals: JSON.parse(JSON.stringify(lastFrameVisuals)),
    lighting_style: sb.lighting_style || '',
    lighting_chiaroscuro: sb.lighting_chiaroscuro || '',
    dialogue_framing: sb.dialogue_framing || '',
    start_framing: sb.start_framing || '',
    end_framing: sb.end_framing || '',
    transition_to_next: sb.transition_to_next || '',
  }
}

function syncVisualSlotsToPromptPreview() {
  const vs = sbPromptVisualSlots.value
  if (!vs) return

  const parts = []

  // 1. 场景空间与纵深
  const locParts = [vs.location, vs.time].filter(Boolean)
  const locStr = locParts.length ? `${locParts.join('，')}。` : ''
  const envStr = vs.environment_depth ? `${vs.environment_depth}。` : ''
  parts.push(`【场景空间与纵深】${locStr}${envStr}`)

  // 2. 机位景别
  const shotMap = {
    '特写': '特写镜头 (Close-up)',
    '大特写': '微距大特写 (Extreme Close-up)',
    '近景': '近景镜头 (Medium Close-up)',
    '中景': '中景镜头 (Medium Shot)',
    '中全景': '中全景镜头 (Medium Long Shot)',
    '全景': '全景镜头 (Long Shot / Full Shot)',
    '远景': '大远景镜头 (Extreme Long Shot)',
  }
  const hMap = {
    front: '正面平视',
    '3_4_left': '四分之三侧身朝左',
    '3_4_right': '四分之三侧身朝右',
    side_left: '正侧面朝左',
    side_right: '正侧面朝右',
    back: '背面视角',
    overhead: '俯视顶拍',
  }
  const vMap = {
    eye_level: '平视拍摄',
    low_angle: '微仰角仰拍',
    high_angle: '微俯角俯拍',
    dutch_angle: '倾斜荷兰角',
  }
  const dofMap = {
    shallow: '浅景深主体突出，背景奶油般柔和虚化',
    medium: '中等景深，主体与环境自然过渡',
    deep: '大景深，前后景均清晰可见',
    extreme_shallow: '超浅景深，焦点极其微薄细腻',
  }

  const shotName = shotMap[vs.shot_type] || vs.shot_type || '中景'
  const hName = hMap[vs.angle_h] || vs.angle_h || ''
  const vName = vMap[vs.angle_v] || vs.angle_v || ''
  const dofName = dofMap[vs.depth_of_field] || ''
  const lensName = vs.cinematic_lens || ''

  const camDesc = [shotName, hName, vName, dofName, lensName].filter(Boolean).join('，')
  parts.push(`【机位景别】${camDesc}`)

  // 3. 角色构图与姿态
  const chars = vs.character_visuals || []
  if (chars.length > 0) {
    const charPhrases = chars.map((c) => {
      const charName = `角色「${c.name}」`
      const items = []
      if (c.depth_layer) items.push(`景深层级${c.depth_layer}`)
      if (c.screen_position) items.push(c.screen_position)
      if (c.environmental_anchor) items.push(c.environmental_anchor)
      else if (c.spatial_anchor) items.push(c.spatial_anchor)
      if (c.facing) items.push(c.facing)
      if (c.expression) items.push(c.expression)
      if (c.head_pose) items.push(c.head_pose)
      if (c.gaze) items.push(c.gaze)
      if (c.posture) items.push(c.posture)
      if (c.hands) items.push(c.hands)
      if (c.prop_interaction) items.push(c.prop_interaction)
      if (c.appearance_details) items.push(c.appearance_details)
      return `${charName}：${items.join('，')}`
    })
    const countRule = `画面中仅有且必须仅有 ${chars.length} 个人物（${chars.map((c) => c.name).join('、')}）。`
    parts.push(`【角色构图与姿态】${countRule}${charPhrases.join('；')}`)
  }

  // 4. 光影影调
  if (vs.lighting_chiaroscuro) {
    parts.push(`【光影影调】${vs.lighting_chiaroscuro}`)
  }

  if (vs.start_framing) parts.push(`【起幅构图】${vs.start_framing}`)
  if (vs.end_framing) parts.push(`【落幅构图】${vs.end_framing}`)
  if (vs.transition_to_next) parts.push(`【下镜转场】${vs.transition_to_next}`)

  // 5. 摄影风格
  parts.push('【摄影风格】photorealistic, ultra-detailed, 8k uhd, sharp focus, natural cinematic lighting, RAW photo, real skin texture，首帧静止画面')

  sbPromptImageText.value = parts.join('\n')
}

async function onRebuildSbImagePrompt() {
  const sb = sbPromptTarget.value
  if (!sb?.id) return
  sbPromptImageRebuilding.value = true
  try {
    const res = await storyboardsAPI.rebuildImagePrompt(sb.id)
    if (res?.image_prompt) {
      sbPromptImageText.value = formatImagePromptForEdit(res.image_prompt)
      sbPromptVisualSlots.value = ensureVisualSlots(res)
      ElMessage.success('已按最新分镜与角色参数重新编译生图提示词与构图槽位')
    }
  } catch (e) {
    ElMessage.error(e.message || '编译生图提示词失败')
  } finally {
    sbPromptImageRebuilding.value = false
  }
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

async function onSaveSbPromptDialog() {
  const sb = sbPromptTarget.value
  if (!sb?.id) return
  sbPromptSaving.value = true
  try {
    if (sbPromptImageSubTab.value === 'slots' && sbPromptVisualSlots.value) {
      syncVisualSlotsToPromptPreview()
    }
    if (sbPromptVideoSlots.value) {
      syncSlotsToPromptPreview()
    }
    const patch = {
      image_prompt: sbPromptImageText.value.trim() || null,
      polished_prompt: sbPromptPolishedText.value.trim() || null,
    }
    if (sbPromptVisualSlots.value) {
      const vs = sbPromptVisualSlots.value
      patch.character_visuals = vs.character_visuals
      patch.last_frame_visuals = vs.last_frame_visuals
      patch.location = vs.location
      patch.time = vs.time
      patch.dialogue_framing = vs.dialogue_framing
      patch.lighting_style = vs.lighting_style
      patch.depth_of_field = vs.depth_of_field
      patch.shot_type = vs.shot_type
      patch.angle_h = vs.angle_h
      patch.angle_v = vs.angle_v
      patch.angle_s = vs.angle_s
      patch.start_framing = vs.start_framing
      patch.end_framing = vs.end_framing
      patch.transition_to_next = vs.transition_to_next
      patch.cinematic_lens = vs.cinematic_lens
      patch.environment_depth = vs.environment_depth
      patch.lighting_chiaroscuro = vs.lighting_chiaroscuro
    }
    if (sbPromptVideoSlots.value) {
      patch.video_slots = sbPromptVideoSlots.value
    }
    if (sbPromptSemanticSlots.value) {
      patch.semantic_slots = sbPromptSemanticSlots.value
    }
    if (sbPromptH3Data.value && dramaId.value) {
      await videosAPI.saveH3Inputs(dramaId.value, sb.id, {
        engine_mode: sbPromptH3Data.value.engine_mode || 'auto',
        first_frame_policy: (sbPromptH3Data.value.engine_mode === 'ref2va' || (sbPromptH3Data.value.engine_mode === 'auto' && sbPromptH3Data.value.agent_mode === 'ref2va')) ? 'agent' : (sbPromptH3Data.value.first_frame_policy_override || 'agent'),
        last_frame_policy: (sbPromptH3Data.value.engine_mode === 'ref2va' || (sbPromptH3Data.value.engine_mode === 'auto' && sbPromptH3Data.value.agent_mode === 'ref2va')) ? 'agent' : (sbPromptH3Data.value.last_frame_policy_override || 'agent'),
      })
    }
    await storyboardsAPI.update(sb.id, patch)
    Object.assign(sb, patch)
    const list = store.currentEpisode?.storyboards
    if (Array.isArray(list)) {
      const row = list.find((x) => Number(x.id) === Number(sb.id))
      if (row) Object.assign(row, patch)
    }
    showSbPromptDialog.value = false
    ElMessage.success('提示词与槽位已保存')
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
    videoParamsTarget.value = { ...sb, ...patch }
    Object.assign(sb, patch)
    const list = store.currentEpisode?.storyboards
    if (Array.isArray(list)) {
      const row = list.find((x) => Number(x.id) === Number(sb.id))
      if (row) Object.assign(row, patch)
    }
    ElMessage.success('已保存，H3 将从最新权威槽位编译输入')
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
        <p><strong>运镜动感度:</strong> 固定镜头占比 ${(stats.static_ratio * 100 || 0).toFixed(1)}% （仅供参考，由导演按剧情决定）</p>
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
      detailHtml += `<p style="color: #67c23a; margin-top: 8px;"><strong>✅ 硬门禁 100% 通过（已由导演智能体在生成阶段严格闭环自检自纠完成，运镜动感度、对白时长、BGM契约全部合格）</strong></p>`
    }

    if (totalWarns > 0) {
      detailHtml += `<p style="color: #e6a23c; margin-top: 6px;"><strong>💡 优化建议 (${totalWarns} 处，非阻断项):</strong></p><ul style="padding-left: 18px; margin: 4px 0; color: #e6a23c;">`
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
  if (isDirectorRefiningShot(sb.id)) {
    ElMessage.info(`第 ${sb.storyboard_number ?? ''} 镜正在后台微调，可刷新页面继续查看进度`)
    return
  }
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

    const res = await ontologyAPI.directorRefineShot(sb.id, instruction.trim())
    const data = res?.data ?? res
    const taskId = data?.task_id
    if (!taskId) throw new Error(data?.message || '未能创建导演微调任务')
    const meta = {
      dramaId: dramaId.value,
      episodeId: currentEpisodeId.value,
      dramaTitle: store.drama?.title,
      episodeNumber: store.currentEpisode?.episode_number,
      resourceType: GEN_RESOURCE.DIRECTOR_REFINE_SHOT,
      resourceId: Number(sb.id),
      label: `${store.currentEpisode?.title || '当前集'} 导演微调 #${sb.storyboard_number ?? sb.id}`,
      taskId,
    }
    genStore?.markRunning(meta)
    ElMessage.success(`第 ${sb.storyboard_number ?? ''} 镜已进入后台微调，刷新页面不会中断`)
    genStore?.pollTask(taskId, meta, async () => {
      await loadDrama()
      ElNotification({
        title: `🎬 第 ${sb.storyboard_number ?? ''} 镜定向微调完成`,
        message: '镜头动作、运镜、光影、声音与完整语义槽位已通过门禁并原子更新。',
        type: 'success',
        duration: 5000,
      })
    }, { ElMessage, maxAttempts: 21600, interval: 2000 })
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error(err.message || '定向微调失败')
    }
  }
}

function isDirectorRefiningShot(storyboardId) {
  if (!genStore || storyboardId == null) return false
  return genStore.getRunningForEpisode(dramaId?.value, currentEpisodeId?.value).some((task) => (
    task.resourceType === GEN_RESOURCE.DIRECTOR_REFINE_SHOT
    && Number(task.resourceId) === Number(storyboardId)
  ))
}

const directorPlanningWarning = computed(() => {
  try {
    directorPlanningInputs(storyboardCount.value, videoDuration.value, { min: shotDurationMin.value, max: shotDurationMax.value })
    return ''
  } catch (error) { return error.message }
})

async function onDirectorAgentGenerate(resumeTaskId = null) {
  if (!currentEpisodeId.value) return
  let planningInputs
  try {
    planningInputs = resumeTaskId ? {} : directorPlanningInputs(storyboardCount.value, videoDuration.value, { min: shotDurationMin.value, max: shotDurationMax.value })
  } catch (error) { ElMessage.warning(error.message); return }
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
  directorTaskMessage.value = '正在启动导演智能体...'
  directorTaskProgress.value = 5
  try {
    const res = await ontologyAPI.directorGenerate(currentEpisodeId.value, resumeTaskId ? { resume_task_id: resumeTaskId } : {
      ...planningInputs,
      shot_duration_range: { min: shotDurationMin.value, max: shotDurationMax.value },
      universal_omni_storyboard: true,
    })
    const taskData = res?.data ?? res
    const taskId = taskData?.task_id
    if (!taskId) {
      throw new Error(taskData?.message || '未能创建导演智能体任务')
    }

    const meta = {
      dramaId: dramaId.value,
      episodeId: currentEpisodeId.value,
      dramaTitle: store.drama?.title,
      episodeNumber: store.currentEpisode?.episode_number,
      resourceType: GEN_RESOURCE.GENERATE_STORYBOARD,
      resourceId: Number(currentEpisodeId.value),
      label: `${store.currentEpisode?.title || '当前集'} 导演生成分镜`,
      taskId,
      taskType: 'director_storyboard_generation',
    }
    await loadLatestDirectorRun(currentEpisodeId.value)

    ElMessage.info('🎬 导演智能体推演已在后台启动，正在规划分镜与自纠质检...')
    directorGenerating.value = false
  } catch (e) {
    ElMessage.error(e.message || '导演智能体启动失败')
    directorGenerating.value = false
    directorTaskMessage.value = ''
    directorTaskProgress.value = 0
  }
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
  const shotModel = selectedShotModel(sb)
  const videoCfg = await getActiveVideoAiConfig(shotModel)
  const h3Request = isH3VideoAiConfig(videoCfg, shotModel)
  let h3Policy = null
  if (h3Request) {
    try {
      const h3Data = await videosAPI.h3Inputs(dramaId.value, sb.id)
      h3Policy = h3ShotInputPolicy(h3Data, { hasFirstFrame: !!getSbFirstFrameUrl(sb) })
    } catch (e) {
      ElMessage.error(e.message || '读取 H3 执行方案失败')
      return
    }
    if (!h3Policy.allowed) {
      await ElMessageBox.alert(h3Policy.reason, 'H3 输入尚未就绪', { confirmButtonText: '知道了', type: 'warning' })
      return
    }
  }
  let universalOmniApi = universal && !h3Request
  if (universalOmniApi) {
    if (!canUseUniversalOmniVideoApi(videoCfg)) {
      try {
        await confirmUniversalUnsupportedVideo()
      } catch {
        return
      }
      universalOmniApi = false
    }
  }
  const omniRefs = universalOmniApi ? collectSbOmniReferenceAbsoluteUrls(sb) : []
  const sceneOnlyRefs = universal && !h3Request && !universalOmniApi ? collectSbSceneOnlyReferenceAbsoluteUrls(sb) : []
  const hasClassicFrame = !!getSbFirstFrameUrl(sb)
  let hasAnyImage = h3Request ? true : false
  if (!h3Request && universalOmniApi) {
    hasAnyImage = omniRefs.length > 0
  } else if (!h3Request && universal) {
    hasAnyImage = hasClassicFrame || sceneOnlyRefs.length > 0
  } else if (!h3Request) {
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
  let genResTaskId = null
  try {
    let absoluteUrl = ''
    let referenceUrls = undefined
    if (h3Request && h3Policy.mode === 'ref2va') {
      // The backend resolves the Agent-planned character/scene/prop references.
      // Sending browser frame fields here would contaminate pure Ref2VA execution.
      absoluteUrl = ''
      referenceUrls = undefined
    } else if (h3Request && h3Policy.firstFramePolicy === 'inherit_tail') {
      // The backend extracts the completed predecessor's actual tail frame.
      absoluteUrl = ''
      referenceUrls = undefined
    } else if (h3Request && h3Policy.mode === 'fl2va') {
      absoluteUrl = toAbsoluteImageUrl(await getMainImageUrlForVideo(sb))
      referenceUrls = absoluteUrl ? [absoluteUrl] : undefined
    } else if (universalOmniApi) {
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
    const useH3StoryboardFrames = h3Request && h3Policy.useStoryboardFrames
    const { first: vFirst, last: vLast } = useH3StoryboardFrames
      ? sbVideoFirstLastUrls(sb, false, null)
      : (h3Request ? { first: undefined, last: undefined } : sbVideoFirstLastUrls(sb, universalOmniApi, null))
    if ((!h3Request || useH3StoryboardFrames) && !universalOmniApi && vLast && referenceUrls && !referenceUrls.includes(vLast)) {
      referenceUrls = [...referenceUrls, vLast]
    }
    const res = await videosAPI.create({
      drama_id: dramaId.value,
      storyboard_id: sb.id,
      model: selectedShotModel(sb),
      image_url: (universalOmniApi || (h3Request && !useH3StoryboardFrames)) ? undefined : ((vFirst || absoluteUrl) || undefined),
      first_frame_url: (universalOmniApi || (h3Request && !useH3StoryboardFrames)) ? undefined : (vFirst || absoluteUrl || undefined),
      last_frame_url: (universalOmniApi || (h3Request && !useH3StoryboardFrames)) ? undefined : vLast,
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
        if (pollRes?.result?.video_generation_id) {
          sbSelectedVideoId.value = { ...sbSelectedVideoId.value, [sb.id]: pollRes.result.video_generation_id }
          const row = (store.storyboards || []).find((b) => b.id === sb.id)
          if (row) {
            row.selected_video_id = pollRes.result.video_generation_id
            if (pollRes.result.video_url) row.video_url = pollRes.result.video_url
          }
        }
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
      if (pollRes?.result?.video_generation_id) {
        sbSelectedVideoId.value = { ...sbSelectedVideoId.value, [sb.id]: pollRes.result.video_generation_id }
        const row = (store.storyboards || []).find((b) => b.id === sb.id)
        if (row) {
          row.selected_video_id = pollRes.result.video_generation_id
          if (pollRes.result.video_url) row.video_url = pollRes.result.video_url
        }
      }
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

function speechStatus(sb) { return shotSpeechStatus(sb, speechSummaries.value[sb.id]) }
function defaultShotModel(sb) { return automaticVideoModel(videoModelConfigs.value, speechStatus(sb)) }
function selectedShotModel(sb) { return sb.video_model || defaultShotModel(sb) || undefined }
function videoModelLabel(model) {
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

async function onClearEpisodeMedia(mode = 'all') {
  if (!currentEpisodeId.value) return
  let title = '确认清除参考帧与分镜视频'
  let message = '确定要清除当前集所有分镜的参考帧（首尾帧图片）和分镜视频吗？相关的生成历史记录也将被重置。'
  let clearImages = true
  let clearVideos = true

  if (mode === 'videos') {
    title = '确认清除分镜视频'
    message = '确定要清除当前集所有分镜的生成视频吗？参考帧（首尾帧图片）将保留。'
    clearImages = false
    clearVideos = true
  } else if (mode === 'images') {
    title = '确认清除参考帧图片'
    message = '确定要清除当前集所有分镜的参考帧（首尾帧图片）吗？分镜视频将保留。'
    clearImages = true
    clearVideos = false
  }

  try {
    await ElMessageBox.confirm(message, title, {
      confirmButtonText: '确定清除',
      cancelButtonText: '取消',
      type: 'warning',
      confirmButtonClass: 'el-button--danger',
    })
  } catch {
    return
  }

  const loading = ElLoading.service({
    lock: true,
    text: '正在清除分镜媒体与关联任务...',
    background: 'rgba(0, 0, 0, 0.7)',
  })
  try {
    const res = await storyboardsAPI.clearEpisodeMedia(currentEpisodeId.value, {
      clear_images: clearImages,
      clear_videos: clearVideos,
    })
    const data = res?.data ?? res
    if (clearImages) {
      sbSelectedImgId.value = {}
      sbSelectedLastImgId.value = {}
    }
    if (clearVideos) {
      sbSelectedVideoId.value = {}
      sbVideoErrors.value = {}
    }
    if (typeof refreshStoryboardsOnly === 'function') {
      await refreshStoryboardsOnly()
    } else if (typeof loadDrama === 'function') {
      await loadDrama()
    }
    if (typeof loadStoryboardMedia === 'function') {
      await loadStoryboardMedia()
    }
    if (typeof restoreSelectionsFromBackend === 'function') {
      restoreSelectionsFromBackend()
    }
    const count = data?.cleared_storyboards ?? 0
    ElMessage.success(`清除完成，已重置 ${count} 条分镜媒体`)
  } catch (err) {
    ElMessage.error(err.message || '清除失败')
  } finally {
    loading.close()
  }
}

async function onClearEpisodeStoryboards() {
  if (!currentEpisodeId.value || !storyboards.value.length) return
  try {
    await ElMessageBox.confirm(
      '将软删除当前集全部分镜脚本，并清除关联参考帧、视频和相关生成记录。剧本、角色、道具、场景不会删除。确认后再点击“导演生成分镜脚本”即可从空白状态重新规划。',
      '清空当前集分镜脚本',
      {
        confirmButtonText: '确认清空',
        cancelButtonText: '取消',
        type: 'warning',
        confirmButtonClass: 'el-button--danger',
      },
    )
  } catch {
    return
  }

  const loading = ElLoading.service({
    lock: true,
    text: '正在清空当前集分镜脚本与媒体...',
    background: 'rgba(0, 0, 0, 0.7)',
  })
  try {
    const res = await storyboardsAPI.clearEpisodeStoryboards(currentEpisodeId.value)
    const data = res?.data ?? res
    await loadDrama()
    sbSelectedImgId.value = {}
    sbSelectedLastImgId.value = {}
    sbSelectedVideoId.value = {}
    sbVideoErrors.value = {}
    ElMessage.success(`已清空 ${data?.cleared_storyboards ?? 0} 个分镜脚本，现在可以重新生成`)
  } catch (err) {
    ElMessage.error(err.message || '清空分镜脚本失败')
  } finally {
    loading.close()
  }
}

async function onClearSingleStoryboardMedia(sb, mode = 'all') {
  if (!sb?.id) return
  const num = sb.storyboard_number ? `#${sb.storyboard_number}` : ''
  let title = `确认清除分镜 ${num} 媒体`
  let message = `确定要清除分镜 ${num} 的参考帧与视频吗？`
  let clearImages = true
  let clearVideos = true

  if (mode === 'videos') {
    title = `确认清除分镜 ${num} 视频`
    message = `确定要清除分镜 ${num} 的生成视频吗？参考帧将保留。`
    clearImages = false
    clearVideos = true
  } else if (mode === 'images') {
    title = `确认清除分镜 ${num} 参考帧`
    message = `确定要清除分镜 ${num} 的参考帧（首尾帧图片）吗？分镜视频将保留。`
    clearImages = true
    clearVideos = false
  }

  try {
    await ElMessageBox.confirm(message, title, {
      confirmButtonText: '确定清除',
      cancelButtonText: '取消',
      type: 'warning',
      confirmButtonClass: 'el-button--danger',
    })
  } catch {
    return
  }

  try {
    await storyboardsAPI.clearStoryboardMedia(sb.id, {
      clear_images: clearImages,
      clear_videos: clearVideos,
    })
    if (clearImages) {
      delete sbSelectedImgId.value[sb.id]
      delete sbSelectedLastImgId.value[sb.id]
    }
    if (clearVideos) {
      delete sbSelectedVideoId.value[sb.id]
      delete sbVideoErrors.value[sb.id]
    }
    if (typeof loadSingleStoryboardMedia === 'function') {
      await loadSingleStoryboardMedia(sb.id)
    } else if (typeof loadStoryboardMedia === 'function') {
      await loadStoryboardMedia()
    }
    if (typeof refreshStoryboardsOnly === 'function') {
      await refreshStoryboardsOnly()
    }
    if (typeof restoreSelectionsFromBackend === 'function') {
      restoreSelectionsFromBackend()
    }
    ElMessage.success(`分镜 ${num} 媒体已清除`)
  } catch (err) {
    ElMessage.error(err.message || '清除失败')
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
  isDirectorRefiningShot,
  onDirectorAgentGenerate,
  onAddSingleStoryboard,
  onInsertStoryboardBefore,
  onDeleteSingleStoryboard,
  onClearEpisodeMedia,
  onClearSingleStoryboardMedia,
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
  onUniversalSegmentPromptMenu,
  onGenerateUniversalSegmentPrompt,
  onPolishUniversalSegmentPromptStream,
  getMainImageUrlForVideo,
  toAbsoluteImageUrl,
  sbUniversalSegmentTrimmed,
  sbCanSubmitVideo,
  getSbUniversalOmniRefSlots,
  collectSbOmniReferenceAbsoluteUrls,
  collectSbSceneOnlyReferenceAbsoluteUrls,
  getActiveVideoAiConfig,
  confirmUniversalUnsupportedVideo,
  onEditSbImagePrompt,
  formatImagePromptForEdit,
  onPolishSbPrompt,
  onRebuildSbImagePrompt,
  onSaveSbPromptDialog,
  onSaveSbImagePrompt,
  angleToPromptFragment,
  onSaveSbVideoFields,
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

defineExpose({
  stopBatchImageGeneration,
  stopBatchVideoGeneration,
  invalidateActiveVideoAiConfigCache,
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
:deep(.sb-prompt-dialog) {
  max-width: 96vw;
  border-radius: 12px;
}
:deep(.sb-prompt-dialog .el-dialog__body) {
  max-height: calc(88vh - 100px);
  overflow-y: auto;
  padding: 14px 22px 14px;
}
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

.storyboard-cards-list {
  margin-top: 20px;
}

.director-run-audit {
  margin-top: 10px;
  padding: 9px 12px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 8px 16px;
  border: 1px solid #dbeafe;
  border-radius: 8px;
  background: #f8fbff;
  color: #475569;
  font-size: 12px;
}
.director-run-audit__header { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 7px 12px; min-width: 0; }
.director-run-audit__header strong { color: #1e3a8a; }
.director-run-audit__time { color: #64748b; }
.director-run-audit__badge { padding: 2px 7px; border-radius: 999px; background: #e0ecff; color: #315b9b; }
.director-run-audit__progress { grid-column: 1 / -1; display: flex; align-items: center; gap: 10px; min-width: 0; color: #475569; }
.director-run-audit__progress .el-progress { flex: 0 0 150px; }
.director-run-audit__progress span { min-width: 0; overflow-wrap: anywhere; }
.director-run-audit__usage { grid-column: 1 / -1; color: #475569; }
.director-run-audit__usage-text { overflow-wrap: anywhere; }
.director-run-audit__checkpoint { grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 10px; border: 1px solid #fecaca; border-radius: 6px; background: #fff7f7; color: #7f1d1d; }
.director-run-audit__checkpoint > div { display: grid; gap: 2px; min-width: 0; }
.director-run-audit__checkpoint small { color: #991b1b; }
.director-run-audit__id { color: #94a3b8; font-family: monospace; white-space: nowrap; }
:global(html.dark .director-run-audit) { border-color: #334155; background: #0f172a; color: #cbd5e1; }
:global(html.dark .director-run-audit__header strong) { color: #93c5fd; }
:global(html.dark .director-run-audit__badge) { background: #172554; color: #bfdbfe; }
:global(html.dark .director-run-audit__checkpoint) { border-color: #7f1d1d; background: #2a1111; color: #fecaca; }
:global(html.dark .director-run-audit__checkpoint small) { color: #fca5a5; }
@media (max-width: 800px) {
  .director-run-audit { grid-template-columns: 1fr; }
  .director-run-audit__progress { align-items: flex-start; flex-direction: column; }
  .director-run-audit__progress .el-progress { flex-basis: auto; width: 100%; }
  .director-run-audit__checkpoint { align-items: flex-start; flex-direction: column; }
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

/* 视频语义槽位与多镜头时间线编辑器样式 */
.sb-slots-view {
  max-height: 480px;
  overflow-y: auto;
  padding-right: 4px;
}
.sb-slots-timeline-container {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.sb-slot-shot-card {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 12px 14px;
}
html.light .sb-slot-shot-card {
  background: #f8fafc;
  border-color: #e2e8f0;
}
.sb-slot-shot-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.sb-slot-shot-title {
  display: flex;
  align-items: center;
  gap: 8px;
}
.sb-slot-shot-badge {
  background: #4f46e5;
  color: #ffffff;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 4px;
}
.sb-slot-shot-time {
  font-size: 12px;
  color: #475569;
  font-weight: 500;
}
.sb-slot-shot-dur {
  font-size: 11px;
  color: #64748b;
  background: #e2e8f0;
  padding: 1px 6px;
  border-radius: 4px;
}
.sb-slot-shot-cam {
  display: flex;
  align-items: center;
  gap: 6px;
}
.sb-slot-action-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 8px;
}
.sb-slot-field-label {
  font-size: 12px;
  color: #475569;
  font-weight: 500;
}
.sb-slot-chars-container {
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  padding: 8px 10px;
  margin-bottom: 8px;
}
.sb-slot-section-subtitle {
  font-size: 11px;
  font-weight: 600;
  color: #64748b;
  margin-bottom: 6px;
}
.sb-slot-char-card {
  margin-bottom: 6px;
  padding-bottom: 6px;
  border-bottom: 1px dashed #f1f5f9;
}
.sb-slot-char-card:last-child {
  margin-bottom: 0;
  padding-bottom: 0;
  border-bottom: none;
}
.sb-slot-char-name {
  font-size: 12px;
  font-weight: 600;
  color: #1e293b;
  margin-bottom: 4px;
}
.sb-slot-char-grid {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.sb-slot-char-item {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  min-width: 120px;
}
.sb-slot-mini-label {
  font-size: 11px;
  color: #64748b;
  white-space: nowrap;
}
.sb-slot-dialogue-box {
  display: flex;
  align-items: center;
  gap: 8px;
  background: #f1f5f9;
  padding: 6px 10px;
  border-radius: 4px;
}
.sb-slot-h3-media-card {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 12px;
}
.sb-slot-h3-header-right {
  display: flex;
  align-items: center;
  gap: 6px;
}
.sb-h3-media-subgroup {
  margin-top: 8px;
}
.sb-h3-subgroup-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  font-weight: 600;
  color: #334155;
  margin-bottom: 8px;
}
.sb-h3-picture-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 10px;
}
.sb-h3-picture-item {
  display: flex;
  gap: 8px;
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  padding: 6px 8px;
  align-items: center;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.sb-h3-picture-item:hover {
  border-color: #a855f7;
}
.sb-h3-picture-item--opening {
  border-color: #c084fc;
  background: #faf5ff;
}
.sb-h3-pic-thumb-wrap {
  position: relative;
  width: 52px;
  height: 52px;
  border-radius: 4px;
  overflow: hidden;
  flex-shrink: 0;
  background: #0f172a;
}
.sb-h3-pic-thumb {
  width: 100%;
  height: 100%;
}
.sb-h3-pic-tag {
  position: absolute;
  top: 0;
  left: 0;
  background: rgba(124, 58, 237, 0.88);
  color: #fff;
  font-size: 9.5px;
  padding: 1px 4px;
  border-bottom-right-radius: 4px;
  font-family: monospace;
  font-weight: bold;
}
.sb-h3-pic-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.sb-h3-pic-name {
  font-size: 12px;
  font-weight: 600;
  color: #1e293b;
  display: flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sb-h3-mini-tag {
  font-size: 10px;
  padding: 0 4px;
  height: 18px;
  line-height: 18px;
}
.sb-h3-pic-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.sb-h3-badge-kind {
  font-size: 10px;
  color: #64748b;
  background: #f1f5f9;
  padding: 1px 4px;
  border-radius: 3px;
}
.sb-h3-badge-retention {
  font-size: 9.5px;
  color: #7c3aed;
  background: #ede9fe;
  padding: 1px 4px;
  border-radius: 3px;
  font-family: monospace;
}
.sb-h3-audio-grid {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.sb-h3-audio-item {
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  padding: 7px 10px;
}
.sb-h3-audio-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
  flex-wrap: wrap;
}
.sb-h3-audio-tag {
  background: #4338ca;
  color: #ffffff;
  font-size: 10px;
  font-family: monospace;
  font-weight: bold;
  padding: 1px 5px;
  border-radius: 3px;
}
.sb-h3-speaker-tag {
  font-size: 12px;
  font-weight: 600;
  color: #1e293b;
}
.sb-h3-audio-kind {
  font-size: 11px;
  color: #64748b;
}
.sb-h3-audio-voice-name {
  font-size: 11px;
  color: #059669;
  background: #ecfdf5;
  padding: 1px 5px;
  border-radius: 3px;
  margin-left: auto;
}
.sb-h3-audio-line {
  font-size: 12px;
  color: #334155;
  line-height: 1.4;
  background: #f8fafc;
  padding: 4px 8px;
  border-radius: 4px;
  font-family: monospace;
  word-break: break-all;
}
.sb-h3-d-tag {
  color: #d97706;
  font-weight: bold;
}
.sb-h3-empty-hint {
  font-size: 12px;
  color: #94a3b8;
  padding: 8px 12px;
  background: #ffffff;
  border-radius: 6px;
  border: 1px dashed #cbd5e1;
}
:global(html.dark .sb-slot-h3-media-card) {
  background: #0f172a;
  border-color: #334155;
}
:global(html.dark .sb-h3-picture-item) {
  background: #1e293b;
  border-color: #334155;
}
:global(html.dark .sb-h3-picture-item--opening) {
  background: #1e1b4b;
  border-color: #6b21a8;
}
:global(html.dark .sb-h3-pic-name),
:global(html.dark .sb-h3-speaker-tag) {
  color: #f1f5f9;
}
:global(html.dark .sb-h3-badge-kind) {
  background: #334155;
  color: #cbd5e1;
}
:global(html.dark .sb-h3-audio-item) {
  background: #1e293b;
  border-color: #334155;
}
:global(html.dark .sb-h3-audio-line) {
  background: #0f172a;
  color: #cbd5e1;
}
:global(html.dark .sb-h3-empty-hint) {
  background: #1e293b;
  border-color: #334155;
  color: #64748b;
}
.sb-slot-soundscape-card {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 10px 12px;
}
.sb-slot-global-card {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 10px 12px;
}
.sb-slots-empty-card {
  background: #f8fafc;
  border: 1px dashed #cbd5e1;
  border-radius: 8px;
  padding: 24px;
  text-align: center;
}

/* 图片提示词分层预览卡片样式 */
.sb-image-prompt-layers-box {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 12px;
}
.sb-image-prompt-layers-grid {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.sb-image-layer-card {
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-left: 4px solid #64748b;
  border-radius: 6px;
  padding: 10px 12px;
  transition: all 0.2s ease;
}
.sb-image-layer-card:hover {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
}
.sb-image-layer-card.layer--location {
  border-left-color: #0284c7;
  background: #f0f9ff;
}
.sb-image-layer-card.layer--camera {
  border-left-color: #d97706;
  background: #fffbeb;
}
.sb-image-layer-card.layer--characters {
  border-left-color: #16a34a;
  background: #f0fdf4;
}
.sb-image-layer-card.layer--lighting {
  border-left-color: #ca8a04;
  background: #fefce8;
}
.sb-image-layer-card.layer--style {
  border-left-color: #6b7280;
  background: #f9fafb;
}
.sb-image-layer-header {
  margin-bottom: 6px;
}
.sb-image-layer-tag {
  font-weight: 600;
  font-size: 11px;
}
.sb-image-layer-body {
  font-size: 13px;
  line-height: 1.6;
  color: #1e293b;
  word-break: break-word;
}
:global(html.dark .sb-image-prompt-layers-box) {
  background: #0f172a;
  border-color: #334155;
}
:global(html.dark .sb-image-layer-card) {
  background: #1e293b;
  border-color: #334155;
}
:global(html.dark .sb-image-layer-card.layer--location) {
  border-left-color: #38bdf8;
  background: #0f172a;
}
:global(html.dark .sb-image-layer-card.layer--camera) {
  border-left-color: #f59e0b;
  background: #0f172a;
}
:global(html.dark .sb-image-layer-card.layer--characters) {
  border-left-color: #4ade80;
  background: #0f172a;
}
:global(html.dark .sb-image-layer-card.layer--lighting) {
  border-left-color: #facc15;
  background: #0f172a;
}
:global(html.dark .sb-image-layer-card.layer--style) {
  border-left-color: #94a3b8;
  background: #0f172a;
}
:global(html.dark .sb-image-layer-body) {
  color: #f1f5f9;
}
</style>
