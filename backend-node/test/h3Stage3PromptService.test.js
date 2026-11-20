'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const agentsRuntime = require('../src/services/agentsRuntime');
const stage3 = require('../src/services/h3Stage3PromptService');
const storyboardService = require('../src/services/storyboardService');

const silentLog = { info() {}, warn() {}, error() {} };

function setupDb(t) {
  const db = new Database(':memory:');
  runMigrationsAndEnsure(db);
  db.prepare(`INSERT INTO dramas (id, title, style, metadata, created_at, updated_at) VALUES (1, '剧目', 'photorealistic', '{"aspect_ratio":"16:9"}', '', '')`).run();
  db.prepare(`INSERT INTO episodes (id, drama_id, episode_number, title, created_at, updated_at) VALUES (10, 1, 1, '第一集', '', '')`).run();
  db.prepare(`INSERT INTO scenes (id, drama_id, location, time, prompt, created_at, updated_at) VALUES (38, 1, '废弃工厂内部战斗区', '夜晚', '混凝土立柱与火光', '', '')`).run();
  db.prepare(`INSERT INTO characters (id, drama_id, name, appearance, created_at, updated_at) VALUES (26, 1, '蜂医', '深色战术装束', '', '')`).run();
  db.prepare(`INSERT INTO storyboards (
    id, episode_id, scene_id, storyboard_number, title, description, location, time, duration,
    action, result, dialogue, narration, characters, background_characters,
    character_visuals, last_frame_visuals, semantic_slots, video_slots, status, created_at, updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    1267, 10, 38, 1, '归零撤离',
    '【镜头类型】特写\n【运镜】push\n【动作】旧描述', '废弃工厂内部战斗区', '夜晚', 5,
    '蜂医撤入火光', '画面定格在零', '', '定格的倒计时归零，蜂医的身影消失在火光中。',
    JSON.stringify([26]), JSON.stringify([]),
    JSON.stringify([{
      character_id: 26, name: '蜂医', depth_layer: 'background', screen_position: 'center_background',
      environmental_anchor: '火光区域', facing: 'away_from_camera', facing_target_id: null,
      head_pose: 'neutral', gaze_type: 'none', gaze_target_id: null, gaze_target_label: '',
      posture: 'walking', hands_state: 'relaxed', hands_object_id: null, hands_target_id: null,
      expression: 'neutral', expression_detail: '背影轮廓清晰', appearance_details: '深色战术服',
    }]),
    JSON.stringify([]),
    JSON.stringify({
      continuity_from_previous: {
        relationship: 'opening', previous_end_state: '', entry_state: '倒计时屏幕亮起', causal_link: '开场事件', sound_bridge: '', requires_previous_tail: false,
      },
      visible_characters: [{ id: 26, name: '蜂医' }],
      background_characters: [],
      offscreen_characters: [],
      identity_visibility: 'silhouette',
      speech_plan: { speaker_id: null, speaker_name: '旁白', is_offscreen: true, is_narration: true, text: '定格的倒计时归零，蜂医的身影消失在火光中。' },
      sound_plan: { sound_effects: ['倒计时滴答声骤停'], bgm_prompt: '低沉电子脉冲', acoustic_env: '工厂混响', is_silent: false },
      audio_lip_sync: 'offscreen_voiceover',
      continuity_type: 'scene_continuation',
      h3_mode: 'ref2va',
      first_frame_policy: 'none',
      last_frame_policy: 'none',
      required_references: [{ type: 'scene', id: 38, name: '废弃工厂内部战斗区' }, { type: 'character', id: 26, character_id: 26, name: '蜂医' }],
      shot_duration: 5,
      execution_backend: 'h3_single',
      continuum_plan: null,
    }),
    JSON.stringify({
      performance_contract: 'structured_sync',
      camera: { shot_type: 'close_up', movement: 'static' },
      audio_lip_sync: { mode: 'offscreen_voiceover', speaker_name: '旁白', speaker_in_frame: false, dialogue_content: '定格的倒计时归零，蜂医的身影消失在火光中。', visible_characters_lip_state: 'strictly_sealed', lip_sync_rule: '画内闭口' },
      timing: { duration: 5, pacing: '紧凑' },
      shots_timeline: [{
        shot_number: 1, timestamp: null, duration: 5,
        camera: { shot_type: 'close_up', movement: 'static', movement_description: '固定聚焦前景数字' },
        action: '倒计时归零，蜂医在背景火光中远去消失', result: '焦点留在归零数字上',
        visible_characters: [{ character_id: 26, name: '蜂医' }],
        audio_lip_sync: { mode: 'offscreen_voiceover', speaker_name: '旁白', speaker_in_frame: false, dialogue_content: '定格的倒计时归零，蜂医的身影消失在火光中。', visible_characters_lip_state: 'strictly_sealed', lip_sync_rule: '画内闭口' },
        speech_action_alignment: { mode: 'concurrent', speech_window: { start: 0, end: 5 }, speaker_character_id: null, speaker_action_window: { start: 0, end: 5 }, speaker_action: '倒计时归零，蜂医向火光移动', listener_reactions: [{ character_id: 26, action_window: { start: 0, end: 5 }, trajectory_action: 'react' }], pause_reason: '' },
        character_trajectories: [{
          character_id: 26, name: '蜂医', start_state: 'standing',
          action_atom: { action: 'walk', action_detail: '背对镜头步入火光中消失', body_part: 'whole_body', object_id: null, target_type: 'scene', target_id: null, target_label: '火光', direction: 'away_from_target', contact: 'none' },
          result_state: 'walking', reaction_trigger: { type: 'environment_event', source_id: null, source_label: '倒计时归零' },
          facing: 'away_from_camera', facing_target_id: null, head_pose: 'neutral',
          gaze_type: 'none', gaze_target_id: null, gaze_target_label: '',
          posture: 'walking', hands_state: 'relaxed', hands_object_id: null, hands_target_id: null,
          expression: 'neutral', expression_detail: '背影轮廓', mouth_state: 'offscreen_sealed',
        }],
      }],
    }),
    'pending', '', ''
  );
  t.after(() => db.close());
  return db;
}

const VALID_STAGE3_PROMPT = [
  'subject_definitions:',
  '<Subject 1> is the ruined industrial combat zone at night in <Picture 1>, lit by flickering background flames.',
  '<Subject 2> is the tactical operative in dark gear in <Picture 2>.',
  '<Audio 1> is the voice-timbre reference for the off-screen narrator (S1).',
  '',
  'summary:',
  '[reference generation + audio reference] Inside <Subject 1>, a close-up holds on a digital countdown display as it hits zero while <Subject 2> walks away into the flames and vanishes under an off-screen narration (S1).',
  '',
  'retention_analysis:',
  '<Subject 1> (appears in [Shot 1]): fully_preserved - retain the dark factory combat zone and orange fire glow.',
  '<Subject 2> (appears in [Shot 1]): partially_preserved - retain tactical silhouette and outfit from <Picture 2> seen from behind.',
  '<Audio 1>: reference - vocal timbre only.',
  '',
  'detailed_description:',
  'Natural photorealistic nocturnal action lighting with high contrast between cool screen glow and warm orange firelight.',
  '[Shot 1] Static tight close-up inside <Subject 1> focusing on a glowing countdown screen in the foreground as digits tick down to zero. Deep in the background glow, <Subject 2> stands turned away from camera and walks briskly into the flames until her silhouette vanishes completely. The off-screen narrator (S1), using the timbre from <Audio 1>, says, <d>[Chinese] 定格的倒计时归零，蜂医的身影消失在火光中。</d>',
  '',
  'overall_soundscape:',
  'Industrial room hum, accelerating countdown beeps stopping at zero, and crackling flames.',
  '',
  'non_diegetic_music:',
  'Low tense electronic pulse cutting off cleanly at zero.',
].join('\n');

test('loadOfficialH3Skill bundles SKILL.md, ref-en.txt, and base-en.txt locally', () => {
  const refSkill = stage3.loadOfficialH3Skill('ref2va');
  assert.equal(refSkill.guideFile, 'references/ref-en.txt');
  assert.match(refSkill.skill, /h3-prompt-writing/);
  assert.match(refSkill.guide, /subject_definitions/);

  const baseSkill = stage3.loadOfficialH3Skill('fl2va');
  assert.equal(baseSkill.guideFile, 'references/base-en.txt');
  assert.match(baseSkill.guide, /integrated_multimodal_description/);
});

test('Stage 3 compiles official prompt, retries invalid Chinese drafts, caches by fingerprint, and respects manual edit locks', async (t) => {
  const db = setupDb(t);
  let calls = 0;
  let lastInput = '';
  t.mock.method(agentsRuntime, 'runAgent', async (_db, _log, options) => {
    calls += 1;
    lastInput = options.input;
    assert.match(options.instructions, /Full-Reference Mode Rewrite Output Format Guide/);
    if (calls === 1) {
      return VALID_STAGE3_PROMPT.replace('Static tight close-up', '固定特写镜头');
    }
    return VALID_STAGE3_PROMPT;
  });

  const shot = db.prepare('SELECT * FROM storyboards WHERE id = 1267').get();
  const first = await stage3.ensureShotH3PromptCompiled(db, silentLog, shot, { dramaId: 1, aspectRatio: '16:9' });
  assert.equal(calls, 2, 'should retry once on Chinese prose violation');
  assert.equal(first.source, 'stage3_compiled');
  assert.equal(first.prompt, VALID_STAGE3_PROMPT);
  assert.equal(lastInput.includes('旧描述'), false, 'must never feed redundant Stage 1 shot.description');
  assert.equal(lastInput.includes('push'), false, 'must never leak contradictory Stage 1 movement');

  // 2. Subsequent check with unchanged contract hits fingerprint cache without calling LLM
  const freshShot = db.prepare('SELECT * FROM storyboards WHERE id = 1267').get();
  assert.equal(freshShot.h3_prompt_manual, 0);
  const cached = await stage3.ensureShotH3PromptCompiled(db, silentLog, freshShot, { dramaId: 1, aspectRatio: '16:9' });
  assert.equal(calls, 2, 'cache hit must not invoke LLM');
  assert.equal(cached.source, 'cache_hit');

  // 3. Manual edit locks h3_prompt_snapshot even if non-breaking slot attributes change later
  const manualText = VALID_STAGE3_PROMPT.replace('Low tense electronic pulse', 'Sparse deep bass drone');
  storyboardService.updateStoryboard(db, silentLog, 1267, {
    h3_prompt_snapshot: manualText,
    h3_prompt_manual: true,
    atmosphere: '极度危机与倒计时逼近',
  });
  const lockedShot = db.prepare('SELECT * FROM storyboards WHERE id = 1267').get();
  const lockedRes = await stage3.ensureShotH3PromptCompiled(db, silentLog, lockedShot, { dramaId: 1, aspectRatio: '16:9' });
  assert.equal(calls, 2, 'manual locked snapshot must not be overwritten automatically');
  assert.equal(lockedRes.source, 'manual_locked');
  assert.equal(lockedRes.prompt, manualText);

  // 4. Explicit forceRecompile unlocks and recompiles against updated 6s contract
  const unlocked = await stage3.ensureShotH3PromptCompiled(db, silentLog, lockedShot, {
    dramaId: 1, aspectRatio: '16:9', forceRecompile: true,
  });
  assert.equal(calls, 3);
  assert.equal(unlocked.source, 'stage3_compiled');
  assert.equal(db.prepare('SELECT h3_prompt_manual FROM storyboards WHERE id = 1267').get().h3_prompt_manual, 0);
});

test('Stage 3 fails loudly with no silent fallback when LLM fails or output never validates', async (t) => {
  const db = setupDb(t);
  t.mock.method(agentsRuntime, 'runAgent', async () => 'invalid single line output');
  const shot = db.prepare('SELECT * FROM storyboards WHERE id = 1267').get();
  await assert.rejects(
    () => stage3.ensureShotH3PromptCompiled(db, silentLog, shot, { dramaId: 1, maxAttempts: 2 }),
    /三阶官方 H3 提示词编译未通过校验/
  );
  assert.equal(db.prepare('SELECT h3_prompt_snapshot FROM storyboards WHERE id = 1267').get().h3_prompt_snapshot, null);
});

test('validateOfficialH3Prompt normalizes dialogue punctuation variations (curved vs straight quotes, etc.)', () => {
  const spec = {
    mode: 'ref2va',
    picture_bindings: [{ tag: '<Picture 1>' }],
    audio_bindings: [{ tag: '<Audio 1>' }],
    spoken_lines: [{
      key: 'character:24',
      kind: 'dialogue',
      speaker: '奕馨',
      text: '你昨天说马上，后来一直玩到睡觉。‘马上’是不是根本不会来？',
    }],
  };
  const promptWithStraightQuotes = [
    'subject_definitions:',
    '<Subject 1> is the room in <Picture 1>.',
    '<Audio 1> is the voice reference.',
    '',
    'summary:',
    'A tense confrontation between siblings.',
    '',
    'retention_analysis:',
    '<Subject 1> (appears in [Shot 1]): fully_preserved.',
    '<Audio 1>: vocal timbre only.',
    '',
    'detailed_description:',
    '[Shot 1] Inside the room, <Subject 1> sets the scene. The character speaks sharply: <d>[Chinese] 你昨天说马上，后来一直玩到睡觉。\'马上\'是不是根本不会来？</d> while glaring across the desk.',
    '',
    'overall_soundscape:',
    'Quiet room with ambient background hum.',
    '',
    'non_diegetic_music:',
    'Low subtle piano undertone.',
  ].join('\n');

  const result = stage3.validateOfficialH3Prompt(promptWithStraightQuotes, spec);
  assert.equal(result.valid, true, `Validation should pass with straight quotes: ${result.errors.join('; ')}`);
});

test('timeline performance continues across segments and preserves repeated speech exactly as scripted', (t) => {
  const db = setupDb(t);
  const shot = db.prepare('SELECT * FROM storyboards WHERE id=1267').get();
  const spec = stage3.buildStage3PromptSpec(db, shot);
  const timeline = spec.authoritative_contract.video_slots.shots_timeline;
  timeline.push({ ...timeline[0], camera: { shot_change: false }, timestamp: '00:02.000' });
  const skeleton = stage3.buildDeterministicStage3Skeleton(spec);
  assert.match(skeleton, /Continue same take/);
  assert.equal(skeleton.includes('[Shot 2]'), false);
  assert.equal(skeleton.match(/<d>/g).length, 1);
  const line = spec.spoken_lines[0].text;
  const duplicate = VALID_STAGE3_PROMPT.replace(line, line + line);
  assert.equal(stage3.validateOfficialH3Prompt(duplicate, spec).valid, false);
  spec.spoken_lines[0].text += line;
  assert.equal(stage3.validateOfficialH3Prompt(duplicate, spec).valid, true);
});

test('resume after an in-place edit invalidates only the edited shot and its continuity neighbors', (t) => {
  const db = setupDb(t);
  const checkpoint = require('../src/services/directorCheckpoint');
  for (let n = 2; n <= 5; n++) {
    db.prepare('INSERT INTO storyboards (episode_id, storyboard_number, created_at, updated_at) VALUES (10,?,?,?)').run(n, '', '');
  }
  for (const id of ['original', 'retry']) {
    db.prepare("INSERT INTO async_tasks (id,type,resource_id,status,created_at,updated_at) VALUES (?,'director_storyboard_generation','10','processing','','')").run(id);
  }
  const original = checkpoint.open(db, 'original', 10, {}, {});
  const rows = db.prepare('SELECT * FROM storyboards ORDER BY storyboard_number').all();
  Object.assign(original.state, { stage1Complete: true, stage1Storyboards: rows, enrichedShots: rows });
  original.capturePublished();
  db.prepare("UPDATE storyboards SET action='人工修改' WHERE storyboard_number=3").run();
  assert.throws(() => original.assertCurrent(), /已编辑/);
  db.prepare("UPDATE async_tasks SET status='failed' WHERE id='original'").run();
  const resumed = checkpoint.open(db, 'retry', 10, {}, {}, 'original');
  assert.deepEqual(resumed.state.enrichedShots.map(row => row.storyboard_number), [1, 5]);
  resumed.assertCurrent();
});

test('a manual edit during prompt compilation survives the pending model response', async (t) => {
  const db = setupDb(t);
  const shot = db.prepare('SELECT * FROM storyboards WHERE id=1267').get();
  t.mock.method(agentsRuntime, 'runAgent', async () => {
    db.prepare("UPDATE storyboards SET h3_prompt_manual=1,h3_prompt_snapshot='手动版本' WHERE id=1267").run();
    return VALID_STAGE3_PROMPT;
  });
  await assert.rejects(() => stage3.ensureShotH3PromptCompiled(db, silentLog, shot), /已更新/);
  assert.equal(db.prepare('SELECT h3_prompt_snapshot FROM storyboards WHERE id=1267').get().h3_prompt_snapshot, '手动版本');
});

test('ASR flags inserted, missing and repeated words including in silent shots', () => {
  const { compareSpeech } = require('../src/services/asrQualityAudit');
  assert.equal(compareSpeech('马上。', '马上马上').unexpected_speech, true);
  assert.equal(compareSpeech('马上马上。', '马上').missing_expected_dialogue, true);
  assert.equal(compareSpeech('马上马上。', '马上，马上').passed, true);
  assert.equal(compareSpeech('', '马上').unexpected_speech, true);
  assert.equal(compareSpeech('马上', 'language Chinese<asr_text>马上').passed, true);
  assert.equal(compareSpeech('', 'language None<asr_text>').passed, true);
});

test('a manual draft stays intact when its scene reference changes and can be reviewed against the new asset', async t => {
  const db = setupDb(t);
  const load = () => db.prepare('SELECT * FROM storyboards WHERE id=1267').get();
  const saveReview = () => storyboardService.updateStoryboard(db, silentLog, 1267, {
    h3_prompt_manual: true, h3_prompt_snapshot: VALID_STAGE3_PROMPT,
  });
  saveReview();
  db.prepare("UPDATE scenes SET local_path='replacement.png' WHERE id=38").run();
  await assert.rejects(stage3.ensureShotH3PromptCompiled(db, silentLog, load()), /复核（参考素材）/);
  assert.equal(load().h3_prompt_snapshot, VALID_STAGE3_PROMPT);
  saveReview();
  assert.equal((await stage3.ensureShotH3PromptCompiled(db, silentLog, load())).source, 'manual_locked');
});

test('reverse shots use each visible actor’s subject number with all their cards retained', t => {
  const db = setupDb(t);
  const shot = db.prepare('SELECT * FROM storyboards WHERE id=1267').get();
  const spec = stage3.buildStage3PromptSpec(db, shot, { refs: [
    { type: 'scene', id: 38 }, { type: 'character_sheet', character_id: 26 },
    { type: 'wardrobe', character_id: 26 }, { type: 'character', character_id: 27 },
  ] });
  const timeline = spec.authoritative_contract.video_slots.shots_timeline;
  timeline.push({ camera: { shot_change: true }, visible_characters: [{ character_id: 27 }] });
  const prompt = VALID_STAGE3_PROMPT.replace('gear in <Picture 2>.', 'gear in <Picture 2> and <Picture 3>.\n<Subject 3> is the listener in <Picture 4>.')
    .replace('\noverall_soundscape:', '\n[Shot 2] <Subject 3> turns to the doorway.\noverall_soundscape:');
  assert.deepEqual(stage3.validateOfficialH3Prompt(prompt, spec).errors, []);
  const wrong = prompt.replace('[Shot 2] <Subject 3>', '[Shot 2] <Subject 2>');
  assert.equal(stage3.validateOfficialH3Prompt(wrong, spec).valid, false);
  const wrongCard = prompt.replace('and <Picture 3>.', 'and <Picture 4>.');
  assert.equal(stage3.validateOfficialH3Prompt(wrongCard, spec).valid, false);
});

test('an unobservable outcome or unavailable vision provider cannot pass the visual review', async t => {
  const { auditVisibleOutcome } = require('../src/services/videoQualityGate');
  const client = require('../src/services/aiClient');
  const vision = t.mock.method(client, 'generateTextWithVision', async () => JSON.stringify({ status: 'mismatch', evidence: '书仍然打开。' }));
  const mismatch = await auditVisibleOutcome(null, silentLog, '书已合拢', 'tail.png');
  assert.equal(mismatch.status, 'mismatch');
  assert.equal(mismatch.frame, 'tail_frame');
  assert.equal(mismatch.target, '书已合拢');
  vision.mock.mockImplementation(async () => { throw new Error('offline'); });
  assert.equal((await auditVisibleOutcome(null, silentLog, '书已合拢', 'tail.png')).status, 'unverified');
});
