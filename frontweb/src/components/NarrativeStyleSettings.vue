<template>
  <div class="narrative-settings" :class="{ 'narrative-settings--compact': compact }">
    <span class="narrative-label">叙事风格</span>
    <el-select :model-value="modelValue.preset" style="width:160px" :disabled="saving || disabled || !presets.length" @change="pickPreset">
      <el-option v-for="item in presets" :key="item.id" :value="item.id" :label="item.label" />
    </el-select>
    <el-tooltip :content="`${selected?.description || ''} 所有叙事风格均规划人物互动、动作过程与结束状态。人物对白与旁白使用自然语速；本选项只调整表达侧重。`" placement="top">
      <span class="narrative-help">说明</span>
    </el-tooltip>
    <span v-if="saving" style="font-size:12px;color:var(--el-color-primary)">保存中…</span>
    <el-button v-if="loadError" size="small" link @click="load">重试加载叙事风格</el-button>
  </div>
</template>
<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { creativeSettingsAPI } from '@/api/creativeSettings'
import { dramaAPI } from '@/api/drama'
const props=defineProps({modelValue:{type:Object,required:true},dramaId:[String,Number],disabled:Boolean,compact:Boolean})
const emit=defineEmits(['update:modelValue','saved','saving'])
const presets=ref([]),saving=ref(false),loadError=ref(false)
const selected=computed(()=>presets.value.find(p=>p.id===props.modelValue.preset))
async function load(){try{presets.value=await creativeSettingsAPI.presets();loadError.value=false}catch{loadError.value=true}}
async function commit(settings){
  if(saving.value || props.disabled)return
  const previous={...props.modelValue}
  const dramaId=props.dramaId
  emit('update:modelValue',settings)
  if(!dramaId)return
  saving.value=true
  emit('saving',true)
  try{
    await dramaAPI.saveOutline(dramaId,{metadata:{narrative_style:settings}})
    if(props.dramaId===dramaId){emit('saved',settings);ElMessage.success('叙事风格已保存，对后续新生成内容生效')}
  }catch(e){if(props.dramaId===dramaId)emit('update:modelValue',previous);ElMessage.error(e.message || '叙事风格保存失败')}
  finally{saving.value=false;emit('saving',false)}
}
function pickPreset(id){const item=presets.value.find(p=>p.id===id);if(item)return commit({preset:id})}
onMounted(load)
</script>
<style scoped>
.narrative-settings{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:13px;margin:0}
.narrative-settings--compact{margin:0}
.narrative-label{font-weight:500;color:var(--el-text-color-regular)}
.narrative-help{color:var(--el-color-primary);cursor:help}
</style>
