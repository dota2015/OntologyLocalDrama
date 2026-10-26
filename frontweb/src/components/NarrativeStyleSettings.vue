<template>
  <div class="narrative-settings" :class="{ 'narrative-settings--compact': compact }">
    <span class="narrative-label">叙事风格</span>
    <el-select :model-value="modelValue.preset" style="width:160px" :disabled="saving || disabled || !presets.length" @change="pickPreset">
      <el-option v-for="item in presets" :key="item.id" :value="item.id" :label="item.label" />
    </el-select>
    <template v-if="!compact">
      <el-select :model-value="modelValue.speech_mode || 'fixed'" style="width:130px" :disabled="saving || disabled" @change="changeMode">
        <el-option value="auto" label="逐镜自动语速" />
        <el-option value="fixed" label="固定语速" />
      </el-select>
      <span class="narrative-label">{{ modelValue.speech_mode === 'auto' ? '基准语速' : '固定语速' }}</span>
      <el-input-number
        :model-value="modelValue.speech_rate"
        :min="0.5"
        :max="2"
        :step="0.05"
        :precision="2"
        :disabled="saving || disabled"
        style="width:115px"
        @change="val => changeSpeed(val, modelValue.speech_mode)"
      />
      <span>倍</span>
    </template>
    <el-tooltip :content="`${selected?.description || ''} 自动模式按各镜台词、情绪和时长规划：以基准语速为中心，普通对白1.2～1.3倍，急促短句最多1.4倍；固定模式则全片使用统一倍速。您可自由输入调节倍率（0.5~2.0倍）。`" placement="top">
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
function pickPreset(id){const item=presets.value.find(p=>p.id===id);if(item)return commit({preset:id,speech_rate:item.speed,speech_mode:item.speech_mode || 'fixed'})}
function changeSpeed(speed, explicitMode){
  if(Number.isFinite(speed)){
    const mode = explicitMode !== undefined ? explicitMode : 'fixed'
    return commit({...props.modelValue,speech_rate:Math.round(speed*100)/100,speech_mode:mode})
  }
}
function changeMode(mode){return commit({...props.modelValue,speech_mode:mode,...(mode==='auto'?{speech_rate:1.25}:{})})}
onMounted(load)
</script>
<style scoped>
.narrative-settings{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:13px;margin:10px 0}
.narrative-settings--compact{margin:0}
.narrative-label{font-weight:500;color:var(--el-text-color-regular)}
.narrative-help{color:var(--el-color-primary);cursor:help}
</style>
