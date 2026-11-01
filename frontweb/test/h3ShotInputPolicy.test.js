import test from 'node:test'
import assert from 'node:assert/strict'

import { h3ShotInputPolicy } from '../src/utils/h3ShotInputPolicy.js'
import { isH3VideoAiConfig } from '../src/utils/videoOmniSupport.js'

test('H3 request detection uses the selected shot model as well as AI config', () => {
  assert.equal(isH3VideoAiConfig({ api_protocol: 'minimax_h3' }), true)
  assert.equal(isH3VideoAiConfig(null, 'minimax_h3'), true)
  assert.equal(isH3VideoAiConfig({ api_protocol: 'comfyui_wan22' }, 'Wan2.2'), false)
})

test('pure Ref2VA never requires a storyboard frame', () => {
  const policy = h3ShotInputPolicy({
    resolved_mode: 'ref2va',
    h3_generation_plan: { mode: 'ref2va', first_frame_policy: 'none', last_frame_policy: 'none' },
  })
  assert.equal(policy.allowed, true)
  assert.equal(policy.useStoryboardFrames, false)
})

test('FL2VA requires a generated or uploaded first frame', () => {
  const data = { resolved_mode: 'fl2va', h3_generation_plan: { mode: 'fl2va', first_frame_policy: 'generate_new' } }
  assert.equal(h3ShotInputPolicy(data).allowed, false)
  assert.equal(h3ShotInputPolicy(data, { hasFirstFrame: true }).allowed, true)
  assert.equal(h3ShotInputPolicy(data, { hasFirstFrame: true }).useStoryboardFrames, true)
})

test('FL2VA inherit-tail uses the completed predecessor instead of a storyboard frame', () => {
  const data = {
    resolved_mode: 'fl2va',
    h3_generation_plan: { mode: 'fl2va', first_frame_policy: 'inherit_tail' },
    previous_storyboard: { video_ready: true },
  }
  const policy = h3ShotInputPolicy(data)
  assert.equal(policy.allowed, true)
  assert.equal(policy.useStoryboardFrames, false)
  assert.equal(h3ShotInputPolicy({ ...data, previous_storyboard: { video_ready: false } }).allowed, false)
})

test('missing H3 director plan is blocked instead of guessed from creation mode', () => {
  const policy = h3ShotInputPolicy({})
  assert.equal(policy.allowed, false)
  assert.match(policy.reason, /缺少.*执行方案/)
})
