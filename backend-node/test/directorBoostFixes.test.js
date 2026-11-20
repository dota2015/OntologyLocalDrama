const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  auditDirectorDraftScoped,
  directorAtomicRepairHint,
  directorAtomicPatchSchema,
  normalizeTimelineTimestamps,
} = require('../src/ontology/directorAgent');
const agentsRuntime = require('../src/services/agentsRuntime');
const h3NativeService = require('../src/services/h3NativeService');
const { STRUCTURED_SCREEN_POSITIONS, validateCharacterVisualSlots } = require('../src/ontology/visualSlots');
const { isStaticGazeTrajectory, SEALED_MOUTH_STATES, validateVideoSlots } = require('../src/ontology/videoSlots');

describe('Director Boost Fixes Verification', () => {
  it('auditDirectorDraftScoped does not retain stale violations after structural shot shifts', () => {
    const fakePreviousAudit = {
      valid: false,
      error_count: 2,
      shots_count: 16,
      violations: [
        {
          rule: 'INVARIANT_SPEECH_OVER_BUDGET',
          shot_number: 17,
          message: 'Old shot 17 over budget',
        },
      ],
    };

    // Candidate shots: 17 shots (after a split)
    const shots = Array.from({ length: 17 }, (_, i) => ({
      shot_number: i + 1,
      duration: 5,
      movement: 'push',
      lighting_style: '冷调高反差',
      depth_of_field: '浅景深',
      angle_h: 'front',
      angle_v: 'eye_level',
      angle_s: 'medium',
      shot_type: '中景',
      dialogue_framing: 'solo_action',
      characters: [1],
      character_visuals: [
        {
          character_id: 1,
          name: '主角',
          depth_layer: 'foreground',
          screen_position: '画面中央中景',
          facing: '正面面对镜头',
          head_pose: '头部正对前方',
          gaze: '目光直视前方',
          posture: '端正站立',
          hands: '双手自然下垂',
        },
      ],
      video_slots: {
        camera: { shot_type: '中景' },
        audio_lip_sync: { mode: 'silent_ambient' },
        trajectories: [],
        environment_vfx: {},
        timing: { duration: 5 },
        shots_timeline: [],
      },
      semantic_slots: {
        visible_characters: [{ id: 1, name: '主角' }],
        background_characters: [],
        identity_visibility: 'clear_frontal',
        speech_plan: { text: '' },
        sound_plan: { is_silent: true },
        continuity_type: 'continuation',
        h3_mode: 'ref2va',
        h3_mode_reason: '测试',
        first_frame_policy: 'none',
        first_frame_reason: '测试',
        last_frame_policy: 'none',
        last_frame_reason: '测试',
        required_references: [{ id: 1, type: 'character' }],
        audio_lip_sync: 'none',
        shot_duration: 5,
      },
    }));

    const audit = auditDirectorDraftScoped(
      shots,
      { directorPlanningMode: 'classic' },
      fakePreviousAudit,
      15,
      { structural: true, previousShotCount: 16 }
    );

    // Stale violation from old shot 17 must NOT be preserved!
    assert.equal(
      audit.violations.some((v) => v.message === 'Old shot 17 over budget'),
      false,
      'Structural repair must never preserve stale violations from previous audits'
    );
  });

  it('binds the union of reverse-shot subjects and enforces each segment separately', () => {
    const refs = [{ character_id: 1 }, { character_id: 2 }, { kind: 'context' }];
    const shot = (...segments) => ({ shot_type: '特写', video_slots: JSON.stringify({
      shots_timeline: segments.map(ids => ({ visible_characters: ids.map(character_id => ({ character_id })) })),
    }) });
    assert.doesNotThrow(() => h3NativeService.assertSegmentReferences(refs, shot([1], [2])));
    assert.throws(() => h3NativeService.assertSegmentReferences(refs, shot([1])), /均未入画/);
    assert.throws(() => h3NativeService.assertSegmentReferences(refs, shot([1,2,3])), /最多允许/);
    assert.throws(() => h3NativeService.assertSegmentReferences(refs.slice(0,1), shot([1], [2])), /缺少绑定/);
    assert.throws(() => h3NativeService.assertSegmentReferences(refs, shot()), /缺少 H3 分段时间轴/);
  });

  it('dynamic schema for last_frame_visuals restricts to maxItems 0 when last_frame_policy is not generate_tail', () => {
    const noneOutputType = agentsRuntime.directorExecutionSlotsOutputType(5, {
      lastFramePolicy: 'none',
      allowTailVisuals: false,
    });
    assert.equal(noneOutputType.schema.properties.last_frame_visuals.maxItems, 0);

    const tailOutputType = agentsRuntime.directorExecutionSlotsOutputType(5, {
      lastFramePolicy: 'generate_tail',
      allowTailVisuals: true,
    });
    assert.equal(tailOutputType.schema.properties.last_frame_visuals.maxItems, 2);
  });

  it('execution contract schema requires a complete incoming continuity object', () => {
    const outputType = agentsRuntime.directorExecutionSlotsOutputType(5);
    const semantic = outputType.schema.properties.semantic_slots;
    assert.ok(semantic.required.includes('continuity_from_previous'));
    assert.ok(semantic.required.includes('source_script_excerpt'));
    assert.deepEqual(
      semantic.properties.continuity_from_previous.required,
      ['relationship', 'previous_end_state', 'entry_state', 'causal_link', 'sound_bridge', 'requires_previous_tail'],
    );
  });

  it('normalizeTimelineTimestamps calculates deterministic timestamps based on segment durations', () => {
    const timeline = [
      { shot_number: 1, duration: 2, timestamp: '00:00.000' },
      { shot_number: 2, duration: 2, timestamp: 'wrong_or_null' },
      { shot_number: 3, duration: 2, timestamp: '00:03' },
    ];
    const normalized = normalizeTimelineTimestamps(timeline);
    assert.equal(normalized[0].timestamp, '00:00.000');
    assert.equal(normalized[1].timestamp, '00:02.000');
    assert.equal(normalized[2].timestamp, '00:04.000');
  });

  it('validateCharacterVisualSlots enforces closed structured screen_position enums', () => {
    for (const pos of STRUCTURED_SCREEN_POSITIONS) {
      const violations = validateCharacterVisualSlots({ shot_number: 1 }, [{
        character_id: 1, name: '角色甲', depth_layer: 'midground', screen_position: pos,
        facing: 'front_camera', head_pose: 'neutral', gaze_type: 'scene',
        posture: 'standing', hands_state: 'free', expression: 'focused',
      }]);
      assert.equal(violations.length, 0, `Structured screen_position "${pos}" should be valid`);
    }
    const invalid = validateCharacterVisualSlots({ shot_number: 1 }, [{
      character_id: 1, name: '角色甲', depth_layer: 'midground', screen_position: '站在桌子旁',
      facing: 'front_camera', head_pose: 'neutral', gaze_type: 'scene',
      posture: 'standing', hands_state: 'free', expression: 'focused',
    }]);
    assert.ok(invalid.some((v) => v.rule === 'INVARIANT_VISUAL_ENUM_INVALID'));
  });

  it('isStaticGazeTrajectory detects structured actions vs passive gaze-only atoms', () => {
    assert.equal(isStaticGazeTrajectory({
      start_state: 'crouched',
      result_state: 'walking',
      action_atom: { action: 'walk', direction: 'forward', contact: 'ground', object_id: null },
    }), false);
    assert.equal(isStaticGazeTrajectory({
      start_state: 'standing',
      result_state: 'turned_to_target',
      action_atom: { action: 'turn', direction: 'toward_target', contact: 'none', object_id: null },
    }), false);
    assert.equal(isStaticGazeTrajectory({
      start_state: 'standing',
      result_state: 'standing',
      action_atom: { action: 'look', direction: 'none', contact: 'none', object_id: null },
    }, { trajectory_action: 'react' }), false);

    assert.equal(isStaticGazeTrajectory({
      start_state: 'standing',
      result_state: 'standing',
      action_atom: { action: 'look', direction: 'none', contact: 'none', object_id: null },
    }), true);
    assert.equal(isStaticGazeTrajectory({
      start_state: 'sitting',
      result_state: 'sitting',
      action_atom: { action: 'listen', direction: 'none', contact: 'none', object_id: null },
    }, { trajectory_action: 'none' }), true);
  });

  it('SEALED_MOUTH_STATES strictly accepts closed/offscreen_sealed enums and rejects prose', () => {
    assert.ok(SEALED_MOUTH_STATES.has('closed'));
    assert.ok(SEALED_MOUTH_STATES.has('offscreen_sealed'));
    for (const state of ['speaker_synced', '双唇紧闭', '开口说话', '微张', 'strictly_sealed']) {
      assert.equal(SEALED_MOUTH_STATES.has(state), false, `mouth_state "${state}" must not be accepted via prose bypass`);
    }
  });

  it('validateVideoSlots evaluates listener reactions against segment speaker, not outer shot speaker', () => {
    // Mimic Drama 5 / Episode 17 Shot 12 scenario:
    // Outer shot speaker is 蜂医 (id: 1)
    // Segment 3 dialogue is spoken by 露娜 (id: 2)
    // In segment 3, 蜂医 is the listener, 露娜 is the speaker.
    const shot = {
      shot_number: 12,
      duration: 6,
      characters: [1, 2],
      speech_plan: {
        speaker_id: 1,
        speaker_name: '蜂医',
        text: '第一句由蜂医说',
      },
    };

    const timeline = [
      {
        shot_number: 1,
        timestamp: '00:00.000',
        duration: 2,
        camera: { shot_type: '中景' },
        visible_characters: [{ id: 1, name: '蜂医' }, { id: 2, name: '露娜' }],
        action: '蜂医迈步前行',
        result: '站定在露娜身旁',
        character_trajectories: [
          { character_id: 1, name: '蜂医', mouth_state: 'speaker_synced' },
          { character_id: 2, name: '露娜', mouth_state: 'closed' },
        ],
        audio_lip_sync: {
          speaker_id: 1,
          speaker_name: '蜂医',
          speaker_in_frame: true,
          dialogue_content: '我们得尽快离开这里。',
        },
        speech_action_alignment: {
          speaker_action: '蜂医迈步前行并开口说话',
          speaker_action_window: { start: 0, end: 2 },
          speech_window: { start: 0, end: 2 },
          listener_reactions: [
            { character_id: 2, name: '露娜', action: '露娜转头注视蜂医并聆听', action_window: { start: 0, end: 2 } },
          ],
        },
      },
      {
        shot_number: 2,
        timestamp: '00:02.000',
        duration: 2,
        camera: { shot_type: '中景' },
        visible_characters: [{ id: 1, name: '蜂医' }, { id: 2, name: '露娜' }],
        action: '两人对视观察四周',
        result: '保持警戒',
        character_trajectories: [
          { character_id: 1, name: '蜂医', mouth_state: 'closed' },
          { character_id: 2, name: '露娜', mouth_state: 'closed' },
        ],
        audio_lip_sync: {
          mode: 'silent_ambient',
          speaker_in_frame: false,
          dialogue_content: '',
        },
      },
      {
        shot_number: 3,
        timestamp: '00:04.000',
        duration: 2,
        camera: { shot_type: '中景' },
        visible_characters: [{ id: 1, name: '蜂医' }, { id: 2, name: '露娜' }],
        action: '露娜转头回应',
        result: '确认路线',
        character_trajectories: [
          { character_id: 1, name: '蜂医', mouth_state: 'closed' },
          { character_id: 2, name: '露娜', mouth_state: 'speaker_synced' },
        ],
        audio_lip_sync: {
          speaker_id: 2,
          speaker_name: '露娜',
          speaker_in_frame: true,
          dialogue_content: '通道就在前面，跟我来。',
        },
        speech_action_alignment: {
          speaker_action: '露娜迈步带路并开口说话',
          speaker_action_window: { start: 4, end: 6 },
          speech_window: { start: 4, end: 6 },
          listener_reactions: [
            { character_id: 1, name: '蜂医', action: '蜂医转头注视露娜并点头', action_window: { start: 4, end: 6 } },
          ],
        },
      },
    ];

    const violations = validateVideoSlots(
      shot,
      {
        performance_contract: 'structured_sync',
        camera: { shot_type: '中景' },
        audio_lip_sync: { mode: 'in_frame_dialogue' },
        timing: { duration: 6 },
        trajectories: [],
        shots_timeline: timeline,
      },
      { duration: 6 }
    );

    // There should be NO INVARIANT_LISTENER_REACTION_OVERLAP_MISSING for 露娜 in segment 3
    const listenerViolations = violations.filter(v => v.rule === 'INVARIANT_LISTENER_REACTION_OVERLAP_MISSING');
    assert.equal(listenerViolations.length, 0, 'Should not complain about missing listener reaction for the segment speaker');
  });

  it('directorAtomicPatchSchema for mouth_state violations uses sealed mouth enum instead of natural language const', () => {
    const rulesToTest = [
      'INVARIANT_CHARACTER_MOUTH_NOT_SEALED',
      'INVARIANT_OFFSCREEN_SPEECH_LIP_SYNC_CONFLICT',
      'INVARIANT_NONVERBAL_MOUTH_NOT_SEALED',
      'INVARIANT_OFFSCREEN_LIP_SYNC_VIOLATION',
    ];

    const targetShot = {
      shot_number: 1,
      duration: 5,
      video_slots: {
        trajectories: [
          { character_id: 26, name: '蜂医', mouth_state: 'speaker_synced' },
        ],
        shots_timeline: [
          {
            shot_number: 1,
            character_trajectories: [
              { character_id: 26, name: '蜂医', mouth_state: 'speaker_synced' },
            ],
          },
        ],
      },
    };

    for (const rule of rulesToTest) {
      const violation = {
        rule,
        shot_number: 1,
        message: `${rule} test violation`,
        conflict_slots: ['trajectories', 'audio_lip_sync'],
      };

      const schema = directorAtomicPatchSchema(violation, targetShot);
      assert.ok(schema, `Schema should be returned for ${rule}`);

      // Check top-level video_slots schema
      const vsSchema = schema.properties?.video_slots;
      assert.ok(vsSchema, `video_slots should be present in patch schema for ${rule}`);

      // Check trajectories mouth_state schema (supports prefixItems or items)
      const trajArray = vsSchema.properties?.trajectories;
      assert.ok(trajArray, 'trajectories schema should be present');
      const trajItem = trajArray.prefixItems?.[0] || trajArray.items;
      assert.ok(trajItem, 'trajectories item schema should be defined');
      const mouthSchema = trajItem.properties?.mouth_state;
      assert.ok(mouthSchema, 'mouth_state schema should be present');

      // Crucial: enum must be defined and contain closed/offscreen_sealed; MUST NOT have const: '双唇紧闭无口型'
      assert.ok(Array.isArray(mouthSchema.enum), 'mouth_state schema must be an enum array');
      assert.deepEqual(
        [...mouthSchema.enum].sort(),
        [...SEALED_MOUTH_STATES].sort(),
        'mouth_state enum should match SEALED_MOUTH_STATES'
      );
      assert.equal(mouthSchema.const, undefined, 'mouth_state must not have hardcoded const string');

      // Check timeline trajectories mouth_state schema
      const timelineArray = vsSchema.properties?.shots_timeline;
      const timelineItem = timelineArray?.prefixItems?.[0] || timelineArray?.items;
      const tlTrajArray = timelineItem?.properties?.character_trajectories;
      const tlTrajItem = tlTrajArray?.prefixItems?.[0] || tlTrajArray?.items;
      if (tlTrajItem?.properties?.mouth_state) {
        const tlMouthSchema = tlTrajItem.properties.mouth_state;
        assert.ok(Array.isArray(tlMouthSchema.enum), 'timeline character_trajectories mouth_state must be enum');
        assert.deepEqual(
          [...tlMouthSchema.enum].sort(),
          [...SEALED_MOUTH_STATES].sort()
        );
        assert.equal(tlMouthSchema.const, undefined);
      }
    }
  });

  it('enforces crowd_reaction focal character limits without lifting 2-person physical boundary', () => {
    const CrowdControlRule = require('../src/ontology/rules/crowdControlRule');
    const H3ReferenceCapacityRule = require('../src/ontology/rules/h3ReferenceCapacityRule');
    const { CrossSlotInvariantsRule } = require('../src/ontology/rules/crossSlotRules');

    const crowdRule = new CrowdControlRule();
    const h3Rule = new H3ReferenceCapacityRule();
    const crossSlotRule = new CrossSlotInvariantsRule();

    // 3 named characters in crowd_reaction shot
    const crowdShot = {
      shot_number: 5,
      beat_type: 'crowd_reaction',
      dialogue_framing: 'crowd_reaction',
      characters: [1, 2, 3],
      semantic_slots: {
        visible_characters: [{ id: 1 }, { id: 2 }, { id: 3 }],
        required_references: [{ id: 1, type: 'character' }, { id: 2, type: 'character' }, { id: 3, type: 'character' }],
      },
    };

    const crowdViolations = crowdRule.evaluate({ shots: [crowdShot] });
    assert.equal(crowdViolations.length, 1);
    assert.equal(crowdViolations[0].rule, 'INVARIANT_CROWD_COLLAPSE_RISK');
    assert.ok(crowdViolations[0].message.includes('围观吃瓜镜头'));
    assert.ok(crowdViolations[0].message.includes('具名焦点角色仍须 ≤ 2 人'));

    const h3Violations = h3Rule.evaluate({ shots: [crowdShot] });
    assert.equal(h3Violations.length, 1);
    assert.equal(h3Violations[0].rule, 'INVARIANT_H3_CROWD_OVERLOAD');
    assert.ok(h3Violations[0].message.includes('围观吃瓜镜头'));

    const crossViolations = crossSlotRule.evaluate({ shots: [crowdShot] });
    const capacityViolation = crossViolations.find((v) => v.rule === 'INVARIANT_REFERENCE_CAPACITY_EXCEEDED');
    assert.ok(capacityViolation);
    assert.ok(capacityViolation.message.includes('围观吃瓜镜头'));

    // 2 focal characters + background text description passes cleanly
    const compliantCrowdShot = {
      shot_number: 6,
      beat_type: 'crowd_reaction',
      dialogue_framing: 'crowd_reaction',
      characters: [1, 2],
      background_characters: [],
      semantic_slots: {
        visible_characters: [{ id: 1 }, { id: 2 }],
        background_characters: [],
        required_references: [{ id: 1, type: 'character' }, { id: 2, type: 'character' }],
      },
    };
    assert.equal(crowdRule.evaluate({ shots: [compliantCrowdShot] }).length, 0);
    assert.equal(h3Rule.evaluate({ shots: [compliantCrowdShot] }).length, 0);
  });

  it('validates beat cinematography: reveal prop close-up and suppression audio/angle invariants', () => {
    const BeatCinematographyRule = require('../src/ontology/rules/beatCinematographyRule');
    const rule = new BeatCinematographyRule();

    const catalogs = {
      props: [
        { id: 10, name: '至尊龙王戒', prop_role: 'key_token', close_up_required: true },
        { id: 20, name: '普通茶杯', prop_role: 'ambient', close_up_required: false },
      ],
      characters: [
        { id: 1, name: '强势反派', power_status: 'dominant' },
        { id: 2, name: '隐忍主角', power_status: 'suppressed' },
      ],
    };

    // Case 1: Reveal beat missing prop reference
    const revealNoPropShot = {
      shot_number: 1,
      beat_type: 'reveal',
      shot_type: '特写',
      props: [],
      sound_plan: { sound_effects: ['sfx_sting'] },
    };
    const v1 = rule.evaluate({ shots: [revealNoPropShot], catalogs });
    assert.ok(v1.some((v) => v.rule === 'INVARIANT_KEY_PROP_REFERENCE_MISSING'));

    // Case 2: Reveal beat or key token prop with wide shot
    const revealWideShot = {
      shot_number: 2,
      beat_type: 'reveal',
      shot_type: '全景',
      props: [10],
      sound_plan: { sound_effects: ['sfx_sting'] },
    };
    const v2 = rule.evaluate({ shots: [revealWideShot], catalogs });
    assert.ok(v2.some((v) => v.rule === 'INVARIANT_KEY_PROP_CLOSE_UP_REQUIRED'));

    // Case 3: Suppression beat missing sting/impact SFX
    const suppressionNoSfxShot = {
      shot_number: 3,
      beat_type: 'suppression',
      shot_type: '中景',
      characters: [1],
      angle_v: 'low',
      sound_plan: { sound_effects: [] },
    };
    const v3 = rule.evaluate({ shots: [suppressionNoSfxShot], catalogs });
    assert.ok(v3.some((v) => v.rule === 'INVARIANT_BEAT_AUDIO_IMPACT_MISSING'));

    // Case 4: Suppression dominant character shot with high angle
    const suppressionWrongAngleDominant = {
      shot_number: 4,
      beat_type: 'suppression',
      shot_type: '中景',
      characters: [1],
      angle_v: 'high',
      sound_plan: { sound_effects: ['重音刺入'] },
    };
    const v4 = rule.evaluate({ shots: [suppressionWrongAngleDominant], catalogs });
    assert.ok(v4.some((v) => v.rule === 'INVARIANT_SUPPRESSION_ANGLE_MISMATCH' && v.message.includes('dominant')));

    // Case 5: Suppression suppressed character shot with low angle
    const suppressionWrongAngleSuppressed = {
      shot_number: 5,
      beat_type: 'suppression',
      shot_type: '近景',
      characters: [2],
      angle_v: 'low',
      sound_plan: { sound_effects: ['打脸音效'] },
    };
    const v5 = rule.evaluate({ shots: [suppressionWrongAngleSuppressed], catalogs });
    assert.ok(v5.some((v) => v.rule === 'INVARIANT_SUPPRESSION_ANGLE_MISMATCH' && v.message.includes('suppressed')));

    // Case 6: Fully compliant reveal shot
    const perfectRevealShot = {
      shot_number: 6,
      beat_type: 'reveal',
      shot_type: '特写',
      props: [10],
      sound_plan: { sound_effects: ['重音刺入'] },
    };
    const v6 = rule.evaluate({ shots: [perfectRevealShot], catalogs });
    assert.equal(v6.length, 0, 'Compliant reveal shot must produce 0 violations');
  });

  it('provides repair hint and explicit patch schema for beat cinematography violations', () => {
    const hintCloseUp = directorAtomicRepairHint({ rule: 'INVARIANT_KEY_PROP_CLOSE_UP_REQUIRED' });
    assert.ok(hintCloseUp.includes('特写'));

    const hintSfx = directorAtomicRepairHint({ rule: 'INVARIANT_BEAT_AUDIO_IMPACT_MISSING' });
    assert.ok(hintSfx.includes('重音刺入'));

    const hintAngle = directorAtomicRepairHint({ rule: 'INVARIANT_SUPPRESSION_ANGLE_MISMATCH' });
    assert.ok(hintAngle.includes('仰拍'));

    const schemaCloseUp = directorAtomicPatchSchema({ rule: 'INVARIANT_KEY_PROP_CLOSE_UP_REQUIRED' });
    assert.deepEqual(schemaCloseUp.properties.shot_type.enum, ['特写', '大特写', '近景']);

    const schemaAngle = directorAtomicPatchSchema({ rule: 'INVARIANT_SUPPRESSION_ANGLE_MISMATCH' });
    assert.ok(schemaAngle.properties.angle_v.enum.includes('low'));

    const schemaSfx = directorAtomicPatchSchema({ rule: 'INVARIANT_BEAT_AUDIO_IMPACT_MISSING' });
    assert.ok(schemaSfx.properties.sound_effect);
  });
});
