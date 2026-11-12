const test = require('node:test');
const assert = require('node:assert/strict');
const slots = require('../src/ontology/videoSlots');
const h3 = require('../src/services/h3NativeService');

function timelineSegment(shotNumber, duration, ids) {
  return {
    shot_number: shotNumber,
    duration,
    camera: { shot_type: shotNumber === 1 ? '中景' : '反应近景', movement: shotNumber === 1 ? 'push' : 'static', movement_description: '稳定跟踪' },
    visible_characters: ids.map((id) => ({ character_id: id, name: id === 1 ? '甲' : (id === 28 ? '苏晚' : '乙') })),
    action: shotNumber === 1 ? '说话者抬手施压' : '听者攥紧衣角并抬眼',
    result: shotNumber === 1 ? '手臂抬到对方肩旁' : '听者完成侧身并保持戒备',
    character_trajectories: ids.map((id) => ({
      character_id: id,
      name: id === 1 ? '赵虎' : (id === 28 ? '苏晚' : '苏承远'),
      start_state: 'standing',
      action_atom: {
        action: id === 1 ? 'point' : 'react',
        action_detail: id === 1 ? '抬手并继续说话' : '攥紧衣角并调整重心',
        body_part: id === 1 ? 'right_hand' : 'whole_body',
        object_id: null,
        target_type: 'character',
        target_id: id === 1 ? 2 : 1,
        target_label: id === 1 ? '苏晚面部' : '赵虎面部',
        direction: 'toward_target',
        contact: 'none',
      },
      result_state: 'turned_to_target',
      reaction_trigger: { type: 'dialogue', source_id: 1, source_label: id === 1 ? '自己开口说话' : '赵虎开口威胁' },
      facing: 'toward_character',
      facing_target_id: id === 1 ? 2 : 1,
      head_pose: 'turned_to_target',
      gaze_type: 'character',
      gaze_target_id: id === 1 ? 2 : 1,
      gaze_target_label: id === 1 ? '苏晚眼睛' : '赵虎眼睛',
      posture: 'standing',
      hands_state: id === 1 ? 'pointing' : 'clenched',
      hands_object_id: null,
      hands_target_id: null,
      expression: id === 1 ? 'angry' : 'alert',
      expression_detail: id === 1 ? '冷笑加深' : '目光由克制转为戒备',
      mouth_state: id === 1 ? 'speaker_synced' : 'closed',
    })),
    audio_lip_sync: { mode: 'in_frame_dialogue', speaker_name: '赵虎', speaker_in_frame: true },
  };
}

test('missing timeline action_atom feedback names the exact structured field', () => {
  const shot = { storyboard_number: 29, duration: 5,
    semantic_slots: { h3_mode: 'ref2va', shot_duration: 5, visible_characters: [{ id: 1 }, { id: 2 }] } };
  const segment = timelineSegment(1, 5, [1, 2]);
  const character = segment.character_trajectories[0];
  delete character.action_atom;
  const video = { performance_contract: 'structured_sync', camera: {}, audio_lip_sync: {}, trajectories: [], environment_vfx: {}, timing: { duration: 5 }, shots_timeline: [segment] };
  const [error] = slots.validateVideoSlots(shot, video).filter(v => v.rule === 'INVARIANT_SHORT_DRAMA_CHARACTER_REACTION_MISSING');
  assert.ok(error.missing_fields.includes('action_atom'));
  assert.ok(error.conflict_slots.includes('video_slots.shots_timeline[0].character_trajectories[character_id=1].action_atom'));
  assert.equal(error.character_id, 1);
  assert.match(error.message, /action_atom/);
  segment.character_trajectories[0].action_atom = timelineSegment(1, 5, [1, 2]).character_trajectories[0].action_atom;
  assert.equal(slots.validateVideoSlots(shot, video).filter(v => v.rule === 'INVARIANT_SHORT_DRAMA_CHARACTER_REACTION_MISSING').length, 0);
});

test('structural director repairs use compact patches over the original shot', () => {
  const runtime = require('../src/services/agentsRuntime');
  const item = runtime.directorStructuralRepairOutputType(29).schema.properties.structural_repairs.prefixItems[0].properties.storyboards.items;
  const semantic = item.properties.semantic_slots;
  assert.equal(semantic.properties.source_script_excerpt.type, 'string');
  assert.ok(semantic.required.includes('source_script_excerpt'));
  assert.equal(semantic.properties.source_script_unit_ids.type, 'array');
  assert.ok(item.required.includes('video_slots'));
  assert.ok(item.required.includes('duration'));
  assert.equal(item.properties.video_slots.additionalProperties, false);
  assert.equal(item.properties.character_visuals, undefined);
});

test('structured trajectory compiles deterministically into natural language', () => {
  const normalized = slots.createVideoSemanticSlots({
    performance_contract: 'structured_sync',
    trajectories: [{
      character_id: 2,
      name: '苏晚',
      start_state: 'standing',
      action_atom: {
        action: 'block',
        action_detail: '左臂护住身后并封住门口',
        body_part: 'left_arm',
        object_id: null,
        target_type: 'scene',
        target_id: null,
        target_label: '门口',
        direction: 'none',
        contact: 'none',
      },
      result_state: 'standing_alert',
      reaction_trigger: { type: 'character_action', source_id: null, source_label: '门外脚步声' },
      facing: 'front_camera',
      facing_target_id: null,
      head_pose: 'neutral',
      gaze_type: 'scene',
      gaze_target_id: null,
      gaze_target_label: '门口方向',
      posture: 'standing',
      hands_state: 'free',
      hands_object_id: null,
      hands_target_id: null,
      expression: 'alert',
      expression_detail: '由安抚转为戒备',
      mouth_state: 'closed',
    }],
  });
  const prompt = slots.compileVideoPromptFromSlots({ title: '堵门', duration: 5 }, normalized);
  assert.match(prompt, /苏晚挡住门口/);
  assert.match(prompt, /由安抚转为戒备/);
});

test('video prompt deterministically preserves static and timed eyeline contracts', () => {
  const shot = {
    title: '县衙喊冤',
    duration: 5,
    characters: [1, 2],
    character_visuals: [
      {
        character_id: 1, name: '苏晚', depth_layer: 'foreground', screen_position: 'left_foreground',
        environmental_anchor: '堂下', facing: 'three_quarter_right', facing_target_id: 2,
        head_pose: 'tilted_up', gaze_type: 'character', gaze_target_id: 2, gaze_target_label: '赵虎眼睛',
        posture: 'kneeling', hands_state: 'clenched', expression: 'determined',
      },
      {
        character_id: 2, name: '赵虎', depth_layer: 'midground', screen_position: 'right_midground',
        environmental_anchor: '案前', facing: 'three_quarter_left', facing_target_id: 1,
        head_pose: 'tilted_down', gaze_type: 'character', gaze_target_id: 1, gaze_target_label: '苏晚面部',
        posture: 'standing', hands_state: 'on_surface', expression: 'alert',
      },
    ],
  };
  const normalized = slots.createVideoSemanticSlots({
    performance_contract: 'structured_sync',
    camera: {}, audio_lip_sync: {}, environment_vfx: {}, timing: { duration: 5 },
    trajectories: timelineSegment(1, 2, [1, 2]).character_trajectories,
  });
  const prompt = slots.compileVideoPromptFromSlots(shot, normalized);
  assert.match(prompt, /角色站位与视线合同/);
  assert.match(prompt, /赵虎眼睛/);
  assert.match(prompt, /苏晚面部/);
  assert.match(prompt, /赵虎开口威胁|赵虎指向苏晚面部/);
});

test('structured_sync rejects a dialogue segment that only holds an eye-line', () => {
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
    character_id: id, name,
    start_state: 'standing',
    action_atom: { action: 'look', action_detail: '保持姿态看着对方', body_part: 'eyes', object_id: null, target_type: 'character', target_id: id === 1 ? 2 : 1, target_label: '对方', direction: 'toward_target', contact: 'none' },
    result_state: 'standing',
    reaction_trigger: { type: 'dialogue', source_id: 1, source_label: '对白发生' },
    facing: 'toward_character', facing_target_id: id === 1 ? 2 : 1,
    head_pose: 'turned_to_target', gaze_type: 'character', gaze_target_id: id === 1 ? 2 : 1, gaze_target_label: '对方眼睛',
    posture: 'standing', hands_state: 'relaxed', hands_object_id: null, hands_target_id: null,
    expression: 'neutral', expression_detail: '平静',
    mouth_state: id === 1 ? 'speaker_synced' : 'closed',
  });
  const video = {
    performance_contract: 'structured_sync', camera: {}, trajectories: [], environment_vfx: {}, timing: { duration: 4 },
    audio_lip_sync: { mode: 'in_frame_dialogue', speaker_name: '甲', speaker_in_frame: true },
    shots_timeline: [{
      shot_number: 1, duration: 2, camera: {}, visible_characters: [{ character_id: 1, name: '甲' }, { character_id: 2, name: '乙' }], action: '两人对视', result: '对白结束后保持对视',
      character_trajectories: [staticTrajectory(1, '甲'), staticTrajectory(2, '乙')],
      audio_lip_sync: { mode: 'in_frame_dialogue', speaker_name: '甲', speaker_in_frame: true, dialogue_content: '你来了。' },
      speech_action_alignment: {
        mode: 'concurrent', speech_window: { start: 0, end: 1 }, speaker_action_window: { start: 0, end: 1 },
        speaker_action: '甲边看着乙边说话', listener_reactions: [{ character_id: 2, action_window: { start: 0, end: 1 }, action: '乙看着甲' }], pause_reason: '',
      },
    }, { shot_number: 2, duration: 2, camera: {}, visible_characters: [{ character_id: 1, name: '甲' }, { character_id: 2, name: '乙' }], action: '无意义特写', result: '继续等待', character_trajectories: [staticTrajectory(1, '甲'), staticTrajectory(2, '乙')], audio_lip_sync: { mode: 'silent_ambient', speaker_name: '', speaker_in_frame: false, dialogue_content: '' }, speech_action_alignment: { mode: 'none', speech_window: null, speaker_action_window: null, speaker_action: '', listener_reactions: [], pause_reason: '' } }],
  };
  const violations = slots.validateVideoSlots(shot, video);
  assert.ok(violations.some(v => v.rule === 'INVARIANT_SHORT_DRAMA_INTERACTION_BEAT_EMPTY'));
  assert.ok(violations.some(v => v.rule === 'INVARIANT_SHORT_DRAMA_CHARACTER_ACTION_EMPTY'));
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
    performance_contract: 'structured_sync', camera: {}, trajectories: [], environment_vfx: {}, timing: { duration: 4 },
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
  const normalized = slots.createVideoSemanticSlots({ performance_contract: 'structured_sync', camera: {}, audio_lip_sync: {}, trajectories: [], environment_vfx: {}, timing: { duration: 5 }, shots_timeline: timeline });
  const prompt = slots.compileVideoPromptFromSlots({ duration: 5, action: '询问路线' }, normalized);
  assert.match(prompt, /同步视听事件/);
  assert.match(prompt, /边转身边抬手指向北侧通道/);
});

test('legacy sync_v1 and sync_v2 video slots are rejected immediately by validateVideoSlots', () => {
  const shot = { storyboard_number: 1, duration: 5, semantic_slots: { h3_mode: 'ref2va', shot_duration: 5, visible_characters: [{ id: 1 }] } };
  for (const contract of ['sync_v1', 'sync_v2', '']) {
    const legacy = {
      performance_contract: contract,
      timing: { duration: 5 },
      audio_lip_sync: { dialogue_content: '你好', speaker_in_frame: true },
      shots_timeline: [{ duration: 5, character_trajectories: [] }],
    };
    assert.ok(slots.validateVideoSlots(shot, legacy).some(v => v.rule === 'INVARIANT_H3_PERFORMANCE_CONTRACT_VERSION'));
  }
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
