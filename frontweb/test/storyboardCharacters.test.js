import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveStoryboardCharacters } from '../src/utils/storyboardCharacters.js'

test('cross-episode selection resolves exact ID rather than same-name current character', () => {
  const old = { id: 17, name: '蜂医', local_path: 'old.png' }
  const current = { id: 26, name: '蜂医', local_path: 'new.png' }
  assert.deepEqual(resolveStoryboardCharacters([17], [current], [old, current]), [old])
  assert.deepEqual(resolveStoryboardCharacters(['26'], [current], [old]), [current])
})

test('missing character remains visible even with empty episode catalog', () => {
  const result = resolveStoryboardCharacters([17], [], [{ id: 26, name: '蜂医' }])
  assert.equal(result.length, 1)
  assert.equal(result[0].id, 17)
  assert.equal(result[0].missing, true)
  assert.match(result[0].name, /17.*无法解析/)
  assert.deepEqual(resolveStoryboardCharacters([], [], []), [])
})
