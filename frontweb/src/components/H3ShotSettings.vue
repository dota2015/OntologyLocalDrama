<template>
  <div class="h3-shot-settings">
    <span>H3 原生输入 {{ canvasLabel }} · 23 步 · 人物多图 + 参考声音</span>
    <el-button size="small" link type="primary" @click="open">参考素材与衔接</el-button>
    <el-dialog v-model="visible" title="H3 参考素材与衔接" width="660px" append-to-body destroy-on-close>
      <div v-loading="loading">
        <el-alert v-if="error" :title="error" type="error" :closable="false" />
        <template v-if="data">
          <p>人物主图与补充图会一起送入 Ref2VA；人物卡的正面、侧面提供身份参考；本镜首帧决定实际服装，尾帧保持连续。可在「角色生成」上传补充图，请保持人物服装一致。</p>
          <div class="reference-grid">
            <div v-for="item in data.references" :key="item.source">
              <el-image :src="item.url" :preview-src-list="data.references.map(r => r.url)" fit="contain" style="width:120px;height:90px" />
              <div>{{ item.name }} · {{ item.kind === 'scene' ? '场景' : item.kind === 'prop' ? '道具' : '人物' }}</div>
            </div>
          </div>
          <p v-if="!data.references.length">本镜尚未关联人物或场景图。请先选择人物和场景并生成图片。</p>
          <p>生成时还会加入当前首尾帧和分镜参考图，去重后最多 9 张。声音按「编辑文本」中的人物与旁白绑定，优先上传样音，否则使用已分配的 Edge-TTS 音色；每镜最多 3 个声音。</p>
          <el-alert v-if="data.wardrobe_change || data.continuity_reset" title="本镜开始前切换了造型，自动模式会使用本镜自己的新造型首帧，全镜保持同一套服装。" type="info" :closable="false" />
          <el-form label-position="top">
            <el-form-item label="上一镜尾帧衔接">
              <el-select v-model="continuity" style="width:100%" :disabled="disabled || saving">
                <el-option value="auto" label="自动：相邻同场景、无换装变化且上一镜已有视频时使用" />
                <el-option value="off" label="关闭：使用当前分镜自己的首帧" />
                <el-option value="previous_tail" label="指定：使用上一镜实际尾帧（需先生成上一镜）" />
              </el-select>
            </el-form-item>
          </el-form>
          <p v-if="data.previous_storyboard">上一镜：#{{ data.previous_storyboard.number }} · {{ data.previous_storyboard.same_scene ? '同场景' : '不同场景' }} · {{ data.previous_storyboard.video_ready ? '视频已就绪' : '尚无已完成视频' }}。{{ continuity === 'auto' && !data.previous_storyboard.same_scene ? '自动模式会使用本镜自己的首帧。' : '' }}</p>
          <p v-else>这是本集第一镜，使用本镜自己的首帧。</p>
          <p>使用上一镜尾帧时，当前首帧仍作为画面参考保留。H3 批量视频会按镜号顺序生成；换场景会自动停止衔接。修改仅对下次生成生效。</p>
        </template>
      </div>
      <template #footer><el-button @click="visible = false">关闭</el-button><el-button type="primary" :loading="saving" :disabled="!data || loading || disabled" @click="save">保存</el-button></template>
    </el-dialog>
  </div>
</template>
<script setup>
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { videosAPI } from '@/api/videos'
const props = defineProps({ dramaId: [Number, String], storyboardId: [Number, String], aspectRatio: String, disabled: Boolean })
const visible = ref(false)
const loading = ref(false)
const saving = ref(false)
const data = ref(null)
const error = ref('')
const continuity = ref('auto')
const canvasLabel = computed(() => ({ '16:9': '1344×768', '9:16': '768×1344', '1:1': '992×992', '4:3': '1152×864', '3:4': '864×1152', '21:9': '1536×672' })[props.aspectRatio] || '1344×768')
async function open() {
  visible.value = true
  data.value = null
  error.value = ''
  loading.value = true
  try { data.value = await videosAPI.h3Inputs(props.dramaId, props.storyboardId); continuity.value = data.value.continuity }
  catch (e) { error.value = e.message }
  finally { loading.value = false }
}
async function save() {
  saving.value = true
  error.value = ''
  try { data.value = await videosAPI.saveH3Inputs(props.dramaId, props.storyboardId, { continuity: continuity.value }); ElMessage.success('H3 衔接设置已保存'); visible.value = false }
  catch (e) { error.value = e.message }
  finally { saving.value = false }
}
</script>
<style scoped>
.h3-shot-settings { color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.6; margin: 8px 0; }
p { margin: 12px 0; line-height: 1.7; }
.reference-grid { display: flex; flex-wrap: wrap; gap: 12px; }
.reference-grid > div { width: 140px; font-size: 12px; }
</style>
