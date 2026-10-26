/**
 * 门禁 1：运镜动态感与固定镜头比例检查（严格少用固定镜头）
 */
const BaseInvariantRule = require('./baseRule');
const { CAMERA_MOVEMENTS } = require('../schema');

class MovementDynamismRule extends BaseInvariantRule {
  constructor() {
    super({
      id: 'RULE_MOVEMENT_DYNAMISM',
      name: '运镜动态感与连镜静态比',
      category: 'camera',
      defaultSeverity: 'error',
      description: '全片固定镜头占比需<=15%，严禁连续两个分镜使用静态固定镜头',
    });
  }

  evaluate(context) {
    const shots = context.shots;
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
            severity: this.defaultSeverity,
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
        severity: this.defaultSeverity,
        message: `全片固定镜头占比为 ${(staticRatio * 100).toFixed(1)}%（共 ${staticCount}/${total} 镜），严重超出 15% 上限。短剧切忌画面死板，绝大多数镜头必须采用推/拉/摇/跟/手持等动态运镜。`,
      });
    }

    return violations;
  }
}

module.exports = MovementDynamismRule;
