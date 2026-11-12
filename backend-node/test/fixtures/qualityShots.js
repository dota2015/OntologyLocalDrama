// Fixed qualitative comparison cases. These never modify production episodes.
const daughter = {
  character_id: 28, name: '苏晚', depth_layer: 'midground', screen_position: 'left_midground',
  environmental_anchor: '床沿旁', facing: 'three_quarter_right', facing_target_id: 29,
  head_pose: 'tilted_down', gaze_type: 'character', gaze_target_id: 29, gaze_target_label: '父亲脸上',
  posture: 'sitting', hands_state: 'supporting_target', hands_object_id: null, hands_target_id: 29,
  expression: 'worried', expression_detail: '关切地扶着父亲肩膀', appearance_details: '朴素布衣', mouth_state: 'closed',
};
const father = {
  character_id: 29, name: '苏承远', depth_layer: 'midground', screen_position: 'right_midground',
  environmental_anchor: '木床上', facing: 'three_quarter_left', facing_target_id: 28,
  head_pose: 'tilted_up', gaze_type: 'character', gaze_target_id: 28, gaze_target_label: '苏晚双眼',
  posture: 'lying', hands_state: 'relaxed', hands_object_id: null, hands_target_id: null,
  expression: 'exhausted', expression_detail: '神情疲惫靠枕', appearance_details: '旧麻布病服', mouth_state: 'closed',
};
function trajectory(v, change = {}) {
  return {
    character_id: v.character_id,
    name: v.name,
    start_state: v.posture === 'lying' ? 'lying' : 'standing',
    action_atom: {
      action: 'listen',
      action_detail: '保持姿态安静倾听',
      body_part: 'eyes',
      object_id: null,
      target_type: 'character',
      target_id: v.character_id === 28 ? 29 : 28,
      target_label: '对方当前状态',
      direction: 'toward_target',
      contact: 'none',
    },
    result_state: v.posture === 'lying' ? 'lying' : 'standing',
    reaction_trigger: { type: 'character_action', source_id: null, source_label: '对方的动作与话语' },
    facing: v.facing,
    facing_target_id: v.facing_target_id,
    head_pose: v.head_pose,
    gaze_type: v.gaze_type,
    gaze_target_id: v.gaze_target_id,
    gaze_target_label: v.gaze_target_label,
    posture: v.posture,
    hands_state: v.hands_state,
    hands_object_id: v.hands_object_id,
    hands_target_id: v.hands_target_id,
    expression: v.expression,
    expression_detail: v.expression_detail,
    mouth_state: v.mouth_state,
    ...change,
  };
}
const cases = [
  {
    name: 'solo_dialogue', label: '单人对白',
    people: [{ ...daughter, facing: 'three_quarter_right', head_pose: 'turned_right', gaze_type: 'offscreen', gaze_target_label: '画外门口的弟弟', posture: 'standing', hands_state: 'holding_object', expression_detail: '平静关切' }],
    text: '别怕，我们回家。',
    action: '苏晚看着画外弟弟，平静地说话，捧碗站定。',
  },
  {
    name: 'two_person_eyeline', label: '双人对视与扶起', people: [daughter, father], text: '爹，我扶您起来。',
    action: '0至3秒苏晚看着父亲说话并托住肩背与上臂，父亲右手撑床配合；3至5秒苏晚扶父亲由半躺转为坐姿；5至6秒父亲坐稳，苏晚保持支撑，观察他的脸色。',
    result: '父亲坐稳床沿，苏晚双手仍支撑肩背和上臂，确认父亲状态。',
    changes: [
      { action_atom: { action: 'support', action_detail: '说话时左手托肩背、右手扶上臂，说完继续扶父亲坐起', body_part: 'both_arms', object_id: null, target_type: 'character', target_id: 29, target_label: '苏承远', direction: 'toward_target', contact: 'shoulder_back' }, result_state: 'supported', mouth_state: 'speaker_synced' },
      { action_atom: { action: 'sit_down', action_detail: '右手撑床配合女儿借力起身坐稳', body_part: 'whole_body', object_id: null, target_type: 'character', target_id: 28, target_label: '苏晚', direction: 'up', contact: 'hand' }, result_state: 'target_sitting_supported', posture: 'sitting', gaze_target_label: '苏晚的脸' },
    ],
    ends: [{ posture: 'sitting', hands_state: 'supporting_target', gaze_target_label: '父亲面部', head_pose: 'turned_to_target' }, { posture: 'sitting', hands_state: 'on_surface', gaze_target_label: '苏晚面部', head_pose: 'turned_to_target' }],
  },
  {
    name: 'event_reaction', label: '事件触发反应', people: [daughter, father], text: '',
    action: '父亲咳嗽，抬手捂嘴。苏晚立即低头看他的嘴角，皱眉并托住他的肩。',
    changes: [
      { action_atom: { action: 'support', action_detail: '低头看向父亲嘴角，右手托紧肩膀', body_part: 'right_hand', object_id: null, target_type: 'character', target_id: 29, target_label: '父亲嘴角', direction: 'toward_target', contact: 'shoulder_back' }, head_pose: 'tilted_down', gaze_target_label: '父亲嘴角', expression: 'worried', expression_detail: '担忧，眉头收紧' },
      { action_atom: { action: 'react', action_detail: '咳嗽并抬手捂嘴', body_part: 'right_hand', object_id: null, target_type: 'event', target_id: null, target_label: '剧烈咳嗽', direction: 'none', contact: 'hand' }, hands_state: 'covering_mouth', expression: 'pain', expression_detail: '眉头紧皱' },
    ],
  },
  {
    name: 'continuous_action', label: '连续动作',
    people: [{ ...daughter, facing: 'toward_object', head_pose: 'lowered', gaze_type: 'prop', gaze_target_label: '手中陶碗', posture: 'standing', hands_state: 'holding_object' }],
    text: '',
    action: '苏晚把手中陶碗缓慢放到木桌中央，双手松开，目光跟着碗。',
    changes: [{ action_atom: { action: 'release', action_detail: '双手把陶碗放到木桌中央', body_part: 'both_hands', object_id: null, target_type: 'prop', target_id: null, target_label: '桌上的陶碗', direction: 'down', contact: 'object_surface' }, result_state: 'object_on_surface', gaze_target_label: '桌上的碗', expression: 'focused', expression_detail: '平静专注' }],
  },
];

module.exports = cases.map(c => {
  const trajectories = c.people.map((v, i) => trajectory(v, c.changes?.[i]));
  const shot = {
    id: c.name, duration: 6, location: '古代朴素木屋内部，木床与木桌', time: '白天',
    description: c.action, action: c.action, movement: 'static', shot_type: '中景',
    angle_h: 'front_left', angle_v: 'eye_level', lighting_style: 'natural',
    start_framing: '人物与互动目标同框', character_visuals: c.people,
    last_frame_visuals: c.people.map((v, i) => ({ ...v, posture: trajectories[i].posture, gaze_target_label: trajectories[i].gaze_target_label, head_pose: trajectories[i].head_pose })),
    semantic_slots: {
      h3_mode: 'ref2va', shot_duration: 6,
      visible_characters: c.people.map(v => ({ id: v.character_id, name: v.name })),
      audio_lip_sync: c.text ? 'in_frame_dialogue' : 'silent_ambient',
      sound_plan: { acoustic_env: c.name === 'event_reaction' ? '室内环境声、父亲短促咳嗽声与衣料摩擦声' : '轻微室内环境声和衣料摩擦声' },
    },
  };
  const segment = { shot_number: 1, timestamp: null, duration: 6, camera: { shot_type: '中景', movement: 'static' }, action: c.action, result: c.result || '人物保持动作完成后的状态', character_trajectories: trajectories };
  if (c.ends) shot.last_frame_visuals = c.people.map((v, i) => ({ ...v, ...c.ends[i] }));
  if (c.result) shot.result = c.result;
  const refs = c.people.map(v => ({ character_id: v.character_id, kind: 'character_sheet', source: `ref${v.character_id}.png` })).concat({ kind: 'scene', source: 'scene.png' });
  const speech = { references: c.text ? [{ key: 'character:28', kind: 'dialogue', url: 'voice.wav' }] : [], lines: c.text ? [{ key: 'character:28', kind: 'dialogue', speaker: '苏晚', text: c.text }] : [] };
  return { name: c.name, label: c.label, shot, segment, refs, speech };
});
