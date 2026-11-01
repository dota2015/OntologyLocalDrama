const test = require('node:test');
const assert = require('node:assert/strict');
const slots = require('../src/ontology/videoSlots');
const h3 = require('../src/services/h3NativeService');

function timelineSegment(shotNumber, duration, ids) {
  return {
    shot_number: shotNumber,
    duration,
    camera: { shot_type: shotNumber === 1 ? '中景' : '反应近景', movement: shotNumber === 1 ? 'push' : 'static' },
    visible_characters: ids.map((id) => ({ character_id: id, name: id === 1 ? '甲' : '乙' })),
    action: shotNumber === 1 ? '说话者抬手施压' : '听者攥紧衣角并抬眼',
    result: shotNumber === 1 ? '手臂抬到对方肩旁' : '听者完成侧身并保持戒备',
    character_trajectories: ids.map((id) => ({
      character_id: id,
      trajectory: id === 1 ? '抬手并继续说话' : '攥紧衣角并调整重心',
      terminal_pose: '动作收束',
      facial_expression: id === 1 ? '冷笑加深' : '目光由克制转为戒备',
      facing: id === 1 ? '四分之三侧身朝向苏晚' : '四分之三侧身朝向赵虎',
      head_pose: id === 1 ? '头部微俯朝向苏晚面部' : '抬头朝向赵虎面部',
      gaze: id === 1 ? '双眼锁定苏晚眼睛' : '目光锁定赵虎眼睛',
      attention_target: id === 1 ? '苏晚面部' : '赵虎面部',
      gaze_motivation: id === 1 ? '开口施压' : '直接听取威胁',
      reaction_trigger: id === 1 ? '自己开口说话' : '赵虎开口威胁',
      mouth_state: id === 1 ? 'speaker_synced' : 'closed',
    })),
    audio_lip_sync: { mode: 'in_frame_dialogue', speaker_name: '赵虎', speaker_in_frame: true },
  };
}

test('missing timeline action feedback names the exact field without silently renaming it', () => {
  const shot = { storyboard_number: 29, duration: 5,
    semantic_slots: { h3_mode: 'ref2va', shot_duration: 5, visible_characters: [{ id: 1 }, { id: 2 }] } };
  const segment = timelineSegment(1, 5, [1, 2]);
  const character = segment.character_trajectories[0];
  character.visible_action = character.trajectory;
  delete character.trajectory;
  const video = { camera: {}, audio_lip_sync: {}, trajectories: [], environment_vfx: {}, timing: { duration: 5 }, shots_timeline: [segment] };
  const before = structuredClone(video);
  const [error] = slots.validateVideoSlots(shot, video).filter(v => v.rule === 'INVARIANT_SHORT_DRAMA_CHARACTER_REACTION_MISSING');
  assert.deepEqual(error.missing_fields, ['trajectory']);
  assert.deepEqual(error.conflict_slots, ['video_slots.shots_timeline[0].character_trajectories[character_id=1].trajectory']);
  assert.equal(error.character_id, 1);
  assert.match(error.message, /不是 visible_action/);
  assert.deepEqual(video, before);
  character.trajectory = character.visible_action;
  assert.equal(slots.validateVideoSlots(shot, video).filter(v => v.rule === 'INVARIANT_SHORT_DRAMA_CHARACTER_REACTION_MISSING').length, 0);
});

test('structural director repairs use the same typed timeline schema as initial generation', () => {
  const runtime = require('../src/services/agentsRuntime');
  const item = runtime.directorStructuralRepairOutputType(29).schema.properties.structural_repairs.prefixItems[0].properties.storyboards.items;
  const trajectory = item.properties.video_slots.properties.shots_timeline.items.properties.character_trajectories.items;
  assert.ok(trajectory.required.includes('trajectory'));
  assert.equal(trajectory.additionalProperties, false);
  assert.equal(trajectory.properties.visible_action, undefined);
  const semantic = item.properties.semantic_slots;
  assert.equal(semantic.properties.source_script_excerpt.type, 'string');
  assert.ok(semantic.required.includes('source_script_excerpt'));
  assert.equal(semantic.properties.source_script_unit_ids.type, 'array');
  for (const key of ['speech_plan', 'h3_mode', 'required_references']) {
    assert.equal(item.properties[key], undefined);
    assert.ok(semantic.properties[key]);
  }
  for (const key of ['creation_mode', 'long_take_group_id', 'long_take_sequence']) assert.ok(item.required.includes(key));
});

test('legacy Agent trajectory aliases survive deterministic compilation', () => {
  const normalized = slots.createVideoSemanticSlots({ trajectories: [{
    character_id: 2,
    name: '苏晚',
    start_anchor: '画面左侧',
    trajectory: '左臂护住身后',
    end_action: '身体封住门口',
    expression_change: '由安抚转为戒备',
  }] });
  assert.equal(normalized.trajectories[0].terminal_pose, '身体封住门口');
  assert.equal(normalized.trajectories[0].facial_expression, '由安抚转为戒备');
  const prompt = slots.compileVideoPromptFromSlots({ title: '堵门', duration: 5 }, normalized);
  assert.match(prompt, /终态姿态：身体封住门口/);
  assert.match(prompt, /面部神态：由安抚转为戒备/);
});

test('video prompt deterministically preserves static and timed eyeline contracts', () => {
  const shot = {
    title: '县衙喊冤',
    duration: 5,
    characters: [1, 2],
    character_visuals: [
      { character_id: 1, name: '苏晚', screen_position: '画面左侧前景', facing: '侧身朝右', head_pose: '头部微仰朝向赵虎', gaze: '目光锁定赵虎眼睛' },
      { character_id: 2, name: '赵虎', screen_position: '画面右侧中景', facing: '侧身朝左', head_pose: '头部微低朝向苏晚', gaze: '目光审视苏晚面部' },
    ],
  };
  const normalized = slots.createVideoSemanticSlots({
    camera: {}, audio_lip_sync: {}, environment_vfx: {}, timing: { duration: 5 },
    trajectories: timelineSegment(1, 2, [1, 2]).character_trajectories,
  });
  const prompt = slots.compileVideoPromptFromSlots(shot, normalized);
  assert.match(prompt, /角色站位与视线合同/);
  assert.match(prompt, /目光锁定赵虎眼睛/);
  assert.match(prompt, /注意对象：苏晚面部/);
  assert.match(prompt, /反应触发：赵虎开口威胁/);
});

test('H3 Director gate requires explicit timelines and character directions from every visible character', () => {
  const shot = {
    storyboard_number: 6,
    duration: 5,
    semantic_slots: { h3_mode: 'ref2va', shot_duration: 5, visible_characters: [{ id: 1 }, { id: 2 }] },
  };
  const base = {
    camera: {}, audio_lip_sync: {}, trajectories: [], environment_vfx: {}, timing: { duration: 5 },
  };
  assert.ok(slots.validateVideoSlots(shot, base).some(v => v.rule === 'INVARIANT_SHORT_DRAMA_TIMELINE_MISSING'));
  const valid = { ...base, shots_timeline: [timelineSegment(1, 2, [1, 2]), timelineSegment(2, 2, [1, 2]), timelineSegment(3, 1, [1, 2])] };
  assert.equal(slots.validateVideoSlots(shot, valid).filter(v => v.severity === 'error').length, 0);
  const missingEyeline = structuredClone(valid);
  delete missingEyeline.shots_timeline[0].character_trajectories[1].attention_target;
  assert.ok(slots.validateVideoSlots(shot, missingEyeline).some(v => v.rule === 'INVARIANT_SHORT_DRAMA_CHARACTER_REACTION_MISSING'));
  const missingFacing = structuredClone(valid);
  delete missingFacing.shots_timeline[0].character_trajectories[1].facing;
  assert.ok(slots.validateVideoSlots(shot, missingFacing).some(v => v.rule === 'INVARIANT_SHORT_DRAMA_CHARACTER_REACTION_MISSING'));
  const missingMotivation = structuredClone(valid);
  delete missingMotivation.shots_timeline[0].character_trajectories[1].gaze_motivation;
  assert.ok(slots.validateVideoSlots(shot, missingMotivation).some(v => v.rule === 'INVARIANT_SHORT_DRAMA_CHARACTER_REACTION_MISSING'));
});

test('sync_v1 rejects a dialogue segment that only holds an eye-line', () => {
  const shot = {
    storyboard_number: 31,
    duration: 4,
    semantic_slots: {
      h3_mode: 'ref2va',
      shot_duration: 4,
      visible_characters: [{ id: 1, name: '甲' }, { id: 2, name: '乙' }],
      speech_plan: { speaker_id: 1, speaker_name: '甲', text: '你来了。' },
    },
  };
  const staticTrajectory = (id, name) => ({
    character_id: id, name, trajectory: '保持姿态看着对方', terminal_pose: '保持原姿态',
    facial_expression: '平静', facing: '朝向对方', head_pose: '转向对方',
    gaze: '看向对方眼睛', attention_target: '对方', gaze_motivation: '对话',
    reaction_trigger: '对白发生', mouth_state: id === 1 ? 'speaker_synced' : 'closed',
  });
  const video = {
    performance_contract: 'sync_v1', camera: {}, trajectories: [], environment_vfx: {}, timing: { duration: 4 },
    audio_lip_sync: { mode: 'in_frame_dialogue', speaker_name: '甲', speaker_in_frame: true },
    shots_timeline: [{
      shot_number: 1, duration: 2, camera: {}, visible_characters: [{ character_id: 1, name: '甲' }, { character_id: 2, name: '乙' }], action: '两人对视', result: '对白结束后保持对视',
      character_trajectories: [staticTrajectory(1, '甲'), staticTrajectory(2, '乙')],
      audio_lip_sync: { mode: 'in_frame_dialogue', speaker_name: '甲', speaker_in_frame: true, dialogue_content: '你来了。' },
      speech_action_alignment: {
        mode: 'concurrent', speech_window: { start: 0, end: 1 }, speaker_action_window: { start: 0, end: 1 },
        speaker_action: '甲边看着乙边说话', listener_reactions: [{ character_id: 2, action_window: { start: 0, end: 1 }, action: '乙看着甲' }], pause_reason: '',
      },
    }, { shot_number: 2, duration: 2, camera: {}, action: '无意义特写', result: '继续等待', character_trajectories: [staticTrajectory(1, '甲'), staticTrajectory(2, '乙')], audio_lip_sync: { mode: 'silent_ambient', speaker_name: '', speaker_in_frame: false, dialogue_content: '' }, speech_action_alignment: { mode: 'none', speech_window: null, speaker_action_window: null, speaker_action: '', listener_reactions: [], pause_reason: '' } }],
  };
  const violations = slots.validateVideoSlots(shot, video);
  assert.ok(violations.some(v => v.rule === 'INVARIANT_SHORT_DRAMA_INTERACTION_BEAT_EMPTY'));
  assert.ok(violations.some(v => v.rule === 'INVARIANT_SHORT_DRAMA_CHARACTER_ACTION_EMPTY'));
});

test('sync_v1 requires speech and performance windows to overlap for every visible listener', () => {
  const shot = {
    storyboard_number: 22,
    duration: 5,
    semantic_slots: {
      h3_mode: 'ref2va', shot_duration: 5,
      visible_characters: [{ id: 1, name: '红狼' }, { id: 2, name: '露娜' }],
      speech_plan: { speaker_id: 1, speaker_name: '红狼', text: '哪条是备用路线？' },
    },
  };
  const base = {
    performance_contract: 'sync_v1',
    camera: {}, trajectories: [], environment_vfx: {}, timing: { duration: 5 },
    audio_lip_sync: { mode: 'in_frame_dialogue', speaker_name: '红狼', speaker_in_frame: true },
    shots_timeline: [{
      shot_number: 1, duration: 2, camera: {}, visible_characters: [{ character_id: 1, name: '红狼' }, { character_id: 2, name: '露娜' }], action: '对话', result: '转身完成',
      character_trajectories: [
        { character_id: 1, trajectory: '转身询问', terminal_pose: '面向露娜', facial_expression: '焦急', facing: '朝向露娜', head_pose: '转向露娜', gaze: '看向露娜', attention_target: '露娜', gaze_motivation: '求助', reaction_trigger: '开口', mouth_state: 'speaker_synced' },
        { character_id: 2, trajectory: '抬眼并侧身听取', terminal_pose: '注视红狼', facial_expression: '专注', facing: '朝向红狼', head_pose: '转向红狼', gaze: '看向红狼', attention_target: '红狼', gaze_motivation: '听取问题', reaction_trigger: '红狼开口', mouth_state: '闭唇' },
      ],
      audio_lip_sync: { mode: 'in_frame_dialogue', speaker_name: '红狼', speaker_in_frame: true, dialogue_content: '哪条是备用路线？', lip_sync_rule: '同步' },
      speech_action_alignment: {
        mode: 'concurrent', speech_window: { start: 0, end: 2 }, speaker_action_window: { start: 0, end: 2 }, speaker_action: '红狼边转身边询问',
        listener_reactions: [{ character_id: 2, action_window: { start: 0, end: 2 }, action: '露娜边听边抬眼锁定红狼' }], pause_reason: '',
      },
    }],
  };
  base.shots_timeline.push(
    { ...structuredClone(base.shots_timeline[0]), shot_number: 2, timestamp: '00:02.000', duration: 2, audio_lip_sync: { ...base.shots_timeline[0].audio_lip_sync, dialogue_content: '' }, speech_action_alignment: { mode: 'none', speech_window: null, speaker_action_window: null, speaker_action: '', listener_reactions: [], pause_reason: '' } },
    { ...structuredClone(base.shots_timeline[0]), shot_number: 3, timestamp: '00:04.000', duration: 1, audio_lip_sync: { ...base.shots_timeline[0].audio_lip_sync, dialogue_content: '' }, speech_action_alignment: { mode: 'none', speech_window: null, speaker_action_window: null, speaker_action: '', listener_reactions: [], pause_reason: '' } },
  );
  assert.equal(slots.validateVideoSlots(shot, base).filter(v => v.severity === 'error').length, 0);
  const noOverlap = structuredClone(base);
  noOverlap.shots_timeline[0].speech_action_alignment.speaker_action_window = { start: 2, end: 5 };
  assert.ok(slots.validateVideoSlots(shot, noOverlap).some(v => v.rule === 'INVARIANT_SPEECH_ACTION_OVERLAP_MISSING'));
  const noListener = structuredClone(base);
  noListener.shots_timeline[0].speech_action_alignment.listener_reactions = [];
  assert.ok(slots.validateVideoSlots(shot, noListener).some(v => v.rule === 'INVARIANT_LISTENER_REACTION_OVERLAP_MISSING'));
});

test('timeline validates only the characters visible in each local shot segment', () => {
  const shot = {
    storyboard_number: 44,
    duration: 4,
    semantic_slots: {
      h3_mode: 'ref2va',
      shot_duration: 4,
      visible_characters: [{ id: 1, name: '赵虎' }, { id: 2, name: '沈清岚' }],
    },
  };
  const closeup = timelineSegment(1, 2, [1]);
  closeup.visible_characters = [{ character_id: 1, name: '赵虎' }];
  const twoShot = timelineSegment(2, 2, [1, 2]);
  twoShot.timestamp = '00:02.000';
  twoShot.visible_characters = [{ character_id: 1, name: '赵虎' }, { character_id: 2, name: '沈清岚' }];
  const video = {
    performance_contract: 'sync_v1', camera: {}, trajectories: [], environment_vfx: {}, timing: { duration: 4 },
    audio_lip_sync: {}, shots_timeline: [closeup, twoShot],
  };
  const validViolations = slots.validateVideoSlots(shot, video);
  assert.equal(validViolations.filter(v => ['INVARIANT_SHORT_DRAMA_VISIBLE_CHARACTERS_MISSING', 'INVARIANT_SHORT_DRAMA_TRAJECTORY_NOT_VISIBLE'].includes(v.rule)).length, 0);

  const invalid = structuredClone(video);
  invalid.shots_timeline[0].character_trajectories.push({ ...timelineSegment(1, 2, [2]).character_trajectories[0], name: '沈清岚' });
  assert.ok(slots.validateVideoSlots(shot, invalid).some(v => v.rule === 'INVARIANT_SHORT_DRAMA_TRAJECTORY_NOT_VISIBLE'));
});

test('compiled H3 prompt states that speech and movement overlap', () => {
  const timeline = [{
    shot_number: 1, duration: 5, camera: { shot_type: '中景', movement: 'push' }, action: '转身', result: '保持对视',
    character_trajectories: [],
    audio_lip_sync: { mode: 'in_frame_dialogue', speaker_name: '红狼', speaker_in_frame: true, dialogue_content: '哪条路？' },
    speech_action_alignment: { mode: 'concurrent', speech_window: { start: 0, end: 2 }, speaker_action_window: { start: 0, end: 3 }, speaker_action: '边转身边抬手指向北侧通道', listener_reactions: [{ character_id: 2, action_window: { start: 0, end: 2 }, action: '边听边抬眼看向红狼' }] },
  }];
  const normalized = slots.createVideoSemanticSlots({ performance_contract: 'sync_v1', camera: {}, audio_lip_sync: {}, trajectories: [], environment_vfx: {}, timing: { duration: 5 }, shots_timeline: timeline });
  const prompt = slots.compileVideoPromptFromSlots({ duration: 5, action: '询问路线' }, normalized);
  assert.match(prompt, /同步视听事件/);
  assert.match(prompt, /边转身边抬手指向北侧通道/);
});

test('legacy video slots stay readable until regenerated under sync_v1', () => {
  const shot = { storyboard_number: 1, duration: 5, semantic_slots: { h3_mode: 'ref2va', shot_duration: 5, visible_characters: [{ id: 1 }] } };
  const legacy = { timing: { duration: 5 }, audio_lip_sync: { dialogue_content: '你好', speaker_in_frame: true }, shots_timeline: [{ duration: 5, audio_lip_sync: { dialogue_content: '你好', speaker_in_frame: true }, character_trajectories: [{ character_id: 1, trajectory: '说话', terminal_pose: '站定', facial_expression: '平静', facing: '正面', head_pose: '抬头', gaze: '看前方', attention_target: '前方', gaze_motivation: '说话', reaction_trigger: '开口' }] }] };
  assert.equal(slots.validateVideoSlots(shot, legacy).some(v => v.rule === 'INVARIANT_SPEECH_ACTION_OVERLAP_MISSING'), false);
});

test('H3 prompt executes the Agent timeline and uses the full declared speech window', () => {
  const refs = [
    { source: 'speaker.png', kind: 'character', character_id: 1 },
    { source: 'listener.png', kind: 'character', character_id: 2 },
  ];
  const speech = {
    narrative_style: { speech_rate: 1.3 },
    references: [{ key: 'character:1', kind: 'dialogue' }],
    lines: [{ key: 'character:1', kind: 'dialogue', text: '这棚子姓赵。想住，就把口粮留下。' }],
    soundtrack: { events: [{ start_seconds: 0.5, end_seconds: 5.5 }] },
  };
  const timeline = [
    { ...timelineSegment(1, 2, [1, 2]), timestamp: null },
    { ...timelineSegment(2, 2, [1, 2]), timestamp: '00:02.000' },
    { ...timelineSegment(3, 2, [1, 2]), timestamp: '00:04.000' },
    { ...timelineSegment(4, 2, [1, 2]), timestamp: '00:06.000' },
  ];
  const translated = {
    visual_description: 'A tense confrontation unfolds at a shelter entrance.',
    shot_descriptions: timeline.map((_, index) => ({
      shot_number: index + 1,
      description: `The characters perform distinct physical reactions in edit beat ${index + 1}.`,
      character_directions: [
        { character_id: 1, direction: 'turns his head toward the listener and fixes both eyes on her face after beginning the threat.' },
        { character_id: 2, direction: 'raises her head toward the speaker and fixes both eyes on his face in direct response.' },
      ],
    })),
    overall_soundscape: 'Dry wind and footsteps move through the shelter entrance.',
    non_diegetic_music: 'N/A',
  };
  const prompt = h3.compilePrompt(refs, speech, translated, {}, {
    timeline,
    duration: 8,
    delivery: { end_reserve_seconds: 1.5 },
  });
  assert.match(prompt, /A 4-shot edit/);
  assert.match(prompt, /\[Shot 2\] At 00:02\.000/);
  assert.match(prompt, /complete every final word by second 8\.0/);
  assert.equal((prompt.match(/<scenetrans>/g) || []).length, 4, 'only the 2s and 4s cuts crossed by the utterance get paired transition markers');
  assert.equal((prompt.match(/这棚子姓赵。想住，就把口粮留下。/g) || []).length, 1);
  assert.match(prompt, /Character direction/);
  assert.match(prompt, /<Subject 1> turns his head toward the listener/);
  assert.doesNotMatch(prompt.replace(/<d>.*?<\/d>/gs, ''), /\b(no|not|without|avoid|never)\b/i);
});

test('Ref2VA does not claim speech crosses every cut when no exact event timing exists', () => {
  const refs = [{ source: 'speaker.png', kind: 'character', character_id: 1 }];
  const speech = {
    references: [{ key: 'character:1', kind: 'dialogue' }],
    lines: [{ key: 'character:1', kind: 'dialogue', text: '马上出发。' }],
  };
  const timeline = [
    { ...timelineSegment(1, 2, [1]), timestamp: null },
    { ...timelineSegment(2, 2, [1]), timestamp: '00:02.000' },
  ];
  const translated = {
    visual_description: 'A young scout prepares to leave.',
    shot_descriptions: timeline.map((_, index) => ({
      shot_number: index + 1,
      description: `The scout completes physical beat ${index + 1}.`,
      character_directions: [{ character_id: 1, direction: 'The scout watches the exit.' }],
    })),
    overall_soundscape: 'Quiet room tone.',
    non_diegetic_music: 'N/A',
  };
  const prompt = h3.compilePrompt(refs, speech, translated, {}, { timeline, duration: 4 });
  assert.equal((prompt.match(/<scenetrans>/g) || []).length, 0);
  assert.equal((prompt.match(/马上出发。/g) || []).length, 1);
  assert.doesNotMatch(prompt, /ongoing spoken performance/);
});

test('FL2VA executes the same Agent-owned short-drama timeline', () => {
  const timeline = [
    { ...timelineSegment(1, 2, [1, 2]), timestamp: null },
    { ...timelineSegment(2, 2, [1, 2]), timestamp: '00:02.000' },
  ];
  const prompt = h3.compileFl2vaPrompt({
    visual_description: 'Two characters confront each other at a shelter entrance.',
    shot_descriptions: [
      { shot_number: 1, description: 'The speaker steps forward while the listener braces and narrows her eyes.', character_directions: [
        { character_id: 1, direction: 'The standing speaker looks into the listener face.' },
        { character_id: 2, direction: 'The listener looks back into the speaker face.' },
      ] },
      { shot_number: 2, description: 'The view cuts closer as both characters shift their weight and exchange tense reactions.', character_directions: [
        { character_id: 1, direction: 'The standing speaker maintains eye contact with the listener.' },
        { character_id: 2, direction: 'The listener keeps her eyes on the speaker face.' },
      ] },
    ],
    overall_soundscape: 'Dry wind moves across the shelter entrance.',
    non_diegetic_music: 'N/A',
  }, timeline);
  assert.match(prompt, /^integrated_multimodal_description:/);
  assert.match(prompt, /\[Shot 1\]/);
  assert.match(prompt, /\[Shot 2\] At 00:02\.000/);
  assert.match(prompt, /overall_soundscape:/);
  assert.match(prompt, /listener looks back into the speaker face/);
});

test('runtime H3 compilation uses authoritative Chinese text without a second model rewrite', () => {
  const timeline = [{
    ...timelineSegment(1, 2, [28, 29]),
    timestamp: null,
    character_trajectories: [
      {
        character_id: 28,
        name: '苏晚',
        trajectory: '迅速俯身托住父亲肩背',
        terminal_pose: '右掌贴住父亲胸口',
        facial_expression: '眼睛睁大，眉头收紧',
        facing: '正对苏承远',
        head_pose: '下颌压低并朝向父亲嘴角',
        gaze: '视线锁定苏承远嘴角血迹',
        attention_target: '苏承远嘴角血迹',
        gaze_motivation: '确认父亲伤势',
        reaction_trigger: '苏承远突然咳血',
        mouth_state: '双唇紧闭',
      },
      {
        character_id: 29,
        name: '苏承远',
        trajectory: '咳血后身体失力',
        terminal_pose: '肩背落入苏晚臂弯',
        facial_expression: '痛苦虚弱',
        facing: '侧身朝向苏晚',
        head_pose: '头部低垂',
        gaze: '目光失焦',
        attention_target: '无稳定目标',
        gaze_motivation: '高热导致意识涣散',
        reaction_trigger: '自身突然咳血',
        mouth_state: '双唇紧闭',
      },
    ],
  }];
  const contract = h3.buildDirectH3TextContract({
    location: '苏家破败窝棚内部',
    description: '苏承远突然咳血，苏晚立即托扶',
    action: '苏晚右掌按上父亲胸口',
    semantic_slots: JSON.stringify({ sound_plan: { sound_effects: ['咳嗽声'], bgm_prompt: '低沉弦乐' } }),
    character_visuals: JSON.stringify([{ character_id: 28, name: '苏晚', gaze: '视线锁定苏承远嘴角血迹' }]),
  }, timeline);
  assert.equal(contract.shot_descriptions.length, 1);
  assert.deepEqual(contract.shot_descriptions[0].character_directions.map(item => item.character_id), [28, 29]);
  assert.match(contract.shot_descriptions[0].character_directions[0].direction, /视线锁定苏承远嘴角血迹/);
  const prompt = h3.compileFl2vaPrompt(contract, timeline, { allowChinese: true });
  assert.match(prompt, /苏家破败窝棚内部/);
  assert.match(prompt, /视线锁定苏承远嘴角血迹/);
  assert.match(prompt, /低沉弦乐/);
});

test('silent ambient H3 contract seals every mouth and requests only nonverbal sound', () => {
  const timeline = [{
    ...timelineSegment(1, 2, [1]),
    timestamp: null,
    character_trajectories: [{
      character_id: 1,
      name: '红狼',
      trajectory: '贴墙移动',
      terminal_pose: '停在掩体后',
      facial_expression: '屏息警觉',
      facing: '侧身朝向通道',
      head_pose: '头部转向通道口',
      gaze: '目光锁定通道口',
      attention_target: '通道口',
      gaze_motivation: '确认敌情',
      reaction_trigger: '远处脚步声',
      mouth_state: '双唇紧闭无口型',
    }],
  }];
  const contract = h3.buildDirectH3TextContract({
    location: '废弃仓库',
    action: '红狼贴墙移动',
    semantic_slots: {
      audio_lip_sync: 'silent_ambient',
      speech_plan: { text: '' },
      sound_plan: { is_silent: false, sound_effects: ['远处脚步声'], acoustic_env: '空旷仓库回声', bgm_prompt: '' },
    },
    video_slots: { audio_lip_sync: { mode: 'silent_ambient', dialogue_content: '' } },
  }, timeline);
  assert.match(contract.visual_description, /双唇自然闭合/);
  assert.match(contract.overall_soundscape, /环境声和物理动作音效/);
  assert.match(contract.overall_soundscape, /远处脚步声/);
  assert.equal(contract.non_diegetic_music, 'N/A');
  const prompt = h3.compileFl2vaPrompt(contract, timeline, { allowChinese: true, speech: { lines: [] } });
  assert.doesNotMatch(prompt, /<d>/);
  assert.match(prompt, /双唇自然闭合/);
});
