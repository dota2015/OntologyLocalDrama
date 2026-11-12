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
const { isGazeOnlyHold, mouthIsSealed, validateVideoSlots } = require('../src/ontology/videoSlots');

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

  it('provides repair hint and explicit patch schema for INVARIANT_CLOSE_DIALOGUE_BACKGROUND_CONFLICT', () => {
    const violation = {
      rule: 'INVARIANT_CLOSE_DIALOGUE_BACKGROUND_CONFLICT',
      shot_number: 5,
      message: '近景双人对话构图声明了背景人物',
    };
    const hint = directorAtomicRepairHint(violation);
    assert.match(hint, /background_characters 设为 \[\]/);
    assert.match(hint, /semantic_slots\.background_characters 设为 \[\]/);

    const schema = directorAtomicPatchSchema(violation, {
      dialogue_framing: 'over_the_shoulder',
      background_characters: [{ character_id: 3, name: '背景人' }],
      character_visuals: [
        { character_id: 1, name: '主角' },
        { character_id: 2, name: '配角' },
        { character_id: 3, name: '背景人', depth_layer: 'background' },
      ],
    });

    assert.ok(schema.properties.background_characters);
    assert.deepEqual(schema.properties.background_characters, { const: [] });
    assert.ok(schema.properties.semantic_slots.properties.background_characters);
    assert.deepEqual(schema.properties.semantic_slots.properties.background_characters, { const: [] });
    assert.ok(schema.properties.character_visuals);
    assert.ok(schema.properties.dialogue_framing);
  });

  it('prunes background characters from Subjects and Subject Count in tight framing (h3NativeService)', () => {
    const refs = [
      { source: 'scene.png', kind: 'scene', character_id: null },
      { source: 'focal1.png', kind: 'character', character_id: 1, name: '主角A' },
      { source: 'focal2.png', kind: 'character', character_id: 2, name: '主角B' },
      { source: 'bg.png', kind: 'character', character_id: 3, name: '背景角色C' },
    ];
    const speech = {
      references: [
        { key: 'character:1', kind: 'dialogue' },
      ],
      lines: [
        { key: 'character:1', kind: 'dialogue', text: '行动开始。' },
      ],
    };
    const translated = {
      visual_description: 'Two characters stand close facing each other over the shoulder in the control room.',
      overall_soundscape: 'Humming server ambience.',
      non_diegetic_music: 'N/A',
      shot_descriptions: [],
    };

    assert.throws(() => h3NativeService.compilePrompt(refs, speech, translated, {}, {
      dialogueFraming: 'over_the_shoulder', shotType: '近景',
      backgroundCharacters: [{ character_id: 3, name: '背景角色C' }], duration: 5,
    }), /未规划的背景人物/);
  });

  it('prunes third character in tight OTS when background_characters is empty (Drama 5 Episode 17 clone scenario)', () => {
    const refs = [
      { source: 'scene.png', kind: 'scene', character_id: null },
      { source: 'focal1.png', kind: 'character', character_id: 1, name: '主角A' },
      { source: 'focal2.png', kind: 'character', character_id: 2, name: '主角B' },
      { source: 'third.png', kind: 'character', character_id: 3, name: '非焦点角色C' },
    ];
    const speech = {
      references: [
        { key: 'character:1', kind: 'dialogue' },
      ],
      lines: [
        { key: 'character:1', kind: 'dialogue', text: '你在说什么？' },
      ],
    };
    const translated = {
      visual_description: 'Two characters face each other over the shoulder in close dialogue.',
      overall_soundscape: 'Tense room tone.',
      non_diegetic_music: 'N/A',
      shot_descriptions: [],
    };

    // In Drama 5 / Episode 17, background_characters was [] (or cleared by agent),
    // but the 3rd character was present in refs (e.g. from episode assets).
    // The compiler must prune character 3 because visible_characters only includes [1, 2].
    assert.throws(() => h3NativeService.compilePrompt(refs, speech, translated, {}, {
      dialogueFraming: 'over_the_shoulder', shotType: '近景', backgroundCharacters: [],
      visibleCharacters: [{ id: 1, name: '主角A' }, { id: 2, name: '主角B' }], duration: 5,
    }), /未规划的背景人物/);
  });

  it('prunes non-focal character in single close framing', () => {
    const refs = [
      { source: 'focal1.png', kind: 'character', character_id: 1, name: '主角A' },
      { source: 'second.png', kind: 'character', character_id: 2, name: '配角B' },
    ];
    const speech = {
      references: [{ key: 'character:1', kind: 'dialogue' }],
      lines: [{ key: 'character:1', kind: 'dialogue', text: '我不相信。' }],
    };
    const translated = {
      visual_description: 'Tight close-up of a character reacting.',
      overall_soundscape: 'Quiet ambience.',
      non_diegetic_music: 'N/A',
      shot_descriptions: [],
    };

    assert.throws(() => h3NativeService.compilePrompt(refs, speech, translated, {}, {
      dialogueFraming: 'single_close', shotType: '特写',
      visibleCharacters: [{ id: 1, name: '主角A' }], duration: 4,
    }), /未规划的背景人物/);
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

  it('patch schema for INVARIANT_CLOSE_DIALOGUE_BACKGROUND_CONFLICT allows shot_type and universal_segment_text', () => {
    const violation = {
      rule: 'INVARIANT_CLOSE_DIALOGUE_BACKGROUND_CONFLICT',
      shot_number: 3,
      message: '近景双人对话构图声明了背景人物',
    };
    const schema = directorAtomicPatchSchema(violation, {
      dialogue_framing: 'over_the_shoulder',
      shot_type: '近景',
    });
    assert.ok(schema.properties.shot_type, 'shot_type should be allowed in patch schema');
    assert.ok(schema.properties.universal_segment_text, 'universal_segment_text should be allowed in patch schema');
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

  it('isGazeOnlyHold correctly detects physical events vs gaze-only holds', () => {
    // Physical verbs should NOT be considered gaze-only hold
    assert.equal(isGazeOnlyHold(['迈步前行，警戒四周']), false);
    assert.equal(isGazeOnlyHold(['起步跟随，保持警惕']), false);
    assert.equal(isGazeOnlyHold(['转头注视说话人并聆听']), false);
    assert.equal(isGazeOnlyHold(['转过头看向受话人']), false);
    assert.equal(isGazeOnlyHold(['向门口走去']), false);
    assert.equal(isGazeOnlyHold(['步入室内']), false);

    // Gaze-only hold without physical actions
    assert.equal(isGazeOnlyHold(['保持视线，沉默不语']), true);
    assert.equal(isGazeOnlyHold(['双眼注视前方，安静等待']), true);
  });

  it('mouthIsSealed accepts natural closed mouth descriptions', () => {
    const sealedStates = [
      '闭合',
      '紧闭',
      '自然闭合',
      '自然闭合，嘴唇抿紧',
      '抿紧闭合',
      '安静闭合',
      '微闭',
      '双唇紧闭',
      '双唇紧闭无口型',
      '咬牙紧闭',
      '无口型',
      'strictly_sealed',
    ];
    for (const state of sealedStates) {
      assert.ok(mouthIsSealed(state), `mouth state "${state}" should be recognized as sealed`);
    }

    const openStates = [
      'speaker_synced',
      '开口说话',
      '微张',
      '大声呼喊',
    ];
    for (const state of openStates) {
      assert.ok(!mouthIsSealed(state), `mouth state "${state}" should NOT be recognized as sealed`);
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
          { character_id: 2, name: '露娜', mouth_state: '自然闭合' },
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
          { character_id: 1, name: '蜂医', mouth_state: '自然闭合' },
          { character_id: 2, name: '露娜', mouth_state: '自然闭合' },
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
          { character_id: 1, name: '蜂医', mouth_state: '自然闭合' },
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

});
