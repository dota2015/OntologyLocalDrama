const test = require('node:test');
const assert = require('node:assert/strict');
const agentsRuntime = require('../src/services/agentsRuntime');
const {
  enrichSingleStoryboardSlots,
} = require('../src/ontology/directorEnrichmentService');
const {
  ensureDirectorExecutionSlots,
} = require('../src/ontology/directorAgent');

test('directorTwoStageEnrichment: local normalizer does not invent execution semantics', () => {
  const bareShot = {
    id: 99,
    storyboard_number: 1,
    duration: 6,
    dialogue: '露娜: 我们必须立刻撤退！',
    narration: '',
    action: '露娜向红狼发出警告，两人在掩体后戒备',
    result: '红狼点头，准备转移',
    characters: JSON.stringify([1, 2]),
    scene_id: 10,
  };
  const normalized = enrichSingleStoryboardSlots(bareShot);
  assert.deepEqual(normalized.characters, [1, 2]);
  assert.equal(normalized.semantic_slots, undefined);
  assert.equal(normalized.character_visuals, undefined);
  assert.equal(normalized.video_slots, undefined);
  assert.equal(normalized.action, bareShot.action);
  assert.equal(normalized.dialogue, bareShot.dialogue);
});

test('directorTwoStageEnrichment: stage-two whitelist carries the full drama cast and the lock carries offscreen participants', async () => {
  const originalRunAgent = agentsRuntime.runAgent;
  let received;
  agentsRuntime.runAgent = async (_db, _log, options) => {
    received = options;
    return {
      semantic_slots: {
        visible_characters: [{ id: 25, name: '红狼' }],
        background_characters: [],
        offscreen_characters: [{ character_id: 27, name: '露娜', mode: 'remote_voice' }],
      },
    };
  };
  try {
    const source = {
      id: 8, storyboard_number: 12, duration: 4,
      dialogue: '红狼: 收到。', action: '红狼伏在掩体后，耳机里传来露娜的声音',
      characters: [25], scene_id: 10,
      semantic_slots: {
        visible_characters: [{ id: 25, name: '红狼' }],
        background_characters: [],
        offscreen_characters: [{ character_id: 27, name: '露娜', mode: 'remote_voice' }],
        speech_plan: { speaker_id: 25, speaker_name: '红狼', text: '收到。' },
        source_script_excerpt: '红狼: 收到。',
      },
    };
    await assert.rejects(() => ensureDirectorExecutionSlots({}, { info() {}, warn() {} }, source, {
      forceAgent: true,
      maxAttempts: 1,
      catalogs: {
        characters: [{ id: 25, name: '红狼' }, { id: 26, name: '蜂医' }, { id: 27, name: '露娜' }],
        scenes: [{ id: 10, name: '峡谷掩体' }],
        props: [],
      },
    }));
    // 蜂医 (26) plays no part in this shot, but his real ID must still be
    // visible to the Agent; a cropped whitelist is what made it guess 28.
    const whitelistLine = received.input.split('\n').find((line) => line.startsWith('【本体资产白名单】'));
    assert.ok(whitelistLine && whitelistLine.includes('"id":26'), `whitelist must carry the full cast: ${whitelistLine}`);
    assert.ok(received.input.includes('offscreen=[27]'), 'stage-two prompt must carry the locked offscreen participants');
  } finally {
    agentsRuntime.runAgent = originalRunAgent;
  }
});

test('directorTwoStageEnrichment: execution slots schema physically allows offscreen_characters', () => {
  const { directorExecutionSlotsOutputType } = require('../src/services/agentsRuntime');
  const outputType = directorExecutionSlotsOutputType(5, {});
  const semanticProps = outputType.schema.properties.semantic_slots.properties;
  assert.ok(semanticProps.offscreen_characters, 'semantic_slots schema must define offscreen_characters, otherwise constrained decoding can never emit it');
  const modes = semanticProps.offscreen_characters.items.properties.mode.enum;
  assert.deepEqual([...modes].sort(), ['present_offscreen', 'remote_voice']);
});

test('directorTwoStageEnrichment: without a stage-one semantic contract, stage two may author offscreen participants', async () => {
  const originalRunAgent = agentsRuntime.runAgent;
  let received;
  agentsRuntime.runAgent = async (_db, _log, options) => {
    received = options;
    return {
      semantic_slots: {
        visible_characters: [{ id: 25, name: '红狼' }],
        background_characters: [],
        offscreen_characters: [{ character_id: 27, name: '露娜', mode: 'remote_voice' }],
        speech_plan: { speaker_id: 27, speaker_name: '露娜', is_offscreen: true, is_narration: false, text: '红狼，立刻转备用路线！', speed: 1.25, emotion: '急促', audio_references: [] },
        audio_lip_sync: 'offscreen_voiceover',
      },
    };
  };
  try {
    // Base-generation chain shape: top-level roster only, no semantic_slots.
    const source = {
      id: 9, storyboard_number: 22, duration: 4,
      dialogue: '露娜: 红狼，立刻转备用路线！', action: '红狼伏在掩体后按住耳机',
      characters: [25], scene_id: 10,
    };
    let error = null;
    try {
      await ensureDirectorExecutionSlots({}, { info() {}, warn() {} }, source, {
        forceAgent: true,
        maxAttempts: 1,
        catalogs: {
          characters: [{ id: 25, name: '红狼' }, { id: 26, name: '蜂医' }, { id: 27, name: '露娜' }],
          scenes: [{ id: 10, name: '峡谷掩体' }],
          props: [],
        },
      });
    } catch (err) {
      error = err;
    }
    assert.ok(error, 'incomplete mock contract must still be rejected overall');
    assert.ok(received.input.includes('offscreen 阶段一未声明、未锁定'), 'prompt must tell the Agent offscreen is authorable when stage one never declared it');
    assert.equal(error.message.includes('offscreen_characters 应为 []'), false, `offscreen must not be locked to []: ${error.message}`);
    assert.equal(error.message.includes('未出现在任何人物清单'), false, `declared offscreen speaker must satisfy the speaker gate: ${error.message}`);
  } finally {
    agentsRuntime.runAgent = originalRunAgent;
  }
});

test('directorTwoStageEnrichment: execution contract is authored by the Agent and preserves source fields', async () => {
  const originalRunAgent = agentsRuntime.runAgent;
  let received;
  agentsRuntime.runAgent = async (_db, _log, options) => {
    received = options;
    return {
      semantic_slots: {
        visible_characters: [{ id: 1, name: '露娜' }],
        background_characters: [],
        speech_plan: { speaker_id: 1, speaker_name: '露娜', text: '撤退！', is_narration: false },
        sound_plan: { sound_effects: [], bgm_prompt: '', acoustic_env: '室内', is_silent: false },
        continuity_from_previous: { relationship: 'opening', previous_end_state: '', entry_state: '露娜抬手', causal_link: '开场', sound_bridge: '', requires_previous_tail: false },
        source_script_excerpt: '露娜: 撤退！',
        h3_mode: 'ref2va',
        required_references: [{ type: 'scene', id: 10 }, { type: 'character', id: 1 }],
        first_frame_policy: 'none',
        last_frame_policy: 'none',
        shot_duration: 4,
      },
      character_visuals: [{
        character_id: 1, name: '露娜', depth_layer: 'midground', screen_position: 'right_midground',
        environmental_anchor: '掩体旁', facing: 'toward_character', facing_target_id: null,
        head_pose: 'turned_to_target', gaze_type: 'character', gaze_target_id: null, gaze_target_label: '红狼',
        posture: 'crouching', hands_state: 'pointing', hands_object_id: null, hands_target_id: null,
        expression: 'alert', expression_detail: '警觉抬手', appearance_details: '战术服',
      }],
      last_frame_visuals: [],
      video_slots: {
        timing: { duration: 4, pacing: '紧凑' }, performance_contract: 'structured_sync',
        camera: { shot_type: 'medium', angle_h: 'front', angle_v: 'eye_level', angle_s: 'medium', movement: 'static', movement_description: '固定机位' },
        audio_lip_sync: { mode: 'in_frame_dialogue', speaker_name: '露娜', speaker_in_frame: true, delivery_medium: 'direct_speech', dialogue_content: '撤退！', visible_characters_lip_state: 'synchronized_lip', lip_sync_rule: '口型同步' },
        trajectories: [],
        environment_vfx: { lighting_atmosphere: '冷光', physical_phenomena: '', terminal_event: '进入撤退动作' },
        shots_timeline: [
          {
            shot_number: 1, timestamp: null, duration: 4,
            camera: { shot_type: 'medium', movement: 'static', movement_description: '固定' },
            action: '露娜抬手示意并向出口转移', result: '靠近出口准备撤离',
            visible_characters: [{ character_id: 1, name: '露娜' }],
            character_trajectories: [{
              character_id: 1, name: '露娜', start_state: 'crouched',
              action_atom: { action: 'point', action_detail: '抬手示意并迈向出口', body_part: 'right_arm', object_id: null, target_type: 'scene', target_id: null, target_label: '出口', direction: 'forward', contact: 'none' },
              result_state: 'walking', reaction_trigger: { type: 'environment_event', source_id: null, source_label: '发现危险' },
              facing: 'toward_character', facing_target_id: null, head_pose: 'turned_to_target',
              gaze_type: 'character', gaze_target_id: null, gaze_target_label: '红狼',
              posture: 'crouching', hands_state: 'pointing', hands_object_id: null, hands_target_id: null,
              expression: 'alert', expression_detail: '警觉坚决', mouth_state: 'speaker_synced',
            }],
            audio_lip_sync: { mode: 'in_frame_dialogue', speaker_name: '露娜', speaker_in_frame: true, dialogue_content: '撤退！', lip_sync_rule: '同步' },
            speech_action_alignment: { mode: 'concurrent', speech_window: { start: 0, end: 4 }, speaker_character_id: 1, speaker_action_window: { start: 0, end: 4 }, listener_reactions: [], pause_reason: '' },
          },
        ],
      },
    };
  };
  try {
    const source = { id: 7, storyboard_number: 1, duration: 4, dialogue: '露娜: 撤退！', action: '原始动作', characters: [1], scene_id: 10 };
    const planned = await ensureDirectorExecutionSlots({}, { info() {}, warn() {} }, source, { forceAgent: true, maxAttempts: 1 });
    assert.equal(received.name, 'director-execution-slots-planner');
    assert.equal(received.input.includes('本集全部分镜只读上下文'), false);
    assert.equal(received.input.includes('本体资产目录'), false);
    assert.ok(received.input.length < 10000, `stage-two input unexpectedly large: ${received.input.length}`);
    assert.equal(planned.action, '原始动作');
    assert.equal(planned.semantic_slots.source_script_excerpt, '露娜: 撤退！');
    assert.equal(planned.semantic_slots.h3_mode, 'ref2va');
    assert.equal(planned.character_visuals[0].gaze_target_label, '红狼');
  } finally {
    agentsRuntime.runAgent = originalRunAgent;
  }
});

test('directorTwoStageEnrichment: speaker_synced feedback pinpoints mouth_state, surfaces conflict_slots, and stops masking invalid alignment.mode', async () => {
  const originalRunAgent = agentsRuntime.runAgent;
  const inputs = [];
  agentsRuntime.runAgent = async (_db, _log, options) => {
    inputs.push(options.input);
    const baseSegment = {
      shot_number: 11,
      timestamp: '00:00.000',
      duration: 4,
      camera: { shot_type: 'medium', movement: 'static', movement_description: '固定机位' },
      action: '说话人抬手指向右侧发出指令',
      result: '指向完成',
      visible_characters: [{ character_id: 27, name: '说话人A' }],
      character_trajectories: [{
        character_id: 27,
        name: '说话人A',
        start_state: 'crouched',
        action_atom: {
          action: 'shout_command',
          body_part: 'torso',
          object_id: null,
          target_type: 'event',
          target_id: null,
          target_label: '发出指令',
          direction: 'forward',
          contact: 'none',
          action_detail: '抬手并开口喊话',
        },
        result_state: 'crouched',
        reaction_trigger: { type: 'dialogue', source_id: 25, source_label: '对话响应' },
        facing: 'front_camera',
        facing_target_id: null,
        head_pose: 'neutral',
        gaze_type: 'offscreen',
        gaze_target_id: null,
        gaze_target_label: '画外方向',
        posture: 'crouching',
        hands_state: 'pointing',
        hands_object_id: null,
        hands_target_id: null,
        expression: 'determined',
        expression_detail: '神情专注紧迫',
        mouth_state: inputs.length === 1 ? 'closed' : 'speaker_synced',
      }],
      audio_lip_sync: {
        mode: 'in_frame_dialogue',
        speaker_name: '说话人A',
        speaker_in_frame: true,
        dialogue_content: '转备用路线！',
        lip_sync_rule: '口型同步',
      },
      speech_action_alignment: {
        mode: inputs.length === 1 ? 'speaker_synced' : 'concurrent',
        speech_window: { start: 0, end: 4 },
        speaker_action_window: { start: 0, end: 4 },
        speaker_character_id: 27,
        listener_reactions: [],
        pause_reason: '',
      },
    };
    const contract = {
      semantic_slots: {
        visible_characters: [{ id: 27, name: '说话人A' }],
        background_characters: [],
        offscreen_characters: [],
        identity_visibility: 'clear',
        speech_plan: { speaker_id: 27, speaker_name: '说话人A', is_offscreen: false, is_narration: false, text: '转备用路线！', speed: 1, emotion: 'urgent', audio_references: [] },
        sound_plan: { sound_effects: [], bgm_prompt: '', acoustic_env: '户外', is_silent: false },
        continuity_type: 'continuation',
        continuity_from_previous: { relationship: 'continuation', previous_end_state: '蹲伏掩体后', entry_state: '继续蹲伏', causal_link: '承接前镜', sound_bridge: '', requires_previous_tail: false },
        source_script_excerpt: '说话人A: 转备用路线！',
        h3_mode: 'ref2va',
        h3_mode_reason: '需要人物参考',
        first_frame_policy: 'none',
        first_frame_reason: '同场景延续',
        last_frame_policy: 'none',
        last_frame_reason: '自然收束',
        required_references: [{ type: 'scene', id: 10 }, { type: 'character', id: 27 }],
        audio_lip_sync: 'in_frame_dialogue',
        shot_duration: 4,
      },
      character_visuals: [{
        character_id: 27, name: '说话人A', depth_layer: 'foreground', screen_position: 'center_foreground',
        environmental_anchor: '掩体旁', facing: 'front_camera', facing_target_id: null, head_pose: 'neutral',
        gaze_type: 'offscreen', gaze_target_id: null, gaze_target_label: '画外方向', posture: 'crouching',
        hands_state: 'pointing', hands_object_id: null, hands_target_id: null, expression: 'determined',
        expression_detail: '神情专注', appearance_details: '战术装备',
      }],
      last_frame_visuals: [],
      video_slots: {
        timing: { duration: 4, pacing: 'medium' },
        performance_contract: 'structured_sync',
        camera: { shot_type: 'medium', movement: 'static', movement_description: '固定机位' },
        audio_lip_sync: { mode: 'in_frame_dialogue', speaker_name: '说话人A', speaker_in_frame: true, dialogue_content: '转备用路线！', lip_sync_rule: '口型同步' },
        shots_timeline: [baseSegment],
      },
    };
    return inputs.length === 1 ? contract : { repairs: [{ shot_number: 11, patch: { video_slots: contract.video_slots } }] };
  };
  try {
    const source = { id: 11, storyboard_number: 11, duration: 4, dialogue: '说话人A: 转备用路线！', action: '发出指令', characters: [27], scene_id: 10 };
    const planned = await ensureDirectorExecutionSlots({}, { info() {}, warn() {} }, source, {
      forceAgent: true,
      maxAttempts: 2,
      catalogs: { characters: [{ id: 27, name: '说话人A' }], scenes: [{ id: 10, name: '峡谷' }], props: [] },
    });
    assert.equal(inputs.length, 2, 'should converge on attempt 2 once feedback specifies field path');
    assert.match(inputs[1], /character_trajectories\[\]\.mouth_state/);
    assert.match(inputs[1], /冲突字段:.*mouth_state/);
    assert.match(inputs[1], /对白必须与动作同步.*speech_action_alignment\.mode/);
    assert.match(inputs[1], /speech_action_alignment\.mode 必须为 'concurrent'/);
    assert.match(inputs[1], /【允许修复字段】\["video_slots"\]/);
    assert.equal(planned.video_slots.shots_timeline[0].character_trajectories[0].mouth_state, 'speaker_synced');
    assert.equal(planned.video_slots.shots_timeline[0].speech_action_alignment.mode, 'concurrent');
  } finally {
    agentsRuntime.runAgent = originalRunAgent;
  }
});

test('directorTwoStageEnrichment: structured_sync visuals pass VisualSlotCompletenessRule, resolve catalog names in CrossSlot, and lock Ref2VA none policies', () => {
  const { VisualSlotCompletenessRule } = require('../src/ontology/rules/visualSlotCompletenessRule');
  const { CrossSlotInvariantsRule } = require('../src/ontology/rules/crossSlotRules');
  const { directorExecutionSlotsOutputType } = agentsRuntime;

  const semanticProps = directorExecutionSlotsOutputType(6, {}).schema.properties.semantic_slots.properties;
  assert.deepEqual(semanticProps.first_frame_policy, { const: 'none' });
  assert.deepEqual(semanticProps.last_frame_policy, { const: 'none' });

  const shot = {
    shot_number: 2,
    duration: 6,
    scene_id: 10,
    characters: ['角色甲', '角色乙'],
    background_characters: ['群众'],
    dialogue: '角色甲：“现在出发。”',
    narration: '',
    semantic_slots: {
      visible_characters: [{ id: 101, name: '角色甲' }, { id: 102, name: '角色乙' }],
      background_characters: [],
      speech_plan: { speaker_id: 101, speaker_name: '角色甲', is_offscreen: false, is_narration: false, text: '现在出发。', speed: 1, emotion: 'calm', audio_references: [] },
      sound_plan: { sound_effects: ['脚步声'], bgm_prompt: '', acoustic_env: '室内', is_silent: false },
      h3_mode: 'ref2va',
      first_frame_policy: 'none',
      last_frame_policy: 'none',
      required_references: [{ type: 'scene', id: 10 }, { type: 'character', id: 101 }, { type: 'character', id: 102 }],
      audio_lip_sync: 'in_frame_dialogue',
      shot_duration: 6,
    },
    character_visuals: [
      {
        character_id: 101, name: '角色甲', depth_layer: 'foreground', screen_position: 'left_foreground',
        environmental_anchor: '门边', facing: 'front_camera', facing_target_id: null, head_pose: 'lowered',
        gaze_type: 'character', gaze_target_id: 102, gaze_target_label: '角色乙', posture: 'standing',
        hands_state: 'clenched', hands_object_id: null, hands_target_id: null, expression: 'focused',
        expression_detail: '神情沉着', appearance_details: '深色外套',
      },
      {
        character_id: 102, name: '角色乙', depth_layer: 'midground', screen_position: 'right_midground',
        environmental_anchor: '桌旁', facing: 'toward_character', facing_target_id: 101, head_pose: 'neutral',
        gaze_type: 'character', gaze_target_id: 101, gaze_target_label: '角色甲', posture: 'sitting',
        hands_state: 'relaxed', hands_object_id: null, hands_target_id: null, expression: 'alert',
        expression_detail: '注视对方', appearance_details: '浅色衬衫',
      },
    ],
    video_slots: {
      performance_contract: 'structured_sync',
      audio_lip_sync: { mode: 'in_frame_dialogue', speaker_name: '角色甲', speaker_in_frame: true, dialogue_content: '现在出发。', lip_sync_rule: '口型同步' },
    },
  };
  const catalogs = { characters: [{ id: 101, name: '角色甲' }, { id: 102, name: '角色乙' }], scenes: [{ id: 10 }], props: [] };
  const visualViolations = new VisualSlotCompletenessRule().evaluate({ shots: [shot] }).filter((v) => v.severity === 'error');
  assert.deepEqual(visualViolations, []);
  const crossViolations = new CrossSlotInvariantsRule().evaluate({ shots: [shot], catalogs }).filter((v) => v.severity === 'error');
  assert.deepEqual(crossViolations, []);
});

test('directorTwoStageEnrichment: stage one enforces single-speaker splits and flags unresolved multi-speaker/budget shots for repair', async () => {
  const { enforceStoryboardSpeechTiming } = require('../src/services/storyboardSpeechService');
  const { stageOnePlanningViolations } = require('../src/services/episodeStoryboardService');

  const multiSpeakerShort = [{
    shot_number: 1,
    duration: 7,
    characters: ['角色甲', '角色乙'],
    scene_id: 10,
    dialogue: '角色甲：“先走。”角色乙：“等等我！”',
  }];
  let splitCalls = 0;
  const split = await enforceStoryboardSpeechTiming(multiSpeakerShort, {
    durationRange: { min: 4, max: 8 },
    enforceSingleSpeaker: true,
    keepUnresolvedForRepair: true,
    generate: async () => {
      splitCalls += 1;
      return JSON.stringify([
        { shot_number: 1, duration: 4, dialogue: '角色甲：“先走。”', narration: '', action: '角色甲迈步', result: '角色甲起身' },
        { shot_number: 2, duration: 4, dialogue: '角色乙：“等等我！”', narration: '', action: '角色乙伸手呼喊', result: '角色乙追上' },
      ]);
    },
  });
  assert.equal(splitCalls, 1);
  assert.equal(split.length, 2);

  const unresolved = stageOnePlanningViolations(multiSpeakerShort, {
    catalogs: { characters: [{ id: 101, name: '角色甲' }, { id: 102, name: '角色乙' }], scenes: [{ id: 10 }], props: [] },
    durationRange: { min: 4, max: 8 },
  });
  assert.ok(unresolved.some((v) => v.rule === 'INVARIANT_MULTI_SPEAKER_SHOT'));
});

test('directorTwoStageEnrichment: stage-two per-shot gate catches duplicate screen_position and narration mislabeling cleanly', async () => {
  const originalRunAgent = agentsRuntime.runAgent;
  const seenInputs = [];
  agentsRuntime.runAgent = async (_db, _log, options) => {
    seenInputs.push(options.input);
    const attempt = seenInputs.length;
    const visual = (id, name, pos) => ({
      character_id: id, name, depth_layer: 'foreground', screen_position: pos,
      environmental_anchor: '通道旁', facing: 'front_camera', facing_target_id: null, head_pose: 'neutral',
      gaze_type: 'character', gaze_target_id: id === 101 ? 102 : 101, gaze_target_label: '对方',
      posture: 'standing', hands_state: 'free', hands_object_id: null, hands_target_id: null,
      expression: 'focused', expression_detail: '专注', appearance_details: '深色装束',
    });
    const makeSeg = () => ({
      shot_number: 1, timestamp: null, duration: 4,
      camera: { shot_type: 'medium', movement: 'static', movement_description: '固定机位' },
      action: '角色甲边转身看角色乙边开口说话，角色乙随之点头反应',
      result: '双方完成确认',
      visible_characters: [{ character_id: 101, name: '角色甲' }, { character_id: 102, name: '角色乙' }],
      character_trajectories: [
        {
          character_id: 101, name: '角色甲', start_state: 'standing',
          action_atom: { action: 'speak', action_detail: '开口回应对方', body_part: 'head', object_id: null, target_type: 'character', target_id: 102, target_label: '角色乙', direction: 'toward_target', contact: 'none' },
          result_state: 'standing', reaction_trigger: { type: 'dialogue', source_id: 101, source_label: '角色甲' },
          facing: 'front_camera', facing_target_id: null, head_pose: 'neutral', gaze_type: 'character', gaze_target_id: 102, gaze_target_label: '角色乙',
          posture: 'standing', hands_state: 'free', hands_object_id: null, hands_target_id: null, expression: 'focused', expression_detail: '认真', mouth_state: 'speaker_synced',
        },
        {
          character_id: 102, name: '角色乙', start_state: 'standing',
          action_atom: { action: 'react', action_detail: '抬眼看向角色甲并轻点头', body_part: 'head', object_id: null, target_type: 'character', target_id: 101, target_label: '角色甲', direction: 'toward_target', contact: 'none' },
          result_state: 'standing', reaction_trigger: { type: 'dialogue', source_id: 101, source_label: '角色甲' },
          facing: 'toward_character', facing_target_id: 101, head_pose: 'turned_to_target', gaze_type: 'character', gaze_target_id: 101, gaze_target_label: '角色甲',
          posture: 'standing', hands_state: 'relaxed', hands_object_id: null, hands_target_id: null, expression: 'focused', expression_detail: '倾听', mouth_state: 'closed',
        },
      ],
      audio_lip_sync: { mode: 'in_frame_dialogue', speaker_name: '角色甲', speaker_in_frame: true, dialogue_content: '按原计划推进。', lip_sync_rule: '口型同步' },
      speech_action_alignment: { mode: 'concurrent', speech_window: { start: 0, end: 4 }, speaker_action_window: { start: 0, end: 4 }, speaker_character_id: 101, listener_reactions: [{ character_id: 102, action_window: { start: 0, end: 4 }, trajectory_action: 'react' }], pause_reason: '' },
    });
    const contract = {
      semantic_slots: {
        visible_characters: [{ id: 101, name: '角色甲' }, { id: 102, name: '角色乙' }],
        background_characters: [], offscreen_characters: [], identity_visibility: 'full',
        speech_plan: { speaker_id: 101, speaker_name: '角色甲', is_offscreen: false, is_narration: attempt === 1, text: '按原计划推进。', speed: 1, emotion: 'steady', audio_references: [] },
        sound_plan: { sound_effects: [], bgm_prompt: '', acoustic_env: '通道', is_silent: false },
        continuity_type: 'opening',
        continuity_from_previous: { relationship: 'opening', previous_end_state: '', entry_state: '同框站立', causal_link: '开场', sound_bridge: '', requires_previous_tail: false },
        source_script_excerpt: '角色甲: 按原计划推进。',
        h3_mode: 'ref2va', h3_mode_reason: '多参考一致性',
        first_frame_policy: attempt === 1 ? 'match' : 'none', first_frame_reason: 'Ref2VA不用首帧',
        last_frame_policy: 'none', last_frame_reason: '自然收束',
        required_references: [{ type: 'scene', id: 10 }, { type: 'character', id: 101 }, { type: 'character', id: 102 }],
        audio_lip_sync: 'in_frame_dialogue', shot_duration: 4, execution_backend: 'h3_single', continuum_plan: null,
      },
      character_visuals: [
        visual(101, '角色甲', attempt === 1 ? 'center_foreground' : 'left_foreground'),
        visual(102, '角色乙', attempt === 1 ? 'center_foreground' : 'right_foreground'),
      ],
      last_frame_visuals: [],
      video_slots: {
        timing: { duration: 4, pacing: 'medium' },
        performance_contract: 'structured_sync',
        camera: { shot_type: 'medium', movement: 'static', movement_description: '固定' },
        audio_lip_sync: { mode: 'in_frame_dialogue', speaker_name: '角色甲', speaker_in_frame: true, dialogue_content: '按原计划推进。', lip_sync_rule: '口型同步' },
        shots_timeline: [makeSeg()],
      },
    };
    return attempt === 1 ? contract : { repairs: [{ shot_number: 1, patch: { semantic_slots: contract.semantic_slots, character_visuals: contract.character_visuals } }] };
  };
  try {
    const source = { id: 20, storyboard_number: 1, duration: 4, dialogue: '角色甲：“按原计划推进。”', action: '两人交谈', characters: [101, 102], scene_id: 10 };
    const planned = await ensureDirectorExecutionSlots({}, { info() {}, warn() {} }, source, {
      forceAgent: true, maxAttempts: 2,
      catalogs: { characters: [{ id: 101, name: '角色甲' }, { id: 102, name: '角色乙' }], scenes: [{ id: 10, name: '通道' }], props: [] },
    });
    assert.equal(seenInputs.length, 2);
    assert.match(seenInputs[1], /完全相同的构图位置/);
    assert.match(seenInputs[1], /first_frame_policy 必须为 none/);
    assert.match(seenInputs[1], /旁白解说/);
    assert.equal(planned.semantic_slots.first_frame_policy, 'none');
    assert.equal(planned.semantic_slots.speech_plan.is_narration, false);
    assert.notEqual(planned.character_visuals[0].screen_position, planned.character_visuals[1].screen_position);
  } finally {
    agentsRuntime.runAgent = originalRunAgent;
  }
});

test('directorTwoStageEnrichment: execution slots schema locks execution_backend to shot duration', () => {
  const { directorExecutionSlotsOutputType } = require('../src/services/agentsRuntime');
  const shortProps = directorExecutionSlotsOutputType(5, {}).schema.properties.semantic_slots.properties;
  assert.equal(shortProps.shot_duration.const, 5);
  assert.equal(shortProps.execution_backend.const, 'h3_single');
  assert.equal(shortProps.continuum_plan.type, 'null');

  const longProps = directorExecutionSlotsOutputType(12, {}).schema.properties.semantic_slots.properties;
  assert.equal(longProps.shot_duration.const, 12);
  assert.equal(longProps.execution_backend.const, 'h3_continuum');
  assert.equal(longProps.continuum_plan.properties.total_duration.const, 12);
});

test('directorTwoStageEnrichment: stage-two gate rejects h3_continuum on 5s shot and repairs semantic_slots.execution_backend', async () => {
  const { validateVideoSlots } = require('../src/ontology/videoSlots');
  const semanticMismatchViolations = validateVideoSlots(
    {
      shot_number: 1,
      duration: 5,
      semantic_slots: { h3_mode: 'ref2va', execution_backend: 'h3_continuum', continuum_plan: null, visible_characters: [] },
    },
    {
      performance_contract: 'structured_sync',
      timing: { duration: 5, pacing: 'medium' },
      shots_timeline: [],
    },
  );
  const backendError = semanticMismatchViolations.find((v) => v.rule === 'INVARIANT_SINGLE_BACKEND_REQUIRED');
  assert.ok(backendError, 'validateVideoSlots must reject semantic_slots.execution_backend=h3_continuum on 5s shot');
  assert.deepEqual(backendError.conflict_slots, ['semantic_slots.execution_backend', 'semantic_slots.continuum_plan']);

  const crossMismatch = validateVideoSlots(
    {
      shot_number: 1,
      duration: 5,
      semantic_slots: { h3_mode: 'ref2va', execution_backend: 'h3_continuum', continuum_plan: null, visible_characters: [] },
    },
    {
      performance_contract: 'structured_sync',
      execution_backend: 'h3_single',
      timing: { duration: 5, pacing: 'medium' },
      shots_timeline: [],
    },
  );
  assert.ok(crossMismatch.some((v) => v.rule === 'INVARIANT_EXECUTION_BACKEND_CONFLICT'));
});
