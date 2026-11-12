const test = require('node:test');
const assert = require('node:assert/strict');
const plan = require('../src/services/storyboardImagePlan');
const frames = require('../src/services/framePromptService');
const videoSlots = require('../src/ontology/videoSlots');
const h3Stage3 = require('../src/services/h3Stage3PromptService');
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

test('Stage 3 H3 spec leaves physical actions and spoken lines under Director control without leaking Stage 1 description', () => {
  const fixture = qualityShots.find(f => f.name === 'continuous_action');
  const speech = {
    references: [{ key: 'narrator', kind: 'narration' }],
    lines: [{ key: 'narrator', kind: 'narration', text: '她放下了碗。' }],
  };
  const spec = h3Stage3.buildStage3PromptSpec(null, {
    ...fixture.shot,
    description: '【运镜】wrong_stage1_movement',
    video_slots: { shots_timeline: [fixture.segment] },
  }, { refs: fixture.refs, speech, duration: 6 });
  assert.equal(spec.authoritative_contract.video_slots.shots_timeline.length, 1);
  assert.equal(spec.spoken_lines[0].text, '她放下了碗。');
  assert.equal(JSON.stringify(spec).includes('wrong_stage1_movement'), false);
});

test('Stage 3 H3 validator enforces verbatim spoken lines and rejects leaked Chinese prose', () => {
  const fixture = structuredClone(qualityShots.find(f => f.name === 'solo_dialogue'));
  fixture.speech.lines[0].text = '明天我扶您出去。';
  const spec = h3Stage3.buildStage3PromptSpec(null, {
    ...fixture.shot,
    video_slots: { shots_timeline: [fixture.segment] },
  }, { refs: fixture.refs, speech: fixture.speech, duration: 6 });

  const picDefs = fixture.refs.map((_, idx) => `<Subject ${idx + 1}> is the character in <Picture ${idx + 1}>.`).join('\n');
  const validPrompt = `subject_definitions:\n${picDefs}\n<Audio 1> is the voice-timbre reference for <Subject 1> (S1).\n\nsummary:\n[reference generation + audio reference] <Subject 1> speaks gently in the room using <Audio 1>.\n\nretention_analysis:\n<Subject 1> (appears in [Shot 1]): fully_preserved - appearance retained.\n<Audio 1>: reference - vocal timbre only.\n\ndetailed_description:\nThe scene uses natural indoor lighting.\n[Shot 1] <Subject 1> (S1) leans softly beside the wooden bed, using the timbre from <Audio 1>, and says, <d>[Chinese] 明天我扶您出去。</d> Another character listens attentively without rising.\n\noverall_soundscape:\nQuiet indoor room tone.\n\nnon_diegetic_music:\nN/A`;
  assert.deepEqual(h3Stage3.validateOfficialH3Prompt(validPrompt, spec).errors, []);

  const leakedChinese = validPrompt.replace('leans softly beside the wooden bed', '轻声扶着床沿');
  const bad = h3Stage3.validateOfficialH3Prompt(leakedChinese, spec);
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.some((e) => e.includes('残留汉字')));
});
