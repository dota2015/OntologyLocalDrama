/**
 * 门禁 2：音频视听合同检查（无对白必配 BGM，供给 H3）
 */
const BaseInvariantRule = require('./baseRule');

class AudioContractRule extends BaseInvariantRule {
  constructor() {
    super({
      id: 'RULE_AUDIO_CONTRACT',
      name: '音频视听合同',
      category: 'audio',
      defaultSeverity: 'error',
      description: '无对白且无旁白的静音镜头必须具备专属背景音乐提示词(bgm_prompt)',
    });
  }

  evaluate(context) {
    const shots = context.shots;
    const violations = [];
    if (!Array.isArray(shots)) return violations;

    shots.forEach((shot, idx) => {
      const shotNum = shot.shot_number || (idx + 1);
      const hasDialogue = !!(shot.dialogue && String(shot.dialogue).trim());
      const hasNarration = !!(shot.narration && String(shot.narration).trim());
      const bgmPrompt = String(shot.bgm_prompt || '').trim();

      if (!hasDialogue && !hasNarration) {
        if (!bgmPrompt || bgmPrompt === '无' || bgmPrompt === '无BGM' || bgmPrompt === '禁BGM') {
          violations.push({
            rule: 'INVARIANT_SILENT_SHOT_MISSING_BGM',
            shot_number: shotNum,
            severity: this.defaultSeverity,
            message: `分镜 ${shotNum} 无人物台词与旁白，但 bgm_prompt 为空。H3 等多模态视频模型需要专属背景音乐提示词（如紧迫电子脉冲、重低音打击乐等）来原生合成音画同步视频。`,
          });
        }
      }
    });

    return violations;
  }
}

module.exports = AudioContractRule;
