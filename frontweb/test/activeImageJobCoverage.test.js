import test from 'node:test'
import assert from 'node:assert/strict'
import { activeImageJobCoverage, storyboardImageTaskKey } from '../src/utils/activeImageJobCoverage.js'

test('single-shot durable image jobs cover their child sidebar task', () => {
  const covered = activeImageJobCoverage([{
    options: JSON.stringify({ storyboard_ids: [487], slots: ['image'] }),
    items: [],
  }])
  assert.equal(covered.has(storyboardImageTaskKey('sb_image', 487)), true)
  assert.equal(covered.has(storyboardImageTaskKey('sb_first_image', 487)), false)
})

test('expanded batches cover only active image items and preserve frame roles', () => {
  const covered = activeImageJobCoverage([{
    options: {},
    items: [
      { action: 'image', status: 'running', payload: { storyboard_id: 10, slot: 'first' } },
      { action: 'image', status: 'pending', payload: { storyboard_id: 10, slot: 'last' } },
      { action: 'image', status: 'completed', payload: { storyboard_id: 9, slot: 'image' } },
      { action: 'frame_prompt', status: 'running', payload: { storyboard_id: 11, slot: 'first' } },
    ],
  }])
  assert.deepEqual([...covered].sort(), ['sb_first_image:10', 'sb_last_image:10'])
})
