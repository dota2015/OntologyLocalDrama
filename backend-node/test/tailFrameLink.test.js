const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');
const routes = require('../src/services/tailFrameLinkService');

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE dramas (
      id INTEGER PRIMARY KEY,
      title TEXT,
      deleted_at TEXT
    );
    CREATE TABLE episodes (
      id INTEGER PRIMARY KEY,
      drama_id INTEGER,
      episode_number INTEGER,
      title TEXT,
      deleted_at TEXT
    );
    CREATE TABLE storyboards (
      id INTEGER PRIMARY KEY,
      episode_id INTEGER,
      storyboard_number INTEGER,
      title TEXT,
      first_frame_image_id INTEGER,
      image_url TEXT,
      local_path TEXT,
      last_frame_image_id INTEGER,
      last_frame_image_url TEXT,
      last_frame_local_path TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE video_generations (
      id INTEGER PRIMARY KEY,
      drama_id INTEGER,
      episode_id INTEGER,
      storyboard_id INTEGER,
      status TEXT,
      local_path TEXT,
      video_url TEXT,
      duration REAL,
      created_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE image_generations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      drama_id INTEGER,
      episode_id INTEGER,
      storyboard_id INTEGER,
      prompt TEXT,
      provider TEXT,
      model TEXT,
      status TEXT,
      image_url TEXT,
      local_path TEXT,
      width INTEGER,
      height INTEGER,
      created_at TEXT,
      updated_at TEXT,
      completed_at TEXT
    );
  `);
  return db;
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
  };
}

describe('tailFrameLinkService - True Last Frame Extraction', () => {
  it('extracts the exact last frame without 1-second premature truncation', async () => {
    const db = createTestDb();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-tail-test-'));

    // Find an existing sample mp4 or create a short one
    const sampleVideo = path.join(__dirname, '../generated_videos/498a614f-ec7e-4bd4-8d7f-f53603ee95f0.mp4');
    let testVideoPath = sampleVideo;
    if (!fs.existsSync(sampleVideo)) {
      testVideoPath = path.join(tempDir, 'test_sample.mp4');
      const { spawnSync } = require('child_process');
      const { getFfmpegPath } = require('../src/utils/ffmpegPath');
      spawnSync(getFfmpegPath(), ['-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10', '-c:v', 'libx264', '-y', testVideoPath]);
    }

    // Seed database
    db.prepare("INSERT INTO dramas (id, title) VALUES (1, '测试短剧')").run();
    db.prepare("INSERT INTO episodes (id, drama_id, episode_number, title) VALUES (10, 1, 1, '第1集')").run();
    db.prepare("INSERT INTO storyboards (id, episode_id, storyboard_number, title) VALUES (101, 10, 19, '第19镜')").run();
    db.prepare("INSERT INTO storyboards (id, episode_id, storyboard_number, title) VALUES (102, 10, 20, '第20镜')").run();

    db.prepare(`
      INSERT INTO video_generations (id, drama_id, episode_id, storyboard_id, status, local_path, created_at)
      VALUES (1, 1, 10, 101, 'completed', ?, datetime('now'))
    `).run(testVideoPath);

    const cfg = {
      storage: {
        local_path: tempDir,
        base_url: 'http://127.0.0.1:5679/static',
      },
    };
    const log = {
      info: () => {},
      warn: () => {},
      error: () => {},
    };

    const handler = routes(db, cfg, log);
    const req = {
      params: { id: 101 },
      body: { drama_id: 1 },
    };
    const res = mockRes();

    await handler.linkTailFrame(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.next_storyboard_id, 102);
    assert.ok(res.body.new_first_frame_image_id > 0);
    assert.ok(res.body.local_path.startsWith('media/images/tailframe_101_to_102_'));

    // Verify next storyboard has been linked to the new first frame
    const nextSb = db.prepare('SELECT first_frame_image_id, local_path FROM storyboards WHERE id = 102').get();
    assert.equal(nextSb.first_frame_image_id, res.body.new_first_frame_image_id);
    assert.equal(nextSb.local_path, res.body.local_path);

    // Verify output file exists on disk and is non-empty
    const generatedImagePath = path.join(tempDir, res.body.local_path);
    assert.ok(fs.existsSync(generatedImagePath));
    assert.ok(fs.statSync(generatedImagePath).size > 1000);

    // Clean up
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns appropriate error when there is no next storyboard', async () => {
    const db = createTestDb();
    db.prepare("INSERT INTO dramas (id, title) VALUES (1, '测试短剧')").run();
    db.prepare("INSERT INTO episodes (id, drama_id, episode_number, title) VALUES (10, 1, 1, '第1集')").run();
    db.prepare("INSERT INTO storyboards (id, episode_id, storyboard_number, title) VALUES (101, 10, 99, '最后一镜')").run();
    db.prepare(`
      INSERT INTO video_generations (id, drama_id, episode_id, storyboard_id, status, local_path, created_at)
      VALUES (1, 1, 10, 101, 'completed', 'some.mp4', datetime('now'))
    `).run();

    const handler = routes(db, {}, { info: () => {}, error: () => {} });
    const req = { params: { id: 101 }, body: { drama_id: 1 } };
    const res = mockRes();

    await handler.linkTailFrame(req, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /没有下一个分镜/);
  });

  it('linkFirstFrame extracts the first frame and binds to previous storyboard as last frame', async () => {
    const db = createTestDb();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-first-test-'));

    let testVideoPath = path.join(tempDir, 'test_first_sample.mp4');
    const { spawnSync } = require('child_process');
    const { getFfmpegPath } = require('../src/utils/ffmpegPath');
    spawnSync(getFfmpegPath(), ['-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10', '-c:v', 'libx264', '-y', testVideoPath]);

    // Seed database with shot 101 and shot 102
    db.prepare("INSERT INTO dramas (id, title) VALUES (1, '测试短剧')").run();
    db.prepare("INSERT INTO episodes (id, drama_id, episode_number, title) VALUES (10, 1, 1, '第1集')").run();
    db.prepare("INSERT INTO storyboards (id, episode_id, storyboard_number, title) VALUES (101, 10, 1, '第1镜')").run();
    db.prepare("INSERT INTO storyboards (id, episode_id, storyboard_number, title) VALUES (102, 10, 2, '第2镜')").run();

    // Shot 102 has a completed video
    db.prepare(`
      INSERT INTO video_generations (id, drama_id, episode_id, storyboard_id, status, local_path, created_at)
      VALUES (2, 1, 10, 102, 'completed', ?, datetime('now'))
    `).run(testVideoPath);

    const cfg = {
      storage: {
        local_path: tempDir,
        base_url: 'http://127.0.0.1:5679/static',
      },
    };
    const log = { info: () => {}, warn: () => {}, error: () => {} };

    const handler = routes(db, cfg, log);
    const req = {
      params: { id: 102 },
      body: { drama_id: 1 },
    };
    const res = mockRes();

    await handler.linkFirstFrame(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.prev_storyboard_id, 101);
    assert.ok(res.body.new_last_frame_image_id > 0);
    assert.ok(res.body.local_path.startsWith('media/images/firstframe_102_to_101_'));

    // Verify shot 101 has its last_frame_* fields updated
    const prevSb = db.prepare('SELECT last_frame_image_id, last_frame_local_path FROM storyboards WHERE id = 101').get();
    assert.equal(prevSb.last_frame_image_id, res.body.new_last_frame_image_id);
    assert.equal(prevSb.last_frame_local_path, res.body.local_path);

    // Verify output file exists on disk and is non-empty
    const generatedImagePath = path.join(tempDir, res.body.local_path);
    assert.ok(fs.existsSync(generatedImagePath));
    assert.ok(fs.statSync(generatedImagePath).size > 100);

    // Clean up
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('linkFirstFrame returns 400 when there is no previous storyboard', async () => {
    const db = createTestDb();
    db.prepare("INSERT INTO dramas (id, title) VALUES (1, '测试短剧')").run();
    db.prepare("INSERT INTO episodes (id, drama_id, episode_number, title) VALUES (10, 1, 1, '第1集')").run();
    db.prepare("INSERT INTO storyboards (id, episode_id, storyboard_number, title) VALUES (101, 10, 1, '第1镜')").run();
    db.prepare(`
      INSERT INTO video_generations (id, drama_id, episode_id, storyboard_id, status, local_path, created_at)
      VALUES (1, 1, 10, 101, 'completed', 'some.mp4', datetime('now'))
    `).run();

    const handler = routes(db, {}, { info: () => {}, error: () => {} });
    const req = { params: { id: 101 }, body: { drama_id: 1 } };
    const res = mockRes();

    await handler.linkFirstFrame(req, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /没有上一个分镜/);
  });
});
