/**
 * 影视视听本体：生图构图与角色姿态槽位系统（Structured Visual Composition Slots System）
 * 所有角色首/尾帧视觉槽位统一遵守 `actionAtoms` 结构化枚举契约，
 * 严禁回归旧版 V1 自然语言正则兜底或服务端启发式槽位猜测。
 */

const actionAtoms = require('./actionAtoms');
const STRUCTURED_DEPTH_LAYERS = Object.freeze(['foreground', 'midground', 'background']);
const STRUCTURED_SCREEN_POSITIONS = Object.freeze([
  'left_foreground', 'left_midground', 'left_background', 'center_foreground',
  'center_midground', 'center_background', 'right_foreground', 'right_midground',
  'right_background',
]);

const DEPTH_LABELS = Object.freeze({
  foreground: '前景',
  midground: '中景',
  background: '后景',
});

const SCREEN_POSITION_LABELS = Object.freeze({
  left_foreground: '画面左侧前景',
  left_midground: '画面左侧中景',
  left_background: '画面左侧后景',
  center_foreground: '画面中央前景',
  center_midground: '画面中央中景',
  center_background: '画面中央后景',
  right_foreground: '画面右侧前景',
  right_midground: '画面右侧中景',
  right_background: '画面右侧后景',
});

const FACING_LABELS = Object.freeze({
  front_camera: '正面朝向镜头',
  back_camera: '背向镜头',
  left_profile: '正侧面朝向画面左侧',
  right_profile: '正侧面朝向画面右侧',
  three_quarter_left: '四分之三侧身面朝左',
  three_quarter_right: '四分之三侧身面朝右',
  toward_character: '身体转向目标角色',
  toward_object: '身体转向目标物体',
  toward_event: '身体转向事件源',
  away_from_camera: '背离镜头方向',
});

const HEAD_POSE_LABELS = Object.freeze({
  neutral: '头部正对自然保持',
  turned_left: '头部转向左侧',
  turned_right: '头部转向右侧',
  tilted_up: '头部微仰',
  tilted_down: '头部微俯',
  turned_to_target: '头部转向目标对象',
  lowered: '低头向下',
  raised: '抬头向上',
  recoiling: '受惊后仰躲避',
});

const GAZE_TYPE_LABELS = Object.freeze({
  camera: '注视镜头',
  character: '注视角色',
  prop: '注视道具',
  event: '注视事件源',
  scene: '观察场景',
  offscreen: '望向画外',
  ground: '低头看地面',
  none: '无固定视线',
});

const POSTURE_LABELS = Object.freeze({
  standing: '站立姿态',
  sitting: '坐姿',
  kneeling: '单膝或双膝跪姿',
  crouching: '蹲伏低姿',
  lying: '卧姿',
  leaning: '身体倚靠或前倾',
  walking: '行进迈步姿态',
  running: '奔跑冲刺姿态',
  falling: '失衡倾倒姿态',
  supported: '被扶持借力姿态',
});

const HAND_STATE_LABELS = Object.freeze({
  free: '双手自然空置',
  holding_object: '手持物体',
  reaching: '伸手探向目标',
  supporting_target: '伸手搀扶托住目标',
  pointing: '抬手指向目标',
  covering_mouth: '抬手掩口',
  on_surface: '手掌按在支撑表面',
  clenched: '紧握拳头',
  relaxed: '双手放松垂落',
});

const EXPRESSION_LABELS = Object.freeze({
  neutral: '神情平静',
  focused: '神情专注',
  alert: '神情警惕锐利',
  worried: '神情忧虑紧绷',
  angry: '神情愤怒紧绷',
  surprised: '神情震惊',
  pain: '神情痛苦隐忍',
  fear: '神情惊恐',
  relief: '神情松一口气',
  determined: '神情坚定决绝',
  sad: '神情悲伤低落',
  confused: '神情困惑迟疑',
  exhausted: '神情疲惫虚弱',
});

/**
 * 校验单镜的角色视觉槽位完整性（仅认结构化枚举契约，拒绝旧版自由文本字段）
 * @param {object} shot
 * @param {Array<object>} slots
 * @param {string} [slotField]
 * @returns {Array<object>} 违规列表
 */
function validateStructuredVisualSlots(shot, slots = [], slotField = 'character_visuals') {
  const violations = [];
  const shotNum = shot?.shot_number || shot?.storyboard_number || 1;
  const frameLabel = slotField === 'last_frame_visuals' ? '尾帧' : '首帧';
  const frame = slotField === 'last_frame_visuals' ? 'last' : 'first';

  if (!Array.isArray(slots) || slots.length === 0) {
    violations.push({
      rule: 'INVARIANT_SLOT_EMPTY',
      shot_number: shotNum,
      severity: 'error',
      frame,
      conflict_slots: [slotField],
      message: `${frameLabel}：分镜 ${shotNum} 缺少角色视觉槽位定义 (${slotField})。`,
    });
    return violations;
  }

  const enumFields = [
    ['depth_layer', STRUCTURED_DEPTH_LAYERS],
    ['screen_position', STRUCTURED_SCREEN_POSITIONS],
    ['facing', actionAtoms.FACING],
    ['head_pose', actionAtoms.HEAD_POSES],
    ['gaze_type', actionAtoms.GAZE_TYPES],
    ['posture', actionAtoms.POSTURES],
    ['hands_state', actionAtoms.HAND_STATES],
    ['expression', actionAtoms.EXPRESSIONS],
  ];

  slots.forEach((slot, sIdx) => {
    const cName = slot?.name || `出场人物${sIdx + 1}`;
    const charId = slot?.character_id != null ? Number(slot.character_id) : null;
    for (const [field, allowed] of enumFields) {
      const value = String(slot?.[field] ?? '');
      if (!allowed.includes(value)) {
        violations.push({
          rule: 'INVARIANT_VISUAL_ENUM_INVALID',
          shot_number: shotNum,
          severity: 'error',
          frame,
          character_id: charId,
          character_name: cName,
          conflict_slots: [`${slotField}[${sIdx}].${field}`],
          message: `${frameLabel}：分镜 ${shotNum} ${slotField}[${sIdx}].${field} 必须使用结构化枚举值（当前为 '${value}'，允许值: ${allowed.join('/')}）`,
        });
      }
    }
  });

  if (slots.length >= 2) {
    const byPosition = new Map();
    slots.forEach((slot, sIdx) => {
      const pos = String(slot?.screen_position || '').trim();
      if (!pos) return;
      if (!byPosition.has(pos)) byPosition.set(pos, []);
      byPosition.get(pos).push(sIdx);
    });
    for (const [pos, indices] of byPosition.entries()) {
      if (indices.length < 2) continue;
      const names = indices.map((i) => `「${slots[i]?.name || `角色${i + 1}`}」`).join('与');
      violations.push({
        rule: 'INVARIANT_SLOT_DUPLICATE_POSITION',
        shot_number: shotNum,
        severity: 'error',
        frame,
        conflict_slots: indices.map((i) => `${slotField}[${i}].screen_position`),
        message: `${frameLabel}：分镜 ${shotNum} 中角色${names}被安排在完全相同的构图位置（${pos}），必须错开画面左右/纵深位置，禁止多人叠站在同一位置！`,
      });
    }
  }

  return violations;
}

function validateCharacterVisualSlots(shot, slots = [], slotField = 'character_visuals') {
  return validateStructuredVisualSlots(shot, slots, slotField);
}

/**
 * 智能推导环境三层纵深（当 shot.environment_depth 未显式提供时兜底推导）
 * @param {object} shot
 * @returns {string} 三层空间纵深描述
 */
function synthesizeEnvironmentDepth(shot) {
  const loc = (shot.location || '').toLowerCase();
  const act = (shot.action || '').toLowerCase();
  const shotType = shot.shot_type || '';

  if (loc.includes('厂') || loc.includes('战') || loc.includes('废墟') || loc.includes('战区') || loc.includes('塔') || act.includes('掩体') || act.includes('枪')) {
    if (shotType === '特写' || shotType === '大特写') {
      return '前景微虚的战术掩体断壁边缘，中景为主体清晰面容与装备接触面，后景深处是残损建筑的暗调轮廓透视';
    }
    return '前景右下角虚化遮挡着残破掩体钢架，中景地表散落碎石与断裂线缆，背景纵深处是开阔破损结构的深远灭点透视';
  }

  if (loc.includes('房') || loc.includes('书桌') || loc.includes('室') || loc.includes('家') || loc.includes('电脑')) {
    if (shotType === '特写' || shotType === '大特写') {
      return '前景近处虚化遮挡的桌沿物件，中景精准合焦于主体细部，背景纵深处为柔和虚化的室内空间光晕';
    }
    return '前景虚化遮挡的桌面资料与实木家具边缘，中景为主体活动焦点核心区，背景纵深处为窗外透入的环境泛光与墙体陈设透视';
  }

  if (loc.includes('街') || loc.includes('路') || loc.includes('道') || loc.includes('外') || loc.includes('野')) {
    return '前景近处地面与街沿建筑虚化遮挡，中景开阔路面与活动主体，背景纵深处是渐远延伸的道路灭点与远方地平线轮廓';
  }

  return '空间三层纵深层次分明：前景轻微遮挡虚化引线，中景主体聚焦清晰，后景延伸至深邃视觉灭点';
}

/**
 * 智能推导影视镜头光学参数（当 shot.cinematic_lens 未显式提供时兜底推导）
 * @param {object} shot
 * @returns {string} 镜头参数
 */
function synthesizeCinematicLens(shot) {
  const shotType = shot.shot_type || '';
  const angleV = shot.angle_v || '';

  if (shotType === '大特写' || shotType === '特写') {
    return '85mm电影定焦镜头抓拍·f/1.8浅景深焦外散景·主体边缘锐利合焦';
  }
  if (shotType === '近景') {
    return '50mm电影定焦人像镜头·f/2.2适度景深透视逼真·背景自然光学虚化';
  }
  if (shotType === '全景' || shotType === '大远景') {
    return '24mm宽银幕电影广角镜头·大景深通透通焦·宏阔环境透视张力';
  }
  if (angleV === 'low' || angleV === 'worm') {
    return '35mm电影广角仰角镜头·透视畸变受控·突出压迫感张力';
  }
  if (angleV === 'high' || angleV === 'top_down') {
    return '35mm电影广角俯角镜头·层次感纵深全景铺展';
  }
  return '50mm经典电影大师镜头·f/2.8标准视场角·通透写实质感';
}

/**
 * 智能推导光影与明暗反差（当 shot.lighting_chiaroscuro 未显式提供时兜底推导）
 * @param {object} shot
 * @returns {string} 光影描述
 */
function synthesizeLightingChiaroscuro(shot) {
  const style = shot.lighting_style || 'natural';
  const lightMap = {
    natural: '电影级自然漫反射采光，面部明暗立体过渡自然，暗部保留丰富纹理',
    side: '强烈高反差侧光照明，雕刻面孔立体起伏与锐利明暗交界线',
    backlit: '高强度电影级轮廓逆光切边，发丝与肩膀金边勾勒，暗部微弱补光',
    dramatic: '经典伦勃朗三角光影调，戏剧性强光比反差与深沉阴影交融',
    soft: '柔和漫反射柔光箱照明，阴影清淡通透，肤质细腻写实',
    golden_hour: '暖金色低角度夕阳斜射，温润金色侧光与长投影交织',
    blue_hour: '幽蓝冷调暮光氛围，环境冷光与面部弱冷光交融',
    night: '暗夜微光照明，局部点光源照亮焦点，大面积电影级深邃暗场',
    neon: '冷暖双色霓虹反差光，蓝粉交错的赛博电影感光影反差',
  };
  return lightMap[style] || '高反差电影级光影照明，立体明暗质感鲜明';
}

/**
 * 确定性编译器：将槽位编译为纯静态摄影抓拍级的 image_prompt
 * @param {object} shot
 * @param {Array<object>} slots
 * @param {object} options
 * @returns {string} 编译后的 image_prompt
 */
function renderFrameSlots(shot, slots, options = {}, last = false) {
  const parts = [];
  const append = (label, values) => {
    const body = [...new Set(values.filter(v => typeof v === 'string' && v.trim()).map(v => v.trim()))].join('；');
    if (body) parts.push(`【${label}】${body}`);
  };
  append('场景空间', [shot.location, shot.time, shot.environment_depth]);
  append(last ? '落幅构图' : '起幅构图', [last ? shot.end_framing : shot.start_framing, shot.layout_description, shot.dialogue_framing]);
  const horizontal = { front: '正面机位', front_left: '前左机位', front_right: '前右机位', left: '左侧机位', right: '右侧机位', back: '背面机位', back_left: '后左机位', back_right: '后右机位' };
  const vertical = { eye_level: '平视', low: '仰拍', high: '俯拍', top_down: '顶拍', worm: '极低仰拍' };
  append('机位景别', [shot.shot_type, horizontal[shot.angle_h], vertical[shot.angle_v], shot.cinematic_lens]);
  for (const v of (Array.isArray(slots) ? slots : [])) {
    if (!v || typeof v !== 'object') continue;
    const screenPos = SCREEN_POSITION_LABELS[v.screen_position] || v.screen_position;
    const depthLayer = DEPTH_LABELS[v.depth_layer] || v.depth_layer;
    const facing = FACING_LABELS[v.facing] || v.facing;
    const headPose = HEAD_POSE_LABELS[v.head_pose] || v.head_pose;
    const gazeBase = GAZE_TYPE_LABELS[v.gaze_type] || '';
    const gaze = v.gaze_target_label
      ? (gazeBase ? `${gazeBase}：${v.gaze_target_label}` : v.gaze_target_label)
      : gazeBase;
    const posture = POSTURE_LABELS[v.posture] || v.posture;
    const hands = HAND_STATE_LABELS[v.hands_state] || v.hands_state;
    const exprBase = EXPRESSION_LABELS[v.expression] || v.expression;
    const expression = v.expression_detail
      ? (exprBase && exprBase !== v.expression_detail ? `${exprBase}（${v.expression_detail}）` : v.expression_detail)
      : exprBase;
    append(v.name || `角色${v.character_id || v.id}`, [
      screenPos, v.environmental_anchor, depthLayer,
      facing, headPose, gaze, posture, hands,
      expression, v.appearance_details, v.activity, v.mouth_state,
    ]);
  }
  append('光影', [shot.lighting_chiaroscuro || shot.lighting_style, shot.atmosphere]);
  append('画风', [options.style]);
  parts.push(last ? '尾帧静止画面。' : '首帧静止画面。');
  return parts.join('\n');
}

function compileImagePromptFromSlots(shot, slots = [], options = {}) {
  return renderFrameSlots(shot, slots, options, false);
}

/**
 * 确定性尾帧编译器：将尾帧槽位编译为纯静态摄影抓拍级的 last_frame prompt
 * @param {object} shot
 * @param {Array<object>} slots
 * @param {object} options
 * @returns {string} 编译后的 last_frame prompt
 */
function compileLastFramePromptFromSlots(shot, slots = [], options = {}) {
  return renderFrameSlots(shot, slots, options, true);
}

module.exports = {
  STRUCTURED_DEPTH_LAYERS,
  STRUCTURED_SCREEN_POSITIONS,
  validateStructuredVisualSlots,
  validateCharacterVisualSlots,
  synthesizeLightingChiaroscuro,
  compileImagePromptFromSlots,
  compileLastFramePromptFromSlots,
};
