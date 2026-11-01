<template>
  <div class="storyboard-batch-toolbar">
    <div class="sb-config-row">
      <label class="sb-config-item">
        <span class="sb-config-label">分镜数量</span>
        <el-input-number
          :model-value="storyboardCount"
          :min="1"
          :max="200"
          :step="1"
          placeholder="自动"
          class="sb-config-input"
          @update:model-value="$emit('update:storyboardCount', $event)"
        />
        <span class="sb-config-hint sb-config-hint--estimate" :title="scriptEstimateStoryboardTitle">
          留空由 AI 决定{{ scriptEstimateStoryboardHint }}
        </span>
      </label>
      <span class="sb-config-divider">｜</span>
      <label class="sb-config-item">
        <span class="sb-config-label">视频总时长(秒)</span>
        <el-input-number
          :model-value="videoDuration"
          :min="10"
          :max="600"
          :step="5"
          placeholder="自动"
          class="sb-config-input"
          @update:model-value="$emit('update:videoDuration', $event)"
        />
        <span class="sb-config-hint sb-config-hint--estimate" :title="scriptEstimateVideoDurationTitle">
          留空由 AI 决定{{ scriptEstimateVideoDurationHint }}
        </span>
      </label>
      <span class="sb-config-hint">手动值须能容纳完整台词与动作；不足时导演会给出调整建议。</span>
      <el-alert v-if="planningWarning" :title="planningWarning" type="warning" :closable="false" show-icon />
      <span class="sb-config-divider">｜</span>
      <label class="sb-config-item">
        <span class="sb-config-label">序列图模式</span>
        <el-select
          :model-value="gridMode"
          size="small"
          style="width:110px"
          :disabled="storyboardUseFirstLastFrame"
          @update:model-value="$emit('update:gridMode', $event)"
        >
          <el-option label="单张" value="single" />
          <el-option label="四宫格" value="quad_grid" />
          <el-option label="九宫格" value="nine_grid" />
        </el-select>
        <span class="sb-config-hint">四/九宫格自动按视角拆分</span>
      </label>
    </div>

    <div class="sb-config-row sb-narration-export-row" style="margin-top:10px;flex-wrap:wrap;align-items:center;gap:12px">
      <el-button
        v-if="hasStoryboards"
        class="sb-export-srt-btn"
        size="small"
        plain
        type="primary"
        :disabled="!hasEpisode"
        :loading="exportingStoryboardSheet"
        @click="$emit('export-storyboard-sheet')"
      >
        导出分镜表excel
      </el-button>
      <el-button
        v-if="hasStoryboards"
        class="sb-export-srt-btn"
        size="small"
        plain
        type="primary"
        :disabled="!hasEpisode"
        @click="$emit('export-narration-srt')"
      >
        导出解说 SRT
      </el-button>
    </div>

    <div class="asset-actions sb-batch-actions">
      <div class="flex">
        <el-button
          type="primary"
          size="large"
          :loading="directorGenerating || storyboardGenerating || universalOmniPolishRunning"
          :disabled="!hasEpisode || directorGenerating || storyboardGenerating || universalOmniPolishRunning"
          title="由导演智能体根据剧本与视听本体库闭环编排分镜脚本"
          @click="$emit('director-generate')"
        >
          <template v-if="directorGenerating">🎬 导演正在推演编排分镜...</template>
          <template v-else>🎬 导演生成分镜脚本{{ hasStoryboards ? '（重编）' : '' }}</template>
        </el-button>
        <el-button type="info" plain size="large" @click="$emit('add-storyboard')">
          添加一个分镜
        </el-button>
        <el-button
          v-if="hasStoryboards"
          type="success"
          plain
          size="large"
          :loading="auditingInvariants"
          title="查看视听本体硬门禁审查报告（导演智能体已在生成时自动完成闭环质检与自纠）"
          @click="$emit('audit-invariants')"
        >
          🛡️ 视听本体质检
        </el-button>
      </div>

      <template v-if="hasStoryboards">
        <div class="sb-batch-right">
          <el-button
            type="success"
            plain
            size="large"
            :loading="batchImageRunning && !singleShotImageInfo"
            title="按每镜 Agent 方案补齐所需参考帧：FL2VA 必须有首帧、尾帧按剧情选配；Ref2VA 不生成首尾帧。人工模式覆盖会同步改变本次计划。"
            :disabled="!hasEpisode || batchImageRunning || batchVideoRunning || pipelineRunning || storyboardGenerating || universalOmniPolishRunning"
            @click="$emit('start-batch-image')"
          >
            批量生成所需参考帧
          </el-button>
          <el-button
            type="warning"
            plain
            size="large"
            :loading="batchVideoRunning"
            :disabled="!hasEpisode || batchImageRunning || batchVideoRunning || pipelineRunning || storyboardGenerating || universalOmniPolishRunning"
            @click="$emit('start-batch-video')"
          >
            批量生成分镜视频
          </el-button>
          <slot name="batch-speech" />
          <el-dropdown
            split-button
            type="danger"
            size="large"
            plain
            :disabled="!hasEpisode || batchImageRunning || batchVideoRunning || pipelineRunning || storyboardGenerating"
            title="一键清除当前集分镜的参考帧和分镜视频"
            @click="$emit('clear-media', 'all')"
            @command="cmd => $emit('clear-media', cmd)"
          >
            🗑️ 一键清除参考帧和分镜视频
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="all">
                  <span style="color: #f56c6c; font-weight: 600;">全部清除（参考帧 + 视频）</span>
                </el-dropdown-item>
                <el-dropdown-item command="videos">仅清除分镜视频</el-dropdown-item>
                <el-dropdown-item command="images">仅清除参考帧（首尾帧图片）</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <el-button
            type="danger"
            plain
            size="large"
            :disabled="!hasEpisode || batchImageRunning || batchVideoRunning || pipelineRunning || storyboardGenerating || universalOmniPolishRunning"
            title="软删除当前集已有分镜及其媒体；剧本、角色、道具和场景保留，之后可重新运行导演规划"
            @click="$emit('clear-storyboards')"
          >
            🧹 清空当前集分镜脚本
          </el-button>
          <el-button v-if="batchImageRunning" size="large" type="danger" plain @click="$emit('stop-batch-image')">
            停止图片
          </el-button>
          <el-button v-if="batchVideoRunning" size="large" type="danger" plain @click="$emit('stop-batch-video')">
            停止视频
          </el-button>
        </div>
      </template>
    </div>

    <!-- 批量生成进度 -->
    <div v-if="batchImageRunning || batchVideoRunning || (batchImageErrors && batchImageErrors.length) || (batchVideoErrors && batchVideoErrors.length)" class="batch-status">
      <div v-if="batchImageRunning" class="batch-progress">
        <el-icon class="is-loading"><Loading /></el-icon>
        <span v-if="singleShotImageInfo">
          后台生成分镜 {{ singleShotImageInfo.sbNum ? '#' + singleShotImageInfo.sbNum + ' ' : '' }}{{ singleShotImageInfo.slotText }}（可关闭页面）<template v-if="singleShotImageInfo.queuedCount > 0">，还有 {{ singleShotImageInfo.queuedCount }} 个任务排队中</template>
        </span>
        <span v-else>
          后台批量生成所需参考帧（可关闭页面）：{{ batchImageProgress.current }}/{{ batchImageProgress.total }}
        </span>
        <span v-if="batchImageProgress && batchImageProgress.failed > 0" class="batch-failed">
          {{ batchImageProgress.failed }} 条失败
        </span>
        <span v-if="batchImageStopping" class="batch-stopping">（正在停止...）</span>
      </div>
      <div v-if="batchVideoRunning" class="batch-progress">
        <el-icon class="is-loading"><Loading /></el-icon>
        <span>
          后台批量生成分镜视频：{{ batchVideoProgress.current }}/{{ batchVideoProgress.total }}（可关闭页面）
        </span>
        <span v-if="batchVideoProgress && batchVideoProgress.failed > 0" class="batch-failed">
          {{ batchVideoProgress.failed }} 条失败
        </span>
        <span v-if="batchVideoStopping" class="batch-stopping">（正在停止...）</span>
      </div>
      <div v-if="batchImageErrors && batchImageErrors.length > 0" class="batch-error-log">
        <div class="batch-error-header">
          <span class="batch-error-title">分镜图生成失败记录（{{ batchImageErrors.length }} 条）：</span>
          <div class="batch-error-actions">
            <el-button size="small" text @click="$emit('clear-batch-image-errors')">清除记录</el-button>
          </div>
        </div>
        <div v-for="(e, i) in batchImageErrors" :key="i" class="batch-error-line">{{ e }}</div>
      </div>
      <div v-if="batchVideoErrors && batchVideoErrors.length > 0" class="batch-error-log">
        <div class="batch-error-header">
          <span class="batch-error-title">分镜视频生成失败记录（{{ batchVideoErrors.length }} 条）：</span>
          <div class="batch-error-actions">
            <el-button size="small" type="primary" plain :loading="batchVideoSubmitting" @click="$emit('retry-failed-batch-videos')">
              一键重试失败分镜
            </el-button>
            <el-button size="small" text @click="$emit('clear-batch-video-errors')">
              清除记录
            </el-button>
          </div>
        </div>
        <div v-for="(e, i) in batchVideoErrors" :key="i" class="batch-error-line">{{ e }}</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { Loading } from '@element-plus/icons-vue'

defineProps({
  planningWarning: { type: String, default: '' },
  storyboardCount: { type: [Number, String, null], default: null },
  videoDuration: { type: [Number, String, null], default: null },
  gridMode: { type: String, default: 'single' },
  storyboardUseFirstLastFrame: { type: Boolean, default: false },
  videoFrameContiguity: { type: Boolean, default: false },
  hasStoryboards: { type: Boolean, default: false },
  hasEpisode: { type: Boolean, default: false },
  scriptEstimateStoryboardTitle: { type: String, default: '' },
  scriptEstimateStoryboardHint: { type: String, default: '' },
  scriptEstimateVideoDurationTitle: { type: String, default: '' },
  scriptEstimateVideoDurationHint: { type: String, default: '' },
  directorGenerating: { type: Boolean, default: false },
  storyboardGenerating: { type: Boolean, default: false },
  universalOmniPolishRunning: { type: Boolean, default: false },
  inferringParams: { type: Boolean, default: false },
  auditingInvariants: { type: Boolean, default: false },
  batchImageRunning: { type: Boolean, default: false },
  batchVideoRunning: { type: Boolean, default: false },
  batchImageStopping: { type: Boolean, default: false },
  batchVideoStopping: { type: Boolean, default: false },
  pipelineRunning: { type: Boolean, default: false },
  singleShotImageInfo: { type: Object, default: () => null },
  batchImageProgress: { type: Object, default: () => ({ current: 0, total: 0, failed: 0 }) },
  batchVideoProgress: { type: Object, default: () => ({ current: 0, total: 0, failed: 0 }) },
  batchImageErrors: { type: Array, default: () => [] },
  batchVideoErrors: { type: Array, default: () => [] },
  batchVideoSubmitting: { type: Boolean, default: false },
  exportingStoryboardSheet: { type: Boolean, default: false },
})

defineEmits([
  'update:storyboardCount',
  'update:videoDuration',
  'update:gridMode',
  'update:videoFrameContiguity',
  'save-settings',
  'director-generate',
  'add-storyboard',
  'batch-infer-params',
  'audit-invariants',
  'start-batch-image',
  'start-batch-video',
  'clear-media',
  'clear-storyboards',
  'stop-batch-image',
  'stop-batch-video',
  'export-storyboard-sheet',
  'export-narration-srt',
  'clear-batch-image-errors',
  'clear-batch-video-errors',
  'retry-failed-batch-videos',
])

</script>

<style scoped>
.storyboard-batch-toolbar {
  margin-bottom: 22px;
}
.sb-batch-actions {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 8px;
}
.sb-batch-actions > .flex {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}
.sb-batch-right {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}
</style>
