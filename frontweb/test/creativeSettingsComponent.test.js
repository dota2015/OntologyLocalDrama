import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { parse, compileScript } from '@vue/compiler-sfc'

function handlers(component,names,bindings,extra=''){
 const {descriptor}=parse(fs.readFileSync(new URL(`../src/components/${component}.vue`,import.meta.url),'utf8'))
 const script=compileScript(descriptor,{id:'creative-settings-behavior'})
 const functions=script.scriptSetupAst.filter(node=>node.type==='FunctionDeclaration' && names.includes(node.id.name))
 assert.equal(functions.length,names.length)
 const source=functions.map(node=>descriptor.scriptSetup.content.slice(node.start,node.end)).join('\n')
 return new Function(...Object.keys(bindings),`${extra}\n${source}\nreturn {${names.join(',')}}`)(...Object.values(bindings))
}
const ref=value=>({value})
function narrativeSetup({id=3,reject=false}={}){
 const props={modelValue:{preset:'balanced',speech_rate:1},dramaId:id,disabled:false},events=[],requests=[]
 const bindings={props,presets:ref([{id:'narration'},{id:'balanced'}]),saving:ref(false),
  emit:(name,value)=>{events.push({name,value});if(name==='update:modelValue')props.modelValue=value},
  dramaAPI:{saveOutline:async(id,body)=>{requests.push({id,body});if(reject)throw new Error('save failed')}},
  ElMessage:{success(){},error(){}}}
 return {props,events,requests,bindings,actions:handlers('NarrativeStyleSettings',['commit','pickPreset'],bindings)}
}
test('selecting a narrative preset saves only the content style and emits the confirmed settings',async()=>{
 const {actions,requests,props,events}=narrativeSetup()
 await actions.pickPreset('narration')
 assert.deepEqual(requests,[{id:3,body:{metadata:{narrative_style:{preset:'narration'}}}}])
 assert.deepEqual(props.modelValue,{preset:'narration'})
 assert.deepEqual(events.find(e=>e.name==='saved'),{name:'saved',value:{preset:'narration'}})
 assert.deepEqual(events.filter(e=>e.name==='saving').map(e=>e.value),[true,false])
})
test('a failed style save restores the old selection and leaves no success event',async()=>{
 const {actions,props,events,bindings}=narrativeSetup({reject:true})
 await actions.pickPreset('narration')
 assert.deepEqual(props.modelValue,{preset:'balanced',speech_rate:1})
 assert.equal(events.filter(e=>e.name==='saved').length,0)
 assert.equal(bindings.saving.value,false)
})
test('choosing a preset drops legacy speech multiplier fields from the saved selection',async()=>{
 const {actions,props,requests}=narrativeSetup()
 props.modelValue={preset:'balanced',speech_rate:1.5,speech_mode:'auto'}
 await actions.pickPreset('narration')
 assert.deepEqual(props.modelValue,{preset:'narration'})
 assert.deepEqual(requests[0].body.metadata.narrative_style,{preset:'narration'})
})
test('new-project selections stay local and a late save cannot update another project',async()=>{
 const local=narrativeSetup({id:null})
 await local.actions.pickPreset('narration')
 assert.equal(local.requests.length,0)
 assert.deepEqual(local.props.modelValue,{preset:'narration'})
 const old=narrativeSetup()
 let finish
 old.bindings.dramaAPI.saveOutline=()=>new Promise(resolve=>{finish=resolve})
 const pending=old.actions.pickPreset('narration')
 old.props.dramaId=9;old.props.modelValue={preset:'atmosphere',speech_rate:1}
 finish();await pending
 assert.equal(old.events.filter(e=>e.name==='saved').length,0)
 assert.equal(old.props.modelValue.preset,'atmosphere')
})
function wardrobeSetup(props){
 const requests=[]
 const bindings={props,saving:ref(false),error:ref(''),visible:ref(true),description:ref('灰色卫衣'),changed:ref(true),reason:ref('进入梦境'),
  data:ref({characters:[{id:5},{id:6}]}),selected:ref({5:true,6:false}),outfits:ref({5:'银色训练服',6:'教官服'}),stageSelections:ref({}),
  creativeSettingsAPI:{saveWardrobe:async(path,body)=>{requests.push({path,body})}},ElMessage:{success(){}}}
 const endpoint=()=>props.characterId?`/dramas/${props.dramaId}/wardrobe/characters/${props.characterId}`:`/storyboards/${props.storyboardId}/wardrobe`
 return {requests,bindings,actions:handlers('WardrobeSettings',['save'],{...bindings,endpoint},'let sequence=0;')}
}
test('character wardrobe editor saves its own project character rather than a shot or full project metadata',async()=>{
 const {actions,requests}=wardrobeSetup({dramaId:3,characterId:5})
 await actions.save()
 assert.deepEqual(requests,[{path:'/dramas/3/wardrobe/characters/5',body:{description:'灰色卫衣'}}])
})
test('shot wardrobe editor submits only selected changes and allows clearing a transition to restore inheritance',async()=>{
 const {actions,requests,bindings}=wardrobeSetup({dramaId:3,storyboardId:80})
 await actions.save()
 assert.deepEqual(requests[0],{path:'/storyboards/80/wardrobe',body:{change:{boundary:'before_shot',reason:'进入梦境',characters:[{character_id:5,description:'银色训练服'}]}}})
 bindings.changed.value=false
 await actions.save()
 assert.deepEqual(requests[1].body,{change:null})
})
test('shot look selection submits a single stage ID for the real character',async()=>{
 const {actions,requests,bindings}=wardrobeSetup({dramaId:3,storyboardId:80})
 bindings.stageSelections.value={5:'training'}
 await actions.save()
 assert.deepEqual(requests[0].body,{change:{boundary:'before_shot',reason:'进入梦境',characters:[{character_id:5,stage_id:'training'}]}})
})
test('stage upload updates only its original character and ignores late results after switching characters',async()=>{
 const props={dramaId:3,characterId:5},stages=ref([{id:'training',name:'训练装',appearance:'白色训练服'}]),events=[]
 let finish
 const bindings={props,stages,uploading:ref(''),emit:(...event)=>events.push(event),
  uploadAPI:{uploadImage:()=>new Promise(resolve=>{finish=resolve})},ElMessage:{error(){}}}
 const actions=handlers('CharacterStagesEditor',['commit','upload'],bindings,'let alive=true;')
 const event={target:{files:[{type:'image/png',size:100}],value:'file.png'}}
 const pending=actions.upload(stages.value[0],event)
 props.characterId=6
 finish({local_path:'new.png'});await pending
 assert.equal(stages.value[0].reference_image,undefined)
 assert.equal(events.filter(e=>e[0]==='update:modelValue').length,0)
 const next=actions.upload(stages.value[0],event)
 finish({local_path:'training.png'});await next
 assert.equal(JSON.parse(events.find(e=>e[0]==='update:modelValue')[1])[0].reference_image,'training.png')
})

test('style controls announce pending saves so script generation and the second selector can wait for persistence',async()=>{
 const editor=narrativeSetup()
 let finish
 editor.bindings.dramaAPI.saveOutline=()=>new Promise(resolve=>{finish=resolve})
 const pending=editor.actions.pickPreset('narration')
 assert.deepEqual(editor.events.filter(e=>e.name==='saving').map(e=>e.value),[true])
 await editor.actions.pickPreset('balanced')
 assert.equal(editor.props.modelValue.preset,'narration','another selection must wait for the pending save')
 finish();await pending
 assert.deepEqual(editor.events.filter(e=>e.name==='saving').map(e=>e.value),[true,false])
 const failed=narrativeSetup({reject:true})
 await failed.actions.pickPreset('narration')
 assert.deepEqual(failed.events.filter(e=>e.name==='saving').map(e=>e.value),[true,false])
});
