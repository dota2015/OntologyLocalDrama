/**
 * 影视视听本体门禁：镜头起落幅完整性与镜头过渡审查（Shot Arc & Transition Continuity Rule）
 * 审查每个分镜是否具备完整的视听运动弧线（起幅态 start_framing、落幅态 end_framing、与下一镜过渡 transition_to_next）
 */
const BaseInvariantRule = require('./baseRule');

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) { return null; }
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) { return []; }
}

function hasStructuredGazeTarget(shot) {
  const visuals = parseArray(shot?.character_visuals);
  const video = parseObject(shot?.video_slots);
  const trajectories = Array.isArray(video?.shots_timeline)
    ? video.shots_timeline.flatMap((seg) => (Array.isArray(seg?.character_trajectories) ? seg.character_trajectories : []))
    : [];
  const entries = [...visuals, ...trajectories];
  if (entries.length === 0) return true;
  return entries.some((item) => {
    const gazeType = String(item?.gaze_type || '').trim();
    const hasTarget = item?.gaze_target_id != null || Boolean(String(item?.gaze_target_label || '').trim());
    return Boolean(gazeType && gazeType !== 'none' && hasTarget);
  });
}

class ShotTransitionContinuityRule extends BaseInvariantRule {
  constructor() {
    super({
      id: 'RULE_SHOT_TRANSITION_CONTINUITY',
      name: '镜头时序运动弧线与过渡连续性',
      category: 'continuity',
      defaultSeverity: 'warning',
      description: '审查镜头起幅构图、落幅定格与过渡承接的完整性，防止镜头前后脱节',
    });
  }

  evaluate(context) {
    const shots = context.shots;
    const violations = [];
    if (!Array.isArray(shots) || shots.length === 0) return violations;

    shots.forEach((shot, idx) => {
      const shotNum = shot.shot_number || (idx + 1);
      const hasContent = Boolean(shot.action || shot.layout_description || shot.character_visuals || shot.image_prompt);
      const semantic = parseObject(shot.semantic_slots);
      const incoming = semantic?.continuity_from_previous || parseObject(shot.continuity_from_previous);

      // 1. 检查起幅构图（仅当分镜有动作/构图内容时检查）
      if (hasContent) {
        const startFraming = String(shot.start_framing || '').trim();
        const layoutDesc = String(shot.layout_description || '').trim();
        if (!startFraming && !layoutDesc) {
          violations.push({
            rule: 'INVARIANT_MISSING_START_FRAMING',
            shot_number: shotNum,
            severity: this.defaultSeverity,
            message: `分镜 ${shotNum} 缺少起幅构图（start_framing）或空间布局描写，导致画面开端机位与人物初始姿态不明确。`,
          });
        }
      }

      // 2. 检查落幅构图（非最后一镜时，落幅为下镜提供视觉承接）
      if (hasContent && idx < shots.length - 1) {
        const endFraming = String(shot.end_framing || '').trim();
        const actionResult = String(shot.result || '').trim();
        if (!endFraming && !actionResult) {
          violations.push({
            rule: 'INVARIANT_MISSING_END_FRAMING',
            shot_number: shotNum,
            severity: this.defaultSeverity,
            message: `分镜 ${shotNum} 缺少落幅定格描写（end_framing）或动作收束结果，无法为下一个镜头提供准确的视觉/动作承接锚点。`,
          });
        }
      }

      // 3. 检查镜头间视线或动作过渡逻辑
      if (idx < shots.length - 1) {
        const transition = String(shot.transition_to_next || shot.transition || '').trim();
        const nextShot = shots[idx + 1];
        const nextShotNum = nextShot.shot_number || (idx + 2);

        // 如果同一场景且两人对话，但未提供过渡逻辑
        const sameScene = shot.scene_id != null && nextShot.scene_id != null && shot.scene_id === nextShot.scene_id;
        if (sameScene && shot.dialogue && nextShot.dialogue && !transition) {
          violations.push({
            rule: 'INVARIANT_MISSING_TRANSITION_LOGIC',
            shot_number: shotNum,
            severity: this.defaultSeverity,
            message: `分镜 ${shotNum} 与分镜 ${nextShotNum} 属于同场景对话交锋，但未声明过渡衔接方式（transition_to_next，如正反打 ots_reverse、视线匹配 eyeline_match 或景深拉焦 rack_focus），易造成镜头间生硬切换。`,
          });
        }
      }

      // Every generated shot after the opening needs an incoming contract. The
      // existing transition_to_next field only describes the outgoing cut and
      // cannot tell H3 how the current shot begins. Legacy rows without
      // semantic_slots are left untouched; newly planned semantic shots are
      // rejected when the contract is missing or incomplete.
      if (idx > 0 && semantic) {
        const relation = String(incoming?.relationship || semantic.continuity_type || '').trim();
        const sameScene = shot.scene_id != null && shots[idx - 1].scene_id != null && shot.scene_id === shots[idx - 1].scene_id;
        const severity = relation === 'hard_cut' && incoming ? this.defaultSeverity : (sameScene || relation !== 'hard_cut' ? 'error' : this.defaultSeverity);
        if (!incoming) {
          violations.push({
            rule: 'INVARIANT_MISSING_INCOMING_CONTINUITY',
            shot_number: shotNum,
            severity,
            conflict_slots: ['semantic_slots.continuity_from_previous', 'start_framing', 'end_framing'],
            message: `分镜 ${shotNum} 缺少从上一镜进入的连续性合同。transition_to_next 只描述本镜结束后的去向，必须补齐 previous_end_state、entry_state 与 causal_link；不能让 H3 独立猜测本镜如何接上上一镜。`,
          });
        } else {
          const missing = ['relationship', 'previous_end_state', 'entry_state', 'causal_link']
            .filter((key) => !String(incoming[key] ?? '').trim());
          if (missing.length) {
            violations.push({
              rule: 'INVARIANT_INCOMING_CONTINUITY_INCOMPLETE',
              shot_number: shotNum,
              severity: 'error',
              conflict_slots: missing.map((key) => `semantic_slots.continuity_from_previous.${key}`),
              message: `分镜 ${shotNum} 的上一镜承接合同缺少 ${missing.join('、')}，无法确定本镜开头的角色、空间与因果状态。`,
            });
          }
          if (String(incoming.relationship || '').trim() === 'eyeline_match' && !hasStructuredGazeTarget(shot)) {
            violations.push({
              rule: 'INVARIANT_EYELINE_MATCH_WITHOUT_EYE_TARGET',
              shot_number: shotNum,
              severity: 'error',
              conflict_slots: ['semantic_slots.continuity_from_previous', 'character_visuals.gaze_type', 'character_visuals.gaze_target_label'],
              message: `分镜 ${shotNum} 标记为 eyeline_match，但 character_visuals/character_trajectories 中未声明结构化视线类型（gaze_type != "none"）及具体目标（gaze_target_id 或 gaze_target_label），不能使用视线匹配。`,
            });
          }
        }
      }
    });

    return violations;
  }
}

module.exports = ShotTransitionContinuityRule;
