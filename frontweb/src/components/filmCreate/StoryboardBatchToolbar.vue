<template>
  <div class="storyboard-batch-toolbar">
    <div class="sb-config-row">
      <label class="sb-config-item">
        <span class="sb-config-label">分镜数量</span>
        <el-input-number
          :model-value="storyboardCount"
          :min="1"
          :max="200"
          :step="5"
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
      <el-checkbox
        :model-value="storyboardUniversalOmni"
        @update:model-value="$emit('update:storyboardUniversalOmni', $event)"
        @change="$emit('save-settings', false)"
      >
        全能分镜模式（每镜输出多子分镜段落式 universal_segment_text，与「生成/润色全能提示词」同版式）
      </el-checkbox>
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
          type="warning"
          plain
          size="large"
          :loading="inferringParams"
          title="智能分析全集分镜动作、氛围与台词，自动补齐视角、灯光风格、景深与运镜"
          @click="$emit('batch-infer-params')"
        >
          ⚡ 智能补全镜头参数
        </el-button>
        <el-button
          v-if="hasStoryboards"
          type="success"
          plain
          size="large"
          :loading="auditingInvariants"
          title="运行 SHACL 风格视听本体门禁检验：检查运镜动感度、无对白BGM、人脸防拥挤及空间防跳切"
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
            :title="storyboardUseFirstLastFrame ? '仅补齐缺失的首尾帧；每镜先完成首帧，再生成尾帧，已有图片会跳过。' : '仅补齐缺失的分镜图片，已有图片会跳过。'"
            :disabled="!hasEpisode || batchImageRunning || batchVideoRunning || pipelineRunning || storyboardGenerating || universalOmniPolishRunning"
            @click="$emit('start-batch-image')"
          >
            {{ storyboardUseFirstLastFrame ? '批量生成首尾帧' : '批量生成分镜图' }}
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
          <el-button
            type="primary"
            size="large"
            :loading="batchDubbingStarting"
            :disabled="!hasEpisode || pipelineRunning || storyboardGenerating || universalOmniPolishRunning"
            title="根据各分镜已整理的台词文本与角色音色，批量调用 TTS 生成语音音频"
            @click="$emit('start-batch-dubbing')"
          >
            🎙️ 批量对白与旁白配音(TTS)
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
          后台{{ storyboardUseFirstLastFrame ? '批量生成首尾帧' : '批量生成分镜图' }}（可关闭页面）：{{ batchImageProgress.current }}/{{ batchImageProgress.total }}
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
  storyboardCount: { type: [Number, String, null], default: null },
  videoDuration: { type: [Number, String, null], default: null },
  gridMode: { type: String, default: 'single' },
  storyboardUniversalOmni: { type: Boolean, default: false },
  storyboardUseFirstLastFrame: { type: Boolean, default: false },
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
  batchDubbingStarting: { type: Boolean, default: false },
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
  'update:storyboardUniversalOmni',
  'save-settings',
  'director-generate',
  'add-storyboard',
  'batch-infer-params',
  'audit-invariants',
  'start-batch-image',
  'start-batch-video',
  'start-batch-dubbing',
  'stop-batch-image',
  'stop-batch-video',
  'export-storyboard-sheet',
  'export-narration-srt',
  'clear-batch-image-errors',
  'clear-batch-video-errors',
  'retry-failed-batch-videos',
])
</script>
