const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const migrate = require('../src/db/migrate');
const episodeStoryboardService = require('../src/services/episodeStoryboardService');

const log = { info() {}, warn() {}, error() {} };

function setupDb(t) {
  const db = new Database(':memory:');
  t.after(() => { if (db.open) db.close(); });
  migrate.runMigrationsAndEnsure(db);
  db.exec(`
    INSERT INTO dramas(id, title) VALUES(1, '测试剧');
    INSERT INTO episodes(id, drama_id, episode_number) VALUES(10, 1, 1);
    INSERT INTO storyboards(id, episode_id, storyboard_number, duration, title, local_path, image_url, first_frame_image_id, last_frame_image_id, last_frame_image_url, video_url, selected_video_id)
    VALUES
      (101, 10, 1, 5, '镜头1', 'images/sb_101.png', 'http://example/101.png', 201, 202, 'http://example/101_last.png', 'http://example/video101.mp4', 501),
      (102, 10, 2, 5, '镜头2', 'images/sb_102.png', 'http://example/102.png', 203, NULL, NULL, 'http://example/video102.mp4', 502);

    INSERT INTO image_generations(id, drama_id, storyboard_id, status, image_url, local_path)
    VALUES
      (201, 1, 101, 'completed', 'http://example/101.png', 'images/sb_101.png'),
      (202, 1, 101, 'completed', 'http://example/101_last.png', 'images/sb_101_last.png'),
      (203, 1, 102, 'completed', 'http://example/102.png', 'images/sb_102.png');

    INSERT INTO video_generations(id, drama_id, storyboard_id, status, video_url, local_path)
    VALUES
      (501, 1, 101, 'completed', 'http://example/video101.mp4', 'videos/501.mp4'),
      (502, 1, 102, 'completed', 'http://example/video102.mp4', 'videos/502.mp4');
  `);
  return db;
}

test('clearEpisodeMedia clears both reference frames and videos for all storyboards in the episode', () => {
  const db = setupDb({ after: () => {} });
  const result = episodeStoryboardService.clearEpisodeMedia(db, log, 10, { clear_images: true, clear_videos: true });

  assert.equal(result.cleared_storyboards, 2);
  assert.equal(result.cleared_images, 3);
  assert.equal(result.cleared_videos, 2);

  // Check storyboards table fields
  const rows = db.prepare('SELECT id, image_url, local_path, first_frame_image_id, last_frame_image_id, last_frame_image_url, video_url, selected_video_id FROM storyboards WHERE episode_id = 10').all();
  for (const r of rows) {
    assert.equal(r.image_url, null);
    assert.equal(r.local_path, null);
    assert.equal(r.first_frame_image_id, null);
    assert.equal(r.last_frame_image_id, null);
    assert.equal(r.last_frame_image_url, null);
    assert.equal(r.video_url, null);
    assert.equal(r.selected_video_id, null);
  }

  // Check image_generations soft-deleted
  const activeImages = db.prepare('SELECT COUNT(*) as n FROM image_generations WHERE storyboard_id IN (101, 102) AND deleted_at IS NULL').get().n;
  assert.equal(activeImages, 0);

  // Check video_generations soft-deleted
  const activeVideos = db.prepare('SELECT COUNT(*) as n FROM video_generations WHERE storyboard_id IN (101, 102) AND deleted_at IS NULL').get().n;
  assert.equal(activeVideos, 0);
});

test('clearEpisodeMedia can selectively clear only videos or only images', () => {
  const db = setupDb({ after: () => {} });
  // Clear only videos
  const resVid = episodeStoryboardService.clearEpisodeMedia(db, log, 10, { clear_images: false, clear_videos: true });
  assert.equal(resVid.cleared_videos, 2);
  assert.equal(resVid.cleared_images, 0);

  const row1 = db.prepare('SELECT image_url, video_url FROM storyboards WHERE id = 101').get();
  assert.equal(row1.image_url, 'http://example/101.png'); // preserved!
  assert.equal(row1.video_url, null); // cleared!

  // Now clear images
  const resImg = episodeStoryboardService.clearEpisodeMedia(db, log, 10, { clear_images: true, clear_videos: false });
  assert.equal(resImg.cleared_images, 3);
  assert.equal(resImg.cleared_videos, 0);

  const row2 = db.prepare('SELECT image_url, video_url FROM storyboards WHERE id = 101').get();
  assert.equal(row2.image_url, null); // cleared!
});

test('clearStoryboardMedia clears media for a single storyboard', () => {
  const db = setupDb({ after: () => {} });
  const result = episodeStoryboardService.clearStoryboardMedia(db, log, 101, { clear_images: true, clear_videos: true });
  assert.equal(result.cleared_images, 2);
  assert.equal(result.cleared_videos, 1);

  const sb101 = db.prepare('SELECT image_url, video_url FROM storyboards WHERE id = 101').get();
  assert.equal(sb101.image_url, null);
  assert.equal(sb101.video_url, null);

  // Shot 102 untouched
  const sb102 = db.prepare('SELECT image_url, video_url FROM storyboards WHERE id = 102').get();
  assert.equal(sb102.image_url, 'http://example/102.png');
  assert.equal(sb102.video_url, 'http://example/video102.mp4');
});
