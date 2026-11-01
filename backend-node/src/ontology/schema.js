/**
 * 影视视听本体（Audiovisual Drama Ontology）架构规范
 * 参考 /home/nvidia/ontology-semantic-system 的本体语义建模理念：
 * - 明确对象实体（Entities）、状态属性（Properties）、空间关系（Relations）
 * - 严禁散装字典与模糊猜测，提供强类型数据契约与规范定义
 */

// ── 景别本体枚举 ──
const SHOT_TYPES = {
  ESTABLISHING: '大远景',
  WIDE: '远景',
  FULL: '全景',
  MEDIUM: '中景',
  CLOSE_UP: '近景',
  EXTREME_CLOSE_UP: '特写',
};

// ── 运镜本体枚举（动态流动优先，少用固定） ──
const CAMERA_MOVEMENTS = {
  PUSH: 'push',               // 缓推轨贴近主体
  PULL: 'pull',               // 后拉镜头展开环境
  PAN: 'pan',                 // 水平横移/横摇
  TILT: 'tilt',               // 垂直俯仰
  TRACKING: 'tracking',       // 移动跟拍
  HANDHELD: 'handheld',       // 手持呼吸感微晃
  CRANE_UP: 'crane_up',       // 升镜展开纵深
  CRANE_DN: 'crane_dn',       // 降镜俯向主体
  ORBIT: 'orbit',             // 环绕运镜
  BULLET_TIME: 'bullet_time', // 子弹时间
  STATIC: 'static',           // 固定机位（由导演按剧情选择）
};

// ── 3D 机位三元组枚举 ──
const CAMERA_ANGLES = {
  HORIZONTAL: ['front', 'front_left', 'front_right', 'left', 'right', 'back', 'back_left', 'back_right'],
  ELEVATION: ['eye_level', 'low', 'high', 'top_down', 'worm'],
  SHOT_SCALE: ['establishing', 'wide', 'medium', 'close_up', 'extreme_close_up'],
};

// ── 光影与照明本体枚举 ──
const LIGHTING_STYLES = {
  NATURAL: 'natural',
  FRONT: 'front',
  SIDE: 'side',
  BACKLIT: 'backlit',
  TOP: 'top',
  UNDER: 'under',
  SOFT: 'soft',
  DRAMATIC: 'dramatic',
  GOLDEN_HOUR: 'golden_hour',
  BLUE_HOUR: 'blue_hour',
  NIGHT: 'night',
  NEON: 'neon',
};

// ── 景深本体枚举 ──
const DEPTH_OF_FIELD = {
  EXTREME_SHALLOW: 'extreme_shallow',
  SHALLOW: 'shallow',
  MEDIUM: 'medium',
  DEEP: 'deep',
};

// ── 空间站位与构图锚点 ──
const SPATIAL_POSITIONS = {
  LEFT_THIRD: 'screen_left',
  CENTER: 'screen_center',
  RIGHT_THIRD: 'screen_right',
  FOREGROUND: 'foreground',
  MIDGROUND: 'midground',
  BACKGROUND: 'background',
};

// ── 角色空间朝向 ──
const FACING_DIRECTIONS = {
  TOWARD_CAMERA: 'toward_camera',
  THREE_QUARTER_LEFT: 'three_quarter_left',
  THREE_QUARTER_RIGHT: 'three_quarter_right',
  PROFILE_LEFT: 'profile_left',
  PROFILE_RIGHT: 'profile_right',
  AWAY_FROM_CAMERA: 'away_from_camera',
  THREE_QUARTER_BACK_LEFT: 'three_quarter_back_left',
  THREE_QUARTER_BACK_RIGHT: 'three_quarter_back_right',
  SCREEN_LEFT: 'screen_left',
  SCREEN_RIGHT: 'screen_right',
  INTERACTIVE_OPPONENT: 'facing_opponent',
};

// ── 对话视听构图选择题枚举（彻底告别面向镜头跟空气说话） ──
const DIALOGUE_FRAMING = {
  TWO_SHOT_FACE_TO_FACE: 'two_shot_face_to_face',         // 双人面对面对视：左右3/4侧身互相对视，视线交汇，严禁直视镜头
  OVER_THE_SHOULDER: 'over_the_shoulder',                 // 经典过肩拍 OTS：前景露出肩背充当引线，后景搭档面部清晰，视线轴贯穿纵深
  SINGLE_REACTION_OFFSCREEN: 'single_reaction_offscreen', // 单人视线看画外：身体微侧30°-45°，目光锁定画外搭档，严禁直视摄影机
  JOINT_OBSERVATION: 'joint_observation',                 // 双人同向观察：两人侧身前倾，共同注视前方战术目标/屏幕，严禁直视镜头
  SOLO_ACTION: 'solo_action',                             // 单人专注动作：视线锁定手中道具或行动目标，无对话
};

// ── 画面纵深层级 ──
const DEPTH_LAYERS = {
  FOREGROUND: 'foreground', // 画面前景近处（景深虚化遮挡物、过肩肩颈、近身特写引线）
  MIDGROUND: 'midground',   // 画面中景主体（清晰焦点，主要动作与对白承载区）
  BACKGROUND: 'background', // 画面后景深处（纵深掩护、战术支援、环境灭点透视）
};

// ── 头部姿态枚举 ──
const HEAD_POSES = {
  HEAD_FRONT: 'head_front',               // 头部正对前方
  HEAD_TILT_UP: 'head_tilt_up',           // 头部微仰（仰视观察高台、窗口、大屏）
  HEAD_TILT_DOWN: 'head_tilt_down',       // 低头俯视/咬牙垂首（专注资料或隐忍情绪）
  HEAD_TURN_LEFT: 'head_turn_left',       // 侧头偏向左侧（转向左侧搭档）
  HEAD_TURN_RIGHT: 'head_turn_right',     // 侧头偏向右侧（转向右侧搭档）
  HEAD_LOOK_BACK: 'head_look_back',       // 转头回望（警戒后方或依依惜别）
  HEAD_NATURAL_TILT: 'head_natural_tilt', // 随动作身体自然倾斜
};

// ── 目光视线落点枚举 ──
const GAZE_DIRECTIONS = {
  LOCKED_ON_PARTNER: 'locked_on_partner',                 // 视线锁定戏中搭档，眼神对视交汇，严禁直视镜头
  LOCKED_OFFSCREEN: 'locked_offscreen',                   // 目光专注凝视画外对话人，眼神自然避开镜头
  LOCKED_ON_TACTICAL_TARGET: 'locked_on_tactical_target', // 目光锐利锁定前方战术目标/二层窗口/岔路威胁点
  FOCUSED_ON_SCREEN: 'focused_on_screen',                 // 双眼专注凝视前方冷光屏幕/终端/大屏拓扑
  FOCUSED_ON_PROP: 'focused_on_prop',                     // 双眼紧盯手中操作的道具/武器/纸页资料
  SCANNING_ENVIRONMENT: 'scanning_environment',           // 警惕扫视周围环境两侧，目光游移防备
};

// ── 躯干重心与体态枚举 ──
const POSTURE_TYPES = {
  STANDING_UPRIGHT: 'standing_upright',                 // 挺拔立姿，身姿端正重心稳固
  STANDING_ALERT: 'standing_alert',                     // 战术立姿微侧，重心下沉机动待发
  CROUCHING_LOW: 'crouching_low',                       // 半蹲低伏紧贴掩体，重心压低避开射界
  KNEELING_SINGLE: 'kneeling_single',                   // 单膝跪姿身体微侧，保持低位隐蔽与稳定
  SITTING_LEANING_FORWARD: 'sitting_leaning_forward',   // 身体前倾坐姿，上身紧贴桌台/控制台边缘
  SITTING_UPRIGHT: 'sitting_upright',                   // 端正端坐，双肩平展
  PRONE_COVER: 'prone_cover',                           // 侧卧撑地 / 卧姿掩蔽，紧贴地面
  STUMBLING_UNBALANCED: 'stumbling_unbalanced',         // 身体大幅倾斜失衡，单手撑地定格
  LEAPING_FREEZE: 'leaping_freeze',                     // 身体前跃飞扑，凌空定格重心前倾
  WALL_LEANING: 'wall_leaning',                         // 侧身背靠墙壁/立柱，重心稳固
};

// ── 四肢与手部动作枚举 ──
const HANDS_ACTIONS = {
  HANDS_NATURAL_SIDES: 'hands_natural_sides',                 // 双手自然放松微屈垂于身侧
  HANDS_FOLDED_CHEST: 'hands_folded_chest',                   // 双手收于胸前，神态专注聆听
  HOLDING_WEAPON_ALERT: 'holding_weapon_alert',               // 双手紧握战术武器呈戒备瞄准姿态，食指搭在扳机护圈外
  ONE_HAND_ON_EARPIECE: 'one_hand_on_earpiece',               // 单手手指紧按战术通讯耳机，另一手护于胸前
  ONE_HAND_ON_DESK: 'one_hand_on_desk',                       // 单手掌心按在桌面边缘定格，另一手自然收拢
  HANDS_ON_KEYBOARD: 'hands_on_keyboard',                     // 双手手指悬停或轻触键盘按键上方
  ONE_HAND_POINTING: 'one_hand_pointing',                     // 单臂向前平举，食指直指目标行动方向
  ONE_HAND_ON_SHOULDER: 'one_hand_on_shoulder',               // 单手按在对方肩膀上，另一手撑在掩体边缘
  ONE_HAND_SUPPORTING_GROUND: 'one_hand_supporting_ground',   // 单手手掌牢牢撑向地面稳住失衡重心
  FISTS_CLENCHED: 'fists_clenched',                           // 单手在身侧紧紧攥拳，指节发白定格
};

// ── 音频与口型控制模式 ──
const AUDIO_LIP_SYNC_MODES = {
  IN_FRAME_DIALOGUE: 'in_frame_dialogue',     // 画内人物说话（说话人发音并严格同步唇形动作，画内其余角色双唇紧闭）
  OFFSCREEN_VOICEOVER: 'offscreen_voiceover', // 画外音/画外说话（画内所有人双唇紧闭，严禁动嘴，无任何口型）
  NARRATION: 'narration',                     // 客观旁白解说（画面无声解说，全员双唇紧闭，严禁动嘴）
  SILENT_AMBIENT: 'silent_ambient',           // 纯环境音效（全员双唇紧闭，严禁动嘴，专注战术动作）
  BGM_ONLY: 'bgm_only',                       // 纯电影配乐分镜（全员双唇紧闭，专供视频模型原生合成高质量背景音乐）
};

// ── 声音传导介质枚举 ──
const DELIVERY_MEDIUMS = {
  DIRECT_SPEECH: 'direct_speech', // 现场面对面原声发音
  RADIO_HEADSET: 'radio_headset', // 战术无线电/单兵战术耳机
  PHONE_CALL: 'phone_call',       // 手机/电话通讯
  INTERCOM: 'intercom',           // 车载/广播对讲机
  VOICEOVER: 'voiceover',         // 画外音/内心独白/回忆
  NARRATION: 'narration',         // 第三人称客观旁白解说
};

// ── 长镜头接力角色枚举 ──
const LONG_TAKE_ROLES = {
  HEAD: 'head',                 // 长镜头组首（必须由文生图根据槽位生成高保真首帧图）
  CONTINUATION: 'continuation', // 接力续镜（自动提取上一镜视频尾帧作为起始帧，延续动线与运镜）
  TAIL: 'tail',                 // 终镜收尾（承接上一镜尾帧，完成长镜头动作收束）
};

// ── 电影镜头光学参数枚举 ──
const CINEMATIC_LENSES = {
  ANAMORPHIC_35MM: 'anamorphic_35mm', // 35mm宽银幕变形镜头（经典椭圆散景与宽阔水平视场）
  PRIME_50MM: 'prime_50mm',           // 50mm电影大师标准定焦镜头（逼真透视比例，人眼自然视角）
  PORTRAIT_85MM: 'portrait_85mm',     // 85mm人像长焦定焦镜头（极浅景深，五官立体无畸变）
  WIDE_24MM: 'wide_24mm',             // 24mm电影广角镜头（开阔场景纵深，宏阔视觉冲击）
};

// ── 实体工厂函数：构造符合本体契约的对象 ──

function createCharacterEntity({ id, name, gender = 'unknown', role = '', appearance = '', wardrobeStageId = null, state = 'normal', voice = null }) {
  return {
    entity_type: 'character',
    id: Number(id),
    name: String(name || '').trim(),
    gender: String(gender),
    role: String(role),
    appearance: String(appearance),
    wardrobe_stage_id: wardrobeStageId != null ? Number(wardrobeStageId) : null,
    physical_state: state, // normal, injured, fallen, exhausted, alert
    voice: voice ? { ...voice } : null,
  };
}

function createSceneSpatialEntity({ id, location, time, spatialType = 'interior', lightingEnv = 'natural', landmarks = [], acoustics = '' }) {
  return {
    entity_type: 'scene_spatial',
    id: Number(id),
    location: String(location || '').trim(),
    time: String(time || '').trim(),
    spatial_type: spatialType, // interior_tight, interior_open, exterior_open, tactical_field
    lighting_env: lightingEnv,
    landmarks: Array.isArray(landmarks) ? landmarks : [], // e.g. ['doorway', 'desk', 'cover_box']
    acoustics: String(acoustics),
  };
}

function createShotEntity(data = {}) {
  return {
    entity_type: 'shot',
    shot_number: Number(data.shot_number || 1),
    title: String(data.title || '').trim(),
    segment_index: Number(data.segment_index || 0),
    segment_title: data.segment_title || null,
    scene_id: data.scene_id != null ? Number(data.scene_id) : null,
    shot_type: data.shot_type || '中景',
    angle_h: data.angle_h || 'front',
    angle_v: data.angle_v || 'eye_level',
    angle_s: data.angle_s || 'medium',
    movement: data.movement || 'push',
    lighting_style: data.lighting_style || 'natural',
    depth_of_field: data.depth_of_field || 'medium',
    duration: Math.max(1, Number(data.duration) || 5),
    action: String(data.action || '').trim(),
    result: String(data.result || '').trim(),
    dialogue: String(data.dialogue || '').trim(),
    narration: String(data.narration || '').trim(),
    bgm_prompt: String(data.bgm_prompt || '').trim(),
    sound_effect: String(data.sound_effect || '').trim(),
    emotion: String(data.emotion || '').trim(),
    layout_description: String(data.layout_description || '').trim(),
    character_ids: Array.isArray(data.character_ids) ? data.character_ids.map(Number) : [],
    prop_ids: Array.isArray(data.prop_ids) ? data.prop_ids.map(Number) : [],
  };
}

// ── 时代世界观枚举 ──
const DRAMA_ERAS = {
  ANCIENT: 'ancient',               // 古装/古风/仙侠/武侠
  REPUBLIC_CHINA: 'republic_china', // 民国/近代
  MODERN: 'modern',                 // 现代/都市/现实主义
  SCI_FI: 'sci_fi',                 // 科幻/赛博朋克/星际
  FANTASY: 'fantasy',               // 奇幻/魔幻
};

// ── 角色主体面部识别度枚举 ──
const IDENTITY_VISIBILITIES = {
  CLEAR_FRONTAL: 'clear_frontal', // 清晰正脸识别（核心对白特写与主要情绪呈现）
  THREE_QUARTER: 'three_quarter', // 侧脸3/4微侧（标准电影构图，立体五官雕刻）
  PROFILE: 'profile',             // 正侧剪影（对峙凝视或远眺）
  BACK_VIEW: 'back_view',         // 背影定格（过肩前景或离开背身）
  SILHOUETTE: 'silhouette',       // 逆光剪影（氛围意境与神秘感）
  OCCLUDED: 'occluded',           // 遮挡/虚化（前景障碍物半遮）
};

// ── 镜头连戏接续类型枚举 ──
const CONTINUITY_TYPES = {
  MATCH_CUT: 'match_cut',                         // 动作匹配切（承接上一镜动作动势）
  EYELINE_MATCH: 'eyeline_match',                 // 视线匹配（正反打目光交汇）
  OTS_REVERSE: 'ots_reverse',                     // 过肩反打（正反双人对话交替）
  HARD_CUT: 'hard_cut',                           // 场景硬切（转场或时间推进）
  CONTINUATION: 'continuation',                   // 同场景连戏续镜（动作连贯延伸）
  LONG_TAKE_CONTINUATION: 'long_take_continuation', // 长镜头接力续镜（承接尾帧）
};

// ── 首帧生成策略枚举 ──
const FIRST_FRAME_POLICIES = {
  NONE: 'none',                 // Ref2VA 仅使用多参考素材，不生成首帧引导
  GENERATE_NEW: 'generate_new', // 独立全新文生图生成首帧
  INHERIT_TAIL: 'inherit_tail', // 继承前序分镜视频尾帧为本镜首帧
  LAYOUT_LOCK: 'layout_lock',   // 首帧空间构图锁保持
};

// ── 尾帧生成策略枚举 ──
const LAST_FRAME_POLICIES = {
  GENERATE_TAIL: 'generate_tail', // 规划并生成指定尾帧（首尾帧双向引导）
  NONE: 'none',                   // 无尾帧（单首帧驱动或纯Ref2VA）
};

/**
 * 构造标准 12 项影视分镜语义槽位对象
 */
function createSemanticSlots(data = {}) {
  const visible = Array.isArray(data.visible_characters) ? data.visible_characters : (Array.isArray(data.characters) ? data.characters : []);
  const background = Array.isArray(data.background_characters) ? data.background_characters : [];
  const refs = Array.isArray(data.required_references) ? data.required_references : [];

  return {
    visible_characters: visible.map(c => typeof c === 'object' ? c : { name: String(c) }),
    background_characters: background.map(c => typeof c === 'object' ? c : { name: String(c) }),
    identity_visibility: data.identity_visibility || IDENTITY_VISIBILITIES.THREE_QUARTER,
    wardrobe_id: data.wardrobe_id != null ? data.wardrobe_id : null,
    speech_plan: {
      speaker_id: data.speech_plan?.speaker_id || null,
      speaker_name: data.speech_plan?.speaker_name || '',
      is_offscreen: !!data.speech_plan?.is_offscreen,
      is_narration: !!data.speech_plan?.is_narration,
      text: String(data.speech_plan?.text || data.dialogue || '').trim(),
      speed: Number(data.speech_plan?.speed) || 1.0,
      emotion: String(data.speech_plan?.emotion || data.emotion || '').trim(),
      audio_references: Array.isArray(data.speech_plan?.audio_references) ? data.speech_plan.audio_references : [],
    },
    sound_plan: {
      sound_effects: Array.isArray(data.sound_plan?.sound_effects) ? data.sound_plan.sound_effects : (data.sound_effect ? [data.sound_effect] : []),
      bgm_prompt: String(data.sound_plan?.bgm_prompt || data.bgm_prompt || '').trim(),
      acoustic_env: String(data.sound_plan?.acoustic_env || '').trim(),
      is_silent: !!(data.sound_plan?.is_silent || data.is_silent),
    },
    continuity_type: data.continuity_type || CONTINUITY_TYPES.CONTINUATION,
    h3_mode: data.h3_mode || null,
    h3_mode_reason: String(data.h3_mode_reason || '').trim(),
    first_frame_policy: data.first_frame_policy || (data.long_take_role === 'continuation' ? FIRST_FRAME_POLICIES.INHERIT_TAIL : FIRST_FRAME_POLICIES.GENERATE_NEW),
    first_frame_reason: String(data.first_frame_reason || '').trim(),
    last_frame_policy: data.last_frame_policy || LAST_FRAME_POLICIES.NONE,
    last_frame_reason: String(data.last_frame_reason || '').trim(),
    required_references: refs.map(r => ({
      id: r.id != null ? r.id : null,
      character_id: r.character_id != null ? r.character_id : null,
      stage_id: r.stage_id != null ? r.stage_id : null,
      type: r.type || 'character', // character, scene, prop, costume
      name: r.name || '',
      url: r.url || r.image_url || r.local_path || '',
      description: r.description || r.appearance || '',
    })),
    audio_lip_sync: data.audio_lip_sync || (data.speech_plan?.is_narration ? AUDIO_LIP_SYNC_MODES.NARRATION : (data.speech_plan?.is_offscreen ? AUDIO_LIP_SYNC_MODES.OFFSCREEN_VOICEOVER : AUDIO_LIP_SYNC_MODES.IN_FRAME_DIALOGUE)),
    shot_duration: Math.max(1, Number(data.shot_duration || data.duration) || 5),
  };
}

// ── 道具本体实体 ──
function createPropEntity({ id, name, type = '日常用品', eraCategory = 'universal', eraCompatibility = '', eraReason = '', physicalScale = '', description = '', ownerCharacterId = null, prompt = '' }) {
  return {
    entity_type: 'prop',
    id: id != null ? Number(id) : null,
    name: String(name || '').trim(),
    type: String(type || '日常用品').trim(),
    era_category: String(eraCategory || 'universal'), // ancient, modern, sci_fi, universal
    era_compatibility: String(eraCompatibility || ''), // compatible, intentional_cross_era, incompatible, uncertain
    era_reason: String(eraReason || '').trim(),
    physical_scale: String(physicalScale || '').trim(), // e.g. "高度约75cm，次要环境物件"
    description: String(description || '').trim(),
    owner_character_id: ownerCharacterId != null ? Number(ownerCharacterId) : null,
    image_prompt: String(prompt || '').trim(),
  };
}

// ── 剧本叙事节拍本体实体 ──
function createBeatEntity({ beatNumber, title = '', eventSummary = '', preConditions = [], postConditions = [], tensionLevel = 1, sceneId = null, characterIds = [], propIds = [] }) {
  return {
    entity_type: 'narrative_beat',
    beat_number: Number(beatNumber || 1),
    title: String(title || '').trim(),
    event_summary: String(eventSummary || '').trim(),
    pre_conditions: Array.isArray(preConditions) ? preConditions : [],
    post_conditions: Array.isArray(postConditions) ? postConditions : [],
    tension_level: Math.max(0, Math.min(3, Number(tensionLevel) || 1)), // 0: 平缓, 1: 展开, 2: 紧张对峙, 3: 高潮爆发
    scene_id: sceneId != null ? Number(sceneId) : null,
    character_ids: Array.isArray(characterIds) ? characterIds.map(Number) : [],
    prop_ids: Array.isArray(propIds) ? propIds.map(Number) : [],
  };
}

const {
  createCharacterVisualSlot,
  compileImagePromptFromSlots,
  synthesizeCharacterVisualSlots,
} = require('./visualSlots');

// ── 影视视听本体统一数据字典 (Audiovisual Slot Data Dictionary) ──
// 【核心设计准则】：字典仅供模型与Agent启发和参考（Reference Guidance），绝非必须填写的死板封闭值！
// 系统完全支持开放式描述（open_ended: true），鼓励结合具体剧情与镜头情境做生动的个性化与具象扩充。
const AUDIOTISUAL_DATA_DICTIONARY = {
  _meta: {
    is_strict_whitelist: false,
    reference_only: true,
    open_ended: true,
    description: '影视视听本体数据字典定义了工业级视听分镜的核心维度与参考推荐项。作为智能体提示与思考基准，绝非硬性限制，完全支持根据剧情做开放式具象扩充与自然语言发挥。',
  },
  dialogue_framing: {
    name_zh: '对话视听构图',
    category: 'composition',
    open_ended: true,
    reference_only: true,
    description: '对话场景机位与视线交互参考（字典仅供启发参考，非必填固定值），建议形成视线闭环、避免面对镜头自言自语，支持开放式构图描述',
    required: false,
    enums: {
      two_shot_face_to_face: { label: '双人面对面对视（参考）', desc: '两人左右站位，微转3/4侧身互相对视，眼神交汇，严禁直视镜头' },
      over_the_shoulder: { label: '经典过肩拍 OTS（参考）', desc: '前景人物露出肩背作为视觉引线，后景搭档面部清晰，视线轴贯穿纵深' },
      single_reaction_offscreen: { label: '单人视线看画外（参考）', desc: '单人近景/特写，身体与头部微转30°-45°，眼神专注锁定画外搭档' },
      joint_observation: { label: '双人同向观察（参考）', desc: '两人侧身前倾，共同注视前方战术目标/屏幕，严禁直视镜头' },
      solo_action: { label: '单人动作无对话（参考）', desc: '专注手中道具、武器操作或周围环境探索' },
    },
  },
  depth_layer: {
    name_zh: '画面纵深层级',
    category: 'spatial_depth',
    open_ended: true,
    description: '三维Z轴空间纵深分层参考，打破扁平贴纸感，构建电影透视',
    required: false,
    enums: {
      foreground: { label: '画面前景近处', desc: '景深虚化遮挡物、过肩肩颈、近身特写引线' },
      midground: { label: '画面中景主体', desc: '清晰焦点，主要动作与对白承载区' },
      background: { label: '画面后景深处', desc: '纵深掩护、战术支援、环境灭点透视' },
    },
  },
  facing: {
    name_zh: '人物空间朝向',
    category: 'character_pose',
    open_ended: true,
    description: '人物躯干在摄影机坐标系中的三维朝向基准参考，支持结合场景自由方位描述',
    required: false,
    description: '人物躯干在摄影机坐标系中的三维朝向',
    required: true,
    enums: {
      toward_camera: { label: '正面面对镜头', desc: '仅用于特殊独白或极特殊正面镜头' },
      three_quarter_left: { label: '3/4侧身面朝左侧', desc: '身体微转向左，面向左侧搭档或左侧目标' },
      three_quarter_right: { label: '3/4侧身面朝右侧', desc: '身体微转向右，面向右侧搭档或右侧目标' },
      profile_left: { label: '90度正侧向左', desc: '纯正侧面轮廓剪影或观察' },
      profile_right: { label: '90度正侧向右', desc: '纯正侧面轮廓剪影或观察' },
      away_from_camera: { label: '背向镜头', desc: '正背影，强化沉重、未知或凝视远方' },
      three_quarter_back_left: { label: '3/4侧背向左', desc: '露出右肩与侧背，经典OTS过肩前景' },
      three_quarter_back_right: { label: '3/4侧背向右', desc: '露出左肩与侧背，经典OTS过肩前景' },
      facing_opponent: { label: '侧身迎向搭档', desc: '身体自然偏向对话方' },
    },
  },
  head_pose: {
    name_zh: '头部姿态',
    category: 'character_pose',
    description: '头部相对躯干的俯仰与转向姿势',
    required: true,
    enums: {
      head_front: { label: '头部正对前方', desc: '头部与躯干朝向一致' },
      head_tilt_up: { label: '头部微仰', desc: '仰视观察高台、窗口、大屏' },
      head_tilt_down: { label: '低头咬牙/俯视桌面', desc: '专注资料或隐忍情绪' },
      head_turn_left: { label: '侧头偏向左侧', desc: '转向左侧搭档' },
      head_turn_right: { label: '侧头偏向右侧', desc: '转向右侧搭档' },
      head_look_back: { label: '转头回望', desc: '警戒后方或依依惜别' },
      head_natural_tilt: { label: '随动作自然倾斜', desc: '配合身体倾斜与动态' },
    },
  },
  gaze: {
    name_zh: '目光视线落点',
    category: 'character_pose',
    description: '双眼视线聚焦点，建立画内视线轴与注意力',
    required: true,
    enums: {
      locked_on_partner: { label: '锁定戏中搭档', desc: '眼神对视交流，严禁直视镜头' },
      locked_offscreen: { label: '专注凝视画外对话人', desc: '眼神自然避开镜头，锁定画外说话者' },
      locked_on_tactical_target: { label: '锁定战术目标', desc: '目光锐利锁定二层窗口/岔路威胁点' },
      focused_on_screen: { label: '专注凝视屏幕', desc: '双眼紧盯前方冷光屏幕/终端/大屏' },
      focused_on_prop: { label: '紧盯手中道具/资料', desc: '目光落在武器、手枪、纸页或关键道具' },
      scanning_environment: { label: '警惕扫视环境两侧', desc: '目光游移防备，观察敌情' },
    },
  },
  posture: {
    name_zh: '躯干体态与重心',
    category: 'character_pose',
    description: '首帧决定性瞬间的纯静态物理定格姿态',
    required: true,
    enums: {
      standing_upright: { label: '挺拔立姿', desc: '身姿端正，身体重心平稳' },
      standing_alert: { label: '战术立姿微侧', desc: '重心下沉机动待发' },
      crouching_low: { label: '半蹲低伏紧贴掩体', desc: '重心压低避开射界' },
      kneeling_single: { label: '单膝跪姿身体微侧', desc: '保持低位隐蔽与稳定' },
      sitting_leaning_forward: { label: '身体前倾坐姿', desc: '上身紧贴桌台/控制台边缘' },
      sitting_upright: { label: '端正端坐', desc: '双肩平展，仪态端庄' },
      prone_cover: { label: '侧卧撑地/卧姿掩蔽', desc: '紧贴地面，单手撑起' },
      stumbling_unbalanced: { label: '倾斜失衡定格', desc: '身体大幅向侧方倾斜失衡，单手撑地定格' },
      leaping_freeze: { label: '飞扑凌空定格', desc: '身体前跃扑出，重心前倾' },
      wall_leaning: { label: '侧身背靠墙壁', desc: '背靠墙面或立柱，重心稳固' },
    },
  },
  hands: {
    name_zh: '四肢与手部动作',
    category: 'character_pose',
    description: '手指与双手的具体物理接触与定格姿势',
    required: true,
    enums: {
      hands_natural_sides: { label: '双手自然垂于身侧', desc: '手指放松微屈' },
      hands_folded_chest: { label: '双手收于胸前', desc: '神态专注聆听' },
      holding_weapon_alert: { label: '持枪戒备瞄准', desc: '食指搭在扳机护圈外侧' },
      one_hand_on_earpiece: { label: '单手紧按战术耳机', desc: '手指按压耳机，另一手护胸' },
      one_hand_on_desk: { label: '单手掌心按桌面', desc: '掌心撑在桌沿边缘定格' },
      hands_on_keyboard: { label: '双手悬停键盘', desc: '手指悬在按键上方保持敲击定格' },
      one_hand_pointing: { label: '单臂平举直指方向', desc: '食指直指目标行动方向' },
      one_hand_on_shoulder: { label: '单手按对方肩膀', desc: '手掌按压搭档肩头，另一手撑掩体' },
      one_hand_supporting_ground: { label: '单手撑向地面', desc: '手掌紧贴地表稳住失衡重心' },
      fists_clenched: { label: '身侧紧紧攥拳', desc: '拳头紧攥，指节发白定格' },
    },
  },
  movement: {
    name_zh: '机位运镜动态',
    category: 'camera',
    description: '摄影机运动方式（由叙事决定，可保持固定机位）',
    required: true,
    enums: {
      push: { label: '缓推轨贴近主体 (push)', desc: '强化情绪，聚焦心理变化' },
      pull: { label: '后拉镜头展开环境 (pull)', desc: '展现危机、空间纵深与人物处境' },
      pan: { label: '水平横移/横摇 (pan)', desc: '视线转移，跟随对白与两翼' },
      tilt: { label: '垂直俯仰 (tilt)', desc: '展示高耸结构、压迫感审视' },
      tracking: { label: '平稳移动跟拍 (tracking)', desc: '伴随人物移动、追逐与机动' },
      handheld: { label: '手持呼吸感微晃 (handheld)', desc: '强烈临场感、紧张冲突、负伤' },
      crane_up: { label: '升镜展开纵深 (crane_up)', desc: '自下而上展开宏阔视界' },
      crane_dn: { label: '降镜俯冲逼近 (crane_dn)', desc: '自上而下俯冲逼近主体' },
      orbit: { label: '环绕运镜 (orbit)', desc: '弧形或360度环绕高潮对峙' },
      bullet_time: { label: '子弹时间 (bullet_time)', desc: '超高速动作凝固环绕' },
      static: { label: '固定机位 (static)', desc: '固定机位，可承载对白、倾听或连续动作' },
    },
  },
  audio_lip_sync_mode: {
    name_zh: '视频音频与口型同步契约',
    category: 'audio',
    description: '根治画外音导致画内演员乱张嘴的口型同步控制',
    required: true,
    enums: {
      in_frame_dialogue: { label: '画内人物说话', desc: '指定角色发音并同步唇形，其余角色双唇紧闭' },
      offscreen_voiceover: { label: '画外音/无线电通话', desc: '画内全员双唇紧闭，严禁张嘴说话，无口型' },
      narration: { label: '客观旁白解说', desc: '画面无声纯画外音，全员双唇紧闭，严禁动嘴' },
      silent_ambient: { label: '纯环境音效/动作', desc: '全员双唇紧闭，专注战术动作' },
      bgm_only: { label: '纯电影配乐分镜', desc: '全员双唇紧闭，专供视频模型原生合成背景音乐' },
    },
  },
  long_take_role: {
    name_zh: '长镜头连续接力角色',
    category: 'continuity',
    description: '长镜头拆解子镜头的时空接力关系',
    required: false,
    enums: {
      head: { label: '长镜头组首 (head)', desc: '组首镜头，必须由文生图根据槽位生成高保真首帧图' },
      continuation: { label: '接力续镜 (continuation)', desc: '自动提取上一镜尾帧作为起始帧，延续动线' },
      tail: { label: '终镜收束 (tail)', desc: '承接上一镜尾帧，完成长镜头动作收束' },
    },
  },
  lighting_style: {
    name_zh: '影视打光风格',
    category: 'lighting',
    description: '场景光影基调与明暗影调反差',
    required: true,
    enums: {
      natural: { label: '自然光 (natural)', desc: '漫反射立体过渡，保留暗部丰富纹理' },
      side: { label: '高反差侧光 (side)', desc: '强烈侧光雕刻面部起伏与锐利明暗交界线' },
      backlit: { label: '轮廓逆光 (backlit)', desc: '发丝与肩膀金边勾勒，暗部弱补光' },
      dramatic: { label: '戏剧光/伦勃朗光 (dramatic)', desc: '经典三角光影调，强光比与深邃阴影' },
      soft: { label: '柔和漫反射 (soft)', desc: '阴影清淡通透，肤质细腻写实' },
      golden_hour: { label: '黄金时刻夕阳 (golden_hour)', desc: '暖金低角度斜射与长投影交织' },
      blue_hour: { label: '幽蓝暮光 (blue_hour)', desc: '环境冷光与面部弱冷光交融' },
      night: { label: '暗夜微光 (night)', desc: '局部点光源，大面积深邃暗场' },
      neon: { label: '双色霓虹反差 (neon)', desc: '蓝粉交错赛博电影感光影反差' },
    },
  },
  depth_of_field: {
    name_zh: '景深光学参数',
    category: 'optics',
    description: '镜头景深与焦外虚化层次',
    required: true,
    enums: {
      extreme_shallow: { label: '极浅景深 (extreme_shallow)', desc: 'f/1.4，极限虚化背景斑斓散景，主体极致锐利' },
      shallow: { label: '浅景深 (shallow)', desc: 'f/2.2，人物主体清晰脱模，背景自然柔和虚化' },
      medium: { label: '中等景深 (medium)', desc: 'f/4.0~5.6，人物与中景环境兼顾' },
      deep: { label: '全景深 (deep)', desc: 'f/11，前后景通透全焦，展现开阔宏大环境' },
    },
  },
};

module.exports = {
  SHOT_TYPES,
  CAMERA_MOVEMENTS,
  CAMERA_ANGLES,
  LIGHTING_STYLES,
  DEPTH_OF_FIELD,
  SPATIAL_POSITIONS,
  FACING_DIRECTIONS,
  DIALOGUE_FRAMING,
  DEPTH_LAYERS,
  HEAD_POSES,
  GAZE_DIRECTIONS,
  POSTURE_TYPES,
  HANDS_ACTIONS,
  AUDIO_LIP_SYNC_MODES,
  DELIVERY_MEDIUMS,
  LONG_TAKE_ROLES,
  CINEMATIC_LENSES,
  AUDIOTISUAL_DATA_DICTIONARY,
  DRAMA_ERAS,
  IDENTITY_VISIBILITIES,
  CONTINUITY_TYPES,
  FIRST_FRAME_POLICIES,
  LAST_FRAME_POLICIES,
  createSemanticSlots,
  createCharacterEntity,
  createSceneSpatialEntity,
  createShotEntity,
  createPropEntity,
  createBeatEntity,
  createCharacterVisualSlot,
  compileImagePromptFromSlots,
  synthesizeCharacterVisualSlots,
};
