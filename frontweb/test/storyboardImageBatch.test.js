import test from 'node:test'
import assert from 'node:assert/strict'
import { missingStoryboardImageSlots, fillMissingStoryboardImages } from '../src/utils/storyboardImageBatch.js'

function setup(initial = {}) {
  const state = { useFirstLast: true, hasFirst: false, hasLast: false, hasImage: false, ...initial }
  const calls = []
  const options = {
    getMissingSlots: () => missingStoryboardImageSlots(state),
    generate: async slot => {
      calls.push(slot)
      if (slot === 'first') state.hasFirst = true
      if (slot === 'last') state.hasLast = true
      if (slot === 'image') state.hasImage = true
      return { status: 'completed' }
    },
  }
  return { state, calls, options }
}

test('an existing first frame does not skip a storyboard with a missing tail', async () => {
  const { calls, options } = setup({ hasFirst: true, hasImage: true })
  assert.deepEqual(options.getMissingSlots(), ['last'])
  await fillMissingStoryboardImages(options)
  assert.deepEqual(calls, ['last'])
  await fillMissingStoryboardImages(options)
  assert.deepEqual(calls, ['last'], 'retry preserves both completed frames')
})

test('the first frame completes before its tail is submitted for layout reference', async () => {
  const { state, options } = setup()
  const events = []
  options.generate = async slot => {
    if (slot === 'last') assert.equal(state.hasFirst, true)
    events.push(`submit:${slot}`)
    await Promise.resolve()
    state[slot === 'first' ? 'hasFirst' : 'hasLast'] = true
    events.push(`complete:${slot}`)
    return { status: 'completed' }
  }
  await fillMissingStoryboardImages(options)
  assert.deepEqual(events, ['submit:first','complete:first','submit:last','complete:last'])
})

test('an existing tail is retained while only the first frame is filled', async () => {
  const { calls, options } = setup({ hasLast: true })
  await fillMissingStoryboardImages(options)
  assert.deepEqual(calls, ['first'])
})

test('single-image and universal modes generate one image and never request tails', async () => {
  const { calls, options } = setup({ useFirstLast: false })
  await fillMissingStoryboardImages(options)
  assert.deepEqual(calls, ['image'])
  assert.deepEqual(options.getMissingSlots(), [])
})

for (const status of ['failed','timeout','cancelled']) test(`${status} on the first frame prevents tail submission`, async () => {
  const { options } = setup()
  const calls = []
  options.generate = async slot => { calls.push(slot); return { status, error: '尚未完成' } }
  await assert.rejects(fillMissingStoryboardImages(options), /尚未完成/)
  assert.deepEqual(calls, ['first'])
})

test('a successful task without a visible completed frame does not allow tail generation', async () => {
  const { options } = setup()
  const calls = []
  options.generate = async slot => { calls.push(slot); return {status:'completed'} }
  await assert.rejects(fillMissingStoryboardImages(options), /首帧尚未确认/)
  assert.deepEqual(calls,['first'])
})

test('pause retains the first frame and resume only fills the missing tail', async () => {
  const { state, calls, options } = setup()
  const original = options.generate
  options.generate = async slot => slot === 'last' ? {paused:true} : original(slot)
  const result = await fillMissingStoryboardImages(options)
  assert.equal(result.paused, true)
  assert.equal(state.hasFirst, true)
  options.generate = original
  await fillMissingStoryboardImages(options)
  assert.deepEqual(calls,['first','last'])
})

test('stop or navigation lets the current first frame finish and prevents further submissions', async () => {
  const { options, calls } = setup()
  let stopped = false
  const original = options.generate
  options.shouldStop = () => stopped
  options.generate = async slot => { const result = await original(slot); stopped = true; return result }
  assert.equal((await fillMissingStoryboardImages(options)).stopped, true)
  assert.deepEqual(calls,['first'])
})

test('a slot supplied while waiting is not generated again', async () => {
  const { state, options } = setup()
  const original = options.generate
  options.generate = async slot => { const result = await original(slot); state.hasLast = true; return result }
  const result = await fillMissingStoryboardImages(options)
  assert.deepEqual(result.generated,['first'])
})
