import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { parse, compileScript } from '@vue/compiler-sfc'
import { orderedVideoShots } from '../src/utils/h3VideoBatch.js'

const {descriptor}=parse(fs.readFileSync(new URL('../src/views/FilmCreate.vue',import.meta.url),'utf8'))
const script=compileScript(descriptor,{id:'durable-video-batch-regression'})
const names=['startBatchVideoGeneration','applyVideoBatchStatus','stopBatchVideoGeneration']
const functions=script.scriptSetupAst.filter(n=>n.type==='FunctionDeclaration'&&names.includes(n.id.name))
  .map(n=>descriptor.scriptSetup.content.slice(n.start,n.end)).join('\n')

function setup() {
  const ref=value=>({value})
  const requests=[]
  const bindings={
    currentEpisodeId:ref(7),dramaId:ref(3),batchVideoRunning:ref(false),pipelineRunning:ref(false),
    batchVideoSubmitting:ref(false),batchVideoStopping:ref(false),batchVideoErrors:ref([]),batchVideoProgress:ref({}),serverVideoBatch:ref(null),
    loadStoryboardMedia:async()=>{},orderedVideoShots,store:{storyboards:[{id:9,storyboard_number:9},{id:7,storyboard_number:7},{id:8,storyboard_number:8}]},
    sbVideos:ref({7:[{status:'completed',local_path:'completed.mp4'}]}),recordHasPlayableVideoUrl:v=>!!v.local_path,
    isSbUniversalMode:()=>false,getSbFirstFrameUrl:sb=>`/first-${sb.id}.png`,collectSbOmniReferenceAbsoluteUrls:()=>[],sbCanSubmitVideo:()=>true,
    sbVideoFirstLastUrls:sb=>({first:`/first-${sb.id}.png`,last:`/tail-${sb.id}.png`}),selectedShotModel:()=>'minimax_h3',
    buildSbVideoPromptForApi:sb=>`Prompt ${sb.id}`,getSelectedStyle:()=>'saved-style',projectAspectRatio:ref('16:9'),
    videoResolution:ref('480p'),getSbVideoDurationForApi:sb=>sb.id===8?6:10,videoFrameContiguity:ref(true),
    videosAPI:{
      create:()=>assert.fail('Browser submitted an individual video'),
      createBatch:async(episodeId,body)=>{requests.push({episodeId,body});return {id:'persisted',episode_id:7,status:'running',total:2,current:0,failed:0,items:[]}},
      stopBatch:async(episodeId,batchId)=>{requests.push({stop:true,episodeId,batchId});return {id:batchId,episode_id:episodeId,status:'stopping',items:[]}},
    },ElMessage:{info(){},success(){},error(){}},
  }
  const handlers=new Function(...Object.keys(bindings),functions+'\nreturn {startBatchVideoGeneration,stopBatchVideoGeneration};')(...Object.values(bindings))
  return {handlers,bindings,requests}
}

test('batch button sends one complete durable batch, keeps selected inputs and skips completed videos',async()=>{
  const {handlers,bindings,requests}=setup()
  await handlers.startBatchVideoGeneration()
  assert.equal(requests.length,1)
  const {episodeId,body}=requests[0]
  assert.equal(episodeId,7); assert.equal(body.drama_id,3); assert.equal(body.continuity,true)
  assert.deepEqual(body.shots.map(s=>s.storyboard_id),[8,9])
  assert.deepEqual(body.shots.map(s=>s.duration),[6,10])
  assert.equal(body.shots[0].model,'minimax_h3')
  assert.equal(body.shots[0].first_frame_url,'/first-8.png')
  assert.equal(body.shots[0].last_frame_url,'/tail-8.png')
  assert.deepEqual(body.shots[0].reference_image_urls,['/first-8.png','/tail-8.png'])
  assert.equal(bindings.batchVideoRunning.value,true)
  await handlers.startBatchVideoGeneration()
  assert.equal(requests.length,1,'a repeated click must not resubmit')
})

test('stop button targets persisted batch rather than only changing browser state',async()=>{
  const {handlers,bindings,requests}=setup()
  await handlers.startBatchVideoGeneration(); await handlers.stopBatchVideoGeneration()
  assert.deepEqual(requests[1],{stop:true,episodeId:7,batchId:'persisted'})
  assert.equal(bindings.batchVideoStopping.value,true)
  assert.equal(bindings.batchVideoRunning.value,true)
})

test('switching episodes while media loads cannot submit shots to the previous episode',async()=>{
  const {handlers,bindings,requests}=setup()
  bindings.loadStoryboardMedia=async()=>{}
  // The awaited API/media load yields so a route change can arrive before submission.
  const pending=handlers.startBatchVideoGeneration()
  bindings.currentEpisodeId.value=8
  await pending
  assert.equal(requests.length,0)
})
