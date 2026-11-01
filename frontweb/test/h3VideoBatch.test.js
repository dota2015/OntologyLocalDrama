import test from 'node:test'
import assert from 'node:assert/strict'
import { videoBatchConcurrency, orderedVideoShots } from '../src/utils/h3VideoBatch.js'
test('H3 batches run in storyboard order and wait for prior completion', () => {
  const boards = [{ id: 8, storyboard_number: 2, model: 'MiniMax-H3' }, { id: 5, storyboard_number: 1, model: 'MiniMax-H3' }]
  assert.deepEqual(orderedVideoShots(boards).map(s => s.id), [5, 8])
  assert.equal(boards[0].id, 8)
  assert.equal(videoBatchConcurrency(boards, s => s.model, 3), 1)
  assert.equal(videoBatchConcurrency([boards[1]], s => s.model, 3), 1)
  assert.equal(videoBatchConcurrency([boards[1]], s => s.model, 3, true), 1)
  assert.equal(videoBatchConcurrency(boards, () => undefined, 3), 1)
})
