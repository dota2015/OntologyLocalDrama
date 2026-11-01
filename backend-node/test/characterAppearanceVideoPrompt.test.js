const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const svc = require('../src/services/episodeStoryboardService');

const noopLog = { info() {}, warn() {}, error() {} };

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE dramas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT, style TEXT, metadata TEXT, deleted_at TEXT
    );
    CREATE TABLE episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      drama_id INTEGER, title TEXT, script_content TEXT, description TEXT, deleted_at TEXT
    );
    CREATE TABLE storyboards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      episode_id INTEGER, scene_id INTEGER, storyboard_number INTEGER,
      title TEXT, description TEXT, location TEXT, time TEXT, duration INTEGER,
      dialogue TEXT, narration TEXT, action TEXT, result TEXT, atmosphere TEXT,
      image_prompt TEXT, video_prompt TEXT, characters TEXT,
      shot_type TEXT, angle TEXT, angle_h TEXT, angle_v TEXT, angle_s TEXT,
      movement TEXT, lighting_style TEXT, depth_of_field TEXT,
      video_slots TEXT,
      segment_index INTEGER, segment_title TEXT, creation_mode TEXT,
      universal_segment_text TEXT, status TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT
    );
    CREATE TABLE characters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      drama_id INTEGER, name TEXT, role TEXT, description TEXT, personality TEXT,
      appearance TEXT, image_url TEXT, local_path TEXT, sort_order INTEGER,
      created_at TEXT, updated_at TEXT, deleted_at TEXT
    );
    CREATE TABLE storyboard_characters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      storyboard_id INTEGER, character_id INTEGER
    );
    CREATE TABLE storyboard_props (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      storyboard_id INTEGER, prop_id INTEGER
    );
  `);
  return db;
}

/** 种子：1 部剧 / 1 集 / 1 个角色（林薇）/ 1 个分镜 */
function seedStoryboard(db, { charactersJson = JSON.stringify([{ id: 1, name: '林薇' }]), appearance = '素色连衣裙，丸子头' } = {}) {
  const now = new Date().toISOString();
  db.prepare('INSERT INTO dramas (id, title, style, metadata) VALUES (1, ?, ?, NULL)').run('测试剧', '动漫');
  db.prepare('INSERT INTO episodes (id, drama_id, title, script_content) VALUES (1, 1, ?, ?)').run('第1集', '林薇回到老宅。');
  db.prepare('INSERT INTO characters (id, drama_id, name, appearance) VALUES (1, 1, ?, ?)').run('林薇', appearance);
  db.prepare(
    `INSERT INTO storyboards (id, episode_id, storyboard_number, title, action, characters, video_slots, created_at, updated_at)
     VALUES (1, 1, 1, '开场', '林薇走进房间', ?, ?, ?, ?)`
  ).run(charactersJson, JSON.stringify({
    camera: { shot_type: '中景', angle_h: 'front', angle_v: 'eye_level', angle_s: 'medium', movement: 'tracking' },
    audio_lip_sync: { mode: 'silent_ambient', speaker_name: '', speaker_in_frame: false, dialogue_content: '', visible_characters_lip_state: 'strictly_sealed' },
    trajectories: [], environment_vfx: {}, timing: { duration: 5 },
  }), now, now);
}

describe('#38 H3 不再持久化派生 video_prompt', () => {
  it('rebuildVideoPromptForStoryboard 清理历史 video_prompt', () => {
    const db = createTestDb();
    seedStoryboard(db);
    db.prepare("UPDATE storyboards SET video_prompt='legacy prompt' WHERE id=1").run();
    const sb = svc.rebuildVideoPromptForStoryboard(db, noopLog, 1);
    assert.ok(sb, '应返回更新后的分镜');
    assert.equal(sb.video_prompt, null);
  });

  it('deriveStoryboardFieldsFromAi 不生成 videoPrompt', () => {
    const map = { '1': '「林薇」素色连衣裙，丸子头', 'name:林薇': '「林薇」素色连衣裙，丸子头' };
    const d = svc.deriveStoryboardFieldsFromAi(
      { title: '开场', action: '林薇走进房间', characters: [{ id: 1, name: '林薇' }] },
      '动漫',
      '16:9',
      { characterAppearances: map }
    );
    assert.equal(d.videoPrompt, null);
  });

  it('saveStoryboards 将 video_prompt 入库为 NULL', () => {
    const db = createTestDb();
    seedStoryboard(db, { charactersJson: '[]' });
    svc.saveStoryboards(
      db,
      noopLog,
      1,
      [{ shot_number: 1, title: '开场', action: '林薇走进房间', characters: [{ id: 1, name: '林薇' }] }],
      { style: {} },
      '动漫',
      null,
      { characterAppearances: { '1': '「林薇」素色连衣裙，丸子头', 'name:林薇': '「林薇」素色连衣裙，丸子头' } }
    );
    const row = db.prepare('SELECT video_prompt FROM storyboards WHERE episode_id = 1 AND deleted_at IS NULL').get();
    assert.equal(row.video_prompt, null);
  });
});
