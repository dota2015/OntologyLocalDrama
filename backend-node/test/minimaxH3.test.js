const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isMinimaxH3Model,
  getMinimaxApiRoot,
  buildMinimaxH3PollUrl,
  extractMinimaxH3VideoUrl,
  normalizeMinimaxH3Duration,
  normalizeMinimaxH3Resolution,
} = require('../src/services/videoClient');

describe('MiniMax H3 helpers', () => {
  it('detects MiniMax-H3 model ids', () => {
    assert.equal(isMinimaxH3Model('MiniMax-H3'), true);
    assert.equal(isMinimaxH3Model('minimax-h3'), true);
    assert.equal(isMinimaxH3Model('MiniMax-Hailuo-2.3'), false);
  });

  it('strips /v1 from base for V2 root', () => {
    assert.equal(getMinimaxApiRoot('https://api.minimaxi.com/v1'), 'https://api.minimaxi.com');
    assert.equal(getMinimaxApiRoot('https://api.minimaxi.com/'), 'https://api.minimaxi.com');
    assert.equal(getMinimaxApiRoot('https://api.minimax.io/v2'), 'https://api.minimax.io');
  });

  it('builds poll URL with path task id', () => {
    const url = buildMinimaxH3PollUrl(
      { base_url: 'https://api.minimaxi.com/v1', query_endpoint: '/v2/query/video_generation/{taskId}' },
      '424010985738629'
    );
    assert.equal(url, 'https://api.minimaxi.com/v2/query/video_generation/424010985738629');
  });

  it('reads content.url from V2 query response', () => {
    const data = {
      task: {
        id: '424010985738629',
        model: 'MiniMax-H3',
        status: 'succeeded',
        content: { url: 'https://cdn.example.com/out.mp4' },
      },
    };
    assert.equal(extractMinimaxH3VideoUrl(data), 'https://cdn.example.com/out.mp4');
  });

  it('clamps provider safety duration to 4–30 and maps resolution', () => {
    assert.equal(normalizeMinimaxH3Duration(3), 4);
    assert.equal(normalizeMinimaxH3Duration(20), 20);
    assert.equal(normalizeMinimaxH3Duration(5), 5);
    assert.equal(normalizeMinimaxH3Resolution('1080p'), '2K');
    assert.equal(normalizeMinimaxH3Resolution('720p'), '768P');
    assert.equal(normalizeMinimaxH3Resolution('2K'), '2K');
  });

  it('does not allow the legacy duration clamp to hide a request over 30 seconds', () => {
    assert.throws(() => normalizeMinimaxH3Duration(30.5), /整数秒/);
  });
});
