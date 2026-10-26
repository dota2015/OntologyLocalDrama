<template>
  <div v-if="activeTasks && activeTasks.length > 0" class="atp-panel">
    <!-- 折叠态：只显示旋转点和数量 -->
    <div v-if="navCollapsed" class="atp-collapsed-badge" :title="activeTaskLabels.join('\n')">
      <span class="atp-spin-dot" />
      <span class="atp-collapsed-count">{{ activeTasks.length }}</span>
    </div>
    <!-- 展开态：标题 + 任务列表 -->
    <template v-else>
      <div class="atp-header">
        <span class="atp-spin-dot" />
        <span class="atp-title">任务进度</span>
        <span class="atp-count-badge">{{ activeTasks.length }}</span>
        <div class="atp-header-stats">
          <span v-if="runningCount > 0" class="atp-header-stat atp-header-running">{{ runningCount }} 正在跑</span>
          <span v-if="waitingCount > 0" class="atp-header-stat atp-header-waiting">{{ waitingCount }} 等待中</span>
        </div>
      </div>
      <div class="atp-list">
        <div
          v-for="item in activeTasks.slice(0, 50)"
          :key="item.id"
          class="atp-item"
          :class="[
            item.isWaiting ? 'atp-item--waiting' : 'atp-item--running',
            { 'atp-item--clickable': !!getAnchor(item) }
          ]"
          :title="getAnchor(item) ? '点击跳转到对应分镜' : item.label"
          @click="$emit('navigate', item)"
        >
          <span class="atp-item-dot" :class="item.isWaiting ? 'atp-dot--waiting' : 'atp-dot--running'" />
          <el-tooltip :content="item.label" placement="right" :show-after="300" :enterable="false">
            <span class="atp-item-label">{{ item.label }}</span>
          </el-tooltip>
          <span class="atp-status-tag" :class="item.isWaiting ? 'atp-tag--waiting' : 'atp-tag--running'">
            {{ item.isWaiting ? '等待中' : '生成中' }}
          </span>
          <button
            type="button"
            class="atp-item-close"
            title="取消任务"
            aria-label="取消任务"
            @click.stop="$emit('cancel', item)"
          >
            <el-icon :size="12"><Close /></el-icon>
          </button>
        </div>
        <el-tooltip
          v-if="activeTasks.length > 50"
          :content="activeTasks.slice(50).map((t) => t.label).join('\n')"
          placement="right"
          :show-after="200"
        >
          <div class="atp-more">
            还有 {{ activeTasks.length - 50 }} 个任务...
          </div>
        </el-tooltip>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { Close } from '@element-plus/icons-vue'

const props = defineProps({
  navCollapsed: {
    type: Boolean,
    default: false,
  },
  activeTasks: {
    type: Array,
    default: () => [],
  },
  runningCount: {
    type: Number,
    default: 0,
  },
  waitingCount: {
    type: Number,
    default: 0,
  },
  getAnchor: {
    type: Function,
    default: () => null,
  },
})

defineEmits(['navigate', 'cancel'])

const activeTaskLabels = computed(() => (props.activeTasks || []).map((t) => t.label))
</script>

<style scoped>
.atp-panel {
  margin-top: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.04);
  padding: 6px 0 4px;
}
.atp-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px 4px;
}
.atp-header-stats {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}
.atp-header-stat {
  font-size: 0.62rem;
  line-height: 1;
  padding: 2px 4px;
  border-radius: 4px;
  font-weight: 600;
  white-space: nowrap;
}
.atp-header-running {
  background: rgba(34, 197, 94, 0.18);
  color: #4ade80;
  border: 1px solid rgba(34, 197, 94, 0.35);
}
.atp-header-waiting {
  background: rgba(234, 179, 8, 0.18);
  color: #facc15;
  border: 1px solid rgba(234, 179, 8, 0.35);
}
.atp-title {
  font-size: 0.72rem;
  font-weight: 600;
  color: #a78bfa;
  letter-spacing: 0.03em;
}
.atp-count-badge {
  font-size: 0.68rem;
  background: rgba(139, 92, 246, 0.25);
  color: #c4b5fd;
  border-radius: 8px;
  padding: 1px 5px;
  min-width: 16px;
  text-align: center;
}
.atp-spin-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #a78bfa;
  flex-shrink: 0;
  animation: atp-pulse 1.2s ease-in-out infinite;
}
@keyframes atp-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.75); }
}
.atp-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-height: 380px;
  overflow-y: auto;
  padding-right: 2px;
}
.atp-list::-webkit-scrollbar {
  width: 4px;
}
.atp-list::-webkit-scrollbar-thumb {
  background: rgba(168, 85, 247, 0.25);
  border-radius: 4px;
}
.atp-list::-webkit-scrollbar-track {
  background: transparent;
}
.atp-list :deep(.el-tooltip__trigger) {
  display: block;
  width: 100%;
  min-width: 0;
}
.atp-item {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  border-radius: 6px;
  transition: background 0.15s;
  min-width: 0;
  cursor: default;
}
.atp-item:hover { background: rgba(255,255,255,0.05); }
.atp-item--clickable {
  cursor: pointer;
}
.atp-item--clickable:hover {
  background: rgba(168, 85, 247, 0.18);
}
.atp-item--waiting {
  opacity: 0.85;
}
.atp-item--waiting:hover {
  opacity: 1;
}
.atp-item-dot {
  display: inline-block;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #7c3aed;
  flex-shrink: 0;
  animation: atp-pulse 1.6s ease-in-out infinite;
}
.atp-item-dot.atp-dot--running {
  background: #22c55e;
  box-shadow: 0 0 5px rgba(34, 197, 94, 0.6);
  animation: atp-pulse 1.2s ease-in-out infinite;
}
.atp-item-dot.atp-dot--waiting {
  background: #eab308;
  animation: none;
}
.atp-status-tag {
  font-size: 0.6rem;
  line-height: 1.1;
  padding: 1px 4px;
  border-radius: 3px;
  font-weight: 500;
  flex-shrink: 0;
  white-space: nowrap;
}
.atp-tag--running {
  background: rgba(34, 197, 94, 0.15);
  color: #4ade80;
  border: 1px solid rgba(34, 197, 94, 0.28);
}
.atp-tag--waiting {
  background: rgba(234, 179, 8, 0.15);
  color: #facc15;
  border: 1px solid rgba(234, 179, 8, 0.28);
}
.atp-item-label {
  font-size: 0.72rem;
  color: #a1a1aa;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}
.atp-item-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: #71717a;
  cursor: pointer;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.15s, background 0.15s, color 0.15s;
}
.atp-item:hover .atp-item-close,
.atp-item-close:focus-visible {
  opacity: 1;
}
.atp-item-close:hover {
  background: rgba(239, 68, 68, 0.15);
  color: #f87171;
}
.atp-more {
  font-size: 0.68rem;
  color: #71717a;
  padding: 2px 10px 2px 19px;
}
.atp-collapsed-badge {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 4px 0;
  cursor: default;
}
.atp-collapsed-count {
  font-size: 0.65rem;
  color: #a78bfa;
  font-weight: 700;
  line-height: 1;
}
:global(html.light) .atp-title { color: #7c3aed; }
:global(html.light) .atp-count-badge { background: rgba(139,92,246,0.12); color: #7c3aed; }
:global(html.light) .atp-header-running { background: rgba(34, 197, 94, 0.12); color: #16a34a; border-color: rgba(34, 197, 94, 0.25); }
:global(html.light) .atp-header-waiting { background: rgba(202, 138, 4, 0.12); color: #ca8a04; border-color: rgba(202, 138, 4, 0.25); }
:global(html.light) .atp-tag--running { background: rgba(34, 197, 94, 0.1); color: #16a34a; border-color: rgba(34, 197, 94, 0.2); }
:global(html.light) .atp-tag--waiting { background: rgba(202, 138, 4, 0.1); color: #ca8a04; border-color: rgba(202, 138, 4, 0.2); }
:global(html.light) .atp-item-dot.atp-dot--running { background: #16a34a; }
:global(html.light) .atp-item-dot.atp-dot--waiting { background: #ca8a04; }
:global(html.light) .atp-spin-dot { background: #7c3aed; }
:global(html.light) .atp-item-dot { background: #8b5cf6; }
:global(html.light) .atp-item-label { color: #374151; }
:global(html.light) .atp-item:hover { background: rgba(0,0,0,0.04); }
:global(html.light) .atp-item-close { color: #9ca3af; }
:global(html.light) .atp-item-close:hover { background: rgba(239,68,68,0.1); color: #dc2626; }
:global(html.light) .atp-panel { border-top-color: rgba(139,92,246,0.15); }
</style>
