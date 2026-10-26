<template>
  <div class="speech-delivery">
    <span v-if="loading">正在计算本镜语速…</span>
    <el-button v-else-if="error" link size="small" @click="refresh">语速信息加载失败，点击重试</el-button>
    <template v-else-if="plan">
      <span v-if="!plan.has_speech">本镜无对白及旁白</span>
      <el-tooltip v-else :content="`${plan.reason}。对白与旁白共用预算，已预留收尾和换人停顿。TTS 按此倍率生成；H3 为目标语速，实际可能不同。已有音视频保留。`">
        <span>本镜目标语速：{{ plan.mode === 'auto' ? '自动' : '固定' }} · {{ plan.speech_rate }} 倍 · 合计约 {{ plan.han_budget }} 个中文字预算{{ plan.fits ? '' : '（当前台词超出，需延长或拆镜）' }}</span>
      </el-tooltip>
    </template>
  </div>
</template>
<script setup>
import { ref,watch } from 'vue'
import { creativeSettingsAPI } from '@/api/creativeSettings'
const props=defineProps({shot:{type:Object,required:true},narrativeStyle:{type:Object,required:true}})
const plan=ref(null),loading=ref(false),error=ref(false)
let sequence=0
async function refresh(){
  const request=++sequence,id=props.shot.id
  if(!id)return
  loading.value=true;error.value=false
  try{const result=await creativeSettingsAPI.speechDelivery(id);if(request===sequence && id===props.shot.id)plan.value=result}
  catch{if(request===sequence)error.value=true}
  finally{if(request===sequence)loading.value=false}
}
watch(()=>JSON.stringify([props.shot.id,props.shot.dialogue,props.shot.narration,props.shot.universal_segment_text,props.shot.duration,props.shot.action,props.shot.description,props.narrativeStyle]),refresh,{immediate:true})
</script>
<style scoped>
.speech-delivery{font-size:12px;color:var(--el-text-color-secondary);margin:6px 0;line-height:1.6}
</style>
