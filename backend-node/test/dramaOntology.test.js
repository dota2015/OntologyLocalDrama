const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
  createCharacterEntity,
  createSceneSpatialEntity,
  createShotEntity,
  createPropEntity,
  CAMERA_MOVEMENTS,
} = require('../src/ontology/schema');
const {
  checkMovementDynamism,
  checkAudioContract,
  checkSpeechTiming,
  checkVisualSlotCompleteness,
  checkVideoSlots,
  checkCrowdControl,
  checkPhysicalVisualDescription,
  checkSpatialContinuity,
  checkPropEraAndScale,
  checkObsoleteAssets,
  validateAllInvariants,
} = require('../src/ontology/invariants');
const {
  createCharacterVisualSlot,
  validateCharacterVisualSlots,
  compileImagePromptFromSlots,
  compileLastFramePromptFromSlots,
  synthesizeCharacterVisualSlots,
  synthesizeLastFrameVisualSlots,
} = require('../src/ontology/visualSlots');
const {
  createVideoSemanticSlots,
  validateVideoSlots,
  compileVideoPromptFromSlots,
  synthesizeVideoSlots,
} = require('../src/ontology/videoSlots');
const { compileDramaSemanticPackage } = require('../src/ontology/semanticPackage');
const { refineSingleStoryboard } = require('../src/ontology/directorAgent');
const { autocompleteEntityFromScript } = require('../src/ontology/extractionAgent');
const aiClient = require('../src/services/aiClient');

describe('Audiovisual Drama Ontology & Semantic Invariants', () => {
  let db;

  before(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE dramas (id INTEGER PRIMARY KEY, title TEXT, genre TEXT, style TEXT, era TEXT, metadata TEXT, deleted_at TEXT);
      CREATE TABLE episodes (id INTEGER PRIMARY KEY, drama_id INTEGER, episode_number INTEGER, title TEXT, duration INTEGER, script_content TEXT, deleted_at TEXT);
      CREATE TABLE characters (id INTEGER PRIMARY KEY, drama_id INTEGER, name TEXT, gender TEXT, role TEXT, appearance TEXT, description TEXT, current_stage_id INTEGER, identity_anchors TEXT, voice_id TEXT, custom_voice_id TEXT, speed REAL, pitch REAL, deleted_at TEXT);
      CREATE TABLE scenes (id INTEGER PRIMARY KEY, drama_id INTEGER, location TEXT, time TEXT, prompt TEXT, deleted_at TEXT);
      CREATE TABLE props (id INTEGER PRIMARY KEY, drama_id INTEGER, name TEXT, type TEXT, description TEXT, physical_scale TEXT, image_prompt TEXT, deleted_at TEXT);
      CREATE TABLE storyboards (id INTEGER PRIMARY KEY, episode_id INTEGER, scene_id INTEGER, storyboard_number INTEGER, title TEXT, description TEXT, location TEXT, time TEXT, duration INTEGER, dialogue TEXT, narration TEXT, action TEXT, result TEXT, atmosphere TEXT, emotion TEXT, movement TEXT, lighting_style TEXT, depth_of_field TEXT, angle_h TEXT, angle_v TEXT, angle_s TEXT, shot_type TEXT, bgm_prompt TEXT, sound_effect TEXT, layout_description TEXT, characters TEXT, image_prompt TEXT, video_prompt TEXT, polished_prompt TEXT, continuity_snapshot TEXT, status TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT);

      INSERT INTO dramas (id, title, genre, style, era, deleted_at) VALUES (1, '三角洲行动', '军事动作', '写实电影感', 'modern', NULL);
      INSERT INTO episodes VALUES (10, 1, 1, '黑鹰突围', 60, '红狼与蜂医在仓库遭遇埋伏，露娜在远程支援。', NULL);
      INSERT INTO characters VALUES (101, 1, '红狼', '男', '突击手', '精干短发，身穿黑色战术背心', '突击干员', NULL, '{"gender":"male"}', 'voice_1', NULL, 1.0, 0, NULL);
      INSERT INTO characters VALUES (102, 1, '蜂医', '女', '医疗兵', '金发马尾，身穿白色医疗战术服', '医疗干员', NULL, '{"gender":"female"}', 'voice_2', NULL, 1.0, 0, NULL);
      INSERT INTO scenes VALUES (201, 1, '废弃仓库掩体区', '黄昏', '昏暗废弃仓库，右侧有高大木箱掩体，残阳从高窗射入', NULL);
      INSERT INTO props VALUES (301, 1, '军用情报箱', '证物', '黑色金属箱', '长约45cm，放置于木箱表面', '黑色战术密码箱', NULL);
      INSERT INTO storyboards (id, episode_id, scene_id, storyboard_number, title, description, location, time, duration, dialogue, narration, action, result, atmosphere, emotion, movement, lighting_style, depth_of_field, angle_h, angle_v, angle_s, shot_type, bgm_prompt, sound_effect, layout_description, characters, image_prompt, video_prompt, polished_prompt, continuity_snapshot, status, created_at, updated_at, deleted_at) VALUES (501, 10, 201, 1, '仓库对峙', '红狼在木箱后', '废弃仓库掩体区', '黄昏', 5, '', '', '红狼隐蔽在木箱后探头观察', '发现敌情', '紧张', '紧张', 'static', 'dramatic', 'medium', 'front', 'eye_level', 'medium', '中景', '', '', '红狼在右侧掩体后', '[101]', '', '', '', NULL, 'pending', '2026-10-24', '2026-10-24', NULL);
    `);
  });

  after(() => {
    if (db) db.close();
  });

  it('Schema entity factories construct strongly typed ontology objects', () => {
    const char = createCharacterEntity({ id: 1, name: '红狼', role: '突击手' });
    assert.equal(char.entity_type, 'character');
    assert.equal(char.name, '红狼');

    const scene = createSceneSpatialEntity({ id: 2, location: '掩体区', landmarks: ['cover', 'doorway'] });
    assert.equal(scene.entity_type, 'scene_spatial');
    assert.deepEqual(scene.landmarks, ['cover', 'doorway']);

    const prop = createPropEntity({ id: 3, name: '密码箱', physicalScale: '40cm' });
    assert.equal(prop.entity_type, 'prop');
    assert.equal(prop.physical_scale, '40cm');

    const shot = createShotEntity({ shot_number: 1, movement: 'push' });
    assert.equal(shot.entity_type, 'shot');
    assert.equal(shot.movement, 'push');
  });

  it('Invariant checkMovementDynamism detects static shot ratio > 15% and consecutive statics', () => {
    const badShots = [
      { shot_number: 1, movement: 'static' },
      { shot_number: 2, movement: 'static' },
      { shot_number: 3, movement: 'push' },
      { shot_number: 4, movement: 'static' },
      { shot_number: 5, movement: 'static' },
      { shot_number: 6, movement: 'static' },
    ];
    const violations = checkMovementDynamism(badShots);
    assert.ok(violations.length >= 2);
    assert.ok(violations.some((v) => v.rule === 'INVARIANT_NO_CONSECUTIVE_STATIC'));
    assert.ok(violations.some((v) => v.rule === 'INVARIANT_STATIC_RATIO_EXCEEDED'));

    const goodShots = [
      { shot_number: 1, movement: 'push' },
      { shot_number: 2, movement: 'tracking' },
      { shot_number: 3, movement: 'handheld' },
      { shot_number: 4, movement: 'pan' },
      { shot_number: 5, movement: 'pull' },
      { shot_number: 6, movement: 'static' }, // 1/6 = 16.6%, let's keep <15%
      { shot_number: 7, movement: 'tracking' },
    ];
    const goodViolations = checkMovementDynamism(goodShots);
    assert.equal(goodViolations.length, 0);
  });

  it('Invariant checkAudioContract flags silent shots with missing BGM prompt', () => {
    const shots = [
      { shot_number: 1, dialogue: '', narration: '', bgm_prompt: '' },
      { shot_number: 2, dialogue: '红狼："快撤！"', narration: '', bgm_prompt: '' },
      { shot_number: 3, dialogue: '', narration: '', bgm_prompt: '紧张低频重音脉冲' },
    ];
    const violations = checkAudioContract(shots);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].shot_number, 1);
    assert.equal(violations[0].rule, 'INVARIANT_SILENT_SHOT_MISSING_BGM');
  });

  it('Invariant checkCrowdControl flags single shots with >3 characters (crowd overload)', () => {
    const shots = [
      { shot_number: 1, character_ids: [1, 2] },
      { shot_number: 2, character_ids: [1, 2, 3] }, // 3人完全合法，符合用户需求
      { shot_number: 3, character_ids: [1, 2, 3, 4] }, // >3人过载触发硬门禁
    ];
    const violations = checkCrowdControl(shots);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].shot_number, 3);
    assert.equal(violations[0].rule, 'INVARIANT_CROWD_COLLAPSE_RISK');
  });

  it('Invariant checkPhysicalVisualDescription catches literary metaphors and UI countdowns', () => {
    const badShots = [
      { shot_number: 1, action: '红狼与蜂医形成高低对照，焦急凝结在空气中' },
      { shot_number: 2, action: '画面右上角悬浮救援倒计时19秒' },
    ];
    const violations = checkPhysicalVisualDescription(badShots);
    assert.ok(violations.length >= 2);
    assert.ok(violations.some((v) => v.rule === 'INVARIANT_LITERARY_METAPHOR_FORBIDDEN'));
    assert.ok(violations.some((v) => v.rule === 'INVARIANT_UI_TEXT_IN_PROMPT_FORBIDDEN'));
  });

  it('Invariant checkSpatialContinuity detects instant character jump cuts in same scene & angle', () => {
    const shots = [
      { shot_number: 1, scene_id: 1, angle_h: 'front', angle_v: 'eye_level', shot_type: '中景', character_ids: [101] },
      { shot_number: 2, scene_id: 1, angle_h: 'front', angle_v: 'eye_level', shot_type: '中景', character_ids: [102] },
    ];
    const violations = checkSpatialContinuity(shots);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].rule, 'INVARIANT_SPATIAL_JUMP_CUT');
  });

  it('Invariant checkPropEraAndScale flags modern gadgets in ancient dramas', () => {
    const props = [
      { id: 1, name: '青铜长剑', physical_scale: '长约80cm' },
      { id: 2, name: '智能手机', description: '主角拿出的苹果手机' },
    ];
    const violations = checkPropEraAndScale(props, 'ancient');
    assert.ok(violations.some((v) => v.rule === 'INVARIANT_PROP_ANACHRONISM'));
  });

  it('compileDramaSemanticPackage packages immutable drama assets with revision hash', () => {
    const pkg = compileDramaSemanticPackage(db, 10);
    assert.ok(pkg.semantic_revision.startsWith('sem_rev_10_'));
    assert.equal(pkg.drama.title, '三角洲行动');
    assert.equal(pkg.catalogs.characters.length, 2);
    assert.equal(pkg.catalogs.scenes.length, 1);
    assert.equal(pkg.catalogs.props.length, 1);

    const char = pkg.getCharacter(101);
    assert.equal(char.name, '红狼');
    const scene = pkg.getScene(201);
    assert.ok(scene.landmarks.includes('cover'));

    const digest = pkg.getSystemDigest();
    assert.match(digest, /三角洲行动/);
    assert.match(digest, /红狼/);
    assert.match(digest, /废弃仓库/);
  });

  it('refineSingleStoryboard performs targeted micro shot adjustment with ontology & continuity memory', async (t) => {
    t.mock.method(aiClient, 'generateText', async (database, logger, kind, user, system) => {
      assert.match(system, /不可变本体世界观契约/);
      assert.match(user, /用户导演直指定向微调指令/);
      assert.match(user, /红狼/);
      return JSON.stringify({
        title: '拔枪特写',
        scene_id: 201,
        characters: [101],
        shot_type: '特写',
        angle_h: 'front_left',
        angle_v: 'low',
        angle_s: 'close_up',
        movement: 'push',
        lighting_style: 'side',
        depth_of_field: 'shallow',
        duration: 4,
        action: '红狼眼神锐利，迅速拔出手枪指向前方',
        result: '锁定目标',
        dialogue: '',
        bgm_prompt: '急促的心跳脉冲与低音大提琴拉弦音，极度紧绷',
        sound_effect: '手枪上膛金属咔哒声',
        layout_description: '红狼位于画面中心偏右，手枪长约20cm位于前景近景特写',
        emotion: '决绝',
        polished_prompt: '写实电影感，红狼面部特写，坚毅眼神，黑色战术背心，冷峻侧光，浅景深',
      });
    });

    const result = await refineSingleStoryboard(db, { info() {}, warn() {}, error() {} }, {}, 501, '改成拔枪特写，微推运镜，加紧迫BGM');
    assert.equal(result.storyboard.shot_type, '特写');
    assert.equal(result.storyboard.movement, 'push');
    assert.equal(result.storyboard.lighting_style, 'side');
    assert.equal(result.storyboard.action, '红狼眼神锐利，迅速拔出手枪指向前方');
    assert.ok(result.storyboard.bgm_prompt.includes('心跳脉冲'));
    assert.ok(result.storyboard.continuity_snapshot.includes('红狼'));
  });

  it('checkObsoleteAssets detects characters, props, scenes no longer in script or storyboards', () => {
    const catalogs = {
      characters: [{ id: 101, name: '红狼' }, { id: 999, name: '老李头' }],
      props: [{ id: 301, name: '军用情报箱' }, { id: 998, name: '算盘' }],
      scenes: [{ id: 201, location: '废弃仓库掩体区' }, { id: 997, location: '古城旧客栈' }],
    };
    const script = '红狼在废弃仓库掩体区观察，发现了军用情报箱。';
    const shots = [{ storyboard_number: 1, characters: '[101]', prop_ids: [301], scene_id: 201 }];

    const violations = checkObsoleteAssets(catalogs, script, shots);
    assert.equal(violations.length, 3);
    assert.ok(violations.some((v) => v.asset_type === 'character' && v.asset_id === 999));
    assert.ok(violations.some((v) => v.asset_type === 'prop' && v.asset_id === 998));
    assert.ok(violations.some((v) => v.asset_type === 'scene' && v.asset_id === 997));
  });

  it('Invariant checkSpeechTiming flags dialogue exceeding duration budget', () => {
    const badShots = [
      {
        shot_number: 2,
        duration: 6,
        dialogue: '露娜: "红狼，别从正面过去！敌人在高台和仓库二层交叉射击，先等我找安全路线！"',
      },
    ];
    const violations = checkSpeechTiming(badShots);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].shot_number, 2);
    assert.equal(violations[0].rule, 'INVARIANT_SPEECH_OVER_BUDGET');
    assert.match(violations[0].message, /超出时长预算/);

    const goodShots = [
      {
        shot_number: 2,
        duration: 7,
        dialogue: '露娜: "红狼，别从正面过去！敌人在高台和仓库二层交叉射击，先等我找安全路线！"',
      },
      {
        shot_number: 3,
        duration: 5,
        dialogue: '红狼："明白！"',
      },
    ];
    const goodViolations = checkSpeechTiming(goodShots);
    assert.equal(goodViolations.length, 0);
  });

  it('Invariant checkVisualSlotCompleteness flags missing facing, posture, hands, gaze, and clone trajectory', () => {
    // 1. 槽位缺失测试
    const incompleteSlotShot = {
      shot_number: 1,
      characters: '[101]',
      character_visuals: [
        {
          character_id: 101,
          name: '红狼',
          facing: '', // 缺少朝向
          head_pose: '',
          gaze: '',
          posture: '站立',
          hands: '空手',
        },
      ],
    };
    const v1 = checkVisualSlotCompleteness([incompleteSlotShot]);
    assert.ok(v1.some((v) => v.rule === 'INVARIANT_SLOT_MISSING_FACING'));
    assert.ok(v1.some((v) => v.rule === 'INVARIANT_SLOT_MISSING_HEAD_POSE'));

    // 2. 轨迹位移导致的克隆人风险测试（“从A点跑到了B点”）
    const cloneRiskShot = {
      shot_number: 4,
      characters: '[101]',
      character_visuals: [
        {
          character_id: 101,
          name: '红狼',
          screen_position: '画面中央',
          facing: '背向镜头',
          spatial_anchor: '画面中央从掩体后冲出跑向工厂侧门', // 多位置轨迹！
          head_pose: '头部正对前方',
          gaze: '目光注视前方',
          posture: '大步奔冲',
          hands: '双手紧握武器',
        },
      ],
    };
    const v2 = checkVisualSlotCompleteness([cloneRiskShot]);
    const cloneViolation = v2.find((v) => v.rule === 'INVARIANT_MULTI_POSITION_CLONE_RISK');
    assert.ok(cloneViolation);
    assert.match(cloneViolation.message, /克隆人/);

    // 3. 完整合法的单一静态槽位
    const goodShot = {
      shot_number: 5,
      characters: '[101]',
      character_visuals: [
        {
          character_id: 101,
          name: '红狼',
          facing: '侧身朝向画面右侧',
          spatial_anchor: '画面中央装卸道路前',
          head_pose: '头部微侧向右',
          gaze: '锐利目光警惕锁定前方通道',
          posture: '单膝跪地压低重心隐蔽',
          hands: '双手握持战术武器呈戒备姿态',
        },
      ],
    };
    const v3 = checkVisualSlotCompleteness([goodShot]);
    assert.equal(v3.length, 0);
  });

  it('compileImagePromptFromSlots and synthesizeCharacterVisualSlots assemble complete static frame prompts', () => {
    const shot = {
      shot_number: 1,
      location: '废弃工厂内部战斗区',
      time: '任务进行中·阴天白昼',
      shot_type: '近景',
      angle_h: 'front_left',
      angle_v: 'eye_level',
      characters: [102],
      action: '露娜伏在低矮掩体后，抬头观察高台与仓库二层窗口，右手按住通讯器位置。',
    };

    const slots = synthesizeCharacterVisualSlots(shot, [{ id: 102, name: '露娜' }]);
    assert.equal(slots.length, 1);
    assert.equal(slots[0].name, '露娜');
    assert.ok(slots[0].facing.includes('朝向画面左侧') || slots[0].facing.includes('正面'));
    assert.ok(slots[0].head_pose.includes('仰') || slots[0].head_pose.includes('头'));
    assert.ok(slots[0].gaze.includes('锁定') || slots[0].gaze.includes('目光'));
    assert.ok(slots[0].hands.includes('通讯') || slots[0].hands.includes('手'));

    const prompt = compileImagePromptFromSlots(shot, slots, { style: 'photorealistic, ultra-detailed, 8k uhd' });
    assert.ok(prompt.includes('露娜位于'));
    assert.ok(prompt.includes('首帧静止画面'));
    assert.ok(!prompt.includes('从走廊掩体后冲出')); // 无两点动态位移
  });

  it('synthesizeLastFrameVisualSlots and compileLastFramePromptFromSlots produce deterministic tail frame slots', () => {
    const shot = {
      shot_number: 29,
      location: '废弃工厂内部战斗区',
      time: '任务进行中·阴天白昼',
      shot_type: '全景',
      angle_h: 'front_right',
      angle_v: 'low',
      characters: [1, 2],
      action: '倒计时跳到五秒，红狼从断墙后拼尽全力冲向蜂医，连续弹着点从他身后追到脚边；数字降至一秒时，他伸手扑向蜂医。',
      result: '红狼的手停在距离蜂医约半米处，画面在弹着火星中骤然冻结。',
    };

    const catalog = [
      { id: 1, name: '红狼' },
      { id: 2, name: '蜂医' },
    ];

    const firstSlots = synthesizeCharacterVisualSlots(shot, catalog);
    const lastSlots = synthesizeLastFrameVisualSlots(shot, catalog, firstSlots);

    assert.equal(lastSlots.length, 2);
    const wolfLast = lastSlots.find((s) => s.name === '红狼');
    const docLast = lastSlots.find((s) => s.name === '蜂医');

    assert.ok(wolfLast);
    assert.ok(docLast);

    // 终态物理站位：红狼冲到蜂医身旁半米处
    assert.ok(wolfLast.spatial_anchor.includes('半米处') || wolfLast.spatial_anchor.includes('画面右侧'));
    // 终态姿态：飞扑伸展定格
    assert.ok(wolfLast.posture.includes('扑') || wolfLast.posture.includes('倾'));
    assert.ok(wolfLast.hands.includes('伸') || wolfLast.hands.includes('手停在'));

    // 蜂医：卧倒在掩体地面
    assert.ok(docLast.spatial_anchor.includes('地面') || docLast.spatial_anchor.includes('掩体'));
    assert.ok(docLast.posture.includes('卧') || docLast.posture.includes('倒'));

    const lastPrompt = compileLastFramePromptFromSlots(shot, lastSlots, { style: 'photorealistic, RAW' });
    assert.ok(lastPrompt.includes('尾帧静止画面'));
    assert.ok(lastPrompt.includes('动作收束瞬间细节'));
    assert.ok(!lastPrompt.includes('连续弹着点')); // 具象化排查
  });

  it('Video Semantic Slots enforce Audio Lip-Sync contract and translate physical jargon (Shot 29 scenario)', () => {
    const shot29 = {
      shot_number: 29,
      title: '一秒冲刺',
      location: '废弃工厂内部战斗区',
      time: '任务进行中·阴天白昼',
      shot_type: '全景',
      angle_h: 'front_right',
      angle_v: 'low',
      angle_s: 'wide',
      movement: 'tracking',
      characters: [1, 2],
      action: '倒计时跳到五秒，红狼从断墙后拼尽全力冲向蜂医，连续弹着点从他身后追到脚边；数字降至一秒时，他伸手扑向蜂医。',
      result: '红狼的手停在距离蜂医约半米处，画面在弹着火星中骤然冻结。',
      dialogue: '露娜: "红狼！你再不做决定，就来不及了！"',
      atmosphere: '孤注一掷',
      sound_effect: '耳机无线电急促呼叫杂音、密集枪声、子弹击地',
      duration: 8,
    };

    const catalog = [
      { id: 1, name: '红狼' },
      { id: 2, name: '蜂医' },
    ];

    // 1. 槽位智能合成
    const slots = synthesizeVideoSlots(shot29, catalog);

    assert.equal(slots.audio_lip_sync.mode, 'offscreen_voiceover');
    assert.equal(slots.audio_lip_sync.speaker_name, '露娜');
    assert.equal(slots.audio_lip_sync.speaker_in_frame, false);
    assert.equal(slots.audio_lip_sync.visible_characters_lip_state, 'strictly_sealed');

    // 画内可见人物全员嘴型闭合审查
    slots.trajectories.forEach((t) => {
      assert.ok(t.mouth_state.includes('双唇紧闭') || t.mouth_state.includes('严禁张嘴'));
    });

    // 物理特效具象化（连续弹着点 -> 碎石与火花）
    assert.ok(slots.environment_vfx.physical_phenomena.includes('飞溅碎石'));
    assert.ok(!slots.environment_vfx.physical_phenomena.includes('连续弹着点'));

    // 2. 槽位硬门禁校验
    const violations = validateVideoSlots(shot29, slots);
    assert.equal(violations.length, 0);

    // 3. 确定性提示词编译
    const videoPrompt = compileVideoPromptFromSlots(shot29, slots, {
      style: 'photorealistic, ultra-detailed',
      videoRatio: '16:9',
    });

    // 验证三大核心保障：
    // A. 画外音与全员闭口明确标注
    assert.ok(videoPrompt.includes('画外无线电呼叫（画内全员闭口无口型）'));
    assert.ok(videoPrompt.includes('纯画外音传输，画面内所有人物全程紧闭双唇，绝对不开口说话，无任何台词口型动作'));
    // B. 英文画面与口型约束指令
    assert.ok(videoPrompt.includes('(off-screen radio voiceover only, all visible characters in frame keep mouth closed, lips sealed, strictly no lip movement, characters do not talk)'));
    // C. 角色轨迹口型闭口要求
    assert.ok(videoPrompt.includes('口型状态：双唇紧闭'));
    // D. 比例标签
    assert.ok(videoPrompt.includes('=VideoRatio: 16:9'));
  });

  it('Invariant checkVideoSlots catches unsealed characters during offscreen dialogue and abstract jargon', () => {
    const badShot = {
      shot_number: 10,
      video_slots: {
        camera: { shot_type: '全景', angle_h: 'front', angle_v: 'eye_level', movement: 'tracking' },
        audio_lip_sync: {
          mode: 'offscreen_voiceover',
          speaker_name: '露娜',
          speaker_in_frame: false,
          dialogue_content: '撤退！',
          visible_characters_lip_state: 'synchronized_lip', // 错误：画外音却设为开启动嘴口型
        },
        trajectories: [
          { name: '蜂医', start_anchor: '地面', trajectory: '卧倒', mouth_state: '开口说话' }, // 错误：画内人物开口说话
        ],
        environment_vfx: {
          physical_phenomena: '连续弹着点扫射地面', // 错误：未具象化的抽象术语
        },
      },
    };

    const violations = checkVideoSlots([badShot]);
    assert.ok(violations.length >= 2);
    assert.ok(violations.some((v) => v.rule === 'INVARIANT_OFFSCREEN_LIP_SYNC_VIOLATION'));
    assert.ok(violations.some((v) => v.rule === 'INVARIANT_CHARACTER_MOUTH_NOT_SEALED'));
    assert.ok(violations.some((v) => v.rule === 'INVARIANT_ABSTRACT_PHYSICAL_JARGON'));
  });

  it('autocompleteEntityFromScript extracts structured props, characters and scenes based on user name/hint and script context', async (t) => {
    t.mock.method(aiClient, 'generateText', async (database, logger, kind, user, system) => {
      if (user.includes('【待补全道具】：战术护目镜')) {
        return JSON.stringify({
          name: '战术护目镜',
          type: '战术装备',
          physical_scale: '长约18cm单兵佩戴护目镜，紧密贴合面部轮廓，次要战术物件',
          description: '红狼在废弃仓库战斗时佩戴的战术护目镜，黑色哑光框架与防强光镀膜镜片。',
          prompt: '特写单体道具：战术护目镜，哑光深灰色框架，偏振镀膜镜片泛微蓝光，纯色干净背景，超高清摄影，8k uhd',
          reference_image_mode: 'single',
          reference_image_reason: '单重视角物件，单图优先保障细节与材质清晰度',
        });
      }
      if (user.includes('【待补全角色】：露娜')) {
        return JSON.stringify({
          name: '露娜',
          role: 'supporting',
          gender: '女',
          appearance: '女性，约二十二至二十五岁，干练短发，眼神敏锐，身穿深灰迷彩侦察战术服与战术耳机，身材修长灵活。',
          description: '三角洲特战小队的侦察干员，负责远程情报支援与路线侦察。',
          personality: '冷静、严谨、敏锐',
          polished_prompt: '四视图角色概念设计，多角度，同一角色保持外貌一致，露娜，短发干练女侦察兵，纯白背景，大师画质',
        });
      }
      return '{}';
    });

    const propResult = await autocompleteEntityFromScript(db, { info() {}, warn() {}, error() {} }, {}, {
      dramaId: 1,
      episodeId: 10,
      entityType: 'prop',
      name: '战术护目镜',
      hint: '红狼佩戴的防强光战术眼镜',
    });

    assert.equal(propResult.name, '战术护目镜');
    assert.equal(propResult.type, '战术装备');
    assert.ok(propResult.physical_scale.includes('长约18cm'));
    assert.ok(propResult.description.includes('护目镜'));

    const charResult = await autocompleteEntityFromScript(db, { info() {}, warn() {}, error() {} }, {}, {
      dramaId: 1,
      episodeId: 10,
      entityType: 'character',
      name: '露娜',
      hint: '远程情报支援干员',
    });

    assert.equal(charResult.name, '露娜');
    assert.equal(charResult.role, 'supporting');
    assert.ok(charResult.appearance.includes('短发'));
  });
});
