const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { compileDramaSemanticPackage } = require('../src/ontology/semanticPackage');
const { extractAllEntitiesFromScript } = require('../src/ontology/extractionAgent');
const BeatCinematographyRule = require('../src/ontology/rules/beatCinematographyRule');
const CrowdControlRule = require('../src/ontology/rules/crowdControlRule');
const H3ReferenceCapacityRule = require('../src/ontology/rules/h3ReferenceCapacityRule');
const { CrossSlotInvariantsRule } = require('../src/ontology/rules/crossSlotRules');
const ai = require('../src/services/aiClient');

test('dramas.metadata.ontology_graph safely merges relations and partitions beats across episodes without wiping', async (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());

  db.exec(`
    CREATE TABLE dramas (
      id INTEGER PRIMARY KEY,
      title TEXT,
      genre TEXT,
      style TEXT,
      metadata TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE episodes (
      id INTEGER PRIMARY KEY,
      drama_id INTEGER,
      episode_number INTEGER,
      title TEXT,
      script_content TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE characters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      drama_id INTEGER,
      name TEXT,
      role TEXT,
      gender TEXT,
      appearance TEXT,
      description TEXT,
      personality TEXT,
      identity_anchors TEXT,
      voice_id TEXT,
      custom_voice_id TEXT,
      speed REAL,
      pitch REAL,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE episode_characters (
      episode_id INTEGER,
      character_id INTEGER,
      created_at TEXT,
      UNIQUE(episode_id, character_id)
    );
    CREATE TABLE scenes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      drama_id INTEGER,
      location TEXT,
      time TEXT,
      prompt TEXT,
      power_axis TEXT,
      landmarks TEXT,
      lighting_env TEXT,
      reference_image_mode TEXT,
      reference_image_recommendation TEXT,
      reference_image_reason TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE episode_scenes (
      episode_id INTEGER,
      scene_id INTEGER,
      created_at TEXT,
      UNIQUE(episode_id, scene_id)
    );
    CREATE TABLE props (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      drama_id INTEGER,
      episode_id INTEGER,
      name TEXT,
      type TEXT,
      description TEXT,
      prop_role TEXT,
      close_up_required INTEGER,
      owner_character_id INTEGER,
      physical_scale TEXT,
      era_category TEXT,
      era_compatibility TEXT,
      era_reason TEXT,
      prompt TEXT,
      image_prompt TEXT,
      reference_image_mode TEXT,
      reference_image_recommendation TEXT,
      reference_image_reason TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE storyboards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      episode_id INTEGER,
      scene_id INTEGER,
      characters TEXT,
      deleted_at TEXT
    );
    CREATE TABLE storyboard_props (
      storyboard_id INTEGER,
      prop_id INTEGER
    );
  `);

  // Insert drama with pre-existing metadata keys (dubbing, custom flags)
  const initialMeta = {
    custom_setting: 'keep_me_safe',
    dubbing: { voice_id: 'sample_voice' },
  };
  db.prepare(`
    INSERT INTO dramas (id, title, genre, style, metadata, created_at, updated_at)
    VALUES (1, '逆天神豪', '都市爽剧', '快节奏', ?, '2026-01-01', '2026-01-01')
  `).run(JSON.stringify(initialMeta));

  // Insert two episodes
  db.prepare(`INSERT INTO episodes (id, drama_id, episode_number, title, script_content) VALUES (101, 1, 1, '第1集', '叶辰亮出龙王黑金卡。')`).run();
  db.prepare(`INSERT INTO episodes (id, drama_id, episode_number, title, script_content) VALUES (102, 1, 2, '第2集', '王霸天震怒，命令保镖动手。')`).run();

  const log = { info() {}, warn() {}, error() {} };
  const cfg = {};

  // Mock LLM extraction response for Episode 101
  let ep101Call = true;
  t.mock.method(ai, 'generateText', async () => {
    if (ep101Call) {
      ep101Call = false;
      return JSON.stringify({
        characters: [{ name: '叶辰', role: '赘婿神豪', archetype: 'hidden_tycoon', power_status: 'dominant' }],
        props: [{ name: '龙王黑金卡', prop_role: 'key_token', close_up_required: true, physical_scale: '标准银行卡', era_category: 'modern', era_compatibility: 'compatible' }],
        scenes: [{ location: '宴会大厅', power_axis: '主位', landmarks: ['红毯', '主桌'] }],
        character_relations: [{ from_character: '王霸天', relation_kind: 'enemy_of', to_character: '叶辰', description: '家族死敌' }],
        narrative_beats: [{ beat_number: 1, beat_type: 'reveal', tension_level: 5, event_summary: '叶辰亮出黑金卡反转' }],
      });
    } else {
      // Episode 102 response
      return JSON.stringify({
        characters: [{ name: '王霸天', role: '嚣张家主', archetype: 'arrogant_antagonist', power_status: 'dominant' }],
        props: [{ name: '龙头拐杖', prop_role: 'conflict_tool', close_up_required: false, physical_scale: '1米实木拐杖', era_category: 'modern', era_compatibility: 'compatible' }],
        scenes: [{ location: '王家祠堂', power_axis: '高位座椅', landmarks: ['牌位', '宗族主椅'] }],
        character_relations: [{ from_character: '王霸天', relation_kind: 'superior_to', to_character: '保镖阿龙', description: '主仆命令' }],
        narrative_beats: [{ beat_number: 1, beat_type: 'suppression', tension_level: 4, event_summary: '王霸天极限施压' }],
      });
    }
  });

  // Extract Episode 101
  await extractAllEntitiesFromScript(db, log, cfg, 101);

  // Verify drama metadata after Ep 101
  let dramaRow = db.prepare('SELECT metadata FROM dramas WHERE id = 1').get();
  let meta = JSON.parse(dramaRow.metadata);
  assert.equal(meta.custom_setting, 'keep_me_safe', 'Pre-existing metadata must NOT be overwritten');
  assert.equal(meta.dubbing.voice_id, 'sample_voice');
  assert.equal(meta.ontology_graph.relations.length, 1);
  assert.equal(meta.ontology_graph.relations[0].from_character, '王霸天');
  assert.equal(meta.ontology_graph.beats['101'].length, 1);
  assert.equal(meta.ontology_graph.beats['101'][0].beat_type, 'reveal');

  // Extract Episode 102
  await extractAllEntitiesFromScript(db, log, cfg, 102);

  // Verify drama metadata after Ep 102
  dramaRow = db.prepare('SELECT metadata FROM dramas WHERE id = 1').get();
  meta = JSON.parse(dramaRow.metadata);
  assert.equal(meta.custom_setting, 'keep_me_safe', 'Pre-existing metadata must still be preserved');
  assert.equal(meta.ontology_graph.relations.length, 2, 'Relations must be incrementally merged across episodes');
  assert.ok(meta.ontology_graph.beats['101'], 'Episode 101 beats must NOT be erased by Episode 102 extraction');
  assert.ok(meta.ontology_graph.beats['102'], 'Episode 102 beats must be saved');
  assert.equal(meta.ontology_graph.beats['101'][0].beat_type, 'reveal');
  assert.equal(meta.ontology_graph.beats['102'][0].beat_type, 'suppression');

  // Verify compileDramaSemanticPackage for Ep 101 and 102
  const pkg101 = compileDramaSemanticPackage(db, 101);
  assert.equal(pkg101.narrative_beats.length, 1);
  assert.equal(pkg101.narrative_beats[0].beat_type, 'reveal');
  assert.equal(pkg101.ontology_graph.relations.length, 2);

  const pkg102 = compileDramaSemanticPackage(db, 102);
  assert.equal(pkg102.narrative_beats.length, 1);
  assert.equal(pkg102.narrative_beats[0].beat_type, 'suppression');
});

test('beat cinematography rule enforces close-up on key tokens and sting audio on suppression/slap', () => {
  const rule = new BeatCinematographyRule();
  const catalogs = {
    props: [
      { id: 10, name: '至尊龙王戒', prop_role: 'key_token', close_up_required: true },
    ],
    characters: [
      { id: 1, name: '嚣张阔少', power_status: 'dominant' },
      { id: 2, name: '隐忍主角', power_status: 'suppressed' },
    ],
  };

  // Missing prop on reveal
  const vMissingProp = rule.evaluate({
    shots: [{ shot_number: 1, beat_type: 'reveal', shot_type: '特写', props: [] }],
    catalogs,
  });
  assert.ok(vMissingProp.some((v) => v.rule === 'INVARIANT_KEY_PROP_REFERENCE_MISSING'));

  // Wide shot on key token prop
  const vWideKeyProp = rule.evaluate({
    shots: [{ shot_number: 2, beat_type: 'reveal', shot_type: '全景', props: [10], sound_plan: { sound_effects: ['sting'] } }],
    catalogs,
  });
  assert.ok(vWideKeyProp.some((v) => v.rule === 'INVARIANT_KEY_PROP_CLOSE_UP_REQUIRED'));

  // Missing sting SFX on slap_reversal
  const vMissingSfx = rule.evaluate({
    shots: [{ shot_number: 3, beat_type: 'slap_reversal', shot_type: '特写', sound_plan: { sound_effects: [] } }],
    catalogs,
  });
  assert.ok(vMissingSfx.some((v) => v.rule === 'INVARIANT_BEAT_AUDIO_IMPACT_MISSING'));

  // Suppression dominant figure with high angle (looking down at dominant)
  const vAngleDominant = rule.evaluate({
    shots: [{ shot_number: 4, beat_type: 'suppression', shot_type: '中景', characters: [1], angle_v: 'high', sound_plan: { sound_effects: ['重音刺入'] } }],
    catalogs,
  });
  assert.ok(vAngleDominant.some((v) => v.rule === 'INVARIANT_SUPPRESSION_ANGLE_MISMATCH' && v.message.includes('dominant')));

  // Suppression suppressed figure with low angle (looking up at victim)
  const vAngleSuppressed = rule.evaluate({
    shots: [{ shot_number: 5, beat_type: 'suppression', shot_type: '近景', characters: [2], angle_v: 'low', sound_plan: { sound_effects: ['打脸音效'] } }],
    catalogs,
  });
  assert.ok(vAngleSuppressed.some((v) => v.rule === 'INVARIANT_SUPPRESSION_ANGLE_MISMATCH' && v.message.includes('suppressed')));
});
