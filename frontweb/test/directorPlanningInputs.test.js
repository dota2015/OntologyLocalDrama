import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { parse, compileScript } from '@vue/compiler-sfc'
import { directorPlanningInputs, estimateScriptSpeech, speechPlanningWarning } from '../src/utils/directorPlanningInputs.js'

test('auto inputs are omitted and impossible manual combinations explain the adjustment',()=>{
  assert.deepEqual(directorPlanningInputs(null,undefined,{min:4,max:8}),{})
  assert.deepEqual(directorPlanningInputs(20,131,{min:4,max:8}),{storyboard_count:20,video_duration:131})
  assert.throws(()=>directorPlanningInputs(10,131,{min:4,max:8}),/17–32 镜/)
})

test('speech preflight uses the configured TTS speed and warns before submission', () => {
  const script = Array.from({ length: 5 }, () => '妈妈："先把数学作业写完。"\n奕辰："马上马上，我打完这一局就写。"').join('\n')
  const estimate = estimateScriptSpeech(script, 1.25)
  assert.equal(estimate.han, 100)
  assert.equal(estimate.speed, 1.25)
  assert.ok(estimate.seconds > 0)
  assert.match(speechPlanningWarning(script, 1, null, { min: 4, max: 8 }, 1.25), /TTS 1\.25x/)
  assert.equal(speechPlanningWarning(script, 10, null, { min: 4, max: 8 }, 1.25), '')
})

const {descriptor}=parse(fs.readFileSync(new URL('../src/components/filmCreate/StoryboardWorkbench.vue',import.meta.url),'utf8'))
const compiled=compileScript(descriptor,{id:'director-inputs'})
const node=compiled.scriptSetupAst.find(n=>n.type==='FunctionDeclaration'&&n.id.name==='onDirectorAgentGenerate')
const source=descriptor.scriptSetup.content.slice(node.start,node.end)
function setup(count,seconds){
  const ref=value=>({value}), requests=[], warnings=[]
  const bindings={directorPlanningInputs,currentEpisodeId:ref(1),dramaId:ref(2),storyboardCount:ref(count),videoDuration:ref(seconds),shotDurationMin:ref(4),shotDurationMax:ref(8),storyboards:ref([]),directorGenerating:ref(false),directorTaskMessage:ref(''),directorTaskProgress:ref(0),storyboardUniversalOmni:ref(true),store:{drama:{title:'测试'},currentEpisode:{title:'第一集'}},GEN_RESOURCE:{GENERATE_STORYBOARD:'storyboard'},loadLatestDirectorRun:async()=>{},ontologyAPI:{directorGenerate:async(id,body)=>{requests.push({id,body});return {task_id:'task'}}},ElMessage:{info(){},error(e){throw new Error(e)},warning(e){warnings.push(e)}}}
  return {run:new Function(...Object.keys(bindings),source+';return onDirectorAgentGenerate')(...Object.values(bindings)),requests,warnings}
}
test('real Director button sends manual fields but never substitutes displayed estimates',async()=>{
  const auto=setup(null,null);await auto.run()
  assert.deepEqual(auto.requests[0].body,{shot_duration_range:{min:4,max:8},universal_omni_storyboard:true})
  const manual=setup(20,131);await manual.run()
  assert.deepEqual(manual.requests[0].body,{storyboard_count:20,video_duration:131,shot_duration_range:{min:4,max:8},universal_omni_storyboard:true})
  const invalid=setup(10,131);await invalid.run()
  assert.equal(invalid.requests.length,0);assert.match(invalid.warnings[0],/17–32 镜/)
})

test('resume button sends only the failed task ID, ignoring incompatible current form values',async()=>{
  const form=setup(1,600)
  await form.run('failed-director-task')
  assert.deepEqual(form.requests[0].body,{resume_task_id:'failed-director-task'})
  assert.equal(form.warnings.length,0)
})
