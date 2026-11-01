const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tts = require('../src/services/ttsService');

test('IndexTTS sends duration_factor 0.8 by default and honors an explicit requested speed', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'index-speed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const reference = path.join(root, 'voice.wav');
  fs.writeFileSync(reference, 'reference-fixture');
  const factors = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    if (url.endsWith('/upload')) return new Response(JSON.stringify(['/tmp/reference.wav']));
    if (options?.method === 'POST') {
      factors.push(JSON.parse(options.body).data[17]);
      return new Response(JSON.stringify({ event_id: 'test' }));
    }
    if (url.endsWith('/gen_single/test')) return new Response('event: complete\ndata: [{"value":{"url":"http://index.test/audio.wav"}}]\n\n');
    return new Response('audio-fixture');
  });
  for (const speed of [undefined, 1]) {
    const result = await tts.synthesize(null, { info() {} }, { text: '爹，我扶您起来。',
      config: { provider: 'indextts', base_url: 'http://index.test', settings: '{}' },
      storage_base: root, voice_id: reference, speed });
    assert.ok(fs.existsSync(path.join(root, result.local_path)));
  }
  assert.deepEqual(factors, [0.8, 1]);
});
