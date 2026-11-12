const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');
const {
  DIALOGUE_FRAMING,
  DEPTH_LAYERS,
  FACING_DIRECTIONS,
  HEAD_POSES,
  GAZE_DIRECTIONS,
  POSTURE_TYPES,
  HANDS_ACTIONS,
  AUDIO_LIP_SYNC_MODES,
  DELIVERY_MEDIUMS,
  LONG_TAKE_ROLES,
  CINEMATIC_LENSES,
  AUDIOTISUAL_DATA_DICTIONARY,
} = require('../src/ontology/schema');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const storyboardService = require('../src/services/storyboardService');

test('AUDIOTISUAL_DATA_DICTIONARY contains all core slot definitions and closed-loop enums', () => {
  assert.ok(AUDIOTISUAL_DATA_DICTIONARY, 'Data dictionary exists');

  const requiredSlots = [
    'dialogue_framing',
    'depth_layer',
    'facing',
    'head_pose',
    'gaze',
    'posture',
    'hands',
    'movement',
    'audio_lip_sync_mode',
    'long_take_role',
    'lighting_style',
    'depth_of_field',
  ];

  for (const slotKey of requiredSlots) {
    const slotDef = AUDIOTISUAL_DATA_DICTIONARY[slotKey];
    assert.ok(slotDef, `Slot "${slotKey}" is defined in data dictionary`);
    assert.ok(slotDef.name_zh, `Slot "${slotKey}" has Chinese name`);
    assert.ok(slotDef.description, `Slot "${slotKey}" has description`);
    assert.ok(slotDef.enums && typeof slotDef.enums === 'object', `Slot "${slotKey}" has enum map`);
    assert.ok(Object.keys(slotDef.enums).length >= 3, `Slot "${slotKey}" has multiple enum choices`);
  }

  // Check specific enum values for dialogue_framing (doing multiple choice, no facing camera)
  const dfEnums = AUDIOTISUAL_DATA_DICTIONARY.dialogue_framing.enums;
  assert.ok(dfEnums.two_shot_face_to_face, 'has two_shot_face_to_face');
  assert.ok(dfEnums.over_the_shoulder, 'has over_the_shoulder');
  assert.ok(dfEnums.single_reaction_offscreen, 'has single_reaction_offscreen');
  assert.ok(dfEnums.joint_observation, 'has joint_observation');
  assert.ok(dfEnums.solo_action, 'has solo_action');

  // Verify constant objects match data dictionary keys
  assert.equal(DIALOGUE_FRAMING.TWO_SHOT_FACE_TO_FACE, 'two_shot_face_to_face');
  assert.equal(DEPTH_LAYERS.FOREGROUND, 'foreground');
  assert.equal(POSTURE_TYPES.CROUCHING_LOW, 'crouching_low');
  assert.equal(HANDS_ACTIONS.HOLDING_WEAPON_ALERT, 'holding_weapon_alert');
  assert.equal(AUDIO_LIP_SYNC_MODES.OFFSCREEN_VOICEOVER, 'offscreen_voiceover');
  assert.equal(LONG_TAKE_ROLES.HEAD, 'head');
});

test('storyboardService supports creating, updating and retrieving dialogue_framing slot', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-dict-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = new Database(dbPath);
  const log = { info: () => {}, warn: () => {}, error: () => {} };

  try {
    runMigrationsAndEnsure(db);

    db.prepare("INSERT INTO dramas (id, title) VALUES (1, '测试剧目')").run();
    db.prepare("INSERT INTO episodes (id, drama_id, episode_number, title) VALUES (1, 1, 1, '第1集')").run();

    // Create storyboard with dialogue_framing
    const created = storyboardService.createStoryboard(db, log, {
      episode_id: 1,
      storyboard_number: 1,
      title: '对峙交流',
      dialogue_framing: 'two_shot_face_to_face',
      action: '两人面对面对视',
      duration: 5,
      bgm_prompt: '低沉克制的悬疑弦乐与轻微环境脉冲',
    });

    // Seed a complete silent Agent plan so editing a cinematic field exercises
    // the same semantic gate as production Director-created storyboards.
    db.prepare('UPDATE storyboards SET semantic_slots = ?, video_slots = ?, bgm_prompt = ? WHERE id = ?').run(
      JSON.stringify({
        h3_mode: 'fl2va', h3_mode_reason: '人工首帧测试',
        first_frame_policy: 'generate_new', first_frame_reason: '人工首帧测试',
        last_frame_policy: 'none', last_frame_reason: '自然收束',
        required_references: [], visible_characters: [], background_characters: [],
        speech_plan: { speaker_name: '', text: '', is_narration: false, audio_references: [] },
        shot_duration: 5,
      }),
      JSON.stringify({
        performance_contract: 'structured_sync',
        execution_backend: 'h3_single',
        camera: { shot_type: '中景', movement: 'push' },
        audio_lip_sync: { mode: 'silent_ambient', speaker_name: '', speaker_in_frame: false, dialogue_content: '', visible_characters_lip_state: 'strictly_sealed' },
        trajectories: [], environment_vfx: {}, timing: { duration: 5 },
        shots_timeline: [
          { shot_number: 1, timestamp: '00:00.000', duration: 2, camera: { shot_type: '中景', movement: 'push' }, visible_characters: [], action: '摄影机缓慢推进至空间主体', result: '建立空间关系', character_trajectories: [], audio_lip_sync: { mode: 'silent_ambient' } },
          { shot_number: 2, timestamp: '00:02.000', duration: 2, camera: { shot_type: '近景', movement: 'push' }, visible_characters: [], action: '镜头继续推进观察现场细节', result: '关键环境细节清晰可见', character_trajectories: [], audio_lip_sync: { mode: 'silent_ambient' } },
          { shot_number: 3, timestamp: '00:04.000', duration: 1, camera: { shot_type: '近景', movement: 'static' }, visible_characters: [], action: '镜头稳定停住', result: '画面在环境细节上收束', character_trajectories: [], audio_lip_sync: { mode: 'silent_ambient' } },
        ],
      }),
      '低沉克制的悬疑弦乐与轻微环境脉冲',
      created.id,
    );

    assert.equal(created.dialogue_framing, 'two_shot_face_to_face', 'persists dialogue_framing on create');

    // Update storyboard with new framing choice
    const updated = storyboardService.updateStoryboard(db, log, created.id, {
      dialogue_framing: 'over_the_shoulder',
    });

    assert.equal(updated.dialogue_framing, 'over_the_shoulder', 'updates dialogue_framing successfully');

    // Retrieve from DB directly
    const row = db.prepare('SELECT dialogue_framing FROM storyboards WHERE id = ?').get(created.id);
    assert.equal(row.dialogue_framing, 'over_the_shoulder', 'retrieved from DB successfully');

    // Test open-ended custom creative values: not restricted to dictionary enums!
    const customFraming = '两人背对背持枪警戒侧方走廊';
    const customUpdated = storyboardService.updateStoryboard(db, log, created.id, {
      dialogue_framing: customFraming,
    });
    assert.equal(customUpdated.dialogue_framing, customFraming, 'accepts creative custom framing outside dictionary');

    const customRow = db.prepare('SELECT dialogue_framing FROM storyboards WHERE id = ?').get(created.id);
    assert.equal(customRow.dialogue_framing, customFraming, 'custom framing persisted cleanly in DB');
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
