<template>
  <div class="reference-mode">
    <div class="reference-mode-choice">
      <span>参考图</span>
      <el-select :model-value="referenceImageMode(resource)" size="small" style="width: 120px" :disabled="disabled || saving" @change="save">
        <el-option label="单图" value="single" />
        <el-option label="四视图（2×2）" value="quad_grid" />
      </el-select>
      <span v-if="saving">保存中…</span>
      <el-tag v-if="resource.reference_image_recommendation" size="small" type="info">AI 建议：{{ resource.reference_image_recommendation === 'quad_grid' ? '四视图' : '单图' }}</el-tag>
    </div>
    <div v-if="resource.reference_image_reason" class="reference-mode-reason">{{ resource.reference_image_reason }}</div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { propAPI } from '@/api/props'
import { sceneAPI } from '@/api/scenes'
import { referenceImageMode } from '@/utils/referenceImageMode'
const props = defineProps({ resource: { type: Object, required: true }, kind: { type: String, required: true }, disabled: Boolean })
const emit = defineEmits(['saving-change'])
const saving = ref(false)
async function save(mode) {
  if (saving.value || props.disabled) return
  const resource = props.resource
  const previous = referenceImageMode(resource)
  resource.reference_image_mode = mode
  saving.value = true
  emit('saving-change', true)
  try {
    await (props.kind === 'scene' ? sceneAPI : propAPI).update(resource.id, { reference_image_mode: mode })
  } catch (error) {
    resource.reference_image_mode = previous
    ElMessage.error(error.message || '参考图模式保存失败')
  } finally {
    saving.value = false
    emit('saving-change', false)
  }
}
</script>

<style scoped>
.reference-mode { margin: 8px 0; font-size: 12px; }
.reference-mode-choice { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.reference-mode-reason { color: var(--el-text-color-secondary); margin-top: 5px; line-height: 1.5; }
</style>
