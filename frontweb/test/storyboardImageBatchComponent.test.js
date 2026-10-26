import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { parse, compileScript } from '@vue/compiler-sfc'
import { missingStoryboardImageSlots, fillMissingStoryboardImages } from '../src/utils/storyboardImageBatch.js'

// Exercise the actual button handler and request adapter with external services
// replaced. This catches a component still filtering out shots that have firsts.
const { descriptor } = parse(fs.readFileSync(new URL('../src/components/filmCreate/StoryboardWorkbench.vue', import.meta.url), 'utf8'))
const script = compileScript(descriptor, { id: 'batch-image-regression' })
const names = ['startBatchImageGeneration','submitShotImageJob','onGenerateSbFramePair','openFramePromptEditor']
const functions = script.scriptSetupAst.filter(node => node.type === 'FunctionDeclaration' && names.includes(node.id.name))
  .map(node => descriptor.scriptSetup.content.slice(node.start,node.end)).join('\n')
assert.equal(script.scriptSetupAst.filter(node => node.type === 'FunctionDeclaration' && names.includes(node.id.name)).length,names.length)
function setup(count, {promptGenerator} = {}) {
  const ref = value => ({value})
  const requests=[]
  const bindings={
    dramaId:ref(3), currentEpisodeId:ref(7),batchImageRunning:ref(false),pipelineRunning:ref(false),
    hasSbFirstLastPair:()=>false,sbCharacterIds:ref({}),storyboardsAPI:{update:async()=>{}},
    submitGenerationJob:async(kind,options)=>{requests.push({kind,options});return {id:'durable-job'}},
    editingFramePromptSb:ref(null),editingFramePromptSlot:ref('first'),editingFramePromptText:ref(''),
    showFramePromptEditor:ref(false),editingFramePromptLoading:ref(false),
    ensureProfessionalFramePrompt:promptGenerator || (async()=> 'prompt'),
    ElMessage:{info(){},success(){},warning(){},error(){}},
  }
  const handlers=new Function(...Object.keys(bindings),'let framePromptEditorRequest=0;\n'+functions+'\nreturn {startBatchImageGeneration,onGenerateSbFramePair,openFramePromptEditor};')(...Object.values(bindings))
  return {handlers,bindings,requests}
}
test('batch image button submits a complete backend job once without browser dispatch or polling',async()=>{
  const {handlers,requests}=setup(20)
  await handlers.startBatchImageGeneration()
  assert.deepEqual(requests,[{kind:'storyboard_images',options:undefined}])
})
test('single shot frame pair is also submitted together; tail dispatch cannot depend on browser lifetime',async()=>{
  const {handlers,requests}=setup(1)
  await handlers.onGenerateSbFramePair({id:80})
  assert.deepEqual(requests,[{kind:'storyboard_images',options:{storyboard_ids:[80],slots:['first','last'],force:false}}])
})

test('the prompt dialog stays visibly loading while its tail prompt is generated',async()=>{
  let resolvePrompt
  const waiting = new Promise(resolve=>{resolvePrompt=resolve})
  const {handlers,bindings} = setup(0,{promptGenerator:()=>waiting})
  const opened = handlers.openFramePromptEditor({id:1},'last')
  assert.equal(bindings.showFramePromptEditor.value,true)
  assert.equal(bindings.editingFramePromptLoading.value,true)
  resolvePrompt('generated tail prompt')
  await opened
  assert.equal(bindings.editingFramePromptLoading.value,false)
  assert.equal(bindings.editingFramePromptText.value,'generated tail prompt')
})

test('a slow prompt response cannot overwrite a different storyboard opened afterward',async()=>{
  let resolveOld
  const waiting = new Promise(resolve=>{resolveOld=resolve})
  const {handlers,bindings} = setup(0,{promptGenerator:sb=>sb.id===1 ? waiting : Promise.resolve('second tail')})
  const old = handlers.openFramePromptEditor({id:1},'last')
  await handlers.openFramePromptEditor({id:2},'last')
  resolveOld('first tail')
  await old
  assert.equal(bindings.editingFramePromptSb.value.id,2)
  assert.equal(bindings.editingFramePromptText.value,'second tail')
})
