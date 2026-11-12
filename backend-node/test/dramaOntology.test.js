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
  checkAudioContract,
  checkSpeechTiming,
  checkVisualSlotCompleteness,
  checkVideoSlots,
  checkCrowdControl,
  checkPhysicalVisualDescription,
  checkSpatialContinuity,
  checkPropEraAndScale,
  checkCrossSlotInvariants,
  checkObsoleteAssets,
  validateAllInvariants,
} = require('../src/ontology/invariants');
const {
  validateCharacterVisualSlots,
  compileImagePromptFromSlots,
  compileLastFramePromptFromSlots,
} = require('../src/ontology/visualSlots');
const {
  createVideoSemanticSlots,
  validateVideoSlots,
  compileVideoPromptFromSlots,
} = require('../src/ontology/videoSlots');
const { compileDramaSemanticPackage } = require('../src/ontology/semanticPackage');
const { refineSingleStoryboard, applySingleStoryboardPatch } = require('../src/ontology/directorAgent');
const { autocompleteEntityFromScript } = require('../src/ontology/extractionAgent');
const aiClient = require('../src/services/aiClient');
const agentsRuntime = require('../src/services/agentsRuntime');

describe('Audiovisual Drama Ontology & Semantic Invariants', () => {
  let db;

  before(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE dramas (id INTEGER PRIMARY KEY, title TEXT, genre TEXT, style TEXT, era TEXT, metadata TEXT, deleted_at TEXT);
      CREATE TABLE episodes (id INTEGER PRIMARY KEY, drama_id INTEGER, episode_number INTEGER, title TEXT, duration INTEGER, script_content TEXT, deleted_at TEXT);
      CREATE TABLE episode_characters (episode_id INTEGER, character_id INTEGER, PRIMARY KEY (episode_id, character_id));
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

  it('allows consecutive static shots without a camera movement quota', () => {
    const { validateAllInvariants } = require('../src/ontology/invariants');
    const result = validateAllInvariants(Array.from({ length: 8 }, (_, i) => ({ shot_number: i + 1, movement: 'static' })));
    assert.ok(!result.violations.some(v => /STATIC|MOVEMENT_DYNAMISM/.test(v.rule)));
  });

  it('Invariant checkAudioContract does not force BGM on speechless shots', () => {
    const shots = [
      { shot_number: 1, dialogue: '', narration: '', bgm_prompt: '' },
      { shot_number: 2, dialogue: '红狼："快撤！"', narration: '', bgm_prompt: '' },
      { shot_number: 3, dialogue: '', narration: '', bgm_prompt: '紧张低频重音脉冲' },
    ];
    const violations = checkAudioContract(shots);
    assert.equal(violations.length, 0);
  });

  it('Invariant checkCrowdControl flags single shots with >2 identity characters (crowd overload)', () => {
    const shots = [
      { shot_number: 1, character_ids: [1, 2] },
      { shot_number: 2, character_ids: [1, 2] }, // 双人对话完全合法
      { shot_number: 3, character_ids: [1, 2, 3] }, // >2人过载触发硬门禁
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

  it('Invariant checkPropEraAndScale uses Agent era contracts and permits intentional time-travel props', () => {
    const props = [
      { id: 1, name: '青铜长剑', physical_scale: '长约80cm', era_compatibility: 'compatible' },
      { id: 2, name: '智能手机', description: '穿越者用于查看现代时间', physical_scale: '长15cm', era_compatibility: 'intentional_cross_era', era_reason: '现代人物随身穿越到古代' },
      { id: 3, name: '液晶电视', physical_scale: '55英寸', era_compatibility: 'incompatible', era_reason: '普通古代宫殿场景没有穿越设定' },
      { id: 4, name: '押送囚车', description: '不得出现橡胶轮胎等现代结构', physical_scale: '长3米' },
    ];
    const violations = checkPropEraAndScale(props, 'ancient');
    assert.ok(violations.some((v) => v.rule === 'INVARIANT_PROP_ERA_CONTRACT_CONFLICT' && v.prop_id === 3));
    assert.ok(!violations.some((v) => v.severity === 'error' && v.prop_id === 2));
    assert.ok(!violations.some((v) => v.severity === 'error' && v.prop_id === 4));
    assert.ok(violations.some((v) => v.rule === 'INVARIANT_PROP_ERA_CONTRACT_UNDECLARED' && v.prop_id === 4));
  });

  it('cross-slot gate rejects divergent persisted and semantic character sets', () => {
    const violations = checkCrossSlotInvariants([{
      shot_number: 1,
      characters: [101],
      background_characters: [{ character_id: 102 }],
      character_visuals: [{ character_id: 101 }, { character_id: 102 }],
      semantic_slots: {
        visible_characters: [{ id: 102, name: '蜂医' }],
        background_characters: [],
        speech_plan: {},
        sound_plan: {},
        h3_mode: 'ref2va',
        first_frame_policy: 'none',
        last_frame_policy: 'none',
        required_references: [],
      },
    }]);
    assert.ok(violations.some((v) => v.rule === 'INVARIANT_CHARACTER_SLOT_DIVERGENCE'));
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

  it('single-shot patch preserves fields that the Agent did not explicitly change', () => {
    const current = {
      title: '咳血触泉',
      duration: 8,
      dialogue: '父亲：别怕。',
      character_visuals: [{ character_id: 101, gaze: '看向床边' }],
      video_slots: { camera: { movement: 'push' }, timing: { duration: 8 } },
    };
    const next = applySingleStoryboardPatch(current, {
      patch: {
        video_slots: { camera: { movement: 'static' } },
      },
    }, 16);

    assert.equal(next.title, current.title);
    assert.equal(next.dialogue, current.dialogue);
    assert.deepEqual(next.character_visuals, current.character_visuals);
    assert.equal(next.video_slots.camera.movement, 'static');
    assert.equal(next.video_slots.timing.duration, 8);
  });

  it('single-shot refinement accepts an explicit Agent no-op without changing the candidate', () => {
    const current = { title: '咳血触泉', duration: 8, dialogue: '' };
    const next = applySingleStoryboardPatch(current, {
      noop: true,
      reason: '苏晚的头部姿态、视线落点和惊慌反应已经满足本次指令',
    }, 16);
    assert.deepEqual(next, current);
    assert.throws(
      () => applySingleStoryboardPatch(current, { noop: true, patch: {}, reason: '冲突协议' }, 16),
      /不能同时包含 patch/
    );
  });

  it('refineSingleStoryboard carries the patched candidate into the next ReAct round', async (t) => {
    let calls = 0;
    t.mock.method(agentsRuntime, 'runAgent', async (database, logger, options) => {
      calls += 1;
      const { input: user, instructions: system } = options;
      assert.match(system, /后端只会校验并编译/);
      assert.match(user, /【用户指令】/);
      assert.match(user, /【本集完整剧本（持久导演记忆）】/);
      assert.match(user, /【本集导演记忆（全部现有分镜摘要）】/);
      assert.match(user, /红狼/);
      assert.match(user, /只返回一个纯 JSON 对象，并严格二选一/);
      if (calls === 1) return { patch: { title: '第一轮已修改标题', duration: 0 } };
      assert.match(user, /第一轮已修改标题/);
      assert.match(user, /上一轮 ReAct 门禁反馈/);
      return { patch: { id: 999 } };
    });

    await assert.rejects(
      () => refineSingleStoryboard(db, { info() {}, warn() {}, error() {} }, {}, 501, '改成拔枪特写，微推运镜，加紧迫BGM', { maxReflectionRounds: 2 }),
      (err) => err.status === 422 && Array.isArray(err.violations) && err.violations.length > 0
    );
    assert.equal(calls, 2);
    const unchanged = db.prepare('SELECT shot_type, movement, action FROM storyboards WHERE id = 501').get();
    assert.equal(unchanged.action, '红狼隐蔽在木箱后探头观察');
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
        dialogue: '露娜: "红狼，别从正面过去！敌人在高台和仓库二层交叉射击，先等我找安全路线！这次一定要先确认撤离点再行动！"',
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
        dialogue: '露娜: "红狼，别从正面过去！先等我找安全路线！"',
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

  it('Invariant checkVisualSlotCompleteness enforces structured visual enums and rejects V1 slots', () => {
    const incompleteSlotShot = {
      shot_number: 1,
      characters: '[101]',
      character_visuals: [
        {
          character_id: 101,
          name: '红狼',
          depth_layer: 'midground',
          screen_position: 'left_midground',
          facing: '',
          head_pose: '',
          gaze_type: '',
          posture: 'standing',
          hands_state: 'free',
          expression: 'focused',
        },
      ],
    };
    const v1 = checkVisualSlotCompleteness([incompleteSlotShot]);
    const invalidFacing = v1.find((v) => v.rule === 'INVARIANT_VISUAL_ENUM_INVALID' && v.conflict_slots?.includes('character_visuals[0].facing'));
    assert.ok(invalidFacing);
    const missingHeadPose = v1.find((v) => v.rule === 'INVARIANT_VISUAL_ENUM_INVALID' && v.conflict_slots?.includes('character_visuals[0].head_pose'));
    assert.ok(missingHeadPose);
    assert.equal(missingHeadPose.character_id, 101);
    assert.equal(missingHeadPose.character_name, '红狼');

    const goodShot = {
      shot_number: 5,
      characters: '[101]',
      character_visuals: [
        {
          character_id: 101,
          name: '红狼',
          depth_layer: 'midground',
          screen_position: 'center_midground',
          environmental_anchor: '装卸道路前',
          facing: 'right_profile',
          facing_target_id: null,
          head_pose: 'turned_right',
          gaze_type: 'scene',
          gaze_target_id: null,
          gaze_target_label: '前方通道',
          posture: 'kneeling',
          hands_state: 'holding_object',
          hands_object_id: null,
          hands_target_id: null,
          expression: 'alert',
          expression_detail: '警惕锁定前方通道',
          appearance_details: '深色战术服',
        },
      ],
    };
    const v3 = checkVisualSlotCompleteness([goodShot]);
    assert.equal(v3.length, 0);
  });

  it('compileImagePromptFromSlots and compileLastFramePromptFromSlots assemble complete static frame prompts', () => {
    const shot = {
      shot_number: 1,
      location: '废弃工厂内部战斗区',
      time: '任务进行中·阴天白昼',
      shot_type: '近景',
      angle_h: 'front_left',
      angle_v: 'eye_level',
      characters: [102],
      action: '露娜伏在低矮掩体后，抬头观察高台与仓库二层窗口，右手按住通讯器位置。',
      result: '右手松开通讯器，转身望向右侧通道。',
    };

    const firstSlots = [{
      character_id: 102, name: '露娜', depth_layer: 'midground', screen_position: 'left_midground',
      environmental_anchor: '低矮掩体后', facing: 'three_quarter_left', facing_target_id: null,
      head_pose: 'tilted_up', gaze_type: 'scene', gaze_target_id: null, gaze_target_label: '二层窗口',
      posture: 'crouching', hands_state: 'holding_object', expression: 'alert',
      expression_detail: '目光警惕锁定窗口', appearance_details: '侦察装束',
    }];
    const prompt = compileImagePromptFromSlots(shot, firstSlots, { style: 'photorealistic, ultra-detailed, 8k uhd' });
    assert.ok(prompt.includes('【露娜】'));
    assert.ok(prompt.includes('二层窗口'));
    assert.ok(prompt.includes('首帧静止画面'));

    const lastSlots = [{
      ...firstSlots[0],
      facing: 'three_quarter_right',
      head_pose: 'turned_right',
      gaze_target_label: '右侧通道',
      hands_state: 'free',
    }];
    const lastPrompt = compileLastFramePromptFromSlots(shot, lastSlots, { style: 'photorealistic, RAW' });
    assert.ok(lastPrompt.includes('尾帧静止画面'));
    assert.ok(lastPrompt.includes('右侧通道'));
  });

  it('Video Semantic Slots enforce structured_sync Audio Lip-Sync contract (Shot 29 scenario)', () => {
    const validShot = {
      shot_number: 29,
      title: '掩体警报',
      location: '废弃工厂内部战斗区',
      duration: 5,
      characters: [1, 2],
      semantic_slots: { h3_mode: 'ref2va', shot_duration: 5, visible_characters: [{ id: 1, name: '红狼' }, { id: 2, name: '蜂医' }] },
      character_visuals: [
        { character_id: 1, name: '红狼', depth_layer: 'foreground', screen_position: 'left_foreground', facing: 'front_camera', head_pose: 'neutral', gaze_type: 'offscreen', gaze_target_label: '无线电声源', posture: 'crouching', hands_state: 'holding_object', expression: 'alert' },
        { character_id: 2, name: '蜂医', depth_layer: 'midground', screen_position: 'right_midground', facing: 'back_camera', head_pose: 'turned_right', gaze_type: 'character', gaze_target_label: '红狼', posture: 'crouching', hands_state: 'clenched', expression: 'worried' },
      ],
    };

    const slots = createVideoSemanticSlots({
      performance_contract: 'structured_sync',
      camera: { shot_type: '全景', angle_h: 'front_right', angle_v: 'low', angle_s: 'wide', movement: 'tracking' },
      audio_lip_sync: {
        mode: 'offscreen_voiceover',
        speaker_name: '露娜',
        speaker_in_frame: false,
        delivery_medium: 'radio_headset',
        dialogue_content: '红狼！你再不做决定，就来不及了！',
        visible_characters_lip_state: 'strictly_sealed',
        lip_sync_rule: '画内人物保持双唇自然闭合',
      },
      trajectories: [],
      environment_vfx: {
        physical_phenomena: '一连串密集子弹击地激起飞溅碎石、烟尘与火花',
        terminal_event: '红狼停在半米处掩体旁',
      },
      timing: { duration: 5, pacing: '紧凑' },
      shots_timeline: [{
        shot_number: 1, timestamp: null, duration: 5,
        camera: { shot_type: '全景', movement: 'tracking', movement_description: '跟拍推进' },
        visible_characters: [{ character_id: 1, name: '红狼' }, { character_id: 2, name: '蜂医' }],
        action: '红狼冲到掩体旁蹲下',
        result: '红狼停在掩体旁持械戒备',
        character_trajectories: [
          {
            character_id: 1, name: '红狼', start_state: 'running',
            action_atom: { action: 'crouch', action_detail: '急停蹲下护住队友', body_part: 'whole_body', object_id: null, target_type: 'scene', target_id: null, target_label: '掩体', direction: 'forward', contact: 'none' },
            result_state: 'crouched', reaction_trigger: { type: 'dialogue', source_id: null, source_label: '无线电催促' },
            facing: 'front_camera', facing_target_id: null, head_pose: 'neutral', gaze_type: 'offscreen', gaze_target_id: null, gaze_target_label: '无线电方向',
            posture: 'crouching', hands_state: 'holding_object', hands_object_id: null, hands_target_id: null,
            expression: 'alert', expression_detail: '紧张戒备', mouth_state: 'offscreen_sealed',
          },
          {
            character_id: 2, name: '蜂医', start_state: 'crouched',
            action_atom: { action: 'turn', action_detail: '侧身抬头看向红狼', body_part: 'head', object_id: null, target_type: 'character', target_id: 1, target_label: '红狼', direction: 'toward_target', contact: 'none' },
            result_state: 'turned_to_target', reaction_trigger: { type: 'character_action', source_id: 1, source_label: '红狼抵达掩体' },
            facing: 'toward_character', facing_target_id: 1, head_pose: 'turned_to_target', gaze_type: 'character', gaze_target_id: 1, gaze_target_label: '红狼',
            posture: 'crouching', hands_state: 'clenched', hands_object_id: null, hands_target_id: null,
            expression: 'worried', expression_detail: '屏息倾听', mouth_state: 'offscreen_sealed',
          },
        ],
        audio_lip_sync: { mode: 'offscreen_voiceover', speaker_name: '露娜', speaker_in_frame: false, dialogue_content: '红狼！你再不做决定，就来不及了！', lip_sync_rule: '画内闭口' },
        speech_action_alignment: { mode: 'concurrent', speech_window: { start: 0, end: 2 }, speaker_character_id: null, speaker_action_window: { start: 0, end: 5 }, listener_reactions: [{ character_id: 1, action_window: { start: 0, end: 5 }, trajectory_action: 'react' }, { character_id: 2, action_window: { start: 0, end: 5 }, trajectory_action: 'react' }], pause_reason: '' },
      }],
    });

    assert.equal(validateVideoSlots(validShot, slots).length, 0);
    const videoPrompt = compileVideoPromptFromSlots(validShot, slots, { style: 'photorealistic, ultra-detailed', videoRatio: '16:9' });
    assert.match(videoPrompt, /画外无线电呼叫.*画内人物保持双唇自然闭合/);
    assert.doesNotMatch(videoPrompt, /绝对不开口|严禁张嘴|strictly no lip movement/);
    assert.ok(videoPrompt.includes('(the voice comes from off screen; every visible character maintains relaxed closed lips and attentive listening expressions)'));
    assert.ok(videoPrompt.includes('=VideoRatio: 16:9'));
  });

  it('Invariant checkVideoSlots catches unsealed characters during offscreen dialogue and abstract jargon', () => {
    const badShot = {
      shot_number: 10,
      video_slots: {
        performance_contract: 'structured_sync',
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
