<template>
  <div class="wardrobe-settings">
    <el-button size="small" link type="primary" :disabled="disabled" class="wardrobe-btn" @click="open">{{ characterId ? '编辑人物默认服装' : '镜间换装' }}</el-button>
    <el-dialog v-model="visible" :title="characterId ? '人物默认服装' : '本镜造型与镜间换装'" width="650px" append-to-body destroy-on-close>
      <div v-loading="loading">
        <el-alert v-if="error" :title="error" type="error" :closable="false" />
        <template v-if="data">
          <template v-if="characterId">
            <p>未指定阶段造型时沿用这套服装。已配置的集数范围与分镜明确选择优先；普通换场景、换集不代表换装。描述可包含上衣、下装、颜色、鞋子与配饰，留空时沿用人物主参考图。</p>
            <el-image v-if="data.reference_url" :src="data.reference_url" fit="contain" style="width:130px;height:130px" />
            <el-input v-model="description" type="textarea" :rows="4" maxlength="1500" show-word-limit placeholder="例如：浅灰连帽卫衣、深蓝长裤、白色运动鞋；胸前无徽章" />
          </template>
          <template v-else>
            <p>一个分镜内，每个人物只用一套造型，首尾帧和视频全程一致。换装过程拆成多个分镜，在新镜头开始前切换；后续镜头沿用。</p>
            <p v-if="!data.characters.length">本镜尚未关联人物，请先选择出场人物。</p>
            <el-checkbox v-model="changed" :disabled="!data.characters.length">本镜开始前切换造型（换装、穿越或返回现实）</el-checkbox>
            <el-input v-if="changed" v-model="reason" type="textarea" :rows="2" maxlength="1000" placeholder="说明剧情原因，例如：从梦境返回现实，恢复家中便装" style="margin:10px 0" />
            <div v-for="c in data.characters" :key="c.id" style="margin:12px 0">
              <strong>{{ c.name }}</strong>
              <template v-if="changed">
                <el-checkbox v-model="selected[c.id]" style="margin-left:10px">此人物换装</el-checkbox>
                <template v-if="selected[c.id]">
                  <el-select v-model="stageSelections[c.id]" placeholder="选择这位人物的造型" style="width:100%;margin:8px 0">
                    <el-option value="" label="自定义服装描述" />
                    <el-option v-for="stage in c.stages" :key="stage.id" :value="stage.id" :label="stage.name" />
                  </el-select>
                  <p v-if="stageSelections[c.id]">{{ c.stages?.find(s=>s.id===stageSelections[c.id])?.appearance }}</p>
                  <el-input v-else v-model="outfits[c.id]" type="textarea" :rows="2" maxlength="1500" placeholder="明确填写本镜开始时已穿着的服装，换装过程另拆分镜" />
                </template>
              </template>
              <p v-if="c.stage_missing" style="color:var(--el-color-warning)">原造型已移除，当前保留原服装描述，请审核后重新选择。</p>
              <p v-if="!changed">{{ c.stage_name ? c.stage_name+'：' : '' }}{{ c.description || '沿用人物主参考图中的既定服装' }}{{ c.source_storyboard_id ? '（继承已确定造型）' : '' }}</p>
            </div>
          </template>
          <p>保存不会改写已有图片或视频。已有首尾帧穿着冲突时，请按同一造型重新生成相关图片，再生成视频。</p>
        </template>
      </div>
      <template #footer><el-button @click="visible=false">关闭</el-button><el-button type="primary" :loading="saving" :disabled="loading || !data || disabled" @click="save">保存造型</el-button></template>
    </el-dialog>
  </div>
</template>
<script setup>
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { creativeSettingsAPI } from '@/api/creativeSettings'
const props=defineProps({dramaId:[String,Number],characterId:[String,Number],storyboardId:[String,Number],disabled:Boolean})
const visible=ref(false),loading=ref(false),saving=ref(false),error=ref(''),data=ref(null)
const description=ref(''),changed=ref(false),reason=ref(''),outfits=ref({}),selected=ref({}),stageSelections=ref({})
const endpoint=()=>props.characterId?`/dramas/${props.dramaId}/wardrobe/characters/${props.characterId}`:`/storyboards/${props.storyboardId}/wardrobe`
let sequence=0
async function open(){
  visible.value=true;loading.value=true;error.value='';data.value=null
  const request=++sequence,path=endpoint()
  try{
    const result=await creativeSettingsAPI.getWardrobe(path)
    if(request!==sequence || path!==endpoint())return
    data.value=result;description.value=result.description || '';changed.value=!!result.change;reason.value=result.change?.reason || ''
    stageSelections.value=Object.fromEntries((result.characters || []).map(c=>[c.id,c.stage_id || '']))
    outfits.value=Object.fromEntries((result.characters || []).map(c=>[c.id,c.description || '']))
    selected.value=Object.fromEntries((result.characters || []).map(c=>[c.id,!!result.change?.characters?.some(v=>v.character_id===c.id)]))
  }catch(e){if(request===sequence)error.value=e.message}
  finally{if(request===sequence)loading.value=false}
}
async function save(){
  if(saving.value || props.disabled || !data.value)return
  saving.value=true;error.value=''
  const path=endpoint(),request=sequence
  const body=props.characterId?{description:description.value}:{change:changed.value?{boundary:'before_shot',reason:reason.value,characters:data.value.characters.filter(c=>selected.value[c.id]).map(c=>({character_id:c.id,...(stageSelections.value[c.id]?{stage_id:stageSelections.value[c.id]}:{description:outfits.value[c.id]})}))}:null}
  try{await creativeSettingsAPI.saveWardrobe(path,body);if(path===endpoint() && request===sequence){ElMessage.success('服装连续性设置已保存');visible.value=false}}
  catch(e){if(path===endpoint() && request===sequence)error.value=e.message}
  finally{saving.value=false}
}
</script>
<style scoped>
.wardrobe-settings{display:inline-flex;align-items:center;font-size:11px;margin:0;line-height:1.2;color:var(--el-text-color-secondary)}
.wardrobe-btn{font-size:11px;padding:0 4px;height:22px}
p{line-height:1.7;margin:10px 0}
</style>
