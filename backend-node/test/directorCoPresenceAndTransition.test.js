const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const SceneCoPresenceRule = require('../src/ontology/rules/sceneCoPresenceRule');
const ShotTransitionContinuityRule = require('../src/ontology/rules/shotTransitionContinuityRule');
const { validateAllInvariants } = require('../src/ontology/invariants');

describe('Director Scene Co-Presence and Shot Arc Transitions', () => {
  it('SceneCoPresenceRule flags characters who suddenly speak without prior background presence or entrance action', () => {
    const rule = new SceneCoPresenceRule();
    const shots = [
      {
        shot_number: 1,
        scene_id: 10,
        characters: [1],
        character_visuals: [{ character_id: 1, name: '奕宸', depth_layer: 'midground' }],
        action: '奕宸坐在书桌前疯狂敲击键盘，专心致志打游戏',
        dialogue: '奕宸: “马上就能通关了！”',
      },
      {
        shot_number: 2,
        scene_id: 10,
        characters: [2], // 妹妹突然说话，但镜头1既无妹妹在场，本镜也无进门动作
        character_visuals: [{ character_id: 2, name: '妹妹', depth_layer: 'midground' }],
        action: '妹妹合上作业本抬头，语气带着不满',
        dialogue: '妹妹: “哥，你答应帮我检查作业的，怎么还在玩？”',
      },
    ];

    const violations = rule.evaluate({ shots });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].rule, 'INVARIANT_SUDDEN_APPARITION');
    assert.ok(violations[0].message.includes('妹妹'));
    assert.ok(violations[0].message.includes('突然降临'));
  });

  it('SceneCoPresenceRule passes when the character was pre-established as background_character in prior shot', () => {
    const rule = new SceneCoPresenceRule();
    const shots = [
      {
        shot_number: 1,
        scene_id: 10,
        characters: [1],
        background_characters: [
          {
            character_id: 2,
            name: '妹妹',
            depth_layer: 'background',
            screen_position: '画面右后方景深处书桌前',
            activity: '低头安静写作业',
          },
        ],
        character_visuals: [
          { character_id: 1, name: '奕宸', depth_layer: 'midground' },
          { character_id: 2, name: '妹妹', depth_layer: 'background' },
        ],
        action: '奕宸坐在书桌前疯狂敲击键盘，景深处妹妹低头写作业',
        dialogue: '奕宸: “马上就能通关了！”',
      },
      {
        shot_number: 2,
        scene_id: 10,
        characters: [2], // 妹妹在第2镜成为焦点说话，因为第1镜已在场，合情合理不突兀
        character_visuals: [{ character_id: 2, name: '妹妹', depth_layer: 'midground' }],
        action: '妹妹合上作业本抬头说话',
        dialogue: '妹妹: “哥，你答应帮我检查作业的。”',
      },
    ];

    const violations = rule.evaluate({ shots });
    assert.equal(violations.length, 0, 'Should have 0 sudden apparition violations when background presence is declared');
  });

  it('SceneCoPresenceRule passes when the newly appearing character has an explicit entrance action', () => {
    const rule = new SceneCoPresenceRule();
    const shots = [
      {
        shot_number: 1,
        scene_id: 10,
        characters: [1],
        character_visuals: [{ character_id: 1, name: '奕宸', depth_layer: 'midground' }],
        action: '奕宸坐在书桌前疯狂敲击键盘',
        dialogue: '',
      },
      {
        shot_number: 2,
        scene_id: 10,
        characters: [3],
        character_visuals: [{ character_id: 3, name: '妈妈', depth_layer: 'midground' }],
        action: '书房房门被推开，妈妈推门走入书房，皱眉注视着电脑屏幕',
        dialogue: '妈妈: “奕宸，作业写完了吗？”',
      },
    ];

    const violations = rule.evaluate({ shots });
    assert.equal(violations.length, 0, 'Should pass when entrance action (推门走入) is present');
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
