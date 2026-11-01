import test from 'node:test'
import assert from 'node:assert/strict'

import {
  canUseUniversalOmniVideoApi,
  isH3VideoAiConfig,
  videoModelNameFromAiConfig,
} from '../src/utils/videoOmniSupport.js'

test('videoModelNameFromAiConfig prefers default_model then first model', () => {
  assert.equal(videoModelNameFromAiConfig({ default_model: 'a' }), 'a')
  assert.equal(videoModelNameFromAiConfig({ model: ['b', 'c'] }), 'b')
  assert.equal(videoModelNameFromAiConfig({ model: 'd' }), 'd')
  assert.equal(videoModelNameFromAiConfig(null), '')
})

test('H3 is the only universal multi-reference video integration', () => {
  assert.equal(canUseUniversalOmniVideoApi({ api_protocol: 'minimax_h3' }), true)
  assert.equal(canUseUniversalOmniVideoApi({ provider: 'minimax_h3' }), true)
  assert.equal(canUseUniversalOmniVideoApi({ api_protocol: 'openai', model: 'MiniMax-H3' }), true)

  assert.equal(canUseUniversalOmniVideoApi({ api_protocol: 'comfyui_wan22' }), false)
  assert.equal(canUseUniversalOmniVideoApi({ api_protocol: 'volcengine_omni' }), false)
  assert.equal(canUseUniversalOmniVideoApi({ provider: 'agnes', model: 'agnes-video-2.5' }), false)
  assert.equal(canUseUniversalOmniVideoApi(null), false)
})

test('H3 AI config detection is reusable outside universal creation mode', () => {
  assert.equal(isH3VideoAiConfig({ api_protocol: 'minimax_h3' }), true)
  assert.equal(isH3VideoAiConfig({ provider: 'openai', model: ['MiniMax-H3'] }), true)
  assert.equal(isH3VideoAiConfig(null, 'minimax_h3'), true)
  assert.equal(isH3VideoAiConfig({ api_protocol: 'comfyui_wan22', model: ['Wan2.2'] }), false)
})
