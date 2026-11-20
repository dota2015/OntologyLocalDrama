/**
 * 影视视听本体（Audiovisual Drama Ontology）架构规范
 * 参考 /home/nvidia/ontology-semantic-system 的本体语义建模理念：
 * - 明确对象实体（Entities）、状态属性（Properties）、空间关系（Relations）
 * - 以 actionAtoms 与 visualSlots 的 structured_sync 闭集枚举为唯一权威事实源（Single Source of Truth）
 * - 严禁散装字典与模糊猜测，提供强类型数据契约与规范定义
 */

const actionAtoms = require('./actionAtoms');
const {
  STRUCTURED_DEPTH_LAYERS,
  STRUCTURED_SCREEN_POSITIONS,
  compileImagePromptFromSlots,
  compileLastFramePromptFromSlots,
} = require('./visualSlots');

// ── 景别本体枚举 ──
const SHOT_TYPES = Object.freeze({
  ESTABLISHING: '大远景',
  WIDE: '远景',
  FULL: '全景',
  MEDIUM: '中景',
  CLOSE_UP: '近景',
  EXTREME_CLOSE_UP: '特写',
});

// ── 运镜本体枚举（动态流动优先，少用固定） ──
const CAMERA_MOVEMENTS = Object.freeze({
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
});

// ── 3D 机位三元组枚举 ──
const CAMERA_ANGLES = Object.freeze({
  HORIZONTAL: ['front', 'front_left', 'front_right', 'left', 'right', 'back', 'back_left', 'back_right'],
  ELEVATION: ['eye_level', 'low', 'high', 'top_down', 'worm'],
  SHOT_SCALE: ['establishing', 'wide', 'medium', 'close_up', 'extreme_close_up'],
});

// ── 光影与照明本体枚举 ──
const LIGHTING_STYLES = Object.freeze({
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
});

// ── 景深本体枚举 ──
const DEPTH_OF_FIELD = Object.freeze({
  EXTREME_SHALLOW: 'extreme_shallow',
  SHALLOW: 'shallow',
  MEDIUM: 'medium',
  DEEP: 'deep',
});

// ── 画面纵深层级（严格对齐 visualSlots.STRUCTURED_DEPTH_LAYERS） ──
const DEPTH_LAYERS = Object.freeze({
  FOREGROUND: 'foreground', // 画面前景近处（景深虚化遮挡物、过肩肩颈、近身特写引线）
  MIDGROUND: 'midground',   // 画面中景主体（清晰焦点，主要动作与对白承载区）
  BACKGROUND: 'background', // 画面后景深处（纵深掩护、背景环境、灭点透视）
});

// ── 空间站位与构图锚点（严格对齐 visualSlots.STRUCTURED_SCREEN_POSITIONS 九宫格枚举） ──
const SPATIAL_POSITIONS = Object.freeze({
  LEFT_FOREGROUND: 'left_foreground',
  LEFT_MIDGROUND: 'left_midground',
  LEFT_BACKGROUND: 'left_background',
  CENTER_FOREGROUND: 'center_foreground',
  CENTER_MIDGROUND: 'center_midground',
  CENTER_BACKGROUND: 'center_background',
  RIGHT_FOREGROUND: 'right_foreground',
  RIGHT_MIDGROUND: 'right_midground',
  RIGHT_BACKGROUND: 'right_background',
  // 向后兼容旧版别名（收敛映射至合法的九宫格站位值）
  LEFT_THIRD: 'left_midground',
  CENTER: 'center_midground',
  RIGHT_THIRD: 'right_midground',
  FOREGROUND: 'center_foreground',
  MIDGROUND: 'center_midground',
  BACKGROUND: 'center_background',
});

// ── 角色空间朝向（严格对齐 actionAtoms.FACING） ──
const FACING_DIRECTIONS = Object.freeze({
  FRONT_CAMERA: 'front_camera',
  BACK_CAMERA: 'back_camera',
  LEFT_PROFILE: 'left_profile',
  RIGHT_PROFILE: 'right_profile',
  THREE_QUARTER_LEFT: 'three_quarter_left',
  THREE_QUARTER_RIGHT: 'three_quarter_right',
  TOWARD_CHARACTER: 'toward_character',
  TOWARD_OBJECT: 'toward_object',
  TOWARD_EVENT: 'toward_event',
  AWAY_FROM_CAMERA: 'away_from_camera',
  // 向后兼容旧版别名（统一映射至 actionAtoms.FACING 合法枚举）
  TOWARD_CAMERA: 'front_camera',
  PROFILE_LEFT: 'left_profile',
  PROFILE_RIGHT: 'right_profile',
  THREE_QUARTER_BACK_LEFT: 'back_camera',
  THREE_QUARTER_BACK_RIGHT: 'back_camera',
  SCREEN_LEFT: 'left_profile',
  SCREEN_RIGHT: 'right_profile',
  INTERACTIVE_OPPONENT: 'toward_character',
});

// ── 对话视听构图枚举 ──
const DIALOGUE_FRAMING = Object.freeze({
  TWO_SHOT_FACE_TO_FACE: 'two_shot_face_to_face',         // 双人面对面对视：左右3/4侧身互相对视，视线交汇，严禁直视镜头
  OVER_THE_SHOULDER: 'over_the_shoulder',                 // 经典过肩拍 OTS：前景露出肩背充当引线，后景搭档面部清晰，视线轴贯穿纵深
  SINGLE_REACTION_OFFSCREEN: 'single_reaction_offscreen', // 单人视线看画外：身体微侧30°-45°，目光锁定画外搭档，严禁直视摄影机
  JOINT_OBSERVATION: 'joint_observation',                 // 双人同向观察：两人侧身前倾，共同注视前方目标/屏幕，严禁直视镜头
  SOLO_ACTION: 'solo_action',                             // 单人专注动作：视线锁定手中道具或行动目标，无对话
});

// ── 头部姿态枚举（严格对齐 actionAtoms.HEAD_POSES） ──
const HEAD_POSES = Object.freeze({
  NEUTRAL: 'neutral',                   // 头部正对自然保持
  TURNED_LEFT: 'turned_left',           // 头部转向左侧
  TURNED_RIGHT: 'turned_right',         // 头部转向右侧
  TILTED_UP: 'tilted_up',               // 头部微仰
  TILTED_DOWN: 'tilted_down',           // 头部微俯
  TURNED_TO_TARGET: 'turned_to_target', // 头部转向目标对象
  LOWERED: 'lowered',                   // 低头向下
  RAISED: 'raised',                     // 抬头向上
  RECOILING: 'recoiling',               // 受惊后仰躲避
  // 向后兼容旧版别名（统一映射至 actionAtoms.HEAD_POSES 合法枚举）
  HEAD_FRONT: 'neutral',
  HEAD_TILT_UP: 'tilted_up',
  HEAD_TILT_DOWN: 'tilted_down',
  HEAD_TURN_LEFT: 'turned_left',
  HEAD_TURN_RIGHT: 'turned_right',
  HEAD_LOOK_BACK: 'turned_to_target',
  HEAD_NATURAL_TILT: 'neutral',
});

// ── 目光视线类型枚举（严格对齐 actionAtoms.GAZE_TYPES） ──
const GAZE_DIRECTIONS = Object.freeze({
  CAMERA: 'camera',       // 注视镜头
  CHARACTER: 'character', // 注视角色
  PROP: 'prop',           // 注视道具
  EVENT: 'event',         // 注视事件源
  SCENE: 'scene',         // 观察场景
  OFFSCREEN: 'offscreen', // 望向画外
  GROUND: 'ground',       // 低头看地面
  NONE: 'none',           // 无固定视线
  // 向后兼容旧版别名（统一映射至 actionAtoms.GAZE_TYPES 合法枚举）
  LOCKED_ON_PARTNER: 'character',
  LOCKED_OFFSCREEN: 'offscreen',
  LOCKED_ON_TACTICAL_TARGET: 'event',
  FOCUSED_ON_SCREEN: 'prop',
  FOCUSED_ON_PROP: 'prop',
  SCANNING_ENVIRONMENT: 'scene',
});
const GAZE_TYPES = GAZE_DIRECTIONS;

// ── 躯干重心与体态枚举（严格对齐 actionAtoms.POSTURES） ──
const POSTURE_TYPES = Object.freeze({
  STANDING: 'standing',   // 站立姿态
  SITTING: 'sitting',     // 坐姿
  KNEELING: 'kneeling',   // 单膝或双膝跪姿
  CROUCHING: 'crouching', // 蹲伏低姿
  LYING: 'lying',         // 卧姿
  LEANING: 'leaning',     // 身体倚靠或前倾
  WALKING: 'walking',     // 行进迈步姿态
  RUNNING: 'running',     // 奔跑冲刺姿态
  FALLING: 'falling',     // 失衡倾倒姿态
  SUPPORTED: 'supported', // 被扶持借力姿态
  // 向后兼容旧版别名（统一映射至 actionAtoms.POSTURES 合法枚举）
  STANDING_UPRIGHT: 'standing',
  STANDING_ALERT: 'standing',
  CROUCHING_LOW: 'crouching',
  KNEELING_SINGLE: 'kneeling',
  SITTING_LEANING_FORWARD: 'sitting',
  SITTING_UPRIGHT: 'sitting',
  PRONE_COVER: 'lying',
  STUMBLING_UNBALANCED: 'falling',
  LEAPING_FREEZE: 'running',
  WALL_LEANING: 'leaning',
});
const POSTURES = POSTURE_TYPES;

// ── 四肢与手部状态枚举（严格对齐 actionAtoms.HAND_STATES） ──
const HANDS_ACTIONS = Object.freeze({
  FREE: 'free',                           // 双手自然空置
  HOLDING_OBJECT: 'holding_object',       // 手持物体
  REACHING: 'reaching',                   // 伸手探向目标
  SUPPORTING_TARGET: 'supporting_target', // 伸手搀扶托住目标
  POINTING: 'pointing',                   // 抬手指向目标
  COVERING_MOUTH: 'covering_mouth',       // 抬手掩口
  ON_SURFACE: 'on_surface',               // 手掌按在支撑表面
  CLENCHED: 'clenched',                   // 紧握拳头
  RELAXED: 'relaxed',                     // 双手放松垂落
  // 向后兼容旧版别名（统一映射至 actionAtoms.HAND_STATES 合法枚举）
  HANDS_NATURAL_SIDES: 'relaxed',
  HANDS_FOLDED_CHEST: 'free',
  HOLDING_WEAPON_ALERT: 'holding_object',
  ONE_HAND_ON_EARPIECE: 'holding_object',
  ONE_HAND_ON_DESK: 'on_surface',
  HANDS_ON_KEYBOARD: 'on_surface',
  ONE_HAND_POINTING: 'pointing',
  ONE_HAND_ON_SHOULDER: 'supporting_target',
  ONE_HAND_SUPPORTING_GROUND: 'on_surface',
  FISTS_CLENCHED: 'clenched',
});
const HAND_STATES = HANDS_ACTIONS;

// ── 面部神情枚举（严格对齐 actionAtoms.EXPRESSIONS） ──
const EXPRESSION_TYPES = Object.freeze({
  NEUTRAL: 'neutral',
  FOCUSED: 'focused',
  ALERT: 'alert',
  WORRIED: 'worried',
  ANGRY: 'angry',
  SURPRISED: 'surprised',
  PAIN: 'pain',
  FEAR: 'fear',
  RELIEF: 'relief',
  DETERMINED: 'determined',
  SAD: 'sad',
  CONFUSED: 'confused',
  EXHAUSTED: 'exhausted',
});

// ── 角色口型状态枚举（严格对齐 actionAtoms.MOUTH_STATES） ──
const MOUTH_STATES = Object.freeze({
  CLOSED: 'closed',
  SPEAKER_SYNCED: 'speaker_synced',
  OFFSCREEN_SEALED: 'offscreen_sealed',
});

// ── 音频与口型控制模式 ──
const AUDIO_LIP_SYNC_MODES = Object.freeze({
  IN_FRAME_DIALOGUE: 'in_frame_dialogue',     // 画内人物说话（说话人发音并严格同步唇形动作，画内其余角色双唇紧闭）
  OFFSCREEN_VOICEOVER: 'offscreen_voiceover', // 画外音/画外说话（画内所有人双唇紧闭，严禁动嘴，无任何口型）
  NARRATION: 'narration',                     // 客观旁白解说（画面无声解说，全员双唇紧闭，严禁动嘴）
  SILENT_AMBIENT: 'silent_ambient',           // 纯环境音效（全员双唇紧闭，严禁动嘴，专注动作）
  BGM_ONLY: 'bgm_only',                       // 纯电影配乐分镜（全员双唇紧闭，专供视频模型原生合成高质量背景音乐）
});

// ── 声音传导介质枚举 ──
const DELIVERY_MEDIUMS = Object.freeze({
  DIRECT_SPEECH: 'direct_speech', // 现场面对面原声发音
  RADIO_HEADSET: 'radio_headset', // 无线电/通讯耳机
  PHONE_CALL: 'phone_call',       // 手机/电话通讯
  INTERCOM: 'intercom',           // 车载/广播对讲机
  VOICEOVER: 'voiceover',         // 画外音/内心独白/回忆
  NARRATION: 'narration',         // 第三人称客观旁白解说
});

// ── 画外参与方式枚举 ──
const OFFSCREEN_PARTICIPATION_MODES = Object.freeze({
  PRESENT_OFFSCREEN: 'present_offscreen', // 人在现场空间内、镜头外：可成为视线目标、可发出画外声响、参与空间连续性
  REMOTE_VOICE: 'remote_voice',           // 人不在现场，经通讯设备连接：只产生声音/对话关系，不参与本场空间连续性
});

// ── 长镜头接力角色枚举 ──
const LONG_TAKE_ROLES = Object.freeze({
  HEAD: 'head',                 // 长镜头组首（必须由文生图根据槽位生成高保真首帧图）
  CONTINUATION: 'continuation', // 接力续镜（自动提取上一镜视频尾帧作为起始帧，延续动线与运镜）
  TAIL: 'tail',                 // 终镜收尾（承接上一镜尾帧，完成长镜头动作收束）
});

// ── 电影镜头光学参数枚举 ──
const CINEMATIC_LENSES = Object.freeze({
  ANAMORPHIC_35MM: 'anamorphic_35mm', // 35mm宽银幕变形镜头（经典椭圆散景与宽阔水平视场）
  PRIME_50MM: 'prime_50mm',           // 50mm电影大师标准定焦镜头（逼真透视比例，人眼自然视角）
  PORTRAIT_85MM: 'portrait_85mm',     // 85mm人像长焦定焦镜头（极浅景深，五官立体无畸变）
  WIDE_24MM: 'wide_24mm',             // 24mm电影广角镜头（开阔场景纵深，宏阔视觉冲击）
});

// ── 显式短剧本体元模型（Object Types, Properties, Relations） ──
const SHORT_DRAMA_ONTOLOGY_META_MODEL = Object.freeze({
  version: '2.0.0',
  domain: 'short_drama',
  description: '短剧领域语义本体元模型：基于人设反差、恩怨关系与爽点节拍的有向语义图',
  object_types: Object.freeze({
    EpisodeArc: {
      id: 'EpisodeArc',
      name_zh: '单集叙事弧',
      description: '短剧单集叙事结构骨架，管控黄金3秒钩子、核心矛盾与集末断章卡点',
      properties: {
        hook_type: { type: 'string', default: null },
        core_conflict: { type: 'string', required: true },
        cliffhanger_type: { type: 'enum', enums: ['resolved', 'open_question', 'identity_reveal_cut', 'danger_imminent', 'betrayal_shock', 'slap_pending'], required: true },
        pacing_tempo: { type: 'string', default: 'fast_paced' },
      },
    },
    NarrativeBeat: {
      id: 'NarrativeBeat',
      name_zh: '短剧剧情节拍',
      description: '短剧叙事张力与情绪推进单元，直接驱动分镜机位构图与音画重音',
      properties: {
        beat_number: { type: 'number', required: true },
        beat_type: { type: 'enum', enums: ['decision', 'discovery', 'consequence', 'relationship_change', 'hook', 'suppression', 'reveal', 'slap_reversal', 'crowd_reaction', 'cliffhanger', 'transition'], required: true },
        tension_level: { type: 'number', min: 1, max: 5, default: 1 },
        dominant_emotion: { type: 'string', default: '' },
        power_shift: { type: 'enum', enums: ['aggressor_dominant', 'protagonist_counter', 'power_reversed', 'stalemate'], default: null },
        pre_conditions: { type: 'array', default: [] },
        post_conditions: { type: 'array', default: [] },
      },
    },
    Character: {
      id: 'Character',
      name_zh: '短剧人设实体',
      description: '具备表里双层身份与权力位阶的短剧行动主体',
      properties: {
        id: { type: 'number', required: true },
        name: { type: 'string', required: true },
        gender: { type: 'string', default: '女' },
        role: { type: 'string', default: '主演' },
        archetype: { type: 'string', default: null },
        surface_identity: { type: 'string', default: '' },
        hidden_identity: { type: 'string', default: '' },
        power_status: { type: 'enum', enums: ['dominant', 'suppressed', 'awakened', 'bystander'], default: null },
        appearance: { type: 'string', default: '' },
        identity_anchors: { type: 'array', default: [] },
        wardrobe_stage_id: { type: 'number', default: null },
        voice: { type: 'object', default: null },
      },
    },
    WardrobeStage: {
      id: 'WardrobeStage',
      name_zh: '造型与变装阶段',
      description: '角色在不同身份状态下的视觉外观阶段（如落魄伪装 vs 盛装觉醒）',
      properties: {
        id: { type: 'number', required: true },
        character_id: { type: 'number', required: true },
        stage_type: { type: 'enum', enums: ['disguise_humble', 'normal', 'injured_humiliated', 'awakened_noble'], required: true },
        stage_name: { type: 'string', default: '' },
        description: { type: 'string', default: '' },
        reference_image: { type: 'string', default: '' },
      },
    },
    Prop: {
      id: 'Prop',
      name_zh: '短剧道具与信物',
      description: '推动剧情反转与身份掉马的核心信物、证据或环境物件',
      properties: {
        id: { type: 'number', required: true },
        name: { type: 'string', required: true },
        prop_role: { type: 'enum', enums: ['key_token', 'slap_evidence', 'conflict_tool', 'ambient'], default: 'ambient' },
        close_up_required: { type: 'boolean', default: false },
        physical_scale: { type: 'string', default: '' },
        era_category: { type: 'string', default: 'universal' },
        era_compatibility: { type: 'string', default: 'compatible' },
        era_reason: { type: 'string', default: '' },
        owner_character_id: { type: 'number', default: null },
      },
    },
    SceneZone: {
      id: 'SceneZone',
      name_zh: '短剧空间与权力轴',
      description: '具备权力位阶与戏剧冲突轴线的短剧空间环境',
      properties: {
        id: { type: 'number', required: true },
        location: { type: 'string', required: true },
        time: { type: 'string', default: '日景' },
        spatial_type: { type: 'string', default: 'interior' },
        power_axis: { type: 'enum', enums: ['high_seat_vs_floor', 'entrance_intrusion', 'center_stage_vs_crowd', 'corridor_ambush'], default: null },
        landmarks: { type: 'array', default: [] },
        lighting_env: { type: 'string', default: 'natural' },
        acoustics: { type: 'string', default: '' },
      },
    },
    Shot: {
      id: 'Shot',
      name_zh: '短剧分镜单元',
      description: '9:16竖屏短剧视听镜头，由爽点节拍确定性投影生成',
      properties: {
        shot_number: { type: 'number', required: true },
        beat_id: { type: 'number', default: null },
        duration: { type: 'number', default: 3 },
        shot_type: { type: 'string', default: '中景' },
        dialogue_framing: { type: 'string', default: 'single_reaction_offscreen' },
        movement: { type: 'string', default: 'push' },
        utterance: { type: 'string', default: '' },
        sfx_sting: { type: 'enum', enums: ['slap_crack', 'bass_drop_silence', 'gasp_sting', 'blade_unsheathe', 'heartbeat_thud', 'door_kick_boom'], default: null },
      },
    },
  }),
  relation_types: Object.freeze({
    REL_CHARACTER_SOCIAL: {
      id: 'REL_CHARACTER_SOCIAL',
      source: 'Character',
      target: 'Character',
      cardinality: 'M:N',
      description: '角色间的人际恩怨、压迫与从属有向关系边',
      allowed_kinds: ['humiliates', 'protects', 'subordinate_to', 'family_oppresses', 'enemy_of', 'ally_of', 'reveals_identity_to'],
    },
    REL_CHARACTER_OWNS_PROP: {
      id: 'REL_CHARACTER_OWNS_PROP',
      source: 'Character',
      target: 'Prop',
      cardinality: '1:N',
      description: '角色持有的核心信物或随身道具归属关系',
    },
    REL_CHARACTER_WEARS_STAGE: {
      id: 'REL_CHARACTER_WEARS_STAGE',
      source: 'Character',
      target: 'WardrobeStage',
      cardinality: '1:N',
      description: '角色的外观造型阶段绑定关系',
    },
    REL_BEAT_PARTICIPANT: {
      id: 'REL_BEAT_PARTICIPANT',
      source: 'NarrativeBeat',
      target: 'Character',
      cardinality: '1:N',
      description: '角色在爽点节拍中承担的戏剧功能（施压方/反转方/吃瓜围观方）',
      allowed_roles: ['aggressor', 'protagonist', 'supporter', 'bystander'],
    },
    REL_BEAT_REVEALS_PROP: {
      id: 'REL_BEAT_REVEALS_PROP',
      source: 'NarrativeBeat',
      target: 'Prop',
      cardinality: '1:N',
      description: '爽点节拍中引爆身份反转的关键信物或打脸证据',
    },
    REL_SHOT_REALIZES_BEAT: {
      id: 'REL_SHOT_REALIZES_BEAT',
      source: 'Shot',
      target: 'NarrativeBeat',
      cardinality: 'N:1',
      description: '分镜所承载和实现的短剧剧情节拍',
    },
    REL_SHOT_IN_SCENE_ZONE: {
      id: 'REL_SHOT_IN_SCENE_ZONE',
      source: 'Shot',
      target: 'SceneZone',
      cardinality: 'N:1',
      description: '分镜拍摄依托的空间区域与权力轴',
    },
    REL_SHOT_CONTINUES_FROM: {
      id: 'REL_SHOT_CONTINUES_FROM',
      source: 'Shot',
      target: 'Shot',
      cardinality: '1:1',
      description: '相邻分镜之间的蒙太奇剪辑逻辑与时空因果',
    },
  }),
});

function createRelationEdge({ type, fromType, fromId, toType, toId, properties = {} }) {
  if (!type || fromId == null || toId == null) {
    throw new Error('createRelationEdge requires type, fromId, and toId');
  }
  return {
    type: String(type),
    from_type: String(fromType || ''),
    from_id: Number(fromId),
    to_type: String(toType || ''),
    to_id: Number(toId),
    properties: { ...properties },
  };
}

// ── 实体工厂函数：构造符合本体契约的对象 ──

function createCharacterEntity({
  id,
  name,
  gender = 'unknown',
  role = '',
  appearance = '',
  wardrobeStageId = null,
  state = 'normal',
  voice = null,
  identityAnchors = null,
  archetype = null,
  surfaceIdentity = '',
  hiddenIdentity = '',
  powerStatus = null,
}) {
  return {
    entity_type: 'character',
    id: Number(id),
    name: String(name || '').trim(),
    gender: String(gender),
    role: String(role),
    archetype: archetype || null,
    surface_identity: String(surfaceIdentity || '').trim(),
    hidden_identity: String(hiddenIdentity || '').trim(),
    power_status: powerStatus || null,
    appearance: String(appearance || '').trim(),
    wardrobe_stage_id: wardrobeStageId != null ? Number(wardrobeStageId) : null,
    physical_state: state, // normal, injured, fallen, exhausted, alert
    voice: voice ? { ...voice } : null,
    identity_anchors: identityAnchors && typeof identityAnchors === 'object' ? { ...identityAnchors } : (Array.isArray(identityAnchors) ? identityAnchors : null),
  };
}

function createSceneSpatialEntity({ id, location, time, spatialType = 'interior', lightingEnv = 'natural', landmarks = [], acoustics = '', powerAxis = null }) {
  return {
    entity_type: 'scene_spatial',
    id: Number(id),
    location: String(location || '').trim(),
    time: String(time || '').trim(),
    spatial_type: spatialType, // interior_tight, interior_open, exterior_open
    power_axis: powerAxis || null,
    lighting_env: lightingEnv,
    landmarks: Array.isArray(landmarks) ? landmarks : [], // e.g. ['doorway', 'desk', 'window']
    acoustics: String(acoustics),
  };
}

function createShotEntity(data = {}) {
  return {
    entity_type: 'shot',
    shot_number: Number(data.shot_number || 1),
    beat_id: data.beat_id != null ? Number(data.beat_id) : null,
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
    utterance: String(data.utterance || data.dialogue || '').trim(),
    sfx_sting: data.sfx_sting || null,
    bgm_prompt: String(data.bgm_prompt || '').trim(),
    sound_effect: String(data.sound_effect || '').trim(),
    emotion: String(data.emotion || '').trim(),
    layout_description: String(data.layout_description || '').trim(),
    character_ids: Array.isArray(data.character_ids) ? data.character_ids.map(Number) : [],
    prop_ids: Array.isArray(data.prop_ids) ? data.prop_ids.map(Number) : [],
  };
}

// ── 时代世界观枚举 ──
const DRAMA_ERAS = Object.freeze({
  ANCIENT: 'ancient',               // 古装/古风/仙侠/武侠
  REPUBLIC_CHINA: 'republic_china', // 民国/近代
  MODERN: 'modern',                 // 现代/都市/现实主义
  SCI_FI: 'sci_fi',                 // 科幻/赛博朋克/星际
  FANTASY: 'fantasy',               // 奇幻/魔幻
});

// ── 角色主体面部识别度枚举 ──
const IDENTITY_VISIBILITIES = Object.freeze({
  CLEAR_FRONTAL: 'clear_frontal', // 清晰正脸识别（核心对白特写与主要情绪呈现）
  THREE_QUARTER: 'three_quarter', // 侧脸3/4微侧（标准电影构图，立体五官雕刻）
  PROFILE: 'profile',             // 正侧剪影（对峙凝视或远眺）
  BACK_VIEW: 'back_view',         // 背影定格（过肩前景或离开背身）
  SILHOUETTE: 'silhouette',       // 逆光剪影（氛围意境与神秘感）
  OCCLUDED: 'occluded',           // 遮挡/虚化（前景障碍物半遮）
});

// ── 镜头连戏接续类型枚举 ──
const CONTINUITY_TYPES = Object.freeze({
  MATCH_CUT: 'match_cut',                         // 动作匹配切（承接上一镜动作动势）
  EYELINE_MATCH: 'eyeline_match',                 // 视线匹配（正反打目光交汇）
  OTS_REVERSE: 'ots_reverse',                     // 过肩反打（正反双人对话交替）
  HARD_CUT: 'hard_cut',                           // 场景硬切（转场或时间推进）
  CONTINUATION: 'continuation',                   // 同场景连戏续镜（动作连贯延伸）
  LONG_TAKE_CONTINUATION: 'long_take_continuation', // 长镜头接力续镜（承接尾帧）
});

// ── 首帧生成策略枚举 ──
const FIRST_FRAME_POLICIES = Object.freeze({
  NONE: 'none',                 // Ref2VA 仅使用多参考素材，不生成首帧引导
  GENERATE_NEW: 'generate_new', // 独立全新文生图生成首帧
  INHERIT_TAIL: 'inherit_tail', // 继承前序分镜视频尾帧为本镜首帧
  LAYOUT_LOCK: 'layout_lock',   // 首帧空间构图锁保持
});

// ── 尾帧生成策略枚举 ──
const LAST_FRAME_POLICIES = Object.freeze({
  GENERATE_TAIL: 'generate_tail', // 规划并生成指定尾帧（首尾帧双向引导）
  NONE: 'none',                   // 无尾帧（单首帧驱动或纯Ref2VA）
});

/**
 * 构造标准 12 项影视分镜语义槽位对象
 */
function createSemanticSlots(data = {}) {
  const visible = Array.isArray(data.visible_characters) ? data.visible_characters : (Array.isArray(data.characters) ? data.characters : []);
  const background = Array.isArray(data.background_characters) ? data.background_characters : [];
  const offscreen = Array.isArray(data.offscreen_characters) ? data.offscreen_characters : [];
  const refs = Array.isArray(data.required_references) ? data.required_references : [];

  return {
    visible_characters: visible.map(c => typeof c === 'object' ? c : { name: String(c) }),
    background_characters: background.map(c => typeof c === 'object' ? c : { name: String(c) }),
    offscreen_characters: offscreen.map(c => {
      const entry = typeof c === 'object' && c !== null ? c : { name: String(c) };
      const mode = entry.mode != null ? String(entry.mode).trim() : '';
      return {
        character_id: entry.character_id != null ? entry.character_id : (entry.id != null ? entry.id : null),
        id: entry.id != null ? entry.id : (entry.character_id != null ? entry.character_id : null),
        name: entry.name || '',
        mode,
      };
    }),
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
    beat_type: data.beat_type || null,
    beat_id: data.beat_id || null,
  };
}

// ── 道具本体实体 ──
function createPropEntity({
  id,
  name,
  type = '日常用品',
  propRole = 'ambient',
  closeUpRequired = null,
  eraCategory = 'universal',
  eraCompatibility = 'compatible',
  eraReason = '',
  physicalScale = '',
  description = '',
  ownerCharacterId = null,
  prompt = '',
}) {
  const role = String(propRole || (type === '打脸信物' || type === '核心信物' ? 'key_token' : 'ambient'));
  const needsCloseUp = closeUpRequired !== null ? !!closeUpRequired : (role === 'key_token' || role === 'slap_evidence');
  return {
    entity_type: 'prop',
    id: id != null ? Number(id) : null,
    name: String(name || '').trim(),
    type: String(type || '日常用品').trim(),
    prop_role: role,
    close_up_required: needsCloseUp,
    era_category: String(eraCategory || 'universal'),
    era_compatibility: String(eraCompatibility || 'compatible'),
    era_reason: String(eraReason || '').trim(),
    physical_scale: String(physicalScale || '').trim(),
    description: String(description || '').trim(),
    owner_character_id: ownerCharacterId != null ? Number(ownerCharacterId) : null,
    image_prompt: String(prompt || '').trim(),
  };
}

// ── 剧本叙事节拍本体实体 ──
function createBeatEntity({
  beatNumber,
  title = '',
  beatType = 'hook',
  tensionLevel = 1,
  dominantEmotion = '',
  powerShift = null,
  eventSummary = '',
  preConditions = [],
  postConditions = [],
  sceneId = null,
  characterIds = [],
  propIds = [],
  actors = [],
  revealedPropId = null,
}) {
  return {
    entity_type: 'narrative_beat',
    beat_number: Number(beatNumber || 1),
    title: String(title || '').trim(),
    beat_type: String(beatType || 'hook'),
    tension_level: Math.max(1, Math.min(5, Number(tensionLevel) || 1)),
    dominant_emotion: String(dominantEmotion || '').trim(),
    power_shift: powerShift || null,
    event_summary: String(eventSummary || '').trim(),
    pre_conditions: Array.isArray(preConditions) ? preConditions : [],
    post_conditions: Array.isArray(postConditions) ? postConditions : [],
    scene_id: sceneId != null ? Number(sceneId) : null,
    character_ids: Array.isArray(characterIds) ? characterIds.map(Number) : [],
    prop_ids: Array.isArray(propIds) ? propIds.map(Number) : [],
    actors: Array.isArray(actors) ? actors : [],
    revealed_prop_id: revealedPropId != null ? Number(revealedPropId) : null,
  };
}

// ── 共享枚举字典项定义（与 actionAtoms / visualSlots 严格 1:1 绑定） ──
const GAZE_ENUM_MAP = Object.freeze({
  camera: { label: '注视镜头 (camera)', desc: '直视摄影机镜头（仅用于特殊主观镜头或独白）' },
  character: { label: '注视角色 (character)', desc: '眼神锁定戏中搭档或目标人物，建立视线交流轴' },
  prop: { label: '注视道具 (prop)', desc: '目光聚焦于手中或场景中的关键道具、屏幕或文书' },
  event: { label: '注视事件源 (event)', desc: '目光锁定突发声响、光影变化或动作事件发生点' },
  scene: { label: '观察场景 (scene)', desc: '审视周围空间环境、通道入口或空间地标' },
  offscreen: { label: '望向画外 (offscreen)', desc: '眼神自然避开镜头，凝视画外说话人或画外动静' },
  ground: { label: '低头看地面 (ground)', desc: '视线垂向地面，表现沉思、隐忍或寻找地面线索' },
  none: { label: '无固定视线 (none)', desc: '背对镜头、闭目或视线不可见' },
});

const HANDS_ENUM_MAP = Object.freeze({
  free: { label: '双手自然空置 (free)', desc: '双手无持物，自然垂放或处于准备状态' },
  holding_object: { label: '手持物体 (holding_object)', desc: '单手或双手持握道具、器物或装备' },
  reaching: { label: '伸手探向目标 (reaching)', desc: '手臂前伸探向目标人物或物体' },
  supporting_target: { label: '伸手搀扶托住目标 (supporting_target)', desc: '手掌或手臂扶住、托起目标人物' },
  pointing: { label: '抬手指向目标 (pointing)', desc: '手臂抬起明确指向特定方向、人物或地标' },
  covering_mouth: { label: '抬手掩口 (covering_mouth)', desc: '手掌掩住口鼻，表现震惊、咳嗽或克制情绪' },
  on_surface: { label: '手掌按在支撑表面 (on_surface)', desc: '手掌撑在桌面、床沿、墙面或地面等物理表面' },
  clenched: { label: '紧握拳头 (clenched)', desc: '手指攥紧成拳，表现愤怒、决绝或紧绷状态' },
  relaxed: { label: '双手放松垂落 (relaxed)', desc: '双手自然放松垂于身侧或膝上' },
});

// ── 影视视听本体统一数据字典 (Audiovisual Slot Data Dictionary) ──
// 结构化执行字段（depth_layer, screen_position, facing, head_pose, gaze_type, posture, hands_state, expression, mouth_state）
// 严格对齐 actionAtoms.js 与 visualSlots.js 闭集枚举；dialogue_framing 保持开放式构图支持。
const AUDIOVISUAL_DATA_DICTIONARY = {
  _meta: {
    performance_contract: actionAtoms.PERFORMANCE_CONTRACT,
    is_strict_whitelist: true,
    reference_only: false,
    open_ended: false,
    description: '影视视听本体数据字典：结构化角色定格与动作轨迹字段严格对齐 actionAtoms 与 visualSlots 闭集枚举；dialogue_framing 等构图描述支持结合剧情做开放式扩充。',
  },
  dialogue_framing: {
    name_zh: '对话视听构图',
    category: 'composition',
    open_ended: true,
    reference_only: true,
    description: '对话场景机位与视线交互参考（支持枚举或结合剧情的开放式构图描述），建议形成视线闭环、避免面对镜头自言自语',
    required: false,
    enums: {
      two_shot_face_to_face: { label: '双人面对面对视（参考）', desc: '两人左右站位，微转3/4侧身互相对视，眼神交汇，严禁直视镜头' },
      over_the_shoulder: { label: '经典过肩拍 OTS（参考）', desc: '前景人物露出肩背作为视觉引线，后景搭档面部清晰，视线轴贯穿纵深' },
      single_reaction_offscreen: { label: '单人视线看画外（参考）', desc: '单人近景/特写，身体与头部微转30°-45°，眼神专注锁定画外搭档' },
      joint_observation: { label: '双人同向观察（参考）', desc: '两人侧身前倾，共同注视前方目标或屏幕，严禁直视镜头' },
      solo_action: { label: '单人动作无对话（参考）', desc: '专注手中道具操作或周围环境探索' },
    },
  },
  depth_layer: {
    name_zh: '画面纵深层级',
    category: 'spatial_depth',
    open_ended: false,
    description: '三维Z轴空间纵深分层（严格对齐 visualSlots.STRUCTURED_DEPTH_LAYERS）',
    required: true,
    enums: {
      foreground: { label: '画面前景近处 (foreground)', desc: '景深虚化遮挡物、过肩肩颈、近身特写引线' },
      midground: { label: '画面中景主体 (midground)', desc: '清晰焦点，主要动作与对白承载区' },
      background: { label: '画面后景深处 (background)', desc: '纵深环境、远景人物或空间灭点透视' },
    },
  },
  screen_position: {
    name_zh: '画面九宫格站位',
    category: 'spatial_depth',
    open_ended: false,
    description: '角色在画面水平（左/中/右）与纵深（前/中/后）的九宫格精确锚点（多人同框严禁重叠）',
    required: true,
    enums: {
      left_foreground: { label: '画面左侧前景 (left_foreground)', desc: '左侧近景/前景引线位置' },
      left_midground: { label: '画面左侧中景 (left_midground)', desc: '左侧中景主构图位' },
      left_background: { label: '画面左侧后景 (left_background)', desc: '左侧远端纵深位置' },
      center_foreground: { label: '画面中央前景 (center_foreground)', desc: '中央近景焦点位置' },
      center_midground: { label: '画面中央中景 (center_midground)', desc: '中央中景核心站位' },
      center_background: { label: '画面中央后景 (center_background)', desc: '中央远端纵深位置' },
      right_foreground: { label: '画面右侧前景 (right_foreground)', desc: '右侧近景/前景引线位置' },
      right_midground: { label: '画面右侧中景 (right_midground)', desc: '右侧中景主构图位' },
      right_background: { label: '画面右侧后景 (right_background)', desc: '右侧远端纵深位置' },
    },
  },
  facing: {
    name_zh: '人物空间朝向',
    category: 'character_pose',
    open_ended: false,
    description: '人物躯干在摄影机坐标系中的三维朝向（严格对齐 actionAtoms.FACING）',
    required: true,
    enums: {
      front_camera: { label: '正面朝向镜头 (front_camera)', desc: '躯干正对摄影机方向' },
      back_camera: { label: '背向镜头 (back_camera)', desc: '露出肩背，用于过肩前景或背影构图' },
      left_profile: { label: '正侧面朝向画面左侧 (left_profile)', desc: '90度正侧面向左' },
      right_profile: { label: '正侧面朝向画面右侧 (right_profile)', desc: '90度正侧面向右' },
      three_quarter_left: { label: '四分之三侧身面朝左 (three_quarter_left)', desc: '身体微转向左，面向左侧搭档或目标' },
      three_quarter_right: { label: '四分之三侧身面朝右 (three_quarter_right)', desc: '身体微转向右，面向右侧搭档或目标' },
      toward_character: { label: '身体转向目标角色 (toward_character)', desc: '躯干朝向互动角色，配合 facing_target_id 使用' },
      toward_object: { label: '身体转向目标物体 (toward_object)', desc: '躯干朝向操作或观察的道具物体' },
      toward_event: { label: '身体转向事件源 (toward_event)', desc: '躯干朝向突发事件或环境动静方向' },
      away_from_camera: { label: '背离镜头方向 (away_from_camera)', desc: '背对镜头远去或面朝空间深处' },
    },
  },
  head_pose: {
    name_zh: '头部姿态',
    category: 'character_pose',
    open_ended: false,
    description: '头部相对躯干的俯仰与转向姿势（严格对齐 actionAtoms.HEAD_POSES）',
    required: true,
    enums: {
      neutral: { label: '头部正对自然保持 (neutral)', desc: '头部与躯干朝向一致，自然平视' },
      turned_left: { label: '头部转向左侧 (turned_left)', desc: '侧头偏向画面左侧' },
      turned_right: { label: '头部转向右侧 (turned_right)', desc: '侧头偏向画面右侧' },
      tilted_up: { label: '头部微仰 (tilted_up)', desc: '微仰观察高处或表现思索、骄傲' },
      tilted_down: { label: '头部微俯 (tilted_down)', desc: '微俯审视桌面、地面或表现克制' },
      turned_to_target: { label: '头部转向目标对象 (turned_to_target)', desc: '转头面向说话人、互动对象或事件源' },
      lowered: { label: '低头向下 (lowered)', desc: '垂首低头，表现隐忍、疲惫或专注查看' },
      raised: { label: '抬头向上 (raised)', desc: '猛然或专注抬头望向高处' },
      recoiling: { label: '受惊后仰躲避 (recoiling)', desc: '受冲击或惊吓时头部后仰闪避' },
    },
  },
  gaze_type: {
    name_zh: '目光视线落点类型',
    category: 'character_pose',
    open_ended: false,
    description: '双眼视线聚焦目标类型（严格对齐 actionAtoms.GAZE_TYPES）',
    required: true,
    enums: GAZE_ENUM_MAP,
  },
  // 向后兼容旧版属性名 gaze
  gaze: {
    name_zh: '目光视线落点',
    category: 'character_pose',
    open_ended: false,
    description: '双眼视线聚焦点，建立画内视线轴与注意力（严格对齐 actionAtoms.GAZE_TYPES）',
    required: true,
    enums: GAZE_ENUM_MAP,
  },
  posture: {
    name_zh: '躯干体态与重心',
    category: 'character_pose',
    open_ended: false,
    description: '角色躯干体态与重心状态（严格对齐 actionAtoms.POSTURES）',
    required: true,
    enums: {
      standing: { label: '站立姿态 (standing)', desc: '身姿站立，重心稳固' },
      sitting: { label: '坐姿 (sitting)', desc: '坐于椅、榻、床沿或地面' },
      kneeling: { label: '单膝或双膝跪姿 (kneeling)', desc: '单膝或双膝跪地保持低位或行礼' },
      crouching: { label: '蹲伏低姿 (crouching)', desc: '半蹲或低伏压低身体重心' },
      lying: { label: '卧姿 (lying)', desc: '平躺、侧卧或伏地状态' },
      leaning: { label: '身体倚靠或前倾 (leaning)', desc: '身体前倾贴近案台或侧身倚靠墙柱' },
      walking: { label: '行进迈步姿态 (walking)', desc: '迈步走动中的动态定格' },
      running: { label: '奔跑冲刺姿态 (running)', desc: '快速奔跑或急行中的动态定格' },
      falling: { label: '失衡倾倒姿态 (falling)', desc: '身体失衡跌倒或倾倒瞬间' },
      supported: { label: '被扶持借力姿态 (supported)', desc: '由他人搀扶或借力支撑身体' },
    },
  },
  hands_state: {
    name_zh: '四肢与手部状态',
    category: 'character_pose',
    open_ended: false,
    description: '手指与双手的具体物理接触与定格状态（严格对齐 actionAtoms.HAND_STATES）',
    required: true,
    enums: HANDS_ENUM_MAP,
  },
  // 向后兼容旧版属性名 hands
  hands: {
    name_zh: '四肢与手部动作',
    category: 'character_pose',
    open_ended: false,
    description: '手指与双手的具体物理接触与定格姿势（严格对齐 actionAtoms.HAND_STATES）',
    required: true,
    enums: HANDS_ENUM_MAP,
  },
  expression: {
    name_zh: '面部神情状态',
    category: 'character_pose',
    open_ended: false,
    description: '角色面部核心情绪枚举（严格对齐 actionAtoms.EXPRESSIONS）',
    required: true,
    enums: {
      neutral: { label: '神情平静 (neutral)', desc: '克制平稳，无明显情绪外露' },
      focused: { label: '神情专注 (focused)', desc: '目光凝聚，全神贯注' },
      alert: { label: '神情警惕锐利 (alert)', desc: '高度戒备，眼神敏锐' },
      worried: { label: '神情忧虑紧绷 (worried)', desc: '眉头微蹙，担忧挂念' },
      angry: { label: '神情愤怒紧绷 (angry)', desc: '怒目紧绷，情绪激昂' },
      surprised: { label: '神情震惊 (surprised)', desc: '瞳孔微张，意外错愕' },
      pain: { label: '神情痛苦隐忍 (pain)', desc: '咬牙隐忍或伤痛不适' },
      fear: { label: '神情惊恐 (fear)', desc: '惧怕紧张，呼吸急促' },
      relief: { label: '神情松一口气 (relief)', desc: '紧绷感消退，释然宽慰' },
      determined: { label: '神情坚定决绝 (determined)', desc: '目光坚毅，毫不退缩' },
      sad: { label: '神情悲伤低落 (sad)', desc: '哀伤黯然，情绪低垂' },
      confused: { label: '神情困惑迟疑 (confused)', desc: '疑惑不解，犹豫审视' },
      exhausted: { label: '神情疲惫虚弱 (exhausted)', desc: '体力透支，倦怠虚弱' },
    },
  },
  mouth_state: {
    name_zh: '角色口型状态',
    category: 'audio',
    open_ended: false,
    description: '角色唇部开合状态闭集枚举（严格对齐 actionAtoms.MOUTH_STATES）',
    required: true,
    enums: {
      closed: { label: '双唇闭合 (closed)', desc: '非说话人或无对白时双唇自然闭合，无说话口型' },
      speaker_synced: { label: '说话口型同步 (speaker_synced)', desc: '画内说话人发音并与台词严格同步口型' },
      offscreen_sealed: { label: '画外音/背影闭口 (offscreen_sealed)', desc: '画外音、旁白或背影时画内角色严禁张嘴' },
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
      silent_ambient: { label: '纯环境音效/动作', desc: '全员双唇紧闭，专注肢体动作' },
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

// 保留旧版拼写别名 AUDIOTISUAL_DATA_DICTIONARY 兼容既有路由与测试引用
const AUDIOTISUAL_DATA_DICTIONARY = AUDIOVISUAL_DATA_DICTIONARY;

module.exports = {
  SHOT_TYPES,
  CAMERA_MOVEMENTS,
  CAMERA_ANGLES,
  LIGHTING_STYLES,
  DEPTH_OF_FIELD,
  SPATIAL_POSITIONS,
  STRUCTURED_DEPTH_LAYERS,
  STRUCTURED_SCREEN_POSITIONS,
  FACING_DIRECTIONS,
  DIALOGUE_FRAMING,
  DEPTH_LAYERS,
  HEAD_POSES,
  GAZE_DIRECTIONS,
  GAZE_TYPES,
  POSTURE_TYPES,
  POSTURES,
  HANDS_ACTIONS,
  HAND_STATES,
  EXPRESSION_TYPES,
  EXPRESSIONS: actionAtoms.EXPRESSIONS,
  MOUTH_STATES,
  ACTIONS: actionAtoms.ACTIONS,
  STATES: actionAtoms.STATES,
  AUDIO_LIP_SYNC_MODES,
  DELIVERY_MEDIUMS,
  OFFSCREEN_PARTICIPATION_MODES,
  LONG_TAKE_ROLES,
  CINEMATIC_LENSES,
  AUDIOVISUAL_DATA_DICTIONARY,
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
  SHORT_DRAMA_ONTOLOGY_META_MODEL,
  createRelationEdge,
  compileImagePromptFromSlots,
  compileLastFramePromptFromSlots,
};