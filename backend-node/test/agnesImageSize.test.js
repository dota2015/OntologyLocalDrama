const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mapAgnesImageSizeSpec, isAgnesImageConfig, clampAndAlignSize } = require('../src/services/imageClient');
const { aspectRatioToSize } = require('../src/services/imageService');

describe('aspectRatioToSize and clampAndAlignSize', () => {
  it('aspectRatioToSize returns sizes with max dimension <= 2048 and divisible by 16', () => {
    const ratios = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'];
    for (const r of ratios) {
      const s = aspectRatioToSize(r);
      assert.ok(s, `ratio ${r} should map to a size`);
      const [w, h] = s.split('x').map(Number);
      assert.ok(w <= 2048 && w >= 256, `w=${w} for ${r} should be between 256 and 2048`);
      assert.ok(h <= 2048 && h >= 256, `h=${h} for ${r} should be between 256 and 2048`);
      assert.equal(w % 16, 0, `w=${w} for ${r} must be multiple of 16`);
      assert.equal(h % 16, 0, `h=${h} for ${r} must be multiple of 16`);
    }
  });

  it('clampAndAlignSize scales down oversized dimensions to <= 2048 and aligns to 16', () => {
    assert.equal(clampAndAlignSize('2560x1440'), '2048x1152');
    assert.equal(clampAndAlignSize('1440x2560'), '1152x2048');
    assert.equal(clampAndAlignSize('1024x1024'), '1024x1024');
    assert.equal(clampAndAlignSize('2048x1152'), '2048x1152');
  });
});

describe('mapAgnesImageSizeSpec', () => {
  it('maps 9:16 project size to 2K portrait', () => {
    assert.deepEqual(mapAgnesImageSizeSpec('1440x2560'), { size: '2K', ratio: '9:16' });
  });

  it('maps 16:9 project size to 2K landscape', () => {
    assert.deepEqual(mapAgnesImageSizeSpec('2560x1440'), { size: '2K', ratio: '16:9' });
  });

  it('maps 1:1 project size to 2K square', () => {
    assert.deepEqual(mapAgnesImageSizeSpec('1920x1920'), { size: '2K', ratio: '1:1' });
  });

  it('keeps explicit size tiers', () => {
    assert.deepEqual(mapAgnesImageSizeSpec('1K'), { size: '1K', ratio: '1:1' });
    assert.deepEqual(mapAgnesImageSizeSpec('3k'), { size: '3K', ratio: '1:1' });
  });

  it('maps smaller squares to 1K', () => {
    assert.deepEqual(mapAgnesImageSizeSpec('1024x1024'), { size: '1K', ratio: '1:1' });
  });
});

describe('isAgnesImageConfig', () => {
  it('detects agnes provider even when api_protocol is openai', () => {
    assert.equal(
      isAgnesImageConfig({ provider: 'agnes', base_url: 'https://apihub.agnes-ai.com/v1', api_protocol: 'openai' }, 'agnes-image-2.5-flash'),
      true
    );
  });
});
