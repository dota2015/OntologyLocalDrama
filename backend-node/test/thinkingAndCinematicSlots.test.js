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

test('compileImagePromptFromSlots synthesizes all 5 cinematic layers', () => {
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
  assert.ok(prompt.includes('峡谷信号塔残破控制室（任务进行中·阴天白昼）'));
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

test('compileImagePromptFromSlots synthesizes missing layers from context with zero boilerplate', () => {
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
  // 必须包含推导的三层纵深、电影光学镜头参数、侧光照明反差
  assert.ok(compiled.includes('前景微虚'));
  assert.ok(compiled.includes('85mm电影定焦镜头抓拍'));
  assert.ok(compiled.includes('侧光照明'));
  assert.ok(compiled.includes('首帧静止画面'));
});

test('H3 multimodal slots format timecode cuts and integrated_multimodal_description', () => {
  const { synthesizeH3MultimodalSlots, formatH3Timestamp, synthesizeVideoSlots } = require('../src/ontology/videoSlots');

  // 1. 时间戳格式化
  assert.equal(formatH3Timestamp(3.5), '00:03.500');
  assert.equal(formatH3Timestamp(7), '00:07.000');
  assert.equal(formatH3Timestamp(0), '00:00.000');

  // 2. 长于6秒的镜头自动生成 [Shot 1] 与 [Shot 2] At 00:03.500 切换
  const multiCutShot = {
    duration: 7,
    shot_type: '中景',
    movement: 'push',
    action: '红狼沿货箱低姿冲向蜂医',
    result: '蜂医抬头看着他接近',
    dialogue: '蜂医: "我还能撑住。"',
    sound_effect: '子弹尖啸、碎石撞墙',
    bgm_prompt: '急促战术重低音脉冲',
  };

  const h3Slots = synthesizeH3MultimodalSlots(multiCutShot);
  assert.equal(h3Slots.shots.length, 2);
  assert.equal(h3Slots.shots[0].shot_number, 1);
  assert.equal(h3Slots.shots[0].timestamp, null);
  assert.equal(h3Slots.shots[1].shot_number, 2);
  assert.equal(h3Slots.shots[1].timestamp, '00:03.500');

  assert.ok(h3Slots.integrated_multimodal_description.includes('[Shot 1] Live-action, cinematic.'));
  assert.ok(h3Slots.integrated_multimodal_description.includes('[Shot 2] At 00:03.500, the camera cuts to'));
  assert.ok(h3Slots.overall_soundscape.includes('子弹尖啸、碎石撞墙'));
  assert.ok(h3Slots.non_diegetic_music.includes('急促战术重低音脉冲'));

  // 3. synthesizeVideoSlots 正确集成 h3_multimodal 槽位
  const fullVideoSlots = synthesizeVideoSlots(multiCutShot, []);
  assert.ok(fullVideoSlots.h3_multimodal);
  assert.equal(fullVideoSlots.h3_multimodal.shots.length, 2);
  assert.ok(Array.isArray(fullVideoSlots.shots_timeline));
  assert.equal(fullVideoSlots.shots_timeline.length, 2);
});

test('Video semantic slots timeline mapping and non-hallucinatory generic trajectory deduction', () => {
  const { synthesizeVideoSlots, compileH3MultimodalPrompt } = require('../src/ontology/videoSlots');

  const briefingShot = {
    duration: 6,
    shot_type: '中景',
    movement: 'tracking',
    characters: [27, 25],
    action: '第二次任务开启，露娜在峡谷入口展开任务简报界面，红狼站在对面查看。',
    result: '地图上的信号塔与北侧撤离线被标记。',
    dialogue: '露娜: "这次要护送设备到信号塔，再从北侧撤离。"',
    sound_effect: '风声、界面展开提示音、远处金属结构震动声',
    atmosphere: '谨慎',
  };

  const catalog = [
    { id: 27, name: '露娜' },
    { id: 25, name: '红狼' },
  ];

  const slots = synthesizeVideoSlots(briefingShot, catalog);

  // 1. 结构化时间线 shots_timeline
  assert.equal(slots.shots_timeline.length, 2);
  assert.equal(slots.shots_timeline[0].shot_number, 1);
  assert.equal(slots.shots_timeline[0].timestamp, null);
  assert.equal(slots.shots_timeline[1].shot_number, 2);
  assert.equal(slots.shots_timeline[1].timestamp, '00:03.000');

  // 2. 彻底杜绝飞扑硬编码幻觉
  slots.trajectories.forEach((t) => {
    assert.ok(!t.terminal_pose.includes('飞扑'), `角色 ${t.name} 的姿态不应出现飞扑幻觉: ${t.terminal_pose}`);
    assert.ok(!t.terminal_pose.includes('伸手抓向目标'), `角色 ${t.name} 不应出现伸手抓向目标`);
  });

  // 3. 露娜在 Shot 1 嘴型闭合，Shot 2 开口口型同步；红狼全程闭合
  const lunaShot1 = slots.shots_timeline[0].character_trajectories.find((t) => t.name === '露娜');
  const lunaShot2 = slots.shots_timeline[1].character_trajectories.find((t) => t.name === '露娜');
  const wolfShot2 = slots.shots_timeline[1].character_trajectories.find((t) => t.name === '红狼');
  assert.ok(lunaShot1.mouth_state.includes('双唇紧闭'));
  assert.ok(lunaShot2.mouth_state.includes('开口说话并同步口型'));
  assert.ok(wolfShot2.mouth_state.includes('双唇紧闭'));

  // 4. H3 专用编译器正确输出
  const h3Compiled = compileH3MultimodalPrompt(slots);
  assert.ok(h3Compiled.integrated_multimodal_description.includes('[Shot 1]'));
  assert.ok(h3Compiled.integrated_multimodal_description.includes('[Shot 2] At 00:03.000'));
  assert.ok(h3Compiled.integrated_multimodal_description.includes('露娜: “这次要护送设备到信号塔，再从北侧撤离。”'));
  assert.ok(h3Compiled.overall_soundscape.includes('界面展开提示音'));
});



