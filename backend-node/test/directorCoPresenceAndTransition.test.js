const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const ShotTransitionContinuityRule = require('../src/ontology/rules/shotTransitionContinuityRule');
const { defaultEngine } = require('../src/ontology/invariants');

describe('Director Shot Arc Transitions', () => {
  it('removed SceneCoPresenceRule is not registered in defaultEngine', () => {
    assert.equal(defaultEngine.getRule('RULE_SCENE_CO_PRESENCE'), undefined);
  });

  it('ShotTransitionContinuityRule checks eyeline_match using structured gaze slots without text regex', () => {
    const rule = new ShotTransitionContinuityRule();
    const base = { shot_number: 1, scene_id: 10, action: '角色抬头望向门口', result: '视线停在门框', layout_description: '近景' };
    const missingGaze = {
      shot_number: 2,
      scene_id: 10,
      action: '反打镜头',
      result: '角色回头',
      start_framing: '近景',
      character_visuals: [{ character_id: 2, gaze_type: 'none', gaze_target_id: null, gaze_target_label: '' }],
      semantic_slots: {
        continuity_from_previous: {
          relationship: 'eyeline_match',
          previous_end_state: '抬头',
          entry_state: '对视',
          causal_link: '反应',
        },
      },
    };
    const bad = rule.evaluate({ shots: [base, missingGaze] });
    assert.ok(bad.some((v) => v.rule === 'INVARIANT_EYELINE_MATCH_WITHOUT_EYE_TARGET'));

    const validGaze = structuredClone(missingGaze);
    validGaze.character_visuals[0].gaze_type = 'character';
    validGaze.character_visuals[0].gaze_target_id = 1;
    validGaze.character_visuals[0].gaze_target_label = '角色甲';
    const good = rule.evaluate({ shots: [base, validGaze] });
    assert.equal(good.some((v) => v.rule === 'INVARIANT_EYELINE_MATCH_WITHOUT_EYE_TARGET'), false);
  });

  it('ShotTransitionContinuityRule flags missing start_framing or transition logic in dialogue clashes', () => {
    const rule = new ShotTransitionContinuityRule();
    const shots = [
      {
        shot_number: 1,
        scene_id: 10,
        action: '奕宸敲击键盘',
        dialogue: '奕宸: “等一分钟就好！”',
        start_framing: '',
        layout_description: '',
        end_framing: '',
        result: '',
      },
      {
        shot_number: 2,
        scene_id: 10,
        action: '妹妹叹气',
        dialogue: '妹妹: “你每次都说等一分钟。”',
        start_framing: '近景平视，妹妹双手撑在下巴上',
        end_framing: '定格在妹妹失望的侧颜',
        transition_to_next: '',
      },
    ];

    const violations = rule.evaluate({ shots });
    assert.ok(violations.some((v) => v.rule === 'INVARIANT_MISSING_START_FRAMING'));
    assert.ok(violations.some((v) => v.rule === 'INVARIANT_MISSING_TRANSITION_LOGIC'));
  });

  it('requires an incoming continuity contract for generated non-opening shots', () => {
    const rule = new ShotTransitionContinuityRule();
    const base = { shot_number: 1, scene_id: 10, action: '奕宸停在门边', result: '奕宸抬头看向屋内', layout_description: '中景' };
    const next = { shot_number: 2, scene_id: 10, action: '妈妈走到桌边', result: '妈妈停在桌旁', layout_description: '中景', semantic_slots: { continuity_type: 'continuation' } };
    const missing = rule.evaluate({ shots: [base, next] });
    assert.ok(missing.some((v) => v.rule === 'INVARIANT_MISSING_INCOMING_CONTINUITY'));

    next.semantic_slots.continuity_from_previous = {
      relationship: 'continuation',
      previous_end_state: '奕宸停在门边并抬头看向屋内',
      entry_state: '妈妈从门口进入并走到桌边',
      causal_link: '奕宸抬头看到妈妈后，妈妈走近桌边询问作业',
    };
    const valid = rule.evaluate({ shots: [base, next] });
    assert.equal(valid.some((v) => v.rule === 'INVARIANT_MISSING_INCOMING_CONTINUITY'), false);
  });
});
