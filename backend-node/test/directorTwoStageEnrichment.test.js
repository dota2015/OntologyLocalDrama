const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
  enrichSingleStoryboardSlots,
  enrichEpisodeOntologySlots,
} = require('../src/ontology/directorEnrichmentService');
const { validateAllInvariants } = require('../src/ontology/invariants');

test('directorTwoStageEnrichment: enrichSingleStoryboardSlots enriches bare storyboard with full ontology contracts', () => {
  const context = {
    catalogs: {
      characters: [
        { id: 1, name: '露娜', role: 'main' },
        { id: 2, name: '红狼', role: 'main' },
      ],
      scenes: [{ id: 10, location: '废弃工厂', time: '白天' }],
      props: [{ id: 100, name: '战术终端', type: '道具' }],
    },
    allShots: [],
    drama: { id: 1, title: '测试短剧' },
    episode: { id: 1, script_content: '露娜和红狼在废弃工厂执行任务。' },
  };

  const bareShot = {
    id: 99,
    storyboard_number: 1,
    duration: 6,
    dialogue: '露娜: 我们必须立刻撤退！',
    narration: '',
    action: '废弃工厂内部，露娜向红狼发出警告，两人在掩体后戒备',
    result: '红狼点头，准备转移',
    characters: [1, 2],
    scene_id: 10,
    shot_type: '中景',
    angle: '平视',
    movement: 'push',
  };

  const enriched = enrichSingleStoryboardSlots(bareShot, context);

  // 1. Check semantic_slots
  assert.ok(enriched.semantic_slots, 'semantic_slots should be created');
  assert.equal(enriched.semantic_slots.h3_mode, 'ref2va');
  assert.equal(enriched.semantic_slots.first_frame_policy, 'none');
  assert.equal(enriched.semantic_slots.last_frame_policy, 'none');
  assert.equal(enriched.semantic_slots.visible_characters.length, 2);
  assert.equal(enriched.semantic_slots.visible_characters[0].name, '露娜');
  assert.equal(enriched.semantic_slots.visible_characters[1].name, '红狼');
  assert.equal(enriched.semantic_slots.speech_plan.speaker_name, '露娜');
  assert.equal(enriched.semantic_slots.speech_plan.text, '我们必须立刻撤退！');
  assert.equal(enriched.semantic_slots.continuity_from_previous.relationship, 'opening');

  // 2. Check character_visuals
  assert.ok(Array.isArray(enriched.character_visuals), 'character_visuals should be an array');
  assert.equal(enriched.character_visuals.length, 2);
  const lunaVisual = enriched.character_visuals.find((c) => c.name === '露娜');
  assert.ok(lunaVisual, '露娜 visual slot should exist');
  assert.ok(lunaVisual.screen_position, 'screen_position should exist');
  assert.ok(lunaVisual.facing, 'facing should exist');
  assert.ok(lunaVisual.posture, 'posture should exist');
  assert.ok(lunaVisual.hands, 'hands should exist');
  assert.ok(lunaVisual.head_pose, 'head_pose should exist');
  assert.ok(lunaVisual.gaze, 'gaze should exist');
  assert.ok(lunaVisual.depth_layer, 'depth_layer should exist');

  // 3. Check video_slots and timeline
  assert.ok(enriched.video_slots, 'video_slots should exist');
  assert.equal(enriched.video_slots.performance_contract, 'sync_v1');
  assert.equal(enriched.video_slots.audio_lip_sync.mode, 'in_frame_dialogue');
  assert.equal(enriched.video_slots.audio_lip_sync.speaker_name, '露娜');
  assert.ok(Array.isArray(enriched.video_slots.shots_timeline), 'shots_timeline should be an array');
  assert.ok(enriched.video_slots.shots_timeline.length >= 2, 'shots_timeline should have at least 2 segments for 6s');

  const firstSeg = enriched.video_slots.shots_timeline[0];
  assert.ok(firstSeg.speech_action_alignment, 'segment with dialogue should have speech_action_alignment');
  assert.equal(firstSeg.speech_action_alignment.mode, 'concurrent', 'speech_action_alignment mode should be concurrent');

  // 4. Check framings
  assert.equal(enriched.dialogue_framing, 'two_shot_face_to_face');
  assert.ok(enriched.start_framing);
  assert.ok(enriched.end_framing);
  assert.ok(enriched.transition_to_next);
});

test('directorTwoStageEnrichment: enrichEpisodeOntologySlots batch enriches in DB and passes invariant audit', async () => {
  const db = new Database(':memory:');

  // Setup minimal tables
  db.exec(`
    CREATE TABLE dramas (id INTEGER PRIMARY KEY, title TEXT, genre TEXT, style TEXT, era TEXT, metadata TEXT, deleted_at TEXT);
    CREATE TABLE episodes (id INTEGER PRIMARY KEY, drama_id INTEGER, episode_number INTEGER, title TEXT, script_content TEXT, duration INTEGER, deleted_at TEXT);
    CREATE TABLE characters (id INTEGER PRIMARY KEY, drama_id INTEGER, name TEXT, role TEXT, appearance TEXT, deleted_at TEXT);
    CREATE TABLE scenes (id INTEGER PRIMARY KEY, drama_id INTEGER, location TEXT, time TEXT, deleted_at TEXT);
    CREATE TABLE props (id INTEGER PRIMARY KEY, drama_id INTEGER, name TEXT, type TEXT, deleted_at TEXT);
    CREATE TABLE episode_characters (episode_id INTEGER, character_id INTEGER);
    CREATE TABLE storyboard_props (storyboard_id INTEGER, prop_id INTEGER);
    CREATE TABLE storyboards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      episode_id INTEGER,
      scene_id INTEGER,
      storyboard_number INTEGER,
      title TEXT,
      description TEXT,
      location TEXT,
      time TEXT,
      duration INTEGER,
      dialogue TEXT,
      narration TEXT,
      action TEXT,
      result TEXT,
      atmosphere TEXT,
      image_prompt TEXT,
      video_prompt TEXT,
      shot_type TEXT,
      angle TEXT,
      movement TEXT,
      lighting_style TEXT,
      depth_of_field TEXT,
      bgm_prompt TEXT,
      sound_effect TEXT,
      characters TEXT,
      props TEXT,
      dialogue_framing TEXT,
      character_visuals TEXT,
      last_frame_visuals TEXT,
      video_slots TEXT,
      semantic_slots TEXT,
      start_framing TEXT,
      end_framing TEXT,
      transition_to_next TEXT,
      layout_description TEXT,
      long_take_group_id TEXT,
      long_take_role TEXT,
      long_take_sequence INTEGER,
      background_characters TEXT,
      status TEXT,
      deleted_at TEXT,
      created_at TEXT,
      updated_at TEXT
    );
  `);

  // Insert mock drama & episode
  db.prepare('INSERT INTO dramas (id, title, genre, style, era, metadata) VALUES (?, ?, ?, ?, ?, ?)')
    .run(1, '三角洲行动', '现代战术动作', '真人写实, 电影风格', 'modern', JSON.stringify({}));
  db.prepare('INSERT INTO episodes (id, drama_id, episode_number, title, script_content, duration) VALUES (?, ?, ?, ?, ?, ?)')
    .run(10, 1, 1, '同样的错误', '蜂医中弹倒地，红狼冲向控制台掩护露娜撤退。', 1);

  // Insert characters
  db.prepare('INSERT INTO characters (id, drama_id, name, role, appearance) VALUES (?, ?, ?, ?, ?)')
    .run(25, 1, '红狼', 'main', '身穿现代战术防弹装甲，面容冷峻');
  db.prepare('INSERT INTO characters (id, drama_id, name, role, appearance) VALUES (?, ?, ?, ?, ?)')
    .run(26, 1, '蜂医', 'main', '身穿战术白绿医疗制服，战术头盔');
  db.prepare('INSERT INTO characters (id, drama_id, name, role, appearance) VALUES (?, ?, ?, ?, ?)')
    .run(27, 1, '露娜', 'main', '身穿战术通讯作战服，手持侦察设备');

  // Insert scenes
  db.prepare('INSERT INTO scenes (id, drama_id, location, time) VALUES (?, ?, ?, ?)')
    .run(38, 1, '废弃工厂内部战斗区', '白天');

  // Insert 3 bare storyboards from Stage 1
  const insertSb = db.prepare(`
    INSERT INTO storyboards (episode_id, scene_id, storyboard_number, title, duration, dialogue, narration, action, result, characters, shot_type, angle, movement, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertSb.run(10, 38, 1, '倒计时归零', 6, '', '', '废弃工厂内部战斗区，倒计时归零，蜂医的身影被火光吞没，红狼从掩体后冲出。', '蜂医倒地，红狼戒备。', JSON.stringify([26, 25]), '全景', '低角仰拍', 'push', 'pending');
  insertSb.run(10, 38, 2, '撤退警告', 7, '露娜: 我们不是输在枪法，而是输在你冲进去之前，根本没想过后果！', '', '露娜在控制室门边持枪戒备，语气严厉地斥责红狼。', '红狼动作一滞，停步反思。', JSON.stringify([27, 25]), '中景', '平视', 'tracking', 'pending');
  insertSb.run(10, 38, 3, '红狼反省', 6, '红狼: 刚才是我太急了，这次听你指挥。', '', '红狼单手握紧战术终端，目光从残破屏幕移向露娜，神情严肃坦白。', '露娜点头，重新制定突围计划。', JSON.stringify([25, 27]), '中景', '平视', 'pan', 'pending');

  const log = { info: () => {}, warn: () => {}, error: () => {} };
  const cfg = {};

  // Run Stage 2 enrichment
  const res = await enrichEpisodeOntologySlots(db, log, cfg, 10);

  assert.equal(res.success, true);
  assert.equal(res.total_shots, 3);
  assert.equal(res.updated_shots, 3);

  // Check storyboards in DB
  const rows = db.prepare('SELECT * FROM storyboards WHERE episode_id = 10 ORDER BY storyboard_number ASC').all();
  assert.equal(rows.length, 3);

  for (const row of rows) {
    assert.ok(row.semantic_slots, `Shot #${row.storyboard_number} must have semantic_slots`);
    const sem = JSON.parse(row.semantic_slots);
    assert.equal(sem.h3_mode, 'ref2va');
    assert.ok(sem.visible_characters.length > 0);

    assert.ok(row.video_slots, `Shot #${row.storyboard_number} must have video_slots`);
    const vid = JSON.parse(row.video_slots);
    assert.equal(vid.performance_contract, 'sync_v1');
    assert.ok(vid.shots_timeline.length >= 2);

    assert.ok(row.character_visuals, `Shot #${row.storyboard_number} must have character_visuals`);
    const visuals = JSON.parse(row.character_visuals);
    assert.ok(visuals.length > 0);
    assert.ok(visuals[0].screen_position);
    assert.ok(visuals[0].facing);
    assert.ok(visuals[0].posture);
    assert.ok(visuals[0].hands);
  }

  // Verify invariant audit
  assert.equal(res.audit.valid, true, 'All 3 storyboards should pass invariant validation');
  assert.equal(res.audit.error_count, 0, 'Invariant error_count should be 0');
});

test('directorTwoStageEnrichment: handles narration shots cleanly without INVARIANT_NARRATION_SPEAKER_CONFLICT', async () => {
  const db = new Database(':memory:');

  db.exec(`
    CREATE TABLE dramas (id INTEGER PRIMARY KEY, title TEXT, genre TEXT, style TEXT, era TEXT, metadata TEXT, deleted_at TEXT);
    CREATE TABLE episodes (id INTEGER PRIMARY KEY, drama_id INTEGER, episode_number INTEGER, title TEXT, script_content TEXT, duration INTEGER, deleted_at TEXT);
    CREATE TABLE characters (id INTEGER PRIMARY KEY, drama_id INTEGER, name TEXT, role TEXT, appearance TEXT, deleted_at TEXT);
    CREATE TABLE scenes (id INTEGER PRIMARY KEY, drama_id INTEGER, location TEXT, time TEXT, deleted_at TEXT);
    CREATE TABLE props (id INTEGER PRIMARY KEY, drama_id INTEGER, name TEXT, type TEXT, deleted_at TEXT);
    CREATE TABLE episode_characters (episode_id INTEGER, character_id INTEGER);
    CREATE TABLE storyboard_props (storyboard_id INTEGER, prop_id INTEGER);
    CREATE TABLE storyboards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      episode_id INTEGER,
      scene_id INTEGER,
      storyboard_number INTEGER,
      title TEXT,
      description TEXT,
      location TEXT,
      time TEXT,
      duration INTEGER,
      dialogue TEXT,
      narration TEXT,
      action TEXT,
      result TEXT,
      atmosphere TEXT,
      image_prompt TEXT,
      video_prompt TEXT,
      shot_type TEXT,
      angle TEXT,
      movement TEXT,
      lighting_style TEXT,
      depth_of_field TEXT,
      bgm_prompt TEXT,
      sound_effect TEXT,
      characters TEXT,
      props TEXT,
      dialogue_framing TEXT,
      character_visuals TEXT,
      last_frame_visuals TEXT,
      video_slots TEXT,
      semantic_slots TEXT,
      start_framing TEXT,
      end_framing TEXT,
      transition_to_next TEXT,
      layout_description TEXT,
      long_take_group_id TEXT,
      long_take_role TEXT,
      long_take_sequence INTEGER,
      background_characters TEXT,
      status TEXT,
      deleted_at TEXT,
      created_at TEXT,
      updated_at TEXT
    );
  `);

  db.prepare('INSERT INTO dramas (id, title, genre, style, era, metadata) VALUES (?, ?, ?, ?, ?, ?)')
    .run(1, '三角洲行动', '现代战术动作', '真人写实, 电影风格', 'modern', JSON.stringify({}));
  db.prepare('INSERT INTO episodes (id, drama_id, episode_number, title, script_content, duration) VALUES (?, ?, ?, ?, ?, ?)')
    .run(11, 1, 2, '尾声', '旁白响起，红狼静静注视远方。', 1);

  db.prepare('INSERT INTO characters (id, drama_id, name, role, appearance) VALUES (?, ?, ?, ?, ?)')
    .run(25, 1, '红狼', 'main', '战术装甲');
  db.prepare('INSERT INTO scenes (id, drama_id, location, time) VALUES (?, ?, ?, ?)')
    .run(38, 1, '废墟高地', '黄昏');

  const insertSb = db.prepare(`
    INSERT INTO storyboards (episode_id, scene_id, storyboard_number, title, duration, dialogue, narration, action, result, characters, shot_type, angle, movement, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Shot 1: dialogue starts with "旁白: ..." as generated by some baseline LLM prompts
  insertSb.run(11, 38, 1, '终局独白', 6, '旁白: 轰鸣声渐行渐远，硝烟笼罩了整片废墟。', '', '废墟高地，红狼屹立在落日余晖中，目光深邃注视前方。', '红狼握紧拳头，准备迎接下一场战斗。', JSON.stringify([25]), '远景', '平视', 'pan', 'pending');
  // Shot 2: narration in narration column directly
  insertSb.run(11, 38, 2, '未完待续', 5, '', '新的战火即将重燃，暗流在黑暗中悄然涌动。', '镜头缓缓拉远，红狼的身影融入暮色之中。', '画面渐隐。', JSON.stringify([25]), '全景', '俯视', 'pull', 'pending');

  const log = { info: () => {}, warn: () => {}, error: () => {} };
  const cfg = {};

  const res = await enrichEpisodeOntologySlots(db, log, cfg, 11);

  assert.equal(res.success, true);
  assert.equal(res.total_shots, 2);
  assert.equal(res.updated_shots, 2);

  const rows = db.prepare('SELECT * FROM storyboards WHERE episode_id = 11 ORDER BY storyboard_number ASC').all();
  assert.equal(rows.length, 2);

  // Check Shot 1 was converted to narration cleanly
  const row1 = rows[0];
  assert.equal(row1.dialogue, '');
  assert.equal(row1.narration, '轰鸣声渐行渐远，硝烟笼罩了整片废墟。');

  const sem1 = JSON.parse(row1.semantic_slots);
  assert.equal(sem1.speech_plan.is_narration, true);
  assert.equal(sem1.speech_plan.speaker_id, null);
  assert.equal(sem1.speech_plan.speaker_name, '旁白');

  const vid1 = JSON.parse(row1.video_slots);
  assert.equal(vid1.audio_lip_sync.mode, 'narration');
  assert.equal(vid1.audio_lip_sync.speaker_id, null);
  assert.equal(vid1.audio_lip_sync.speaker_in_frame, false);
  assert.equal(vid1.audio_lip_sync.visible_characters_lip_state, 'strictly_sealed');

  // Verify all character trajectories have mouth_state = sealed
  for (const seg of vid1.shots_timeline) {
    for (const t of (seg.character_trajectories || [])) {
      assert.equal(t.mouth_state, '双唇紧闭无口型');
    }
  }

  // Audit must be 100% valid with 0 errors
  assert.equal(res.audit.valid, true);
  assert.equal(res.audit.error_count, 0);
});
