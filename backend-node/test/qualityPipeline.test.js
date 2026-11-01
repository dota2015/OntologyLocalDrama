const test = require('node:test');
const assert = require('node:assert/strict');
const plan = require('../src/services/storyboardImagePlan');
const frames = require('../src/services/framePromptService');
const videoSlots = require('../src/ontology/videoSlots');
const h3 = require('../src/services/h3NativeService');
const qualityShots = require('./fixtures/qualityShots');

const visual = { character_id: 1, name: '苏晚', screen_position: '画面左侧', facing: '身体朝右', head_pose: '头部低向父亲', gaze: '注视父亲嘴角', posture: '左膝跪地', hands: '右手托肩', expression: '担忧' };
test('planned frame bypasses LLM rewriting, preserves eyeline and uses distinct end state', async () => {
  const shot = { semantic_slots: { visible_characters: [{ id: 1 }] }, character_visuals: [visual], last_frame_visuals: [{ ...visual, head_pose: '抬头望父亲', gaze: '注视父亲双眼' }], location: '床边' };
  // No database/model client is supplied: a planned static frame needs neither.
  const first = await frames.generateSingleFrameExported(null, null, {}, shot, null, [], null, 'first');
  const last = await frames.generateSingleFrameExported(null, null, {}, shot, null, [], null, 'last');
  assert.match(first.prompt, /注视父亲嘴角/);
  assert.match(last.prompt, /注视父亲双眼/);
  assert.doesNotMatch(last.prompt, /注视父亲嘴角/);
  assert.doesNotMatch(first.prompt, /85mm|50mm|不得|严禁|克隆|<image/);
  assert.throws(() => plan.compileFrame({ ...shot, character_visuals: [] }, null, 'first'), /槽位缺失/);
});

test('continuous static dialogue and quiet listening are valid for every 4–8 second duration', () => {
  for (let duration = 4; duration <= 8; duration++) {
    const character = { ...visual, start_anchor: visual.screen_position, trajectory: '保持姿态安静倾听', terminal_pose: '保持跪姿', facial_expression: '眉头微皱', attention_target: '父亲', gaze_motivation: '关注病情', reaction_trigger: '听父亲说话', mouth_state: 'strictly_sealed' };
    const segment = { shot_number: 1, duration, camera: { movement: 'static', shot_type: '中景' }, action: '父亲与女儿对话', result: '女儿听完', character_trajectories: [character] };
    const shot = { duration, location: '床边', character_visuals: [visual], semantic_slots: { h3_mode: 'ref2va', shot_duration: duration, visible_characters: [{ id: 1 }] } };
    const slots = { timing: { duration }, audio_lip_sync: {}, shots_timeline: [segment] };
    assert.deepEqual(videoSlots.validateVideoSlots(shot, slots).filter(v => v.severity === 'error'), []);
    const contract = h3.buildDirectH3TextContract(shot, [segment]);
    const prompt = h3.compilePrompt([{ character_id: 1, source: 'card', kind: 'character' }], { references: [], lines: [] }, contract, {}, { timeline: [segment], duration, allowChinese: true });
    assert.match(prompt, /single continuous shot/);
    assert.match(prompt, /安静倾听/);
    assert.doesNotMatch(prompt, /camera cuts|remain physically active|concurrent with physical movement/);
    assert.ok(videoSlots.validateVideoSlots(shot, { ...slots, timing: { duration: duration + 0.1 } }).some(v => v.severity === 'error'));
    const bad = { ...slots, shots_timeline: [{ ...segment, duration: duration + 0.5 }] };
    assert.ok(videoSlots.validateVideoSlots(shot, bad).some(v => v.rule === 'INVARIANT_SHORT_DRAMA_TIMELINE_DURATION'));
  }
});

test('a line finishing at 3s preserves the assisted rise through the 6s ending', () => {
  const fixture = structuredClone(qualityShots.find(f => f.name === 'two_person_eyeline'));
  fixture.speech.soundtrack = { events: [{ start_seconds: 0, end_seconds: 3 }] };
  const before = JSON.stringify(fixture);
  const timeline = [fixture.segment];
  const contract = h3.buildDirectH3TextContract(fixture.shot, timeline);
  const prompt = h3.compilePrompt(fixture.refs, fixture.speech, contract, {}, { timeline, duration: 6, allowChinese: true });
  assert.equal(JSON.stringify(fixture), before, 'compilation must not rewrite the planned actions');
  assert.match(prompt, /from second 0\.00 through second 3\.00/);
  assert.match(prompt, /complete every final word by second 6\.0/);
  assert.match(prompt, /use all remaining planned time for the ongoing action or reaction/);
  assert.match(prompt, /stops speaking until their next planned line and continues the planned actions/);
  assert.match(prompt, /3至5秒苏晚扶父亲由半躺转为坐姿/);
  assert.match(prompt, /5至6秒父亲坐稳/);
  assert.match(prompt, /终态：坐稳床沿，上身直立/);
  assert.match(prompt, /single continuous shot/);
  assert.doesNotMatch(prompt, /speaker settles|closed-mouth settling|terminal state holds|camera cuts|保持姿态安静倾听/);
  assert.deepEqual([...prompt.matchAll(/<d>\[Chinese\] (.*?)<\/d>/g)].map(m => m[1]), ['爹，我扶您起来。']);
  assert.match(plan.compileFrame(fixture.shot, null, 'last'), /坐稳床沿，上身直立/);
  assert.doesNotMatch(plan.compileFrame(fixture.shot, null, 'last'), /半躺/);
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
  assert.match(prompt, /保持姿态安静倾听/);
  assert.match(prompt, /<d>\[Chinese\] 明天我扶您出去。<\/d>/);
  assert.doesNotMatch(prompt, /托肩背|撑床|转为坐姿|推门走出/);
});
