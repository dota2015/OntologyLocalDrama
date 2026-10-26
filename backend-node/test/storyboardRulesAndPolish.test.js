const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const promptI18n = require('../src/services/promptI18n');
const storytellingPrompts = require('../src/services/storytellingPrompts');
const { sanitizeFramePrompt } = require('../src/utils/framePromptSanitize');

describe('Storyboard Rules & Classic Video Prompt Polish', () => {
  it('getClassicVideoPromptPolishPrompt returns valid polish instruction', () => {
    const prompt = promptI18n.getClassicVideoPromptPolishPrompt();
    assert.ok(typeof prompt === 'string' && prompt.length > 100);
    assert.match(prompt, /分镜静帧 → 图生视频/);
    assert.match(prompt, /REQUIRED_COVERAGE_DIGEST/);
    assert.match(prompt, /RETENTION_CLAUSES_FROM_SOURCE/);
  });

  it('storyboardRules includes 4 core rules in zh and en', () => {
    const zh = storytellingPrompts.storyboardRules({ app: { language: 'zh' } });
    assert.match(zh, /刚性动作单元铁律/);
    assert.match(zh, /禁止画面文字\/UI交代剧情/);
    assert.match(zh, /推行短剧正反打语法/);
    assert.match(zh, /纯物理视觉描写/);

    const en = storytellingPrompts.storyboardRules({ app: { language: 'en' } });
    assert.match(en, /Rigid Single Action Unit/);
    assert.match(en, /Ban On-Screen Text\/UI/);
    assert.match(en, /Shot-Reverse-Shot Syntax/);
    assert.match(en, /Pure Physical Visual Description/);
  });

  it('framePromptSanitize strips literary metaphors and UI countdown noise', () => {
    const dirtyPrompt = '中景，平视正面，尾帧以红狼与蜂医形成高低对照，焦急与时间压力凝结在静止尾帧中，蜂医附近悬浮小幅救援倒计时界面，显示正在流逝的剩余十九秒，五至十五秒固定镜头结束后保持原机位，首尾视觉差异由红狼撑起后的上身占幅增加共同形成，红狼（参考图中的人物形象）坐于地上';
    const cleaned = sanitizeFramePrompt(dirtyPrompt, ['红狼', '蜂医'], ['红狼', '蜂医']);

    assert.doesNotMatch(cleaned, /高低对照/);
    assert.doesNotMatch(cleaned, /焦急与时间压力凝结/);
    assert.doesNotMatch(cleaned, /救援倒计时界面/);
    assert.doesNotMatch(cleaned, /显示正在流逝的剩余/);
    assert.doesNotMatch(cleaned, /保持原机位/);
    assert.doesNotMatch(cleaned, /首尾视觉差异由/);
    assert.match(cleaned, /红狼（参考图中的人物形象）/);
  });

  it('framePromptSanitize cleans dual-state transitions preventing cloned characters', () => {
    const transitionalPrompt = '蜂医由站姿变为地面倒卧，一只手伸向掩体，表情由短暂释然转为焦急，红狼撑起上身。';
    const cleaned = sanitizeFramePrompt(transitionalPrompt, ['红狼', '蜂医'], ['红狼', '蜂医']);
    assert.doesNotMatch(cleaned, /由站姿变为/);
    assert.doesNotMatch(cleaned, /由短暂释然转为/);
    assert.match(cleaned, /蜂医地面倒卧/);
    assert.match(cleaned, /表情焦急/);
  });

  it('storyboardSplitService parses JSON sub-shots properly', () => {
    const { extractJsonArray } = require('../src/services/storyboardSplitService');
    const jsonStr = `
    Some preamble commentary...
    \`\`\`json
    [
      { "title": "镜头A", "duration": 4, "shot_type": "中景", "action": "红狼撑起身体" },
      { "title": "镜头B", "duration": 5, "shot_type": "特写", "action": "蜂医倒在地上" }
    ]
    \`\`\`
    `;
    const res = extractJsonArray(jsonStr);
    assert.ok(Array.isArray(res));
    assert.equal(res.length, 2);
    assert.equal(res[0].title, '镜头A');
    assert.equal(res[1].title, '镜头B');
  });
});
