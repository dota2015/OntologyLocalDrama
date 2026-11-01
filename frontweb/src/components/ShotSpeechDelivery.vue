<template>
  <div v-if="loading || error || (plan && plan.has_speech)" class="speech-delivery">
    <span v-if="loading" class="speech-hint">计算台词预算中…</span>
    <el-button v-else-if="error" link size="small" @click="refresh">重试预算</el-button>
    <template v-else-if="plan && plan.has_speech">
      <el-tooltip content="对白与旁白使用自然语速，共用本镜实际时长；动作与台词按时间轴同步。" placement="top">
        <span class="speech-info">
          自然语速 · 约{{ plan.han_budget }}字{{ plan.fits ? '' : '(超出)' }}
        </span>
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
.speech-delivery{display:inline-flex;align-items:center;font-size:11px;color:var(--el-text-color-secondary);margin:0;line-height:1.2}
.speech-info{background:rgba(139,92,246,0.08);color:#a78bfa;padding:1px 6px;border-radius:4px;cursor:help;white-space:nowrap}
:global(html.light) .speech-info{background:rgba(124,58,237,0.08);color:#7c3aed}
.speech-hint{font-size:11px;color:var(--el-text-color-placeholder)}
</style>
