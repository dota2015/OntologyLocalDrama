import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {parse, compileScript} from '@vue/compiler-sfc'
function handlers(file,names,bindings) {
  const {descriptor}=parse(fs.readFileSync(new URL(file,import.meta.url),'utf8'))
  const script=compileScript(descriptor,{id:'generation-jobs-test'})
  const functions=script.scriptSetupAst.filter(n=>n.type==='FunctionDeclaration' && names.includes(n.id.name))
    .map(n=>descriptor.scriptSetup.content.slice(n.start,n.end)).join('\n')
  return new Function(...Object.keys(bindings),functions+'\nreturn {'+names.join(',')+'};')(...Object.values(bindings))
}
const ref=value=>({value})

test('a refreshed observer restores server job progress and does not submit or cancel anything',async()=>{
  let creates=0,stops=0;const events=[]
  const running={id:'server-1',drama_id:3,episode_id:7,kind:'storyboard_images',status:'running',items:[{id:1,status:'completed'},{id:2,status:'running'}]}
  const bindings={props:{dramaId:3},epoch:1,jobs:ref([]),error:ref(''),signature:'',
    generationJobsAPI:{list:async()=>[running],create:()=>creates++,control:()=>stops++},emit:(...args)=>events.push(args)}
  const {refresh}=handlers('../src/components/GenerationJobs.vue',['refresh'],bindings)
  await refresh()
  assert.deepEqual(bindings.jobs.value,[running]);assert.equal(creates,0);assert.equal(stops,0)
  assert.equal(events[0][0],'jobs-change');assert.equal(events[1][0],'updated')
})
test('a progress query error remains visible without marking server tasks failed or stopping them',async()=>{
  const existing=[{id:'server-1',status:'running'}];const errors=[]
  const bindings={props:{dramaId:3},epoch:1,jobs:ref(existing),error:ref(''),signature:'',
    generationJobsAPI:{list:async()=>{throw new Error('暂时断网')}},emit:(...args)=>errors.push(args)}
  await handlers('../src/components/GenerationJobs.vue',['refresh'],bindings).refresh()
  assert.equal(bindings.error.value,'暂时断网');assert.equal(bindings.jobs.value,existing);assert.equal(errors.length,0)
})
test('reference batch sends one server plan with scope and style, preserving browser-independent execution',async()=>{
  const calls=[],events=[]
  const bindings={props:{dramaId:3,episodeId:7,disabled:false,stylePrompt:'warm'},running:ref(false),submitting:ref(false),
    generationJobsAPI:{create:async(...args)=>calls.push(args)},emit:(...args)=>events.push(args),ElMessage:{success(){},error(){}}}
  await handlers('../src/components/BatchReferenceImages.vue',['start'],bindings).start('scene')
  assert.deepEqual(calls,[[3,'reference_images',7,{scope:'scene',style:'warm'}]])
  assert.deepEqual(events,[['submitted']]);assert.equal(bindings.submitting.value,false)
})
