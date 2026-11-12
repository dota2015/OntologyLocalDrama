const test = require('node:test');
const assert = require('node:assert/strict');

const runtime = require('../src/services/agentsRuntime');
const videoSlots = require('../src/ontology/videoSlots');

function trajectory(id, name, action, startState, resultState, speaker = false) {
  return {
    character_id: id,
    name,
    start_state: startState,
    action_atom: {
      action,
      body_part: action === 'hold' ? 'both_hands' : 'whole_body',
      object_id: action === 'hold' ? 81 : null,
      target_type: ['walk', 'run', 'turn', 'look', 'point', 'block'].includes(action) ? 'scene' : 'none',
      target_id: null,
      target_label: ['walk', 'run', 'turn', 'look', 'point', 'block'].includes(action) ? '出口' : '',
      direction: 'none',
      contact: action === 'hold' ? 'weapon_grip' : 'none',
    },
    result_state: resultState,
    reaction_trigger: { type: 'dialogue', source_id: null, source_label: '本段对白' },
    facing: 'toward_character',
    facing_target_id: id === 25 ? 26 : 25,
    head_pose: 'turned_to_target',
    gaze_type: 'character',
    gaze_target_id: id === 25 ? 26 : 25,
    gaze_target_label: id === 25 ? '蜂医' : '红狼',
    posture: 'standing',
    hands_state: action === 'hold' ? 'holding_object' : 'relaxed',
    hands_object_id: action === 'hold' ? 81 : null,
    hands_target_id: null,
    expression: 'focused',
    expression_detail: '',
    mouth_state: speaker ? 'speaker_synced' : 'closed',
  };
}

function buildStructuredSync() {
  return {
    performance_contract: 'structured_sync',
    camera: { shot_type: 'medium', angle_h: 'front', angle_v: 'eye_level', angle_s: 'medium', movement: 'static', movement_description: '' },
    audio_lip_sync: { mode: 'in_frame_dialogue', speaker_name: '红狼', speaker_in_frame: true, dialogue_content: '撤退！', visible_characters_lip_state: 'synchronized_lip', lip_sync_rule: '' },
    trajectories: [],
    environment_vfx: { lighting_atmosphere: '', physical_phenomena: '', terminal_event: '' },
    timing: { duration: 4, pacing: '紧凑' },
    shots_timeline: [
      {
        shot_number: 1, timestamp: null, duration: 2,
        camera: { shot_type: 'medium', movement: 'static', movement_description: '' },
        action: '红狼发出警告', result: '蜂医转向红狼',
        visible_characters: [{ character_id: 25, name: '红狼' }, { character_id: 26, name: '蜂医' }],
        character_trajectories: [trajectory(25, '红狼', 'hold', 'standing_alert', 'weapon_ready', true), trajectory(26, '蜂医', 'react', 'standing_alert', 'turned_to_target')],
        audio_lip_sync: { mode: 'in_frame_dialogue', speaker_name: '红狼', speaker_in_frame: true, dialogue_content: '撤退！', lip_sync_rule: '' },
        speech_action_alignment: { mode: 'concurrent', speech_window: { start: 0, end: 2 }, speaker_character_id: 25, speaker_action_window: { start: 0, end: 2 }, listener_reactions: [{ character_id: 26, action_window: { start: 0, end: 2 }, trajectory_action: 'react' }], pause_reason: '' },
      },
      {
        shot_number: 2, timestamp: '00:02.000', duration: 2,
        camera: { shot_type: 'medium', movement: 'tracking', movement_description: '' },
        action: '两人向出口移动', result: '两人进入行走状态',
        visible_characters: [{ character_id: 25, name: '红狼' }, { character_id: 26, name: '蜂医' }],
        character_trajectories: [trajectory(25, '红狼', 'walk', 'weapon_ready', 'walking'), trajectory(26, '蜂医', 'walk', 'turned_to_target', 'walking')],
        audio_lip_sync: { mode: 'silent_ambient', speaker_name: '', speaker_in_frame: false, dialogue_content: '', lip_sync_rule: '' },
        speech_action_alignment: { mode: 'none', speech_window: { start: 0, end: 2 }, speaker_character_id: null, speaker_action_window: { start: 0, end: 2 }, listener_reactions: [], pause_reason: '' },
      },
    ],
  };
}

test('execution schema uses structured_sync action atoms', () => {
  const schema = runtime.directorExecutionSlotsOutputType(4).schema;
  const video = schema.properties.video_slots;
  assert.deepEqual(video.properties.performance_contract, { const: 'structured_sync' });
  const trajectory = video.properties.shots_timeline.items.properties.character_trajectories.items;
  assert.ok(trajectory.required.includes('action_atom'));
  const actionSchema = trajectory.properties.action_atom.properties.action;
  assert.equal(actionSchema.anyOf.some((item) => item.enum?.includes('hold')), true);
  assert.ok(trajectory.properties.action_atom.properties.action_detail);
  assert.equal(trajectory.properties.trajectory, undefined);
});

test('structured_sync validates enums, compiles atoms into natural language, and rejects legacy contracts', () => {
  const shot = {
    shot_number: 1,
    duration: 4,
    props: [81],
    semantic_slots: {
      h3_mode: 'ref2va', shot_duration: 4,
      visible_characters: [{ id: 25, name: '红狼' }, { id: 26, name: '蜂医' }],
      background_characters: [],
    },
  };
  const slots = buildStructuredSync();
  assert.deepEqual(videoSlots.validateVideoSlots(shot, slots), []);
  const prompt = videoSlots.compileVideoPromptFromSlots({ ...shot, characters: [25, 26] }, slots);
  assert.match(prompt, /红狼.*握住/);
  assert.match(prompt, /蜂医/);
  const invalid = structuredClone(slots);
  invalid.shots_timeline[0].character_trajectories[0].action_atom.action = 'dance';
  assert.ok(videoSlots.validateVideoSlots(shot, invalid).some((item) => item.rule === 'INVARIANT_ACTION_ENUM_INVALID'));
  for (const legacyName of ['sync_v1', 'sync_v2', '']) {
    const legacy = structuredClone(slots);
    legacy.performance_contract = legacyName;
    assert.ok(videoSlots.validateVideoSlots(shot, legacy).some((item) => item.rule === 'INVARIANT_H3_PERFORMANCE_CONTRACT_VERSION'));
  }
});
