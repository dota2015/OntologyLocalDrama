const test = require('node:test');
const assert = require('node:assert/strict');
const VideoProviderFactory = require('../src/services/video/videoProviderFactory');
const { MinimaxH3VideoProvider } = require('../src/services/video/providers/minimaxH3Provider');

test('video provider factory exposes only MiniMax H3', () => {
  assert.ok(VideoProviderFactory.getProvider({ api_protocol: 'minimax_h3' }) instanceof MinimaxH3VideoProvider);
  assert.equal(VideoProviderFactory.getProvider({ provider: 'comfyui_wan22' }), null);
  assert.equal(VideoProviderFactory.getProvider({ provider: 'agnes' }, 'agnes-video-2.5'), null);
  assert.equal(VideoProviderFactory.getProvider({ api_protocol: 'volcengine_omni' }), null);
});
