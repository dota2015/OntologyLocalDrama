import test from 'node:test'
import assert from 'node:assert/strict'
import { createVideoBatchMonitor } from '../src/utils/videoBatchMonitor.js'
import { canExpireLocally, videoAwareMaxAttempts } from '../src/utils/videoTaskPolicy.js'

test('video tasks cannot become failures from 10/15/30 minute browser thresholds', () => {
  for (const task of [{ type: 'video_generation' }, { resourceType: 'sb_video' }]) {
    assert.equal(canExpireLocally(task), false)
    assert.equal(videoAwareMaxAttempts(task), Infinity)
  }
  assert.equal(canExpireLocally({type:'image_generation'}),true)
  assert.equal(videoAwareMaxAttempts({resourceType:'sb_image'}),450)
})

test('refresh attaches to server progress and disposing never sends a stop or creation request', async () => {
  const statuses=[]; const scheduled=[]
  const monitor=createVideoBatchMonitor({getBatch:async id=>({id:'persisted',episode_id:id,current:3,status:'running'}),
    onStatus:(batch,id)=>statuses.push([batch,id]), schedule:fn=>{scheduled.push(fn);return scheduled.length},cancel:()=>{}})
  monitor.watch(7); await new Promise(setImmediate)
  assert.equal(statuses[0][0].current,3)
  assert.equal(statuses[0][0].id,'persisted')
  monitor.dispose()
  await scheduled[0]()
  assert.equal(statuses.length,1)
})

test('late response from previous episode cannot overwrite current episode progress', async () => {
  let resolveOld; const statuses=[]
  const monitor=createVideoBatchMonitor({getBatch:id=>id===7 ? new Promise(resolve=>{resolveOld=resolve}) : Promise.resolve({episode_id:id}),
    onStatus:batch=>statuses.push(batch),schedule:()=>1,cancel:()=>{}})
  monitor.watch(7); monitor.watch(8); await new Promise(setImmediate)
  resolveOld({episode_id:7}); await new Promise(setImmediate)
  assert.deepEqual(statuses,[{episode_id:8}])
  monitor.dispose()
})

test('network failures retry polling without changing server batch state', async () => {
  let calls=0; const scheduled=[]; const statuses=[]
  const monitor=createVideoBatchMonitor({getBatch:async()=>{if(++calls===1)throw Error('offline');return {status:'running'}},
    onStatus:batch=>statuses.push(batch),schedule:fn=>{scheduled.push(fn);return 1},cancel:()=>{}})
  monitor.watch(7); await new Promise(setImmediate)
  assert.equal(scheduled.length,1)
  await scheduled[0]()
  assert.equal(statuses[0].status,'running')
  monitor.dispose()
})
