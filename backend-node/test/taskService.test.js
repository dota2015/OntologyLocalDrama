const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const taskService = require('../src/services/taskService');

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE async_tasks (
      id TEXT PRIMARY KEY,
      type TEXT,
      status TEXT,
      progress INTEGER DEFAULT 0,
      message TEXT,
      error TEXT,
      result TEXT,
      resource_id TEXT,
      created_at TEXT,
      updated_at TEXT,
      completed_at TEXT,
      deleted_at TEXT
    );
  `);
  return db;
}

describe('taskService.failOrphanedAsyncTasksOnStartup', () => {
  it('marks pending and processing tasks as failed on startup', () => {
    const db = createTestDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO async_tasks (id, type, status, progress, message, resource_id, created_at, updated_at)
       VALUES (?, ?, ?, 0, '', ?, ?, ?)`
    ).run('task-pending', 'background_extraction', 'pending', '42', now, now);
    db.prepare(
      `INSERT INTO async_tasks (id, type, status, progress, message, resource_id, created_at, updated_at)
       VALUES (?, ?, ?, 0, '', ?, ?, ?)`
    ).run('task-processing', 'background_extraction', 'processing', '42', now, now);
    db.prepare(
      `INSERT INTO async_tasks (id, type, status, progress, message, resource_id, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, 100, '', ?, ?, ?, ?)`
    ).run('task-done', 'background_extraction', 'completed', '42', now, now, now);

    const count = taskService.failOrphanedAsyncTasksOnStartup(db, { warn() {}, info() {} });
    assert.equal(count, 2);

    const pending = taskService.getTask(db, 'task-pending');
    const processing = taskService.getTask(db, 'task-processing');
    const done = taskService.getTask(db, 'task-done');

    assert.equal(pending.status, 'failed');
    assert.equal(processing.status, 'failed');
    assert.equal(pending.error, taskService.ORPHAN_ASYNC_TASK_MSG);
    assert.equal(done.status, 'completed');
  });

  it('cancelTask marks active task as failed', () => {
    const db = createTestDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO async_tasks (id, type, status, progress, message, resource_id, created_at, updated_at)
       VALUES (?, ?, ?, 0, '', ?, ?, ?)`
    ).run('task-active', 'background_extraction', 'processing', '42', now, now);

    const result = taskService.cancelTask(db, { info() {} }, 'task-active');
    assert.equal(result.ok, true);
    const task = taskService.getTask(db, 'task-active');
    assert.equal(task.status, 'failed');
    assert.equal(task.error, taskService.USER_CANCEL_TASK_MSG);
  });

  it('cancelTask synchronizes failure to video_generations and image_generations', () => {
    const db = createTestDb();
    db.exec(`
      CREATE TABLE video_generations (
        id INTEGER PRIMARY KEY,
        task_id TEXT,
        status TEXT,
        error_msg TEXT,
        created_at TEXT,
        updated_at TEXT,
        deleted_at TEXT
      );
      CREATE TABLE image_generations (
        id INTEGER PRIMARY KEY,
        task_id TEXT,
        status TEXT,
        error_msg TEXT,
        created_at TEXT,
        updated_at TEXT,
        deleted_at TEXT
      );
    `);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO async_tasks (id, type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run('task-vid', 'video_generation', 'processing', now, now);
    db.prepare(`INSERT INTO video_generations (id, task_id, status, created_at, updated_at) VALUES (1, 'task-vid', 'processing', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO image_generations (id, task_id, status, created_at, updated_at) VALUES (1, 'task-vid', 'processing', ?, ?)`).run(now, now);

    const result = taskService.cancelTask(db, { info() {} }, 'task-vid', '用户取消任务');
    assert.equal(result.ok, true);

    const vid = db.prepare('SELECT status, error_msg FROM video_generations WHERE id = 1').get();
    assert.equal(vid.status, 'failed');
    assert.equal(vid.error_msg, '用户取消任务');

    const img = db.prepare('SELECT status, error_msg FROM image_generations WHERE id = 1').get();
    assert.equal(img.status, 'failed');
    assert.equal(img.error_msg, '用户取消任务');

    // Late completion attempts cannot overwrite the failed/cancelled status
    const lateVidUpdate = db.prepare(
      "UPDATE video_generations SET status = 'completed', updated_at = ? WHERE id = 1 AND status NOT IN ('failed', 'cancelled')"
    ).run(now);
    assert.equal(lateVidUpdate.changes, 0, 'cancelled video cannot be overwritten to completed');

    const lateImgUpdate = db.prepare(
      "UPDATE image_generations SET status = 'completed', updated_at = ? WHERE id = 1 AND status NOT IN ('failed', 'cancelled')"
    ).run(now);
    assert.equal(lateImgUpdate.changes, 0, 'cancelled image cannot be overwritten to completed');
  });
});
