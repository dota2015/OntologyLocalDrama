<template>
  <div class="h3-shot-settings">
    <el-tooltip :content="`H3 原生输入 ${canvasLabel} · 23 步 · 人物多图 + 参考声音`" placement="top">
      <el-button size="small" link type="primary" class="h3-settings-btn" @click="open">
        H3素材与衔接
      </el-button>
    </el-tooltip>
    <el-dialog v-model="visible" title="H3 参考素材与衔接" width="660px" append-to-body destroy-on-close>
      <div v-loading="loading">
        <el-alert v-if="error" :title="error" type="error" :closable="false" />
        <template v-if="data">
          <p>导演 Agent 统一规划 Ref2VA 多参考方案，不生成首尾帧。若生成后需要首帧强绑定，可在这里手动切换为 FL2VA；这个手动覆盖不会改写导演方案。</p>
          <div class="reference-grid">
            <div v-for="item in data.references" :key="item.source">
              <el-image :src="item.url" :preview-src-list="data.references.map(r => r.url)" fit="contain" style="width:120px;height:90px" />
              <div>{{ item.name }} · {{ item.kind === 'scene' ? '场景' : item.kind === 'prop' ? '道具' : '人物' }}</div>
            </div>
          </div>
          <p v-if="!data.references.length">本镜尚未关联人物或场景图。请先选择人物和场景并生成图片。</p>
          <p>Ref2VA 图片参考去重后最多 9 张；声音按「编辑文本」中的人物与旁白绑定，优先上传样音，否则使用已分配的 Edge-TTS 音色，每镜最多 3 个声音。</p>
          <el-alert v-if="data.wardrobe_change || data.continuity_reset" title="本镜开始前切换了造型，不能继承上一镜尾帧；请使用本镜新生成的首帧或让 Agent 重新规划。" type="info" :closable="false" />
          <el-form label-position="top">
            <el-form-item label="生成模式">
              <el-radio-group v-model="engineMode" style="width:100%" :disabled="disabled || saving">
                <el-radio-button label="ref2va">🎭 角色多参考 (默认)</el-radio-button>
                <el-radio-button label="fl2va">🎯 首帧强绑定 (FL2VA 覆盖)</el-radio-button>
              </el-radio-group>
              <div v-if="data.resolution_reason" class="resolution-reason-banner">
                <el-tag size="small" :type="data.resolved_mode === 'fl2va' ? 'success' : 'warning'">
                  {{ data.resolved_mode === 'fl2va' ? '最终方案：FL2VA 首帧强绑定' : '最终方案：Ref2VA 角色多参考' }}
                </el-tag>
                <span class="reason-text"><strong>依据：</strong>{{ data.resolution_reason }}</span>
              </div>
              <div v-if="data.h3_generation_plan" class="plan-card">
                <div><strong>模式：</strong>{{ data.h3_generation_plan.mode?.toUpperCase() }}<span>— {{ data.resolution_reason }}</span></div>
                <div><strong>首帧：</strong>{{ firstPolicyLabel(data.h3_generation_plan.first_frame_policy) }}<span>— {{ data.h3_generation_plan.first_frame_reason }}</span></div>
                <div><strong>尾帧：</strong>{{ lastPolicyLabel(data.h3_generation_plan.last_frame_policy) }}<span>— {{ data.h3_generation_plan.last_frame_reason }}</span></div>
              </div>
              <div style="font-size:12px; color:#64748b; margin-top:6px; line-height:1.6;">
                <span v-if="engineMode === 'fl2va'">
                  <b>首帧强绑定 (FL2VA)</b>：100% 构图贴合分镜图，不传入人物卡、场景卡或参考音频；结构化台词由 H3 原生生成，分镜图画面即是起幅。
                </span>
                <span v-else>
                  <b>角色多参考 (Ref2VA)</b>：只融合人物卡、场景图、道具图和参考声音，不生成或使用首尾帧，注重跨镜角色与音色一致性。
                </span>
              </div>
            </el-form-item>
            <el-form-item label="首帧策略（人工覆盖）">
              <el-select v-model="firstFramePolicy" style="width:100%" :disabled="disabled || saving || effectiveMode === 'ref2va'">
                <el-option value="agent" label="采用 Agent 首帧方案" />
                <el-option value="generate_new" label="Qwen-Image 生成新首帧" />
                <el-option value="layout_lock" label="Qwen-Image 按布局锁定生成首帧" />
                <el-option value="inherit_tail" label="ffmpeg 提取上镜真实尾帧（不调 Qwen-Image）" />
              </el-select>
            </el-form-item>
            <el-form-item label="尾帧策略（人工覆盖）">
              <el-select v-model="lastFramePolicy" style="width:100%" :disabled="disabled || saving || effectiveMode === 'ref2va'">
                <el-option value="agent" label="采用 Agent 尾帧方案" />
                <el-option value="none" label="不生成尾帧，让视频自然收束" />
                <el-option value="generate_tail" label="Qwen-Image 生成目标尾帧" />
              </el-select>
            </el-form-item>
          </el-form>

          <!-- 抽帧质量门禁反馈 -->
          <div v-if="data.quality_audit" class="quality-audit-card">
            <div class="quality-audit-header">
              <span class="qa-title">🎥 视频抽帧质检 (首帧/中帧/尾帧)</span>
              <el-tag size="small" :type="data.quality_audit.passed ? 'success' : 'danger'">
                {{ data.quality_audit.passed ? '质检通过' : '质量门禁警告' }}
              </el-tag>
            </div>
            <div v-if="data.quality_audit.summary" class="qa-summary">{{ data.quality_audit.summary }}</div>
            <div v-if="data.quality_audit.violations && data.quality_audit.violations.length" class="qa-violations">
              <div v-for="(v, i) in data.quality_audit.violations" :key="i" class="qa-violation-item">
                ⚠️ {{ v.message || v }}
              </div>
            </div>
            <div v-if="data.quality_audit.key_frames && data.quality_audit.key_frames.length" class="qa-frames-row">
              <div v-for="kf in data.quality_audit.key_frames" :key="kf.position" class="qa-frame-box">
                <el-image :src="kf.url" :preview-src-list="data.quality_audit.key_frames.map(k => k.url)" fit="cover" style="width: 100px; height: 60px; border-radius: 4px;" />
                <span class="qa-frame-label">{{ kf.position === 'start' ? '首帧(0%)' : kf.position === 'mid' ? '中帧(50%)' : '尾帧(100%)' }}</span>
              </div>
            </div>
          </div>
          <p v-if="effectiveMode === 'ref2va'">当前为 Ref2VA：只使用 Agent 列出的多参考素材，不生成或使用首尾帧。</p>
          <p v-else-if="effectiveFirstPolicy === 'inherit_tail' && data.previous_storyboard">上一镜：#{{ data.previous_storyboard.number }} · {{ data.previous_storyboard.same_scene ? '同场景' : '不同场景' }} · {{ data.previous_storyboard.video_ready ? '视频已就绪' : '尚无已完成视频' }}。本镜将在上镜完成后提取真实尾帧。</p>
          <p v-else-if="effectiveFirstPolicy === 'inherit_tail'">本集没有可继承的上一镜，该方案会在提交前被门禁拦截。</p>
          <p v-else>当前由 Qwen-Image 生成本镜首帧，再以 FL2VA 生成视频。</p>
          <p>H3 批量视频会按镜号顺序生成；换场景会停止尾帧衔接。人工覆盖不会改写 Agent 原建议，只影响下次生成的最终执行方案。</p>
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
const engineMode = ref('ref2va')
const firstFramePolicy = ref('agent')
const lastFramePolicy = ref('agent')
const effectiveMode = computed(() => engineMode.value || data.value?.resolved_mode || 'ref2va')
const effectiveFirstPolicy = computed(() => {
  if (effectiveMode.value === 'ref2va') return 'none'
  if (firstFramePolicy.value !== 'agent') return firstFramePolicy.value
  return data.value?.h3_generation_plan?.first_frame_policy || data.value?.agent_first_frame_policy
})
const canvasLabel = computed(() => ({ '16:9': '1344×768', '9:16': '768×1344', '1:1': '992×992', '4:3': '1152×864', '3:4': '864×1152', '21:9': '1536×672' })[props.aspectRatio] || '1344×768')
const firstPolicyLabel = value => ({ none: '不生成首帧', generate_new: 'Qwen-Image 生成新首帧', layout_lock: 'Qwen-Image 布局锁定首帧', inherit_tail: 'ffmpeg 继承上镜真实尾帧' })[value] || value || '未规划'
const lastPolicyLabel = value => ({ none: '不生成尾帧', generate_tail: 'Qwen-Image 生成目标尾帧' })[value] || value || '未规划'
async function open() {
  visible.value = true
  data.value = null
  error.value = ''
  loading.value = true
  try {
    data.value = await videosAPI.h3Inputs(props.dramaId, props.storyboardId)
    engineMode.value = ['fl2va', 'ref2va'].includes(data.value.engine_mode) ? data.value.engine_mode : 'ref2va'
    firstFramePolicy.value = data.value.first_frame_policy_override || 'agent'
    lastFramePolicy.value = data.value.last_frame_policy_override || 'agent'
  }
  catch (e) { error.value = e.message }
  finally { loading.value = false }
}
async function save() {
  saving.value = true
  error.value = ''
  try {
    data.value = await videosAPI.saveH3Inputs(props.dramaId, props.storyboardId, {
      engine_mode: engineMode.value,
      first_frame_policy: effectiveMode.value === 'ref2va' ? 'none' : firstFramePolicy.value,
      last_frame_policy: effectiveMode.value === 'ref2va' ? 'none' : lastFramePolicy.value,
    })
    ElMessage.success('H3 完整执行方案已保存')
    visible.value = false
  }
  catch (e) { error.value = e.message }
  finally { saving.value = false }
}
</script>
<style scoped>
.h3-shot-settings { display: inline-flex; align-items: center; color: var(--el-text-color-secondary); font-size: 11px; margin: 0; line-height: 1.2; }
.h3-settings-btn { font-size: 11px; padding: 0 4px; height: 22px; }
p { margin: 12px 0; line-height: 1.7; }
.reference-grid { display: flex; flex-wrap: wrap; gap: 12px; }
.reference-grid > div { width: 140px; font-size: 12px; }

.resolution-reason-banner {
  margin-top: 8px;
  padding: 8px 12px;
  background: var(--el-fill-color-light, #f8fafc);
  border: 1px solid var(--el-border-color-light, #e2e8f0);
  border-radius: 6px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.reason-text {
  color: var(--el-text-color-regular, #475569);
  line-height: 1.5;
}
.plan-card {
  margin-top: 8px;
  padding: 8px 12px;
  background: var(--el-fill-color-light, #f8fafc);
  border: 1px solid var(--el-border-color-light, #e2e8f0);
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.7;
}
.plan-card strong { display: inline-block; width: 52px; }
.plan-card span { margin-left: 6px; color: var(--el-text-color-secondary, #64748b); }

.quality-audit-card {
  margin-top: 14px;
  padding: 10px 14px;
  border-radius: 6px;
  background: var(--el-fill-color-light, #f8fafc);
  border: 1px solid var(--el-border-color, #e2e8f0);
}
.quality-audit-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 6px;
}
.qa-summary {
  font-size: 12px;
  color: #64748b;
  margin-bottom: 6px;
}
.qa-violations {
  margin: 6px 0;
  font-size: 12px;
  color: #ef4444;
}
.qa-violation-item {
  margin-bottom: 3px;
}
.qa-frames-row {
  display: flex;
  gap: 10px;
  margin-top: 8px;
}
.qa-frame-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  font-size: 11px;
  color: #64748b;
}
.qa-frame-label {
  margin-top: 3px;
}
</style>
