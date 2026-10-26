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
  STATIC: 'static',           // 固定机位（严格控制，<15%）
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
  AWAY_FROM_CAMERA: 'away_from_camera',
  SCREEN_LEFT: 'screen_left',
  SCREEN_RIGHT: 'screen_right',
  INTERACTIVE_OPPONENT: 'facing_opponent',
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

// ── 道具本体实体 ──
function createPropEntity({ id, name, type = '日常用品', eraCategory = 'universal', physicalScale = '', description = '', ownerCharacterId = null, prompt = '' }) {
  return {
    entity_type: 'prop',
    id: id != null ? Number(id) : null,
    name: String(name || '').trim(),
    type: String(type || '日常用品').trim(),
    era_category: String(eraCategory || 'universal'), // ancient, modern, sci_fi, universal
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

module.exports = {
  SHOT_TYPES,
  CAMERA_MOVEMENTS,
  CAMERA_ANGLES,
  LIGHTING_STYLES,
  DEPTH_OF_FIELD,
  SPATIAL_POSITIONS,
  FACING_DIRECTIONS,
  DRAMA_ERAS,
  createCharacterEntity,
  createSceneSpatialEntity,
  createShotEntity,
  createPropEntity,
  createBeatEntity,
  createCharacterVisualSlot,
  compileImagePromptFromSlots,
  synthesizeCharacterVisualSlots,
};
