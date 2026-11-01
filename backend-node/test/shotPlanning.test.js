const { test } = require('node:test');
const assert = require('node:assert/strict');
const range = require('../src/utils/shotDurationRange');
const { enforceStoryboardSpeechTiming, preservesSpeech } = require('../src/services/storyboardSpeechService');
const { automaticModel, hasSpeech, musicPrompt } = require('../src/services/storyboardVideoModelService');
const { deriveStoryboardFieldsFromAi } = require('../src/services/episodeStoryboardService');
const configs = [
  { is_active:1, is_default:1, provider:'comfyui_wan22', default_model:'Wan2.2', model:['Wan2.2'] },
  { is_active:1, provider:'openai', default_model:'minimax_h3', model:['minimax_h3'] },
];

test('automatic per-shot models default to minimax_h3 and ignore speech switches', () => {
  for (const shot of [{dialogue:'甲：“你好。”'}, {narration:'太阳升起。'}, {universal_segment_text:'甲说：“你好。”'}]) {
    assert.equal(hasSpeech(shot), true);
    assert.equal(automaticModel(configs, hasSpeech(shot)), 'minimax_h3');
  }
  for (const shot of [{}, {dialogue:'无对白',narration:'无旁白'}]) {
    assert.equal(hasSpeech(shot), false);
    assert.equal(automaticModel(configs, hasSpeech(shot)), 'minimax_h3');
  }
  assert.equal(automaticModel([configs[0]], false), null);
  const prompt = musicPrompt('环境[禁BGM]',configs[1],{});
  assert.doesNotMatch(prompt,/禁BGM/);
  assert.match(prompt,/背景音乐/);
});

test('duration ranges reject invalid limits and keep the model durations when they fit', async () => {
  for (const value of [{min:2,max:5},{min:7,max:5},{min:4,max:9},{min:4,max:16},{min:4.5,max:8}]) assert.throws(() => range.normalizeDurationRange(value));
  assert.deepEqual(range.normalizeDurationRange(null,5),{min:4,max:5});
  const shots = [{duration:4, action:'一瞥'}, {duration:7,action:'走近并停下'}, {duration:5, dialogue:'甲：'+'字'.repeat(24)}];
  const output = await enforceStoryboardSpeechTiming(shots, {durationRange:{min:4,max:8},generate:() => assert.fail('Fits without splitting')});
  assert.deepEqual(output.map(s=>s.duration),[4,7,6]);
  const persistedShot = { ...output[1] };
  const derived = deriveStoryboardFieldsFromAi(persistedShot,'', '16:9',{targetClipDuration:5,durationRange:{min:4,max:8}});
  assert.equal(persistedShot.duration,7,'persistence must not reset duration to the legacy fixed value');
  assert.match(range.rangeTimingInstructions({min:4,max:8}), /4–8/);
});

test('speech exceeding the maximum splits without losing words and each fragment has its own duration', async () => {
  const source={duration:5,dialogue:'甲：'+'字'.repeat(40),action:'陈述'};
  let calls=0;
  const output=await enforceStoryboardSpeechTiming([source],{durationRange:{min:4,max:8},generate:async (user,system)=>{
    calls++;
    assert.match(system,/按需规划/);
    return JSON.stringify([
      {dialogue:'甲：'+'字'.repeat(12),duration:4},
      {dialogue:'甲：'+'字'.repeat(20),duration:7},
      {dialogue:'甲：'+'字'.repeat(8),duration:4},
    ]);
  }});
  assert.equal(calls,1);
  assert.equal(preservesSpeech(source,output),true);
  assert.deepEqual(output.map(s=>s.duration),[4,7,4]);
  assert.deepEqual(output.map(s=>s.long_take_role),['head','continuation','tail']);
  assert.deepEqual(output.map(s=>s.long_take_sequence),[1,2,3]);
  assert.equal(new Set(output.map(s=>s.long_take_group_id)).size,1);
  for (const continuation of output.slice(1)) {
    assert.equal(continuation.semantic_slots.h3_mode,'fl2va');
    assert.equal(continuation.semantic_slots.first_frame_policy,'inherit_tail');
    assert.deepEqual(continuation.semantic_slots.required_references,[]);
  }
});
