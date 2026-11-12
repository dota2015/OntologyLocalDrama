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
