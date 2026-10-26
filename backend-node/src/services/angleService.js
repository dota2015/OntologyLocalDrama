/**
 * angleService.js
 * 结构化视角服务：8方向 × 4俯仰 × 3景别 = 96种视角组合
 * 每种组合生成精确的英文镜头描述片段，供图片生成 prompt 使用。
 *
 * 字段说明（storyboards 表扩展字段）：
 *   angle_h  TEXT  水平方向（front/front_left/left/back_left/back/back_right/right/front_right）
 *   angle_v  TEXT  俯仰角度（worm/low/eye_level/high）
 *   angle_s  TEXT  景别（close_up/medium/wide）
 */

// ─── 枚举定义 ────────────────────────────────────────────────────────────────

/** 水平方向：8方向 */
const HORIZONTAL = {
  front:       'front',        // 正面
  front_left:  'front_left',   // 前左斜（45°）
  left:        'left',         // 正侧面
  back_left:   'back_left',    // 后左斜（135°）
  back:        'back',         // 正背面
  back_right:  'back_right',   // 后右斜
  right:       'right',        // 正右侧
  front_right: 'front_right',  // 前右斜
};

/** 俯仰角度：4等级 */
const ELEVATION = {
  worm:      'worm',      // 极低角度仰拍（虫眼视角）
  low:       'low',       // 低角度仰拍
  eye_level: 'eye_level', // 平视
  high:      'high',      // 高角度俯拍（鸟瞰）
};

/** 景别：3等级 */
const SHOT_SIZE = {
  close_up: 'close_up', // 近景/特写
  medium:   'medium',   // 中景
  wide:     'wide',     // 远景/全景
};

// ─── 英文 prompt 片段生成 ─────────────────────────────────────────────────────

/**
 * 水平方向描述
 */
const HORIZONTAL_DESC = {
  front:       'shooting from the front',
  front_left:  'shooting from front-left at 45-degree angle',
  left:        'shooting from the left side, profile view',
  back_left:   'shooting from back-left at 135-degree angle',
  back:        'shooting from behind, character\'s back to camera',
  back_right:  'shooting from back-right at 135-degree angle',
  right:       'shooting from the right side, profile view',
  front_right: 'shooting from front-right at 45-degree angle',
};

/**
 * 俯仰角度描述
 */
const ELEVATION_DESC = {
  worm:      'extreme low-angle worm\'s eye view, camera near ground pointing sharply upward, strong upward perspective distortion, background shows sky/ceiling',
  low:       'low-angle upward shot, camera below eye-line, slight upward tilt, empowering perspective',
  eye_level: 'eye-level shot, neutral perspective, natural horizontal framing',
  high:      'high-angle bird\'s eye view, camera above looking down, background shows floor/ground with downward perspective distortion',
};

/**
 * 景别描述（含构图建议）
 */
const SHOT_SIZE_DESC = {
  close_up: 'close-up shot (face/bust framing), subject fills most of frame, shallow depth of field, background softly blurred',
  medium:   'medium shot (waist-up to full body), character and immediate surroundings visible, moderate depth of field',
  wide:     'wide shot (full body with environment), subject small relative to scene, deep depth of field, environment context prominent',
};

/**
 * 生成完整的镜头描述英文片段
 * @param {string} h - 水平方向（HORIZONTAL 枚举值）
 * @param {string} v - 俯仰角度（ELEVATION 枚举值）
 * @param {string} s - 景别（SHOT_SIZE 枚举值）
 * @returns {string} 英文 prompt 片段
 */
function toPromptFragment(h, v, s) {
  const hDesc = HORIZONTAL_DESC[h] || HORIZONTAL_DESC.front;
  const vDesc = ELEVATION_DESC[v] || ELEVATION_DESC.eye_level;
  const sDesc = SHOT_SIZE_DESC[s] || SHOT_SIZE_DESC.medium;
  return `${sDesc}, ${vDesc}, ${hDesc}`;
}

// ─── 旧文本解析（向后兼容） ────────────────────────────────────────────────────

/**
 * 中文关键字 → 枚举值映射（宽松匹配）
 */
const ZH_H_MAP = [
  { keys: ['背后', '背面', '从背', 'back'],                          val: 'back' },
  { keys: ['前左', '左前', 'front-left', 'front_left'],              val: 'front_left' },
  { keys: ['前右', '右前', 'front-right', 'front_right'],            val: 'front_right' },
  { keys: ['左侧', '正侧', '侧面', 'side', 'left'],                  val: 'left' },
  { keys: ['右侧', 'right'],                                          val: 'right' },
  { keys: ['后左', '左后', 'back-left', 'back_left'],                val: 'back_left' },
  { keys: ['后右', '右后', 'back-right', 'back_right'],              val: 'back_right' },
  { keys: ['正面', '前方', '面向', 'front'],                         val: 'front' },
];

const ZH_V_MAP = [
  { keys: ['虫眼', '极低', 'worm'],               val: 'worm' },
  { keys: ['仰', 'low angle', 'low-angle'],       val: 'low' },
  { keys: ['俯', 'high angle', 'bird'],            val: 'high' },
  { keys: ['平视', 'eye-level', 'eye level'],     val: 'eye_level' },
];

const ZH_S_MAP = [
  { keys: ['特写', '近景', 'close'],              val: 'close_up' },
  { keys: ['全景', '远景', '大全', 'wide', 'long shot', 'establishing'], val: 'wide' },
  { keys: ['中景', '半身', 'medium'],             val: 'medium' },
];

function matchMap(text, map) {
  const t = text.toLowerCase();
  for (const entry of map) {
    if (entry.keys.some(k => t.includes(k.toLowerCase()))) {
      return entry.val;
    }
  }
  return null;
}

/**
 * 从旧版自由文本的 angle 字段解析出结构化三元组
 * @param {string} angleText - 旧 angle 字段值（如 "俯拍中景"、"side low"）
 * @param {string} shotType  - 旧 shot_type 字段值（可辅助景别判断）
 * @returns {{ h: string, v: string, s: string }}
 */
function parseFromLegacyText(angleText, shotType = '') {
  const combined = `${angleText || ''} ${shotType || ''}`;

  const h = matchMap(combined, ZH_H_MAP) || 'front';
  const v = matchMap(combined, ZH_V_MAP) || 'eye_level';
  const s = matchMap(combined, ZH_S_MAP) || 'medium';

  return { h, v, s };
}

/**
 * 从旧版 angle 文本直接生成完整英文 prompt 片段（快捷方法）
 * @param {string} angleText
 * @param {string} shotType
 * @returns {string}
 */
function fromLegacyText(angleText, shotType = '') {
  const { h, v, s } = parseFromLegacyText(angleText, shotType);
  return toPromptFragment(h, v, s);
}

/**
 * 将结构化 angle 三元组转换为简短中文标签（用于前端展示）
 * @param {string} h
 * @param {string} v
 * @param {string} s
 * @returns {string}
 */
function toChineseLabel(h, v, s) {
  const hLabel = { front:'正面', front_left:'前左', left:'左侧', back_left:'后左', back:'背面', back_right:'后右', right:'右侧', front_right:'前右' }[h] || '正面';
  const vLabel = { worm:'虫眼仰', low:'仰拍', eye_level:'平视', high:'俯拍' }[v] || '平视';
  const sLabel = { close_up:'特写', medium:'中景', wide:'远景' }[s] || '中景';
  return `${sLabel}·${vLabel}·${hLabel}`;
}

/**
 * 列出所有 96 种视角组合（用于管理后台展示）
 * @returns {Array<{ h, v, s, label, prompt_fragment }>}
 */
function listAllAngles() {
  const result = [];
  for (const h of Object.values(HORIZONTAL)) {
    for (const v of Object.values(ELEVATION)) {
      for (const s of Object.values(SHOT_SIZE)) {
        result.push({
          h, v, s,
          label: toChineseLabel(h, v, s),
          prompt_fragment: toPromptFragment(h, v, s),
        });
      }
    }
  }
  return result;
}

// ─── 镜头运动 ────────────────────────────────────────────────────────────────

/** 镜头运动枚举值 */
const MOVEMENT = {
  static:    'static',    // 固定
  push:      'push',      // 推镜
  pull:      'pull',      // 拉镜
  pan:       'pan',       // 横摇
  tilt:      'tilt',      // 纵摇（上下摇）
  tracking:  'tracking',  // 跟镜
  crane_up:  'crane_up',  // 升镜
  crane_dn:  'crane_dn',  // 降镜
  orbit:     'orbit',     // 环绕
  handheld:  'handheld',  // 手持
};

/** 镜头运动 → 英文 prompt */
const MOVEMENT_DESC = {
  static:   'static locked shot, no camera movement, tripod-mounted',
  push:     'slow push-in dolly shot, camera gradually moves closer to subject',
  pull:     'pull-back dolly shot, camera gradually moves away from subject',
  pan:      'horizontal pan shot, camera sweeps laterally from side to side',
  tilt:     'vertical tilt shot, camera pivots up or down',
  tracking: 'tracking shot, camera follows subject movement, smooth motion',
  crane_up: 'crane up shot, camera rises vertically, revealing wider scene',
  crane_dn: 'crane down shot, camera descends vertically',
  orbit:    'orbiting arc shot, camera circles around subject',
  handheld: 'handheld shot, subtle natural camera shake, documentary feel',
};

/** 中文关键字 → movement 枚举 */
const ZH_MOVEMENT_MAP = [
  { keys: ['固定', '不动', '静止', 'static', 'locked'],               val: 'static'   },
  { keys: ['推镜', '推进', '推', 'push in', 'dolly in', 'push'],    val: 'push'     },
  { keys: ['拉镜', '拉出', '拉', 'pull back', 'dolly out', 'pull'], val: 'pull'     },
  { keys: ['横移', '横摇', '摇镜', '摇', 'pan'],                    val: 'pan'      },
  { keys: ['纵摇', '上摇', '下摇', 'tilt'],                         val: 'tilt'     },
  { keys: ['跟镜', '跟拍', '跟随', '追踪', 'track', 'tracking'],     val: 'tracking' },
  { keys: ['升镜', '向上', '升起', 'crane up', 'crane_up'],         val: 'crane_up' },
  { keys: ['降镜', '向下', '降落', 'crane down', 'crane_dn'],       val: 'crane_dn' },
  { keys: ['环绕', '绕', 'orbit', 'arc'],                           val: 'orbit'    },
  { keys: ['手持', '晃动', 'handheld', 'shaky'],                    val: 'handheld' },
  { keys: ['变焦', '变倍', 'zoom'],                                  val: 'zoom'     },
  { keys: ['旋转', '滚镜', 'roll'],                                  val: 'roll'     },
  { keys: ['甩镜', '急摇', 'whip pan', 'whip_pan'],                 val: 'whip_pan' },
  { keys: ['螺旋', 'spiral'],                                       val: 'spiral'   },
  { keys: ['希区柯克', '眩晕', 'hitchcock_zoom', 'hitchcock'],      val: 'hitchcock_zoom' },
  { keys: ['子弹时间', 'bullet_time', 'bullet time'],               val: 'bullet_time' },
  { keys: ['荷兰角', 'dutch_angle_move', 'dutch'],                  val: 'dutch_angle_move' },
  { keys: ['推轨', '复合', 'dolly_track', 'dolly track'],            val: 'dolly_track' },
  { keys: ['升格环绕', '慢动作环绕', 'slowmo_orbit'],                 val: 'slowmo_orbit' },
];

/** 归一化运镜值为合法枚举（支持中英文） */
function normalizeMovement(raw) {
  if (!raw) return null;
  const m = String(raw).trim();
  if (MOVEMENT[m] || MOVEMENT_DESC[m]) return m;
  const lower = m.toLowerCase();
  for (const entry of ZH_MOVEMENT_MAP) {
    if (entry.keys.some(k => lower.includes(k.toLowerCase()))) {
      return entry.val;
    }
  }
  return null;
}

/**
 * 将中文运动描述或枚举值转换为英文 prompt 片段
 * @param {string} movement - 中文或枚举值
 * @returns {string|null}
 */
function movementToPrompt(movement) {
  if (!movement) return null;
  const m = String(movement).trim();
  // 先尝试直接枚举匹配
  if (MOVEMENT_DESC[m]) return MOVEMENT_DESC[m];
  // 再尝试中文关键字匹配
  const lower = m.toLowerCase();
  for (const entry of ZH_MOVEMENT_MAP) {
    if (entry.keys.some(k => lower.includes(k.toLowerCase()))) {
      return MOVEMENT_DESC[entry.val] || null;
    }
  }
  return null;
}

// ─── 灯光风格 ────────────────────────────────────────────────────────────────

/** 灯光风格枚举值 */
const LIGHTING = {
  natural:      'natural',       // 自然光
  front:        'front',         // 顺光
  side:         'side',          // 侧光
  backlit:      'backlit',       // 逆光
  top:          'top',           // 顶光
  under:        'under',         // 底光
  soft:         'soft',          // 柔光
  dramatic:     'dramatic',      // 戏剧光（明暗对比）
  golden_hour:  'golden_hour',   // 黄金时段
  blue_hour:    'blue_hour',     // 蓝调时刻
  night:        'night',         // 夜景/低调光
  neon:         'neon',          // 霓虹/赛博朋克
};

/** 灯光风格 → 英文 prompt */
const LIGHTING_DESC = {
  natural:     'natural ambient lighting, soft and even illumination',
  front:       'flat front lighting, even illumination, minimal shadows',
  side:        'dramatic side lighting, strong contrast between light and shadow',
  backlit:     'backlit, rim lighting, subject silhouetted with halo edge light',
  top:         'harsh overhead top lighting, strong downward shadows',
  under:       'unsettling underlighting, upward low-key light source',
  soft:        'soft diffused lighting, gentle shadows, flattering luminosity',
  dramatic:    'high contrast chiaroscuro lighting, deep shadows, cinematic noir',
  golden_hour: 'warm golden hour sunlight, long low shadows, amber glow',
  blue_hour:   'cool blue hour twilight, moody atmospheric dusk light',
  night:       'low key night lighting, isolated artificial light sources, deep shadows',
  neon:        'vivid neon lighting, colored artificial lights, cyberpunk atmosphere',
};

/** 灯光中文 → 枚举 */
const ZH_LIGHTING_MAP = [
  { keys: ['自然光', '日光', '阳光', '晴天', '白天', 'natural'],          val: 'natural'     },
  { keys: ['顺光', '正面光', 'front light'],                              val: 'front'       },
  { keys: ['侧光', '侧面光', 'side light'],                               val: 'side'        },
  { keys: ['逆光', '背光', 'backlit', 'back light', '轮廓光'],            val: 'backlit'     },
  { keys: ['顶光', '头顶光', 'top light', '吊灯', '射灯'],                val: 'top'         },
  { keys: ['底光', '脚灯', 'under light', '地灯', '屏幕光'],              val: 'under'       },
  { keys: ['柔光', '散射', 'soft light', '暖光', '暖黄', '台灯', '温馨'], val: 'soft'        },
  { keys: ['戏剧', '明暗', '强对比', '冷暖对比', 'dramatic', 'chiaroscuro'], val: 'dramatic' },
  { keys: ['黄金时段', '黄昏', '金色光', '金色', '夕阳', '落日', '晚霞', 'golden hour'], val: 'golden_hour' },
  { keys: ['蓝调', '傍晚', '余晖', '冷蓝', 'blue hour'],                  val: 'blue_hour'   },
  { keys: ['夜景', '夜晚', '深夜', '午夜', '低调', '漆黑', '昏暗', 'night'], val: 'night'   },
  { keys: ['霓虹', '赛博', 'neon', 'cyberpunk', '全息'],                  val: 'neon'        },
];

/** 归一化灯光风格为合法枚举（支持中英文） */
function normalizeLighting(raw) {
  if (!raw) return null;
  const l = String(raw).trim();
  if (LIGHTING[l] || LIGHTING_DESC[l]) return l;
  const lower = l.toLowerCase();
  for (const entry of ZH_LIGHTING_MAP) {
    if (entry.keys.some(k => lower.includes(k.toLowerCase()))) {
      return entry.val;
    }
  }
  return null;
}

function lightingToPrompt(lighting) {
  if (!lighting) return null;
  const l = String(lighting).trim();
  if (LIGHTING_DESC[l]) return LIGHTING_DESC[l];
  const lower = l.toLowerCase();
  for (const entry of ZH_LIGHTING_MAP) {
    if (entry.keys.some(k => lower.includes(k.toLowerCase()))) {
      return LIGHTING_DESC[entry.val] || null;
    }
  }
  return null;
}

// ─── 景深 ─────────────────────────────────────────────────────────────────────

/** 景深枚举值 */
const DEPTH_OF_FIELD = {
  extreme_shallow: 'extreme_shallow', // 极浅景深
  shallow:         'shallow',         // 浅景深
  medium:          'medium',          // 中景深
  deep:            'deep',            // 深景深（全焦）
};

/** 景深 → 英文 prompt */
const DOF_DESC = {
  extreme_shallow: 'extreme shallow depth of field, razor-thin focus plane, heavy creamy bokeh background',
  shallow:         'shallow depth of field, subject in sharp focus, background softly blurred with bokeh',
  medium:          'moderate depth of field, subject and near surroundings in focus',
  deep:            'deep focus, everything sharp from foreground to background, wide depth of field',
};

/** 景深中文 → 枚举 */
const ZH_DOF_MAP = [
  { keys: ['极浅', '大光圈', 'extreme shallow', 'razor thin', '大特写', '微距'], val: 'extreme_shallow' },
  { keys: ['浅景深', '浅', 'shallow', 'bokeh', '虚化', '特写', '近景'],          val: 'shallow'         },
  { keys: ['中景深', '适中', '中景', 'medium dof', 'medium'],                    val: 'medium'          },
  { keys: ['深景深', '全焦', '超焦', 'deep focus', 'deep dof', '全景', '远景'],  val: 'deep'            },
];

/** 归一化景深为合法枚举（支持中英文） */
function normalizeDof(raw) {
  if (!raw) return null;
  const d = String(raw).trim();
  if (DEPTH_OF_FIELD[d] || DOF_DESC[d]) return d;
  const lower = d.toLowerCase();
  for (const entry of ZH_DOF_MAP) {
    if (entry.keys.some(k => lower.includes(k.toLowerCase()))) {
      return entry.val;
    }
  }
  return null;
}

function dofToPrompt(dof) {
  if (!dof) return null;
  const d = String(dof).trim();
  if (DOF_DESC[d]) return DOF_DESC[d];
  const lower = d.toLowerCase();
  for (const entry of ZH_DOF_MAP) {
    if (entry.keys.some(k => lower.includes(k.toLowerCase()))) {
      return DOF_DESC[entry.val] || null;
    }
  }
  return null;
}

/**
 * 生成完整摄影参数描述（景别/俯仰/方向 + 运动 + 灯光 + 景深）
 */
function toCinematicFragment(h, v, s, movement, lighting, dof) {
  const parts = [toPromptFragment(h, v, s)];
  const mvDesc  = movementToPrompt(movement);
  const ltDesc  = lightingToPrompt(lighting);
  const dofDesc = dofToPrompt(dof);
  if (mvDesc)  parts.push(mvDesc);
  if (ltDesc)  parts.push(ltDesc);
  if (dofDesc) parts.push(dofDesc);
  return parts.join(', ');
}

// ─── 快速推断（基于现有字段关键字与电影视听语言智能推断）───────────────────

/**
 * 从分镜已有字段快速推断 movement / lighting_style / depth_of_field
 * 用于老分镜批量补全，以及新分镜 AI 未输出该字段时的兜底。
 * @param {object} sb - 分镜对象（含 atmosphere, time, angle_s, shot_type, movement, action 等）
 * @returns {{ movement: string, lighting_style: string, depth_of_field: string }}
 */
function inferPhotographyParams(sb, options = {}) {
  const atm  = (sb.atmosphere || '').toLowerCase();
  const time = (sb.time || '').toLowerCase();
  const desc = (sb.description || '').toLowerCase();
  const action = (sb.action || '').toLowerCase();
  const combined = `${atm} ${time} ${desc} ${action}`;

  // ── 灯光推断（若已有且合法则保留，否则智能推断，最终兜底为 natural）──
  let lighting = normalizeLighting(sb.lighting_style);
  if (!lighting) {
    if (/霓虹|赛博|neon|cyberpunk|全息|发光屏/.test(combined))                             lighting = 'neon';
    else if (/逆光|背光|backlit|轮廓光|rim light|发光轮廓/.test(combined))                  lighting = 'backlit';
    else if (/戏剧|明暗|强对比|冷暖对比|紧张|对峙|压迫|chiaroscuro|dramatic|noir/.test(combined)) lighting = 'dramatic';
    else if (/黄金时段|黄昏|金色|夕阳|落日|晚霞|golden/.test(combined))                    lighting = 'golden_hour';
    else if (/蓝调|暮色|傍晚|余晖|冷蓝|冷光|twilight|dusk|blue hour/.test(combined))       lighting = 'blue_hour';
    else if (/夜晚|夜景|深夜|午夜|漆黑|昏暗|night|dark/.test(combined))                    lighting = 'night';
    else if (/顶光|头顶|吊灯|射灯|top light/.test(combined))                               lighting = 'top';
    else if (/底光|脚灯|屏幕光|地灯|underlight/.test(combined))                            lighting = 'under';
    else if (/侧光|side light|侧面光|侧射/.test(combined))                                  lighting = 'side';
    else if (/柔光|散射|暖光|暖黄|暖色|柔和|台灯|温馨|家庭|soft light|soft|warm/.test(combined)) lighting = 'soft';
    else if (/顺光|正面光|front light/.test(combined))                                     lighting = 'front';
    else if (/自然光|日光|阳光|白天|清晨|午后|晴天|室内|日常|natural light|sunlight|daytime/.test(combined)) lighting = 'natural';
    else lighting = 'natural';
  }

  // ── 景深推断（依据景别与特写程度）──
  let dof = normalizeDof(sb.depth_of_field);
  if (!dof) {
    const angleS = sb.angle_s || '';
    const shotType = (sb.shot_type || '').toLowerCase();
    if (/极特写|大特写|微距|eye|lip|extreme close/.test(shotType) || /极特写/.test(desc)) {
      dof = 'extreme_shallow';
    } else if (angleS === 'close_up' || /特写|近景|close.?up|close/.test(shotType)) {
      dof = 'shallow';
    } else if (angleS === 'wide' || /大远景|远景|全景|大全景|long shot|wide shot|establishing/.test(shotType)) {
      dof = 'deep';
    } else if (angleS === 'medium' || /中景|半身|medium shot/.test(shotType)) {
      dof = 'medium';
    } else {
      dof = 'medium';
    }
  }

  // ── 运镜推断（严格少用固定镜头 static，根据动作、情绪、景别推断电影动态）──
  const movement = inferMovement(sb, options);

  return { movement: movement || 'push', lighting_style: lighting || 'natural', depth_of_field: dof || 'medium' };
}

/**
 * 从分镜语义智能推断电影化运镜（遵循“严格少用固定镜头 static”铁律）
 * @param {object} sb - 分镜对象
 * @param {object} [options] - 选项
 * @param {boolean} [options.upgradeStatic=false] - 是否将现有的 static 升级为更具电影动态感的运镜
 * @returns {string} movement 枚举 (push/pull/pan/tracking/handheld/crane_up/crane_dn/orbit/static)
 */
function inferMovement(sb, { upgradeStatic = false } = {}) {
  const existing = normalizeMovement(sb?.movement || sb?.camera_movement);
  if (existing && existing !== 'static' && !upgradeStatic) {
    return existing;
  }

  const action = (sb?.action || '').toLowerCase();
  const desc = (sb?.description || '').toLowerCase();
  const dialogue = (sb?.dialogue || '').trim();
  const emotion = (sb?.emotion || '').toLowerCase();
  const atmosphere = (sb?.atmosphere || '').toLowerCase();
  const shotType = (sb?.shot_type || '').toLowerCase();
  const angleS = sb?.angle_s || '';
  const text = `${action} ${desc} ${atmosphere}`;

  // 1. 只有极其明确要求固定机位（如“固定机位”、“定格画面”、“监控视角”、“绝对静止”）时才返回 static
  if (/固定机位|固定镜头|定格画面|监控死角|监控画面|绝对静止|机位不动/.test(text)) {
    return 'static';
  }

  // 若原有不是 static 且未要求 upgradeStatic，保持原有
  if (existing && existing !== 'static') {
    return existing;
  }

  // 2. 强动态动作与位移 -> tracking（跟镜）
  if (/追逐|奔跑|快速移动|追踪|撤离|前进|撤退|奔向|冲向|跑|走向|走出|迈步|走|步入|离开|穿过|飞奔|疾驰|移步|冲出|冲进|赶往|赶去|run|chase|escape|walk|move/.test(text)) {
    return 'tracking';
  }

  // 3. 紧张冲突/搏斗/混乱/负伤/中弹/倒地/挣扎 -> handheld（手持临场感）
  if (/手持|晃动|混乱|打斗|争执|震颤|中弹|倒地|负伤|挣扎|喘息|爆炸|射击|开火|交火|埋伏|危险|慌张|急促|摇晃|冲突|惊恐|撕扯|打翻|摔倒|痛呼|handheld|fight|struggle/.test(text)) {
    return 'handheld';
  }

  // 4. 聚焦细节/靠近/凝视/发现/操作/瞄准 -> push（缓推轨）
  if (/推近|靠近|凝视|逼近|发现|注视|关注|聚焦|仔细看|端详|拿起|伸手|握紧|按|点击|操作|输入|瞄准|锁定|查看|端起|低头看|直视|抬头看|仔细观察|查看伤口|zoom in|approach|look|stare|focus/.test(text)) {
    return 'push';
  }

  // 5. 后退/拉远/全局揭示/抽离/离开中心 -> pull（后拉镜头）
  if (/后退|拉远|展现全貌|远离|远离镜头|撤出|倒退|环顾四周|退后|退到|靠后|望向远处|放眼|全局|抽离|退回|pull back|reveal|retreat/.test(text)) {
    return 'pull';
  }

  // 6. 观察四周/环视/扫视/转头对视/巡视 -> pan（横摇/横移）
  if (/横摇|横移|环视|扫视|环顾|左右看|观察四周|巡视|转头|转过头|看向另一侧|对视|正反打|望向门口|pan|sweep|望向两侧/.test(text)) {
    return 'pan';
  }

  // 7. 站起/起飞/仰望/升起 -> crane_up（升镜）
  if (/抬头|仰望|升起|站起|起飞|起身|挺直|跃起|站立起来|站立|crane up/.test(text)) {
    return 'crane_up';
  }

  // 8. 蹲下/倒下/瘫坐/降落 -> crane_dn（降镜）
  if (/低头|蹲下|倒下|下坠|降落|倒在|瘫坐|伏倒|跌落|趴下|跪下|crane down/.test(text)) {
    return 'crane_dn';
  }

  // 9. 环绕/包围 -> orbit（环绕）
  if (/环绕|盘旋|转圈|打转|围绕|包围|圈住|orbit/.test(text)) {
    return 'orbit';
  }

  // 10. 情绪驱动运镜
  if (/紧张|危机|警惕|急促|恐慌|愤怒|绝望|对峙|突发/.test(emotion)) {
    return 'handheld';
  }
  if (/专注|严肃|凝重|冷峻|好奇|探寻|决心|惊讶/.test(emotion)) {
    return 'push';
  }
  if (/悲伤|失落|无力|释然|叹息|迷茫|孤单/.test(emotion)) {
    return 'pull';
  }

  // 11. 景别与对白做智能电影化推断
  if (angleS === 'close_up' || /特写|近景/.test(shotType)) {
    return 'push';
  }
  if (angleS === 'wide' || /大远景|远景|全景/.test(shotType)) {
    return 'pan';
  }
  if (dialogue) {
    return 'push';
  }

  // 12. 最终兜底：短剧视频严格少用固定镜头，默认使用缓推轨 (push) 赋予画面电影呼吸感
  return 'push';
}

/**
 * 智能推断与补全镜头视角三元组 (h, v, s)
 * @param {object} sb
 * @returns {{ h: string, v: string, s: string }}
 */
function inferAngleTriple(sb) {
  let h = sb.angle_h || null;
  let v = sb.angle_v || null;
  let s = sb.angle_s || null;

  if (!h || !v || !s) {
    const parsed = parseFromLegacyText(sb.angle || '', sb.shot_type || '');
    if (!h) h = parsed.h;
    if (!v) v = parsed.v;
    if (!s) s = parsed.s;
  }

  const combined = `${sb.action || ''} ${sb.atmosphere || ''} ${sb.description || ''}`.toLowerCase();
  if (v === 'eye_level' || !v) {
    if (/仰视|仰望|抬头|高大|压迫|从下往上|低机位/.test(combined)) v = 'low';
    else if (/俯瞰|俯视|居高临下|从上往下|鸟瞰|高机位/.test(combined)) v = 'high';
    else if (/趴在地上|贴地|地缝|虫眼/.test(combined)) v = 'worm';
    else v = 'eye_level';
  }
  if (h === 'front' || !h) {
    if (/背影|背后|背对镜头|转身离去|走向深处/.test(combined)) h = 'back';
    else if (/正侧面|侧脸|侧身|侧向镜头|转头看向一侧/.test(combined)) h = 'left';
    else if (/斜侧|45度|前侧|半侧身/.test(combined)) h = 'front_left';
    else h = 'front';
  }
  if (!s) {
    const st = (sb.shot_type || '').toLowerCase();
    if (/特写|近景/.test(st)) s = 'close_up';
    else if (/大远景|远景|全景/.test(st)) s = 'wide';
    else s = 'medium';
  }

  return { h, v, s };
}

/**
 * 针对无对白镜头自动推断匹配的电影级背景音乐描述（专供 H3 等音视频模型原生合成）
 * @param {object} sb
 * @returns {string}
 */
function inferBgmPrompt(sb) {
  const combined = `${sb.action || ''} ${sb.atmosphere || ''} ${sb.description || ''} ${sb.emotion || ''} ${sb.title || ''}`.toLowerCase();
  if (/战斗|射击|突围|追逐|交火|奔跑|爆炸|打斗|枪声|冲锋|逃跑|反击|开火|包围|破门/.test(combined)) {
    return '快节奏重低音打击乐与紧张电子脉冲，战术爆发感与危机节奏';
  }
  if (/对峙|潜伏|备战|警惕|压迫|对视|凝视|紧张|危机|搜索|隐蔽|靠近|瞄准|巡逻|侦察/.test(combined)) {
    return '低沉压抑的环境低频嗡鸣与心跳脉冲，战备悬疑感与窒息对峙';
  }
  if (/伤心|痛苦|牺牲|告别|眼泪|悲伤|绝望|疲惫|倒下|重伤|无力|哭泣|失落/.test(combined)) {
    return '缓慢深沉的大提琴与孤独钢琴独奏，空旷伤感与情绪余波';
  }
  if (/日常|家庭|温馨|回忆|平静|轻松|吃饭|欢笑|聊天|散步|阳光/.test(combined)) {
    return '轻柔舒缓的吉他扫弦与暖心木管乐，平静的生活叙事质感';
  }
  if (/未来|科技|全息|赛博|机械|系统|终端|实验室|数据|芯片|投影/.test(combined)) {
    return '科幻合成器冷调环境音与低频电子脉冲，硬科幻冷峻科技感';
  }
  return '契合现场画面的低沉电影原声配乐，伴随微弱环境氛围节奏';
}

module.exports = {
  HORIZONTAL,
  ELEVATION,
  SHOT_SIZE,
  MOVEMENT,
  LIGHTING,
  DEPTH_OF_FIELD,
  toPromptFragment,
  toCinematicFragment,
  movementToPrompt,
  lightingToPrompt,
  dofToPrompt,
  inferPhotographyParams,
  inferMovement,
  inferAngleTriple,
  inferBgmPrompt,
  normalizeMovement,
  normalizeLighting,
  normalizeDof,
  parseFromLegacyText,
  fromLegacyText,
  toChineseLabel,
  listAllAngles,
};
