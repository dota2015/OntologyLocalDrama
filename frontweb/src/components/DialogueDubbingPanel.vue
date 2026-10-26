<template>
  <section id="anchor-dubbing" class="section card">
    <h2 class="section-title">对白与旁白配音</h2>
    <p class="dubbing-tip">人物音色在人物编辑中改选和试听，旁白使用独立音色；在此批量生成配音并重新合成剧集。</p>
    <el-button type="primary" plain :disabled="!dramaId" @click="open">旁白音色 / 批量重新配音</el-button>
    <el-dialog v-model="visible" title="旁白音色与批量配音" width="920px" style="max-width:96vw" append-to-body>
      <div v-loading="loading">
        <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon class="dubbing-gap" />
        <el-alert v-if="!loading && !configs.length" title="请先在 AI 配置中添加并启用 TTS 服务，再打开此面板。" type="warning" :closable="false" />
        <el-form label-width="100px" :disabled="running || saving">
          <el-form-item label="TTS 服务">
            <el-select v-model="profile.config_id" @change="changeConfig">
              <el-option v-for="c in configs" :key="c.id" :value="c.id" :label="c.name" />
            </el-select>
          </el-form-item>
          <el-form-item label="默认音色">
            <el-select v-model="profile.default_voice" filterable allow-create default-first-option placeholder="使用服务默认音色" clearable>
              <el-option v-for="v in voiceOptions" :key="v.id" :label="v.label" :value="v.id" :disabled="v.id === profile.narrator_voice" />
            </el-select>
            <span class="dubbing-tip">未标注人物的对白使用此音色</span>
          </el-form-item>
          <el-form-item label="旁白音色">
            <el-select v-model="profile.narrator_voice" filterable allow-create default-first-option placeholder="选择独立的旁白音色">
              <el-option v-for="v in voiceOptions" :key="v.id" :label="v.label" :value="v.id" :disabled="v.id === profile.default_voice || Object.values(profile.voices).includes(v.id)" />
            </el-select>
            <el-button class="dubbing-preview" :loading="previewing === '__narrator__'" :disabled="!!previewing || !profile.config_id" @click="previewVoice('__narrator__')">试听旁白</el-button>
          </el-form-item>
          <el-form-item label="H3 旁白参考">
            <H3VoiceReferenceSettings v-if="visible && !loading" :drama-id="dramaId" target="narrator" :voice-id="profile.narrator_voice" :before-prepare="saveBeforeH3Reference" :disabled="running || saving" />
          </el-form-item>
          <el-form-item label="语速">
            <el-input-number v-model="profile.speed" :min="0.5" :max="2" :step="0.05" :precision="2" />
            <span style="font-size:12px;color:var(--el-text-color-secondary);margin-left:8px">倍；手动改变此值会切换为固定语速。逐镜自动模式请在项目叙事风格处设置；已有音频需重新生成。</span>
          </el-form-item>
          <p class="dubbing-tip">人物音色请在「编辑角色 → 配音音色」中选择；各分镜的「生成对话 / 编辑文本」用于整理台词。</p>
          <el-form-item label="配音内容" class="dubbing-gap">
            <el-radio-group v-model="kind">
              <el-radio value="dialogue">仅人物对白</el-radio>
              <el-radio value="narration">仅旁白</el-radio>
              <el-radio value="both">对白和旁白</el-radio>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="配音范围" class="dubbing-gap">
            <el-radio-group v-model="scope">
              <el-radio value="episode" :disabled="!episodeId">当前集</el-radio>
              <el-radio value="all">全部剧集</el-radio>
            </el-radio-group>
            <span class="dubbing-tip">共 {{ scopedShots.length }} 个有对白或旁白的分镜</span>
          </el-form-item>
          <el-form-item label="台词识别">
            <span class="dubbing-tip">自动读取分镜已有文字，角色名只用于选音色；混写或全能分镜由 AI 提取，台词不改写。</span>
          </el-form-item>
          <el-form-item label="生成方式">
            <el-checkbox v-model="overwrite">重新生成已有配音（旧文件保留，成功后更新当前配音）</el-checkbox>
          </el-form-item>
        </el-form>
        <div class="dubbing-actions">
          <el-button :loading="saving" :disabled="running || !profile.config_id" @click="save">保存音色设置</el-button>
          <el-button type="primary" :loading="saving" :disabled="running || saving || !profile.config_id || !scopedShots.length" @click="start(false)">{{ overwrite ? '批量重新生成配音' : '补齐缺失配音' }}</el-button>
          <el-button v-if="running" type="warning" plain @click="cancel">停止后续配音</el-button>
          <el-button v-if="failed.length && !running" @click="start(true)">重试失败分镜（{{ failed.length }}）</el-button>
        </div>
        <div v-if="task" class="dubbing-gap">
          <el-progress :percentage="Number(task.progress) || 0" :status="task.status === 'failed' ? 'exception' : (task.status === 'completed' ? 'success' : undefined)" />
          <p class="dubbing-tip">{{ task.error || task.message || taskLabel }}</p>
          <el-alert v-if="task.status === 'completed'" :title="'本次成功 ' + (taskResult.succeeded || 0) + '，跳过 ' + skippedCount + '，失败 ' + failed.length" :type="failed.length ? 'warning' : 'success'" :closable="false" />
          <p v-for="r in failed" :key="r.storyboard_id + r.tts_kind" class="dubbing-error">第{{ r.episode_number }}集 · 分镜{{ r.storyboard_number }}（{{ r.tts_kind === 'narration' ? '旁白' : '对白' }}）：{{ r.error }}</p>
        </div>
        <el-table :data="scopedShots" size="small" max-height="280" class="dubbing-gap" empty-text="此范围没有对白或旁白">
          <el-table-column label="分镜" width="110">
            <template #default="{ row }">第{{ row.episode_number }}集 · {{ row.storyboard_number }}</template>
          </el-table-column>
          <el-table-column label="已识别的朗读内容" min-width="260">
            <template #default="{ row }">
              <div v-if="row.extraction_pending" class="dubbing-tip">将由 AI 从分镜中提取说话者与台词</div>
              <div v-if="kind !== 'dialogue' && row.narration" class="dubbing-narration">旁白：{{ row.narration }}</div>
              <div v-for="(line, i) in (kind === 'narration' ? [] : row.segments)" :key="i"><el-tag v-if="line.character_id" size="small" type="success">{{ line.character_name }} · 已关联</el-tag>
                <el-tag v-else-if="line.speaker" size="small" type="warning">{{ line.speaker }} · 独立说话者</el-tag>
                {{ line.text }}</div>
            </template>
          </el-table-column>
          <el-table-column label="当前配音" width="160">
            <template #default="{ row }">
              <el-button v-if="kind !== 'narration' && row.audio_local_path" size="small" @click="play(row.audio_local_path)">试听对白</el-button>
              <el-button v-if="kind !== 'dialogue' && row.narration_audio_local_path" size="small" @click="play(row.narration_audio_local_path)">试听旁白</el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-alert class="dubbing-gap" type="info" :closable="false" title="配音生成后，需要重新合成整集才会更新成片声音。新生成的对白与旁白按提取清单顺序衔接。旁白按 narration 文案生成（不会自动改写旁白），合成时也会生成旁白字幕。有配音的镜头使用 TTS 替换原声；无对白及旁白的镜头保留原有音乐和音效。人物口型不会自动重做。" />
      </div>
      <template #footer>
        <el-button @click="visible = false">关闭</el-button>
        <el-button type="primary" :disabled="running || !episodeId || !mergeReady" @click="merge">使用新配音重新合成当前集</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import H3VoiceReferenceSettings from './H3VoiceReferenceSettings.vue'
import { EDGE_VOICE_OPTIONS, INDEXTTS_VOICE_OPTIONS, getVoiceOptionsByProvider } from '@/utils/dubbingVoices'

const props = defineProps({ dramaId: [Number, String], episodeId: [Number, String] })
const emit = defineEmits(['updated', 'merge', 'profile'])
const visible = ref(false)
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const configs = ref([])
const speakers = ref([])
const characters = ref([])
const shots = ref([])
const profile = ref({ config_id: null, default_voice: '', narrator_voice: '', speed: 1, voices: {}, character_voices: {}, speaker_characters: {} })
const scope = ref('episode')
const kind = ref('both')
const overwrite = ref(true)
const previewing = ref('')
const task = ref(null)
let timer
let audio
const running = computed(() => ['pending', 'processing'].includes(task.value?.status))
const taskResult = computed(() => {
  try { return typeof task.value?.result === 'string' ? JSON.parse(task.value.result) : (task.value?.result || {}) } catch (_) { return {} }
})
const failed = computed(() => (taskResult.value.results || []).filter(r => r.error))
const skippedCount = computed(() => (taskResult.value.results || []).filter(r => r.skipped).length)
const taskLabel = computed(() => running.value ? '后台配音中，关闭面板后仍会继续' : '配音任务已结束')
const hasNarration = s => s.narration?.trim() && !/^(无|无旁白|无解说|none|null)[。.!！\s]*$/i.test(s.narration.trim())
const hasContent = s => s.extraction_pending || (kind.value !== 'narration' && s.segments?.length) || (kind.value !== 'dialogue' && hasNarration(s))
const scopedShots = computed(() => shots.value.filter(s => hasContent(s) && (scope.value === 'all' || Number(s.episode_id) === Number(props.episodeId))))
const mergeReady = computed(() => {
  const list = shots.value.filter(s => Number(s.episode_id) === Number(props.episodeId))
  return list.some(hasContent) && list.every(s =>
    (kind.value === 'narration' || !s.segments?.length || s.audio_local_path) &&
    (kind.value === 'dialogue' || !hasNarration(s) || s.narration_audio_local_path))
})
const speakerRows = computed(() => speakers.value.map(name => ({ name })))
const voiceOptions = computed(() => {
  const config = configs.value.find(c => c.id === profile.value.config_id)
  return getVoiceOptionsByProvider(config?.provider)
})
async function api(url, body, method = 'POST') {
  const response = await fetch('/api/v1' + url, body === undefined ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const result = await response.json()
  if (!response.ok || !(result.success === true || Number(result.code) === 200)) throw new Error(result.error?.message || result.message || '操作失败')
  return result.data
}
function endpoint() { return '/audio/dubbing/' + props.dramaId }
async function load(resetProfile = false) {
  const id = props.dramaId
  const data = await api(endpoint())
  if (id !== props.dramaId) return
  configs.value = data.configs
  speakers.value = data.speakers
  characters.value = data.characters || []
  emit('profile', data.profile)
  shots.value = data.shots
  task.value = data.task
  if (resetProfile) {
    const selected = data.configs.find(c => c.id === data.profile.config_id) || data.configs.find(c => c.is_default) || data.configs[0]
    profile.value = { config_id: selected?.id, default_voice: data.profile.default_voice ?? selected?.default_voice ?? '', narrator_voice: data.profile.narrator_voice || '', speed: data.profile.speed || 1, voices: { ...(data.profile.voices || {}) }, character_voices: { ...(data.profile.character_voices || {}) }, speaker_characters: { ...(data.profile.speaker_characters || {}) } }
  }
  emit('updated', data.shots)
  if (running.value) schedulePoll()
}
async function open() {
  visible.value = true
  loading.value = true
  error.value = ''
  if (!props.episodeId) scope.value = 'all'
  try { await load(true) } catch (e) { error.value = e.message } finally { loading.value = false }
}
async function generateAllAudio() {
  if (loading.value || saving.value) return
  visible.value = true
  loading.value = true
  error.value = ''
  const id = props.dramaId
  const episodeId = props.episodeId
  try {
    await load(true)
    if (id !== props.dramaId || episodeId !== props.episodeId) return
    // Reopen a running job instead of submitting a duplicate batch.
    if (running.value) return
    scope.value = episodeId ? 'episode' : 'all'
    kind.value = 'both'
    overwrite.value = false
    if (!profile.value.config_id) throw new Error('请先在 AI 配置中添加并启用 TTS 服务')
    if (!scopedShots.value.length) throw new Error('所选范围没有可配音的对白或旁白，请先生成或编辑文本')
    await start(false)
  } catch (e) { error.value = e.message }
  finally { loading.value = false }
}
async function changeConfig(id) {
  profile.value.default_voice = configs.value.find(c => c.id === id)?.default_voice || ''
  profile.value.narrator_voice = ''
  profile.value.voices = {}
  profile.value.character_voices = {}
  await autoAssign()
}
async function autoAssign() {
  saving.value = true
  error.value = ''
  try { profile.value = await api(endpoint() + '/auto-assign', { ...profile.value, character_voices: {} }) }
  catch (e) { error.value = e.message }
  finally { saving.value = false }
}
function bindSpeaker(name, id) {
  const target = characters.value.find(c => c.id === id)
  if (target) profile.value.voices[name] = profile.value.character_voices[id] || profile.value.voices[target.name] || ''
}
function changeSpeakerVoice(name, voice) {
  const id = profile.value.speaker_characters[name]
  if (!id) return
  profile.value.character_voices[id] = voice
  const target = characters.value.find(c => c.id === id)
  if (target) profile.value.voices[target.name] = voice
  for (const [speaker, characterId] of Object.entries(profile.value.speaker_characters)) {
    if (characterId === id) profile.value.voices[speaker] = voice
  }
}
async function save() {
  saving.value = true
  error.value = ''
  try {
    profile.value = await api(endpoint(), profile.value, 'PUT')
    emit('profile', profile.value)
    ElMessage.success('角色音色已保存，单条与批量配音均使用此设置')
  } catch (e) { error.value = e.message } finally { saving.value = false }
}
async function saveBeforeH3Reference() {
  await save()
  if (error.value) throw new Error(error.value)
}
async function start(retry) {
  error.value = ''
  saving.value = true
  try {
    const data = await api(endpoint() + '/generate', {
      episode_id: retry || scope.value === 'all' ? undefined : props.episodeId,
      overwrite: retry ? true : overwrite.value,
      tts_kind: retry ? 'both' : kind.value,
      retry_items: retry ? failed.value : undefined,
      storyboard_ids: retry ? failed.value.map(r => r.storyboard_id) : undefined,
      profile: profile.value,
    })
    task.value = data
    schedulePoll()
  } catch (e) { error.value = e.message } finally { saving.value = false }
}
function schedulePoll() {
  clearTimeout(timer)
  const id = props.dramaId
  const taskId = task.value?.id
  timer = setTimeout(async () => {
    try {
      const data = await api('/tasks/' + taskId)
      if (id !== props.dramaId || taskId !== task.value?.id) return
      task.value = data
      for (const r of taskResult.value.results || []) {
        if (r.local_path && !r.error) {
          const shot = shots.value.find(s => s.id === r.storyboard_id)
          if (shot) shot[r.tts_kind === 'narration' ? 'narration_audio_local_path' : 'audio_local_path'] = r.local_path
        }
      }
      emit('updated', shots.value)
      if (running.value) schedulePoll()
      else await load(true)
    } catch (e) {
      error.value = '进度查询失败，可关闭后重新打开恢复：' + e.message
      if (id === props.dramaId && running.value) schedulePoll()
    }
  }, 1500)
}
async function cancel() {
  try { await api('/tasks/' + task.value.id + '/cancel', {}); await load() } catch (e) { error.value = e.message }
}
function play(rel) {
  audio?.pause()
  audio = new Audio('/static/' + rel)
  audio.play().catch(() => ElMessage.error('音频播放失败'))
}
async function previewVoice(speaker) {
  previewing.value = speaker
  try {
    const result = await api(endpoint() + '/preview', { profile: profile.value, speaker })
    play(result.local_path)
  } catch (e) { error.value = e.message } finally { previewing.value = '' }
}
function merge() {
  visible.value = false
  emit('merge', { dialogue: kind.value !== 'narration', narration: kind.value !== 'dialogue' })
}
watch(() => props.dramaId, async (id) => {
  clearTimeout(timer); task.value = null; shots.value = []; visible.value = false; audio?.pause()
  if (id) { try { await load(true) } catch (_) {} }
}, { immediate: true })
defineExpose({ open, generateAllAudio, refresh: () => load(!visible.value) })
onBeforeUnmount(() => { clearTimeout(timer); audio?.pause() })
</script>

<style scoped>
.dubbing-tip { color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.6; margin: 8px 0; }
span.dubbing-tip { margin-left: 12px; }
.dubbing-preview { margin-left: 8px; }
.dubbing-narration { color: var(--el-text-color-secondary); }
.dubbing-gap { margin-top: 16px; }
.dubbing-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 16px; }
.dubbing-actions .el-button + .el-button { margin-left: 0; }
.dubbing-error { color: var(--el-color-danger); font-size: 13px; }
</style>
