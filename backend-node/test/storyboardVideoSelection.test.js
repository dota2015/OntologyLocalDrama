const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const migrate = require('../src/db/migrate');
const storyboardService = require('../src/services/storyboardService');
const videoService = require('../src/services/videoService');
const dramaService = require('../src/services/dramaService');
const episodeStoryboardService = require('../src/services/episodeStoryboardService');

const log = { info() {}, warn() {}, error() {} };

function setupDb(t) {
  const db = new Database(':memory:');
  t.after(() => { if (db.open) db.close(); });
  migrate.runMigrationsAndEnsure(db);
  db.exec(`
    INSERT INTO dramas(id, title) VALUES(1, '测试剧');
    INSERT INTO episodes(id, drama_id, episode_number) VALUES(10, 1, 1);
    INSERT INTO storyboards(id, episode_id, storyboard_number, duration, title, local_path, image_url)
    VALUES(100, 10, 1, 5, '镜头1', 'images/sb_first_frame.png', 'http://example/first.png');
    INSERT INTO video_generations(id, drama_id, storyboard_id, status, video_url, local_path)
    VALUES
      (501, 1, 100, 'completed', 'http://example/video1.mp4', 'videos/501.mp4'),
      (502, 1, 100, 'completed', 'http://example/video2.mp4', 'videos/502.mp4');
  `);
  return db;
}

test('storyboard video selection persistence across refresh and services', async (t) => {
  const db = setupDb(t);

  // 1. Initial state: storyboard has no selected_video_id
  let sb = storyboardService.getStoryboardById(db, 100);
  assert.equal(sb.selected_video_id, null);
  assert.equal(sb.local_path, 'images/sb_first_frame.png');

  // 2. User switches to video 502
  const updated = storyboardService.updateStoryboard(db, log, 100, {
    selected_video_id: 502,
    video_url: 'http://example/video2.mp4',
  });
  assert.equal(updated.selected_video_id, 502);
  assert.equal(updated.video_url, 'http://example/video2.mp4');
  // Confirm local_path for first frame image was NOT corrupted
  assert.equal(updated.local_path, 'images/sb_first_frame.png');

  // 3. Confirm getStoryboardById returns selected_video_id
  sb = storyboardService.getStoryboardById(db, 100);
  assert.equal(sb.selected_video_id, 502);

  // 4. Confirm episodeStoryboardService returns selected_video_id
  const epSbList = episodeStoryboardService.getStoryboardsForEpisode(db, 10);
  assert.equal(epSbList.length, 1);
  assert.equal(epSbList[0].selected_video_id, 502);

  // 5. Confirm dramaService getDrama returns selected_video_id in episode storyboards
  const drama = dramaService.getDrama(db, 1);
  const dramaSb = drama.episodes[0].storyboards[0];
  assert.equal(dramaSb.selected_video_id, 502);

  // 6. Delete the selected video: videoService.deleteById soft-deletes the video and clears selected_video_id
  const ok = videoService.deleteById(db, log, 502);
  assert.equal(ok, true);

  const deletedVid = db.prepare('SELECT deleted_at FROM video_generations WHERE id=502').get();
  assert.ok(deletedVid.deleted_at);

  sb = storyboardService.getStoryboardById(db, 100);
  assert.equal(sb.selected_video_id, null);
});

test('page reload and episode refresh preserve the same director slots as storyboard detail', (t) => {
  const db = setupDb(t);
  const slots = {
    semantic_slots: { h3_mode: 'ref2va', first_frame_policy: 'none', last_frame_policy: 'none', speech_plan: { text: '你好。' } },
    video_slots: { audio_lip_sync: { dialogue_content: '你好。' } },
    character_visuals: [{ character_id: 1, gaze: '看向对方' }],
    last_frame_visuals: [],
  };
  db.prepare(`UPDATE storyboards SET semantic_slots=?, video_slots=?, character_visuals=?, last_frame_visuals=?,
    creation_mode='universal', local_path=NULL, image_url=NULL WHERE id=100`)
    .run(...Object.values(slots).map(value => JSON.stringify(value)));
  const before = db.prepare('SELECT * FROM storyboards WHERE id=100').get();
  const routes = {
    pageReload: dramaService.getDrama(db, 1).episodes[0].storyboards[0],
    dramaList: dramaService.listDramas(db, {}).dramas[0].episodes[0].storyboards[0],
    episodeRefresh: episodeStoryboardService.getStoryboardsForEpisode(db, 10)[0],
    detail: storyboardService.getStoryboardById(db, 100),
  };
  for (const [route, shot] of Object.entries(routes)) {
    for (const [field, value] of Object.entries(slots)) assert.deepEqual(shot[field], value, `${route}.${field}`);
    assert.equal(shot.creation_mode, 'universal', route);
    // Same slot gate used by the batch-video button, with no storyboard image.
    assert.ok(shot.id && Object.keys(shot.semantic_slots).length && typeof shot.video_slots === 'object', route);
  }
  assert.deepEqual(db.prepare('SELECT * FROM storyboards WHERE id=100').get(), before);
});

test('metadata-only edits preserve semantic slots and semantic conflicts return named violations', (t) => {
  const db = setupDb(t);
  const originalSlots = JSON.stringify({
    visible_characters: [],
    background_characters: [],
    speech_plan: {},
    sound_plan: { is_silent: true, sound_effects: [] },
    continuity_type: 'hard_cut',
    first_frame_policy: 'generate_new',
    last_frame_policy: 'none',
    required_references: [],
    audio_lip_sync: 'none',
    shot_duration: 5,
  });
  db.prepare('UPDATE storyboards SET semantic_slots=? WHERE id=100').run(originalSlots);

  storyboardService.updateStoryboard(db, log, 100, { title: '仅修改标题' });
  assert.equal(db.prepare('SELECT semantic_slots FROM storyboards WHERE id=100').get().semantic_slots, originalSlots);

  assert.throws(
    () => storyboardService.updateStoryboard(db, log, 100, {
      dialogue: '妈妈："快回来。"',
      semantic_slots: {
        visible_characters: [],
        background_characters: [],
        speech_plan: { speaker_name: '妈妈', is_offscreen: true, text: '快回来。' },
        sound_plan: { is_silent: false, sound_effects: [] },
        continuity_type: 'hard_cut',
        first_frame_policy: 'generate_new',
        last_frame_policy: 'none',
        required_references: [],
        audio_lip_sync: 'in_frame_dialogue',
        shot_duration: 5,
      },
    }),
    (err) => Array.isArray(err.violations)
      && err.violations.some((v) => v.rule === 'INVARIANT_OFFSCREEN_SPEECH_LIP_SYNC_CONFLICT')
  );
  assert.equal(db.prepare('SELECT semantic_slots FROM storyboards WHERE id=100').get().semantic_slots, originalSlots);
});

test('slot editor fields persist structured JSON and framing contracts without string coercion', (t) => {
  const db = setupDb(t);
  const continuity = { characters: { '1': { head_pose: '头部转向搭档', gaze: '看向搭档双眼' } } };
  const updated = storyboardService.updateStoryboard(db, log, 100, {
    start_framing: '双人侧向中景建立视线轴',
    end_framing: '姐姐转头看向弟弟后定格',
    transition_to_next: '沿姐姐视线切入下一镜',
    continuity_snapshot: continuity,
  });

  assert.equal(updated.start_framing, '双人侧向中景建立视线轴');
  assert.equal(updated.end_framing, '姐姐转头看向弟弟后定格');
  assert.equal(updated.transition_to_next, '沿姐姐视线切入下一镜');
  assert.deepEqual(updated.continuity_snapshot, continuity);
  assert.equal(
    db.prepare('SELECT continuity_snapshot FROM storyboards WHERE id=100').get().continuity_snapshot,
    JSON.stringify(continuity)
  );
});
