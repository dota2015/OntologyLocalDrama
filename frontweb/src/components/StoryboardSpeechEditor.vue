<template>
  <el-dialog v-model="visible" :title="'分镜' + (shot?.storyboard_number || '') + ' · 对话和旁白'" width="760px" style="max-width:96vw" append-to-body :close-on-click-modal="false">
    <div v-loading="loading">
      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
      <p class="speech-tip">从分镜已有文字提取对话与旁白，可修改说话者和正文。人物音色请在人物编辑中选择；配音只朗读正文。</p>
      <el-empty v-if="!loading && !segments.length" description="未找到明确台词，可添加文本；没有旁白的分镜无需添加旁白。" />
      <div v-for="(line, index) in segments" :key="index" class="speech-line">
        <div class="speech-controls">
          <el-select v-model="line.kind" style="width:110px" :disabled="saving">
            <el-option value="dialogue" label="人物对白" />
            <el-option value="narration" label="旁白" />
          </el-select>
          <el-select v-if="line.kind === 'dialogue'" v-model="line.speaker" filterable allow-create default-first-option placeholder="选择说话人物" style="width:210px" :disabled="saving">
            <el-option value="" label="未指定人物（默认音色）" />
            <el-option v-for="c in characters" :key="c.id" :label="c.name" :value="c.name" />
          </el-select>
          <el-button :disabled="saving" @click="move(index, -1)">上移</el-button>
          <el-button :disabled="saving" type="danger" link @click="segments.splice(index, 1)">删除</el-button>
        </div>
        <el-input v-model="line.text" type="textarea" :autosize="{ minRows: 2, maxRows: 6 }" placeholder="只填写要朗读的正文，不要写角色名标签" :disabled="saving" />
      </div>
      <el-button :disabled="loading || saving" @click="segments.push({ kind: 'dialogue', speaker: '', text: '' })">添加对白</el-button>
      <el-button :disabled="loading || saving" @click="segments.push({ kind: 'narration', speaker: '', text: '' })">添加旁白</el-button>
      <p class="speech-tip">保存文字后，再点击分镜上的「对白配音」或「旁白配音」生成声音。修改文字不会自动替换已有音频。</p>
    </div>
    <template #footer>
      <el-button :disabled="saving" @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="loading || !sourceHash" @click="save">保存文本</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
const props = defineProps({ dramaId: [Number, String] })
const emit = defineEmits(['saved'])
const visible = ref(false)
const shot = ref(null)
const segments = ref([])
const characters = ref([])
const sourceHash = ref('')
const loading = ref(false)
const saving = ref(false)
const error = ref('')
let version = 0
function endpoint(id) { return '/api/v1/audio/dubbing/' + props.dramaId + '/speech/' + id }
async function api(url, body, method = 'POST') {
  const response = await fetch(url, body === undefined ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const result = await response.json()
  if (!response.ok || !(result.success === true || Number(result.code) === 200)) throw new Error(result.error?.message || result.message || '对话操作失败')
  return result.data
}
async function open(sb, generate = false) {
  const token = ++version
  shot.value = sb
  visible.value = true
  loading.value = true
  sourceHash.value = ''
  segments.value = []
  error.value = ''
  try {
    const data = await api(endpoint(sb.id) + (generate ? '/extract' : ''), generate ? {} : undefined)
    if (token !== version) return
    characters.value = data.characters
    sourceHash.value = data.source_hash
    segments.value = data.segments.map(s => ({ kind: s.kind, speaker: s.speaker, text: s.text }))
  } catch (e) { if (token === version) error.value = e.message }
  finally { if (token === version) loading.value = false }
}
function move(index, direction) {
  const target = index + direction
  if (target < 0 || target >= segments.value.length) return
  const [line] = segments.value.splice(index, 1)
  segments.value.splice(target, 0, line)
}
async function save() {
  saving.value = true
  error.value = ''
  const token = version
  try {
    const data = await api(endpoint(shot.value.id), { source_hash: sourceHash.value, segments: segments.value }, 'PUT')
    if (token !== version) return
    emit('saved', data)
    ElMessage.success('对话与旁白文本已保存，可生成配音')
    visible.value = false
  } catch (e) { if (token === version) error.value = e.message }
  finally { if (token === version) saving.value = false }
}
watch(() => props.dramaId, () => { version++; visible.value = false; saving.value = false })
onBeforeUnmount(() => { version++ })
defineExpose({ open })
</script>

<style scoped>
.speech-line { margin: 16px 0; }
.speech-controls { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.speech-tip { font-size: 13px; line-height: 1.6; color: var(--el-text-color-secondary); }
</style>
