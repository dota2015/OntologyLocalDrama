const test = require('node:test');
const assert = require('node:assert/strict');

const { applyGeneralChatOptions, applyVolcChatOptions } = require('../src/services/aiClient');
const { compileImagePromptFromSlots, createCharacterVisualSlot } = require('../src/ontology/visualSlots');
const { VisualSlotCompletenessRule } = require('../src/ontology/rules/visualSlotCompletenessRule');

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

  const slot = createCharacterVisualSlot({
    name: '红狼',
    screen_position: '画面左侧',
    facing: '侧身朝向画面左侧',
    expression: '咬肌紧绷，瞳孔警惕聚焦',
    posture: '双膝半跪在碎石地面上身体压低',
    hands: '右手五指微张紧握战术匕首，左手护住胸前',
    prop_interaction: '食指按在刀柄防滑纹路边缘',
    appearance_details: '额角渗出冷汗浸湿碎发，抗撕裂战术背心布满泥痕',
    head_pose: '头部微侧正对前方',
    gaze: '目光锁定通道入口',
  });

  const prompt = compileImagePromptFromSlots(shot, [slot], { style: 'photorealistic, ultra-detailed' });
  assert.ok(prompt.includes('峡谷信号塔残破控制室；任务进行中·阴天白昼'));
  assert.ok(prompt.includes('前景右侧虚化遮挡'));
  assert.ok(prompt.includes('35mm宽银幕电影镜头'));
  assert.ok(prompt.includes('咬肌紧绷，瞳孔警惕聚焦'));
  assert.ok(prompt.includes('食指按在刀柄防滑纹路边缘'));
  assert.ok(prompt.includes('高反差冷色天光自天窗斜射'));
  assert.ok(prompt.includes('首帧静止画面'));
});

test('VisualSlotCompletenessRule detects boilerplate template phrases', () => {
  const rule = new VisualSlotCompletenessRule();
  const badShot = {
    shot_number: 1,
    characters: [1],
    character_visuals: [
      {
        character_id: 1,
        name: '红狼',
        screen_position: '画面左侧',
        facing: '正面面对镜头',
        head_pose: '头部正对前方',
        gaze: '目光专注注视前方',
        posture: '身体保持戒备低姿，重心稳固隐蔽',
        hands: '双手紧握装备保持待发状态',
      },
    ],
  };

  const violations = rule.evaluate({ shots: [badShot] });
  assert.ok(violations.some((v) => v.rule === 'INVARIANT_SLOT_BOILERPLATE_DETECTED'));
});

test('validateCharacterVisualSlots checks multi-character depth staging (near vs far)', () => {
  const { validateCharacterVisualSlots, synthesizeCharacterVisualSlots } = require('../src/ontology/visualSlots');

  // 1. 两角色处于完全相同坐标点 -> INVARIANT_SLOT_DUPLICATE_POSITION
  const duplicatePosShot = {
    shot_number: 38,
    characters: [1, 2],
  };
  const dupSlots = [
    createCharacterVisualSlot({ name: '露娜', screen_position: '画面左侧', facing: '正面', head_pose: '正对', gaze: '看前', posture: '靠桌站立', hands: '双手抱胸' }),
    createCharacterVisualSlot({ name: '红狼', screen_position: '画面左侧', facing: '正面', head_pose: '正对', gaze: '看前', posture: '半蹲低位', hands: '单手扶膝' }),
  ];
  const dupViolations = validateCharacterVisualSlots(duplicatePosShot, dupSlots);
  assert.ok(dupViolations.some((v) => v.rule === 'INVARIANT_SLOT_DUPLICATE_POSITION'));

  // 2. 两角色仅有横向左右（无任何前景/后景等纵深） -> INVARIANT_SLOT_MISSING_DEPTH_STAGING
  const flatShot = {
    shot_number: 39,
    characters: [1, 2],
  };
  const flatSlots = [
    createCharacterVisualSlot({ name: '露娜', screen_position: '画面左侧', facing: '面对', head_pose: '正对', gaze: '看前', posture: '靠桌站立', hands: '双手抱胸' }),
    createCharacterVisualSlot({ name: '红狼', screen_position: '画面右侧', facing: '面对', head_pose: '正对', gaze: '看前', posture: '半蹲低位', hands: '单手扶膝' }),
  ];
  const flatViolations = validateCharacterVisualSlots(flatShot, flatSlots);
  assert.ok(flatViolations.some((v) => v.rule === 'INVARIANT_SLOT_MISSING_DEPTH_STAGING'));

  // 3. 正确的 Z 轴前后纵深构图（前景过肩 vs 中景面对） -> 0 违规
  const depthShot = {
    shot_number: 40,
    characters: [1, 2],
  };
  const depthSlots = [
    createCharacterVisualSlot({ name: '红狼', depth_layer: 'foreground', screen_position: '画面左侧前景近景过肩', facing: '背向镜头', head_pose: '正对', gaze: '看前', posture: '半蹲低姿', hands: '手扶掩体' }),
    createCharacterVisualSlot({ name: '露娜', depth_layer: 'midground', screen_position: '画面右侧中景', facing: '正面面对镜头', head_pose: '微仰', gaze: '看前', posture: '身体前倾', hands: '按在控制台' }),
  ];
  const depthViolations = validateCharacterVisualSlots(depthShot, depthSlots);
  assert.equal(depthViolations.filter((v) => v.rule === 'INVARIANT_SLOT_MISSING_DEPTH_STAGING' || v.rule === 'INVARIANT_SLOT_DUPLICATE_POSITION').length, 0);

  // 4. synthesizeCharacterVisualSlots 自动分配错落纵深层级且不含模板套话
  const autoSlots = synthesizeCharacterVisualSlots({ characters: [1, 2], action: '两人双手握持战术步枪在废弃工厂控制室商议撤离路线。' }, [{ id: 1, name: '红狼' }, { id: 2, name: '露娜' }]);
  assert.equal(autoSlots[0].depth_layer, 'foreground');
  assert.equal(autoSlots[1].depth_layer, 'midground');
  assert.ok(!autoSlots[0].posture.includes('身体保持戒备低姿，重心稳固隐蔽'));
  assert.ok(!autoSlots[0].hands.includes('双手紧握装备保持待发状态'));
  assert.ok(autoSlots[0].expression);
  assert.ok(autoSlots[0].prop_interaction);
  assert.ok(autoSlots[0].appearance_details);
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
  const slot = createCharacterVisualSlot({
    name: '红狼',
    screen_position: '画面中央',
    facing: '正面面对镜头',
    head_pose: '微仰起头',
    gaze: '目光警惕如炬',
    posture: '双膝半跪身体压低机动待发',
    hands: '双手紧握战术武器贴腮瞄准',
  });
  const compiled = compileImagePromptFromSlots(minimalShot, [slot]);
  assert.doesNotMatch(compiled, /前景微虚|85mm|电影定焦/);
  assert.match(compiled, /side/);
  assert.ok(compiled.includes(slot.gaze));
  assert.ok(compiled.includes('首帧静止画面'));
});



