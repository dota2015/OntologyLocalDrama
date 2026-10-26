/**
 * 门禁 4：纯物理描写与禁止UI/文字交代剧情检查
 */
const BaseInvariantRule = require('./baseRule');

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

const FORBIDDEN_UI_TEXT = [
  /倒计时\s*\d+\s*秒/,
  /悬浮.*倒计时/,
  /屏幕小字/,
  /浮动UI/,
  /血条/,
];

class PhysicalDescriptionRule extends BaseInvariantRule {
  constructor() {
    super({
      id: 'RULE_PHYSICAL_DESCRIPTION',
      name: '纯物理描写与禁止UI文字',
      category: 'prompt',
      defaultSeverity: 'error',
      description: '提示词必须纯写实物理姿态与真实光影，禁止文学修辞、心理隐喻与UI文字渲染',
    });
  }

  evaluate(context) {
    const shots = context.shots;
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
}

module.exports = {
  PhysicalDescriptionRule,
  FORBIDDEN_METAPHORS,
  FORBIDDEN_UI_TEXT,
};
