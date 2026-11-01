<template>
  <div class="h3-instances-manager">
    <!-- 头部摘要与统计卡片 -->
    <div class="h3-summary-grid">
      <div class="h3-stat-card">
        <div class="stat-label">H3 实例总数</div>
        <div class="stat-value">{{ instances.length }}</div>
        <div class="stat-sub">已加入算力调度池</div>
      </div>
      <div class="h3-stat-card">
        <div class="stat-label">健康在线</div>
        <div class="stat-value online-text">
          {{ onlineCount }}
          <span class="stat-unit">/ {{ instances.length }}</span>
        </div>
        <div class="stat-sub">
          <span v-if="offlineCount > 0" class="offline-tag">{{ offlineCount }} 个离线/异常</span>
          <span v-else class="all-healthy-tag">全部正常连接</span>
        </div>
      </div>
      <div class="h3-stat-card highlight-card">
        <div class="stat-label">⚡ H3 视频流水线</div>
        <div class="stat-value highlight-text">{{ pipelineVideoConcurrency }}</div>
        <div class="stat-sub">
          <span class="synced-tag">严格串行，按分镜顺序生成</span>
        </div>
      </div>
      <div class="h3-stat-card">
        <div class="stat-label">H3 调度桥接服务</div>
        <div class="stat-value bridge-val">
          <span class="status-dot" :class="bridgeOnline ? 'dot-online' : 'dot-offline'" />
          {{ bridgeOnline ? '运行中' : '离线' }}
        </div>
        <div class="stat-sub bridge-url-text" :title="bridgeUrl">{{ bridgeUrl }}</div>
      </div>
    </div>

    <!-- 操作工具栏 -->
    <div class="h3-action-bar">
      <div class="bar-left">
        <el-button type="primary" @click="openAddDialog">
          <el-icon><Plus /></el-icon>添加 H3 实例
        </el-button>
        <el-button plain :loading="testingAll" @click="refreshAndTestAll">
          <el-icon><Refresh /></el-icon>检测连接 / 刷新负载
        </el-button>
      </div>
      <div class="bar-right">
        <span class="serial-tip">多个 H3 实例仅作为桥接目标，系统不会并行占用显卡。</span>
        <el-button type="success" :loading="saving" @click="saveInstances">
          <el-icon><Check /></el-icon>保存配置
        </el-button>
      </div>
    </div>

    <!-- 实例列表表格 -->
    <el-table
      v-loading="loading"
      :data="instances"
      stripe
      style="width: 100%; margin-top: 12px; border-radius: 8px"
    >
      <el-table-column label="#" width="55" align="center">
        <template #default="{ $index }">
          <span class="instance-idx">{{ $index + 1 }}</span>
        </template>
      </el-table-column>

      <el-table-column label="ComfyUI 实例地址" min-width="260">
        <template #default="{ row, $index }">
          <div class="url-cell">
            <span class="instance-url">{{ row.url }}</span>
            <el-tag v-if="$index === 0" size="small" type="info" class="master-tag">默认节点</el-tag>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="连接状态" width="130" align="center">
        <template #default="{ row }">
          <div v-if="row.testing" class="status-checking">
            <el-icon class="is-loading"><Loading /></el-icon> 检测中...
          </div>
          <el-tag v-else-if="row.online" type="success" size="small" effect="plain" class="status-badge">
            <span class="status-dot dot-online" /> 在线可用
          </el-tag>
          <el-tooltip v-else :content="row.error || '无法连接到该 ComfyUI 服务'" placement="top">
            <el-tag type="danger" size="small" effect="plain" class="status-badge">
              <span class="status-dot dot-offline" /> 离线 / 异常
            </el-tag>
          </el-tooltip>
        </template>
      </el-table-column>

      <el-table-column label="响应延迟" width="120" align="center">
        <template #default="{ row }">
          <span v-if="row.latency_ms != null" :class="latencyClass(row.latency_ms)" class="latency-text">
            {{ row.latency_ms }} ms
          </span>
          <span v-else class="latency-none">—</span>
        </template>
      </el-table-column>

      <el-table-column label="当前负载" width="180">
        <template #default="{ row }">
          <div v-if="row.online" class="load-cell">
            <span class="load-badge running-badge" title="当前 GPU 正在生成的任务">
              运行: {{ row.queue_running ?? 0 }}
            </span>
            <span class="load-badge pending-badge" title="等待此 GPU 生成的排队任务">
              排队: {{ row.queue_pending ?? 0 }}
            </span>
          </div>
          <span v-else class="latency-none">—</span>
        </template>
      </el-table-column>

      <el-table-column label="操作" width="160" align="right" fixed="right">
        <template #default="{ row, $index }">
          <el-button link type="primary" size="small" :loading="row.testing" @click="testSingleInstance(row)">
            测速
          </el-button>
          <el-button link type="primary" size="small" @click="openEditDialog(row, $index)">
            编辑
          </el-button>
          <el-button link type="danger" size="small" :disabled="instances.length <= 1" @click="removeInstance($index)">
            删除
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 调度原理解释卡片 -->
    <div class="h3-help-card">
      <div class="help-title">💡 MiniMax-H3 多实例串行生成</div>
      <ul class="help-list">
        <li>
          <b>串行调度</b>：批量任务严格按分镜顺序一个接一个提交，前一镜完成后才开始下一镜。
        </li>
        <li>
          <b>连续性优先</b>：H3 生成、恢复轮询和连续镜头接力共用同一条队列，避免显存争用和跨镜头状态错乱。
        </li>
        <li>
          <b>实例池</b>：多个 ComfyUI 地址仍可保留，用于桥接选择和故障切换，但不会改变串行规则。
        </li>
      </ul>
    </div>

    <!-- 添加 / 编辑对话框 -->
    <el-dialog
      v-model="dialogVisible"
      :title="editingIndex >= 0 ? '编辑 H3 实例' : '添加 H3 实例'"
      width="480px"
      destroy-on-close
    >
      <el-form label-width="110px" @submit.prevent="confirmDialog">
        <el-form-item label="ComfyUI 地址" required>
          <el-input
            v-model="inputUrl"
            placeholder="例如 http://10.10.13.7:8191"
            clearable
          />
        </el-form-item>
        <div v-if="testResult" class="dialog-test-result">
          <div v-if="testResult.ok" class="test-ok">
            <span class="status-dot dot-online" /> 连接成功！响应延迟: {{ testResult.latency_ms }}ms（运行中: {{ testResult.queue_running }}, 排队: {{ testResult.queue_pending }}）
          </div>
          <div v-else class="test-err">
            <span class="status-dot dot-offline" /> 连接失败: {{ testResult.error }}
          </div>
        </div>
      </el-form>
      <template #footer>
        <div class="dialog-footer">
          <el-button :loading="inputTesting" @click="testInputUrl">测试连接</el-button>
          <el-button @click="dialogVisible = false">取消</el-button>
          <el-button type="primary" @click="confirmDialog">确认</el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Refresh, Check, Loading } from '@element-plus/icons-vue'
import { h3InstancesAPI } from '@/api/h3Instances'

const loading = ref(false)
const saving = ref(false)
const testingAll = ref(false)
const instances = ref([])
const bridgeUrl = ref('http://127.0.0.1:5689')
const bridgeOnline = ref(true)
const pipelineVideoConcurrency = ref(1)

// 对话框表单
const dialogVisible = ref(false)
const editingIndex = ref(-1)
const inputUrl = ref('')
const inputTesting = ref(false)
const testResult = ref(null)

const onlineCount = computed(() => instances.value.filter(i => i.online).length)
const offlineCount = computed(() => instances.value.filter(i => !i.online && !i.testing).length)

function latencyClass(ms) {
  if (ms < 50) return 'latency-fast'
  if (ms < 200) return 'latency-med'
  return 'latency-slow'
}

async function loadData() {
  loading.value = true
  try {
    const res = await h3InstancesAPI.get()
    bridgeUrl.value = res?.bridge_url || 'http://127.0.0.1:5689'
    bridgeOnline.value = Boolean(res?.bridge_online)
    pipelineVideoConcurrency.value = 1
    instances.value = (res?.instances || []).map(i => ({
      url: typeof i === 'string' ? i : (i.url || ''),
      online: Boolean(i.online),
      latency_ms: i.latency_ms ?? null,
      queue_running: i.queue_running ?? 0,
      queue_pending: i.queue_pending ?? 0,
      testing: false,
      error: i.error || null,
    }))
  } catch (err) {
    ElMessage.error(err?.message || '获取 H3 实例列表失败')
  } finally {
    loading.value = false
  }
}

async function refreshAndTestAll() {
  testingAll.value = true
  try {
    await Promise.all(
      instances.value.map(async (item) => {
        item.testing = true
        try {
          const res = await h3InstancesAPI.test(item.url)
          item.online = Boolean(res?.ok)
          item.latency_ms = res?.latency_ms ?? null
          item.queue_running = res?.queue_running ?? 0
          item.queue_pending = res?.queue_pending ?? 0
          item.error = res?.error || null
        } catch (e) {
          item.online = false
          item.latency_ms = null
          item.error = e.message || '检测异常'
        } finally {
          item.testing = false
        }
      })
    )
    ElMessage.success('全部实例连接检测完成')
  } finally {
    testingAll.value = false
  }
}

async function testSingleInstance(row) {
  row.testing = true
  try {
    const res = await h3InstancesAPI.test(row.url)
    row.online = Boolean(res?.ok)
    row.latency_ms = res?.latency_ms ?? null
    row.queue_running = res?.queue_running ?? 0
    row.queue_pending = res?.queue_pending ?? 0
    row.error = res?.error || null
    if (res?.ok) {
      ElMessage.success(`${row.url} 连接正常 (${res.latency_ms}ms)`)
    } else {
      ElMessage.warning(`${row.url} 无法连通: ${res?.error || '连接超时'}`)
    }
  } catch (e) {
    row.online = false
    row.error = e.message
    ElMessage.error(`${row.url} 测试失败: ${e.message}`)
  } finally {
    row.testing = false
  }
}

function openAddDialog() {
  editingIndex.value = -1
  inputUrl.value = ''
  testResult.value = null
  dialogVisible.value = true
}

function openEditDialog(row, index) {
  editingIndex.value = index
  inputUrl.value = row.url
  testResult.value = null
  dialogVisible.value = true
}

async function testInputUrl() {
  const u = (inputUrl.value || '').trim()
  if (!u.startsWith('http://') && !u.startsWith('https://')) {
    ElMessage.warning('请输入有效的 URL 地址 (以 http:// 或 https:// 开头)')
    return
  }
  inputTesting.value = true
  testResult.value = null
  try {
    const res = await h3InstancesAPI.test(u)
    testResult.value = res
  } catch (e) {
    testResult.value = { ok: false, error: e.message }
  } finally {
    inputTesting.value = false
  }
}

function confirmDialog() {
  const u = (inputUrl.value || '').trim().replace(/\/+$/, '')
  if (!u.startsWith('http://') && !u.startsWith('https://')) {
    ElMessage.warning('请输入有效的 URL 地址 (以 http:// 或 https:// 开头)')
    return
  }
  if (editingIndex.value >= 0) {
    instances.value[editingIndex.value].url = u
  } else {
    if (instances.value.some(i => i.url === u)) {
      ElMessage.warning('该实例地址已存在')
      return
    }
    instances.value.push({
      url: u,
      online: testResult.value?.ok ?? true,
      latency_ms: testResult.value?.latency_ms ?? null,
      queue_running: testResult.value?.queue_running ?? 0,
      queue_pending: testResult.value?.queue_pending ?? 0,
      testing: false,
    })
  }
  dialogVisible.value = false
  ElMessage.success(editingIndex.value >= 0 ? '已修改实例地址' : '已添加实例，请点击「保存配置」使设置生效')
}

async function removeInstance(index) {
  if (instances.value.length <= 1) {
    ElMessage.warning('至少需要保留一个 ComfyUI 实例')
    return
  }
  const removed = instances.value[index]
  try {
    await ElMessageBox.confirm(`确定移除实例 ${removed.url}？`, '移除实例', {
      type: 'warning',
      confirmButtonText: '移除',
      cancelButtonText: '取消',
    })
    instances.value.splice(index, 1)
    ElMessage.success('已移除实例，请点击「保存配置」使设置生效')
  } catch (_) {}
}

async function saveInstances() {
  const urlList = instances.value.map(i => i.url)
  if (urlList.length === 0) {
    ElMessage.warning('请至少添加一个有效的 H3 实例')
    return
  }
  saving.value = true
  try {
    const res = await h3InstancesAPI.update({
      instances: urlList,
      auto_sync_concurrency: false,
    })
    pipelineVideoConcurrency.value = 1
    if (Array.isArray(res?.instances)) {
      instances.value = res.instances.map(i => ({
        url: i.url,
        online: Boolean(i.online),
        latency_ms: i.latency_ms ?? null,
        queue_running: i.queue_running ?? 0,
        queue_pending: i.queue_pending ?? 0,
        testing: false,
        error: i.error || null,
      }))
    }
    ElMessage.success('H3 实例配置已保存，视频将严格按分镜顺序串行生成')
  } catch (err) {
    ElMessage.error(err?.message || '保存失败')
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  loadData()
})
</script>

<style scoped>
.h3-instances-manager {
  padding: 4px 0 16px;
}
.h3-summary-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}
.h3-stat-card {
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 8px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
}
html.light .h3-stat-card {
  background: #ffffff;
  border-color: #e4e4e7;
  box-shadow: 0 1px 3px rgba(0,0,0,0.05);
}
.highlight-card {
  border-color: rgba(168, 85, 247, 0.4);
  background: linear-gradient(135deg, rgba(168, 85, 247, 0.08) 0%, rgba(59, 130, 246, 0.05) 100%);
}
.stat-label {
  font-size: 0.8rem;
  color: #a1a1aa;
  margin-bottom: 6px;
}
.stat-value {
  font-size: 1.6rem;
  font-weight: 700;
  color: #f4f4f5;
  line-height: 1.2;
}
html.light .stat-value {
  color: #18181b;
}
.stat-unit {
  font-size: 0.95rem;
  font-weight: 400;
  color: #71717a;
}
.online-text { color: #4ade80; }
.highlight-text { color: #c084fc; }
.bridge-val {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 1.2rem;
}
.stat-sub {
  margin-top: 6px;
  font-size: 0.75rem;
  color: #71717a;
}
.all-healthy-tag { color: #4ade80; font-weight: 500; }
.offline-tag { color: #f87171; font-weight: 500; }
.synced-tag { color: #a855f7; font-weight: 500; }
.not-synced-tag { color: #facc15; font-weight: 500; }
.bridge-url-text {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}
.dot-online {
  background: #22c55e;
  box-shadow: 0 0 6px rgba(34, 197, 94, 0.6);
}
.dot-offline {
  background: #ef4444;
  box-shadow: 0 0 6px rgba(239, 68, 68, 0.6);
}

.h3-action-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: 8px;
  padding: 10px 14px;
}
html.light .h3-action-bar {
  background: #fbfbfe;
  border-color: #e4e4e7;
}
.bar-left, .bar-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.instance-idx {
  font-weight: 600;
  color: #71717a;
}
.url-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}
.instance-url {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.9rem;
  color: #e4e4e7;
}
html.light .instance-url { color: #27272a; }
.master-tag {
  font-size: 0.7rem;
}
.status-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.status-checking {
  font-size: 0.78rem;
  color: #a1a1aa;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}
.latency-text {
  font-size: 0.82rem;
  font-weight: 600;
}
.latency-fast { color: #4ade80; }
.latency-med { color: #facc15; }
.latency-slow { color: #fb923c; }
.latency-none { color: #71717a; }
.load-cell {
  display: flex;
  align-items: center;
  gap: 6px;
}
.load-badge {
  font-size: 0.72rem;
  padding: 2px 6px;
  border-radius: 4px;
  line-height: 1.2;
}
.running-badge {
  background: rgba(59, 130, 246, 0.15);
  color: #60a5fa;
  border: 1px solid rgba(59, 130, 246, 0.3);
}
.pending-badge {
  background: rgba(234, 179, 8, 0.15);
  color: #facc15;
  border: 1px solid rgba(234, 179, 8, 0.3);
}

.h3-help-card {
  margin-top: 20px;
  background: rgba(168, 85, 247, 0.04);
  border: 1px solid rgba(168, 85, 247, 0.15);
  border-radius: 8px;
  padding: 14px 18px;
}
.help-title {
  font-size: 0.875rem;
  font-weight: 600;
  color: #c084fc;
  margin-bottom: 8px;
}
.help-list {
  margin: 0;
  padding-left: 18px;
  color: #a1a1aa;
  font-size: 0.8rem;
  line-height: 1.6;
}
.help-list code {
  background: rgba(255, 255, 255, 0.08);
  padding: 1px 4px;
  border-radius: 3px;
  color: #e4e4e7;
}

.dialog-test-result {
  margin-top: 10px;
  font-size: 0.82rem;
  padding: 8px 12px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.03);
}
.test-ok { color: #4ade80; display: flex; align-items: center; gap: 6px; }
.test-err { color: #f87171; display: flex; align-items: center; gap: 6px; }
</style>
