const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const agentsRuntime = require('../src/services/agentsRuntime');
const {
  projectCanonicalShotContract,
  ensureDirectorExecutionSlots,
} = require('../src/ontology/directorAgent');
const {
  stageOnePlanningViolations,
  deriveStoryboardFieldsFromAi,
} = require('../src/services/episodeStoryboardService');
const {
  buildDeterministicStage3Skeleton,
  validateOfficialH3Prompt,
} = require('../src/services/h3Stage3PromptService');
const {
  extractAllEntitiesFromScript,
} = require('../src/ontology/extractionAgent');
const aiClient = require('../src/services/aiClient');

test('projectCanonicalShotContract: projects duration, execution_backend, character IDs, without rewriting opening performances', () => {
  // Case A: Long shot (>= 9s) -> h3_continuum, dialogue synced
  const shotA = {
    duration: 10,
    dialogue: '陆天宇: 你们今日对我的羞辱，日后必当百倍奉还！',
    action: '陆天宇昂首冷对众人，眼中寒光凛冽',
    semantic_slots: {
      visible_characters: [{ id: 1, name: '陆天宇' }, { id: 2, name: '赵长老' }],
      background_characters: [{ id: 3, name: '护卫甲' }],
      offscreen_characters: [],
      speech_plan: {
        speaker_id: 1,
        mode: 'onscreen_speaking',
        text: '你们今日对我的羞辱，日后必当百倍奉还！',
      },
    },
    character_visuals: [
      { character_id: 1, mouth_state: 'strictly_sealed' },
      { character_id: 2, mouth_state: 'speaking' }, // invalid for non-speaking listener
    ],
    video_slots: {
      execution_backend: 'h3_single', // intentionally mismatched
    },
  };

  const projectedA = projectCanonicalShotContract(shotA);
  assert.equal(projectedA.duration, 10);
  assert.equal(projectedA.video_slots.execution_backend, 'h3_continuum');
  assert.deepEqual(projectedA.characters, [1, 2]);
  assert.deepEqual(projectedA.background_characters, [3]);
  assert.equal(projectedA.video_slots.audio_lip_sync.dialogue_content, '你们今日对我的羞辱，日后必当百倍奉还！');
  assert.equal(projectedA.character_visuals[0].mouth_state, 'strictly_sealed');
  assert.equal(projectedA.character_visuals[1].mouth_state, 'speaking');

  // Case B: Short shot (< 9s) -> h3_single, silent ambient -> strictly_sealed
  const shotB = {
    duration: 4,
    dialogue: '',
    narration: '',
    action: '陆天宇默默收起玉佩，转身离去',
    semantic_slots: {
      visible_characters: [{ id: 1, name: '陆天宇' }],
      background_characters: [],
      speech_plan: {
        speaker_id: null,
        mode: 'silent_ambient',
        text: '',
      },
    },
    character_visuals: [
      { character_id: 1, mouth_state: 'speaking' }, // invalid for silent
    ],
    video_slots: {},
  };

  const projectedB = projectCanonicalShotContract(shotB);
  assert.equal(projectedB.duration, 4);
  assert.equal(projectedB.video_slots.execution_backend, 'h3_single');
  assert.equal(projectedB.character_visuals[0].mouth_state, 'speaking');
  assert.equal(projectedB.video_slots.audio_lip_sync.dialogue_content, '');
});

test('ensureDirectorExecutionSlots: participant conservation allows offscreen reassignments without deadlocks', async () => {
  const originalRunAgent = agentsRuntime.runAgent;
  const stageOneShot = {
    id: 101,
    storyboard_number: 1,
    duration: 4,
    dialogue: '神秘人: 事情办得怎么样了？',
    action: '陆天宇按住耳机，神情严肃',
    characters: [1, 2], // Stage 1 placed caller 2 in visible characters
    background_characters: [],
    scene_id: 10,
  };

  const catalogs = {
    characters: [
      { id: 1, name: '陆天宇' },
      { id: 2, name: '神秘人' },
    ],
    scenes: [{ id: 10, name: '书房' }],
    props: [],
  };

  const baseSegment = {
    shot_number: 1,
    start_time: 0,
    end_time: 4,
    duration: 4,
    camera: { shot_type: 'close_up', movement: 'static', movement_description: '固定机位', angle_h: 'eye_level', angle_v: 'level' },
    action: '陆天宇按住耳机迅速站起身',
    result: '保持站姿警戒神情凝重',
    visible_characters: [{ character_id: 1, name: '陆天宇' }],
    character_trajectories: [{
      character_id: 1,
      name: '陆天宇',
      character_name: '陆天宇',
      start_state: 'sitting',
      action_atom: {
        action: 'stand_up',
        action_detail: '按住耳机迅速站起身',
        body_part: 'legs',
        object_id: null,
        target_type: 'scene',
        target_id: null,
        target_label: '书房',
        direction: 'forward',
        contact: 'none',
      },
      result_state: 'standing',
      reaction_trigger: { type: 'dialogue', source_id: 2, source_label: '电话指令' },
      screen_position: 'center_foreground',
      depth_layer: 'foreground',
      facing: 'front_camera',
      head_pose: 'neutral',
      gaze_type: 'offscreen',
      gaze: { gaze_type: 'offscreen', gaze_target_label: '画外方向' },
      mouth_state: 'offscreen_sealed',
      posture: 'standing',
      hands_state: 'pointing',
      expression: 'alert',
      expression_detail: '神情专注警觉',
    }],
    audio_lip_sync: {
      mode: 'offscreen_voiceover',
      speaker_name: '神秘人',
      speaker_in_frame: false,
      dialogue_content: '事情办得怎么样了？',
      visible_characters_lip_state: 'strictly_sealed',
      lip_sync_rule: '画外音闭口',
    },
    speech_action_alignment: {
      mode: 'concurrent',
      speech_window: { start: 0, end: 4 },
      speaker_character_id: null,
      speaker_action_window: { start: 0, end: 4 },
      listener_reactions: [],
      pause_reason: '',
    },
  };

  const stageTwoContract = {
    semantic_slots: {
      visible_characters: [{ id: 1, name: '陆天宇' }],
      background_characters: [],
      offscreen_characters: [{ id: 2, name: '神秘人', character_id: 2, mode: 'remote_voice' }],
      speech_plan: {
        speaker_id: 2,
        speaker_name: '神秘人',
        mode: 'offscreen_voiceover',
        is_offscreen: true,
        is_narration: false,
        text: '事情办得怎么样了？',
      },
      first_frame_policy: 'none',
      last_frame_policy: 'none',
      h3_mode: 'ref2va',
      required_references: [
        { type: 'scene', scene_id: 10 },
        { type: 'character', character_id: 1 },
      ],
      source_script_excerpt: '神秘人: 事情办得怎么样了？',
      shot_duration: 4,
      continuity_from_previous: {
        relationship: 'none',
        previous_end_state: '',
        entry_state: '',
        causal_link: '',
        sound_bridge: '',
        requires_previous_tail: false,
      },
    },
    character_visuals: [{
      character_id: 1,
      name: '陆天宇',
      depth_layer: 'foreground',
      screen_position: 'center_foreground',
      environmental_anchor: '书桌旁',
      facing: 'front_camera',
      facing_target_id: null,
      head_pose: 'neutral',
      gaze_type: 'offscreen',
      gaze_target_id: null,
      gaze_target_label: '画外方向',
      posture: 'standing',
      hands_state: 'free',
      hands_object_id: null,
      hands_target_id: null,
      expression: 'focused',
      expression_detail: '面色冷峻',
      appearance_details: '黑色风衣',
      mouth_state: 'strictly_sealed',
    }],
    last_frame_visuals: [],
    video_slots: {
      timing: { duration: 4, pacing: 'medium' },
      performance_contract: 'structured_sync',
      camera: { shot_type: 'close_up', movement: 'static', movement_description: '固定机位' },
      audio_lip_sync: {
        mode: 'offscreen_voiceover',
        speaker_name: '神秘人',
        speaker_in_frame: false,
        dialogue_content: '事情办得怎么样了？',
        visible_characters_lip_state: 'strictly_sealed',
        lip_sync_rule: '画外音闭口',
      },
      shots_timeline: [baseSegment],
    },
  };

  try {
    agentsRuntime.runAgent = async () => stageTwoContract;

    const planned = await ensureDirectorExecutionSlots({}, { info() {}, warn() {} }, stageOneShot, {
      forceAgent: true,
      maxAttempts: 1,
      catalogs,
    });

    // Participant conservation preserved: characters updated to [1], background to [], offscreen to [2]
    assert.deepEqual(planned.characters, [1]);
    assert.deepEqual(planned.background_characters, []);
    assert.deepEqual(planned.semantic_slots.offscreen_characters.map((c) => c.id || c.character_id), [2]);
  } finally {
    agentsRuntime.runAgent = originalRunAgent;
  }
});

test('stageOnePlanningViolations: does not infer wardrobe changes from action text', () => {
  const mutatingShot = {
    shot_number: 1,
    duration: 5,
    action: '换上备用电池',
    result: '换装完毕，闪身消失在暗处',
    dialogue: '',
  };

  const violations = stageOnePlanningViolations([mutatingShot]);
  const wardrobeViolation = violations.find((v) => v.rule === 'INVARIANT_MID_SHOT_WARDROBE_MUTATION');
  assert.equal(wardrobeViolation, undefined);
});

test('deriveStoryboardFieldsFromAi: derives beat_type and offscreen_characters into semantic_slots', () => {
  const aiShot = {
    shot_number: 1,
    duration: 5,
    dialogue: '陆天宇: 跪下！',
    action: '陆天宇亮出黑金卡，气场全开',
    beat_type: 'slap_reversal',
    characters: [1],
    offscreen_characters: [2],
  };

  const derived = deriveStoryboardFieldsFromAi(aiShot, '', '9:16', {
    dramaCharacters: [
      { id: 1, name: '陆天宇', character_profiles: [] },
      { id: 2, name: '反派首领', character_profiles: [] },
    ],
    scenes: [],
    props: [],
    drama: { name: '龙王出山' },
  });

  assert.equal(derived.beatType, 'slap_reversal');
  assert.ok(derived.semanticSlots);
  assert.equal(derived.semanticSlots.beat_type, 'slap_reversal');
  assert.deepEqual(derived.semanticSlots.offscreen_characters, [
    { id: 2, character_id: 2, name: '反派首领', mode: 'present_offscreen' },
  ]);
});

test('buildDeterministicStage3Skeleton & validateOfficialH3Prompt: enforces Subject bindings and closed lips', () => {
  const spec = {
    mode: 'ref2va',
    storyboard_id: 3,
    shot_number: 1,
    duration_seconds: 5,
    picture_bindings: [
      { type: 'scene', tag: '<Picture 1>', picture_index: 1, subject_tag: '<Subject 1>', role: 'scene', name: '龙王殿' },
      { type: 'character', tag: '<Picture 2>', picture_index: 2, subject_tag: '<Subject 2>', role: 'character', character_id: 1, name: '陆天宇', appearance: '黑色风衣' },
      { type: 'prop', tag: '<Picture 3>', picture_index: 3, subject_tag: '<Subject 3>', role: 'prop', prop_id: 10, name: '黑金令牌', appearance: '玄铁铸造令牌' },
    ],
    audio_bindings: [
      { tag: '<Audio 1>', speaker_name: '陆天宇', kind: 'speech' },
    ],
    spoken_lines: [
      { text: '见此令如见龙主！', speaker: '陆天宇', language: 'Chinese' },
    ],
    visible_characters: [{ id: 1, name: '陆天宇' }],
    dialogue_content: '见此令如见龙主！',
    authoritative_contract: {
      semantic_slots: {
        visible_characters: [{ id: 1, name: '陆天宇' }],
        speech_plan: {
          text: '见此令如见龙主！',
          speaker_name: '陆天宇',
        },
      },
      video_slots: {
        shots_timeline: [
          {
            shot_number: 1,
            duration: 5,
            camera: { shot_type: 'close_up', movement: 'push', angle_h: 'eye_level', angle_v: 'level' },
            visible_characters: [{ character_id: 1 }],
            character_trajectories: [
              {
                character_name: '陆天宇',
                character_id: 1,
                screen_position: 'center_foreground',
                depth_layer: 'foreground',
                facing: 'front',
                mouth_state: 'speaker_synced',
                action_atom: { action: 'hold', action_detail: '高举令牌' },
                result_state: 'commanding_stance',
              },
            ],
            audio_lip_sync: {
              dialogue_content: '见此令如见龙主！',
            },
          },
        ],
      },
    },
  };

  const skeleton = buildDeterministicStage3Skeleton(spec);
  assert.ok(skeleton.includes('<Subject 1>'));
  assert.ok(skeleton.includes('<Subject 2>'));
  assert.ok(skeleton.includes('<Subject 3>'));
  assert.ok(skeleton.includes('[Shot 1]'));
  assert.ok(skeleton.includes('高举令牌'));
  assert.ok(skeleton.includes('见此令如见龙主！'));

  // Validation: passing case
  const validPrompt = [
    'subject_definitions:',
    '<Subject 1> is the setting in <Picture 1>.',
    '<Subject 2> is the character in <Picture 2>.',
    '<Subject 3> is the prop in <Picture 3>.',
    '<Audio 1> is the voice for <Subject 2>.',
    '',
    'summary:',
    'A dramatic confrontation shot featuring <Subject 2> holding <Subject 3>.',
    '',
    'retention_analysis:',
    '<Subject 1> (appears in [Shot 1]): fully_preserved.',
    '<Subject 2> (appears in [Shot 1]): fully_preserved.',
    '<Subject 3> (appears in [Shot 1]): fully_preserved.',
    '<Audio 1>: reference.',
    '',
    'detailed_description:',
    'Cinematic contrast lighting.',
    '[Shot 1] Close-up of <Subject 2> referenced from <Picture 2> speaking <d>见此令如见龙主！</d> holding <Subject 3> inside <Subject 1>.',
    '',
    'overall_soundscape:',
    'Dramatic indoor ambience.',
    '',
    'non_diegetic_music:',
    'Intense orchestral drum beat.',
  ].join('\n');

  const reportValid = validateOfficialH3Prompt(validPrompt, spec);
  assert.equal(reportValid.valid, true, `Validation should pass: ${JSON.stringify(reportValid.errors)}`);

  // Validation: missing visible character subject tag
  const missingSubjectPrompt = validPrompt.replace('<Subject 2> referenced from <Picture 2>', 'The man');
  const reportMissing = validateOfficialH3Prompt(missingSubjectPrompt, spec);
  assert.equal(reportMissing.valid, false);
  assert.ok(reportMissing.errors.some((v) => v.includes('<Subject 2>') || v.includes('<Picture 2>')));

  // Validation: non-dialogue closed lips enforcement
  const silentSpec = {
    ...spec,
    spoken_lines: [],
    dialogue_content: '',
    speaking_character_id: null,
    character_visuals: [{ character_id: 1, mouth_state: 'strictly_sealed' }],
    authoritative_contract: {
      semantic_slots: {
        audio_lip_sync: 'silent_ambient',
        visible_characters: [{ id: 1, name: '陆天宇' }],
      },
      video_slots: {
        audio_lip_sync: { mode: 'silent_ambient' },
      },
    },
  };
  const silentPrompt = [
    'subject_definitions:',
    '<Subject 1> is the setting in <Picture 1>.',
    '<Subject 2> is the character in <Picture 2>.',
    '',
    'summary:',
    'Silent shot of <Subject 2>.',
    '',
    'retention_analysis:',
    '<Subject 1> (appears in [Shot 1]): fully_preserved.',
    '<Subject 2> (appears in [Shot 1]): fully_preserved.',
    '',
    'detailed_description:',
    'Cinematic lighting.',
    '[Shot 1] <Subject 2> <Picture 2> stands in <Subject 1> and says <d>[Chinese] 不该出现的发言</d>.',
    '',
    'overall_soundscape:',
    'Silent ambient.',
    '',
    'non_diegetic_music:',
    'None.',
  ].join('\n');
  const reportViolatingSpeaking = validateOfficialH3Prompt(silentPrompt, silentSpec);
  assert.equal(reportViolatingSpeaking.valid, false);
  assert.ok(reportViolatingSpeaking.errors.some((v) => v.includes('逐字台词')));
});

test('extractionAgent: incrementally upserts relations and saves beats per episode', async () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE dramas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      genre TEXT,
      style TEXT,
      metadata TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE characters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      drama_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      role TEXT,
      appearance TEXT,
      description TEXT,
      personality TEXT,
      identity_anchors TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE episode_characters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      episode_id INTEGER NOT NULL,
      character_id INTEGER NOT NULL
    );
    CREATE TABLE scenes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      drama_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      location TEXT,
      time TEXT,
      prompt TEXT,
      reference_image_mode TEXT,
      reference_image_recommendation TEXT,
      reference_image_reason TEXT,
      description TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE props (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      drama_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      type TEXT,
      description TEXT,
      era_category TEXT,
      era_compatibility TEXT,
      era_reason TEXT,
      physical_scale TEXT,
      prompt TEXT,
      image_prompt TEXT,
      reference_image_mode TEXT,
      reference_image_recommendation TEXT,
      reference_image_reason TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      drama_id INTEGER NOT NULL,
      episode_number INTEGER NOT NULL,
      title TEXT NOT NULL,
      script_content TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE TABLE storyboards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      episode_id INTEGER NOT NULL,
      characters TEXT,
      scene_id INTEGER,
      deleted_at TEXT
    );
    CREATE TABLE storyboard_props (
      storyboard_id INTEGER NOT NULL,
      prop_id INTEGER NOT NULL
    );
  `);

  const initialMetadata = {
    ontology_graph: {
      episodes_beats: {
        '1': [{ beat_id: 'b1', beat_type: 'hook', description: '第1集开局' }],
      },
      relations: [
        {
          from_type: 'character',
          from_id: 1,
          relation_kind: 'rivalry',
          to_type: 'character',
          to_id: 2,
          description: '最初宿敌关系',
        },
      ],
    },
  };

  db.prepare('INSERT INTO dramas (id, title, metadata) VALUES (1, ?, ?)').run('测试短剧', JSON.stringify(initialMetadata));
  db.prepare('INSERT INTO episodes (id, drama_id, episode_number, title, script_content) VALUES (2, 1, 2, ?, ?)').run('第2集', '第2集剧本内容');

  const originalGenerateText = aiClient.generateText;
  try {
    aiClient.generateText = async () => JSON.stringify({
      characters: [],
      scenes: [],
      props: [],
      character_relations: [
        // Update existing relation description
        {
          from_type: 'character',
          from_id: 1,
          relation_kind: 'rivalry',
          to_type: 'character',
          to_id: 2,
          description: '生死宿敌关系',
        },
        // Add new relation
        {
          from_type: 'character',
          from_id: 1,
          relation_kind: 'possesses_token',
          to_type: 'prop',
          to_id: 10,
          description: '持有黑金令牌',
        },
      ],
      narrative_beats: [
        { beat_id: 'b2_1', beat_type: 'slap_reversal', description: '第2集反转打脸' },
      ],
    });

    const mockLog = { info() {}, warn() {}, error() {} };
    await extractAllEntitiesFromScript(db, mockLog, {}, 2);

    const updatedRow = db.prepare('SELECT metadata FROM dramas WHERE id = 1').get();
    const updatedMeta = JSON.parse(updatedRow.metadata);
    const graph = updatedMeta.ontology_graph;

    // Verify episode 1 beats preserved and episode 2 beats added
    assert.ok(graph.episodes_beats['1']);
    assert.equal(graph.episodes_beats['1'][0].beat_type, 'hook');
    assert.ok(graph.episodes_beats['2']);
    assert.equal(graph.episodes_beats['2'][0].beat_type, 'slap_reversal');

    // Verify relations merged with composite key (should have 2 relations total, not duplicate 1->rivalry->2)
    assert.equal(graph.relations.length, 2);
    const rivalry = graph.relations.find((r) => r.relation_kind === 'rivalry');
    assert.equal(rivalry.description, '生死宿敌关系');
    const token = graph.relations.find((r) => r.relation_kind === 'possesses_token');
    assert.equal(token.to_id, 10);
  } finally {
    aiClient.generateText = originalGenerateText;
    db.close();
  }
});

test('consecutive single-speaker clips can advance the same narrative beat', () => {
  const clips = ['甲：回去吗？', '乙：回去。'].map((dialogue, i) => ({ shot_number: i + 1, duration: 4, beat_id: 1, dialogue }));
  assert.deepEqual(stageOnePlanningViolations(clips), []);
  const errors = stageOnePlanningViolations([...clips, { ...clips[0], beat_id: 2 }, clips[0]]);
  assert.ok(errors.some(v => v.rule === 'INVARIANT_STAGE1_BEAT_GROUP'));
});

test('mouth synchronization follows the active speaking segment, including a silent opening', () => {
  const { validateVideoSlots } = require('../src/ontology/videoSlots');
  const segments = [
    { mode: 'silent_ambient', speaker_in_frame: false, dialogue_content: '' },
    { mode: 'in_frame_dialogue', speaker_in_frame: true, dialogue_content: '到了。' },
    { mode: 'offscreen_voiceover', speaker_in_frame: false, dialogue_content: '走吧。' },
  ].map((audio, i) => ({
    duration: 2, timestamp: i * 2, audio_lip_sync: audio, visible_characters: [1, 2],
    character_trajectories: [1, 2].map(id => ({ character_id: id, mouth_state: i === 1 && id === 1 ? 'speaker_synced' : 'closed' })),
    speech_action_alignment: { mode: 'concurrent', speaker_character_id: 1 },
  }));
  const slots = { performance_contract: 'structured_sync', timing: { duration: 6 }, shots_timeline: segments };
  const check = () => validateVideoSlots({ duration: 6, semantic_slots: { speech_plan: { speaker_id: 1 } } }, slots)
    .filter(item => ['INVARIANT_SEGMENT_MOUTH_CONFLICT', 'INVARIANT_SPEAKER_MOUTH_STATE_INVALID'].includes(item.rule));
  assert.deepEqual(check(), []);
  segments[0].character_trajectories[0].mouth_state = 'speaker_synced';
  segments[1].character_trajectories[1].mouth_state = 'speaker_synced';
  segments[2].character_trajectories[0].mouth_state = 'speaker_synced';
  assert.equal(check().length, 3);
});
