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

test('planning gate rejects identity names mentioned in action but missing from the roster', () => {
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
  assert.deepEqual(
    violations.filter((item) => item.rule === 'INVARIANT_CHARACTER_NARRATIVE_ROSTER_MISMATCH').map((item) => item.asset_id).sort((a, b) => a - b),
    [27, 28]
  );
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

test('facing gate rejects a target direction without a body orientation', () => {
  const base = {
    character_id: 25,
    name: '红狼',
    depth_layer: 'midground',
    screen_position: '画面左侧中景',
    environmental_anchor: '山坡下',
    expression: '警觉',
    head_pose: '头部转向山坡',
    gaze: '目光锁定山坡方向',
    posture: '半蹲低伏',
    hands: '双手握枪',
    prop_interaction: '无道具接触',
    appearance_details: '战术服',
  };
  const bad = validateCharacterVisualSlots({ shot_number: 10 }, [{ ...base, facing: '画面上方（山坡方向）' }]);
  assert.ok(bad.some((item) => item.rule === 'INVARIANT_SLOT_MISSING_FACING'));
  const good = validateCharacterVisualSlots({ shot_number: 10 }, [{ ...base, facing: '侧身朝向画面左侧' }]);
  assert.equal(good.some((item) => item.rule === 'INVARIANT_SLOT_MISSING_FACING'), false);
});
