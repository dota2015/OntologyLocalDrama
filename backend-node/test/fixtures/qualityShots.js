// Fixed qualitative comparison cases. These never modify production episodes.
const daughter = { character_id: 28, name: '苏晚', screen_position: '画面左侧', facing: '身体侧向右方的父亲', head_pose: '头部向右微低', gaze: '视线落在父亲脸上', posture: '坐在床沿，身体微向父亲倾斜', hands: '右手扶着父亲肩膀', expression: '关切', mouth_state: '双唇自然闭合' };
const father = { character_id: 29, name: '苏承远', screen_position: '画面右侧', facing: '身体侧向左方的女儿', head_pose: '头部朝左微抬', gaze: '视线落在苏晚双眼', posture: '半躺在床上，肩背靠枕', hands: '双手叠放腹前', expression: '疲惫', mouth_state: '双唇自然闭合' };
function trajectory(v, change = {}) {
  return { ...v, start_anchor: v.screen_position, trajectory: '保持姿态安静倾听', terminal_pose: v.posture, facial_expression: v.expression, attention_target: v.gaze, gaze_motivation: '关注对方当前状态', reaction_trigger: '对方的动作与话语', ...change };
}
const cases = [
  { name: 'solo_dialogue', label: '单人对白', people: [{ ...daughter, facing: '身体侧向画面右方', head_pose: '侧头看向右侧门口', gaze: '看着画外门口的弟弟', posture: '站在门边', hands: '双手捧着陶碗' }], text: '别怕，我们回家。', action: '苏晚看着画外弟弟，平静地说话，捧碗站定。' },
  { name: 'two_person_eyeline', label: '双人对视与扶起', people: [daughter, father], text: '爹，我扶您起来。',
    action: '0至3秒苏晚看着父亲说话并托住肩背与上臂，父亲右手撑床配合；3至5秒苏晚扶父亲由半躺转为坐姿；5至6秒父亲坐稳，苏晚保持支撑，观察他的脸色。',
    result: '父亲坐稳床沿，苏晚双手仍支撑肩背和上臂，确认父亲状态。',
    changes: [
      { trajectory: '说话时左手托肩背、右手扶上臂，说完继续扶父亲坐起，坐稳后保持支撑', terminal_pose: '坐在床沿侧身扶稳已经坐起的父亲', posture: '前倾借力扶起父亲再扶稳', hands: '左手托肩背，右手扶上臂', gaze: '看着父亲的脸确认状态', attention_target: '父亲面部与上身', reaction_trigger: '父亲撑床配合起身', gaze_motivation: '确认父亲坐起时身体稳定', mouth_state: '说话时口型同步，台词结束后闭嘴继续扶起动作' },
      { trajectory: '右手撑床配合女儿借力起身，从半躺转为坐姿，坐稳后看向女儿', terminal_pose: '坐稳床沿，上身直立，右手扶住床沿', posture: '由半躺借力转为坐姿', hands: '右手撑床，坐稳后扶住床沿', head_pose: '坐起后侧头看女儿', gaze: '看向苏晚的脸', attention_target: '扶自己起身的苏晚', reaction_trigger: '苏晚托住肩背与上臂', gaze_motivation: '回应女儿的搀扶', facial_expression: '起身时微皱眉，坐稳后放松' },
    ],
    ends: [{ posture: '坐在床沿侧身扶稳父亲', hands: '左手托父亲肩背，右手扶上臂', gaze: '看向父亲面部', head_pose: '侧头朝向父亲面部' }, { posture: '坐稳床沿，上身直立', hands: '右手扶住床沿', gaze: '看向苏晚面部', head_pose: '侧头看向苏晚' }],
  },
  { name: 'event_reaction', label: '事件触发反应', people: [daughter, father], text: '', action: '父亲咳嗽，抬手捂嘴。苏晚立即低头看他的嘴角，皱眉并托住他的肩。', changes: [{ trajectory: '低头看向父亲嘴角，右手托紧肩膀', head_pose: '头部低向父亲嘴角', gaze: '注视父亲嘴角', attention_target: '父亲嘴角', reaction_trigger: '父亲咳嗽', terminal_pose: '托住父亲肩膀', facial_expression: '担忧，眉头收紧' }, { trajectory: '咳嗽并抬手捂嘴', terminal_pose: '右手捂住嘴巴', facial_expression: '眉头紧皱' }] },
  { name: 'continuous_action', label: '连续动作', people: [{ ...daughter, facing: '身体侧向右侧桌面', head_pose: '低头朝向陶碗', gaze: '看着手中陶碗', posture: '站在木桌左侧', hands: '双手捧碗' }], text: '', action: '苏晚把手中陶碗缓慢放到木桌中央，双手松开，目光跟着碗。', changes: [{ trajectory: '双手把陶碗放到桌面', terminal_pose: '碗落在桌面，双手收回身侧', gaze: '视线落在桌上的碗', attention_target: '陶碗', reaction_trigger: '碗接触桌面', facial_expression: '平静专注' }] },
];

module.exports = cases.map(c => {
  const trajectories = c.people.map((v,i) => trajectory(v,c.changes?.[i]));
  const shot = { id: c.name, duration: 6, location: '古代朴素木屋内部，木床与木桌', time: '白天', description: c.action, action: c.action, movement: 'static', shot_type: '中景', angle_h: 'front_left', angle_v: 'eye_level', lighting_style: 'natural', start_framing: '人物与互动目标同框', character_visuals: c.people, last_frame_visuals: c.people.map((v,i) => ({ ...v, posture: trajectories[i].terminal_pose, gaze: trajectories[i].gaze, head_pose: trajectories[i].head_pose })), semantic_slots: { h3_mode: 'ref2va', shot_duration: 6, visible_characters: c.people.map(v => ({ id: v.character_id, name: v.name })), audio_lip_sync: c.text ? 'in_frame_dialogue' : 'silent_ambient', sound_plan: { acoustic_env: c.name === 'event_reaction' ? '室内环境声、父亲短促咳嗽声与衣料摩擦声' : '轻微室内环境声和衣料摩擦声' } } };
  const segment = { shot_number: 1, timestamp: null, duration: 6, camera: { shot_type: '中景', movement: 'static' }, action: c.action, result: c.result || '人物保持动作完成后的状态', character_trajectories: trajectories };
  if (c.ends) shot.last_frame_visuals = c.people.map((v, i) => ({ ...v, ...c.ends[i] }));
  if (c.result) shot.result = c.result;
  const refs = c.people.map(v => ({ character_id: v.character_id, kind: 'character_sheet', source: `ref${v.character_id}.png` })).concat({ kind: 'scene', source: 'scene.png' });
  const speech = { references: c.text ? [{ key: 'character:28', kind: 'dialogue', url: 'voice.wav' }] : [], lines: c.text ? [{ key: 'character:28', kind: 'dialogue', speaker: '苏晚', text: c.text }] : [] };
  return { name: c.name, label: c.label, shot, segment, refs, speech };
});
