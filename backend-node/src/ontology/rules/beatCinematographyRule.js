/**
 * 门禁：短剧爽点节拍视听语法与机位硬约束 (Short Drama Beat Cinematography Invariants)
 * 严格执行微短剧视听规律：
 * 1. 亮牌/信物节拍 (reveal) 与核心信物道具 (key_token / slap_evidence / close_up_required)：
 *    - 必须显式关联信物资产 (INVARIANT_KEY_PROP_REFERENCE_MISSING)
 *    - 镜头景别必须使用特写或近景，杜绝宽景丧失焦点 (INVARIANT_KEY_PROP_CLOSE_UP_REQUIRED)
 * 2. 极限施压 (suppression) 与打脸反转 (slap_reversal / slap)：
 *    - 必须配置重音刺入/打脸音效以拉满短剧爽感与情绪张力 (INVARIANT_BEAT_AUDIO_IMPACT_MISSING)
 * 3. 极限施压 (suppression) 权力位阶与机位俯仰角：
 *    - 压迫者 (dominant) 镜头采用仰拍 (low angle)，被压迫者 (suppressed) 镜头采用俯拍 (high angle) (INVARIANT_SUPPRESSION_ANGLE_MISMATCH)
 */

const BaseInvariantRule = require('./baseRule');
const { shotCharacterIds } = require('./assetReferenceRule');

const CLOSE_UP_SHOT_TYPES = new Set([
  '特写', '大特写', '近景', '微距特写',
  'close_up', 'extreme_close_up', 'medium_close_up', 'macro_detail', 'insert_shot',
]);

const IMPACT_SFX_REGEX = /打脸|重音|刺入|巴掌|震动|轰鸣|耳光|打击|威压|心跳|呼吸骤停|反转|破空|sting|impact|slap|whoosh|hit|sub_bass|boom|shock/i;

function isCloseUp(shotType) {
  if (!shotType) return false;
  const str = String(shotType).trim().toLowerCase();
  if (CLOSE_UP_SHOT_TYPES.has(str)) return true;
  return /特写|近景|close_up|extreme_close_up|macro/i.test(str);
}

function parseJsonValue(val) {
  if (typeof val !== 'string' || !val.trim()) return val;
  try { return JSON.parse(val); } catch (_) { return val; }
}

function extractAllSfx(shot) {
  const sfxList = [];
  const add = (v) => {
    if (!v) return;
    if (typeof v === 'string') sfxList.push(v);
    else if (Array.isArray(v)) v.forEach(add);
    else if (typeof v === 'object') {
      if (v.name) sfxList.push(v.name);
      if (v.type) sfxList.push(v.type);
      if (v.description) sfxList.push(v.description);
    }
  };

  const soundPlan = parseJsonValue(shot.sound_plan) || {};
  add(soundPlan.sound_effects);
  add(soundPlan.sound_effect);
  add(soundPlan.sfx);

  const semantic = parseJsonValue(shot.semantic_slots) || {};
  const semSoundPlan = semantic.sound_plan || {};
  add(semSoundPlan.sound_effects);
  add(semSoundPlan.sound_effect);
  add(semSoundPlan.sfx);

  add(shot.sound_effect);
  add(shot.sound_effects);
  add(shot.sound_design);

  return sfxList;
}

class BeatCinematographyRule extends BaseInvariantRule {
  constructor() {
    super({
      id: 'RULE_BEAT_CINEMATOGRAPHY',
      name: '短剧爽点节拍视听语法',
      category: 'cinematography',
      defaultSeverity: 'warning',
      description: '短剧爽点节拍视听语法硬约束（亮信物特写夺焦、施压/打脸音效刺入与权力位阶俯仰角）',
    });
  }

  evaluate(context) {
    const shots = context.shots;
    const violations = [];
    if (!Array.isArray(shots)) return violations;

    const catalogs = context.catalogs || {};
    const propsCatalog = Array.isArray(catalogs.props) ? catalogs.props : (Array.isArray(context.props) ? context.props : []);
    const charactersCatalog = Array.isArray(catalogs.characters) ? catalogs.characters : [];

    // 建立信物道具集合 (key_token, slap_evidence, 或 close_up_required)
    const keyPropsMap = new Map();
    for (const p of propsCatalog) {
      const isKey = p.prop_role === 'key_token'
        || p.prop_role === 'slap_evidence'
        || p.close_up_required === true;
      if (isKey && p.id != null) {
        keyPropsMap.set(Number(p.id), p);
      }
    }

    // 建立角色权力位阶字典
    const characterPowerMap = new Map();
    for (const c of charactersCatalog) {
      if (c.id != null && c.power_status) {
        characterPowerMap.set(Number(c.id), String(c.power_status).trim().toLowerCase());
      }
    }

    shots.forEach((shot, idx) => {
      const shotNum = shot.shot_number || (idx + 1);
      const beatType = String(shot.beat_type || '').trim().toLowerCase();

      // 提取本镜关联的所有道具 ID
      const shotPropIds = [];
      const rawProps = shot.props ?? shot.prop_ids;
      if (Array.isArray(rawProps)) {
        rawProps.forEach((item) => {
          const id = Number(item?.id ?? item?.prop_id ?? item);
          if (id > 0) shotPropIds.push(id);
        });
      }
      const semantic = parseJsonValue(shot.semantic_slots) || {};
      const requiredRefs = Array.isArray(semantic.required_references) ? semantic.required_references : [];
      requiredRefs.forEach((ref) => {
        if (String(ref?.type || '').toLowerCase() === 'prop') {
          const id = Number(ref?.id ?? ref?.prop_id);
          if (id > 0) shotPropIds.push(id);
        }
      });
      const uniqueShotPropIds = [...new Set(shotPropIds)];

      // 判定是否涉及信物道具
      const hasKeyPropLinked = uniqueShotPropIds.some((id) => keyPropsMap.has(id));
      const isRevealBeat = beatType === 'reveal';

      // 1. Reveal 节拍与信物特写约束
      if (isRevealBeat) {
        // 1.1 若存在核心信物目录但本镜未关联任何道具，必须显式挂载信物道具
        if (keyPropsMap.size > 0 && uniqueShotPropIds.length === 0) {
          violations.push({
            rule: 'INVARIANT_KEY_PROP_REFERENCE_MISSING',
            shot_number: shotNum,
            severity: 'error',
            conflict_slots: ['props', 'semantic_slots.required_references'],
            message: `分镜 #${shotNum} 为亮明底牌/信物节拍（reveal），必须在 props 或 semantic_slots.required_references 中显式挂载核心信物/打脸证据道具（key_token / slap_evidence）！`,
          });
        }
      }

      // 1.2 景别特写检查：如果是 reveal 节拍或本镜关联了核心信物，景别必须是近景或特写
      if (isRevealBeat || hasKeyPropLinked) {
        if (!isCloseUp(shot.shot_type)) {
          violations.push({
            rule: 'INVARIANT_KEY_PROP_CLOSE_UP_REQUIRED',
            shot_number: shotNum,
            severity: 'warning',
            conflict_slots: ['shot_type'],
            message: `分镜 #${shotNum} 涉及核心身份信物/亮牌节拍（reveal），镜头景别必须使用特写或近景（当前为「${shot.shot_type || '未指定'}」），确保打脸信物在竖屏短剧中高辨识度夺焦！`,
          });
        }
      }

      // 2. 施压 (suppression) 与反转打脸 (slap_reversal / slap) 音效冲击力约束
      const isSuppressionOrSlap = ['suppression', 'slap_reversal', 'slap'].includes(beatType);
      if (isSuppressionOrSlap) {
        const allSfx = extractAllSfx(shot);
        const hasImpactSfx = allSfx.some((s) => IMPACT_SFX_REGEX.test(s));
        if (!hasImpactSfx) {
          violations.push({
            rule: 'INVARIANT_BEAT_AUDIO_IMPACT_MISSING',
            shot_number: shotNum,
            severity: 'warning',
            conflict_slots: ['sound_plan.sound_effects', 'sound_effect'],
            message: `分镜 #${shotNum} 为 ${beatType === 'suppression' ? '极限施压（suppression）' : '打脸反转（slap_reversal）'} 节拍，必须在 sound_plan.sound_effects 或 sound_effect 中配置重音刺入/打脸音效（如 sfx_sting/打脸音效/重音刺入），以强化短剧视听情绪冲击！`,
          });
        }
      }

      // 3. 极限施压 (suppression) 权力位阶与机位俯仰角契约
      if (beatType === 'suppression' && characterPowerMap.size > 0) {
        const charInfo = shotCharacterIds(shot);
        const visibleIds = [...new Set([...(charInfo.visible || []), ...(charInfo.semanticVisible || [])])];
        const visiblePowers = visibleIds.map((id) => characterPowerMap.get(id)).filter(Boolean);

        const hasDominant = visiblePowers.includes('dominant');
        const hasSuppressed = visiblePowers.includes('suppressed');

        const angleV = String(shot.angle_v || '').trim().toLowerCase();
        const isLowAngle = ['low', 'worm', '仰拍', '仰角'].includes(angleV);
        const isHighAngle = ['high', 'top_down', '俯拍', '俯角'].includes(angleV);

        // 压迫者单人或主导镜头：应采用仰角强化压迫感
        if (hasDominant && !hasSuppressed && isHighAngle) {
          violations.push({
            rule: 'INVARIANT_SUPPRESSION_ANGLE_MISMATCH',
            shot_number: shotNum,
            severity: 'warning',
            conflict_slots: ['angle_v'],
            message: `分镜 #${shotNum} 为极限施压（suppression）镜头，画内主要角色处于强势压迫位阶（dominant），机位建议采用仰拍（angle_v: "low"）以强化压迫与居高临下气势，避免使用俯拍（当前为「${shot.angle_v}」）削弱人物压迫感。`,
          });
        }

        // 被压迫者受辱镜头：应采用俯角强化屈辱与渺小感
        if (hasSuppressed && !hasDominant && isLowAngle) {
          violations.push({
            rule: 'INVARIANT_SUPPRESSION_ANGLE_MISMATCH',
            shot_number: shotNum,
            severity: 'warning',
            conflict_slots: ['angle_v'],
            message: `分镜 #${shotNum} 为极限施压（suppression）镜头，画内主要角色处于受压迫位阶（suppressed），机位建议采用俯拍（angle_v: "high"）以强化屈辱与被压迫感，避免使用仰拍（当前为「${shot.angle_v}」）误增威势。`,
          });
        }
      }
    });

    return violations;
  }
}

module.exports = BeatCinematographyRule;
