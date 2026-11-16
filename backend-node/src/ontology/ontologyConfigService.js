/**
 * 短剧本体配置管理服务 (Short Drama Ontology Configuration Service)
 * 遵循标准短剧本体工程模型：
 * 1. 对象类型 (Object Types / Entities)
 * 2. 属性定义 (Properties / Attributes) 包含系统标准属性与自定义扩展属性
 * 3. 关系拓扑 (Relations / Link Types) 包含实体间连接关系与基数约束
 * 4. 门禁规则与物理阈值 (Invariants / Rule Configs & Thresholds)
 *
 * 持久化存储于 SQLite global_settings (key = 'ontology_config')
 */

const { SHOT_TYPES, CAMERA_MOVEMENTS, CAMERA_ANGLES, LIGHTING_STYLES, DEPTH_OF_FIELD, SPATIAL_POSITIONS, FACING_DIRECTIONS, DIALOGUE_FRAMING, DEPTH_LAYERS, HEAD_POSES, GAZE_DIRECTIONS, POSTURE_TYPES, HANDS_ACTIONS, DRAMA_ERAS, IDENTITY_VISIBILITIES, CONTINUITY_TYPES, FIRST_FRAME_POLICIES, LAST_FRAME_POLICIES } = require('./schema');
const { ACTIONS, BODY_PARTS, TARGET_TYPES, DIRECTIONS, CONTACTS, STATES } = require('./actionAtoms');

const CONFIG_KEY = 'ontology_config';

/**
 * 短剧本体默认标准规范 (Default Short Drama Ontology Specification)
 */
function getDefaultOntologyConfig() {
  return {
    version: '1.0.0',
    description: '短剧视听本体建模规范与约束参数体系（专为快节奏短剧分镜、人物防脸崩与因果动作设计）',
    updated_at: new Date().toISOString(),

    // ── 1. 对象类型与属性定义 (Object Types & Properties) ──
    object_types: [
      {
        id: 'shot',
        name_zh: '分镜 / 镜头',
        description: '短剧最小视听叙事与视频生成单元，承载时空、构图、机位运动与音画契约',
        is_system: true,
        properties: [
          { key: 'shot_number', name_zh: '镜头序号', type: 'number', required: true, default: 1, description: '全集递增镜头编号' },
          { key: 'title', name_zh: '分镜标题', type: 'string', required: true, default: '', description: '简明情节概括' },
          { key: 'shot_type', name_zh: '景别', type: 'enum', required: true, default: '中景', enums: Object.values(SHOT_TYPES), description: '大远景/远景/全景/中景/近景/特写' },
          { key: 'movement', name_zh: '运镜模式', type: 'enum', required: true, default: 'push', enums: Object.values(CAMERA_MOVEMENTS), description: '推拉摇移、手持呼吸感、环绕运镜' },
          { key: 'angle_h', name_zh: '水平机位角', type: 'enum', required: false, default: 'front', enums: CAMERA_ANGLES.HORIZONTAL, description: '水平360度方位角' },
          { key: 'angle_v', name_zh: '垂直俯仰角', type: 'enum', required: false, default: 'eye_level', enums: CAMERA_ANGLES.ELEVATION, description: '平视/俯拍/仰拍/顶拍/虫视' },
          { key: 'lighting_style', name_zh: '光影风格', type: 'enum', required: false, default: 'natural', enums: Object.values(LIGHTING_STYLES), description: '自然光/侧光/逆光/伦勃朗/赛博霓虹' },
          { key: 'depth_of_field', name_zh: '景深层级', type: 'enum', required: false, default: 'medium', enums: Object.values(DEPTH_OF_FIELD), description: '极浅景深/虚化/全景深' },
          { key: 'duration', name_zh: '物理时长预算(秒)', type: 'number', required: true, default: 5, min: 1, max: 15, description: '物理镜头生成时长预算' },
          { key: 'action', name_zh: '拍摄动作规划', type: 'string', required: false, default: '', description: '画面主体物理动作' },
          { key: 'result', name_zh: '镜头结果定格', type: 'string', required: false, default: '', description: '动作终点与尾帧状态' },
          { key: 'dialogue', name_zh: '台词文本', type: 'string', required: false, default: '', description: '画内角色念白，受时长预算门禁控制' },
          { key: 'narration', name_zh: '解说旁白', type: 'string', required: false, default: '', description: '画外纪录式旁白文本' },
          { key: 'audio_mode', name_zh: '音画契约模式', type: 'enum', required: false, default: 'in_frame_dialogue', enums: ['in_frame_dialogue', 'offscreen_voiceover', 'narration', 'mute_action'], description: '口型匹配/画外音/旁白/静音' },
        ],
        custom_properties: [],
      },
      {
        id: 'character',
        name_zh: '角色实体',
        description: '剧情核心行动主体，具备外貌、声纹、服装阶段及空间 3D 视觉槽位',
        is_system: true,
        properties: [
          { key: 'name', name_zh: '角色姓名', type: 'string', required: true, default: '', description: '角色标准称谓' },
          { key: 'gender', name_zh: '性别', type: 'enum', required: true, default: '女', enums: ['男', '女', '其他'], description: '生理性别' },
          { key: 'role', name_zh: '身份定位', type: 'string', required: false, default: '主演', description: '主角/反派/配角/群众' },
          { key: 'appearance', name_zh: '外貌与特征锚点', type: 'string', required: false, default: '', description: '发型、脸型、辨识性特征' },
          { key: 'depth_layer', name_zh: '默认画面纵深', type: 'enum', required: false, default: 'midground', enums: Object.values(DEPTH_LAYERS), description: '前景/中景/背景' },
          { key: 'facing', name_zh: '默认空间朝向', type: 'enum', required: false, default: 'three_quarter_left', enums: Object.values(FACING_DIRECTIONS), description: '正脸/3/4侧脸/正侧/背身' },
          { key: 'gaze', name_zh: '默认视线落点', type: 'enum', required: false, default: 'locked_on_partner', enums: Object.values(GAZE_DIRECTIONS), description: '锁定搭档/画外/战术目标/屏幕/道具' },
          { key: 'posture', name_zh: '体态与重心', type: 'enum', required: false, default: 'standing_upright', enums: Object.values(POSTURE_TYPES), description: '立姿/半蹲/前倾/掩体依托' },
          { key: 'hands', name_zh: '四肢手部姿态', type: 'enum', required: false, default: 'hands_natural_sides', enums: Object.values(HANDS_ACTIONS), description: '手部持物/搭肩/撑地/按耳机' },
          { key: 'voice_id', name_zh: '专属音色 ID', type: 'string', required: false, default: '', description: 'TTS 配音音色绑定' },
        ],
        custom_properties: [],
      },
      {
        id: 'scene',
        name_zh: '场景空间实体',
        description: '物理摄制环境空间，提供纵深透视、采光氛围与地标参照物',
        is_system: true,
        properties: [
          { key: 'location', name_zh: '场景地点', type: 'string', required: true, default: '', description: '如“密闭审讯室”、“天台避难所”' },
          { key: 'time', name_zh: '时间环境', type: 'string', required: false, default: '日景', description: '日景/夜景/黄昏/黎明' },
          { key: 'spatial_type', name_zh: '空间拓扑类型', type: 'enum', required: false, default: 'interior_tight', enums: ['interior_tight', 'interior_open', 'exterior_tight', 'exterior_open', 'tactical_field'], description: '狭小室内/开阔室内/室外/战术场地' },
          { key: 'lighting_env', name_zh: '自然采光条件', type: 'enum', required: false, default: 'natural', enums: Object.values(LIGHTING_STYLES), description: '顶光/侧光/霓虹/暗调' },
          { key: 'landmarks', name_zh: '空间地标清单', type: 'array', required: false, default: [], description: '如门框、办公桌、掩体立柱等空间定位参考物' },
          { key: 'acoustics', name_zh: '声学反射环境', type: 'string', required: false, default: '', description: '混响/回音/室外开阔/密封消音' },
        ],
        custom_properties: [],
      },
      {
        id: 'prop',
        name_zh: '道具物品实体',
        description: '剧情承载物与人机交互物件，具备时代属性与物理尺度',
        is_system: true,
        properties: [
          { key: 'name', name_zh: '道具名称', type: 'string', required: true, default: '', description: '标准道具品名' },
          { key: 'type', name_zh: '道具类别', type: 'string', required: false, default: '日常用品', description: '随身武器/通讯终端/关键证物/日常物件' },
          { key: 'era_category', name_zh: '时代归属', type: 'enum', required: false, default: 'universal', enums: ['ancient', 'republic_china', 'modern', 'sci_fi', 'fantasy', 'universal'], description: '古风/民国/现代/科幻/通用' },
          { key: 'era_compatibility', name_zh: '跨时代兼容性', type: 'enum', required: false, default: 'compatible', enums: ['compatible', 'intentional_cross_era', 'incompatible', 'uncertain'], description: '相容/刻意穿越/违和冲突' },
          { key: 'physical_scale', name_zh: '物理尺度描述', type: 'string', required: false, default: '中型物件', description: '如“约20cm掌上设备”、“高75cm桌面陈设”' },
          { key: 'interaction_type', name_zh: '持握交互模式', type: 'enum', required: false, default: 'hold', enums: ['hold', 'wear', 'place_on_surface', 'fixed_fixture', 'examine'], description: '单手持握/穿戴/桌面摆放/固定装置' },
          { key: 'owner_character_id', name_zh: '专属归属角色ID', type: 'number', required: false, default: null, description: '角色随身物品绑定' },
        ],
        custom_properties: [],
      },
      {
        id: 'action_atom',
        name_zh: '动作原子 (Structured Sync)',
        description: '基于物理因果的精确动态原子，杜绝不可视的模糊意图描述',
        is_system: true,
        properties: [
          { key: 'atom_key', name_zh: '动作原子标识', type: 'enum', required: true, default: 'hold', enums: Object.keys(ACTIONS), description: '15类标准化因果动作原子' },
          { key: 'body_part', name_zh: '发力肢体部位', type: 'enum', required: false, default: 'right_hand', enums: Object.keys(BODY_PARTS), description: '右手/双手/头部/视线/双足' },
          { key: 'target_type', name_zh: '交互目标类型', type: 'enum', required: false, default: 'prop', enums: Object.keys(TARGET_TYPES), description: '道具/搭档身体部位/场景环境/空间方向' },
          { key: 'direction', name_zh: '空间矢量方向', type: 'enum', required: false, default: 'forward', enums: Object.keys(DIRECTIONS), description: '向前/向左/向右/抬高/压低' },
          { key: 'contact', name_zh: '接触状态', type: 'enum', required: false, default: 'grasping', enums: Object.keys(CONTACTS), description: '紧握/轻触/悬停/脱离接触' },
          { key: 'state', name_zh: '动作阶段', type: 'enum', required: false, default: 'sustained', enums: Object.keys(STATES), description: '起始爆发/持续进行/终点保持' },
          { key: 'duration_ratio', name_zh: '镜头时长占比', type: 'number', required: false, default: 0.8, min: 0.1, max: 1.0, description: '动作在总镜头时长中占用的百分比' },
        ],
        custom_properties: [],
      },
      {
        id: 'camera',
        name_zh: '摄影机与机位',
        description: '电影级机位运动与光学成像参数',
        is_system: true,
        properties: [
          { key: 'focal_length', name_zh: '镜头焦段预设', type: 'enum', required: false, default: '35mm', enums: ['24mm', '35mm', '50mm', '85mm', '135mm'], description: '广角环境透视/标准人眼视角/长焦压缩' },
          { key: 'elevation', name_zh: '俯仰角度', type: 'enum', required: false, default: 'eye_level', enums: CAMERA_ANGLES.ELEVATION, description: '平视/仰角/俯视' },
          { key: 'horizontal_track', name_zh: '横向轨道位移', type: 'enum', required: false, default: 'static', enums: ['static', 'pan_left', 'pan_right', 'orbit_180'], description: '水平滑轨或环绕' },
        ],
        custom_properties: [],
      },
      {
        id: 'audio',
        name_zh: '声音与口型契约',
        description: '音画同频与多轨声音设计规范',
        is_system: true,
        properties: [
          { key: 'audio_lip_sync', name_zh: '口型匹配模式', type: 'enum', required: true, default: 'in_frame_dialogue', enums: ['in_frame_dialogue', 'offscreen_voiceover', 'narration', 'mute_action'], description: '画内强制对口/画外音/纪录旁白/静音' },
          { key: 'speed', name_zh: 'TTS 语速缩放', type: 'number', required: false, default: 1.0, min: 0.8, max: 1.5, description: 'TTS 说话速率基准' },
          { key: 'is_silent', name_zh: '是否静音镜头', type: 'boolean', required: false, default: false, description: '无说话人、纯氛围音镜头' },
          { key: 'bgm_prompt', name_zh: '配乐氛围描述', type: 'string', required: false, default: '', description: '配乐情绪与节奏' },
        ],
        custom_properties: [],
      },
    ],

    // ── 2. 关系网络拓扑定义 (Relation Types & Link Graph) ──
    relation_types: [
      {
        id: 'shot_features_character',
        name_zh: '分镜出场角色',
        source: 'shot',
        target: 'character',
        cardinality: '1:N',
        max_count: 2,
        required: false,
        description: '分镜中登场的身份角色，携带 3D 深度、站位坐标、视线朝向与姿态',
        attributes: [
          { key: 'depth_layer', name_zh: '画面纵深层级', type: 'enum', enums: ['foreground', 'midground', 'background'], default: 'midground' },
          { key: 'facing', name_zh: '空间朝向', type: 'enum', enums: Object.values(FACING_DIRECTIONS), default: 'three_quarter_left' },
          { key: 'gaze', name_zh: '视线交互', type: 'enum', enums: Object.values(GAZE_DIRECTIONS), default: 'locked_on_partner' },
        ],
      },
      {
        id: 'shot_takes_place_in_scene',
        name_zh: '分镜拍摄于场景',
        source: 'shot',
        target: 'scene',
        cardinality: '1:1',
        max_count: 1,
        required: true,
        description: '分镜拍摄所依托的物理空间环境与采光声学背景',
        attributes: [],
      },
      {
        id: 'shot_uses_prop',
        name_zh: '分镜入画道具',
        source: 'shot',
        target: 'prop',
        cardinality: '0:N',
        max_count: 2,
        required: false,
        description: '分镜中入画或作为特写交互焦点的关键道具',
        attributes: [
          { key: 'is_primary', name_zh: '是否为主交互焦点', type: 'boolean', default: true },
        ],
      },
      {
        id: 'character_interacts_with_prop',
        name_zh: '角色持握/操作道具',
        source: 'character',
        target: 'prop',
        cardinality: '0:N',
        max_count: 2,
        required: false,
        description: '角色肢体与物理道具之间的真实因果交互动作',
        attributes: [
          { key: 'action', name_zh: '动作动词', type: 'string', default: 'hold' },
          { key: 'hand', name_zh: '操作手', type: 'enum', enums: ['left_hand', 'right_hand', 'both_hands'], default: 'right_hand' },
        ],
      },
      {
        id: 'character_interacts_with_character',
        name_zh: '双人视听对视与构图',
        source: 'character',
        target: 'character',
        cardinality: '0:N',
        max_count: 2,
        required: false,
        description: '双人或多人间的视线交汇、站位纵深与正反打交互关系',
        attributes: [
          { key: 'framing', name_zh: '对话构图', type: 'enum', enums: Object.values(DIALOGUE_FRAMING), default: 'two_shot_face_to_face' },
        ],
      },
      {
        id: 'shot_transitions_to_shot',
        name_zh: '分镜接续与蒙太奇流转',
        source: 'shot',
        target: 'shot',
        cardinality: '1:1',
        max_count: 1,
        required: false,
        description: '相邻前后镜头之间的时空连续性与动作接戏因果',
        attributes: [
          { key: 'continuity_type', name_zh: '连戏类型', type: 'enum', enums: Object.values(CONTINUITY_TYPES), default: 'continuation' },
        ],
      },
      {
        id: 'prop_belongs_to_character',
        name_zh: '道具随身归属',
        source: 'prop',
        target: 'character',
        cardinality: '0:1',
        max_count: 1,
        required: false,
        description: '角色的随身信物、专属武器或标志性物件',
        attributes: [],
      },
    ],

    // ── 3. 门禁规则与物理阈值参数配置 (Invariants & Rule Configs) ──
    rules: {
      RULE_CROWD_CONTROL: {
        enabled: true,
        severity: 'warning',
        params: {
          max_characters: 2,
        },
        description: '单镜出场身份角色数量强控，防止生图/视频模型人脸融化、双胞胎或克隆人',
      },
      RULE_H3_REFERENCE_CAPACITY: {
        enabled: true,
        severity: 'error',
        params: {
          max_characters: 2,
          max_props: 2,
          max_references: 9,
        },
        description: '严格限制 MiniMax H3 单镜头最多 9 张参考图配额，且角色<=2、道具<=2',
      },
      RULE_SPEECH_TIMING: {
        enabled: true,
        severity: 'error',
        params: {
          speech_rate_factor: 1.25,
          min_duration: 1.0,
          max_duration: 15.0,
        },
        description: '按 1.25x 语速精确计算台词字数与镜头物理时长预算，防止台词念不完中断截字',
      },
      RULE_AUDIO_CONTRACT: {
        enabled: true,
        severity: 'error',
        params: {},
        description: '核查台词、解说旁白、静音状态与口型模式（audio_lip_sync）的严格语义一致性',
      },
      RULE_VISUAL_SLOT_COMPLETENESS: {
        enabled: true,
        severity: 'error',
        params: {},
        description: '核验登场角色 3D 视觉槽位（深度层、朝向、视线、姿态、手部动作）是否完备',
      },
      RULE_VIDEO_SLOTS: {
        enabled: true,
        severity: 'error',
        params: {},
        description: '核验 Structured Sync 物理动作原子与轨迹因果链，确保动作可被模型准确执行',
      },
      RULE_SPATIAL_CONTINUITY: {
        enabled: true,
        severity: 'warning',
        params: {
          prevent_jump_cut: true,
        },
        description: '校验相邻分镜机位角度与空间轴线，防范越轴（180度线跃迁）导致观众方向迷失',
      },
      RULE_PROP_ERA_AND_SCALE: {
        enabled: true,
        severity: 'warning',
        params: {
          enforce_era_match: true,
        },
        description: '校验道具时代背景与剧目题材的相容性，防范现代电子产品出现在古代剧中的穿帮',
      },
      RULE_OBSOLETE_ASSETS: {
        enabled: true,
        severity: 'error',
        params: {},
        description: '拦截已软删除或非当前剧目的历史残留孤儿资产，确保资产引用的绝对干净',
      },
      RULE_SHOT_TRANSITION_CONTINUITY: {
        enabled: true,
        severity: 'error',
        params: {},
        description: '校验分镜转场槽位（出画转场与入画转场）因果链，杜绝首尾帧断裂无序切换',
      },
      RULE_CROSS_SLOT_INVARIANTS: {
        enabled: true,
        severity: 'error',
        params: {},
        description: '强制要求画外音、画外在场角色必须显式声明槽位，杜绝自由文本揣测',
      },
      RULE_ASSET_REFERENCE_AND_PLANNING_FEASIBILITY: {
        enabled: true,
        severity: 'error',
        params: {},
        description: '作为资产白名单把关者，杜绝智能体幻觉伪造不存在的资产 ID',
      },
      RULE_BEAT_CINEMATOGRAPHY: {
        enabled: true,
        severity: 'warning',
        params: {
          require_prop_close_up: true,
          require_beat_impact_sfx: true,
          enforce_power_angle: true,
        },
        description: '短剧爽点节拍视听语法硬约束（亮信物特写夺焦、施压/打脸音效刺入与权力位阶俯仰角）',
      },
    },
  };
}

/**
 * 获取当前生效的本体配置（若数据库有保存则深度合并）
 * @param {import('better-sqlite3').Database} db
 * @returns {object}
 */
function getEffectiveConfig(db) {
  const defaults = getDefaultOntologyConfig();
  if (!db) return defaults;

  try {
    const row = db.prepare('SELECT value FROM global_settings WHERE key = ?').get(CONFIG_KEY);
    if (!row || !row.value) {
      return defaults;
    }

    const saved = JSON.parse(row.value);
    return mergeOntologyConfig(defaults, saved);
  } catch (err) {
    console.error('[OntologyConfigService] Failed to load saved config from DB:', err.message);
    return defaults;
  }
}

/**
 * 深度合并用户配置与默认配置
 */
function mergeOntologyConfig(defaults, saved) {
  if (!saved || typeof saved !== 'object') return defaults;

  const result = { ...defaults };
  result.updated_at = saved.updated_at || result.updated_at;
  result.version = saved.version || result.version;

  // 合并对象类型
  if (Array.isArray(saved.object_types)) {
    const savedObjMap = new Map(saved.object_types.map(o => [o.id, o]));
    result.object_types = defaults.object_types.map(defObj => {
      const savedObj = savedObjMap.get(defObj.id);
      if (!savedObj) return defObj;

      // 合并属性
      const defPropMap = new Map(defObj.properties.map(p => [p.key, p]));
      const mergedProps = defObj.properties.map(p => {
        const sp = (savedObj.properties || []).find(x => x.key === p.key);
        return sp ? { ...p, ...sp } : p;
      });

      return {
        ...defObj,
        ...savedObj,
        properties: mergedProps,
        custom_properties: Array.isArray(savedObj.custom_properties) ? savedObj.custom_properties : [],
      };
    });
  }

  // 合并关系拓扑
  if (Array.isArray(saved.relation_types)) {
    const savedRelMap = new Map(saved.relation_types.map(r => [r.id, r]));
    result.relation_types = defaults.relation_types.map(defRel => {
      const savedRel = savedRelMap.get(defRel.id);
      if (!savedRel) return defRel;
      return {
        ...defRel,
        ...savedRel,
      };
    });
  }

  // 合并规则配置
  if (saved.rules && typeof saved.rules === 'object') {
    result.rules = {};
    for (const [ruleId, defRule] of Object.entries(defaults.rules)) {
      const savedRule = saved.rules[ruleId] || {};
      result.rules[ruleId] = {
        ...defRule,
        enabled: savedRule.enabled !== undefined ? !!savedRule.enabled : defRule.enabled,
        severity: savedRule.severity || defRule.severity,
        params: {
          ...defRule.params,
          ...(savedRule.params || {}),
        },
      };
    }
  }

  return result;
}

/**
 * 保存本体配置到 SQLite
 * @param {import('better-sqlite3').Database} db
 * @param {object} newConfig
 */
function saveConfig(db, newConfig) {
  if (!db) throw new Error('Database connection is required');
  if (!newConfig || typeof newConfig !== 'object') {
    throw new Error('Invalid ontology configuration: must be an object');
  }

  const effective = mergeOntologyConfig(getDefaultOntologyConfig(), newConfig);
  effective.updated_at = new Date().toISOString();

  const now = effective.updated_at;
  const jsonStr = JSON.stringify(effective);

  db.prepare(`
    INSERT INTO global_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(CONFIG_KEY, jsonStr, now);

  return effective;
}

/**
 * 重置本体配置为系统默认规范
 * @param {import('better-sqlite3').Database} db
 */
function resetToDefaults(db) {
  if (!db) throw new Error('Database connection is required');
  db.prepare('DELETE FROM global_settings WHERE key = ?').run(CONFIG_KEY);
  return getDefaultOntologyConfig();
}

module.exports = {
  CONFIG_KEY,
  getDefaultOntologyConfig,
  getEffectiveConfig,
  saveConfig,
  resetToDefaults,
  mergeOntologyConfig,
};
