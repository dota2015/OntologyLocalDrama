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

const SCREEN_POSITION_REGEX = /(?:画面左侧|画面右侧|画面中央|画面正中|画面左前|画面右前|画面前景|画面中景|画面后景|左下角|右下角|左上方|右上方|左侧三分线|右侧三分线|居中|偏左|偏右|screen_left|screen_right|screen_center|foreground|midground|background)/i;
const FACING_REGEX = /(?:正面|正对|背对|背面|背向|朝左|朝右|侧身|侧向|三刻|四分之三|转朝|面对|斜向|前左|前右|后左|后右|左侧|右侧|剪影|front|back|left|right|facing|three_quarter|profile)/i;
const HEAD_POSE_REGEX = /(?:头|仰|低头|偏头|转头|正对|回望|俯视|仰视|侧头|head|tilt|turn)/i;
const GAZE_REGEX = /(?:目光|视线|看|眼|注视|盯|凝视|锁定|瞄准|gaze|look|eye|watch)/i;
const POSTURE_REGEX = /(?:站|蹲|坐|卧|趴|扑|俯|仰|倾|跪|靠|crouch|stand|kneel|lean|prone|sit|lie|stride|奔|跑|跃|步|斜躺|低姿|姿态|姿势|姿|立|挺)/i;
const HANDS_REGEX = /(?:手|臂|指|握|按|托|撑|抱|搭|提|拿|拉|伸|扣|掌|持|抓|悬|hand|arm|finger|hold|grip|press)/i;

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
    const m = spatialAnchor.match(/^(画面(?:左侧|右侧|中央|正中|前景|中景|后景|左前|右前)[^，,\s]*)/);
    if (m) {
      finalScreenPos = m[1];
      finalEnvAnchor = spatialAnchor.slice(m[1].length).replace(/^[，,\s]+/, '');
    } else {
      finalScreenPos = spatialAnchor;
    }
  }

  // 智能推断或规整 Z 轴纵深层级 (foreground 前景 / midground 中景 / background 后景)
  let depthLayer = String(data.depth_layer || '').trim().toLowerCase();
  if (!depthLayer) {
    const combined = `${finalScreenPos} ${spatialAnchor}`;
    if (/(?:前景|近景|近处|左前|右前|过肩|foreground)/i.test(combined)) depthLayer = 'foreground';
    else if (/(?:后景|远处|深处|远景|后方|背景|background)/i.test(combined)) depthLayer = 'background';
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
function validateCharacterVisualSlots(shot, slots = []) {
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
        message: `分镜 ${shotNum} 角色「${cName}」缺少画面构图位置槽位 (screen_position)，必须明确人物在画面中的具体构图位置（如：画面左侧前景、画面正中央、画面右侧中景等），防止生图模型默认正中呆立或双人重叠穿模！`,
      });
    }

    // 2. 朝向槽位必须明确（防止参考图正面呆立）
    if (!slot.facing || !FACING_REGEX.test(slot.facing)) {
      violations.push({
        rule: 'INVARIANT_SLOT_MISSING_FACING',
        shot_number: shotNum,
        severity: 'error',
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
        message: `分镜 ${shotNum} 角色「${cName}」缺少视线注视槽位 (gaze)，必须指明目光落点（如：双眼紧盯前方冷光屏幕、目光警惕锁定高窗火力点等）。`,
      });
    }

    // 4. 躯干体态与重心必须具体，不能是无姿态
    if (!slot.posture || !POSTURE_REGEX.test(slot.posture) || slot.posture.length < 3) {
      violations.push({
        rule: 'INVARIANT_SLOT_MISSING_POSTURE',
        shot_number: shotNum,
        severity: 'error',
        message: `分镜 ${shotNum} 角色「${cName}」缺少具体的躯干体态与重心槽位 (posture)，严禁只写名字或身体，必须具体（如：半蹲低伏、单膝跪姿、身体前倾30度坐姿等）。`,
      });
    }

    // 5. 四肢与手部动作
    if (!slot.hands || !HANDS_REGEX.test(slot.hands)) {
      violations.push({
        rule: 'INVARIANT_SLOT_MISSING_HANDS',
        shot_number: shotNum,
        severity: 'error',
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
    const hasForeground = slots.some((s) => s.depth_layer === 'foreground' || /(?:前景|近处|近景|前侧|左前|右前|过肩)/i.test(`${s.screen_position} ${s.spatial_anchor}`));
    const hasBackOrMid = slots.some((s) => s.depth_layer === 'background' || /(?:后景|远处|深处|后方|背景)/i.test(`${s.screen_position} ${s.spatial_anchor}`));

    // 如果所有角色只有横向左右（如全是“画面左侧”、“画面右侧”），没有任何前后远近纵深词
    const allFlat = !hasForeground && !hasBackOrMid && !slots.some((s) => /(?:前景|近景|近处|后景|深处|远处|过肩)/i.test(`${s.screen_position} ${s.spatial_anchor}`));
    if (allFlat) {
      violations.push({
        rule: 'INVARIANT_SLOT_MISSING_DEPTH_STAGING',
        shot_number: shotNum,
        severity: 'warning',
        message: `分镜 ${shotNum} 多人同框仅有左右横向站位，缺少前后远近纵深关系（Z轴前后层次），容易导致画面呈扁平纸片人贴立。建议构图引入一前一后（如：前景过肩/近身背影 vs 中景正面焦点，或中景主体 vs 后景纵深掩护）。`,
      });
    }
  }

  return violations;
}

/**
 * 确定性编译器：将槽位编译为纯静态摄影抓拍级的 image_prompt
 * @param {object} shot
 * @param {Array<object>} slots
 * @param {object} options
 * @returns {string} 编译后的 image_prompt
 */
function compileImagePromptFromSlots(shot, slots = [], options = {}) {
  const parts = [];

  // 1. 场景地点与空间三层纵深
  const loc = shot.location ? shot.location : '';
  const time = shot.time ? shot.time : '';
  const envDepth = shot.environment_depth || shot.decisive_moment_detail || '';
  if (loc && time) {
    parts.push(`${loc}（${time}）`);
  } else if (loc) {
    parts.push(loc);
  } else if (time) {
    parts.push(time);
  }
  if (envDepth) parts.push(envDepth);

  // 2. 景别机位与电影镜头参数
  const angleParts = [];
  if (shot.shot_type) angleParts.push(shot.shot_type);
  const vMap = { low: '仰拍', high: '俯拍', eye_level: '平视', worm: '极低仰拍', top_down: '顶拍' };
  const hMap = {
    front: '正面', front_left: '前左', front_right: '前右',
    left: '左侧', right: '右侧', back: '背面',
    back_left: '后左', back_right: '后右',
  };
  const v = vMap[shot.angle_v] || (shot.angle_v === 'low' ? '仰拍' : shot.angle_v === 'high' ? '俯拍' : '平视');
  const h = hMap[shot.angle_h] || (shot.angle_h === 'front_left' ? '前左' : shot.angle_h === 'front_right' ? '前右' : '正面');
  angleParts.push(v);
  angleParts.push(h);
  if (shot.cinematic_lens) angleParts.push(shot.cinematic_lens);
  parts.push(angleParts.join('·'));

  // 3. 角色视觉槽位（空间站位 + 朝向 + 微表情 + 身体重心 + 手部/接触态 + 服饰微状态）
  if (Array.isArray(slots) && slots.length > 0) {
    const charPhrases = slots.map((s) => {
      const charName = s.name || '人物';
      const items = [];
      if (s.facing) items.push(s.facing);
      if (s.expression) items.push(s.expression);
      if (s.posture) items.push(s.posture);
      if (s.hands) items.push(s.hands);
      if (s.prop_interaction) items.push(s.prop_interaction);
      if (s.head_pose) items.push(s.head_pose);
      if (s.gaze && s.gaze !== s.head_pose) items.push(s.gaze);
      else if (s.head_gaze && !s.head_pose) items.push(s.head_gaze);
      if (s.appearance_details) items.push(s.appearance_details);

      let anchor = s.spatial_anchor ? (s.spatial_anchor.startsWith('位于') ? s.spatial_anchor : `位于${s.spatial_anchor}`) : '';
      if (slots.length >= 2) {
        if ((s.depth_layer === 'foreground' || /(?:前景|近处|近景|左前|右前|过肩)/i.test(anchor)) && !anchor.includes('前景近处') && !anchor.includes('前景') && !anchor.includes('近处')) {
          anchor = `${anchor}（处于画面前景近处）`;
        } else if ((s.depth_layer === 'background' || /(?:后景|远处|深处)/i.test(anchor)) && !anchor.includes('后景纵深') && !anchor.includes('后景') && !anchor.includes('深处')) {
          anchor = `${anchor}（处于画面后景纵深处）`;
        }
      }
      const prefix = anchor ? `${charName}${anchor}` : charName;
      return `${prefix}${items.length > 0 ? '，' + items.join('，') : ''}`;
    });
    parts.push(charPhrases.join('；'));
  } else if (shot.action) {
    const { extractStaticFreezeFramePose } = require('../services/episodeStoryboardService');
    parts.push(extractStaticFreezeFramePose(shot.action, shot));
  }

  // 4. 影视级打光与影调氛围 (Lighting & Chiaroscuro)
  if (shot.lighting_chiaroscuro) {
    parts.push(shot.lighting_chiaroscuro);
  } else if (shot.lighting_style) {
    const lightMap = {
      natural: '自然真实采光',
      side: '高反差侧光照明与立体明暗交界',
      backlit: '电影级强逆光与金色轮廓光',
      dramatic: '戏剧性强对比伦勃朗光',
      soft: '柔和漫反射环境光',
      golden_hour: '暖金色夕阳光切光',
      blue_hour: '冷色调暮光幽蓝氛围',
      night: '暗夜微光照明伴随深重阴影',
      neon: '赛博朋克霓虹冷暖对比光',
    };
    parts.push(lightMap[shot.lighting_style] || shot.lighting_style);
  }

  // 5. 电影风格与胶片摄影质感
  const style = options.style || 'photorealistic, ultra-detailed, 8k uhd, sharp focus, natural lighting, real skin texture, hyperrealism, professional photography, RAW photo';
  parts.push(style);
  parts.push('首帧静止画面');

  return parts.filter(Boolean).join('，');
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

  // 对每个出场角色构造结构化槽位
  return charIds.map((cid, idx) => {
    const charObj = charMap.get(cid) || {};
    const name = charObj.name || (charIds.length === 1 ? '主角' : `人物${idx + 1}`);

    let facing = defaultFacing;
    if (/(?:背对|背面|背向)/i.test(prompt)) facing = '背向镜头';
    else if (/(?:侧身|侧向|朝向|偏向).*(?:左)/i.test(prompt) || shot.angle_h === 'front_left' || shot.angle_h === 'left') facing = '侧身朝向画面左侧';
    else if (/(?:侧身|侧向|朝向|偏向).*(?:右)/i.test(prompt) || shot.angle_h === 'front_right' || shot.angle_h === 'right') facing = '侧身朝向画面右侧';
    else if (/(?:正面|正对)/i.test(prompt)) facing = '正面面对镜头';

    const isTactical = /(?:断墙|战术装备|战术武器|战术耳机|掩体|火力|持枪|射击|拔枪|冲锋枪|突击步枪|手枪|子弹|废弃工厂|潜行|撤离|废墟|蜂医|红狼|露娜)/i.test(prompt) || /(?:断墙|掩体|废弃工厂|废墟)/i.test(shot.location || '');

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

    let posture = isTactical ? '身体保持戒备低姿，重心稳固隐蔽' : '身体保持端正姿态，重心平稳';
    if (/(?:半蹲|俯伏|深蹲|蹲伏)/i.test(prompt)) posture = '半蹲低伏紧贴掩体，重心压低';
    else if (/(?:拍桌|拍案|拍在.+?桌|拍向.+?桌|拍桌面|猛拍桌面|掌心.+?拍|拍.+?桌面)/i.test(prompt)) posture = '身体前倾定格，上身偏向会议桌面';
    else if (/(?:前倾|坐姿|坐在书桌前|坐在会议桌)/i.test(prompt)) posture = '身体前倾坐姿，上身紧贴桌台边缘';
    else if (/(?:单膝跪地|屈膝|跪姿)/i.test(prompt)) posture = '单膝跪地身体微侧，保持低位隐蔽';
    else if (/(?:侧卧|趴在|跌倒|失去平衡|失衡|向前扑倒|扑向)/i.test(prompt)) posture = '侧身撑地身体大幅倾斜失衡，单手撑地';
    else if (/(?:飞扑|跃出|凌空)/i.test(prompt)) posture = '身体凌空大幅前跃扑出，重心前倾';
    else if (/(?:大步奔|奔跑|疾冲|冲刺)/i.test(prompt)) posture = '大步屈膝奔冲，动作迅猛重心前移';
    else if (/(?:站立|站直|起身|直起|直身)/i.test(prompt)) posture = '挺拔端正站立，身体重心平稳';
    else if (/(?:侧身靠墙|背靠)/i.test(prompt)) posture = '侧身背靠墙壁，身体重心稳固';

    let hands = isTactical ? '双手紧握装备保持待发状态' : '双手自然垂放于身侧';
    if (/(?:拍桌|拍案|拍在.+?桌|拍向.+?桌|拍桌面|猛拍桌面|掌心.+?拍|拍.+?桌面)/i.test(prompt)) hands = '单手掌心按在桌面边缘定格，另一手收在身侧';
    else if (/(?:攥拳|握拳|指节)/i.test(prompt)) hands = '单手在身侧紧紧攥拳，指节发白定格';
    else if (/(?:收回胸前|掌心下压|压住动作)/i.test(prompt)) hands = '双手收于胸前，掌心微下压定格';
    else if (/(?:键盘|按键|鼠标)/i.test(prompt)) hands = '双手手指搭在键盘按键上方僵持停滞';
    else if (/(?:通讯|耳机)/i.test(prompt)) hands = '单手手指紧按在战术通讯耳机上，另一手护在身前';
    else if (/(?:枪|武器|持枪)/i.test(prompt)) hands = '双手紧握战术武器呈戒备瞄准姿态';
    else if (/(?:抬手指向|手指指向|单手指|抬手指|手势指向|单臂平举|指向大屏|指向屏幕)/i.test(prompt)) hands = '单臂平举直指前方大屏展示方向';
    else if (/(?:按在.+肩|按住.+肩)/i.test(prompt)) hands = '单手按在对方肩膀上，另一手撑在掩体边缘';
    else if (/(?:撑住地面|撑地)/i.test(prompt)) hands = '单手手掌牢牢撑向地面保持平衡';
    else if (/(?:伸展手指|伸手扑向)/i.test(prompt)) hands = '单臂竭力向前伸展手指抓向目标';

    let headPose = '头部正对前方';
    let gaze = '目光专注注视正前方';
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
    } else if (/(?:赵总|小林|老张|哥哥|妹妹|对方|众人)/i.test(prompt)) {
      headPose = '侧头转向对方';
      gaze = '目光严肃直视对方方向';
    } else if (/(?:蜂医|救援)/i.test(prompt)) {
      headPose = '头部扬起';
      gaze = '目光焦急决绝注视着前方倒地的战友';
    } else if (/(?:作业本)/i.test(prompt)) {
      headPose = '低头俯视';
      gaze = '双眼凝视桌面上未动过的作业本';
    } else if (/(?:桌面|资料|文件)/i.test(prompt)) {
      headPose = '低头俯视';
      gaze = '双眼凝视桌面上铺开的资料文件';
    }

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
  const parts = [];

  // 1. 场景地点与时间光影
  if (shot.location) parts.push(shot.location);
  if (shot.time) parts.push(shot.time);

  // 2. 景别机位
  const angleParts = [];
  if (shot.shot_type) angleParts.push(shot.shot_type);
  const vMap = { low: '仰拍', high: '俯拍', eye_level: '平视', worm: '极低仰拍', top_down: '顶拍' };
  const hMap = {
    front: '正面', front_left: '前左', front_right: '前右',
    left: '左侧', right: '右侧', back: '背面',
    back_left: '后左', back_right: '后右',
  };
  const v = vMap[shot.angle_v] || (shot.angle_v === 'low' ? '仰拍' : shot.angle_v === 'high' ? '俯拍' : '平视');
  const h = hMap[shot.angle_h] || (shot.angle_h === 'front_left' ? '前左' : shot.angle_h === 'front_right' ? '前右' : '正面');
  angleParts.push(v);
  angleParts.push(h);
  parts.push(angleParts.join('·'));

  // 3. 尾帧角色视觉槽位
  if (Array.isArray(slots) && slots.length > 0) {
    const charPhrases = slots.map((s) => {
      const charName = s.name || '人物';
      const items = [];
      if (s.facing) items.push(s.facing);
      if (s.posture) items.push(s.posture);
      if (s.hands) items.push(s.hands);
      if (s.head_pose) items.push(s.head_pose);
      if (s.gaze && s.gaze !== s.head_pose) items.push(s.gaze);
      else if (s.head_gaze && !s.head_pose) items.push(s.head_gaze);

      let anchor = s.spatial_anchor ? (s.spatial_anchor.startsWith('位于') ? s.spatial_anchor : `位于${s.spatial_anchor}`) : '';
      if (slots.length >= 2) {
        if ((s.depth_layer === 'foreground' || /(?:前景|近处|近景|左前|右前|过肩)/i.test(anchor)) && !anchor.includes('前景近处') && !anchor.includes('前景') && !anchor.includes('近处')) {
          anchor = `${anchor}（处于画面前景近处）`;
        } else if ((s.depth_layer === 'background' || /(?:后景|远处|深处)/i.test(anchor)) && !anchor.includes('后景纵深') && !anchor.includes('后景') && !anchor.includes('深处')) {
          anchor = `${anchor}（处于画面后景纵深处）`;
        }
      }
      const prefix = anchor ? `${charName}${anchor}` : charName;
      return `${prefix}${items.length > 0 ? '，' + items.join('，') : ''}`;
    });
    parts.push(charPhrases.join('；'));
  } else if (shot.result) {
    const { extractStaticFreezeFramePose } = require('../services/episodeStoryboardService');
    parts.push(extractStaticFreezeFramePose(shot.result, shot));
  }

  // 4. 动作收束瞬间的环境物理细节
  if (shot.result) {
    const { stripChineseExclusions } = require('../utils/framePromptSanitize');
    let resClean = stripChineseExclusions(shot.result)
      .replace(/连续弹着点/g, '密集子弹击地激起的飞溅碎石与火花')
      .replace(/弹着点/g, '子弹击地激起的飞溅碎石')
      .replace(/弹着火星/g, '子弹击地迸发的飞溅火花与烟尘');
    parts.push(`动作收束瞬间细节：${resClean}`);
  }

  // 5. 画风与尾帧静止标签
  const style = options.style || 'photorealistic, ultra-detailed, 8k uhd, sharp focus, natural lighting, real skin texture, hyperrealism, professional photography, RAW photo';
  parts.push(style);
  parts.push('尾帧静止画面，动作收束定格');

  return parts.filter(Boolean).join('，');
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

    // 终态物理位置推演
    if (/(?:冲向|扑向|赶到|走到|来到|接近).*(?:蜂医|战友|掩体|对方)/i.test(terminalText) && idx === 0) {
      anchor = '画面右侧近景（目标身旁约半米处）';
      facing = '侧身朝向画面右下方';
    } else if (base.name.includes('蜂医') || idx > 0 || /(?:倒卧|倒在|躺在|倒地)/i.test(terminalText)) {
      anchor = '画面右侧地面掩体旁';
      facing = '侧身倒向掩体地面';
    } else if (/(?:冲到|扑到|到达).*(?:门前|窗前|大屏前|书桌前)/i.test(terminalText)) {
      const matchTarget = terminalText.match(/(?:门前|窗前|大屏前|书桌前)/);
      if (matchTarget) anchor = `画面中央${matchTarget[0]}`;
    }

    // 终态躯干姿势推演
    if (/(?:扑向|飞扑|扑倒|伸手扑)/i.test(terminalText) && (idx === 0 || !base.name.includes('蜂医'))) {
      posture = '身体大幅前倾凌空飞扑，重心降至极低几乎贴地';
    } else if (base.name.includes('蜂医') || idx > 0 || /(?:倒卧|倒在|倒地|虚弱|昏迷|起不来)/i.test(terminalText)) {
      posture = '侧身卧倒在碎石地面，身体虚弱无力微颤';
    } else if (/(?:站定|停步|稳住重心|直立)/i.test(terminalText)) {
      posture = '身体站定收步，双腿抓地重心稳固';
    } else if (/(?:单膝跪地|跪倒|屈膝)/i.test(terminalText)) {
      posture = '单膝跪地身体大幅前倾，单膝触地保持低位';
    } else if (/(?:靠在|倚在)/i.test(terminalText)) {
      posture = '背部倚靠在掩体断墙上，身体重心平稳';
    }

    // 终态手部推演
    if (/(?:手停在|伸手|抓向|碰触|抓握)/i.test(terminalText) && (idx === 0 || !base.name.includes('蜂医'))) {
      hands = '单臂竭力向前伸直，手指张开悬停在目标前方半米处定格';
    } else if (/(?:虚弱|护在|按在伤口|无力)/i.test(terminalText) && (idx > 0 || base.name.includes('蜂医'))) {
      hands = '双手虚弱护在胸腹部，手指微颤无力垂落';
    } else if (/(?:攥拳|握紧拳头)/i.test(terminalText)) {
      hands = '双手在身侧紧紧握拳定格，指节发白';
    } else if (/(?:撑地|单手撑地)/i.test(terminalText)) {
      hands = '单手掌心牢牢撑在碎石地面上保持平衡';
    } else if (/(?:垂落|垂下)/i.test(terminalText)) {
      hands = '双手颓然垂直垂落在身体两侧';
    }

    // 终态神态与视线
    if (/(?:焦灼|咬紧牙关|决绝)/i.test(terminalText) && (idx === 0 || !base.name.includes('蜂医'))) {
      headPose = '咬紧牙关头部微仰';
      gaze = '目光焦灼决绝锁定前方目标';
    } else if (/(?:虚弱|紧闭双唇|隐忍)/i.test(terminalText) && (idx > 0 || base.name.includes('蜂医'))) {
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
  FACING_REGEX,
  HEAD_POSE_REGEX,
  GAZE_REGEX,
  POSTURE_REGEX,
  HANDS_REGEX,
  CLONE_TRIGGER_REGEX,
  DYNAMIC_REGEX,
  createCharacterVisualSlot,
  validateCharacterVisualSlots,
  compileImagePromptFromSlots,
  compileLastFramePromptFromSlots,
  synthesizeCharacterVisualSlots,
  synthesizeLastFrameVisualSlots,
};
