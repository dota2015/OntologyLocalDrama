/**
 * 影视视听本体：视频语义槽位系统（Video Semantic Slots System）
 * 遵循确定性语义槽位契约（Video Slots Contract）原则：
 * 绝不依赖脆弱的正则关键字替换或字符串拼凑，而是通过显式的物理与视听语义槽位组织视频生成提示词：
 * 1. 机位与动态运镜槽位 (camera)
 * 2. 音频与口型控制契约 (audio_lip_sync) —— 彻底根治“画外音/无线电导致画内演员动口型”的行业通病
 * 3. 角色动态轨迹槽位 (trajectories) —— 明确每个角色的物理起点、运动轨迹、终点动作、面部表情与口型状态
 * 4. 环境与物理特效交互 (environment_vfx) —— 将抽象军事术语（如“弹着点”）转化为具体视觉物理现象（飞溅碎石、火星与烟尘）
 * 5. 节奏与时长控制 (timing)
 */

const angleService = require('../services/angleService');
const { stripChineseExclusions } = require('../utils/framePromptSanitize');
const { synthesizeLightingChiaroscuro } = require('./visualSlots');
const { CONTINUUM_MAX_SECONDS, SINGLE_MAX_SECONDS, CONTINUUM_MIN_SECONDS } = require('../services/continuumPlan');
const {
  ACTIONS,
  isStructuredTrajectory,
} = require('./actionAtoms');

// 物理现象与军事术语具象化字典
const PHYSICAL_TRANSLATION_MAP = [
  { regex: /连续弹着点/g, visual: '一连串密集子弹扫射在水泥地面上激起的飞溅碎石、烟尘与火花' },
  { regex: /弹着火星/g, visual: '子弹击地迸发的飞溅火花与烟尘' },
  { regex: /弹着点/g, visual: '子弹击中地面的飞溅碎石与火花' },
  { regex: /弹着/g, visual: '子弹击地' },
];

// H3 的逻辑分镜为 4～30 秒；4～8 秒由普通 H3 执行，9～30 秒由 Continuum 执行。
// 让每个角色在 0–1、1–2 这类窗口里都有可验证的动作合同。
// 不能让一个 5～8 秒的大段把对白后的空白交给模型自由发挥。
const MAX_SHORT_DRAMA_TIMELINE_SEGMENT_SECONDS = 2;

const ACTION_TEXT = Object.freeze({
  hold: '握住', grasp: '抓住', release: '松开', reach: '伸手靠近', touch: '触碰',
  support: '支撑', lift: '抬起', push: '推开', pull: '拉回', turn: '转身',
  walk: '走向', run: '跑向', crouch: '蹲下', stand_up: '站起', sit_down: '坐下',
  fall: '倒下', look: '转头看向', speak: '开口说话', listen: '倾听', react: '作出反应',
  use: '操作', point: '指向', block: '挡住',
});

const STATE_TEXT = Object.freeze({
  neutral: '恢复中性状态', standing_alert: '保持站立戒备', standing: '保持站立', sitting: '保持坐姿',
  lying: '保持躺卧', crouched: '保持蹲伏', walking: '进入行走状态', running: '进入奔跑状态',
  falling: '进入倒下状态', holding: '保持持有状态', gripping: '保持抓握状态', touching: '保持接触',
  reaching: '保持伸手状态', supported: '获得支撑', turned_to_target: '转向目标',
  looking_at_target: '视线落在目标上', weapon_ready: '武器处于待发状态', object_on_surface: '对象落在表面',
  object_released: '对象已松开', target_sitting_supported: '目标被扶稳为坐姿',
});

function resolveAtomRef(atom, field, options = {}) {
  const id = atom?.[field];
  if (id == null) return '';
  const map = options.characterMap || options.propMap;
  if (map && typeof map.get === 'function' && map.get(Number(id))) {
    return String(map.get(Number(id)).name || map.get(Number(id))).trim();
  }
  return `${field === 'object_id' ? '道具' : '目标'}${id}`;
}

function compileActionAtom(atom, options = {}) {
  if (!atom || typeof atom !== 'object') return '';
  const action = String(atom.action || '').trim();
  if (!ACTIONS.includes(action)) return '';
  const objectName = resolveAtomRef(atom, 'object_id', options);
  const targetName = atom.target_label || resolveAtomRef(atom, 'target_id', options);
  const subject = options.actorName || '人物';
  const verb = ACTION_TEXT[action] || action;
  let phrase = `${subject}${verb}`;
  if (action === 'hold' || action === 'grasp' || action === 'release' || action === 'use' || action === 'touch') {
    phrase += objectName || '手中对象';
  } else if (['support', 'lift', 'push', 'pull', 'walk', 'run', 'turn', 'look', 'point', 'block'].includes(action)) {
    phrase += targetName || '目标';
  }
  if (atom.direction && atom.direction !== 'none' && !phrase.includes(targetName || '\u0000')) {
    const direction = { left: '向左', right: '向右', forward: '向前', backward: '向后', up: '向上', down: '向下', toward_target: '朝向目标', away_from_target: '远离目标' }[atom.direction];
    if (direction) phrase += direction;
  }
  return phrase;
}

function compileStructuredTrajectory(trajectory, options = {}) {
  if (!isStructuredTrajectory(trajectory)) return '';
  const actorName = trajectory.name || `角色${trajectory.character_id}`;
  const action = compileActionAtom(trajectory.action_atom, { ...options, actorName });
  const state = STATE_TEXT[trajectory.result_state] || trajectory.result_state || '';
  const gazeTarget = trajectory.gaze_target_label || resolveAtomRef({ target_id: trajectory.gaze_target_id }, 'target_id', options);
  const gaze = gazeTarget ? `，视线落在${gazeTarget}` : '';
  const detail = trajectory.expression_detail ? `，${trajectory.expression_detail}` : '';
  return `${actorName}${action ? action.replace(actorName, '') : '作出反应'}${gaze}${detail}${state ? `，${state}` : ''}`;
}

function structuredEnumError(value, allowed) {
  return !allowed.includes(String(value || '').trim());
}

function validateStructuredExecutionContract(shot, slots) {
  const violations = [];
  const shotNum = shot.shot_number || shot.storyboard_number || 1;
  let semantic = shot.semantic_slots;
  if (typeof semantic === 'string') {
    try { semantic = JSON.parse(semantic); } catch (_) { semantic = {}; }
  }
  semantic = semantic && typeof semantic === 'object' ? semantic : {};
  const visibleIds = (Array.isArray(semantic.visible_characters) ? semantic.visible_characters : [])
    .map((c) => Number(c?.id ?? c)).filter((id) => id > 0);
  const backgroundIds = (Array.isArray(semantic.background_characters) ? semantic.background_characters : [])
    .map((c) => Number(c?.character_id ?? c?.id ?? c)).filter((id) => id > 0);
  const allowedIds = new Set([...visibleIds, ...backgroundIds]);
  let propList = shot.props;
  if (typeof propList === 'string') {
    try { propList = JSON.parse(propList); } catch (_) { propList = []; }
  }
  const referenceProps = Array.isArray(semantic.required_references)
    ? semantic.required_references.filter((item) => item?.type === 'prop').map((item) => Number(item.id)).filter((id) => id > 0)
    : [];
  const props = new Set([
    ...(Array.isArray(propList) ? propList : []).map((item) => Number(item?.id ?? item)).filter((id) => id > 0),
    ...referenceProps,
  ]);
  const add = (rule, path, message, extra = {}) => violations.push({
    rule, shot_number: shotNum, severity: 'error', conflict_slots: [path], message, ...extra,
  });

  const targetValid = (atom, path) => {
    const type = String(atom?.target_type || '');
    const id = atom?.target_id == null ? null : Number(atom.target_id);
    if (type === 'character' && (!Number.isInteger(id) || !allowedIds.has(id))) {
      add('INVARIANT_ACTION_TARGET_INVALID', `${path}.target_id`, `分镜 ${shotNum} 的动作目标角色 ID 无效：${id || '空'}。`);
    }
    if (type === 'prop' && id != null && !props.has(id)) {
      add('INVARIANT_ACTION_TARGET_INVALID', `${path}.target_id`, `分镜 ${shotNum} 的动作目标道具 ID ${id} 不在本镜道具清单中。`);
    }
    if (type !== 'none' && type !== 'event' && type !== 'scene' && id == null) {
      add('INVARIANT_ACTION_TARGET_MISSING', `${path}.target_id`, `分镜 ${shotNum} 的 ${type} 目标必须填写 target_id。`);
    }
    if ((type === 'event' || type === 'scene') && !String(atom?.target_label || '').trim()) {
      add('INVARIANT_ACTION_TARGET_LABEL_MISSING', `${path}.target_label`, `分镜 ${shotNum} 的环境事件或场景目标必须填写 target_label。`);
    }
  };

  const validateTrajectory = (trajectory, path, segmentVisibleIds) => {
    if (!trajectory || typeof trajectory !== 'object') {
      add('INVARIANT_STRUCTURED_TRAJECTORY_EMPTY', path, `分镜 ${shotNum} 的 ${path} 缺少结构化人物轨迹。`);
      return null;
    }
    const id = Number(trajectory.character_id);
    if (!Number.isInteger(id) || !segmentVisibleIds.includes(id)) {
      add('INVARIANT_SHORT_DRAMA_TRAJECTORY_NOT_VISIBLE', `${path}.character_id`, `分镜 ${shotNum} 的轨迹人物 ${id || '空'} 不在本段 visible_characters 中。`, { character_id: id });
    }
    const atom = trajectory.action_atom;
    if (!atom || typeof atom !== 'object') {
      add('INVARIANT_ACTION_ATOM_MISSING', `${path}.action_atom`, `分镜 ${shotNum} 的人物 ${id} 必须填写一个结构化 action_atom。`, { character_id: id });
      return id;
    }
    if (structuredEnumError(atom.action, ACTIONS)) add('INVARIANT_ACTION_ENUM_INVALID', `${path}.action_atom.action`, `分镜 ${shotNum} 的 action 不在允许枚举中：${atom.action || '空'}。`);
    if (structuredEnumError(atom.body_part, require('./actionAtoms').BODY_PARTS)) add('INVARIANT_ACTION_BODY_PART_INVALID', `${path}.action_atom.body_part`, `分镜 ${shotNum} 的 body_part 不在允许枚举中。`);
    if (structuredEnumError(atom.target_type, require('./actionAtoms').TARGET_TYPES)) add('INVARIANT_ACTION_TARGET_TYPE_INVALID', `${path}.action_atom.target_type`, `分镜 ${shotNum} 的 target_type 不在允许枚举中。`);
    if (structuredEnumError(atom.direction, require('./actionAtoms').DIRECTIONS)) add('INVARIANT_ACTION_DIRECTION_INVALID', `${path}.action_atom.direction`, `分镜 ${shotNum} 的 direction 不在允许枚举中。`);
    if (structuredEnumError(atom.contact, require('./actionAtoms').CONTACTS)) add('INVARIANT_ACTION_CONTACT_INVALID', `${path}.action_atom.contact`, `分镜 ${shotNum} 的 contact 不在允许枚举中。`);
    const needsObject = ['hold', 'grasp', 'release', 'use', 'touch'].includes(atom.action);
    const needsTarget = ['support', 'lift', 'push', 'pull', 'walk', 'run', 'turn', 'look', 'point', 'block'].includes(atom.action);
    if (needsObject && !Number.isInteger(Number(atom.object_id))) add('INVARIANT_ACTION_OBJECT_MISSING', `${path}.action_atom.object_id`, `分镜 ${shotNum} 的 ${atom.action} 动作必须填写 object_id。`);
    if (needsTarget && String(atom.target_type || 'none') === 'none') add('INVARIANT_ACTION_TARGET_MISSING', `${path}.action_atom.target_type`, `分镜 ${shotNum} 的 ${atom.action} 动作必须填写目标。`);
    if (Number(atom.target_id) === id && atom.target_type === 'character') add('INVARIANT_ACTION_SELF_TARGET', `${path}.action_atom.target_id`, `分镜 ${shotNum} 的人物不能把自己作为动作目标。`);
    targetValid(atom, `${path}.action_atom`);
    if (structuredEnumError(trajectory.start_state, require('./actionAtoms').STATES)) add('INVARIANT_ACTION_STATE_INVALID', `${path}.start_state`, `分镜 ${shotNum} 的 start_state 不在允许枚举中。`);
    if (structuredEnumError(trajectory.result_state, require('./actionAtoms').STATES)) add('INVARIANT_ACTION_STATE_INVALID', `${path}.result_state`, `分镜 ${shotNum} 的 result_state 不在允许枚举中。`);
    if (!trajectory.reaction_trigger || structuredEnumError(trajectory.reaction_trigger.type, require('./actionAtoms').TRIGGER_TYPES)) add('INVARIANT_ACTION_TRIGGER_INVALID', `${path}.reaction_trigger`, `分镜 ${shotNum} 的 reaction_trigger 不完整或类型无效。`);
    if (structuredEnumError(trajectory.facing, require('./actionAtoms').FACING)) add('INVARIANT_VISUAL_ENUM_INVALID', `${path}.facing`, `分镜 ${shotNum} 的 facing 不在允许枚举中。`);
    if (structuredEnumError(trajectory.head_pose, require('./actionAtoms').HEAD_POSES)) add('INVARIANT_VISUAL_ENUM_INVALID', `${path}.head_pose`, `分镜 ${shotNum} 的 head_pose 不在允许枚举中。`);
    if (structuredEnumError(trajectory.gaze_type, require('./actionAtoms').GAZE_TYPES)) add('INVARIANT_VISUAL_ENUM_INVALID', `${path}.gaze_type`, `分镜 ${shotNum} 的 gaze_type 不在允许枚举中。`);
    if (structuredEnumError(trajectory.posture, require('./actionAtoms').POSTURES)) add('INVARIANT_VISUAL_ENUM_INVALID', `${path}.posture`, `分镜 ${shotNum} 的 posture 不在允许枚举中。`);
    if (structuredEnumError(trajectory.hands_state, require('./actionAtoms').HAND_STATES)) add('INVARIANT_VISUAL_ENUM_INVALID', `${path}.hands_state`, `分镜 ${shotNum} 的 hands_state 不在允许枚举中。`);
    if (structuredEnumError(trajectory.expression, require('./actionAtoms').EXPRESSIONS)) add('INVARIANT_VISUAL_ENUM_INVALID', `${path}.expression`, `分镜 ${shotNum} 的 expression 不在允许枚举中。`);
    if (structuredEnumError(trajectory.mouth_state, require('./actionAtoms').MOUTH_STATES)) add('INVARIANT_VISUAL_ENUM_INVALID', `${path}.mouth_state`, `分镜 ${shotNum} 的 mouth_state 不在允许枚举中。`);
    return id;
  };

  const timeline = Array.isArray(slots.shots_timeline) ? slots.shots_timeline : [];
  const duration = Number(slots.timing?.duration || semantic.shot_duration || shot.duration || 0);
  if (!Number.isInteger(duration) || duration < 4 || duration > CONTINUUM_MAX_SECONDS) {
    add('INVARIANT_SHORT_DRAMA_TIMELINE_DURATION', 'video_slots.timing.duration', `分镜 ${shotNum} 总时长必须是 ${4}～${CONTINUUM_MAX_SECONDS} 的整数秒。`);
  }
  const totalDuration = timeline.reduce((sum, segment) => sum + Number(segment?.duration || 0), 0);
  if (totalDuration !== duration) add('INVARIANT_SHORT_DRAMA_TIMELINE_DURATION', 'video_slots.shots_timeline', `分镜 ${shotNum} 镜内时间轴合计 ${totalDuration} 秒，与总时长 ${duration} 秒不一致。`);
  let expectedStart = 0;
  timeline.forEach((segment, index) => {
    const segmentDuration = Number(segment?.duration || 0);
    if (!Number.isInteger(segmentDuration) || segmentDuration < 1 || segmentDuration > MAX_SHORT_DRAMA_TIMELINE_SEGMENT_SECONDS) {
      add('INVARIANT_SHORT_DRAMA_SEGMENT_PACING', `video_slots.shots_timeline[${index}].duration`, `分镜 ${shotNum} 第 ${index + 1} 段必须是 1～2 个整数秒。`);
    }
    const actualStart = parseTimelineTimestamp(segment?.timestamp);
    if (index > 0 && (actualStart == null || Math.abs(actualStart - expectedStart) > 0.001)) {
      add('INVARIANT_SHORT_DRAMA_TIMELINE_TIMESTAMP', `video_slots.shots_timeline[${index}].timestamp`, `分镜 ${shotNum} 第 ${index + 1} 段时间戳必须连续从 ${formatH3Timestamp(expectedStart)} 开始。`);
    }
    expectedStart += Number.isFinite(segmentDuration) ? segmentDuration : 0;
  });
  const previousStates = new Map();
  timeline.forEach((segment, index) => {
    const segmentVisibleIds = [...new Set((Array.isArray(segment?.visible_characters) ? segment.visible_characters : [])
      .map((c) => Number(c?.character_id ?? c?.id ?? c)).filter((id) => id > 0))];
    if (segmentVisibleIds.length > 2) add('INVARIANT_SHORT_DRAMA_VISIBLE_CHARACTER_LIMIT', `video_slots.shots_timeline[${index}].visible_characters`, `分镜 ${shotNum} 第 ${index + 1} 段最多只能有 2 个有身份人物。`);
    const trajectories = Array.isArray(segment?.character_trajectories) ? segment.character_trajectories : [];
    const trajectoryIds = trajectories.map((t) => Number(t?.character_id)).filter((id) => id > 0);
    if (trajectoryIds.length !== new Set(trajectoryIds).size) add('INVARIANT_SHORT_DRAMA_TRAJECTORY_DUPLICATE', `video_slots.shots_timeline[${index}].character_trajectories`, `分镜 ${shotNum} 第 ${index + 1} 段人物轨迹重复。`);
    trajectories.forEach((trajectory, trajectoryIndex) => {
      const id = validateTrajectory(trajectory, `video_slots.shots_timeline[${index}].character_trajectories[${trajectoryIndex}]`, segmentVisibleIds);
      if (id && previousStates.has(id) && trajectory.start_state !== previousStates.get(id)) {
        add('INVARIANT_ACTION_STATE_DISCONTINUITY', `video_slots.shots_timeline[${index}].character_trajectories[${trajectoryIndex}].start_state`, `分镜 ${shotNum} 第 ${index + 1} 段人物 ${id} 的起始状态 ${trajectory.start_state} 与上一段结果状态 ${previousStates.get(id)} 不一致。`, { character_id: id });
      }
      if (id && trajectory.result_state) previousStates.set(id, trajectory.result_state);
    });
    const dialogue = String(segment?.audio_lip_sync?.dialogue_content || '').trim();
    const alignment = segment?.speech_action_alignment || {};
    if (dialogue) {
      if (alignment.mode !== 'concurrent') add('INVARIANT_SPEECH_ACTION_NOT_CONCURRENT', `video_slots.shots_timeline[${index}].speech_action_alignment.mode`, `分镜 ${shotNum} 第 ${index + 1} 段对白必须与动作同步。`);
      const speakerId = Number(alignment.speaker_character_id || 0);
      const speakerInFrame = segment?.audio_lip_sync?.speaker_in_frame !== false;
      if (speakerInFrame && !speakerId) {
        add('INVARIANT_SPEAKER_ID_MISSING', `video_slots.shots_timeline[${index}].speech_action_alignment.speaker_character_id`, `分镜 ${shotNum} 第 ${index + 1} 段为画内对白，必须填写 speaker_character_id。`);
      }
      if (speakerInFrame && speakerId && !segmentVisibleIds.includes(speakerId)) {
        add('INVARIANT_SPEAKER_NOT_VISIBLE', `video_slots.shots_timeline[${index}].speech_action_alignment.speaker_character_id`, `分镜 ${shotNum} 第 ${index + 1} 段说话人 ${speakerId} 不在 visible_characters 中。`);
      }
      if (segmentVisibleIds.includes(speakerId)) {
        const speaker = trajectories.find((t) => Number(t.character_id) === speakerId);
        if (!speaker) add('INVARIANT_SPEAKER_TRAJECTORY_MISSING', `video_slots.shots_timeline[${index}].character_trajectories`, `分镜 ${shotNum} 第 ${index + 1} 段说话人缺少动作轨迹。`);
        if (speaker && speaker.mouth_state !== 'speaker_synced') add('INVARIANT_SPEAKER_MOUTH_STATE_INVALID', `video_slots.shots_timeline[${index}].character_trajectories[character_id=${speakerId}].mouth_state`, `分镜 ${shotNum} 第 ${index + 1} 段说话人必须使用 speaker_synced。`);
      }
      for (const listener of (Array.isArray(alignment.listener_reactions) ? alignment.listener_reactions : [])) {
        if (!segmentVisibleIds.includes(Number(listener.character_id))) add('INVARIANT_LISTENER_NOT_VISIBLE', `video_slots.shots_timeline[${index}].speech_action_alignment.listener_reactions`, `分镜 ${shotNum} 第 ${index + 1} 段听者不在画面中。`);
        if (!['react', 'listen', 'look', 'support', 'turn'].includes(listener.trajectory_action)) add('INVARIANT_LISTENER_REACTION_INVALID', `video_slots.shots_timeline[${index}].speech_action_alignment.listener_reactions`, `分镜 ${shotNum} 第 ${index + 1} 段听者反应必须选择一个原子动作。`);
      }
    }
  });
  return violations;
}

function translatePhysicalPhenomena(text) {
  if (!text) return '';
  let str = String(text);
  for (const item of PHYSICAL_TRANSLATION_MAP) {
    str = str.replace(item.regex, item.visual);
  }
  return str;
}

// A timeline may describe a quiet reaction, but a two-person dialogue cannot
// spend the whole segment on an unmotivated stare.  This gate catches the
// common "say one line, then look at each other" output while leaving real
// actions (turning, handing, supporting, blocking, sitting, etc.) to the
// Director's semantic plan.
function isGazeOnlyHold(values) {
  const text = values.filter(Boolean).map(value => String(value)).join('，').replace(/[\s\u3000]/gu, '');
  if (!text) return false;
  const hasGaze = /(?:互相|相互|彼此|两人|双方)?(?:看着|对视|凝视|注视|看向|盯着|望着)|保持(?:对视|注视|视线|姿势|安静|倾听|沉默)|视线保持|安静倾听|等待|无动作|保持不动|互看/u.test(text);
  if (!hasGaze) return false;
  // 只把会改变空间关系、身体状态或正在发生的发声/反应视为动作。
  // “站着看”“坐着等待”属于静态姿态，不能用来填满时间段。
  const hasPhysicalEvent = /(?:转身|回头|转头|转过头|抬手|抬眼|抬头|抬起|抬|低头|垂头|俯首|垂首|下沉|耸肩|沉肩|叹气|叹息|轻叹|吸气|吐气|低语|低声|轻声|开合|合上|挥手|伸手|递|接|扶|托|抓|握|按|搭|搭在|搭手|撑|靠|倚|倚靠|贴|指向|指|手指|推|拉|挡|躲|退|冲|跑|走向|走去|步入|迈步|前行|跟上|起步|跟随|同行|进发|坐下|坐起|站起|跪下|躺下|起身|直起|直身|挺直|挺立|俯身|靠近|跌|摔|咳|吐|捂|擦|打开|关闭|拿起|放下|移动|跨|闪身|躲开|收回|离开|皱眉|咬牙|张口|开口|闭眼|闭合|后退|前倾|后仰|点头|摇头|摇晃|颤抖|哭|笑|喊|喘|说|问|答|承认|倾诉|坦白|沉思|扫向|扫视|操作|点击|翻看|记录|滑动|触碰|轻触|整理|持枪|持械|握持|戒备)/u.test(text);
  return !hasPhysicalEvent;
}

function mouthIsSealed(value) {
  const str = String(value || '').trim();
  if (!str) return false;
  if (/(?:开口|张嘴|张口|说话|发声|喊话|大喊|低语|念诵|读出|朗读)/iu.test(str)) {
    return /(?:闭合|紧闭|闭口|闭唇|strictly_sealed)$/iu.test(str);
  }
  return /(?:双唇紧闭|双唇自然闭合|双唇闭合|双唇微闭|双唇紧抿|闭唇|闭口|闭嘴|闭合|紧闭|抿紧|自然闭合|安静闭合|微闭|紧抿|咬牙紧闭|无口型|无说话口型|不说话|喘息|紧抿嘴唇|relaxed closed lips|strictly_sealed|closed(?:_non_speaking| lips)?)/iu.test(str);
}

function parseTimelineTimestamp(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const raw = String(value).trim();
  if (/^0(?:\.0+)?$/.test(raw)) return 0;
  const match = raw.match(/^(?:(\d+):)?(\d{1,2})(?:\.(\d{1,3}))?$/);
  if (!match) return null;
  const minutes = Number(match[1] || 0);
  const seconds = Number(match[2]);
  const millis = Number(String(match[3] || '').padEnd(3, '0') || 0);
  return (minutes * 60) + seconds + (millis / 1000);
}

/**
 * 规范化视频槽位对象结构
 * @param {object} data
 * @returns {object}
 */
function createVideoSemanticSlots(data = {}) {
  const camera = data.camera || {};
  const audio = data.audio_lip_sync || {};
  const env = data.environment_vfx || {};
  const timing = data.timing || {};

  return {
    // sync_v1 is emitted by the current Director contract.  It makes the
    // overlap between speech, the speaker's action, and listener reactions
    // explicit instead of leaving the model to infer temporal order.
    performance_contract: String(data.performance_contract || '').trim(),
    execution_backend: String(data.execution_backend || (Number(timing.duration || 0) >= CONTINUUM_MIN_SECONDS ? 'h3_continuum' : 'h3_single')).trim(),
    continuum_plan: data.continuum_plan && typeof data.continuum_plan === 'object' ? data.continuum_plan : null,
    camera: {
      shot_type: String(camera.shot_type || '中景').trim(),
      angle_h: String(camera.angle_h || 'front').trim(),
      angle_v: String(camera.angle_v || 'eye_level').trim(),
      angle_s: String(camera.angle_s || 'medium').trim(),
      movement: String(camera.movement || 'tracking').trim(),
      movement_description: String(camera.movement_description || '').trim(),
    },
    audio_lip_sync: {
      mode: String(audio.mode || 'silent_ambient').trim(), // 'in_frame_dialogue' | 'offscreen_voiceover' | 'narration' | 'silent_ambient' | 'bgm_only'
      speaker_name: String(audio.speaker_name || '').trim(),
      speaker_in_frame: Boolean(audio.speaker_in_frame),
      delivery_medium: String(audio.delivery_medium || 'direct_speech').trim(), // 'direct_speech' | 'radio_headset' | 'phone_call' | 'intercom' | 'voiceover' | 'narration'
      dialogue_content: String(audio.dialogue_content || '').trim(),
      visible_characters_lip_state: (() => {
        const raw = String(audio.visible_characters_lip_state || '').trim();
        const isSealedMode = !audio.speaker_in_frame || audio.mode === 'offscreen_voiceover' || audio.mode === 'narration' || audio.mode === 'silent_ambient' || audio.mode === 'bgm_only';
        if (isSealedMode) {
          if (raw && (raw === 'strictly_sealed' || /(?:双唇紧闭|双唇自然闭合|双唇闭合|闭唇|闭口|闭合|紧闭|无说话口型|无口型|strictly_sealed)/iu.test(raw))) {
            return 'strictly_sealed';
          }
          return raw || 'strictly_sealed';
        }
        return raw || 'synchronized_lip';
      })(),
      lip_sync_rule: String(audio.lip_sync_rule || '').trim(),
    },
    trajectories: Array.isArray(data.trajectories)
      ? data.trajectories.map((t) => ({
          character_id: t.character_id != null ? Number(t.character_id) : null,
          name: String(t.name || '人物').trim(),
          start_state: String(t.start_state || '').trim(),
          action_atom: t.action_atom && typeof t.action_atom === 'object' ? {
            action: String(t.action_atom.action || '').trim(),
            body_part: String(t.action_atom.body_part || '').trim(),
            object_id: t.action_atom.object_id != null ? Number(t.action_atom.object_id) : null,
            target_type: String(t.action_atom.target_type || 'none').trim(),
            target_id: t.action_atom.target_id != null ? Number(t.action_atom.target_id) : null,
            target_label: String(t.action_atom.target_label || '').trim(),
            direction: String(t.action_atom.direction || 'none').trim(),
            contact: String(t.action_atom.contact || 'none').trim(),
          } : null,
          result_state: String(t.result_state || '').trim(),
          reaction_trigger: t.reaction_trigger && typeof t.reaction_trigger === 'object' ? {
            type: String(t.reaction_trigger.type || 'none').trim(),
            source_id: t.reaction_trigger.source_id != null ? Number(t.reaction_trigger.source_id) : null,
            source_label: String(t.reaction_trigger.source_label || '').trim(),
          } : null,
          facing_target_id: t.facing_target_id != null ? Number(t.facing_target_id) : null,
          gaze_type: String(t.gaze_type || '').trim(),
          gaze_target_id: t.gaze_target_id != null ? Number(t.gaze_target_id) : null,
          gaze_target_label: String(t.gaze_target_label || '').trim(),
          posture: String(t.posture || '').trim(),
          hands_state: String(t.hands_state || '').trim(),
          hands_object_id: t.hands_object_id != null ? Number(t.hands_object_id) : null,
          hands_target_id: t.hands_target_id != null ? Number(t.hands_target_id) : null,
          expression: String(t.expression || '').trim(),
          expression_detail: String(t.expression_detail || '').trim(),
          start_anchor: String(t.start_anchor || '').trim(),
          trajectory: String(t.trajectory || '').trim(),
          end_anchor: String(t.end_anchor || '').trim(),
          terminal_pose: String(t.terminal_pose || t.end_action || '').trim(),
          facial_expression: String(t.facial_expression || t.expression_change || '').trim(),
          facing: String(t.facing || '').trim(),
          head_pose: String(t.head_pose || '').trim(),
          gaze: String(t.gaze || '').trim(),
          attention_target: String(t.attention_target || '').trim(),
          gaze_motivation: String(t.gaze_motivation || '').trim(),
          reaction_trigger: String(t.reaction_trigger || '').trim(),
          mouth_state: String(t.mouth_state || '双唇自然闭合，保持安静倾听状态').trim(),
        }))
      : [],
    environment_vfx: {
      lighting_atmosphere: String(env.lighting_atmosphere || '').trim(),
      physical_phenomena: String(env.physical_phenomena || '').trim(),
      terminal_event: String(env.terminal_event || '').trim(),
    },
    timing: {
      duration: Math.max(1, Math.min(120, Number(timing.duration || 5))),
      pacing: String(timing.pacing || '稳健推进').trim(),
    },
    shots_timeline: Array.isArray(data.shots_timeline)
      ? (() => {
          let runningStart = 0;
          return data.shots_timeline.map((s, idx) => {
            const segDuration = Number(s?.duration || 0);
            const timestamp = idx === 0
              ? (s?.timestamp ? formatH3Timestamp(0) : null)
              : formatH3Timestamp(runningStart);
            runningStart += Number.isFinite(segDuration) ? segDuration : 0;
            return {
              shot_number: s.shot_number || (idx + 1),
              timestamp,
              duration: segDuration,
          camera: {
            shot_type: String(s.camera?.shot_type || '中景').trim(),
            movement: String(s.camera?.movement || 'tracking').trim(),
            movement_description: String(s.camera?.movement_description || '').trim(),
          },
          visible_characters: Array.isArray(s.visible_characters)
            ? s.visible_characters.map((c) => ({
                character_id: c?.character_id != null ? Number(c.character_id) : Number(c?.id),
                name: String(c?.name || '').trim(),
              })).filter((c) => Number.isInteger(c.character_id) && c.character_id > 0)
            : [],
          action: String(s.action || '').trim(),
          result: String(s.result || '').trim(),
          character_trajectories: Array.isArray(s.character_trajectories)
            ? s.character_trajectories.map((t) => ({
                character_id: t.character_id != null ? Number(t.character_id) : null,
                name: String(t.name || '人物').trim(),
                start_state: String(t.start_state || '').trim(),
                action_atom: t.action_atom && typeof t.action_atom === 'object' ? {
                  action: String(t.action_atom.action || '').trim(),
                  body_part: String(t.action_atom.body_part || '').trim(),
                  object_id: t.action_atom.object_id != null ? Number(t.action_atom.object_id) : null,
                  target_type: String(t.action_atom.target_type || 'none').trim(),
                  target_id: t.action_atom.target_id != null ? Number(t.action_atom.target_id) : null,
                  target_label: String(t.action_atom.target_label || '').trim(),
                  direction: String(t.action_atom.direction || 'none').trim(),
                  contact: String(t.action_atom.contact || 'none').trim(),
                } : null,
                result_state: String(t.result_state || '').trim(),
                reaction_trigger: t.reaction_trigger && typeof t.reaction_trigger === 'object' ? {
                  type: String(t.reaction_trigger.type || 'none').trim(),
                  source_id: t.reaction_trigger.source_id != null ? Number(t.reaction_trigger.source_id) : null,
                  source_label: String(t.reaction_trigger.source_label || '').trim(),
                } : null,
                facing_target_id: t.facing_target_id != null ? Number(t.facing_target_id) : null,
                gaze_type: String(t.gaze_type || '').trim(),
                gaze_target_id: t.gaze_target_id != null ? Number(t.gaze_target_id) : null,
                gaze_target_label: String(t.gaze_target_label || '').trim(),
                posture: String(t.posture || '').trim(),
                hands_state: String(t.hands_state || '').trim(),
                hands_object_id: t.hands_object_id != null ? Number(t.hands_object_id) : null,
                hands_target_id: t.hands_target_id != null ? Number(t.hands_target_id) : null,
                expression: String(t.expression || '').trim(),
                expression_detail: String(t.expression_detail || '').trim(),
                start_anchor: String(t.start_anchor || '').trim(),
                trajectory: String(t.trajectory || '').trim(),
                end_anchor: String(t.end_anchor || '').trim(),
                terminal_pose: String(t.terminal_pose || t.end_action || '').trim(),
                facial_expression: String(t.facial_expression || t.expression_change || '').trim(),
                facing: String(t.facing || '').trim(),
                head_pose: String(t.head_pose || '').trim(),
                gaze: String(t.gaze || '').trim(),
                attention_target: String(t.attention_target || '').trim(),
                gaze_motivation: String(t.gaze_motivation || '').trim(),
                reaction_trigger: String(t.reaction_trigger || '').trim(),
                mouth_state: String(t.mouth_state || '双唇自然闭合，保持安静倾听状态').trim(),
                shot_number: s.shot_number || (idx + 1),
              }))
            : [],
          speech_action_alignment: {
            mode: String(s.speech_action_alignment?.mode || '').trim(),
            speech_window: s.speech_action_alignment?.speech_window || null,
            speaker_character_id: s.speech_action_alignment?.speaker_character_id != null
              ? Number(s.speech_action_alignment.speaker_character_id) : null,
            speaker_action_window: s.speech_action_alignment?.speaker_action_window || null,
            speaker_action: String(s.speech_action_alignment?.speaker_action || '').trim(),
            listener_reactions: Array.isArray(s.speech_action_alignment?.listener_reactions)
              ? s.speech_action_alignment.listener_reactions.map((r) => ({
                  character_id: r.character_id != null ? Number(r.character_id) : null,
                  action_window: r.action_window || null,
                  action: String(r.action || '').trim(),
                  trajectory_action: String(r.trajectory_action || '').trim(),
                }))
              : [],
            pause_reason: String(s.speech_action_alignment?.pause_reason || '').trim(),
          },
          audio_lip_sync: {
            mode: String(s.audio_lip_sync?.mode || 'silent_ambient').trim(),
            speaker_name: String(s.audio_lip_sync?.speaker_name || '').trim(),
            speaker_in_frame: Boolean(s.audio_lip_sync?.speaker_in_frame),
            dialogue_content: String(s.audio_lip_sync?.dialogue_content || '').trim(),
            lip_sync_rule: String(s.audio_lip_sync?.lip_sync_rule || '').trim(),
          },
        };
      });
    })()
    : [],
    h3_multimodal: {
      shots: Array.isArray(data.h3_multimodal?.shots)
        ? data.h3_multimodal.shots.map((s, idx) => ({
            shot_number: s.shot_number || (idx + 1),
            timestamp: s.timestamp || (idx === 0 ? null : (s.timestamp ?? '00:03.500')),
            description: String(s.description || '').trim(),
          }))
        : [],
      integrated_multimodal_description: String(data.h3_multimodal?.integrated_multimodal_description || '').trim(),
      overall_soundscape: String(data.h3_multimodal?.overall_soundscape || '').trim(),
      non_diegetic_music: String(data.h3_multimodal?.non_diegetic_music || '').trim(),
    },
  };
}

/**
 * 校验视频语义槽位合法性（硬门禁）
 * @param {object} shot
 * @param {object} slots
 * @returns {Array<object>} 违规列表
 */
function validateVideoSlots(shot, slots) {
  const violations = [];
  const shotNum = shot.shot_number || shot.storyboard_number || 1;

  if (!slots || typeof slots !== 'object') {
    violations.push({
      rule: 'INVARIANT_VIDEO_SLOT_EMPTY',
      shot_number: shotNum,
      severity: 'error',
      message: `分镜 ${shotNum} 缺少视频语义槽位 (video_slots)。`,
    });
    return violations;
  }

  const audio = slots.audio_lip_sync || {};

  // sync_v2 is the structured second-stage contract. It is validated by
  // enums, IDs and state transitions; no Chinese keyword completeness check
  // is used for these execution fields.
  if (slots.performance_contract === 'sync_v2') {
    violations.push(...validateStructuredExecutionContract(shot, slots));
  }

  // Current Director outputs use explicit temporal overlap.  Legacy saved
  // shots without the contract remain readable, but every new sync_v1 shot
  // must state when speech, the speaker's action, and listener reactions
  // happen together.  The backend reports omissions; it never invents or
  // moves actions.
  if (slots.performance_contract === 'sync_v1' && Array.isArray(slots.shots_timeline)) {
    const semantic = typeof shot?.semantic_slots === 'string'
      ? (() => { try { return JSON.parse(shot.semantic_slots); } catch (_) { return {}; } })()
      : (shot?.semantic_slots || {});
    const visible = Array.isArray(semantic.visible_characters)
      ? semantic.visible_characters.map(c => ({ id: Number(c?.id ?? c), name: String(c?.name || '') })).filter(c => c.id > 0)
      : [];
    const speech = semantic.speech_plan || {};
    const speakerId = Number(speech.speaker_id || 0);
    const speakerName = String(speech.speaker_name || audio.speaker_name || '').trim();
    const parseTimestampSeconds = (value) => {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      const text = String(value || '').trim();
      const match = text.match(/^(?:(\d+):)?(\d+)(?:\.(\d+))?$/u);
      if (!match) return 0;
      const minutes = Number(match[1] || 0);
      const seconds = Number(match[2] || 0);
      const fraction = match[3] ? Number(`0.${match[3]}`) : 0;
      return minutes * 60 + seconds + fraction;
    };
    const parseWindow = (value, duration, offset = 0) => {
      const start = Array.isArray(value) ? Number(value[0]) : Number(value?.start);
      const end = Array.isArray(value) ? Number(value[1]) : Number(value?.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start < 0) return null;
      // Agents may express a window relative to its segment (0–2) or on the
      // outer-shot timeline (2–4). Normalize both forms to absolute seconds.
      if (end <= duration) return { start: start + offset, end: end + offset };
      if (start >= offset && end <= offset + duration) return { start, end };
      return null;
    };
    const overlaps = (a, b) => a && b && Math.min(a.end, b.end) > Math.max(a.start, b.start);
    slots.shots_timeline.forEach((segment, index) => {
      const dialogue = String(segment?.audio_lip_sync?.dialogue_content || '').trim();
      if (!dialogue) return;
      const duration = Number(segment?.duration || slots.timing?.duration || shot.duration || 0);
      const segmentOffset = parseTimestampSeconds(segment?.timestamp);
      const alignment = segment.speech_action_alignment || {};
      const base = { shot_number: shotNum, severity: 'error', segment_index: index, conflict_slots: [] };
      if (alignment.mode !== 'concurrent') {
        violations.push({ ...base, rule: 'INVARIANT_SPEECH_ACTION_NOT_CONCURRENT', conflict_slots: [`video_slots.shots_timeline[${index}].speech_action_alignment.mode`], message: `分镜 ${shotNum} 的第 ${index + 1} 段包含对白，但未声明对白与动作同步发生。请使用 mode:"concurrent"，不要把动作默认安排在台词结束后。` });
        return;
      }
      const speechWindow = parseWindow(alignment.speech_window, duration, segmentOffset);
      const actionWindow = parseWindow(alignment.speaker_action_window, duration, segmentOffset);
      if (!speechWindow || !actionWindow || !overlaps(speechWindow, actionWindow) || !String(alignment.speaker_action || '').trim()) {
        violations.push({ ...base, rule: 'INVARIANT_SPEECH_ACTION_OVERLAP_MISSING', conflict_slots: [`video_slots.shots_timeline[${index}].speech_action_alignment`], message: `分镜 ${shotNum} 的第 ${index + 1} 段必须填写有效 speech_window、speaker_action_window 与 speaker_action，且动作时间必须覆盖发声时间的一部分；动作与语音应同时发生。` });
      }
      const segAudio = segment?.audio_lip_sync || {};
      const segSpeakerName = String(segAudio.speaker_name || speech.speaker_name || audio.speaker_name || '').trim();
      const segmentVisibleChars = Array.isArray(segment?.visible_characters)
        ? segment.visible_characters.map(c => ({ id: Number(c?.character_id ?? c?.id ?? c), name: String(c?.name || '') })).filter(c => c.id > 0)
        : visible;
      const segSpeakerId = Number(segAudio.speaker_id || 0)
        || segmentVisibleChars.find(c => c.name && c.name === segSpeakerName)?.id
        || visible.find(c => c.name && c.name === segSpeakerName)?.id
        || (speakerName === segSpeakerName ? speakerId : 0)
        || 0;
      const resolvedSpeaker = segSpeakerId;
      const isSpeakerInFrame = segAudio.speaker_in_frame !== undefined
        ? Boolean(segAudio.speaker_in_frame)
        : Boolean(audio.speaker_in_frame);

      if (isSpeakerInFrame && Array.isArray(segment?.visible_characters)
        && !segmentVisibleChars.some((character) => character.id === resolvedSpeaker || (character.name && character.name === segSpeakerName))) {
        violations.push({
          rule: 'INVARIANT_SHORT_DRAMA_SPEAKER_NOT_VISIBLE',
          shot_number: shotNum,
          severity: 'error',
          segment_index: index,
          conflict_slots: [`video_slots.shots_timeline[${index}].visible_characters`, `video_slots.shots_timeline[${index}].audio_lip_sync.speaker_name`],
          message: `分镜 ${shotNum} 的第 ${index + 1} 段声明画内说话人「${segSpeakerName || resolvedSpeaker}」，但该人物不在本段 visible_characters 中；请改为画外音或把说话人纳入本段构图。`,
        });
      }
      if (isSpeakerInFrame && segmentVisibleChars.length > 1) {
        for (const listener of segmentVisibleChars.filter(c => c.id !== resolvedSpeaker && c.name !== segSpeakerName)) {
          const reaction = (Array.isArray(alignment.listener_reactions) ? alignment.listener_reactions : []).find(r =>
            Number(r?.character_id) === listener.id || (r?.name && r?.name === listener.name)
          );
          const reactionWindow = parseWindow(reaction?.action_window, duration, segmentOffset);
          if (!reaction || !String(reaction.action || '').trim() || !overlaps(speechWindow, reactionWindow)) {
            violations.push({ ...base, rule: 'INVARIANT_LISTENER_REACTION_OVERLAP_MISSING', character_id: listener.id, conflict_slots: [`video_slots.shots_timeline[${index}].speech_action_alignment.listener_reactions[character_id=${listener.id}]`], message: `分镜 ${shotNum} 的第 ${index + 1} 段中，角色「${listener.name || listener.id}」缺少与对白同步的听取/视线/动作反应。请写明 action 与 action_window，不能只写“说完后等待”。` });
          }
        }
      }
    });
  }
  // 1. 画外音与口型契约校验（严格防止画内演员动嘴）
  const isVoiceover = audio.mode === 'offscreen_voiceover' || (Boolean(audio.dialogue_content) && !audio.speaker_in_frame);
  if (isVoiceover) {
    const isLipStateSealed = audio.visible_characters_lip_state === 'strictly_sealed'
      || /(?:双唇紧闭|双唇自然闭合|双唇闭合|闭唇|闭口|闭合|紧闭|无说话口型|无口型|strictly_sealed)/iu.test(String(audio.visible_characters_lip_state || ''));
    if (audio.dialogue_content && !isLipStateSealed) {
      violations.push({
        rule: 'INVARIANT_OFFSCREEN_LIP_SYNC_VIOLATION',
        shot_number: shotNum,
        severity: 'error',
        message: `分镜 ${shotNum} 台词为画外音/无线电，必须把 video_slots.audio_lip_sync.visible_characters_lip_state 精确设为 strictly_sealed；顶层 audio_lip_sync 字符串不是视频执行槽位。`,
      });
    }

    if (Array.isArray(slots.trajectories)) {
      slots.trajectories.forEach((traj) => {
        if (traj?.mouth_state !== 'offscreen_sealed' && !mouthIsSealed(traj?.mouth_state)) {
          violations.push({
            rule: 'INVARIANT_CHARACTER_MOUTH_NOT_SEALED',
            shot_number: shotNum,
            severity: 'error',
            message: `分镜 ${shotNum} 画外音模式下，角色「${traj.name}」的口型槽位必须明确声明双唇紧闭无口型！`,
          });
        }
      });
    }
  }

  // 2. 轨迹完整性校验
  if (Array.isArray(slots.trajectories)) {
    slots.trajectories.forEach((traj) => {
      if (!traj.start_anchor || !traj.trajectory) {
        violations.push({
          rule: 'INVARIANT_TRAJECTORY_INCOMPLETE',
          shot_number: shotNum,
          severity: 'warning',
          message: `分镜 ${shotNum} 角色「${traj.name}」的物理轨迹槽位不完整（需包含起止点与运动过程）。`,
        });
      }
    });
  }

  // 3. 短剧镜内剪辑节奏与多人反应契约。导演必须显式规划，执行层不猜。
  let semantic = shot?.semantic_slots;
  if (typeof semantic === 'string') {
    try { semantic = JSON.parse(semantic); } catch (_) { semantic = null; }
  }
  const isH3Planned = semantic && ['fl2va', 'ref2va'].includes(semantic.h3_mode);
  if (isH3Planned && slots.performance_contract !== 'sync_v2') {
    // 旧数据没有 performance_contract 时仍可读取；只有新 Agent 明确提交
    // sync_v1，才启用 1～2 秒动作窗口与逐角色动作门禁。
    const hasTimedPerformanceContract = slots.performance_contract === 'sync_v1';
    const duration = Number(slots.timing?.duration || semantic.shot_duration || shot.duration || 0);
    if (!Number.isInteger(duration) || duration < 4 || duration > CONTINUUM_MAX_SECONDS) {
      violations.push({ rule: 'INVARIANT_SHORT_DRAMA_TIMELINE_DURATION', shot_number: shotNum, severity: 'error', message: `分镜 ${shotNum} 总时长必须为4～${CONTINUUM_MAX_SECONDS}整数秒，当前为 ${duration} 秒。` });
    }
    const executionBackend = String(slots.execution_backend || slots.executionBackend || '').toLowerCase();
    if (duration > SINGLE_MAX_SECONDS && executionBackend !== 'h3_continuum') {
      violations.push({ rule: 'INVARIANT_CONTINUUM_BACKEND_REQUIRED', shot_number: shotNum, severity: 'error', message: `分镜 ${shotNum} 为 ${duration} 秒，必须使用 execution_backend="h3_continuum"。普通 H3 仅支持4～8秒。` });
    }
    if (duration <= SINGLE_MAX_SECONDS && executionBackend === 'h3_continuum') {
      violations.push({ rule: 'INVARIANT_SINGLE_BACKEND_REQUIRED', shot_number: shotNum, severity: 'error', message: `分镜 ${shotNum} 为 ${duration} 秒，应使用 execution_backend="h3_single"。Continuum 从9秒开始。` });
    }
    if (duration >= CONTINUUM_MIN_SECONDS && executionBackend === 'h3_continuum' && slots.continuum_plan?.total_duration != null && Number(slots.continuum_plan.total_duration) !== duration) {
      violations.push({ rule: 'INVARIANT_CONTINUUM_DURATION_MISMATCH', shot_number: shotNum, severity: 'error', message: `分镜 ${shotNum} 的 continuum_plan.total_duration 必须等于 ${duration} 秒。` });
    }
    const timeline = Array.isArray(slots.shots_timeline) ? slots.shots_timeline : [];
    const visibleIds = (Array.isArray(semantic.visible_characters) ? semantic.visible_characters : [])
      .map(c => Number(c && typeof c === 'object' ? c.id : c)).filter(id => id > 0);
    const backgroundIds = (Array.isArray(semantic.background_characters) ? semantic.background_characters : [])
      .map(c => Number(c && typeof c === 'object' ? (c.character_id ?? c.id) : c)).filter(id => id > 0);
    const allowedSegmentIds = new Set([...visibleIds, ...backgroundIds]);
    const minSegments = hasTimedPerformanceContract
      ? Math.ceil(duration / MAX_SHORT_DRAMA_TIMELINE_SEGMENT_SECONDS)
      : 1;
    if (timeline.length < minSegments) {
      violations.push({
        rule: 'INVARIANT_SHORT_DRAMA_TIMELINE_MISSING',
        shot_number: shotNum,
        severity: 'error',
        message: hasTimedPerformanceContract
          ? `分镜 ${shotNum} 为 ${duration || '未知'} 秒片段，必须由导演 Agent 拆成至少 ${minSegments} 个连续动作段；每段使用整数秒并覆盖完整时长，禁止留出未约束时长或由执行层自动均分。`
          : `分镜 ${shotNum} 缺少导演 Agent 规划的镜内时间线，必须至少提供一个时间段。`,
      });
    } else {
      const total = timeline.reduce((sum, segment) => sum + Number(segment?.duration || 0), 0);
      if (total !== duration) {
        violations.push({
          rule: 'INVARIANT_SHORT_DRAMA_TIMELINE_DURATION',
          shot_number: shotNum,
          severity: 'error',
          message: `分镜 ${shotNum} 镜内剪辑段合计 ${total} 秒，与分镜总时长 ${duration} 秒不一致。`,
        });
      }
      let expectedStart = 0;
      timeline.forEach((segment, index) => {
        const segmentDuration = Number(segment?.duration || 0);
        const maxSegmentDuration = hasTimedPerformanceContract
          ? MAX_SHORT_DRAMA_TIMELINE_SEGMENT_SECONDS
          : duration;
        if (!Number.isInteger(segmentDuration) || segmentDuration < 1 || segmentDuration > maxSegmentDuration) {
          violations.push({
            rule: 'INVARIANT_SHORT_DRAMA_SEGMENT_PACING',
            shot_number: shotNum,
            severity: 'error',
            message: hasTimedPerformanceContract
              ? `分镜 ${shotNum} 的镜内剪辑段 ${index + 1} 时长为 ${segmentDuration} 秒，必须是 1～2 个整数秒；请按连续窗口规划。`
              : `分镜 ${shotNum} 的镜内剪辑段 ${index + 1} 时长为 ${segmentDuration} 秒，必须是正整数秒且不超过本镜总时长。`,
          });
        }
        if (hasTimedPerformanceContract) {
          const actualStart = parseTimelineTimestamp(segment?.timestamp);
          const timestampValid = index === 0
            ? (actualStart == null || Math.abs(actualStart) < 0.001)
            : (actualStart != null && Math.abs(actualStart - expectedStart) < 0.001);
          if (!timestampValid) {
            violations.push({
              rule: 'INVARIANT_SHORT_DRAMA_TIMELINE_TIMESTAMP',
              shot_number: shotNum,
              severity: 'error',
              segment_index: index,
              conflict_slots: [`video_slots.shots_timeline[${index}].timestamp`],
              message: index === 0
                ? `分镜 ${shotNum} 的第 1 段必须从 0 秒开始（timestamp 可为 null 或 00:00.000）。`
                : `分镜 ${shotNum} 的第 ${index + 1} 段 timestamp 必须为 ${formatH3Timestamp(expectedStart)}，与前面动作段连续，不能留空或跳时。`,
            });
          }
        }
        expectedStart += Number.isFinite(segmentDuration) ? segmentDuration : 0;
        const trajectories = Array.isArray(segment?.character_trajectories) ? segment.character_trajectories : [];
        const segmentVisible = Array.isArray(segment?.visible_characters) ? segment.visible_characters : null;
        const segmentVisibleIds = segmentVisible
          ? segmentVisible.map((character) => Number(character && typeof character === 'object'
            ? (character.character_id ?? character.id)
            : character)).filter(id => id > 0)
          : [];
        if (hasTimedPerformanceContract && !segmentVisible) {
          violations.push({
            rule: 'INVARIANT_SHORT_DRAMA_VISIBLE_CHARACTERS_MISSING',
            shot_number: shotNum,
            severity: 'error',
            segment_index: index,
            conflict_slots: [`video_slots.shots_timeline[${index}].visible_characters`],
            message: `分镜 ${shotNum} 的第 ${index + 1} 段缺少 visible_characters。请先声明本段实际入画人物，再为这些人物填写轨迹；特写可以只列一个人物。`,
          });
        }
        const uniqueSegmentVisibleIds = [...new Set(segmentVisibleIds)];
        if (hasTimedPerformanceContract && uniqueSegmentVisibleIds.length !== segmentVisibleIds.length) {
          violations.push({
            rule: 'INVARIANT_SHORT_DRAMA_VISIBLE_CHARACTERS_DUPLICATE',
            shot_number: shotNum,
            severity: 'error',
            segment_index: index,
            conflict_slots: [`video_slots.shots_timeline[${index}].visible_characters`],
            message: `分镜 ${shotNum} 的第 ${index + 1} 段 visible_characters 含重复人物，必须每人只列一次。`,
          });
        }
        const unknownVisibleIds = uniqueSegmentVisibleIds.filter(id => !allowedSegmentIds.has(id));
        if (unknownVisibleIds.length) {
          violations.push({
            rule: 'INVARIANT_SHORT_DRAMA_VISIBLE_CHARACTER_UNKNOWN',
            shot_number: shotNum,
            severity: 'error',
            segment_index: index,
            conflict_slots: [`video_slots.shots_timeline[${index}].visible_characters`],
            message: `分镜 ${shotNum} 的第 ${index + 1} 段声明了不在本镜人物清单中的画内角色 ID：${unknownVisibleIds.join('、')}。`,
          });
        }
        const expectedSegmentIds = hasTimedPerformanceContract ? uniqueSegmentVisibleIds : (segmentVisible ? uniqueSegmentVisibleIds : visibleIds);
        const trajectoryIds = [...new Set(trajectories.map(item => Number(item?.character_id)).filter(id => id > 0))];
        const extraTrajectoryIds = trajectoryIds.filter(id => !expectedSegmentIds.includes(id));
        if (hasTimedPerformanceContract && extraTrajectoryIds.length) {
          violations.push({
            rule: 'INVARIANT_SHORT_DRAMA_TRAJECTORY_NOT_VISIBLE',
            shot_number: shotNum,
            severity: 'error',
            segment_index: index,
            conflict_slots: [`video_slots.shots_timeline[${index}].character_trajectories`],
            message: `分镜 ${shotNum} 的第 ${index + 1} 段轨迹包含未入画人物 ID：${extraTrajectoryIds.join('、')}；特写或过肩镜头只能描述 visible_characters。`,
          });
        }
        const segmentDialogue = String(segment?.audio_lip_sync?.dialogue_content || '').trim();
        if (hasTimedPerformanceContract && (!String(segment?.action || '').trim() || !String(segment?.result || '').trim())) {
          violations.push({
            rule: 'INVARIANT_SHORT_DRAMA_BEAT_CONTRACT_MISSING',
            shot_number: shotNum,
            severity: 'error',
            segment_index: index,
            conflict_slots: [`video_slots.shots_timeline[${index}].action`, `video_slots.shots_timeline[${index}].result`],
            message: `分镜 ${shotNum} 的第 ${index + 1} 个时间段必须同时写明本段实际 action 和 result，不能只靠机位或台词填时长。`,
          });
        }
        if (hasTimedPerformanceContract && isGazeOnlyHold([
          segment?.action,
          segment?.result,
          ...trajectories.flatMap(item => [item?.trajectory, item?.terminal_pose, item?.facial_expression]),
          ...(segment?.speech_action_alignment?.listener_reactions || []).map(item => item?.action),
        ])) {
          violations.push({
            rule: 'INVARIANT_SHORT_DRAMA_INTERACTION_BEAT_EMPTY',
            shot_number: shotNum,
            severity: 'error',
            segment_index: index,
            conflict_slots: [`video_slots.shots_timeline[${index}].action`, `video_slots.shots_timeline[${index}].result`, `video_slots.shots_timeline[${index}].character_trajectories`],
            message: `分镜 ${shotNum} 的第 ${index + 1} 段只有“互相看着/对视/等待”等静态描述，缺少可执行的剧情动作或反应。请把本段改成实际发生的物理动作、互动、移动或事件结果；没有后续事件就让该镜在事件结束处收束，不得用注视填时长。`,
          });
        }
        for (const id of expectedSegmentIds) {
          const trajectory = trajectories.find(t => Number(t?.character_id) === id);
          const missingFields = ['trajectory', 'terminal_pose', 'facial_expression', 'facing', 'head_pose',
            'gaze', 'attention_target', 'gaze_motivation', 'reaction_trigger'].filter(field => {
              const value = trajectory?.[field]
                || (field === 'terminal_pose' ? trajectory?.end_action : '')
                || (field === 'facial_expression' ? trajectory?.expression_change : '');
              return !String(value || '').trim();
            });
          if (missingFields.length) {
            const targetPath = `video_slots.shots_timeline[${index}].character_trajectories[character_id=${id}]`;
            violations.push({
              rule: 'INVARIANT_SHORT_DRAMA_CHARACTER_REACTION_MISSING',
              shot_number: shotNum,
              severity: 'error',
              character_id: id,
              segment_index: index,
              missing_fields: missingFields,
              conflict_slots: missingFields.map(field => `${targetPath}.${field}`),
              message: `分镜 ${shotNum} 的镜内剪辑段 ${index + 1} 未给画内角色 ID ${id} 补齐执行字段：${missingFields.join('、')}。必须修复 ${targetPath} 下的这些确切字段；动作字段名是 trajectory，不是 visible_action，也不是顶层 video_slots.trajectories。其他已有字段保留。`,
            });
          }
          const isSpeakingInSegment = segmentDialogue && String(segment?.audio_lip_sync?.speaker_name || '').trim() === String(trajectory?.name || '').trim();
          const listenerReaction = (segment?.speech_action_alignment?.listener_reactions || []).find(r => Number(r?.character_id) === id);
          if (hasTimedPerformanceContract && trajectory && !isSpeakingInSegment && isGazeOnlyHold([
            trajectory.trajectory,
            trajectory.terminal_pose,
            trajectory.facial_expression,
            trajectory.reaction_trigger,
            listenerReaction?.action,
          ])) {
            violations.push({
              rule: 'INVARIANT_SHORT_DRAMA_CHARACTER_ACTION_EMPTY',
              shot_number: shotNum,
              severity: 'error',
              character_id: id,
              segment_index: index,
              conflict_slots: [`video_slots.shots_timeline[${index}].character_trajectories[character_id=${id}].trajectory`],
              message: `分镜 ${shotNum} 的第 ${index + 1} 段中角色 ID ${id} 只有凝视、等待或静止描述，没有本段可执行的动作/反应；请写明与对白或事件同步的身体、表情或互动变化。`,
            });
          }
        }
      });
    }
  }

  // 4. 抽象军事术语排查（必须具象为视觉物理现象）
  const fullText = JSON.stringify(slots);
  if (/(?:连续弹着点|弹着火星|弹着点)/.test(fullText)) {
    violations.push({
      rule: 'INVARIANT_ABSTRACT_PHYSICAL_JARGON',
      shot_number: shotNum,
      severity: 'warning',
      message: `分镜 ${shotNum} 包含未具象化的军事术语（如弹着点），视频模型无法理解抽象名词，必须具象化为“飞溅碎石、火花与烟尘”！`,
    });
  }

  return violations;
}

/**
 * 旧版派生文本编译器；原生 H3 提交不再使用或持久化该文本。
 * @param {object} shot
 * @param {object} slots
 * @param {object} options
 * @returns {string}
 */
function compileVideoPromptFromSlots(shot, slots, options = {}) {
  const normSlots = createVideoSemanticSlots(slots);
  const parts = [];

  // 1. 场景与标题
  if (shot.scene_description) {
    parts.push('场景：' + stripChineseExclusions(shot.scene_description));
  } else if (shot.location) {
    const loc = shot.time ? `${shot.location}，${shot.time}` : shot.location;
    parts.push('场景：' + stripChineseExclusions(loc));
  }
  if (shot.title) parts.push('镜头标题：' + stripChineseExclusions(shot.title));

  // 2. 角色外貌造型注入（角色外貌合同）与出场人数铁律
  if (shot.characters) {
    try {
      const charList = typeof shot.characters === 'string' ? JSON.parse(shot.characters) : shot.characters;
      if (Array.isArray(charList) && charList.length > 0) {
        let visualsList = shot.character_visuals;
        if (typeof visualsList === 'string') {
          try { visualsList = JSON.parse(visualsList); } catch (_) { visualsList = []; }
        }
        const visualNameMap = new Map();
        if (Array.isArray(visualsList)) {
          visualsList.forEach(v => {
            if (v && v.character_id != null && v.name) visualNameMap.set(Number(v.character_id), v.name);
          });
        }
        const charNames = charList.map(c => {
          if (typeof c === 'object' && c) return c.name;
          const numId = Number(c);
          if (visualNameMap.has(numId)) return visualNameMap.get(numId);
          if (options.characterMap && options.characterMap.get(numId)) return options.characterMap.get(numId);
          return c;
        }).filter(Boolean);
        let backgroundList = shot.background_characters;
        if (typeof backgroundList === 'string') {
          try { backgroundList = JSON.parse(backgroundList); } catch (_) { backgroundList = []; }
        }
        const backgroundNames = Array.isArray(backgroundList)
          ? backgroundList.map(c => typeof c === 'object' ? c?.name : '').filter(Boolean)
          : [];
        if (charNames.length > 0) {
          const backgroundContract = backgroundNames.length
            ? `；另有 ${backgroundNames.length} 位后景在场人物（${backgroundNames.join('、')}），保持指定景深与活动`
            : '';
          parts.push(`【出场人物】核心画内角色 ${charNames.length} 位（${charNames.join('、')}）${backgroundContract}，构图聚焦核心角色与剧情动线`);
        }
      }
    } catch (_) {}
  }

  if (shot.character_appearances) {
    parts.push('角色造型：' + stripChineseExclusions(String(shot.character_appearances).replace(/\r?\n/g, '；')));
  }

  // 2.5. 保留导演 Agent 的静态站位与视线合同。这是 H3 构图的权威输入，
  // 禁止只传递动作轨迹而丢失 facing/head_pose/gaze。
  let characterVisuals = shot.character_visuals;
  if (typeof characterVisuals === 'string') {
    try { characterVisuals = JSON.parse(characterVisuals); } catch (_) { characterVisuals = []; }
  }
  if (Array.isArray(characterVisuals) && characterVisuals.length) {
    const visualContracts = characterVisuals.map((v) => {
      if (v.gaze_type || v.hands_state || v.posture) {
        const gazeTarget = v.gaze_target_label || resolveAtomRef({ target_id: v.gaze_target_id }, 'target_id', options);
        const facingTarget = v.facing_target_id != null ? resolveAtomRef({ target_id: v.facing_target_id }, 'target_id', options) : '';
        const items = [
          v.screen_position ? `站位：${v.screen_position}` : '',
          v.facing ? `身体朝向：${v.facing}${facingTarget ? `（目标：${facingTarget}）` : ''}` : '',
          v.head_pose ? `头部：${v.head_pose}` : '',
          v.gaze_type ? `视线：${v.gaze_type}${gazeTarget ? `（${gazeTarget}）` : ''}` : '',
          v.posture ? `体态：${v.posture}` : '',
          v.hands_state ? `手部：${v.hands_state}` : '',
          v.expression ? `表情：${v.expression}` : '',
          v.expression_detail || '',
        ].filter(Boolean);
        return `「${v.name || '人物'}」${items.join('，')}`;
      }
      const items = [];
      if (v.screen_position) items.push(`站位：${v.screen_position}`);
      if (v.facing) items.push(`身体朝向：${v.facing}`);
      if (v.head_pose) items.push(`头部：${v.head_pose}`);
      if (v.gaze) items.push(`视线：${v.gaze}`);
      if (v.posture) items.push(`体态：${v.posture}`);
      if (v.hands) items.push(`手部：${v.hands}`);
      if (v.expression) items.push(`表情：${v.expression}`);
      return `「${v.name || '人物'}」${items.join('，')}`;
    });
    parts.push('角色站位与视线合同：' + visualContracts.join('；'));
  }

  // 3. 景别与机位动态运镜
  const cam = normSlots.camera;
  if (cam.shot_type) parts.push('景别：' + cam.shot_type);

  const chAngle = angleService.toChineseLabel(cam.angle_h, cam.angle_v, cam.angle_s);
  const angleFragment = angleService.toPromptFragment(cam.angle_h, cam.angle_v, cam.angle_s);
  parts.push(`镜头角度：${chAngle}（${angleFragment}）`);

  const moveDesc = cam.movement_description ? `（${cam.movement_description}）` : '';
  parts.push(`运镜：${cam.movement}${moveDesc}`);

  // 4. 角色动态与物理轨迹（明确起点、动作、终态与口型）
  if (normSlots.trajectories.length > 0) {
    const trajLines = normSlots.trajectories.map((t) => {
      if (isStructuredTrajectory(t)) return compileStructuredTrajectory(t, options);
      const items = [];
      if (t.start_anchor) items.push(`起点：${t.start_anchor}`);
      if (t.trajectory) items.push(`动作轨迹：${t.trajectory}`);
      if (t.end_anchor) items.push(`终点：${t.end_anchor}`);
      if (t.terminal_pose) items.push(`终态姿态：${t.terminal_pose}`);
      if (t.facial_expression) items.push(`面部神态：${t.facial_expression}`);
      if (t.facing) items.push(`身体朝向：${t.facing}`);
      if (t.head_pose) items.push(`头部姿态：${t.head_pose}`);
      if (t.gaze) items.push(`视线落点：${t.gaze}`);
      if (t.attention_target) items.push(`注意对象：${t.attention_target}`);
      if (t.gaze_motivation) items.push(`视线动机：${t.gaze_motivation}`);
      if (t.reaction_trigger) items.push(`反应触发：${t.reaction_trigger}`);
      if (t.mouth_state) items.push(`口型状态：${t.mouth_state}`);
      return `「${t.name}」` + items.join('，');
    });
    parts.push('角色动态与轨迹：' + trajLines.join('；'));
  } else if (shot.action) {
    parts.push('动作：' + translatePhysicalPhenomena(stripChineseExclusions(shot.action)));
  }

  const alignedBeats = normSlots.shots_timeline
    .filter((segment) => segment.audio_lip_sync?.dialogue_content && segment.speech_action_alignment?.mode === 'concurrent')
    .map((segment) => {
      const a = segment.speech_action_alignment;
      const speaker = (segment.character_trajectories || []).find((t) => Number(t.character_id) === Number(a.speaker_character_id));
      const speakerAction = speaker && isStructuredTrajectory(speaker)
        ? compileStructuredTrajectory(speaker, options)
        : a.speaker_action;
      const listeners = (a.listener_reactions || []).map((r) => {
        const listener = (segment.character_trajectories || []).find((t) => Number(t.character_id) === Number(r.character_id));
        const reaction = listener && isStructuredTrajectory(listener)
          ? compileStructuredTrajectory(listener, options)
          : r.action;
        return `角色${r.character_id}在${JSON.stringify(r.action_window)}同步${reaction}`;
      }).join('；');
      return `对白${JSON.stringify(segment.audio_lip_sync.dialogue_content)}期间，发言者在${JSON.stringify(a.speaker_action_window)}同步${speakerAction || '执行本段动作'}${listeners ? `；${listeners}` : ''}`;
    });
  if (alignedBeats.length) parts.push('同步视听事件：' + alignedBeats.join('；'));
  const physicalBeats = normSlots.shots_timeline
    .filter((segment) => Array.isArray(segment.character_trajectories) && segment.character_trajectories.some(isStructuredTrajectory))
    .map((segment) => {
      const start = segment.timestamp || '00:00.000';
      const actions = segment.character_trajectories
        .filter(isStructuredTrajectory)
        .map((trajectory) => compileStructuredTrajectory(trajectory, options))
        .filter(Boolean)
        .join('；');
      return `${start}（${segment.duration || 1}秒）：${actions}`;
    });
  if (physicalBeats.length) parts.push('原子动作时间线：' + physicalBeats.join('；'));

  // 5. 音频与口型控制契约（Lip-Sync Contract）
  const audio = normSlots.audio_lip_sync;
  if (audio.mode === 'offscreen_voiceover' || !audio.speaker_in_frame) {
    if (audio.dialogue_content) {
      const spk = audio.speaker_name ? `画外角色${audio.speaker_name}` : '画外无线电';
      const med = audio.delivery_medium === 'radio_headset' ? '战术耳机中传来' : '';
      parts.push(`画外无线电呼叫：${med}${spk}的急促呼喊；画内人物保持双唇自然闭合与专注倾听状态：“${audio.dialogue_content}”`);
    }
  } else if (audio.mode === 'in_frame_dialogue' && audio.dialogue_content) {
    const spk = audio.speaker_name ? audio.speaker_name : '角色';
    parts.push(`对话：${spk}: "${audio.dialogue_content}"（${spk}自然发音并同步口型，画面其余人物双唇自然闭合并保持倾听）`);
  } else if (audio.mode === 'narration' && audio.dialogue_content) {
    parts.push(`解说旁白（画内全员闭口）：${audio.dialogue_content}`);
  }

  // 6. 环境物理特效与交互 (Environment VFX)
  const vfx = normSlots.environment_vfx;
  if (vfx.physical_phenomena) {
    parts.push('物理与环境交互：' + vfx.physical_phenomena);
  }
  if (vfx.terminal_event) {
    parts.push('结果收束：' + vfx.terminal_event);
  } else if (shot.result) {
    parts.push('结果：' + translatePhysicalPhenomena(stripChineseExclusions(shot.result)));
  }

  // 6.5 光影影调与明暗层次 (Lighting & Chiaroscuro)
  const lighting = shot.lighting_chiaroscuro || synthesizeLightingChiaroscuro(shot);
  if (lighting) {
    parts.push('光影影调：' + lighting);
  }

  // 7. 氛围与情绪
  if (shot.atmosphere) parts.push('氛围：' + shot.atmosphere);
  if (shot.emotion) parts.push('情绪：' + shot.emotion);

  // 8. 声音设计
  if (shot.bgm_prompt) parts.push('配乐：' + shot.bgm_prompt);
  if (shot.sound_effect) parts.push('音效：' + shot.sound_effect);

  // 9. 时长与画风
  const durationSec = normSlots.timing.duration || normalizeDuration(shot.duration) || 5;
  parts.push(`时长：${durationSec}秒`);

  const style = options.style || shot.style || 'photorealistic, ultra-detailed, 8k uhd, sharp focus, natural lighting, real skin texture, hyperrealism, professional photography, RAW photo';
  parts.push('风格：' + style);

  // 10. 严格口型与画面负向/正向约束
  if (audio.mode === 'offscreen_voiceover' || !audio.speaker_in_frame) {
    parts.push('画面与口型要求：(the voice comes from off screen; every visible character maintains relaxed closed lips and attentive listening expressions)');
  } else if (audio.mode === 'in_frame_dialogue' && audio.speaker_name) {
    parts.push(`画面与口型要求：(${audio.speaker_name} speaks with synchronized lips; every visible listener maintains relaxed closed lips and an attentive expression)`);
  }

  // 画面比例
  const videoRatio = options.videoRatio || shot.video_ratio || '16:9';
  parts.push('=VideoRatio: ' + videoRatio);

  return parts.join('。');
}

/**
 * 格式化 H3 时间戳 (如 3.5秒 -> "00:03.500", 7秒 -> "00:07.000")
 * @param {number} sec
 * @returns {string} "00:0X.XXX"
 */
function formatH3Timestamp(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const minutes = Math.floor(s / 60);
  const remainingSec = s % 60;
  const wholeSec = Math.floor(remainingSec);
  const ms = Math.round((remainingSec - wholeSec) * 1000);
  const mm = String(minutes).padStart(2, '0');
  const ss = String(wholeSec).padStart(2, '0');
  const mmm = String(ms).padStart(3, '0');
  return `${mm}:${ss}.${mmm}`;
}

/**
 * 依据 MiniMax H3 官方多模态语法合成 H3 Shot 时间轴槽位
 * @param {object} shot
 * @param {object} options
 * @returns {object} { shots, integrated_multimodal_description, overall_soundscape, non_diegetic_music }
 */
function synthesizeH3MultimodalSlots(shot, options = {}) {
  const dur = normalizeDuration(shot.duration) || 5;
  const shotType = shot.shot_type || 'medium shot';
  const movement = shot.movement || 'tracking';
  const lightDesc = angleService.lightingToPrompt(shot.lighting_style) || '';
  const lightPhrase = lightDesc ? ` with ${lightDesc}` : '';
  const actionText = translatePhysicalPhenomena(String(shot.action || ''));
  const resultText = translatePhysicalPhenomena(String(shot.result || ''));
  const diagText = String(shot.dialogue || '');

  const h3Shots = [];

  // 若显式传入了镜头时间线 shots_timeline，直接依据时间线生成 H3 Shots
  if (Array.isArray(options.shots_timeline) && options.shots_timeline.length > 0) {
    options.shots_timeline.forEach((st) => {
      let desc = '';
      const camType = st.camera?.shot_type || shotType;
      const move = st.camera?.movement || movement;
      const visibleNames = (Array.isArray(st.visible_characters) ? st.visible_characters : [])
        .map((item) => String(item?.name || '').trim()).filter(Boolean);
      const visibleCue = visibleNames.length ? ` Visible in frame: ${visibleNames.join(', ')}.` : ' No character is visible in this shot segment.';
      if (!st.timestamp) {
        desc = `Live-action, cinematic. A ${camType} establishes the scene.${visibleCue} The camera begins with ${move} as ${st.action || actionText || 'the action initiates'}.`;
      } else {
        desc = `At ${st.timestamp}, the camera cuts to a ${camType}.${visibleCue} ${st.action || resultText || actionText || 'the movement resolves'}.`;
        if (st.audio_lip_sync?.dialogue_content) {
          const spk = st.audio_lip_sync.speaker_name ? `${st.audio_lip_sync.speaker_name}: ` : '';
          const cleanDiag = String(st.audio_lip_sync.dialogue_content).replace(/^["“](.*)["”]$/, '$1');
          desc += ` Dialogue follows: ${spk}“${cleanDiag}”`;
        }
      }
      const structuredTrajectories = Array.isArray(st.character_trajectories)
        ? st.character_trajectories.filter(isStructuredTrajectory).map((t) => compileStructuredTrajectory(t, options)).filter(Boolean)
        : [];
      if (structuredTrajectories.length) desc += ` Physical performance: ${structuredTrajectories.join('; ')}.`;
      const alignment = st.speech_action_alignment;
      if (alignment?.mode === 'concurrent' && alignment.speaker_action) {
        const listeners = (alignment.listener_reactions || [])
          .map((r) => r.action ? `listener ${r.character_id} reacts: ${r.action}` : '')
          .filter(Boolean).join('; ');
        desc += ` Speech and physical performance happen concurrently: ${alignment.speaker_action}${listeners ? `; ${listeners}` : ''}.`;
      } else if (alignment?.mode === 'deliberate_pause' && alignment.pause_reason) {
        desc += ` Deliberate pause: ${alignment.pause_reason}.`;
      }
      h3Shots.push({
        shot_number: st.shot_number,
        timestamp: st.timestamp,
        description: desc.trim(),
      });
    });
  } else {
    // 判断是否具备镜头切分条件 (时长 >= 6s 且有转折/对话/结果动作)
    const needsCut = dur >= 6 && (resultText.trim().length > 0 || diagText.trim().length > 0);

    if (!needsCut) {
      // 单镜头连续画面: [Shot 1] 从 0 秒开始，不加时间戳
      let desc1 = `Live-action, cinematic. A ${shotType} frames the scene${lightPhrase}. The camera moves with ${movement}.`;
      if (diagText) desc1 += ` From the opening frame (00:00.000), dialogue immediately begins concurrently: ${diagText}.`;
      desc1 += ` ${actionText}`;
      if (resultText) desc1 += ` ${resultText}`;
      h3Shots.push({
        shot_number: 1,
        timestamp: null,
        description: desc1.trim(),
      });
    } else {
      // 多镜头时间线切分: [Shot 1] (0秒开始) + [Shot 2] At 00:0X.XXX
      const cutSec = Math.round((dur / 2) * 2) / 2; // 例如 7s -> 3.5s, 8s -> 4.0s
      const timecode = formatH3Timestamp(cutSec);

      // [Shot 1] 开头第一段画面 (建构机位与主体起始动作，台词在第0秒立即开口并发进行)
      let desc1 = `Live-action, cinematic. A ${shotType} establishes the scene${lightPhrase}. The camera begins with ${movement} as ${actionText || 'the action initiates'}.`;
      if (diagText) {
        desc1 += ` CRITICAL TIMING: Speech delivery starts at the opening frame (00:00.000), concurrent with the physical movement: ${diagText}.`;
      }
      h3Shots.push({
        shot_number: 1,
        timestamp: null,
        description: desc1.trim(),
      });

      // [Shot 2] At 00:XX.XXX 按时间切过去的后续反应/反打/终态镜头
      const secondaryShotType = shotType === '特写' || shotType === '近景' ? 'medium shot' : 'close-up shot';
      let desc2 = `At ${timecode}, the camera cuts to a ${secondaryShotType}, where ${resultText || actionText || 'the movement resolves'}. The speaker concludes speech and settles with sealed lips.`;
      h3Shots.push({
        shot_number: 2,
        timestamp: timecode,
        description: desc2.trim(),
      });
    }
  }

  // 拼接 integrated_multimodal_description
  const integratedDesc = h3Shots
    .map((s) => (s.timestamp ? `[Shot ${s.shot_number}] At ${s.timestamp}, ${s.description.replace(/^At\s+[\d:.]+,\s*/, '')}` : `[Shot ${s.shot_number}] ${s.description}`))
    .join('\n');

  // 音效与环境声 overall_soundscape
  const soundscape = shot.sound_effect
    ? `Ambient environmental audio, room tone, and physical impact sounds: ${shot.sound_effect}.`
    : 'Subtle ambient room tone and realistic environmental sounds matching physical actions.';

  // 配乐 non_diegetic_music
  const music = shot.bgm_prompt && shot.bgm_prompt.trim()
    ? `Cinematic score: ${shot.bgm_prompt.trim()}.`
    : 'N/A';

  return {
    shots: h3Shots,
    integrated_multimodal_description: integratedDesc,
    overall_soundscape: soundscape,
    non_diegetic_music: music,
  };
}

/**
 * 视频语义槽位智能合成器：从 shot 现有数据、实体目录与首尾帧中提取高内聚强结构槽位
 * @param {object} shot
 * @param {Array<object>} catalogCharacters
 * @returns {object} video_slots
 */
function synthesizeVideoSlots(shot, catalogCharacters = [], options = {}) {
  if (shot.video_slots && !options.forceRebuild) {
    let existing = shot.video_slots;
    if (typeof existing === 'string') {
      try { existing = JSON.parse(existing); } catch (_) { existing = null; }
    }
    const isLegacyHallucinated = JSON.stringify(existing || '').includes('凌空飞扑') &&
      !/(?:扑向|飞扑|凌空扑|跃起|扑倒)/.test(String(shot.action || '') + ' ' + String(shot.result || ''));
    if (!isLegacyHallucinated && existing && typeof existing === 'object' && existing.camera && existing.audio_lip_sync && Array.isArray(existing.shots_timeline) && existing.shots_timeline.length > 0) {
      if (!existing.h3_multimodal || !existing.h3_multimodal.integrated_multimodal_description) {
        existing.h3_multimodal = synthesizeH3MultimodalSlots(shot, { camera: existing.camera, shots_timeline: existing.shots_timeline });
      }
      return createVideoSemanticSlots(existing);
    }
  }

  const charMap = new Map();
  (catalogCharacters || []).forEach((c) => {
    if (c && c.id != null) charMap.set(Number(c.id), c);
  });

  const charIds = [];
  if (Array.isArray(shot.characters)) {
    charIds.push(...shot.characters.map((x) => (typeof x === 'object' && x != null ? x.id : x)).map(Number).filter(Number.isFinite));
  } else if (typeof shot.characters === 'string') {
    try {
      const p = JSON.parse(shot.characters);
      if (Array.isArray(p)) charIds.push(...p.map(Number).filter(Number.isFinite));
    } catch (_) {}
  }

  const actionText = translatePhysicalPhenomena(String(shot.action || ''));
  const resultText = translatePhysicalPhenomena(String(shot.result || ''));
  const dialogueText = String(shot.dialogue || '').trim();
  const narrationText = String(shot.narration || '').trim();

  // 1. 推断音频与口型契约 (Audio Lip Sync)
  let speakerName = '';
  let diagContent = dialogueText;
  let speakerMatch = dialogueText.match(/^([^:：\s]+)\s*[:：]\s*(.*)$/s);
  if (speakerMatch) {
    speakerName = speakerMatch[1].trim();
    diagContent = speakerMatch[2].trim().replace(/^["“](.*)["”]$/, '$1');
  }

  const visibleNames = charIds.map((cid) => charMap.get(cid)?.name).filter(Boolean);
  const isSpeakerInVisibleList = speakerName ? visibleNames.includes(speakerName) : false;

  const isExplicitOffscreen =
    /(?:画外|不入画|不在画中|无线电|战术耳机|通讯器|隔空|对讲机)/i.test(actionText) ||
    /(?:画外|不入画|不在画中|无线电|耳机|对讲机)/i.test(dialogueText);

  let audioMode = 'silent_ambient';
  let speakerInFrame = false;
  let deliveryMedium = 'direct_speech';
  let lipState = 'strictly_sealed';
  let lipRule = '画面内全员保持双唇自然闭合与安静专注状态。';

  if (dialogueText) {
    if (!isSpeakerInVisibleList || isExplicitOffscreen) {
      audioMode = 'offscreen_voiceover';
      speakerInFrame = false;
      deliveryMedium = /(?:战术耳机|耳机)/i.test(actionText + dialogueText) ? 'radio_headset' : 'voiceover';
      lipState = 'strictly_sealed';
      lipRule = `战术耳机传来画外角色${speakerName || '画外'}的急促呼喊，画面内人物保持双唇自然闭合与专注倾听状态`;
    } else {
      audioMode = 'in_frame_dialogue';
      speakerInFrame = true;
      deliveryMedium = 'direct_speech';
      lipState = 'synchronized_lip';
      lipRule = `仅限说话人${speakerName}开口说话，其余画内人物双唇紧闭保持倾听`;
    }
  } else if (narrationText) {
    audioMode = 'narration';
    speakerInFrame = false;
    deliveryMedium = 'narration';
    lipState = 'strictly_sealed';
    lipRule = '解说旁白播放，画内全员双唇紧闭无口型动作';
    diagContent = narrationText;
  } else if (shot.bgm_prompt) {
    audioMode = 'bgm_only';
  }

  // 2. 推断角色动态轨迹 (Trajectories) - 完全通用化推演，绝无写死角色名与固定角色启发
  const trajectories = [];
  const firstSlots = Array.isArray(shot.character_visuals) ? shot.character_visuals : [];
  const lastSlots = Array.isArray(shot.last_frame_visuals) ? shot.last_frame_visuals : [];

  charIds.forEach((cid, idx) => {
    const cObj = charMap.get(cid) || {};
    const name = cObj.name || `角色${idx + 1}`;
    const fSlot = firstSlots.find((s) => s.character_id === cid || s.name === name) || firstSlots[idx] || {};
    const lSlot = lastSlots.find((s) => s.character_id === cid || s.name === name) || lastSlots[idx] || {};

    const defaultAnchor = idx === 0 ? '画面左侧' : (idx === 1 ? '画面右侧' : '画面中央');
    let startAnchor = fSlot.spatial_anchor || defaultAnchor;
    let endAnchor = lSlot.spatial_anchor || startAnchor;
    let trajDesc = '';
    let termPose = lSlot.posture || '';
    let facial = '神情专注严肃';
    let mouth = (speakerInFrame && name === speakerName)
      ? '开口说话并同步口型'
      : '双唇自然闭合，保持安静倾听状态';

    // 针对当前角色提取动作与终态关键词
    const charMentionRegex = new RegExp(`(?:${name})[^，。；]*`, 'g');
    const matchedMentions = ((actionText + ' ' + resultText).match(charMentionRegex) || []).join('，');
    const isTargetBeingApproached = name
      ? new RegExp('(?:冲向|扑向|赶到|走向|跑向|接近)\\s*' + name).test(actionText + ' ' + resultText)
      : false;
    const isSpeaker = speakerInFrame && name === speakerName;
    const isListener = speakerInFrame && speakerName && name !== speakerName;
    const activeText = matchedMentions || (idx === 0 ? actionText : resultText) || actionText;

    if (isListener && !matchedMentions) {
      trajDesc = `在${startAnchor}保持警惕戒备，专注倾听${speakerName}发言`;
      facial = '神情冷静专注，目光锐利保持倾听';
      if (!termPose) termPose = '身姿沉稳微收下颌，维持警戒姿态，等待做出决断';
    } else if (isTargetBeingApproached || /(?:倒卧|倒在|倒地|负伤|虚弱|昏迷|起不来|重伤)/.test(activeText)) {
      trajDesc = '侧卧倒在地面掩体旁，因伤势身体虚弱隐忍，无大幅位移';
      facial = '双目微阖神色虚弱隐忍，双唇紧闭';
      if (!termPose) termPose = '侧卧倒地，单手虚弱护在身前';
    } else if (/(?:扑向|飞扑|凌空扑|跃起|扑倒|伸手扑)/.test(activeText)) {
      trajDesc = '全力爆发疾速前扑冲向目标';
      facial = '咬紧牙关，神情焦灼决绝';
      if (!termPose) termPose = '身体大幅前倾凌空飞扑，单臂向前竭力伸手抓向目标';
      if (!lSlot.spatial_anchor && endAnchor === startAnchor) endAnchor = '距离目标半米处';
    } else if (/(?:冲向|奔跑|狂奔|疾冲|冲出|大步走|大步奔)/.test(activeText)) {
      trajDesc = '大步疾速奔跑冲刺向前推进';
      facial = '目光专注坚定，神情严峻';
      if (!termPose) termPose = '身体前倾大步冲刺，重心前移定格';
    } else if (/(?:操作|展开|点击|调出|标记|简报|屏幕|键盘|界面)/.test(activeText)) {
      trajDesc = '在场景中操作交互界面，动作利落专注';
      facial = '目光专注锐利，神情冷静沉着';
      if (!termPose) termPose = '身体微前倾，专注操作与审视前方界面';
    } else if (/(?:掩体|躲避|隐蔽|蹲伏|单膝|防守|戒备)/.test(activeText)) {
      trajDesc = '在掩体后保持警戒防护';
      facial = '目光警惕，神情严肃戒备';
      if (!termPose) termPose = '屈膝蹲伏压低身姿，保持隐蔽警戒';
    } else {
      trajDesc = actionText ? actionText.slice(0, 35) : '动作敏捷，保持稳定姿态推进';
      facial = '神情沉着专注，保持戒备';
      if (!termPose) termPose = resultText ? resultText.slice(0, 35) : '身体站定收步，目光专注重心稳固';
    }

    if (termPose) {
      const isMale = /男性|男|male/i.test(cObj.appearance || cObj.description || '');
      const isFemale = /女性|女|female/i.test(cObj.appearance || cObj.description || '');
      if (isMale && termPose.includes('她')) {
        termPose = termPose.replace(/她/g, '他');
      } else if (isFemale && termPose.includes('他')) {
        termPose = termPose.replace(/他/g, '她');
      }
    }

    trajectories.push({
      character_id: cid,
      name,
      start_anchor: startAnchor,
      trajectory: trajDesc,
      end_anchor: endAnchor,
      terminal_pose: termPose,
      facial_expression: facial,
      mouth_state: mouth,
    });
  });

  // 3. 具象化环境与物理特效 (Environment VFX)
  let physical = '';
  if (/(?:弹着|子弹|扫射|枪声|火星)/.test(actionText + resultText)) {
    physical = '密集子弹高速扫射在水泥地面上，激起一连串飞溅碎石、烟尘与火花，紧随冲刺轨迹追逐至脚边';
  }

  let terminalEvent = translatePhysicalPhenomena(resultText);
  if (!terminalEvent && actionText) {
    terminalEvent = '动作瞬间定格，飞溅火花与烟尘在空中微粒悬停';
  }

  // 4. 摄影参数
  const camera = {
    shot_type: shot.shot_type || '全景',
    angle_h: shot.angle_h || 'front_right',
    angle_v: shot.angle_v || 'low',
    angle_s: shot.angle_s || 'wide',
    movement: shot.movement || 'tracking',
    movement_description: shot.movement === 'tracking' ? '摄影机贴地平稳跟随主体冲刺轨迹同步移动' : '',
  };

  const durationSec = normalizeDuration(shot.duration) || 5;

  // 5. 合成多镜头时间线切分 (shots_timeline)
  const shotsTimeline = [];
  const timelineVisibleCharacters = trajectories.map((t) => ({ character_id: Number(t.character_id), name: t.name })).filter((c) => c.character_id > 0);
  const needsCut = durationSec >= 6 && (resultText.trim().length > 0 || diagContent.trim().length > 0);

  if (!needsCut) {
    shotsTimeline.push({
      shot_number: 1,
      timestamp: null,
      duration: durationSec,
      camera: {
        shot_type: camera.shot_type,
        movement: camera.movement,
        movement_description: camera.movement_description,
      },
      visible_characters: timelineVisibleCharacters,
      action: actionText || '场景主体动作稳健推进',
      result: resultText || '',
      character_trajectories: trajectories.map((t) => ({ ...t, shot_number: 1 })),
      audio_lip_sync: {
        mode: audioMode,
        speaker_name: speakerName,
        speaker_in_frame: speakerInFrame,
        dialogue_content: diagContent,
        lip_sync_rule: lipRule,
      },
    });
  } else {
    const cutSec = Math.round((durationSec / 2) * 2) / 2;
    const timecode = formatH3Timestamp(cutSec);
    const secondaryShotType = camera.shot_type === '特写' || camera.shot_type === '近景' ? '中景' : '特写';

    shotsTimeline.push({
      shot_number: 1,
      timestamp: null,
      duration: cutSec,
      camera: {
        shot_type: camera.shot_type,
        movement: camera.movement,
        movement_description: camera.movement_description,
      },
      visible_characters: timelineVisibleCharacters,
      action: actionText || '场景主体动作开启推进',
      result: '',
      character_trajectories: trajectories.map((t) => ({
        ...t,
        end_anchor: t.start_anchor,
        terminal_pose: '保持推进与初始交互动作',
        mouth_state: '双唇自然闭合，保持安静倾听状态',
        shot_number: 1,
      })),
      audio_lip_sync: {
        mode: 'silent_ambient',
        speaker_name: '',
        speaker_in_frame: false,
        dialogue_content: '',
        lip_sync_rule: '初始建立镜头，画内全员紧闭双唇，无台词口型',
      },
    });

    shotsTimeline.push({
      shot_number: 2,
      timestamp: timecode,
      duration: durationSec - cutSec,
      camera: {
        shot_type: secondaryShotType,
        movement: 'static',
        movement_description: '镜头平稳聚焦主体终态与表情反应',
      },
      visible_characters: timelineVisibleCharacters,
      action: resultText || '动作收束并完成交互反应',
      result: resultText || '',
      character_trajectories: trajectories.map((t) => ({
        ...t,
        start_anchor: t.end_anchor,
        shot_number: 2,
      })),
      audio_lip_sync: {
        mode: audioMode,
        speaker_name: speakerName,
        speaker_in_frame: speakerInFrame,
        dialogue_content: diagContent,
        lip_sync_rule: lipRule,
      },
    });
  }

  return createVideoSemanticSlots({
    camera,
    audio_lip_sync: {
      mode: audioMode,
      speaker_name: speakerName,
      speaker_in_frame: speakerInFrame,
      delivery_medium: deliveryMedium,
      dialogue_content: diagContent,
      visible_characters_lip_state: lipState,
      lip_sync_rule: lipRule,
    },
    trajectories,
    shots_timeline: shotsTimeline,
    environment_vfx: {
      lighting_style: shot.lighting_style || 'natural',
      lighting_atmosphere: shot.atmosphere ? `${shot.lighting_style ? shot.lighting_style + '，' : ''}${shot.atmosphere}` : (shot.lighting_style || ''),
      physical_phenomena: physical,
      terminal_event: terminalEvent,
    },
    timing: {
      duration: durationSec,
      pacing: '急促高潮',
    },
    h3_multimodal: synthesizeH3MultimodalSlots(shot, {
      camera,
      shots_timeline: shotsTimeline,
    }),
  });
}

function compileH3MultimodalPrompt(slots = {}) {
  const norm = createVideoSemanticSlots(slots);
  return {
    integrated_multimodal_description: norm.h3_multimodal?.integrated_multimodal_description || '',
    overall_soundscape: norm.h3_multimodal?.overall_soundscape || '',
    non_diegetic_music: norm.h3_multimodal?.non_diegetic_music || '',
    shots: norm.h3_multimodal?.shots || [],
    shots_timeline: norm.shots_timeline || [],
  };
}

function normalizeDuration(dur) {
  if (dur == null || dur === '') return 5;
  const num = typeof dur === 'number' ? dur : parseFloat(String(dur).replace(/[^0-9.]/g, ''));
  return Number.isFinite(num) && num > 0 ? num : 5;
}

module.exports = {
  createVideoSemanticSlots,
  validateVideoSlots,
  compileVideoPromptFromSlots,
  compileH3MultimodalPrompt,
  synthesizeVideoSlots,
  synthesizeH3MultimodalSlots,
  formatH3Timestamp,
  translatePhysicalPhenomena,
  compileActionAtom,
  compileStructuredTrajectory,
  isGazeOnlyHold,
  mouthIsSealed,
};
