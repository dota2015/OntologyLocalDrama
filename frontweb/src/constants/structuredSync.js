export const PERFORMANCE_CONTRACT = 'structured_sync'

export const DEPTH_LAYER_OPTIONS = [
  { value: 'foreground', label: '前景 (foreground)' },
  { value: 'midground', label: '中景 (midground)' },
  { value: 'background', label: '后景 (background)' },
]

export const SCREEN_POSITION_OPTIONS = [
  { value: 'left_foreground', label: '画面左侧前景' },
  { value: 'left_midground', label: '画面左侧中景' },
  { value: 'left_background', label: '画面左侧后景' },
  { value: 'center_foreground', label: '画面中央前景' },
  { value: 'center_midground', label: '画面中央中景' },
  { value: 'center_background', label: '画面中央后景' },
  { value: 'right_foreground', label: '画面右侧前景' },
  { value: 'right_midground', label: '画面右侧中景' },
  { value: 'right_background', label: '画面右侧后景' },
]

export const FACING_OPTIONS = [
  { value: 'front_camera', label: '正面朝向镜头' },
  { value: 'back_camera', label: '背向镜头' },
  { value: 'left_profile', label: '正侧面朝向画面左侧' },
  { value: 'right_profile', label: '正侧面朝向画面右侧' },
  { value: 'three_quarter_left', label: '四分之三侧身面朝左' },
  { value: 'three_quarter_right', label: '四分之三侧身面朝右' },
  { value: 'toward_character', label: '身体转向目标角色' },
  { value: 'toward_object', label: '身体转向目标物体' },
  { value: 'toward_event', label: '身体转向事件源' },
  { value: 'away_from_camera', label: '背离镜头方向' },
]

export const HEAD_POSE_OPTIONS = [
  { value: 'neutral', label: '头部正对自然保持' },
  { value: 'turned_left', label: '头部转向左侧' },
  { value: 'turned_right', label: '头部转向右侧' },
  { value: 'tilted_up', label: '头部微仰' },
  { value: 'tilted_down', label: '头部微俯' },
  { value: 'turned_to_target', label: '头部转向目标对象' },
  { value: 'lowered', label: '低头向下' },
  { value: 'raised', label: '抬头向上' },
  { value: 'recoiling', label: '受惊后仰躲避' },
]

export const GAZE_TYPE_OPTIONS = [
  { value: 'camera', label: '注视镜头' },
  { value: 'character', label: '注视角色' },
  { value: 'prop', label: '注视道具' },
  { value: 'event', label: '注视事件源' },
  { value: 'scene', label: '观察场景' },
  { value: 'offscreen', label: '望向画外' },
  { value: 'ground', label: '低头看地面' },
  { value: 'none', label: '无固定视线' },
]

export const POSTURE_OPTIONS = [
  { value: 'standing', label: '站立姿态' },
  { value: 'sitting', label: '坐姿' },
  { value: 'kneeling', label: '单膝或双膝跪姿' },
  { value: 'crouching', label: '蹲伏低姿' },
  { value: 'lying', label: '卧姿' },
  { value: 'leaning', label: '身体倚靠或前倾' },
  { value: 'walking', label: '行进迈步姿态' },
  { value: 'running', label: '奔跑冲刺姿态' },
  { value: 'falling', label: '失衡倾倒姿态' },
  { value: 'supported', label: '被扶持借力姿态' },
]

export const HAND_STATE_OPTIONS = [
  { value: 'free', label: '双手自然空置' },
  { value: 'holding_object', label: '手持物体' },
  { value: 'reaching', label: '伸手探向目标' },
  { value: 'supporting_target', label: '伸手搀扶托住目标' },
  { value: 'pointing', label: '抬手指向目标' },
  { value: 'covering_mouth', label: '抬手掩口' },
  { value: 'on_surface', label: '手掌按在支撑表面' },
  { value: 'clenched', label: '紧握拳头' },
  { value: 'relaxed', label: '双手放松垂落' },
]

export const EXPRESSION_OPTIONS = [
  { value: 'neutral', label: '神情平静' },
  { value: 'focused', label: '神情专注' },
  { value: 'alert', label: '神情警惕锐利' },
  { value: 'worried', label: '神情忧虑紧绷' },
  { value: 'angry', label: '神情愤怒紧绷' },
  { value: 'surprised', label: '神情震惊' },
  { value: 'pain', label: '神情痛苦隐忍' },
  { value: 'fear', label: '神情惊恐' },
  { value: 'relief', label: '神情松一口气' },
  { value: 'determined', label: '神情坚定决绝' },
  { value: 'sad', label: '神情悲伤低落' },
  { value: 'confused', label: '神情困惑迟疑' },
  { value: 'exhausted', label: '神情疲惫虚弱' },
]

export const MOUTH_STATE_OPTIONS = [
  { value: 'closed', label: '双唇闭合 (closed)' },
  { value: 'speaker_synced', label: '说话口型同步 (speaker_synced)' },
  { value: 'offscreen_sealed', label: '遮挡/背影闭口 (offscreen_sealed)' },
]

export const STATE_OPTIONS = [
  { value: 'neutral', label: '自然常态 (neutral)' },
  { value: 'standing', label: '站立 (standing)' },
  { value: 'standing_alert', label: '站立警戒 (standing_alert)' },
  { value: 'sitting', label: '坐姿 (sitting)' },
  { value: 'lying', label: '卧姿 (lying)' },
  { value: 'crouched', label: '蹲伏 (crouched)' },
  { value: 'walking', label: '行进 (walking)' },
  { value: 'running', label: '奔跑 (running)' },
  { value: 'falling', label: '倾倒 (falling)' },
  { value: 'holding', label: '持有物体 (holding)' },
  { value: 'gripping', label: '紧握 (gripping)' },
  { value: 'touching', label: '接触 (touching)' },
  { value: 'reaching', label: '探手 (reaching)' },
  { value: 'supported', label: '被扶持 (supported)' },
  { value: 'turned_to_target', label: '转向目标 (turned_to_target)' },
  { value: 'looking_at_target', label: '注视目标 (looking_at_target)' },
  { value: 'weapon_ready', label: '持械戒备 (weapon_ready)' },
  { value: 'object_on_surface', label: '物体在桌面/地面 (object_on_surface)' },
  { value: 'object_released', label: '物体已放开 (object_released)' },
  { value: 'target_sitting_supported', label: '目标坐姿受扶 (target_sitting_supported)' },
]

export const ACTION_OPTIONS = [
  { value: 'hold', label: '持握保持 (hold)' },
  { value: 'grasp', label: '抓取 (grasp)' },
  { value: 'release', label: '放开 (release)' },
  { value: 'reach', label: '伸手探向 (reach)' },
  { value: 'touch', label: '触碰 (touch)' },
  { value: 'support', label: '搀扶托住 (support)' },
  { value: 'lift', label: '抬起/提起 (lift)' },
  { value: 'push', label: '推 (push)' },
  { value: 'pull', label: '拉 (pull)' },
  { value: 'turn', label: '转身/转头 (turn)' },
  { value: 'walk', label: '行走 (walk)' },
  { value: 'run', label: '奔跑 (run)' },
  { value: 'crouch', label: '蹲下 (crouch)' },
  { value: 'stand_up', label: '起身 (stand_up)' },
  { value: 'sit_down', label: '坐下 (sit_down)' },
  { value: 'fall', label: '倒下 (fall)' },
  { value: 'look', label: '注视观察 (look)' },
  { value: 'speak', label: '开口说话 (speak)' },
  { value: 'listen', label: '倾听回应 (listen)' },
  { value: 'react', label: '受激反应 (react)' },
  { value: 'use', label: '使用道具 (use)' },
  { value: 'point', label: '指向 (point)' },
  { value: 'block', label: '格挡遮拦 (block)' },
]

export const BODY_PART_OPTIONS = [
  { value: 'whole_body', label: '全身 (whole_body)' },
  { value: 'left_hand', label: '左手 (left_hand)' },
  { value: 'right_hand', label: '右手 (right_hand)' },
  { value: 'both_hands', label: '双手 (both_hands)' },
  { value: 'left_arm', label: '左臂 (left_arm)' },
  { value: 'right_arm', label: '右臂 (right_arm)' },
  { value: 'both_arms', label: '双臂 (both_arms)' },
  { value: 'head', label: '头部 (head)' },
  { value: 'eyes', label: '双眼视线 (eyes)' },
  { value: 'torso', label: '躯干 (torso)' },
  { value: 'legs', label: '双腿 (legs)' },
]

export const TARGET_TYPE_OPTIONS = [
  { value: 'none', label: '无目标 (none)' },
  { value: 'character', label: '角色 (character)' },
  { value: 'prop', label: '道具 (prop)' },
  { value: 'event', label: '事件 (event)' },
  { value: 'scene', label: '场景 (scene)' },
]

export const DIRECTION_OPTIONS = [
  { value: 'none', label: '无固定方向 (none)' },
  { value: 'left', label: '向左 (left)' },
  { value: 'right', label: '向右 (right)' },
  { value: 'forward', label: '向前 (forward)' },
  { value: 'backward', label: '向后 (backward)' },
  { value: 'up', label: '向上 (up)' },
  { value: 'down', label: '向下 (down)' },
  { value: 'toward_target', label: '朝向目标 (toward_target)' },
  { value: 'away_from_target', label: '背离/远离目标 (away_from_target)' },
]

export const CONTACT_OPTIONS = [
  { value: 'none', label: '无接触 (none)' },
  { value: 'hand', label: '手部接触 (hand)' },
  { value: 'forearm', label: '前臂接触 (forearm)' },
  { value: 'both_arms', label: '双臂抱持 (both_arms)' },
  { value: 'shoulder_back', label: '肩背接触 (shoulder_back)' },
  { value: 'upper_arm', label: '上臂接触 (upper_arm)' },
  { value: 'wrist', label: '手腕接触 (wrist)' },
  { value: 'clothing', label: '衣物接触 (clothing)' },
  { value: 'weapon_grip', label: '握持器械握把 (weapon_grip)' },
  { value: 'object_surface', label: '接触物体表面 (object_surface)' },
  { value: 'ground', label: '接触地面 (ground)' },
]

export const TRIGGER_TYPE_OPTIONS = [
  { value: 'none', label: '无外部触发 (none)' },
  { value: 'dialogue', label: '台词触发 (dialogue)' },
  { value: 'character_action', label: '角色动作触发 (character_action)' },
  { value: 'environment_event', label: '环境事件触发 (environment_event)' },
  { value: 'state_change', label: '状态变化触发 (state_change)' },
]

export const ALIGNMENT_MODE_OPTIONS = [
  { value: 'concurrent', label: '边说边演 (concurrent)' },
  { value: 'deliberate_pause', label: '刻意停顿分隔 (deliberate_pause)' },
  { value: 'none', label: '无说话对齐 (none)' },
]

export const LISTENER_ACTION_OPTIONS = [
  { value: 'react', label: '反应 (react)' },
  { value: 'listen', label: '倾听 (listen)' },
  { value: 'look', label: '注视 (look)' },
  { value: 'support', label: '扶持配合 (support)' },
  { value: 'turn', label: '转身/转头 (turn)' },
  { value: 'none', label: '无动作 (none)' },
]

const LABEL_LOOKUPS = {
  depth_layer: buildLookup(DEPTH_LAYER_OPTIONS),
  screen_position: buildLookup(SCREEN_POSITION_OPTIONS),
  facing: buildLookup(FACING_OPTIONS),
  head_pose: buildLookup(HEAD_POSE_OPTIONS),
  gaze_type: buildLookup(GAZE_TYPE_OPTIONS),
  posture: buildLookup(POSTURE_OPTIONS),
  hands_state: buildLookup(HAND_STATE_OPTIONS),
  expression: buildLookup(EXPRESSION_OPTIONS),
  mouth_state: buildLookup(MOUTH_STATE_OPTIONS),
  state: buildLookup(STATE_OPTIONS),
  action: buildLookup(ACTION_OPTIONS),
  trigger_type: buildLookup(TRIGGER_TYPE_OPTIONS),
  alignment_mode: buildLookup(ALIGNMENT_MODE_OPTIONS),
}

function buildLookup(options) {
  return Object.fromEntries(options.map((opt) => [opt.value, opt.label]))
}

export function optionLabel(kind, value) {
  if (!value) return ''
  return LABEL_LOOKUPS[kind]?.[value] || String(value)
}

export function toNullablePositiveInt(value) {
  if (value === null || value === undefined || value === '') return null
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return null
  return Math.trunc(num)
}

export function normalizeCharacterVisualSlot(raw = {}, index = 0) {
  const c = raw && typeof raw === 'object' ? raw : {}
  return {
    character_id: toNullablePositiveInt(c.character_id),
    name: String(c.name || `角色${index + 1}`),
    depth_layer: String(c.depth_layer || ''),
    screen_position: String(c.screen_position || ''),
    environmental_anchor: String(c.environmental_anchor || ''),
    facing: String(c.facing || ''),
    facing_target_id: toNullablePositiveInt(c.facing_target_id),
    head_pose: String(c.head_pose || ''),
    gaze_type: String(c.gaze_type || ''),
    gaze_target_id: toNullablePositiveInt(c.gaze_target_id),
    gaze_target_label: String(c.gaze_target_label || ''),
    posture: String(c.posture || ''),
    hands_state: String(c.hands_state || ''),
    hands_object_id: toNullablePositiveInt(c.hands_object_id),
    hands_target_id: toNullablePositiveInt(c.hands_target_id),
    expression: String(c.expression || ''),
    expression_detail: String(c.expression_detail || ''),
    appearance_details: String(c.appearance_details || ''),
  }
}

export function normalizeCharacterVisualList(list) {
  if (!Array.isArray(list) || list.length === 0) return []
  return list.map((item, idx) => normalizeCharacterVisualSlot(item, idx))
}

export function normalizeActionAtom(raw) {
  const atom = raw && typeof raw === 'object' ? raw : {}
  return {
    action: String(atom.action || ''),
    action_detail: String(atom.action_detail || ''),
    body_part: String(atom.body_part || ''),
    object_id: toNullablePositiveInt(atom.object_id),
    target_type: String(atom.target_type || 'none'),
    target_id: toNullablePositiveInt(atom.target_id),
    target_label: String(atom.target_label || ''),
    direction: String(atom.direction || 'none'),
    contact: String(atom.contact || 'none'),
  }
}

export function normalizeReactionTrigger(raw) {
  if (!raw || typeof raw !== 'object') {
    return { type: 'none', source_id: null, source_label: '' }
  }
  return {
    type: String(raw.type || 'none'),
    source_id: toNullablePositiveInt(raw.source_id),
    source_label: String(raw.source_label || ''),
  }
}

export function normalizeCharacterTrajectorySlot(raw = {}, index = 0, shotNumber = 1) {
  const t = raw && typeof raw === 'object' ? raw : {}
  return {
    character_id: toNullablePositiveInt(t.character_id),
    name: String(t.name || `角色${index + 1}`),
    start_state: String(t.start_state || ''),
    action_atom: normalizeActionAtom(t.action_atom),
    result_state: String(t.result_state || ''),
    reaction_trigger: normalizeReactionTrigger(t.reaction_trigger),
    facing: String(t.facing || ''),
    facing_target_id: toNullablePositiveInt(t.facing_target_id),
    head_pose: String(t.head_pose || ''),
    gaze_type: String(t.gaze_type || ''),
    gaze_target_id: toNullablePositiveInt(t.gaze_target_id),
    gaze_target_label: String(t.gaze_target_label || ''),
    posture: String(t.posture || ''),
    hands_state: String(t.hands_state || ''),
    hands_object_id: toNullablePositiveInt(t.hands_object_id),
    hands_target_id: toNullablePositiveInt(t.hands_target_id),
    expression: String(t.expression || ''),
    expression_detail: String(t.expression_detail || ''),
    mouth_state: String(t.mouth_state || 'closed'),
    ...(t.shot_number != null || shotNumber != null ? { shot_number: Number(t.shot_number || shotNumber) } : {}),
  }
}

export function normalizeSpeechActionAlignment(raw) {
  const a = raw && typeof raw === 'object' ? raw : {}
  const toWindow = (w) => ({
    start: Number.isFinite(Number(w?.start)) ? Number(w.start) : 0,
    end: Number.isFinite(Number(w?.end)) ? Number(w.end) : 0,
  })
  return {
    mode: String(a.mode || 'none'),
    speech_window: toWindow(a.speech_window),
    speaker_character_id: toNullablePositiveInt(a.speaker_character_id),
    speaker_action_window: toWindow(a.speaker_action_window),
    speaker_action: String(a.speaker_action || ''),
    listener_reactions: Array.isArray(a.listener_reactions)
      ? a.listener_reactions.map((r) => ({
          character_id: toNullablePositiveInt(r?.character_id),
          action_window: toWindow(r?.action_window),
          action: String(r?.action || ''),
          trajectory_action: String(r?.trajectory_action || 'none'),
        }))
      : [],
    pause_reason: String(a.pause_reason || ''),
  }
}

export function normalizeVideoSlots(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const cloned = JSON.parse(JSON.stringify(raw))
  cloned.trajectories = Array.isArray(cloned.trajectories)
    ? cloned.trajectories.map((t, idx) => normalizeCharacterTrajectorySlot(t, idx, null))
    : []
  cloned.shots_timeline = Array.isArray(cloned.shots_timeline)
    ? cloned.shots_timeline.map((seg, idx) => {
        const shotNum = Number(seg?.shot_number || idx + 1)
        return {
          ...seg,
          shot_number: shotNum,
          visible_characters: Array.isArray(seg?.visible_characters)
            ? seg.visible_characters
                .map((vc) => ({
                  character_id: toNullablePositiveInt(vc?.character_id ?? vc?.id),
                  name: String(vc?.name || ''),
                }))
                .filter((vc) => vc.character_id != null)
            : [],
          character_trajectories: Array.isArray(seg?.character_trajectories)
            ? seg.character_trajectories.map((t, tIdx) => normalizeCharacterTrajectorySlot(t, tIdx, shotNum))
            : [],
          speech_action_alignment: normalizeSpeechActionAlignment(seg?.speech_action_alignment),
        }
      })
    : []
  return cloned
}

export function createEmptyTimelineSegment(shotNumber, timecode, baseTrajectories = [], baseVisibleCharacters = []) {
  const visibleCharacters = Array.isArray(baseVisibleCharacters) && baseVisibleCharacters.length > 0
    ? baseVisibleCharacters.map((vc) => ({
        character_id: toNullablePositiveInt(vc?.character_id ?? vc?.id),
        name: String(vc?.name || ''),
      })).filter((vc) => vc.character_id != null)
    : (baseTrajectories || [])
        .map((t) => ({ character_id: toNullablePositiveInt(t?.character_id), name: String(t?.name || '') }))
        .filter((vc) => vc.character_id != null)

  return {
    shot_number: shotNumber,
    timestamp: timecode,
    duration: 3,
    camera: {
      shot_type: '特写',
      movement: 'static',
      movement_description: '',
    },
    action: '',
    result: '',
    visible_characters: visibleCharacters,
    character_trajectories: (baseTrajectories || []).map((t, idx) =>
      normalizeCharacterTrajectorySlot(t, idx, shotNumber)
    ),
    audio_lip_sync: {
      mode: 'silent_ambient',
      speaker_name: '',
      speaker_in_frame: false,
      dialogue_content: '',
      lip_sync_rule: '画内全员紧闭双唇，无台词口型',
    },
    speech_action_alignment: normalizeSpeechActionAlignment(null),
  }
}

export function buildVisualSlotsPreviewText(vs = {}) {
  const parts = []
  const locParts = [vs.location, vs.time].filter(Boolean)
  const locStr = locParts.length ? `${locParts.join('，')}。` : ''
  const envStr = vs.environment_depth ? `${vs.environment_depth}。` : ''
  parts.push(`【场景空间与纵深】${locStr}${envStr}`)

  const shotMap = {
    '特写': '特写镜头 (Close-up)',
    '大特写': '微距大特写 (Extreme Close-up)',
    '近景': '近景镜头 (Medium Close-up)',
    '中景': '中景镜头 (Medium Shot)',
    '中全景': '中全景镜头 (Medium Long Shot)',
    '全景': '全景镜头 (Long Shot / Full Shot)',
    '远景': '大远景镜头 (Extreme Long Shot)',
  }
  const hMap = {
    front: '正面平视',
    '3_4_left': '四分之三侧身朝左',
    '3_4_right': '四分之三侧身朝右',
    front_left: '前左45°机位',
    front_right: '前右45°机位',
    left: '左侧机位',
    right: '右侧机位',
    side_left: '正侧面朝左',
    side_right: '正侧面朝右',
    back: '背面视角',
    overhead: '俯视顶拍',
  }
  const vMap = {
    eye_level: '平视拍摄',
    low: '低机位仰拍',
    low_angle: '微仰角仰拍',
    high: '高机位俯拍',
    high_angle: '微俯角俯拍',
    worm: '极低仰拍',
    top_down: '正顶拍视角',
    dutch_angle: '倾斜荷兰角',
  }
  const dofMap = {
    shallow: '浅景深主体突出，背景奶油般柔和虚化',
    medium: '中等景深，主体与环境自然过渡',
    deep: '大景深，前后景均清晰可见',
    extreme_shallow: '超浅景深，焦点极其微薄细腻',
  }

  const camDesc = [
    shotMap[vs.shot_type] || vs.shot_type || '中景',
    hMap[vs.angle_h] || vs.angle_h || '',
    vMap[vs.angle_v] || vs.angle_v || '',
    dofMap[vs.depth_of_field] || '',
    vs.cinematic_lens || '',
  ].filter(Boolean).join('，')
  parts.push(`【机位景别】${camDesc}`)

  const chars = Array.isArray(vs.character_visuals) ? vs.character_visuals : []
  if (chars.length > 0) {
    const charPhrases = chars.map((c) => {
      const items = []
      if (c.depth_layer) items.push(`景深层级${optionLabel('depth_layer', c.depth_layer).replace(/\s*\([^)]*\)$/, '')}`)
      if (c.screen_position) items.push(optionLabel('screen_position', c.screen_position))
      if (c.environmental_anchor) items.push(c.environmental_anchor)
      if (c.facing) items.push(optionLabel('facing', c.facing))
      if (c.head_pose) items.push(optionLabel('head_pose', c.head_pose))
      if (c.gaze_type) {
        const gazeText = optionLabel('gaze_type', c.gaze_type)
        items.push(c.gaze_target_label ? `${gazeText}（${c.gaze_target_label}）` : gazeText)
      }
      if (c.posture) items.push(optionLabel('posture', c.posture))
      if (c.hands_state) items.push(optionLabel('hands_state', c.hands_state))
      if (c.expression) {
        const exprText = optionLabel('expression', c.expression)
        items.push(c.expression_detail ? `${exprText}（${c.expression_detail}）` : exprText)
      }
      if (c.appearance_details) items.push(c.appearance_details)
      return `角色「${c.name}」：${items.join('，')}`
    })
    const countRule = `画面中仅有且必须仅有 ${chars.length} 个人物（${chars.map((c) => c.name).join('、')}）。`
    parts.push(`【角色构图与姿态】${countRule}${charPhrases.join('；')}`)
  }

  if (vs.lighting_chiaroscuro) parts.push(`【光影影调】${vs.lighting_chiaroscuro}`)
  if (vs.start_framing) parts.push(`【起幅构图】${vs.start_framing}`)
  if (vs.end_framing) parts.push(`【落幅构图】${vs.end_framing}`)
  if (vs.transition_to_next) parts.push(`【下镜转场】${vs.transition_to_next}`)
  parts.push('【摄影风格】photorealistic, ultra-detailed, 8k uhd, sharp focus, natural cinematic lighting, RAW photo, real skin texture，首帧静止画面')

  return parts.join('\n')
}
