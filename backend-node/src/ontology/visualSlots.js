/**
 * 影视视听本体：生图构图与角色姿态槽位系统（Visual Composition Slots System）
 * 遵循 SHACL 预置槽位（Slots Contract）原则：
 * 绝不依赖模型自由发挥无结构文本，而是强制预置具有明确物理意义的槽位：
 * 1. 人物朝向 (facing)：正面面对镜头 / 背向镜头 / 侧身朝向画面左侧 / 侧身朝向画面右侧 / 四分之三侧身面朝左 / 四分之三侧身面朝右
 * 2. 头部姿态 (head_pose)：头部正对前方 / 头部微仰 / 低头咬牙 / 侧头偏向右侧 / 侧头偏向左侧 / 转头回望
 * 3. 目光视线 (gaze)：双眼紧盯前方冷光屏幕 / 目光警惕锁定高窗火力点 / 视线锁定右侧岔路
 * 4. 画面单一站位 (spatial_anchor)：画面左侧近景掩体后 / 画面中央书桌前（严禁出现“从A到B”的多点轨迹，防止模型画出两个克隆人！）
 * 5. 躯干体态与重心 (posture)：半蹲低伏 / 单膝跪地 / 身体前倾30度坐姿 / 侧卧撑地 / 飞扑定格
 * 6. 四肢与手部动作 (hands)：双手搭在键盘按键上方 / 右手紧按战术耳机 / 双手持枪戒备 / 单臂平举直指前方
 *
 * 通过确定性编译器（Deterministic Slot Compiler）将槽位合成为最终的高质量生图提示词。
 */

const SCREEN_POSITION_REGEX = /(?:画面(?:左侧|右侧|中央|正中|正中央|左前|右前|左后|右后|左前方|右前方|左后方|右后方|前景|中景|后景|近景|远景|深处|景深处|左半部|右半部|边缘|靠左|靠右|靠前|靠后|左侧中景|右侧中景|左侧远景|右侧远景|左侧前景|右侧前景|左侧近景|右侧近景)|左下角|右下角|左上方|右上方|左下方|右下方|左侧三分线|右侧三分线|三分线|居中|偏左|偏右|靠左|靠右|正中央|正中|中央|左侧|右侧|左前方?|右前方?|左后方?|右后方?|前景|中景|后景|景深处|近景|远景|screen_left|screen_right|screen_center|foreground|midground|background)/i;
const FACING_REGEX = /(?:正面|正对|背对|背面|背向|朝左|朝右|朝前|朝后|侧身|侧向|侧面|微侧|三刻|四分之三|3\/4|转朝|面朝|面对|朝向|面向|斜向|前左|前右|后左|后右|左前|右前|左后|右后|左侧|右侧|剪影|front|back|left|right|facing|three_quarter|profile)/i;
const HEAD_POSE_REGEX = /(?:头|仰|低头|偏头|转头|正对|回望|俯视|仰视|侧头|head|tilt|turn)/i;
const GAZE_REGEX = /(?:目光|视线|看|眼|注视|盯|凝视|锁定|瞄准|gaze|look|eye|watch)/i;
const POSTURE_REGEX = /(?:站|蹲|坐|卧|趴|扑|俯|仰|倾|跪|靠|crouch|stand|kneel|lean|prone|sit|lie|stride|奔|跑|跃|步|斜躺|低姿|姿态|姿势|姿|立|挺|后仰|消散|瘫|倒)/i;
const HANDS_REGEX = /(?:手|臂|指|握|按|托|撑|抱|搭|提|拿|拉|伸|扣|掌|持|抓|悬|垂|置|放|hand|arm|finger|hold|grip|press)/i;

// 导致文生图模型产生克隆人/多角色的两地时序位移与动态过程正则
const CLONE_TRIGGER_REGEX = /(?:从.+?到.+?|从.+?跑向|从.+?冲向|从.+?跨向|沿.+?走到|从.+?走到|从.+?探出.+?缩回|来回(?:看|确认|扫视))/;
const DYNAMIC_REGEX = /(?:先指向.+?再|急停后|翻滚到|停止翻找|从.+?连续下降|倒计时跳到|操作速度.+?变慢|转向屏幕|抬起通讯器位置|抬头观察高台|红狼没有停步|看了一眼|随后|然后|逐渐|开始)/;

function createCharacterVisualSlot(data = {}) {
  const screenPos = String(data.screen_position || '').trim();
  const envAnchor = String(data.environmental_anchor || '').trim();
  const spatialAnchor = String(data.spatial_anchor || '').trim();

  let finalScreenPos = screenPos;
  let finalEnvAnchor = envAnchor;

  if (!finalScreenPos && spatialAnchor) {
    const m = spatialAnchor.match(/^(?:画面)?(?:左侧|右侧|中央|正中|正中央|左前|右前|左后|右后|左前方|右前方|左后方|右后方|前景|中景|后景|近景|远景|深处|景深处|左下角|右下角|左上方|右上方|左下方|右下方|左侧三分线|右侧三分线|三分线|居中|偏左|偏右|靠左|靠右)[^，,\s]*/);
    if (m) {
      finalScreenPos = m[0];
      finalEnvAnchor = spatialAnchor.slice(m[0].length).replace(/^[，,\s]+/, '');
    } else {
      finalScreenPos = spatialAnchor;
    }
  }

  // 智能推断或规整 Z 轴纵深层级 (foreground 前景 / midground 中景 / background 后景)
  let depthLayer = String(data.depth_layer || '').trim().toLowerCase();
  if (!depthLayer) {
    const combined = `${finalScreenPos} ${spatialAnchor}`;
    if (/(?:前景|近景|近处|左前|右前|左前方|右前方|过肩|foreground)/i.test(combined)) depthLayer = 'foreground';
    else if (/(?:后景|远处|深处|远景|后方|左后|右后|左后方|右后方|背景|background)/i.test(combined)) depthLayer = 'background';
    else depthLayer = 'midground';
  }

  return {
    character_id: data.character_id != null ? Number(data.character_id) : null,
    name: String(data.name || '').trim(),
    depth_layer: depthLayer,
    screen_position: finalScreenPos || '画面中央',
    environmental_anchor: finalEnvAnchor || '',
    spatial_anchor: spatialAnchor || (finalEnvAnchor ? `${finalScreenPos}${finalEnvAnchor}` : finalScreenPos),
    facing: String(data.facing || '').trim(),
    expression: String(data.expression || '').trim(),
    head_pose: String(data.head_pose || (data.head_gaze && !data.gaze ? data.head_gaze : '')).trim(),
    gaze: String(data.gaze || (data.head_gaze && !data.head_pose ? data.head_gaze : '')).trim(),
    head_gaze: String(data.head_gaze || '').trim(),
    posture: String(data.posture || '').trim(),
    hands: String(data.hands || '').trim(),
    appearance_details: String(data.appearance_details || '').trim(),
    prop_interaction: String(data.prop_interaction || '').trim(),
  };
}

/**
 * 校验单镜的角色视觉槽位完整性与静态性（严格防止克隆人与多人物崩坏）
 * @param {object} shot
 * @param {Array<object>} slots
 * @returns {Array<object>} 违规列表
 */
function validateCharacterVisualSlots(shot, slots = [], slotField = 'character_visuals') {
  const violations = [];
  const shotNum = shot.shot_number || shot.storyboard_number || 1;

  if (!Array.isArray(slots) || slots.length === 0) {
    violations.push({
      rule: 'INVARIANT_SLOT_EMPTY',
      shot_number: shotNum,
      severity: 'error',
      message: `分镜 ${shotNum} 缺少角色视觉槽位定义 (character_visuals)。`,
    });
    return violations;
  }

  slots.forEach((slot, sIdx) => {
    const cName = slot.name || `出场人物${sIdx + 1}`;

    // 1. 画面位置槽位必须明确（防止主体中心随机堆叠、多人重影穿模）
    const posText = `${slot.screen_position || ''} ${slot.spatial_anchor || ''}`;
    if (!posText.trim() || !SCREEN_POSITION_REGEX.test(posText)) {
      violations.push({
        rule: 'INVARIANT_SLOT_MISSING_SCREEN_POSITION',
        shot_number: shotNum,
        severity: 'error',
        character_id: slot.character_id != null ? Number(slot.character_id) : null,
        character_name: cName,
        conflict_slots: [`character_visuals[${sIdx}].screen_position`],
        message: `分镜 ${shotNum} 角色「${cName}」缺少画面构图位置槽位 (screen_position)，必须明确人物在画面中的具体构图位置（如：画面左侧前景、画面正中央、画面右侧中景等），防止生图模型默认正中呆立或双人重叠穿模！`,
      });
    }

    // 2. 朝向槽位必须明确（防止参考图正面呆立）
    if (!slot.facing || !FACING_REGEX.test(slot.facing)) {
      violations.push({
        rule: 'INVARIANT_SLOT_MISSING_FACING',
        shot_number: shotNum,
        severity: 'error',
        character_id: slot.character_id != null ? Number(slot.character_id) : null,
        character_name: cName,
        conflict_slots: [`character_visuals[${sIdx}].facing`],
        message: `分镜 ${shotNum} 角色「${cName}」缺少明确的人物朝向槽位 (facing)，必须指明朝向（如：正面面对镜头、侧身朝向画面左侧、侧身朝向画面右侧、背向镜头等）。`,
      });
    }

    // 2. 头部姿态槽位
    const headText = `${slot.head_pose || ''} ${slot.head_gaze || ''}`;
    if (!headText.trim() || !HEAD_POSE_REGEX.test(headText)) {
      violations.push({
        rule: 'INVARIANT_SLOT_MISSING_HEAD_POSE',
        shot_number: shotNum,
        severity: 'error',
        character_id: slot.character_id != null ? Number(slot.character_id) : null,
        character_name: cName,
        conflict_slots: [`character_visuals[${sIdx}].head_pose`],
        message: `分镜 ${shotNum} 角色「${cName}」缺少头部姿态槽位 (head_pose)，必须指明头部朝向与姿势（如：头部正对前方、微仰起头、侧头偏向右侧、低头等）。`,
      });
    }

    // 3. 目光视线槽位
    const gazeText = `${slot.gaze || ''} ${slot.head_gaze || ''}`;
    if (!gazeText.trim() || !GAZE_REGEX.test(gazeText)) {
      violations.push({
        rule: 'INVARIANT_SLOT_MISSING_GAZE',
        shot_number: shotNum,
        severity: 'error',
        character_id: slot.character_id != null ? Number(slot.character_id) : null,
        character_name: cName,
        conflict_slots: [`character_visuals[${sIdx}].gaze`],
        message: `分镜 ${shotNum} 角色「${cName}」缺少视线注视槽位 (gaze)，必须指明目光落点（如：双眼紧盯前方冷光屏幕、目光警惕锁定高窗火力点等）。`,
      });
    }

    // 4. 躯干体态与重心必须具体，不能是无姿态
    if (!slot.posture || !POSTURE_REGEX.test(slot.posture) || slot.posture.length < 3) {
      violations.push({
        rule: 'INVARIANT_SLOT_MISSING_POSTURE',
        shot_number: shotNum,
        severity: 'error',
        character_id: slot.character_id != null ? Number(slot.character_id) : null,
        character_name: cName,
        conflict_slots: [`character_visuals[${sIdx}].posture`],
        message: `分镜 ${shotNum} 角色「${cName}」缺少具体的躯干体态与重心槽位 (posture)，严禁只写名字或身体，必须具体（如：半蹲低伏、单膝跪姿、身体前倾30度坐姿等）。`,
      });
    }

    // 5. 四肢与手部动作
    if (!slot.hands || !HANDS_REGEX.test(slot.hands)) {
      violations.push({
        rule: 'INVARIANT_SLOT_MISSING_HANDS',
        shot_number: shotNum,
        severity: 'error',
        character_id: slot.character_id != null ? Number(slot.character_id) : null,
        character_name: cName,
        conflict_slots: [`character_visuals[${sIdx}].hands`],
        message: `分镜 ${shotNum} 角色「${cName}」缺少手部动作槽位 (hands)，必须指明双手具体动作（如：双手手指悬在按键上方、右手紧按战术耳机、双手持枪等）。`,
      });
    }

    // 6. 严防两地轨迹位移（导致生图模型在两处各画一个人出现克隆人/分身）
    const fullText = `${slot.spatial_anchor || ''} ${slot.facing} ${slot.posture} ${slot.hands} ${slot.head_pose || ''} ${slot.gaze || ''} ${slot.head_gaze || ''}`;
    if (CLONE_TRIGGER_REGEX.test(fullText)) {
      violations.push({
        rule: 'INVARIANT_MULTI_POSITION_CLONE_RISK',
        shot_number: shotNum,
        severity: 'error',
        message: `分镜 ${shotNum} 角色「${cName}」描述中包含两地轨迹位移动态（如“从A到B/跑向/走到”），文生图模型会将两处各画一人导致克隆人！必须锁定在单一物理站位并描述首帧定格姿态！`,
      });
    }

    // 7. 绝对禁止视频化时序动态
    if (DYNAMIC_REGEX.test(fullText)) {
      violations.push({
        rule: 'INVARIANT_SLOT_DYNAMIC_ACTION',
        shot_number: shotNum,
        severity: 'error',
        message: `分镜 ${shotNum} 角色「${cName}」视觉槽位中包含视频化时序动态描述，生图模型无法绘制动态过程，必须改为决定性瞬间静态定格！`,
      });
    }
  });

  // 8. 多人构图空间关系审查：防止双人完全重叠，并审查远近前后纵深层级 (Z-Axis Depth Staging)
  if (slots.length >= 2) {
    const posList = slots.map((s) => `${s.screen_position || ''} ${s.spatial_anchor || ''}`);
    // 检查是否全挤在完全相同的点
    if (posList.length === 2 && posList[0].trim() === posList[1].trim() && posList[0].trim() !== '') {
      violations.push({
        rule: 'INVARIANT_SLOT_DUPLICATE_POSITION',
        shot_number: shotNum,
        severity: 'error',
        message: `分镜 ${shotNum} 中两名角色（「${slots[0].name || '角色1'}」与「${slots[1].name || '角色2'}」）被安排在完全相同的构图位置（${posList[0]}），将导致生图模型产生严重的二人重叠穿模与克隆！必须一左一右并区分前后远近纵深！`,
      });
    }

    // 检查是否存在前后远近纵深关系 (Z-Axis Depth Staging)
    const hasForeground = slots.some((s) => s.depth_layer === 'foreground' || /(?:前景|近处|近景|前侧|左前|右前|左前方|右前方|过肩)/i.test(`${s.screen_position} ${s.spatial_anchor}`));
    const hasBackOrMid = slots.some((s) => s.depth_layer === 'background' || /(?:后景|远处|深处|后方|左后|右后|左后方|右后方|背景)/i.test(`${s.screen_position} ${s.spatial_anchor}`));

    // 如果所有角色只有横向左右（如全是“画面左侧”、“画面右侧”），没有任何前后远近纵深词
    const allFlat = !hasForeground && !hasBackOrMid && !slots.some((s) => /(?:前景|近景|近处|后景|深处|远处|左前|右前|左前方|右前方|左后|右后|左后方|右后方|过肩)/i.test(`${s.screen_position} ${s.spatial_anchor}`));
    if (allFlat) {
      violations.push({
        rule: 'INVARIANT_SLOT_MISSING_DEPTH_STAGING',
        shot_number: shotNum,
        severity: 'warning',
        message: `分镜 ${shotNum} 多人同框仅有左右横向站位，缺少前后远近纵深关系（Z轴前后层次），容易导致画面呈扁平纸片人贴立。建议构图引入一前一后（如：前景过肩/近身背影 vs 中景正面焦点，或中景主体 vs 后景纵深掩护）。`,
      });
    }
  }

  return violations.map(violation => ({
    ...violation,
    frame: slotField === 'last_frame_visuals' ? 'last' : 'first',
    conflict_slots: (violation.conflict_slots || [slotField]).map(field => field.replace(/^character_visuals/, slotField)),
    message: `${slotField === 'last_frame_visuals' ? '尾帧' : '首帧'}：${violation.message}`,
  }));
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
  for (const v of slots) {
    append(v.name || `角色${v.character_id || v.id}`, [
      v.screen_position, v.spatial_anchor, v.environmental_anchor, v.depth_layer,
      v.facing, v.head_pose, v.gaze, v.expression, v.posture, v.hands,
      v.prop_interaction, v.appearance_details, v.activity, v.mouth_state,
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
 * 槽位智能合成与提取器（将现有提示词或剧本动作无损映射到强类型槽位）
 * 供工程兜底及已有分镜槽位补全
 * @param {object} shot
 * @param {Array<object>} catalogCharacters
 * @returns {Array<object>} 补齐后的 character_visuals
 */
function synthesizeCharacterVisualSlots(shot, catalogCharacters = []) {
  const charIds = [];
  if (Array.isArray(shot.characters)) {
    charIds.push(...shot.characters.map(Number));
  } else if (typeof shot.characters === 'string') {
    try {
      const p = JSON.parse(shot.characters);
      if (Array.isArray(p)) charIds.push(...p.map(Number));
    } catch (_) {}
  }

  const charMap = new Map();
  (catalogCharacters || []).forEach((c) => {
    if (c && c.id != null) charMap.set(Number(c.id), c);
  });

  const hMap = {
    front: '正面面对镜头',
    front_left: '侧身朝向画面左侧',
    front_right: '侧身朝向画面右侧',
    left: '正侧面朝向画面左侧',
    right: '正侧面朝向画面右侧',
    back: '背向镜头',
    back_left: '侧背向画面左侧',
    back_right: '侧背向画面右侧',
  };
  const defaultFacing = hMap[shot.angle_h] || '正面面对镜头';

  // 若已有合法槽位则优先复用
  if (Array.isArray(shot.character_visuals) && shot.character_visuals.length > 0) {
    return shot.character_visuals.map((v) => createCharacterVisualSlot(v));
  }

  const sourceText = [shot.action, shot.description, shot.layout_description, shot.location]
    .filter(Boolean)
    .join('；');
  const prompt = sourceText;

  // 智能推断或复用对话视听构图槽位（做选择题，告别自然语言含糊脑补）
  // 可选值：two_shot_face_to_face (双人面对面对视) / over_the_shoulder (过肩拍) / single_reaction_offscreen (单人视线看画外) / joint_observation (双人同向观察) / solo_action (单人动作)
  const hasDialogue = Boolean(String(shot.dialogue || '').trim());
  let framing = shot.dialogue_framing;
  if (!framing) {
    if (charIds.length >= 2) {
      if (hasDialogue || /(?:对视|面对面|交谈|询问|商议|低语|确认|看着对方|商量)/i.test(prompt)) {
        framing = (shot.shot_type === '近景' || shot.shot_type === '特写' || /(?:过肩|后颈|背影|OTS)/i.test(prompt))
          ? 'over_the_shoulder'
          : 'two_shot_face_to_face';
      } else if (/(?:警戒|搜寻|瞄准|撤离|潜行|看前方|看屏幕|看大屏|看二层|看高台)/i.test(prompt)) {
        framing = 'joint_observation';
      } else {
        framing = 'two_shot_face_to_face';
      }
    } else if (charIds.length === 1) {
      framing = hasDialogue ? 'single_reaction_offscreen' : 'solo_action';
    } else {
      framing = 'solo_action';
    }
  }

  // 对每个出场角色构造结构化槽位
  return charIds.map((cid, idx) => {
    const charObj = charMap.get(cid) || {};
    const name = charObj.name || (charIds.length === 1 ? '主角' : `人物${idx + 1}`);
    const otherCharNames = charIds
      .filter((_, i) => i !== idx)
      .map((id) => charMap.get(id)?.name || '对方')
      .join('与');
    const partnerName = otherCharNames || '戏中搭档';

    let facing = defaultFacing;
    let headPose = '头部微侧面向行动方向';
    let gaze = '目光专注于当前行动目标，镜头捕捉自然的三分之四侧脸';

    if (charIds.length >= 2) {
      if (framing === 'over_the_shoulder' || /(?:过肩|OTS|背身|肩后)/i.test(framing)) {
        if (idx === 0) {
          facing = '侧身背向镜头（露出右肩与侧背轮廓，充当过肩前景）';
          headPose = `侧头面向后景中的${partnerName}`;
          gaze = `视线延伸至后景${partnerName}身上，建立纵深视线轴`;
        } else {
          facing = `3/4正侧面迎向前景的${charMap.get(charIds[0])?.name || '搭档'}`;
          headPose = `正视前景中的${charMap.get(charIds[0])?.name || '搭档'}`;
          gaze = `目光深邃凝视着前景的${charMap.get(charIds[0])?.name || '搭档'}，双方眼神自然交汇`;
        }
      } else if (framing === 'joint_observation' || /(?:同向|警戒|观察|大屏|屏幕|搜索|巡视)/i.test(framing)) {
        if (idx === 0) {
          facing = '身体微向右前方3/4侧立';
          headPose = '头部保持战术警戒姿态';
          gaze = '目光锐利锁定前方共同观察目标';
        } else {
          facing = '身体微向左前方3/4侧立';
          headPose = '头部保持战术警戒姿态';
          gaze = '目光锐利锁定前方共同观察目标';
        }
      } else if (/(?:背靠背|背对背)/i.test(framing)) {
        if (idx === 0) {
          facing = '身体朝向画面左前方，背部微靠搭档形成战术掩护';
          headPose = '侧头警戒左侧视界';
          gaze = '目光警惕扫视左方通道';
        } else {
          facing = '身体朝向画面右后方，背部微靠搭档形成战术掩护';
          headPose = '侧头警戒右侧死角';
          gaze = '目光警惕扫视右方死角';
        }
      } else if (framing && framing !== 'two_shot_face_to_face' && framing !== 'solo_action') {
        // 自定义开放式构图描述（尊重模型与用户自由发挥）
        if (idx === 0) {
          facing = '3/4侧身朝向画面右侧（偏向戏中搭档）';
          headPose = `微侧头面向${partnerName}`;
          gaze = `目光专注与${partnerName}互动（${framing}），视线落在搭档身上`;
        } else {
          facing = '3/4侧身朝向画面左侧（偏向戏中搭档）';
          headPose = `微侧头迎向${partnerName}`;
          gaze = `神情专注自然交流（${framing}），视线落在搭档身上`;
        }
      } else {
        // two_shot_face_to_face (双人面对面对视闭环，杜绝双正脸直视镜头跟空气说话)
        if (idx === 0) {
          facing = '3/4侧身朝向画面右侧（侧身面向戏中搭档）';
          headPose = `微侧头面向右侧的${partnerName}`;
          gaze = `目光专注注视着右侧的${partnerName}，眼神对视交流`;
        } else {
          facing = '3/4侧身朝向画面左侧（侧身面向戏中搭档）';
          headPose = `微侧头面向左侧的${partnerName}`;
          gaze = `眼神迎上左侧的${partnerName}，专注对视倾听`;
        }
      }
    } else {
      // 单人出场场景
      if (framing === 'single_reaction_offscreen' || hasDialogue) {
        facing = '身体微侧30度（3/4侧面视角）';
        headPose = '侧头微偏向画外侧方';
        gaze = '目光专注注视着画外的对话搭档，呈自然三分之四侧脸';
      } else {
        // 单人无对白动作
        if (/(?:背对|背面|背向)/i.test(prompt)) facing = '背向镜头';
        else if (/(?:侧身|侧向|朝向|偏向).*(?:左)/i.test(prompt) || shot.angle_h === 'front_left' || shot.angle_h === 'left') facing = '侧身朝向画面左侧';
        else if (/(?:侧身|侧向|朝向|偏向).*(?:右)/i.test(prompt) || shot.angle_h === 'front_right' || shot.angle_h === 'right') facing = '侧身朝向画面右侧';
        else facing = defaultFacing;

        if (/(?:锁定高台|二层窗口)/i.test(prompt)) {
          headPose = '微仰起头';
          gaze = '目光警惕锁定二层窗口火力点';
        } else if (/(?:右侧岔路|岔口)/i.test(prompt)) {
          headPose = '侧头偏向右侧';
          gaze = '目光锐利锁定右侧岔路口';
        } else if (/(?:大屏|拓扑|投影)/i.test(prompt)) {
          headPose = '头部微仰正对大屏';
          gaze = '双眼专注凝视前方大屏核心节点';
        } else if (/(?:屏幕|显示器|冷光)/i.test(prompt)) {
          headPose = '头部微低正对屏幕';
          gaze = '双眼固执专注地紧盯前方冷光屏幕';
        } else if (/(?:作业本|桌面|资料|文件)/i.test(prompt)) {
          headPose = '低头俯视桌面';
          gaze = '双眼凝视桌面上铺开的资料目标';
        } else {
          headPose = '头部随动作自然倾斜';
          gaze = '目光专注于当前行动与环境目标，呈自然工作状态';
        }
      }
    }

    const isTactical = /(?:断墙|战术装备|战术武器|战术耳机|掩体|火力|持枪|射击|拔枪|冲锋枪|突击步枪|手枪|子弹|废弃工厂|潜行|撤离|废墟)/i.test(prompt) || /(?:断墙|掩体|废弃工厂|废墟)/i.test(shot.location || '');

    let depthLayer = 'midground';
    let anchor = '画面中央中景';
    if (charIds.length >= 2) {
      if (idx === 0) {
        depthLayer = 'foreground';
        anchor = shot.angle_h === 'front_left' ? '画面左侧前景近景' : '画面左前近景过肩';
      } else if (idx === 1) {
        depthLayer = 'midground';
        anchor = isTactical ? '画面右侧中景掩体后' : '画面右侧中景';
      } else {
        depthLayer = 'background';
        anchor = '画面后景深处通道旁';
      }
    } else {
      anchor = idx === 0 ? (shot.angle_h === 'front_left' ? '画面左侧近景' : '画面中央前景') : (isTactical ? '画面右侧掩体后' : '画面右侧中景');
      if (shot.layout_description) {
        if (shot.layout_description.includes('左侧')) anchor = '画面左侧';
        else if (shot.layout_description.includes('右侧')) anchor = '画面右侧';
        else if (shot.layout_description.includes('中央') || shot.layout_description.includes('中间')) anchor = '画面中央';
      }
    }

    let posture = isTactical
      ? (idx === 0 ? '身体屈膝下潜倚靠掩体边缘，重心压低机动待发' : '侧身贴紧掩体后壁，身体微俯避开射界')
      : (idx === 0 ? '挺拔立姿微侧，重心稳固自然' : '身姿端正微侧向主体，重心平稳放松');
    if (/(?:半蹲|俯伏|深蹲|蹲伏)/i.test(prompt)) posture = '半蹲低伏紧贴掩体，重心压低';
    else if (/(?:拍桌|拍案|拍在.+?桌|拍向.+?桌|拍桌面|猛拍桌面|掌心.+?拍|拍.+?桌面)/i.test(prompt)) posture = '身体前倾定格，上身偏向会议桌面';
    else if (/(?:前倾|坐姿|坐在书桌前|坐在会议桌)/i.test(prompt)) posture = '身体前倾坐姿，上身紧贴桌台边缘';
    else if (/(?:单膝跪地|屈膝|跪姿)/i.test(prompt)) posture = '单膝跪地身体微侧，保持低位隐蔽';
    else if (/(?:侧卧|趴在|跌倒|失去平衡|失衡|向前扑倒|扑向)/i.test(prompt)) posture = '侧身撑地身体大幅倾斜失衡，单手撑地';
    else if (/(?:飞扑|跃出|凌空)/i.test(prompt)) posture = '身体凌空大幅前跃扑出，重心前倾';
    else if (/(?:大步奔|奔跑|疾冲|冲刺)/i.test(prompt)) posture = '大步屈膝奔冲，动作迅猛重心前移';
    else if (/(?:站立|站直|起身|直起|直身)/i.test(prompt)) posture = '挺拔端正站立，身体重心平稳';
    else if (/(?:侧身靠墙|背靠)/i.test(prompt)) posture = '侧身背靠墙壁，身体重心稳固';

    let hands = isTactical
      ? (idx === 0 ? '双手握持战术设备严密护于胸前，食指搭在扳机护圈外侧' : '单手按在战术胸挂外缘，另一手微屈随时准备协同')
      : (idx === 0 ? '双手手指自然放松微弯，随体态自然悬于身侧' : '双手微曲交叠置于身前，神态专注聆听');
    if (/(?:拍桌|拍案|拍在.+?桌|拍向.+?桌|拍桌面|猛拍桌面|掌心.+?拍|拍.+?桌面)/i.test(prompt)) hands = '单手掌心按在桌面边缘定格，另一手收在身侧';
    else if (/(?:攥拳|握拳|指节)/i.test(prompt)) hands = '单手在身侧紧紧攥拳，指节发白定格';
    else if (/(?:收回胸前|掌心下压|压住动作)/i.test(prompt)) hands = '双手收于胸前，掌心微下压定格';
    else if (/(?:键盘|按键|鼠标)/i.test(prompt)) hands = '双手手指搭在键盘按键上方僵持停滞';
    else if (/(?:通讯|耳机)/i.test(prompt)) hands = '单手手指紧按在战术通讯耳机上，另一手护在身前';
    else if (/(?:枪|武器|持枪)/i.test(prompt)) hands = '双手紧握战术武器呈戒备瞄准姿态';
    else if (/(?:抬手指向|手指指向|单手指|抬手指|手势指向|单臂平举|指向)/i.test(prompt)) {
      if (/(?:大屏|屏幕|投影)/i.test(prompt)) {
        hands = '单臂平举直指前方大屏展示方向';
      } else if (/(?:掩体|断墙|战友|通道|岔路|窗口|门)/i.test(prompt)) {
        const target = prompt.match(/(?:掩体|断墙|战友|通道|岔路|窗口|门)/)?.[0] || '目标';
        hands = `单臂向前抬起，食指直指${target}方向`;
      } else {
        hands = '单臂平举，手指直指前方行动方向';
      }
    }
    else if (/(?:按在.+肩|按住.+肩)/i.test(prompt)) hands = '单手按在对方肩膀上，另一手撑在掩体边缘';
    else if (/(?:撑住地面|撑地)/i.test(prompt)) hands = '单手手掌牢牢撑向地面保持平衡';
    else if (/(?:伸展手指|伸手扑向)/i.test(prompt)) hands = '单臂竭力向前伸展手指抓向目标';

    let expression = isTactical
      ? (idx === 0 ? '咬肌微绷，下颌微收，眼神警惕锐利' : '神态凝重坚毅，呼吸平稳克制')
      : (idx === 0 ? '目光专注清亮，神情认真凝练' : '神情沉着，目光温和而敏锐');
    if (/(?:焦急|急促|心急)/i.test(prompt)) expression = '眉头微蹙，眼神焦灼而迫切';
    else if (/(?:愤怒|发火|震怒)/i.test(prompt)) expression = '下颌紧咬，目光如炬带着怒意';
    else if (/(?:恐惧|惊恐|惊慌)/i.test(prompt)) expression = '瞳孔微缩，呼吸急促神情惊凛';
    else if (/(?:欣慰|微笑|释然)/i.test(prompt)) expression = '嘴角微抿带出一丝释然与克制的笑意';

    let propInteraction = '';
    if (/(?:枪|武器|匕首|步枪|手枪|持枪|射击|瞄准)/i.test(prompt) && !/(?:撑地|撑向地面|指向|按在.+肩|抓向)/i.test(hands)) {
      propInteraction = '手指紧扣握柄防滑纹路，虎口紧密贴合机匣';
    } else if (/(?:键盘|按键|打字)/i.test(prompt)) {
      propInteraction = '指腹轻触键盘键帽，腕部悬空保持敲击定格姿态';
    } else if (/(?:手机|终端|对讲机|耳机)/i.test(prompt)) {
      propInteraction = '食指与拇指紧捏设备边缘控制按键';
    } else if (/(?:笔|写字|文件|资料)/i.test(prompt)) {
      propInteraction = '右手三指握持笔杆轻搭在纸页边缘';
    }

    const appearanceDetails = isTactical
      ? '战术作训服领口紧束，面颊微有尘渍与细汗，装备背心扣件整肃清晰'
      : '衣装整洁挺括，衣料纤维光泽自然，发丝纹理细腻写实';

    return createCharacterVisualSlot({
      character_id: cid,
      name,
      depth_layer: depthLayer,
      screen_position: anchor,
      facing,
      spatial_anchor: anchor,
      head_pose: headPose,
      gaze,
      head_gaze: `${headPose}，${gaze}`,
      posture,
      hands,
      expression,
      prop_interaction: propInteraction,
      appearance_details: appearanceDetails,
    });
  });
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

/**
 * 尾帧槽位智能合成器：从首帧槽位、action 与 result 推演终态物理站位与身体收束姿态
 * @param {object} shot
 * @param {Array<object>} catalogCharacters
 * @param {Array<object>} [firstFrameSlots]
 * @returns {Array<object>} 尾帧的 last_frame_visuals
 */
function synthesizeLastFrameVisualSlots(shot, catalogCharacters = [], firstFrameSlots = []) {
  if (Array.isArray(shot.last_frame_visuals) && shot.last_frame_visuals.length > 0) {
    return shot.last_frame_visuals.map((v) => createCharacterVisualSlot(v));
  }

  const baseSlots = (Array.isArray(firstFrameSlots) && firstFrameSlots.length > 0)
    ? firstFrameSlots
    : synthesizeCharacterVisualSlots(shot, catalogCharacters);

  if (!baseSlots || baseSlots.length === 0) return [];

  const terminalText = [shot.result, shot.action].filter(Boolean).join('；');

  return baseSlots.map((base, idx) => {
    let anchor = base.spatial_anchor;
    let posture = base.posture;
    let hands = base.hands;
    let headPose = base.head_pose;
    let gaze = base.gaze;
    let facing = base.facing;

    // 针对当前角色提取动作与终态关键词（区分动作主体与被冲向/被救助的目标客体）
    const charName = base.name || '';
    const fullContext = [shot.action, terminalText].filter(Boolean).join(' ');
    const isTargetBeingApproached = charName
      ? new RegExp('(?:冲向|扑向|赶到|走向|跑向|接近)\\s*' + charName).test(fullContext)
      : false;
    const isSubjectOfApproach = !isTargetBeingApproached && (
      (charName && new RegExp(charName + '[^，。；]*(?:冲向|扑向|赶到|走到|来到|接近|伸手)').test(fullContext)) ||
      (/(?:冲向|扑向|赶到|走到|来到|接近)/i.test(terminalText) && idx === 0)
    );
    const isTargetOrFallen = isTargetBeingApproached || (
      /(?:倒卧|倒在|躺在|倒地|负伤|虚弱|被救)/i.test(fullContext) ||
      idx > 0
    );

    // 终态物理位置推演
    if (isSubjectOfApproach && /(?:半米处|身旁|面前|掩体)/i.test(terminalText)) {
      anchor = '画面右侧近景（目标身旁约半米处）';
      facing = '侧身朝向画面右下方';
    } else if (isTargetOrFallen && /(?:地面|掩体|碎石)/i.test(fullContext)) {
      anchor = '画面右侧地面掩体旁';
      facing = '侧身倒向掩体地面';
    } else if (/(?:冲到|扑到|到达).*(?:门前|窗前|大屏前|书桌前)/i.test(terminalText)) {
      const matchTarget = terminalText.match(/(?:门前|窗前|大屏前|书桌前)/);
      if (matchTarget) anchor = `画面中央${matchTarget[0]}`;
    }

    // 终态躯干姿势推演
    if (isSubjectOfApproach && /(?:扑向|飞扑|扑倒|伸手扑)/i.test(terminalText + ' ' + (shot.action || ''))) {
      posture = '身体大幅前倾凌空飞扑，重心降至极低几乎贴地';
    } else if (isTargetBeingApproached || (isTargetOrFallen && /(?:倒卧|倒在|倒地|虚弱|昏迷|起不来|躺在)/i.test(terminalText + ' ' + (shot.action || '')))) {
      posture = '侧身卧倒在碎石地面，身体虚弱无力微颤';
    } else if (/(?:站定|停步|稳住重心|直立)/i.test(terminalText)) {
      posture = '身体站定收步，双腿抓地重心稳固';
    } else if (/(?:单膝跪地|跪倒|屈膝)/i.test(terminalText)) {
      posture = '单膝跪地身体大幅前倾，单膝触地保持低位';
    } else if (/(?:靠在|倚在)/i.test(terminalText)) {
      posture = '背部倚靠在掩体断墙上，身体重心平稳';
    }

    // 终态手部推演
    if (isSubjectOfApproach && /(?:手停在|伸手|抓向|碰触|抓握)/i.test(terminalText + ' ' + (shot.action || ''))) {
      hands = '单臂竭力向前伸直，手指张开悬停在目标前方半米处定格';
    } else if (isTargetBeingApproached || (isTargetOrFallen && /(?:虚弱|护在|按在伤口|无力|倒卧|倒在)/i.test(terminalText + ' ' + (shot.action || '')))) {
      hands = '双手虚弱护在胸腹部，手指微颤无力垂落';
    } else if (/(?:攥拳|握紧拳头)/i.test(terminalText)) {
      hands = '双手在身侧紧紧握拳定格，指节发白';
    } else if (/(?:撑地|单手撑地)/i.test(terminalText)) {
      hands = '单手掌心牢牢撑在碎石地面上保持平衡';
    } else if (/(?:垂落|垂下)/i.test(terminalText)) {
      hands = '双手颓然垂直垂落在身体两侧';
    }

    // 终态神态与视线
    if (isSubjectOfApproach && /(?:焦灼|咬紧牙关|决绝)/i.test(terminalText + ' ' + (shot.action || ''))) {
      headPose = '咬紧牙关头部微仰';
      gaze = '目光焦灼决绝锁定前方目标';
    } else if (isTargetBeingApproached || (isTargetOrFallen && /(?:虚弱|紧闭双唇|隐忍|倒卧|昏迷)/i.test(terminalText + ' ' + (shot.action || '')))) {
      headPose = '头部侧偏贴近地面';
      gaze = '双目微阖神色虚弱隐忍，双唇紧闭';
    }

    return createCharacterVisualSlot({
      character_id: base.character_id,
      name: base.name,
      facing,
      spatial_anchor: anchor,
      head_pose: headPose,
      gaze,
      head_gaze: `${headPose}，${gaze}`,
      posture,
      hands,
    });
  });
}

module.exports = {
  SCREEN_POSITION_REGEX,
  FACING_REGEX,
  HEAD_POSE_REGEX,
  GAZE_REGEX,
  POSTURE_REGEX,
  HANDS_REGEX,
  CLONE_TRIGGER_REGEX,
  DYNAMIC_REGEX,
  createCharacterVisualSlot,
  validateCharacterVisualSlots,
  synthesizeLightingChiaroscuro,
  compileImagePromptFromSlots,
  compileLastFramePromptFromSlots,
  synthesizeCharacterVisualSlots,
  synthesizeLastFrameVisualSlots,
};
