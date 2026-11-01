const test = require('node:test');
const assert = require('node:assert/strict');
const client = require('../src/services/videoClient');
const { assertSupportedVideoConfig } = require('../src/services/videoModelSupport');

test('Wan2.2 video configurations are retired and cannot be submitted', () => {
  const config = {
    provider: 'comfyui_wan22',
    api_protocol: 'comfyui_wan22',
    model: ['Wan2.2-I2V-A14B-FP8-4steps'],
    is_active: true,
  };
  assert.equal(client.resolveVideoProtocol(config), '');
  assert.throws(() => assertSupportedVideoConfig(config), /仅支持 MiniMax H3/);
});
