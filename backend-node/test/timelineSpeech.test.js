const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveTimelineSpeech } = require('../src/ontology/timelineSpeech');
const { directorExecutionSlotsOutputType } = require('../src/services/agentsRuntime');

const beat = (mode, plan = {}) => ({ audio_lip_sync: { mode, ...plan } });
const read = result => result.segments.map(s => s.audio_lip_sync.dialogue_content);

test('one voiced beat uses the source exactly regardless of where silence falls', () => {
  const text = '等我说“开始”。';
  const result = resolveTimelineSpeech([beat('bgm_only'), beat('offscreen_voiceover'), beat('music_with_effects')], text);
  assert.deepEqual(read(result), ['', text, '']);
  const segmentSchema = directorExecutionSlotsOutputType(6).schema.properties.video_slots.properties.shots_timeline.items.properties.audio_lip_sync;
  assert.equal(segmentSchema.properties.dialogue_content, undefined);
  assert.equal(segmentSchema.additionalProperties, false);
  assert.ok(segmentSchema.properties.speech_end);
});

test('multiple voiced beats use the selected Unicode boundaries and preserve the final punctuation', () => {
  const result = resolveTimelineSpeech([beat('narration', { speech_end: 2 }), beat('silent_ambient'), beat('narration')], '看🌙，走。');
  assert.deepEqual(read(result), ['看🌙', '', '，走。']);
  assert.equal(result.segments[0].audio_lip_sync.speech_end, undefined);
  assert.deepEqual(resolveTimelineSpeech(result.segments, '看🌙，走。').segments, result.segments);
  for (const end of [0, 6, 1.5]) {
    const invalid = resolveTimelineSpeech([beat('narration', { speech_end: end }), beat('narration')], '看🌙，走。');
    assert.equal(invalid.error.conflict_slots[0], 'video_slots.shots_timeline[0].audio_lip_sync.speech_end');
  }
});

test('explicit fragments may restore quote typography but missing or invented words stay blocked', () => {
  const text = '说‘现在’，然后走。';
  assert.deepEqual(read(resolveTimelineSpeech([beat('in_frame_dialogue', {dialogue_content: "说'现在'，然后走。"})], text)), [text]);
  for (const actual of ['说‘现在’，然后。', '说‘现在’，然后走了。', '说‘现在’，然后走！']) {
    assert.ok(resolveTimelineSpeech([beat('in_frame_dialogue', { dialogue_content: actual })], text).error);
  }
  assert.ok(resolveTimelineSpeech([beat('silent_ambient')], text).error);
  assert.ok(resolveTimelineSpeech([beat('in_frame_dialogue')], '').error);
  assert.ok(resolveTimelineSpeech([beat('silent_ambient', {dialogue_content:'额外台词'})], '').error);
});
