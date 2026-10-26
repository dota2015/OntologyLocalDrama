<template>
  <div class="character-stages">
    <p>为同一人物保存现实装、训练装等造型。每个分镜只用一套，换装拆到新分镜；人物身份和音色保持关联。</p>
    <p>集数范围可留空。同一集有多套造型时，在分镜的「本镜造型」中选择；多个范围重叠时不会自动选定。</p>
    <template v-if="parseError">
      <el-alert :title="parseError" type="error" :closable="false" />
      <el-input :model-value="modelValue" type="textarea" :rows="5" @update:model-value="emit('update:modelValue',$event)" />
    </template>
    <template v-else>
      <el-collapse>
        <el-collapse-item v-for="stage in stages" :key="stage.id" :name="stage.id" :title="stage.name || '未命名造型'">
          <el-input v-model="stage.name" maxlength="80" placeholder="造型名称，例如：三角洲训练装" @input="commit" />
          <el-input v-model="stage.appearance" type="textarea" :rows="3" maxlength="1500" show-word-limit placeholder="描述这套造型的上衣、下装、颜色、鞋子和配饰，保持人物身份不变" @input="commit" />
          <div class="range-row">
            <el-checkbox :model-value="!!stage.episode_range" @change="toggleRange(stage,$event)">按集数默认使用</el-checkbox>
            <template v-if="stage.episode_range">
              第 <el-input-number v-model="stage.episode_range[0]" :min="1" :step="1" :precision="0" @change="commit" />
              至 <el-input-number v-model="stage.episode_range[1]" :min="1" :step="1" :precision="0" @change="commit" /> 集
            </template>
          </div>
          <div class="reference-row">
            <el-image v-if="stage.reference_image" :src="referenceUrl(stage.reference_image)" fit="contain" style="width:110px;height:110px" />
            <label>造型参考图（可选）<input type="file" accept="image/*" :disabled="!!uploading" @change="upload(stage,$event)" /></label>
            <span v-if="uploading===stage.id">上传中…</span>
            <el-button v-if="stage.reference_image" link @click="removeReference(stage)">移除参考图</el-button>
          </div>
          <p>没有造型图时，沿用人物身份参考图，并按这套服装描述生成。</p>
          <el-button type="danger" link @click="remove(stage.id)">删除这套造型</el-button>
        </el-collapse-item>
      </el-collapse>
      <el-button size="small" :disabled="stages.length>=20" @click="add">添加造型</el-button>
      <p>编辑后点击人物窗口的「保存」。删除造型后请审核相关分镜；逐镜明确选用的造型会保留选择时的服装描述，需重新选择造型。</p>
    </template>
  </div>
</template>
<script setup>
import { ref, watch, onBeforeUnmount } from 'vue'
import { ElMessage } from 'element-plus'
import { uploadAPI } from '@/api/upload'
const props=defineProps({modelValue:[String,Array],dramaId:[String,Number],characterId:[String,Number]})
const emit=defineEmits(['update:modelValue','uploading'])
const stages=ref([]),parseError=ref(''),uploading=ref('')
let alive=true
onBeforeUnmount(()=>{alive=false;emit('uploading',false)})
watch(()=>props.modelValue,value=>{
  try{
    const rows=typeof value==='string'?JSON.parse(value || '[]'):value || []
    if(!Array.isArray(rows) || rows.some(row=>!row || typeof row!=='object' || Array.isArray(row) || (row.episode_range!=null && (!Array.isArray(row.episode_range) || row.episode_range.length!==2))))throw new Error()
    stages.value=rows.map((row,i)=>({...row,id:row.id || `legacy-${i+1}`,name:row.name || `造型${i+1}`}))
    parseError.value=''
  }catch{parseError.value='原有造型 JSON 无效，请先修正为数组；原内容已保留。'}
},{immediate:true})
function commit(){emit('update:modelValue',JSON.stringify(stages.value))}
function add(){stages.value.push({id:`look-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,name:`造型${stages.value.length+1}`,appearance:''});commit()}
function remove(id){stages.value=stages.value.filter(s=>s.id!==id);commit()}
function toggleRange(stage,enabled){if(enabled)stage.episode_range=[1,1];else delete stage.episode_range;commit()}
function removeReference(stage){delete stage.reference_image;commit()}
function referenceUrl(value){return /^https?:\/\//i.test(value)?value:'/static/'+value.replace(/^\/static\//,'')}
async function upload(stage,event){
  const file=event.target.files?.[0],dramaId=props.dramaId,characterId=props.characterId,id=stage.id
  if(!file)return
  if(!file.type.startsWith('image/') || file.size>20*1024*1024){ElMessage.error('请选择20MB以内的图片');return}
  uploading.value=id;emit('uploading',true)
  try{
    const result=await uploadAPI.uploadImage(file,{dramaId})
    const current=stages.value.find(s=>s.id===id)
    if(alive && props.dramaId===dramaId && props.characterId===characterId && current){current.reference_image=result.local_path || result.url;commit()}
  }catch(e){ElMessage.error(e.message || '造型参考图上传失败')}
  finally{uploading.value='';emit('uploading',false);event.target.value=''}
}
</script>
<style scoped>
.character-stages{width:100%;font-size:12px;color:var(--el-text-color-secondary)}
p{margin:6px 0;line-height:1.6}.el-input,.el-textarea{margin:6px 0}.range-row,.reference-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:10px 0}.el-input-number{width:105px}input[type=file]{display:block;max-width:240px;margin-top:6px}
</style>
