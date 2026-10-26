import test from 'node:test'
import assert from 'node:assert/strict'
import { referenceImageJobs, runReferenceImageBatch } from '../src/utils/referenceImageBatch.js'

test('only missing images in the requested resource group are planned, IDs are deduplicated per type', () => {
  const groups = {
    character: [{id: 1, name: '已有角色', local_path: 'character.png'}, {id: 2, name: '新角色'}],
    prop: [{id: 2, name: '训练卡'}, {id: 2, name: '重复卡'}, {id: 3, image_url: '/card.png'}, {id: 'bad'}],
    scene: [{id: 4, location: '训练场'}],
  }
  assert.deepEqual(referenceImageJobs(groups).map(job => `${job.type}:${job.id}`), ['character:2', 'prop:2', 'scene:4'])
  assert.deepEqual(referenceImageJobs(groups, 'prop'), [{type: 'prop', id: 2, label: '训练卡'}])
  assert.equal(referenceImageJobs(groups, 'scene')[0].label, '训练场')
})

function setup() {
  const rows = new Map([1,2,3].map(id => [id, {id, name: `道具${id}`}]))
  const jobs = referenceImageJobs({prop: [...rows.values()]})
  const submitted = []
  const progress = []
  const options = {
    resolve: job => rows.get(job.id), isRunning: () => false, shouldStop: () => false,
    generate: async job => { submitted.push(job.id); return {status: 'completed'} },
    onProgress: state => progress.push(state),
  }
  return {rows, jobs, submitted, progress, options}
}

test('images uploaded/generated during the batch, active tasks and deleted resources are skipped', async () => {
  const {rows, jobs, submitted, options} = setup()
  rows.get(1).local_path = 'uploaded-after-click.png'
  options.isRunning = job => job.id === 2
  rows.delete(3)
  const result = await runReferenceImageBatch(jobs, options)
  assert.deepEqual(submitted, [])
  assert.equal(result.skipped, 3)
  assert.equal(result.success, 0)
  assert.equal(result.remaining, 0)
})

test('generation waits for each task to finish before submitting the next', async () => {
  const {jobs, options} = setup()
  const events = []
  let active = false
  options.generate = async job => {
    assert.equal(active, false)
    active = true
    events.push(`start${job.id}`)
    await Promise.resolve()
    active = false
    events.push(`done${job.id}`)
    return {status: 'completed'}
  }
  const result = await runReferenceImageBatch(jobs, options)
  assert.deepEqual(events, ['start1','done1','start2','done2','start3','done3'])
  assert.equal(result.success, 3)
})

test('a failed resource is reported and does not prevent the remaining images from generating', async () => {
  const {jobs, options, submitted} = setup()
  options.generate = async job => {
    submitted.push(job.id)
    if (job.id === 1) throw new Error('上游暂时失败')
    if (job.id === 2) return {status: 'failed', error: '提示词为空'}
    return {status: 'completed'}
  }
  const result = await runReferenceImageBatch(jobs, options)
  assert.deepEqual(submitted, [1,2,3])
  assert.equal(result.success, 1)
  assert.equal(result.failed, 2)
  assert.deepEqual(result.errors.map(e => e.error), ['上游暂时失败', '提示词为空'])
})

test('stop or episode change lets the submitted task finish and prevents further submissions', async () => {
  const {jobs, options, submitted} = setup()
  let stop = false
  options.shouldStop = () => stop
  options.generate = async job => { submitted.push(job.id); stop = true; return {status: 'completed'} }
  const result = await runReferenceImageBatch(jobs, options)
  assert.deepEqual(submitted, [1])
  assert.equal(result.stopped, true)
  assert.equal(result.success, 1)
  assert.equal(result.remaining, 2)
})

for (const status of ['timeout', 'cancelled']) test(`${status} does not count as success and stops further submissions`, async () => {
  const {jobs, options} = setup()
  let count = 0
  options.generate = async () => { count++; return {status, error: '任务尚未确认完成'} }
  const result = await runReferenceImageBatch(jobs, options)
  assert.equal(count, 1)
  assert.equal(result.pending, 1)
  assert.equal(result.success, 0)
  assert.equal(result.stopped, true)
  assert.equal(result.remaining, 2)
})
