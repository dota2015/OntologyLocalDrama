const test = require('node:test');
const assert = require('node:assert/strict');
const {
  checkPlanningFeasibility,
  validateAllInvariants,
} = require('../src/ontology/invariants');
const { validateCharacterVisualSlots } = require('../src/ontology/visualSlots');

const catalogs = {
  characters: [{ id: 25 }, { id: 26 }, { id: 27 }, { id: 28 }],
  scenes: [{ id: 100 }],
  props: [{ id: 200 }],
};

test('planning gate rejects unknown character IDs before execution slots', () => {
  const violations = checkPlanningFeasibility([{
    shot_number: 10,
    scene_id: 100,
    characters: [25, 26, 27],
    background_characters: [{ character_id: 901, name: '敌军' }],
    semantic_slots: {
      visible_characters: [{ id: 25 }, { id: 26 }, { id: 27 }],
      background_characters: [{ character_id: 901, name: '敌军' }],
      required_references: [],
    },
  }], { catalogs });
  assert.ok(violations.some((item) => item.rule === 'INVARIANT_UNKNOWN_CHARACTER_REFERENCE' && item.asset_id === 901));
  assert.ok(violations.some((item) => item.rule === 'INVARIANT_PLANNING_CHARACTER_CAPACITY'));
});

test('planning gate counts semantic visible and background characters as one set', () => {
  const violations = checkPlanningFeasibility([{
    shot_number: 4,
    scene_id: 100,
    characters: [25, 26],
    background_characters: [],
    semantic_slots: {
      visible_characters: [{ id: 25 }, { id: 26 }],
      background_characters: [{ character_id: 27, name: '露娜' }, { character_id: 28, name: '敌军' }],
      required_references: [],
    },
  }], { catalogs });
  assert.equal(violations.some((item) => item.rule === 'INVARIANT_PLANNING_CHARACTER_CAPACITY'), true);
});

test('planning gate rejects divergent top-level and semantic character lists', () => {
  const violations = checkPlanningFeasibility([{
    shot_number: 5,
    characters: [25],
    background_characters: [],
    semantic_slots: {
      visible_characters: [{ id: 26 }],
      background_characters: [],
      required_references: [],
    },
  }], { catalogs });
  assert.ok(violations.some((item) => item.rule === 'INVARIANT_CHARACTER_SLOT_DIVERGENCE'));
});

test('planning gate never infers roster membership from narrative text', () => {
  // Names appearing in free text prove nothing about participation: a named
  // character may be offscreen, remote, or merely mentioned. The gate must
  // not scan narrative text at all; participation is declared structurally.
  const violations = checkPlanningFeasibility([{
    shot_number: 12,
    characters: ['红狼'],
    background_characters: [],
    action: '红狼关闭简报，蜂医和露娜无奈跟上',
    result: '小队进入峡谷',
    semantic_slots: {},
  }], {
    catalogs: {
      characters: [{ id: 25, name: '红狼' }, { id: 27, name: '露娜' }, { id: 28, name: '蜂医' }],
    },
  });
  assert.deepEqual(violations, []);
});

const drama5Catalogs = {
  characters: [
    { id: 25, name: '红狼' }, { id: 26, name: '蜂医' }, { id: 27, name: '露娜' },
  ],
  scenes: [{ id: 100 }],
  props: [],
};

test('episode 17 shot 20: remote addressee declared offscreen passes with a single visible character', () => {
  const violations = checkPlanningFeasibility([{
    shot_number: 20,
    scene_id: 100,
    characters: [27],
    background_characters: [],
    action: '露娜靠在墙上，通过通讯器向红狼解释备用路线',
    dialogue: '露娜: 红狼，备用路线从西侧走。',
    semantic_slots: {
      visible_characters: [{ id: 27, name: '露娜' }],
      background_characters: [],
      offscreen_characters: [{ character_id: 25, name: '红狼', mode: 'remote_voice' }],
      speech_plan: { speaker_id: 27, speaker_name: '露娜', is_offscreen: false, text: '红狼，备用路线从西侧走。' },
      audio_lip_sync: 'in_frame_dialogue',
      required_references: [],
    },
  }], { catalogs: drama5Catalogs });
  assert.deepEqual(violations, []);
});

test('episode 17 shot 14: offscreen participant does not consume the two-person visual capacity', () => {
  const violations = checkPlanningFeasibility([{
    shot_number: 14,
    scene_id: 100,
    characters: [27, 26],
    background_characters: [],
    action: '露娜在枪林弹雨中向红狼喊话，蜂医在旁掩护',
    semantic_slots: {
      visible_characters: [{ id: 27, name: '露娜' }, { id: 26, name: '蜂医' }],
      background_characters: [],
      offscreen_characters: [{ character_id: 25, name: '红狼', mode: 'remote_voice' }],
      speech_plan: { speaker_id: 27, speaker_name: '露娜', is_offscreen: false, text: '北侧被封锁！红狼，立刻转备用路线！' },
      audio_lip_sync: 'in_frame_dialogue',
      required_references: [],
    },
  }], { catalogs: drama5Catalogs });
  assert.deepEqual(violations, []);
});

test('offscreen speaker is valid with offscreen_voiceover and rejected with in-frame lip sync', () => {
  const base = {
    shot_number: 21,
    scene_id: 100,
    characters: [27],
    background_characters: [],
    semantic_slots: {
      visible_characters: [{ id: 27, name: '露娜' }],
      background_characters: [],
      offscreen_characters: [{ character_id: 25, name: '红狼', mode: 'remote_voice' }],
      speech_plan: { speaker_id: 25, speaker_name: '红狼', is_offscreen: true, text: '收到，正在转向。' },
      required_references: [],
    },
  };
  const okShot = structuredClone(base);
  okShot.semantic_slots.audio_lip_sync = 'offscreen_voiceover';
  assert.deepEqual(checkPlanningFeasibility([okShot], { catalogs: drama5Catalogs }), []);
  const badShot = structuredClone(base);
  badShot.semantic_slots.audio_lip_sync = 'in_frame_dialogue';
  const violations = checkPlanningFeasibility([badShot], { catalogs: drama5Catalogs });
  assert.ok(violations.some((item) => item.rule === 'INVARIANT_OFFSCREEN_SPEAKER_LIP_SYNC'));
});

test('planning gate rejects an undeclared speaker instead of guessing from text', () => {
  const violations = checkPlanningFeasibility([{
    shot_number: 22,
    scene_id: 100,
    characters: [27],
    background_characters: [],
    semantic_slots: {
      visible_characters: [{ id: 27, name: '露娜' }],
      background_characters: [],
      offscreen_characters: [],
      speech_plan: { speaker_id: 25, speaker_name: '红狼', is_offscreen: true, text: '收到。' },
      audio_lip_sync: 'offscreen_voiceover',
      required_references: [],
    },
  }], { catalogs: drama5Catalogs });
  assert.ok(violations.some((item) => item.rule === 'INVARIANT_SPEAKER_NOT_DECLARED' && item.asset_id === 25));
});

test('planning gate rejects participation overlap, visualized offscreen characters, and unknown offscreen IDs', () => {
  const overlap = checkPlanningFeasibility([{
    shot_number: 23,
    scene_id: 100,
    characters: [25],
    background_characters: [],
    semantic_slots: {
      visible_characters: [{ id: 25, name: '红狼' }],
      background_characters: [],
      offscreen_characters: [{ character_id: 25, name: '红狼', mode: 'present_offscreen' }],
      required_references: [],
    },
  }], { catalogs: drama5Catalogs });
  assert.ok(overlap.some((item) => item.rule === 'INVARIANT_CHARACTER_PARTICIPATION_CONFLICT'));

  const visualized = checkPlanningFeasibility([{
    shot_number: 24,
    scene_id: 100,
    characters: [27],
    background_characters: [],
    character_visuals: [{ character_id: 25, name: '红狼' }],
    semantic_slots: {
      visible_characters: [{ id: 27, name: '露娜' }],
      background_characters: [],
      offscreen_characters: [{ character_id: 25, name: '红狼', mode: 'remote_voice' }],
      required_references: [],
    },
  }], { catalogs: drama5Catalogs });
  assert.ok(visualized.some((item) => item.rule === 'INVARIANT_OFFSCREEN_CHARACTER_VISUALIZED'));

  const unknown = checkPlanningFeasibility([{
    shot_number: 25,
    scene_id: 100,
    characters: [27],
    background_characters: [],
    semantic_slots: {
      visible_characters: [{ id: 27, name: '露娜' }],
      background_characters: [],
      offscreen_characters: [{ character_id: 999, name: '幽灵' }],
      required_references: [],
    },
  }], { catalogs: drama5Catalogs });
  assert.ok(unknown.some((item) => item.rule === 'INVARIANT_UNKNOWN_CHARACTER_REFERENCE' && item.asset_id === 999));
});

test('planning gate rejects unknown scene, prop, and required reference IDs', () => {
  const violations = checkPlanningFeasibility([{
    shot_number: 2,
    scene_id: 999,
    characters: [25],
    props: [998],
    semantic_slots: {
      visible_characters: [{ id: 25 }],
      background_characters: [],
      required_references: [
        { type: 'scene', id: 999 },
        { type: 'prop', id: 998 },
      ],
    },
  }], { catalogs });
  assert.ok(violations.some((item) => item.rule === 'INVARIANT_UNKNOWN_SCENE_REFERENCE'));
  assert.ok(violations.some((item) => item.rule === 'INVARIANT_UNKNOWN_PROP_REFERENCE'));
  assert.ok(violations.some((item) => item.rule === 'INVARIANT_UNKNOWN_REQUIRED_SCENE_REFERENCE'));
  assert.ok(violations.some((item) => item.rule === 'INVARIANT_UNKNOWN_REQUIRED_PROP_REFERENCE'));
});

test('runtime crowd and H3 capacity use semantic background characters', () => {
  const shot = {
    shot_number: 3,
    characters: [25, 26],
    background_characters: [],
    semantic_slots: {
      visible_characters: [{ id: 25 }, { id: 26 }],
      background_characters: [{ character_id: 27 }, { character_id: 28 }],
    },
  };
  const audit = validateAllInvariants([shot], { catalogs });
  assert.ok(audit.violations.some((item) => item.rule === 'INVARIANT_H3_CROWD_OVERLOAD'));
});

test('facing gate rejects invalid facing enum without allowing prose bypass', () => {
  const base = {
    character_id: 25,
    name: '红狼',
    depth_layer: 'midground',
    screen_position: 'left_midground',
    environmental_anchor: '山坡下',
    head_pose: 'turned_to_target',
    gaze_type: 'scene',
    gaze_target_id: null,
    gaze_target_label: '山坡方向',
    posture: 'crouching',
    hands_state: 'holding_object',
    hands_object_id: null,
    hands_target_id: null,
    expression: 'alert',
    expression_detail: '警觉',
    appearance_details: '战术服',
  };
  const bad = validateCharacterVisualSlots({ shot_number: 10 }, [{ ...base, facing: '画面上方（山坡方向）' }]);
  assert.ok(bad.some((item) => item.rule === 'INVARIANT_VISUAL_ENUM_INVALID'));
  const good = validateCharacterVisualSlots({ shot_number: 10 }, [{ ...base, facing: 'three_quarter_left' }]);
  assert.equal(good.some((item) => item.rule === 'INVARIANT_VISUAL_ENUM_INVALID'), false);
});
