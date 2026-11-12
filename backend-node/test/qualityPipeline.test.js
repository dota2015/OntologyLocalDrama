const test = require('node:test');
const assert = require('node:assert/strict');
const plan = require('../src/services/storyboardImagePlan');
const frames = require('../src/services/framePromptService');
const videoSlots = require('../src/ontology/videoSlots');
const h3 = require('../src/services/h3NativeService');
const qualityShots = require('./fixtures/qualityShots');

const visual = {
  character_id: 1, name: '苏晚', depth_layer: 'midground', screen_position: 'left_midground',
  environmental_anchor: '床沿', facing: 'three_quarter_right', facing_target_id: null,
  head_pose: 'tilted_down', gaze_type: 'character', gaze_target_id: null, gaze_target_label: '父亲嘴角',
  posture: 'kneeling', hands_state: 'supporting_target', hands_object_id: null, hands_target_id: null,
  expression: 'worried', expression_detail: '担忧', appearance_details: '朴素衣衫',
};
test('planned frame bypasses LLM rewriting, preserves eyeline and uses distinct end state', async () => {
  const shot = { semantic_slots: { visible_characters: [{ id: 1 }] }, character_visuals: [visual], last_frame_visuals: [{ ...visual, head_pose: 'tilted_up', gaze_target_label: '父亲双眼' }], location: '床边' };
  // No database/model client is supplied: a planned static frame needs neither.
  const first = await frames.generateSingleFrameExported(null, null, {}, shot, null, [], null, 'first');
  const last = await frames.generateSingleFrameExported(null, null, {}, shot, null, [], null, 'last');
  assert.match(first.prompt, /注视角色：父亲嘴角/);
  assert.match(last.prompt, /注视角色：父亲双眼/);
  assert.doesNotMatch(last.prompt, /父亲嘴角/);
  assert.doesNotMatch(first.prompt, /85mm|50mm|不得|严禁|克隆|<image/);
  assert.throws(() => plan.compileFrame({ ...shot, character_visuals: [] }, null, 'first'), /槽位缺失/);
});

test('voiceover and non-timeline speech also leave physical actions under Director control', () => {
  const fixture = qualityShots.find(f => f.name === 'continuous_action');
  const contract = h3.buildDirectH3TextContract(fixture.shot, [fixture.segment]);
  const speech = {
    references: [{ key: 'narrator', kind: 'narration' }],
    lines: [{ key: 'narrator', kind: 'narration', text: '她放下了碗。' }],
  };
  for (const timeline of [[], [fixture.segment]]) {
    const prompt = h3.compilePrompt(fixture.refs, speech, contract, {}, { timeline, duration: 6, allowChinese: true });
    assert.match(prompt, /visible characters continue their planned actions and reactions/);
    assert.match(prompt, /their lips stay closed except during their own explicitly planned spoken lines/);
    assert.doesNotMatch(prompt, /settles|settling|terminal state holds/);
    assert.match(prompt, /放到木桌中央/);
  }
});

test('a future promise does not cause the compiler to invent an immediate action', () => {
  const fixture = structuredClone(qualityShots.find(f => f.name === 'solo_dialogue'));
  fixture.speech.lines[0].text = '明天我扶您出去。';
  const before = JSON.stringify(fixture);
  const timeline = [fixture.segment];
  const prompt = h3.compilePrompt(fixture.refs, fixture.speech, h3.buildDirectH3TextContract(fixture.shot, timeline), {}, { timeline, duration: 6, allowChinese: true });
  assert.equal(JSON.stringify(fixture), before);
  assert.match(prompt, /苏晚倾听/);
  assert.match(prompt, /<d>\[Chinese\] 明天我扶您出去。<\/d>/);
  assert.doesNotMatch(prompt, /托肩背|撑床|转为坐姿|推门走出/);
});
