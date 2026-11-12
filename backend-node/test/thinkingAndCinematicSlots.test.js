const test = require('node:test');
const assert = require('node:assert/strict');

const { applyGeneralChatOptions, applyVolcChatOptions } = require('../src/services/aiClient');
const { compileImagePromptFromSlots, validateCharacterVisualSlots } = require('../src/ontology/visualSlots');
const { VisualSlotCompletenessRule } = require('../src/ontology/rules/visualSlotCompletenessRule');

function structuredSlot(overrides = {}) {
  return {
    character_id: 1,
    name: '红狼',
    depth_layer: 'midground',
    screen_position: 'left_midground',
    environmental_anchor: '碎石掩体后',
    facing: 'left_profile',
    facing_target_id: null,
    head_pose: 'neutral',
    gaze_type: 'scene',
    gaze_target_id: null,
    gaze_target_label: '通道入口',
    posture: 'kneeling',
    hands_state: 'holding_object',
    hands_object_id: null,
    hands_target_id: null,
    expression: 'alert',
    expression_detail: '咬肌紧绷，瞳孔警惕聚焦',
    appearance_details: '额角渗出冷汗浸湿碎发，抗撕裂战术背心布满泥痕',
    ...overrides,
  };
}

test('applyGeneralChatOptions injects reasoning_effort for enabled thinking', () => {
  const config = {
    provider: 'openai',
    settings: JSON.stringify({ thinking: 'enabled', reasoning_effort: 'high' }),
  };
  const body = { model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'test' }] };
  const res = applyGeneralChatOptions(config, body);
  assert.equal(res.reasoning_effort, 'high');
});

test('applyGeneralChatOptions maps Qwen thinking to vLLM chat template kwargs', () => {
  const disabled = applyGeneralChatOptions({
    settings: JSON.stringify({ thinking: 'disabled' }),
  }, {
    model: 'qwen3_5_122b',
    messages: [{ role: 'user', content: 'test' }],
  });
  assert.deepEqual(disabled.chat_template_kwargs, { enable_thinking: false });
  assert.equal(disabled.reasoning_effort, undefined);

  const enabled = applyGeneralChatOptions({
    settings: JSON.stringify({ thinking: 'enabled', reasoning_effort: 'medium' }),
  }, {
    model: 'qwen3_5_122b',
    messages: [{ role: 'user', content: 'test' }],
    chat_template_kwargs: { custom_flag: 'kept' },
  });
  assert.deepEqual(enabled.chat_template_kwargs, { custom_flag: 'kept', enable_thinking: true });
  assert.equal(enabled.reasoning_effort, 'medium');
});

test('applyVolcChatOptions enables thinking and sets reasoning_effort on Ark models when configured', () => {
  const arkConfig = {
    provider: 'volcengine',
    base_url: 'https://ark.cn-beijing.volces.com/api/v3',
    settings: JSON.stringify({ thinking: 'enabled', reasoning_effort: 'medium' }),
  };
  const body = { model: 'deepseek-v4-flash-ga-260731', messages: [{ role: 'user', content: 'test' }] };
  const res = applyVolcChatOptions(arkConfig, body);
  assert.deepEqual(res.thinking, { type: 'enabled' });
  assert.equal(res.reasoning_effort, 'medium');
});

test('compileImagePromptFromSlots preserves explicitly planned cinematic layers', () => {
  const shot = {
    location: '峡谷信号塔残破控制室',
    time: '任务进行中·阴天白昼',
    environment_depth: '前景右侧虚化遮挡着锈蚀钢构件，中景地面散落碎石与断裂线缆，背景纵深处是防爆玻璃窗',
    shot_type: '近景',
    angle_h: 'front_left',
    angle_v: 'eye_level',
    cinematic_lens: '35mm宽银幕电影镜头',
    lighting_chiaroscuro: '高反差冷色天光自天窗斜射，荧光屏在面颊勾勒出幽蓝侧轮廓光',
  };

  const slot = structuredSlot();

  const prompt = compileImagePromptFromSlots(shot, [slot], { style: 'photorealistic, ultra-detailed' });
  assert.ok(prompt.includes('峡谷信号塔残破控制室；任务进行中·阴天白昼'));
  assert.ok(prompt.includes('前景右侧虚化遮挡'));
  assert.ok(prompt.includes('35mm宽银幕电影镜头'));
  assert.ok(prompt.includes('咬肌紧绷，瞳孔警惕聚焦'));
  assert.ok(prompt.includes('通道入口'));
  assert.ok(prompt.includes('高反差冷色天光自天窗斜射'));
  assert.ok(prompt.includes('首帧静止画面'));
});

test('VisualSlotCompletenessRule requires structured visual slots and rejects empty visuals or V1 strings', () => {
  const rule = new VisualSlotCompletenessRule();
  const missingVisuals = { shot_number: 1, characters: [1], character_visuals: [] };
  assert.ok(rule.evaluate({ shots: [missingVisuals] }).some((v) => v.rule === 'INVARIANT_CHARACTER_VISUAL_SLOTS_REQUIRED'));

  const v1Shot = {
    shot_number: 2,
    characters: [1],
    character_visuals: [{ character_id: 1, name: '红狼', screen_position: '画面左侧', facing: '正面', head_pose: '正对', gaze: '看前', posture: '站立', hands: '握枪' }],
  };
  assert.ok(rule.evaluate({ shots: [v1Shot] }).some((v) => v.rule === 'INVARIANT_VISUAL_ENUM_INVALID'));
});

test('validateCharacterVisualSlots checks multi-character duplicate screen_position under structured_sync', () => {
  const duplicatePosShot = { shot_number: 38, characters: [1, 2] };
  const dupSlots = [
    structuredSlot({ character_id: 1, name: '露娜', screen_position: 'left_foreground', depth_layer: 'foreground' }),
    structuredSlot({ character_id: 2, name: '红狼', screen_position: 'left_foreground', depth_layer: 'foreground' }),
  ];
  const dupViolations = validateCharacterVisualSlots(duplicatePosShot, dupSlots);
  assert.ok(dupViolations.some((v) => v.rule === 'INVARIANT_SLOT_DUPLICATE_POSITION'));

  const depthShot = { shot_number: 40, characters: [1, 2] };
  const depthSlots = [
    structuredSlot({ character_id: 1, name: '红狼', depth_layer: 'foreground', screen_position: 'left_foreground', facing: 'back_camera' }),
    structuredSlot({ character_id: 2, name: '露娜', depth_layer: 'midground', screen_position: 'right_midground', facing: 'front_camera' }),
  ];
  const depthViolations = validateCharacterVisualSlots(depthShot, depthSlots);
  assert.equal(depthViolations.length, 0);
});

test('compileImagePromptFromSlots does not invent missing lens, depth or lighting details', () => {
  const minimalShot = {
    location: '废弃工厂内部战斗区',
    time: '阴天白昼',
    shot_type: '特写',
    angle_v: 'low',
    angle_h: 'front_left',
    lighting_style: 'side',
  };
  const slot = structuredSlot({ gaze_target_label: '高窗火力点' });
  const compiled = compileImagePromptFromSlots(minimalShot, [slot]);
  assert.doesNotMatch(compiled, /前景微虚|85mm|电影定焦/);
  assert.match(compiled, /side/);
  assert.ok(compiled.includes('高窗火力点'));
  assert.ok(compiled.includes('首帧静止画面'));
});



