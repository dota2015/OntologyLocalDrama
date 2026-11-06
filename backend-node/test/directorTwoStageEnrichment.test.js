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
    assert.equal(planned.action, '原始动作');
    assert.equal(planned.semantic_slots.source_script_excerpt, '露娜: 撤退！');
    assert.equal(planned.semantic_slots.h3_mode, 'ref2va');
    assert.equal(planned.character_visuals[0].gaze, '看向红狼');
  } finally {
    agentsRuntime.runAgent = originalRunAgent;
  }
});
