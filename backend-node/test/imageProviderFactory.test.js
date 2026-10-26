const test = require('node:test');
const assert = require('node:assert/strict');
const ImageProviderFactory = require('../src/services/image/imageProviderFactory');
const { DashScopeImageProvider } = require('../src/services/image/providers/dashScopeProvider');
const { KlingImageProvider } = require('../src/services/image/providers/klingProvider');
const { GeminiImageProvider } = require('../src/services/image/providers/geminiProvider');
const { NanoBananaImageProvider } = require('../src/services/image/providers/nanoBananaProvider');
const { UnslothImageProvider } = require('../src/services/image/providers/unslothProvider');
const { OpenAiImageProvider } = require('../src/services/image/providers/openAiProvider');

test('ImageProviderFactory resolves correct strategy instances', () => {
  // DashScope
  const dashScopeByProto = ImageProviderFactory.getProvider({ api_protocol: 'dashscope' });
  assert.ok(dashScopeByProto instanceof DashScopeImageProvider);
  assert.equal(dashScopeByProto.name, 'dashscope');

  const dashScopeByProvider = ImageProviderFactory.getProvider({ provider: 'dashscope' });
  assert.ok(dashScopeByProvider instanceof DashScopeImageProvider);

  const qwenImage = ImageProviderFactory.getProvider({ provider: 'qwen_image' });
  assert.ok(qwenImage instanceof DashScopeImageProvider);

  // Kling
  const klingByProto = ImageProviderFactory.getProvider({ api_protocol: 'kling' });
  assert.ok(klingByProto instanceof KlingImageProvider);
  assert.equal(klingByProto.name, 'kling');

  const klingByModel = ImageProviderFactory.getProvider({}, 'kling-v1');
  assert.ok(klingByModel instanceof KlingImageProvider);

  // Gemini
  const geminiByProto = ImageProviderFactory.getProvider({ api_protocol: 'gemini' });
  assert.ok(geminiByProto instanceof GeminiImageProvider);
  assert.equal(geminiByProto.name, 'gemini');

  const geminiByProvider = ImageProviderFactory.getProvider({ provider: 'google' });
  assert.ok(geminiByProvider instanceof GeminiImageProvider);

  // NanoBanana
  const nanoByProto = ImageProviderFactory.getProvider({ api_protocol: 'nano_banana' });
  assert.ok(nanoByProto instanceof NanoBananaImageProvider);
  assert.equal(nanoByProto.name, 'nano_banana');

  // Unsloth
  const unslothByProto = ImageProviderFactory.getProvider({ api_protocol: 'unsloth' });
  assert.ok(unslothByProto instanceof UnslothImageProvider);
  assert.equal(unslothByProto.name, 'unsloth');

  // OpenAI / Volcengine / Agnes
  const openAiByProto = ImageProviderFactory.getProvider({ api_protocol: 'openai' });
  assert.ok(openAiByProto instanceof OpenAiImageProvider);
  assert.equal(openAiByProto.name, 'openai');

  const volcByModel = ImageProviderFactory.getProvider({}, 'doubao-seedream-4.5');
  assert.ok(volcByModel instanceof OpenAiImageProvider);

  const agnesByModel = ImageProviderFactory.getProvider({}, 'agnes-image-2.1');
  assert.ok(agnesByModel instanceof OpenAiImageProvider);

  // Fallback
  const fallback = ImageProviderFactory.getProvider({ provider: 'some_unknown_gateway' });
  assert.ok(fallback instanceof OpenAiImageProvider);
});

test('ImageProviderFactory.inferProtocol accurately infers protocol from provider and model', () => {
  assert.equal(ImageProviderFactory.inferProtocol('dashscope', ''), 'dashscope');
  assert.equal(ImageProviderFactory.inferProtocol('qwen_image', ''), 'dashscope');
  assert.equal(ImageProviderFactory.inferProtocol('nano_banana', ''), 'nano_banana');
  assert.equal(ImageProviderFactory.inferProtocol('google', ''), 'gemini');
  assert.equal(ImageProviderFactory.inferProtocol('gemini', ''), 'gemini');
  assert.equal(ImageProviderFactory.inferProtocol('volcengine', ''), 'volcengine');
  assert.equal(ImageProviderFactory.inferProtocol('custom', 'doubao-seedream-4.5'), 'volcengine');
  assert.equal(ImageProviderFactory.inferProtocol('kling', ''), 'kling');
  assert.equal(ImageProviderFactory.inferProtocol('custom', 'kling-v2'), 'kling');
  assert.equal(ImageProviderFactory.inferProtocol('agnes', ''), 'agnes');
  assert.equal(ImageProviderFactory.inferProtocol('openai', 'dall-e-3'), 'openai');
});
