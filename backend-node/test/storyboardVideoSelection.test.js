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
