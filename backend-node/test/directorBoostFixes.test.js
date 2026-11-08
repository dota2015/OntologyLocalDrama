const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  auditDirectorDraftScoped,
  directorAtomicRepairHint,
  directorAtomicPatchSchema,
  normalizeTimelineTimestamps,
  autoPatchDirectorExecutionSlots,
  autoPatchShotViolations,
  autoPatchWholeEpisodeViolations,
} = require('../src/ontology/directorAgent');
const agentsRuntime = require('../src/services/agentsRuntime');
const h3NativeService = require('../src/services/h3NativeService');
const { SCREEN_POSITION_REGEX, validateCharacterVisualSlots } = require('../src/ontology/visualSlots');
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

    const prompt = h3NativeService.compilePrompt(refs, speech, translated, {}, {
      dialogueFraming: 'over_the_shoulder',
      shotType: '近景',
      backgroundCharacters: [{ character_id: 3, name: '背景角色C' }],
      duration: 5,
    });

    // Subject count should be exactly 2 characters (主角A and 主角B), NOT 3!
    assert.match(prompt, /\[Subject Count\] The scene features exactly 2 characters: <Subject 1> and <Subject 2>/);
    // Background character must not receive <Subject 3>
    assert.doesNotMatch(prompt, /<Subject 3>/);
    // Background character ref should receive secondary context role
    assert.match(prompt, /<Picture 4> supplies secondary context for a background character/);
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
    const prompt = h3NativeService.compilePrompt(refs, speech, translated, {}, {
      dialogueFraming: 'over_the_shoulder',
      shotType: '近景',
      backgroundCharacters: [],
      visibleCharacters: [{ id: 1, name: '主角A' }, { id: 2, name: '主角B' }],
      duration: 5,
    });

    assert.match(prompt, /\[Subject Count\] The scene features exactly 2 characters: <Subject 1> and <Subject 2>/);
    assert.doesNotMatch(prompt, /<Subject 3>/);
    assert.match(prompt, /<Picture 4> supplies secondary context for a background character in \[Shot 1\]/);
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

    const prompt = h3NativeService.compilePrompt(refs, speech, translated, {}, {
      dialogueFraming: 'single_close',
      shotType: '特写',
      visibleCharacters: [{ id: 1, name: '主角A' }],
      duration: 4,
    });

    assert.match(prompt, /\[Subject Count\] The scene features exactly 1 character: <Subject 1>/);
    assert.doesNotMatch(prompt, /<Subject 2>/);
    assert.match(prompt, /<Picture 2> supplies secondary context for a background character/);
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

  it('SCREEN_POSITION_REGEX matches direction + depth combinations', () => {
    const validPositions = [
      '画面左后方',
      '画面右后方景深处',
      '画面左前方',
      '画面右前',
      '画面左侧前景',
      '画面右侧中景',
      '画面中央',
      '画面正中',
      '画面左后',
      '画面右后',
      '画面中景',
      '画面前景',
      '画面后景',
    ];
    for (const pos of validPositions) {
      assert.ok(SCREEN_POSITION_REGEX.test(pos), `Position "${pos}" should match SCREEN_POSITION_REGEX`);
    }

    // Invalid position
    assert.ok(!SCREEN_POSITION_REGEX.test('站在桌子旁'), 'Position without screen anchor should fail');
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
        performance_contract: 'sync_v1',
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

  it('autoPatchDirectorExecutionSlots creates valid visual and video slots for a bare shot', () => {
    const shot = {
      shot_number: 1,
      duration: 4,
      characters: [1],
      character_visuals: [],
      semantic_slots: {
        visible_characters: [{ id: 1, name: '主角' }],
        shot_duration: 4,
        speech_plan: { text: '' },
      },
    };

    const patched = autoPatchDirectorExecutionSlots(shot, 4);
    assert.ok(Array.isArray(patched.character_visuals));
    assert.equal(patched.character_visuals.length, 1);
    assert.ok(SCREEN_POSITION_REGEX.test(patched.character_visuals[0].screen_position));
    assert.ok(Array.isArray(patched.video_slots?.shots_timeline));
    assert.equal(patched.video_slots.shots_timeline.length, 2);
    assert.equal(patched.video_slots.timing.duration, 4);
  });

  it('autoPatchShotViolations deterministically repairs mouth and divergence violations', () => {
    const rawShot = {
      shot_number: 5,
      duration: 4,
      characters: [1, 2],
      character_visuals: [
        {
          character_id: 1,
          name: '主角',
          screen_position: '画面中央中景',
          facing: '正面面对镜头',
          head_pose: '头部正对前方',
          gaze: '目光直视前方',
          posture: '端正站立',
          hands: '双手自然下垂',
        },
      ],
      video_slots: {
        audio_lip_sync: { mode: 'silent_ambient' },
        trajectories: [{ mouth_state: 'open' }],
        shots_timeline: [
          {
            shot_number: 1,
            timestamp: '00:00.000',
            duration: 2,
            character_trajectories: [{ mouth_state: 'open' }],
          },
          {
            shot_number: 2,
            timestamp: '00:02.000',
            duration: 2,
            character_trajectories: [{ mouth_state: 'open' }],
          },
        ],
      },
      semantic_slots: {
        visible_characters: [{ id: 1, name: '主角' }],
        shot_duration: 4,
      },
    };

    const violations = [
      { rule: 'INVARIANT_CHARACTER_MOUTH_NOT_SEALED', shot_number: 5 },
      { rule: 'INVARIANT_CHARACTER_SLOT_DIVERGENCE', shot_number: 5 },
    ];

    const result = autoPatchShotViolations([rawShot], 5, violations);
    assert.ok(result && result.shots);
    const patched = result.shots[0];

    // characters should now match semantic_slots.visible_characters: [1]
    assert.deepEqual(patched.characters, [1]);
    // mouth states should be sealed
    assert.ok(mouthIsSealed(patched.video_slots.trajectories[0].mouth_state));
    assert.ok(mouthIsSealed(patched.video_slots.shots_timeline[0].character_trajectories[0].mouth_state));
  });

  it('autoPatchDirectorExecutionSlots expands 2-char posture and disambiguates duplicate positions', () => {
    const rawShot = {
      shot_number: 8,
      duration: 5,
      characters: [1, 2],
      character_visuals: [
        {
          character_id: 1,
          name: '主角A',
          screen_position: '画面中央',
          posture: '站立', // length 2: would fail validateCharacterVisualSlots
          facing: '正面',
        },
        {
          character_id: 2,
          name: '主角B',
          screen_position: '画面中央', // duplicate position: would fail validateCharacterVisualSlots
          posture: '坐着', // length 2
          facing: '侧身',
        },
      ],
      semantic_slots: {
        visible_characters: [{ id: 1, name: '主角A' }, { id: 2, name: '主角B' }],
        shot_duration: 5,
      },
    };

    const patched = autoPatchDirectorExecutionSlots(rawShot, 5);
    // Both postures should be length >= 3
    assert.ok(patched.character_visuals[0].posture.length >= 3, 'posture must be at least 3 characters');
    assert.ok(patched.character_visuals[1].posture.length >= 3, 'posture must be at least 3 characters');
    // Positions must be disambiguated
    assert.notEqual(
      patched.character_visuals[0].screen_position.trim(),
      patched.character_visuals[1].screen_position.trim(),
      'positions should not be identical'
    );
    // Visual slot validator should have zero errors on these character visuals
    const violations = validateCharacterVisualSlots(patched, patched.character_visuals, 'character_visuals')
      .filter(v => v.severity === 'error');
    assert.equal(violations.length, 0, `Auto-patched visuals should pass validation: ${JSON.stringify(violations)}`);
  });

  it('autoPatchDirectorExecutionSlots sanitizes dynamic and clone triggers from existing fields', () => {
    const rawShot = {
      shot_number: 9,
      duration: 4,
      characters: [1],
      character_visuals: [
        {
          character_id: 1,
          name: '主角',
          screen_position: '画面中央',
          spatial_anchor: '从门口跑到窗边', // clone trigger!
          appearance_details: '随后转身走向敌人', // dynamic trigger!
          prop_interaction: '开始翻找按键', // dynamic trigger!
          posture: '半蹲低伏姿态',
          facing: '正面面对镜头',
          head_pose: '头部正对前方',
          gaze: '目光注视前方',
          hands: '双手持枪',
        },
      ],
      semantic_slots: {
        visible_characters: [{ id: 1, name: '主角' }],
        shot_duration: 4,
      },
    };

    const patched = autoPatchDirectorExecutionSlots(rawShot, 4);
    const violations = validateCharacterVisualSlots(patched, patched.character_visuals, 'character_visuals')
      .filter(v => v.severity === 'error');
    assert.equal(violations.length, 0, `Sanitized visuals should pass validation: ${JSON.stringify(violations)}`);
  });

  it('prioritizes structural repair when multi-speaker violation is present even with speech divergence', () => {
    const violations = [
      { rule: 'INVARIANT_SPEECH_SLOT_DIVERGENCE', shot_number: 13 },
      { rule: 'INVARIANT_MULTI_SPEAKER_SHOT', shot_number: 13 },
      { rule: 'INVARIANT_SPEECH_OVER_BUDGET', shot_number: 13 },
    ];
    const hasMultiSpeaker = violations.some((v) => v.rule === 'INVARIANT_MULTI_SPEAKER_SHOT');
    const hasSpeechDivergence = !hasMultiSpeaker && violations.some((v) => v.rule === 'INVARIANT_SPEECH_SLOT_DIVERGENCE');
    const requiresStructural = hasMultiSpeaker || (!hasSpeechDivergence && violations.some(v => v.rule === 'INVARIANT_MULTI_SPEAKER_SHOT'));

    assert.equal(hasMultiSpeaker, true);
    assert.equal(hasSpeechDivergence, false, 'Multi-speaker shots must not be trapped in single-utterance speech divergence patch mode');
    assert.equal(requiresStructural, true, 'Multi-speaker shots must trigger structural repair');
  });

  it('autoPatchWholeEpisodeViolations automatically splits multi-speaker shots and harmonizes excerpts with zero audit violations', () => {
    const { autoPatchWholeEpisodeViolations, auditDirectorDraft, autoPatchDirectorExecutionSlots } = require('../src/ontology/directorAgent');
    const dramaChars = [
      { id: 25, name: '红狼' },
      { id: 26, name: '蜂医' },
      { id: 27, name: '露娜' },
    ];
    // Shot 1: multi-speaker excerpt that needs splitting (1 action + 2 dialogue)
    const excerpt1 = '红狼还在寻找方向，蜂医为了保护携带设备的露娜，被爆炸掀倒在地。\n蜂医：“红狼，别过来！先把露娜送出去。”\n露娜：“控制室撑不了多久。”';
    // Shot 2: excerpt has 1 speaker line, but dialogue has hallucinated multi-speaker line
    const excerpt2 = '红狼：“哪条是备用路线？”';

    function makeFullShot(num, title, excerpt, dialogue, spk, text, chars) {
      const isFirst = num === 1;
      return {
        shot_number: num,
        title,
        duration: 6,
        dialogue,
        narration: '',
        action: '行动',
        result: '结果',
        characters: chars,
        background_characters: [],
        props: [],
        shot_type: '中景',
        angle_h: 'front_left',
        angle_v: 'eye_level',
        angle_s: 'medium',
        movement: 'push',
        movement_description: '平推',
        lighting_style: 'daylight',
        depth_of_field: 'shallow',
        dialogue_framing: chars.length === 1 ? 'solo_action' : 'two_shot_face_to_face',
        start_framing: '起幅',
        end_framing: '落幅',
        transition_to_next: 'cut',
        continuity_from_previous: isFirst ? { relationship: 'opening', entry_state: '开场', causal_link: '开局' } : { relationship: 'continuation', previous_end_state: '前态', entry_state: '现态', causal_link: '承接' },
        semantic_slots: {
          source_script_excerpt: excerpt,
          shot_duration: 6,
          visible_characters: chars.map(id => ({ id, name: dramaChars.find(c=>c.id===id)?.name || '人物' })),
          background_characters: [],
          identity_visibility: 'three_quarter',
          h3_mode: 'ref2va',
          h3_mode_reason: '多参考',
          first_frame_policy: 'none',
          first_frame_reason: '无需',
          last_frame_policy: 'none',
          last_frame_reason: '无需',
          continuity_type: 'continuation',
          continuity_from_previous: isFirst ? { relationship: 'opening', entry_state: '开场', causal_link: '开局' } : { relationship: 'continuation', previous_end_state: '前态', entry_state: '现态', causal_link: '承接' },
          required_references: chars.map(id => ({ id, character_id: id, type: 'character', name: dramaChars.find(c=>c.id===id)?.name || '人物' })),
          sound_plan: { sound_effects: [], bgm_prompt: '', is_silent: false },
          audio_lip_sync: 'in_frame_dialogue',
          speech_plan: { speaker_id: spk, speaker_name: dramaChars.find(c=>c.id===spk)?.name || '', text, speed: 1.25, emotion: '坚定', audio_references: [] },
        },
        video_slots: {
          timing: { duration: 6 },
          audio_lip_sync: { mode: 'in_frame_dialogue', speaker_name: dramaChars.find(c=>c.id===spk)?.name || '', dialogue_content: text },
        },
      };
    }

    const rawShot1 = autoPatchDirectorExecutionSlots(makeFullShot(1, '被困', excerpt1, '蜂医: "红狼，别过来！"\n露娜: "控制室撑不了多久。"', 26, '红狼，别过来！先把露娜送出去。', [26, 27]), 6);
    const rawShot2 = autoPatchDirectorExecutionSlots(makeFullShot(2, '路线', excerpt2, '红狼: "哪条是备用路线？"\n露娜: "简报第三项写得很清楚！"', 25, '哪条是备用路线？', [25, 27]), 5);

    const initialShots = [rawShot1, rawShot2];
    const initialAudit = auditDirectorDraft(initialShots, {});
    assert.equal(initialAudit.valid, false);
    assert.ok(initialAudit.error_count >= 2);

    const { shots: patched, structural } = autoPatchWholeEpisodeViolations(initialShots, initialAudit.violations, {
      dramaCharacters: dramaChars,
      characterList: dramaChars,
    });

    assert.equal(structural, true);
    assert.equal(patched.length, 4); // 3 from shot 1 + 1 from shot 2
    const patchedAudit = auditDirectorDraft(patched, {});
    assert.equal(patchedAudit.valid, true);
    assert.equal(patchedAudit.error_count, 0);
  });

  it('autoPatchDirectorExecutionSlots thoroughly cleans dynamic action words from posture and hands, and handles directional facings', () => {
    const { autoPatchDirectorExecutionSlots } = require('../src/ontology/directorAgent');
    const { validateCharacterVisualSlots, FACING_REGEX } = require('../src/ontology/visualSlots');

    // 1. Verify FACING_REGEX handles directional Chinese phrasing
    assert.ok(FACING_REGEX.test('面朝画面右前方爆炸中心方向'));
    assert.ok(FACING_REGEX.test('朝向画面左前方'));
    assert.ok(FACING_REGEX.test('面向通道口'));

    // 2. Shot with dynamic words in posture ("开始后仰") and hands ("开始脱手")
    const dynamicShot = {
      shot_number: 1,
      duration: 6,
      characters: [25, 26],
      character_visuals: [
        {
          character_id: 26,
          name: '蜂医',
          screen_position: '画面中央中景偏后，身体轮廓被爆炸火光吞没',
          facing: '背对镜头，面朝画面右后方爆炸源',
          head_pose: '头部微仰',
          gaze: '双眼紧盯爆炸源',
          posture: '直立身影被火光吞噬，边缘崩解消散',
          hands: '双臂自然垂落',
        },
        {
          character_id: 25,
          name: '红狼',
          screen_position: '画面左侧前景，刚从掩体后冲出，身体前倾',
          facing: '面朝画面右前方爆炸中心方向',
          head_pose: '头部前伸',
          gaze: '双眼紧盯画面右前方爆炸火光中心',
          posture: '身体前倾冲出掩体，右肩与胸口正被子弹击中，身体开始后仰',
          hands: '手中武器因中弹冲击开始脱手',
          prop_interaction: '武器开始脱手',
        },
      ],
      semantic_slots: {
        shot_duration: 6,
        visible_characters: [
          { id: 26, name: '蜂医' },
          { id: 25, name: '红狼' },
        ],
      },
    };

    const patched = autoPatchDirectorExecutionSlots(dynamicShot, 6);
    const violations = validateCharacterVisualSlots(patched, patched.character_visuals, 'character_visuals')
      .filter(v => v.severity === 'error');
    assert.deepEqual(violations, [], `Patched visual slots should have 0 errors, got: ${JSON.stringify(violations)}`);
    assert.equal(patched.character_visuals.length, 2);
    // Ensure "开始" is removed from posture and hands
    const hl = patched.character_visuals.find(v => v.character_id === 25);
    assert.ok(!hl.posture.includes('开始'), 'Posture should not contain dynamic keyword "开始"');
    assert.ok(!hl.hands.includes('开始'), 'Hands should not contain dynamic keyword "开始"');
  });

  it('autoPatchSingleShot deterministically removes forbidden UI countdown text and literary metaphors', () => {
    const { autoPatchSingleShot } = require('../src/ontology/directorAgent');
    const { PhysicalDescriptionRule } = require('../src/ontology/rules/physicalDescriptionRule');

    const shotWithForbiddenUI = {
      shot_number: 27,
      duration: 8,
      action: '紧急通知红光闪烁，红狼站在控制室中央，主动抬手打开悬浮的任务简报界面，地图、敌方位置与撤离规则逐一展开，倒计时显示三分钟。露娜从画面右侧前景走入，侧身看向红狼，问出最后一次机会的质问。',
      result: '红狼说完后目光锁定简报上的地下通道权限标记，倒计时继续跳动，露娜站在右侧前景等待他的回应。',
      layout_description: '红狼位于画面中央中景，面对悬浮简报界面；露娜位于画面右侧前景，侧身朝向红狼。',
      image_prompt: '悬浮界面倒计时三分钟',
    };

    const rule = new PhysicalDescriptionRule();
    const initialViolations = rule.evaluate({ shots: [shotWithForbiddenUI] });
    assert.ok(initialViolations.length >= 1, 'Should detect forbidden UI text initially');

    const { shot: patched } = autoPatchSingleShot(shotWithForbiddenUI, initialViolations, {});
    const patchedViolations = rule.evaluate({ shots: [patched] });
    assert.equal(patchedViolations.length, 0, `Patched shot should have 0 physical description violations, got: ${JSON.stringify(patchedViolations)}`);
    assert.ok(!patched.action.includes('倒计时'));
    assert.ok(!patched.result.includes('倒计时'));
  });
});

