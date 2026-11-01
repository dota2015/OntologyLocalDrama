const test = require('node:test');
const assert = require('node:assert/strict');
const framePrompts = require('../src/services/framePromptService');

test('FL2VA first-frame contract preserves the Agent planned gaze target', () => {
  const contract = framePrompts.compileFirstFrameVisualContract({
    character_visuals: JSON.stringify([
      {
        character_id: 28,
        name: '苏晚',
        depth_layer: 'foreground',
        screen_position: '画面左侧前景贴近父亲肩背',
        facing: '四分之三侧身朝右',
        head_pose: '低头俯向父亲嘴角',
        gaze: '目光紧盯父亲嘴角鲜血',
        expression: '眉头紧锁，眼睛睁大',
        posture: '右膝跪地前俯托扶父亲',
        hands: '左臂托肩，右掌按在父亲胸口',
      },
    ]),
  });
  assert.match(contract, /头部姿态=低头俯向父亲嘴角/);
  assert.match(contract, /视线落点=目光紧盯父亲嘴角鲜血/);
  assert.match(contract, /不得改成直视摄影机或无目标地看向空气/);
});
