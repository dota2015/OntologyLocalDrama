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
        character_id: 1, name: '露娜', depth_layer: 'midground', screen_position: '画面右侧中景',
        environmental_anchor: '掩体旁', facing: '侧向红狼', expression: '警觉', head_pose: '头部转向红狼',
        gaze: '看向红狼', posture: '半蹲低伏', hands: '右手举起示意撤退', prop_interaction: '', appearance_details: '战术服',
      }],
      last_frame_visuals: [],
      video_slots: {
        timing: { duration: 4 }, performance_contract: 'sync_v1',
        camera: { shot_type: '中景', movement: 'static', movement_description: '固定机位' },
        audio_lip_sync: { mode: 'in_frame_dialogue', speaker_name: '露娜', speaker_in_frame: true, dialogue_content: '撤退！', lip_sync_rule: '口型同步' },
        shots_timeline: [
          { shot_number: 1, timestamp: '0-1', duration: 1, camera: { shot_type: '中景', movement: 'static', movement_description: '固定' }, action: '露娜抬手', result: '手臂抬起', visible_characters: [{ character_id: 1, name: '露娜' }], character_trajectories: [{ character_id: 1, trajectory: '抬手示意撤退', terminal_pose: '手臂抬起', facial_expression: '警觉', facing: '侧向红狼', head_pose: '转向红狼', gaze: '看向红狼', attention_target: '红狼', gaze_motivation: '传达警告', reaction_trigger: '发现危险', mouth_state: '说话' }], audio_lip_sync: { mode: 'in_frame_dialogue', speaker_name: '露娜', speaker_in_frame: true, dialogue_content: '撤退！', lip_sync_rule: '同步' }, speech_action_alignment: { mode: 'concurrent', speech_window: { start: 0, end: 1 }, speaker_action_window: { start: 0, end: 1 }, speaker_action: '抬手', listener_reactions: [] , pause_reason: '' } },
          { shot_number: 1, timestamp: '1-2', duration: 1, camera: { shot_type: '中景', movement: 'static', movement_description: '固定' }, action: '压低身体并抬手指向出口', result: '动作延续', visible_characters: [{ character_id: 1, name: '露娜' }], character_trajectories: [{ character_id: 1, trajectory: '压低身体并抬手指向出口', terminal_pose: '保持半蹲', facial_expression: '警觉', facing: '正对前方', head_pose: '微抬', gaze: '看向前方', attention_target: '危险区域', gaze_motivation: '确认路线', reaction_trigger: '等待转移', mouth_state: '闭合' }], audio_lip_sync: { mode: 'silent_ambient', speaker_name: '', speaker_in_frame: false, dialogue_content: '', lip_sync_rule: '闭口' }, speech_action_alignment: { mode: 'none', speech_window: { start: 1, end: 2 }, speaker_action_window: { start: 1, end: 2 }, speaker_action: '', listener_reactions: [], pause_reason: '' } },
          { shot_number: 1, timestamp: '2-3', duration: 1, camera: { shot_type: '中景', movement: 'static', movement_description: '固定' }, action: '转身抓住出口门框', result: '准备撤退', visible_characters: [{ character_id: 1, name: '露娜' }], character_trajectories: [{ character_id: 1, trajectory: '转身抓住出口门框', terminal_pose: '面向出口', facial_expression: '紧张', facing: '朝向出口', head_pose: '转向出口', gaze: '看向出口', attention_target: '出口', gaze_motivation: '准备撤离', reaction_trigger: '收到回应', mouth_state: '闭合' }], audio_lip_sync: { mode: 'silent_ambient', speaker_name: '', speaker_in_frame: false, dialogue_content: '', lip_sync_rule: '闭口' }, speech_action_alignment: { mode: 'none', speech_window: { start: 2, end: 3 }, speaker_action_window: { start: 2, end: 3 }, speaker_action: '', listener_reactions: [], pause_reason: '' } },
          { shot_number: 1, timestamp: '3-4', duration: 1, camera: { shot_type: '中景', movement: 'static', movement_description: '固定' }, action: '露娜迈向出口', result: '进入撤退动作', visible_characters: [{ character_id: 1, name: '露娜' }], character_trajectories: [{ character_id: 1, trajectory: '迈步靠近出口', terminal_pose: '靠近出口', facial_expression: '坚决', facing: '朝向出口', head_pose: '正向出口', gaze: '看向出口', attention_target: '出口', gaze_motivation: '执行撤退', reaction_trigger: '路线确认', mouth_state: '闭合' }], audio_lip_sync: { mode: 'silent_ambient', speaker_name: '', speaker_in_frame: false, dialogue_content: '', lip_sync_rule: '闭口' }, speech_action_alignment: { mode: 'none', speech_window: { start: 3, end: 4 }, speaker_action_window: { start: 3, end: 4 }, speaker_action: '', listener_reactions: [], pause_reason: '' } },
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
    assert.equal(planned.character_visuals[0].gaze, '看向红狼');
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
        performance_contract: 'sync_v2',
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
    assert.match(inputs[1], /【允许修复字段】\["video_slots"\]/);
    assert.equal(planned.video_slots.shots_timeline[0].character_trajectories[0].mouth_state, 'speaker_synced');
    assert.equal(planned.video_slots.shots_timeline[0].speech_action_alignment.mode, 'concurrent');
  } finally {
    agentsRuntime.runAgent = originalRunAgent;
  }
});
