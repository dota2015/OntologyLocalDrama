const test = require('node:test');
const assert = require('node:assert/strict');
const VideoProviderFactory = require('../src/services/video/videoProviderFactory');
const { AgnesVideoProvider } = require('../src/services/video/providers/agnesProvider');
const { MinimaxH3VideoProvider } = require('../src/services/video/providers/minimaxH3Provider');
const { VolcengineVideoProvider } = require('../src/services/video/providers/volcengineProvider');

test('VideoProviderFactory resolves correct strategy instances', () => {
  // Agnes
  const agnesProvider = VideoProviderFactory.getProvider({ provider: 'agnes' });
  assert.ok(agnesProvider instanceof AgnesVideoProvider);
  assert.equal(agnesProvider.name, 'agnes');

  const agnesByModel = VideoProviderFactory.getProvider({}, 'agnes-video-2.5-flash');
  assert.ok(agnesByModel instanceof AgnesVideoProvider);

  // MiniMax H3
  const h3Provider = VideoProviderFactory.getProvider({ api_protocol: 'minimax_h3' });
  assert.ok(h3Provider instanceof MinimaxH3VideoProvider);
  assert.equal(h3Provider.name, 'minimax_h3');

  const h3ByModel = VideoProviderFactory.getProvider({}, 'minimax-h3');
  assert.ok(h3ByModel instanceof MinimaxH3VideoProvider);

  // Volcengine
  const volcProvider = VideoProviderFactory.getProvider({ api_protocol: 'volcengine' });
  assert.ok(volcProvider instanceof VolcengineVideoProvider);
  assert.equal(volcProvider.name, 'volcengine');

  // Generic fallback
  const generic = VideoProviderFactory.getProvider({ provider: 'unknown_provider' });
  assert.equal(generic.name, 'generic');
});

test('AgnesVideoProvider normalizes duration and build poll URLs', () => {
  const provider = new AgnesVideoProvider();
  assert.equal(provider.normalizeDuration(15, 'agnes-video-2.5'), '12');
  assert.equal(provider.normalizeDuration(3, 'agnes-video-2.5'), '4');
  assert.equal(provider.normalizeDuration(8, 'agnes-video-2.5'), '8');

  const pollUrl = provider.buildPollUrl({ base_url: 'https://apihub.agnes-ai.com' }, 'task-123', 'agnes-video-2.5');
  assert.ok(pollUrl.includes('task-123'));
  assert.ok(pollUrl.includes('agnesapi'));
});

test('MinimaxH3VideoProvider clamps duration and builds V2 query endpoint', () => {
  const provider = new MinimaxH3VideoProvider();
  assert.equal(provider.normalizeDuration(20), 15);
  assert.equal(provider.normalizeDuration(2), 4);
  assert.equal(provider.normalizeDuration(8), 8);

  const pollUrl = provider.buildPollUrl({ base_url: 'https://api.minimaxi.com' }, 'h3-task-abc');
  assert.ok(pollUrl.includes('/v2/query/video_generation/h3-task-abc'));
});
