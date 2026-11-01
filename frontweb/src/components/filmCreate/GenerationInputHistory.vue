<template>
  <el-dialog :model-value="true" title="生成记录 · 本次实际输入" width="900px" @close="$emit('close')">
    <p>这里展示提交模型时保存的输入。当前分镜的编辑不会改写这些记录；提交输入已记录不代表生成成功。</p>
    <el-radio-group v-model="kind" @change="resetList">
      <el-radio-button value="image">图片</el-radio-button>
      <el-radio-button value="video">视频</el-radio-button>
    </el-radio-group>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <div v-loading="loading">
      <el-table :data="records" highlight-current-row @current-change="selectRecord">
        <el-table-column prop="id" label="记录" width="80" />
        <el-table-column prop="frame_type" label="帧类型" width="100" />
        <el-table-column prop="status" label="状态" width="110" />
        <el-table-column prop="created_at" label="生成时间" />
        <el-table-column prop="error_msg" label="失败原因" show-overflow-tooltip />
      </el-table>
      <el-pagination v-model:current-page="page" :page-size="20" :total="total" layout="prev, pager, next" @current-change="loadList" />
    </div>
    <div v-loading="detailLoading">
      <template v-if="selected">
        <p>记录 #{{ selected.id }} · {{ selected.status }}</p>
        <el-alert v-if="!selected.input_snapshot" title="未记录实际输入（历史记录、尚未提交或该接口未提供记录）。不会用当前分镜倒推。" type="info" :closable="false" />
        <el-tabs v-else v-model="attemptIndex">
          <el-tab-pane v-for="(attempt, index) in selected.input_snapshot.attempts" :key="index" :name="String(index)" :label="`提交 ${index + 1}`">
            <p>{{ attempt.recorded_at }} · {{ attempt.provider }} · {{ attempt.execution?.model || attempt.model }} · {{ attempt.mode || '' }}</p>
            <p>分镜版本：{{ attempt.storyboard?.revision || '未提供版本号' }}<br>分镜内容 SHA256：{{ attempt.storyboard?.content_sha256 || '未记录' }}</p>
            <p>{{ attempt.execution ? 'ComfyUI 实际执行参数' : '提交参数' }}</p>
            <pre>{{ JSON.stringify(attempt.execution || attempt.parameters, null, 2) }}</pre>
            <p>最终提示词</p><pre>{{ attempt.prompt }}</pre>
            <template v-if="attempt.negative_prompt"><p>负面提示词</p><pre>{{ attempt.negative_prompt }}</pre></template>
            <p>按提交顺序排列的参考素材</p>
            <el-table :data="attempt.references || []">
              <el-table-column prop="index" label="#" width="50" />
              <el-table-column prop="role" label="用途" width="130" />
              <el-table-column label="身份" width="130"><template #default="{ row }">{{ row.name || row.speaker || row.character_id || row.asset_id || row.key || '—' }}</template></el-table-column>
              <el-table-column prop="source" label="来源" show-overflow-tooltip />
              <el-table-column label="内容 SHA256" show-overflow-tooltip><template #default="{ row }">{{ row.content_sha256 || '远端 URL；提交时未取得内容摘要' }}</template></el-table-column>
            </el-table>
            <details><summary>完整提交记录（媒体二进制和凭据已排除）</summary><pre>{{ JSON.stringify(attempt, null, 2) }}</pre></details>
          </el-tab-pane>
        </el-tabs>
      </template>
    </div>
  </el-dialog>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { imagesAPI } from '@/api/images'
import { videosAPI } from '@/api/videos'

const props = defineProps({ storyboardId: { type: [Number, String], required: true } })
defineEmits(['close'])
const kind = ref('image'), page = ref(1), total = ref(0), records = ref([])
const loading = ref(false), detailLoading = ref(false), error = ref(''), selected = ref(null), attemptIndex = ref('0')
let listRequest = 0, detailRequest = 0
const api = () => kind.value === 'image' ? imagesAPI : videosAPI
async function selectRecord(row) {
  const requestId = ++detailRequest
  selected.value = null
  if (!row) { detailLoading.value = false; return }
  detailLoading.value = true
  try {
    const result = await api().get(row.id)
    if (requestId === detailRequest) { selected.value = result; attemptIndex.value = '0' }
  } catch (e) { if (requestId === detailRequest) error.value = e.message }
  finally { if (requestId === detailRequest) detailLoading.value = false }
}
async function loadList() {
  const requestId = ++listRequest
  ++detailRequest
  selected.value = null; detailLoading.value = false; loading.value = true; error.value = ''
  try {
    const result = await api().list({ storyboard_id: props.storyboardId, page: page.value, page_size: 20 })
    if (requestId !== listRequest) return
    records.value = result.items || []; total.value = result.pagination?.total ?? result.total ?? 0
    if (records.value.length) await selectRecord(records.value[0])
  } catch (e) { if (requestId === listRequest) error.value = e.message }
  finally { if (requestId === listRequest) loading.value = false }
}
function resetList() { page.value = 1; records.value = []; loadList() }
onMounted(loadList)
onBeforeUnmount(() => { ++listRequest; ++detailRequest })
</script>

<style scoped>
p { line-height: 1.6; overflow-wrap: anywhere; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 360px; overflow: auto; padding: 12px; background: var(--el-fill-color-light); }
details { margin-top: 16px; }
</style>
