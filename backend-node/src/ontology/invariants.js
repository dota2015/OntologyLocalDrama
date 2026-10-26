/**
 * 影视视听本体约束与硬门禁引擎（Audiovisual Semantic Invariants）
 * 灵感源自 /home/nvidia/ontology-semantic-system 的 SHACL 质量形状与规则门禁体系：
 * - 拒绝隐式错误，任何违背视听语法与连戏铁律的情况均输出具名违规项（Violations）
 * - 供 Agent 自省反思环（Self-Reflection Loop）作为质检反馈，精准指导 Agent 进行微调纠偏
 */

const { CAMERA_MOVEMENTS } = require('./schema');
const { isAssetObsolete } = require('./assetMatcher');

// 严禁在画面提示词中出现的文学抽象修辞与心理隐喻词库
const FORBIDDEN_METAPHORS = [
  /高低对照/,
  /焦急凝结/,
  /心理落差/,
  /希望被突发打断/,
  /时间压力凝结/,
  /气氛僵持在空气中/,
  /眼神中流露出复杂的沧桑/,
  /无声的默契在蔓延/,
];

// 严禁在画面中渲染的文字与UI残留
const FORBIDDEN_UI_TEXT = [
  /倒计时\s*\d+\s*秒/,
  /悬浮.*倒计时/,
  /屏幕小字/,
  /浮动UI/,
  /血条/,
];

/**
 * 门禁 1：运镜动态感与固定镜头比例检查（严格少用固定镜头）
 * @param {Array<object>} shots
 * @returns {Array<object>} 违规列表
 */
function checkMovementDynamism(shots) {
  const violations = [];
  if (!Array.isArray(shots) || shots.length === 0) return violations;

  const total = shots.length;
  let staticCount = 0;
  let consecutiveStatic = 0;

  shots.forEach((shot, idx) => {
    const shotNum = shot.shot_number || (idx + 1);
    const mov = String(shot.movement || '').toLowerCase().trim();

    if (mov === CAMERA_MOVEMENTS.STATIC || mov === '固定') {
      staticCount++;
      consecutiveStatic++;
      if (consecutiveStatic >= 2) {
        violations.push({
          rule: 'INVARIANT_NO_CONSECUTIVE_STATIC',
          shot_number: shotNum,
          severity: 'error',
          message: `分镜 ${shotNum} 与前一镜连续使用固定镜头(static)，导致短剧画面严重呆滞如幻灯片。必须修改为微推(push)、跟拍(tracking)或手持(handheld)。`,
        });
      }
    } else {
      consecutiveStatic = 0;
    }
  });

  const staticRatio = staticCount / total;
  if (staticRatio > 0.15 && total >= 5) {
    violations.push({
      rule: 'INVARIANT_STATIC_RATIO_EXCEEDED',
      shot_number: null,
      severity: 'error',
      message: `全片固定镜头占比为 ${(staticRatio * 100).toFixed(1)}%（共 ${staticCount}/${total} 镜），严重超出 15% 上限。短剧切忌画面死板，绝大多数镜头必须采用推/拉/摇/跟/手持等动态运镜。`,
    });
  }

  return violations;
}

/**
 * 门禁 2：音频视听合同检查（无对白必配 BGM，供给 H3/Seedance）
 * @param {Array<object>} shots
 * @returns {Array<object>} 违规列表
 */
function checkAudioContract(shots) {
  const violations = [];
  if (!Array.isArray(shots)) return violations;

  shots.forEach((shot, idx) => {
    const shotNum = shot.shot_number || (idx + 1);
    const hasDialogue = !!(shot.dialogue && String(shot.dialogue).trim());
    const hasNarration = !!(shot.narration && String(shot.narration).trim());
    const bgmPrompt = String(shot.bgm_prompt || '').trim();

    // 无对白且无解说镜头：必须具备情绪背景音乐描述
    if (!hasDialogue && !hasNarration) {
      if (!bgmPrompt || bgmPrompt === '无' || bgmPrompt === '无BGM' || bgmPrompt === '禁BGM') {
        violations.push({
          rule: 'INVARIANT_SILENT_SHOT_MISSING_BGM',
          shot_number: shotNum,
          severity: 'error',
          message: `分镜 ${shotNum} 无人物台词与旁白，但 bgm_prompt 为空。H3 等多模态视频模型需要专属背景音乐提示词（如紧迫电子脉冲、重低音打击乐等）来原生合成音画同步视频。`,
        });
      }
    }
  });

  return violations;
}

/**
 * 门禁：台词与旁白时长预算检查（Speech Timing Budget Hard Gate）
 * 严格防止台词字数超出镜头时长物理容纳上限，造成下游视频生成或口型合成硬中断
 * @param {Array<object>} shots
 * @param {object} options
 * @returns {Array<object>} 违规列表
 */
function checkSpeechTiming(shots, options = {}) {
  const violations = [];
  if (!Array.isArray(shots)) return violations;

  const { assessVideoSpeech, timingError } = require('../utils/speechTiming');
  const speechDelivery = require('../services/speechDeliveryService');

  shots.forEach((shot, idx) => {
    const shotNum = shot.shot_number || shot.storyboard_number || (idx + 1);
    const hasDialogue = !!(shot.dialogue && String(shot.dialogue).trim() && !/^(?:无|无对白|无对话|无台词|none|null|n\/a)[。.!！\s]*$/iu.test(String(shot.dialogue).trim()));
    const hasNarration = !!(shot.narration && String(shot.narration).trim() && !/^(?:无|无旁白|无解说|none|null|n\/a)[。.!！\s]*$/iu.test(String(shot.narration).trim()));
    if (!hasDialogue && !hasNarration) return;

    const duration = Number(shot.duration) > 0 ? Number(shot.duration) : 5;
    let deliveryOptions = options.deliveryOptions || {};
    if (!deliveryOptions.speechRate && options.db && shot.id) {
      try {
        const delivery = speechDelivery.forShot(options.db, shot, { duration });
        deliveryOptions = speechDelivery.budgetOptions(delivery);
      } catch (_) {}
    } else if (!deliveryOptions.speechRate) {
      deliveryOptions = { speechRate: 1.44, turnPauseSeconds: 0 };
    }

    const prompt = shot.video_prompt || shot.universal_segment_text || '';
    const assessment = assessVideoSpeech(shot, prompt, duration, deliveryOptions);
    if (!assessment.ok) {
      violations.push({
        rule: 'INVARIANT_SPEECH_OVER_BUDGET',
        shot_number: shotNum,
        severity: 'error',
        message: timingError(shot, assessment),
        assessment,
      });
    }
  });

  return violations;
}

/**
 * 门禁：生图构图槽位完整性检查（Visual Slots & Freeze-frame Posture Hard Gate）
 * 预置槽位（facing, posture, hands, head_gaze），杜绝纯文本提示词遗漏朝向、姿态或产生动态残片
 * @param {Array<object>} shots
 * @returns {Array<object>} 违规列表
 */
function checkVisualSlotCompleteness(shots) {
  const violations = [];
  if (!Array.isArray(shots)) return violations;

  const { validateCharacterVisualSlots, FACING_REGEX, POSTURE_REGEX, HANDS_REGEX, GAZE_REGEX, DYNAMIC_REGEX } = require('./visualSlots');

  shots.forEach((shot, idx) => {
    const shotNum = shot.shot_number || shot.storyboard_number || (idx + 1);
    const charIds = parseCharacterIds(shot.characters || shot.character_ids);
    if (charIds.length === 0) return;

    let visuals = shot.character_visuals;
    if (typeof visuals === 'string') {
      try { visuals = JSON.parse(visuals); } catch (_) { visuals = []; }
    }

    if (Array.isArray(visuals) && visuals.length > 0) {
      // 结构化预置槽位强门禁检验
      const slotViolations = validateCharacterVisualSlots(shot, visuals);
      violations.push(...slotViolations);
    } else {
      // 若尚未填充结构化槽位，从 image_prompt/action 做强类型关键槽位审查
      const p = String(shot.image_prompt || shot.action || '');
      const hasFacing = FACING_REGEX.test(p);
      const hasPosture = POSTURE_REGEX.test(p);
      const hasHands = HANDS_REGEX.test(p);
      const hasGaze = GAZE_REGEX.test(p);

      const missing = [];
      if (!hasFacing) missing.push('人物朝向 (facing)');
      if (!hasPosture) missing.push('躯干重心姿态 (posture)');
      if (!hasHands) missing.push('手部动作 (hands)');
      if (!hasGaze) missing.push('头部视线 (head_gaze)');

      if (missing.length > 0) {
        violations.push({
          rule: 'INVARIANT_IMAGE_SLOT_INCOMPLETE',
          shot_number: shotNum,
          severity: 'error',
          message: `分镜 ${shotNum} 画面构图缺少关键槽位：${missing.join('、')}。生图模型无法确定朝向与具体肢体姿态，易造成人物发呆立正或机械套用参考图！`,
        });
      }

      if (DYNAMIC_REGEX.test(p)) {
        violations.push({
          rule: 'INVARIANT_SLOT_DYNAMIC_ACTION',
          shot_number: shotNum,
          severity: 'error',
          message: `分镜 ${shotNum} 图片提示词中包含视频化时序动态叙述，生图模型无法绘制动态过程，必须改为决定性瞬间静态定格！`,
        });
      }
    }

    // 校验尾帧槽位（若存在）
    let lastVisuals = shot.last_frame_visuals;
    if (typeof lastVisuals === 'string') {
      try { lastVisuals = JSON.parse(lastVisuals); } catch (_) { lastVisuals = []; }
    }
    if (Array.isArray(lastVisuals) && lastVisuals.length > 0) {
      const lastViolations = validateCharacterVisualSlots(shot, lastVisuals);
      violations.push(...lastViolations);
    }
  });

  return violations;
}

function parseCharacterIds(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
    } catch (_) {}
  }
  return [];
}

/**
 * 门禁 3：群戏防人脸崩溃与防克隆人检查（单镜角色 <= 2）
 * @param {Array<object>} shots
 * @returns {Array<object>} 违规列表
 */
function checkCrowdControl(shots) {
  const violations = [];
  if (!Array.isArray(shots)) return violations;

  shots.forEach((shot, idx) => {
    const shotNum = shot.shot_number || (idx + 1);
    const charIds = parseCharacterIds(shot.character_ids || shot.characters);
    if (charIds.length > 3) {
      violations.push({
        rule: 'INVARIANT_CROWD_COLLAPSE_RISK',
        shot_number: shotNum,
        severity: 'warning',
        message: `分镜 ${shotNum} 关联了 ${charIds.length} 名角色（超过3人），违反短剧正反打语法。单镜同时出场超过 3 人极易导致生图模型人脸崩溃、双胞胎或克隆人，建议拆解为主体行动镜+反应特写。`,
      });
    }
  });

  return violations;
}

/**
 * 门禁：H3视频参考图物理上限与复杂度审查（单镜角色<=3，核心道具<=2）
 * 严格防止超出 H3 9张参考图上限，避免视频生成中断或人脸肢体扭曲
 */
function checkH3ReferenceCapacity(shots) {
  const violations = [];
  if (!Array.isArray(shots)) return violations;

  shots.forEach((shot, idx) => {
    const shotNum = shot.shot_number || (idx + 1);
    const charIds = parseCharacterIds(shot.character_ids || shot.characters);
    const propIds = Array.isArray(shot.props) ? shot.props : (Array.isArray(shot.prop_ids) ? shot.prop_ids : []);

    if (charIds.length > 3) {
      violations.push({
        rule: 'INVARIANT_H3_CROWD_OVERLOAD',
        shot_number: shotNum,
        severity: 'error',
        message: `分镜 ${shotNum} 出场角色超过3人（当前${charIds.length}人），超出 H3 视频生成 9 张参考图物理上限，必须拆镜为正反打镜头！`,
      });
    }
    if (propIds.length > 2) {
      violations.push({
        rule: 'INVARIANT_H3_PROP_OVERLOAD',
        shot_number: shotNum,
        severity: 'error',
        message: `分镜 ${shotNum} 挂载道具超过2件（当前${propIds.length}件），超出 H3 参考图槽位上限，必须拆镜精简！`,
      });
    }
  });

  return violations;
}

/**
 * 门禁 4：纯物理描写与禁止UI/文字交代剧情检查
 * @param {Array<object>} shots
 * @returns {Array<object>} 违规列表
 */
function checkPhysicalVisualDescription(shots) {
  const violations = [];
  if (!Array.isArray(shots)) return violations;

  shots.forEach((shot, idx) => {
    const shotNum = shot.shot_number || (idx + 1);
    const text = `${shot.action || ''} ${shot.result || ''} ${shot.layout_description || ''} ${shot.image_prompt || ''}`;

    for (const pattern of FORBIDDEN_METAPHORS) {
      if (pattern.test(text)) {
        violations.push({
          rule: 'INVARIANT_LITERARY_METAPHOR_FORBIDDEN',
          shot_number: shotNum,
          severity: 'warning',
          message: `分镜 ${shotNum} 包含抽象文学修辞或心理隐喻（匹配到 ${pattern}）。提示词必须纯写实物理姿态与真实光影，AI生图模型无法理解文学修辞。`,
        });
      }
    }

    for (const pattern of FORBIDDEN_UI_TEXT) {
      if (pattern.test(text)) {
        violations.push({
          rule: 'INVARIANT_UI_TEXT_IN_PROMPT_FORBIDDEN',
          shot_number: shotNum,
          severity: 'error',
          message: `分镜 ${shotNum} 要求在画面中渲染界面文字或倒计时（匹配到 ${pattern}）。此类剧情关键信息 100% 必须由角色台词说出，严禁在画面提示词中绘制文字。`,
        });
      }
    }
  });

  return violations;
}

/**
 * 门禁 5：镜头间空间连续性检查（防跳切与瞬移）
 * @param {Array<object>} shots
 * @returns {Array<object>} 违规列表
 */
function checkSpatialContinuity(shots) {
  const violations = [];
  if (!Array.isArray(shots) || shots.length < 2) return violations;

  for (let i = 1; i < shots.length; i++) {
    const prev = shots[i - 1];
    const curr = shots[i];
    const currNum = curr.shot_number || (i + 1);

    // 如果在同一个场景且机位角度相同
    const sameScene = prev.scene_id != null && prev.scene_id === curr.scene_id;
    const sameAngle = prev.angle_h === curr.angle_h && prev.angle_v === curr.angle_v && prev.shot_type === curr.shot_type;

    if (sameScene && sameAngle) {
      const prevChars = parseCharacterIds(prev.character_ids || prev.characters).map(String);
      const currChars = parseCharacterIds(curr.character_ids || curr.characters).map(String);
      
      // 同一机位同视角，前一镜有角色，后一镜角色完全不同，且没有切特写或动作交代
      if (prevChars.length > 0 && currChars.length > 0 && !prevChars.some(id => currChars.includes(id))) {
        violations.push({
          rule: 'INVARIANT_SPATIAL_JUMP_CUT',
          shot_number: currNum,
          severity: 'warning',
          message: `分镜 ${currNum} 与上一镜处于同一场景相同机位，但角色瞬间被完全置换，构成视觉跳切穿帮。应切换为反打特写或交代人物出入画动作。`,
        });
      }
    }
  }

  return violations;
}

/**
 * 门禁 6：道具时代与物理尺度硬约束检查
 * 严格防止古装剧出现现代道具穿帮，以及道具比例失真
 * @param {Array<object>} props
 * @param {string} dramaEra - ancient, modern, sci_fi, etc.
 * @returns {Array<object>} 违规列表
 */
function checkPropEraAndScale(props, dramaEra = 'modern') {
  const violations = [];
  if (!Array.isArray(props)) return violations;

  const isAncient = dramaEra === 'ancient' || dramaEra === '古风' || dramaEra === '古装';
  const modernAnachronisms = [
    /手机/, /智能机/, /电脑/, /笔记本/, /遥控器/, /塑料袋/, /打火机/, /汽车/, /现代/, /液晶屏/,
  ];

  props.forEach((prop, idx) => {
    const name = prop.name || `道具${idx + 1}`;
    const text = `${name} ${prop.description || ''} ${prop.type || ''}`;

    if (isAncient) {
      for (const pattern of modernAnachronisms) {
        if (pattern.test(text)) {
          violations.push({
            rule: 'INVARIANT_PROP_ANACHRONISM',
            prop_id: prop.id,
            prop_name: name,
            severity: 'error',
            message: `道具「${name}」在古装世界观中出现现代穿帮物品（匹配到 ${pattern}）。严禁在古代剧目中引入现代工业品。`,
          });
        }
      }
    }

    if (!prop.physical_scale || !String(prop.physical_scale).trim()) {
      violations.push({
        rule: 'INVARIANT_PROP_MISSING_SCALE',
        prop_id: prop.id,
        prop_name: name,
        severity: 'warning',
        message: `道具「${name}」未定义物理尺度锚点(physical_scale)。缺少尺寸约束容易导致生图模型将道具画得比例失真、喧宾夺主。`,
      });
    }
  });

  return violations;
}

/**
 * 检验是否有不符合当前剧本且分镜未引用的过时/孤儿资产（角色、道具、场地）
 * @param {object} catalogs - { characters: [], props: [], scenes: [] }
 * @param {string} scriptContent - 当前集/全剧剧本
 * @param {Array<object>} shots - 分镜列表
 * @returns {Array<object>} 警告项列表
 */
function checkObsoleteAssets(catalogs = {}, scriptContent = '', shots = [], options = {}) {
  const violations = [];
  const script = String(scriptContent || '').trim();
  if (!script) return violations;

  const characters = catalogs.characters || [];
  const props = catalogs.props || [];
  const scenes = catalogs.scenes || [];

  // 1. 角色检查
  for (const c of characters) {
    const name = String(c.name || '').trim();
    if (!name) continue;
    if (isAssetObsolete('character', c, { script, shots, ...options })) {
      violations.push({
        rule: 'INVARIANT_OBSOLETE_ASSET',
        severity: 'warning',
        asset_type: 'character',
        asset_id: c.id,
        asset_name: name,
        message: `角色「${name}」在当前剧本正文与分镜中均未发现出场，疑似废弃或剧情调整后的残留，建议删除。`,
      });
    }
  }

  // 2. 道具检查
  for (const p of props) {
    const name = String(p.name || '').trim();
    if (!name) continue;
    if (isAssetObsolete('prop', p, { script, shots, ...options })) {
      violations.push({
        rule: 'INVARIANT_OBSOLETE_ASSET',
        severity: 'warning',
        asset_type: 'prop',
        asset_id: p.id,
        asset_name: name,
        message: `道具「${name}」在当前剧本正文与分镜中未见使用记录，建议删除以精简世界观。`,
      });
    }
  }

  // 3. 场地检查
  for (const sc of scenes) {
    const loc = String(sc.location || '').trim();
    if (!loc) continue;
    if (isAssetObsolete('scene', sc, { script, shots, ...options })) {
      violations.push({
        rule: 'INVARIANT_OBSOLETE_ASSET',
        severity: 'warning',
        asset_type: 'scene',
        asset_id: sc.id,
        asset_name: loc,
        message: `场地「${loc}」在当前剧本与分镜中均未被涉及，建议删除。`,
      });
    }
  }

  return violations;
}

/**
 * 视听硬门禁：视频语义槽位契约与画外音口型审查
 * 杜绝画外音导致画内演员张嘴以及军事术语未具象化
 * @param {Array<object>} shots
 * @returns {Array<object>} 违规列表
 */
function checkVideoSlots(shots) {
  const violations = [];
  if (!Array.isArray(shots)) return violations;

  const { validateVideoSlots } = require('./videoSlots');

  shots.forEach((shot, idx) => {
    let vidSlots = shot.video_slots;
    if (typeof vidSlots === 'string') {
      try { vidSlots = JSON.parse(vidSlots); } catch (_) { vidSlots = null; }
    }
    if (vidSlots && typeof vidSlots === 'object') {
      const vErrs = validateVideoSlots(shot, vidSlots);
      violations.push(...vErrs);
    }
  });

  return violations;
}

/**
 * 运行全部视听本体质量门禁
 * @param {Array<object>} shots
 * @param {object} [options]
 * @param {Array<object>} [options.props]
 * @param {string} [options.dramaEra]
 * @param {object} [options.catalogs]
 * @param {string} [options.scriptContent]
 * @returns {{ valid: boolean, error_count: number, warning_count: number, violations: Array<object>, summary: string }}
 */
function validateAllInvariants(shots, options = {}) {
  const violations = [
    ...checkMovementDynamism(shots),
    ...checkAudioContract(shots),
    ...checkSpeechTiming(shots, options),
    ...checkVisualSlotCompleteness(shots),
    ...checkVideoSlots(shots),
    ...checkCrowdControl(shots),
    ...checkH3ReferenceCapacity(shots),
    ...checkPhysicalVisualDescription(shots),
    ...checkSpatialContinuity(shots),
    ...(options.props ? checkPropEraAndScale(options.props, options.dramaEra) : []),
    ...(options.catalogs && options.scriptContent ? checkObsoleteAssets(options.catalogs, options.scriptContent, shots) : []),
  ];

  const errors = violations.filter(v => v.severity === 'error');
  const warnings = violations.filter(v => v.severity === 'warning');

  let summary = '全部视听本体约束校验通过，符合高质量电影镜头规范。';
  if (errors.length > 0) {
    summary = `发现 ${errors.length} 项视听硬门禁违规，${warnings.length} 项质量警告，需要 Agent 进行针对性纠偏。`;
  } else if (warnings.length > 0) {
    summary = `视听门禁基本通过，但存在 ${warnings.length} 项质量优化建议。`;
  }

  // 计算视听统计指标
  const total = Array.isArray(shots) ? shots.length : 0;
  let staticCount = 0;
  let silentCount = 0;
  let silentWithBgm = 0;
  if (Array.isArray(shots)) {
    shots.forEach(s => {
      const mov = String(s.movement || '').toLowerCase().trim();
      if (mov === CAMERA_MOVEMENTS.STATIC || mov === '固定') staticCount++;
      const hasDialogue = !!(s.dialogue && String(s.dialogue).trim());
      const hasNarration = !!(s.narration && String(s.narration).trim());
      if (!hasDialogue && !hasNarration) {
        silentCount++;
        const bgm = String(s.bgm_prompt || '').trim();
        if (bgm && bgm !== '无' && bgm !== '无BGM' && bgm !== '禁BGM') {
          silentWithBgm++;
        }
      }
    });
  }

  return {
    valid: errors.length === 0,
    error_count: errors.length,
    warning_count: warnings.length,
    violations: errors,
    warnings: warnings,
    stats: {
      total_shots: total,
      static_shots: staticCount,
      dynamic_shots: Math.max(0, total - staticCount),
      static_ratio: total > 0 ? staticCount / total : 0,
      silent_shots: silentCount,
      silent_with_bgm: silentWithBgm,
    },
    summary,
  };
}

module.exports = {
  checkMovementDynamism,
  checkAudioContract,
  checkSpeechTiming,
  checkVisualSlotCompleteness,
  checkVideoSlots,
  checkCrowdControl,
  checkPhysicalVisualDescription,
  checkSpatialContinuity,
  checkPropEraAndScale,
  checkObsoleteAssets,
  validateAllInvariants,
};
