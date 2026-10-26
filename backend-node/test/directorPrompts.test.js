const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runDirectorAgent } = require('../src/ontology/directorAgent');
const {
  rebuildPromptsForStoryboard,
  rebuildPromptsForEpisode,
  extractStaticFreezeFramePose,
  isFlawedImagePrompt,
  sanitizeStaticImagePrompt,
} = require('../src/services/episodeStoryboardService');
const aiClient = require('../src/services/aiClient');

describe('Director Agent Prompt Generation & Persistence', () => {
  let db;

  before(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE dramas (id INTEGER PRIMARY KEY, title TEXT, genre TEXT, style TEXT, metadata TEXT, status TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT);
      CREATE TABLE episodes (id INTEGER PRIMARY KEY, drama_id INTEGER, episode_number INTEGER, title TEXT, duration INTEGER, script_content TEXT, status TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT);
      CREATE TABLE characters (id INTEGER PRIMARY KEY, drama_id INTEGER, name TEXT, gender TEXT, role TEXT, appearance TEXT, description TEXT, current_stage_id INTEGER, identity_anchors TEXT, voice_id TEXT, custom_voice_id TEXT, speed REAL, pitch REAL, deleted_at TEXT);
      CREATE TABLE scenes (id INTEGER PRIMARY KEY, drama_id INTEGER, episode_id INTEGER, location TEXT, time TEXT, prompt TEXT, deleted_at TEXT);
      CREATE TABLE props (id INTEGER PRIMARY KEY, drama_id INTEGER, name TEXT, type TEXT, description TEXT, physical_scale TEXT, image_prompt TEXT, deleted_at TEXT);
      CREATE TABLE storyboard_props (id INTEGER PRIMARY KEY, storyboard_id INTEGER, prop_id INTEGER);
      CREATE TABLE storyboard_characters (id INTEGER PRIMARY KEY, storyboard_id INTEGER, character_id INTEGER, created_at TEXT);
      CREATE TABLE storyboards (
        id INTEGER PRIMARY KEY AUTOINCREMENT, episode_id INTEGER, scene_id INTEGER, storyboard_number INTEGER,
        title TEXT, description TEXT, location TEXT, time TEXT, duration REAL, dialogue TEXT, narration TEXT,
        action TEXT, result TEXT, atmosphere TEXT, emotion TEXT, movement TEXT, lighting_style TEXT,
        depth_of_field TEXT, angle_h TEXT, angle_v TEXT, angle_s TEXT, shot_type TEXT, bgm_prompt TEXT,
        sound_effect TEXT, layout_description TEXT, characters TEXT, image_prompt TEXT, video_prompt TEXT,
        polished_prompt TEXT, continuity_snapshot TEXT, status TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT
      );

      INSERT INTO dramas VALUES (1, '末日行动', '科幻', 'photorealistic', '{"aspect_ratio":"16:9"}', 'active', '2026-10-24', '2026-10-24', NULL);
      INSERT INTO episodes VALUES (10, 1, 1, '突围', 60, '红狼在废弃仓库断墙后换弹，掩护蜂医撤离。', 'draft', '2026-10-24', '2026-10-24', NULL);
      INSERT INTO characters VALUES (1, 1, '红狼', '男', '队长', '身穿深灰色战术服，戴防风眼镜与战术耳机', '战术突击手', NULL, NULL, NULL, NULL, 1.0, 0, NULL);
      INSERT INTO characters VALUES (2, 1, '蜂医', '女', '医护', '金发马尾，身穿白色医疗防护服', '战地医生', NULL, NULL, NULL, NULL, 1.0, 0, NULL);
      INSERT INTO scenes VALUES (100, 1, 10, '废弃工厂内部战斗区', '日景', '废弃厂房断墙', NULL);
      INSERT INTO props VALUES (200, 1, '军用情报箱', '道具', '黑色密码箱', '40cm', '金属箱', NULL);
    `);
  });

  after(() => {
    if (db) db.close();
  });

  it('runDirectorAgent populates image_prompt, video_prompt, and polished_prompt on all storyboards', async (t) => {
    t.mock.method(aiClient, 'generateText', async () => {
      return JSON.stringify({
        storyboards: [
          {
            shot_number: 1,
            title: '断墙换弹',
            scene_id: 100,
            characters: [1],
            props: [200],
            shot_type: '中景',
            angle_h: 'front_left',
            angle_v: 'low',
            angle_s: 'medium',
            movement: 'push',
            lighting_style: 'dramatic',
            depth_of_field: 'shallow',
            duration: 5,
            action: '红狼背靠断墙快速更换步枪弹匣，警惕观察通道',
            result: '弹匣卡紧，推膛上锁',
            dialogue: '',
            narration: '',
            bgm_prompt: '低频紧迫战术脉冲音',
            sound_effect: '弹匣撞击声',
            layout_description: '红狼位于画面中心偏左，情报箱置于断墙边',
            emotion: '紧张戒备',
            image_prompt: '写实电影感，红狼躲在废弃工厂断墙后低姿换弹，侧光，浅景深',
          },
          {
            shot_number: 2,
            title: '蜂医撤离',
            scene_id: 100,
            characters: [2],
            props: [],
            shot_type: '特写',
            angle_h: 'front',
            angle_v: 'eye_level',
            angle_s: 'close_up',
            movement: 'tracking',
            lighting_style: 'side',
            depth_of_field: 'shallow',
            duration: 4,
            action: '蜂医扶住受损护甲，压低身体朝后方撤离点冲刺',
            result: '翻入掩体后方',
            dialogue: '蜂医: "我已就位！"',
            narration: '',
            bgm_prompt: '',
            sound_effect: '急促脚步声',
            layout_description: '蜂医从画右冲向画左',
            emotion: '决绝',
          },
        ],
      });
    });

    const result = await runDirectorAgent(db, console, {}, 10);
    assert.equal(result.total_shots, 2);

    const sbs = db.prepare('SELECT * FROM storyboards WHERE episode_id = 10 AND deleted_at IS NULL ORDER BY storyboard_number ASC').all();
    assert.equal(sbs.length, 2);

    // Shot 1 check
    assert.ok(sbs[0].image_prompt, 'Shot 1 must have image_prompt');
    assert.match(sbs[0].image_prompt, /红狼/);
    assert.ok(sbs[0].video_prompt, 'Shot 1 must have video_prompt');
    assert.match(sbs[0].video_prompt, /废弃工厂内部战斗区/);
    assert.match(sbs[0].video_prompt, /低频紧迫战术脉冲音/);
    assert.ok(sbs[0].polished_prompt, 'Shot 1 must have polished_prompt');

    // Shot 2 check (AI did not provide image_prompt, must be synthesized automatically)
    assert.ok(sbs[1].image_prompt, 'Shot 2 must have automatically synthesized image_prompt');
    assert.match(sbs[1].image_prompt, /蜂医/);
    assert.ok(sbs[1].video_prompt, 'Shot 2 must have video_prompt');
    assert.match(sbs[1].video_prompt, /蜂医/);
    assert.match(sbs[1].video_prompt, /对话：蜂医: "我已就位！"/);
  });

  it('rebuildPromptsForEpisode backfills missing image_prompt and video_prompt on legacy rows', () => {
    // Insert a blank legacy row with null prompts
    const info = db.prepare(`
      INSERT INTO storyboards (
        episode_id, scene_id, storyboard_number, title, description, location, time, duration,
        action, dialogue, movement, shot_type, status, created_at, updated_at
      ) VALUES (
        10, 100, 3, '老旧镜头', '无提示词历史分镜', '废弃工厂内部战斗区', '黄昏', 5,
        '红狼抬头看向高台敌军火力点', '', 'tilt', '仰拍全景', 'pending', '2026-01-01', '2026-01-01'
      )
    `).run();
    const blankId = info.lastInsertRowid;

    let row = db.prepare('SELECT * FROM storyboards WHERE id = ?').get(blankId);
    assert.equal(row.image_prompt, null);
    assert.equal(row.video_prompt, null);

    rebuildPromptsForStoryboard(db, console, blankId);

    row = db.prepare('SELECT * FROM storyboards WHERE id = ?').get(blankId);
    assert.ok(row.image_prompt, 'Backfilled row must have image_prompt');
    assert.match(row.image_prompt, /废弃工厂内部战斗区/);
    assert.ok(row.video_prompt, 'Backfilled row must have video_prompt');
    assert.match(row.video_prompt, /高台敌军/);
  });

  it('transforms dynamic video actions into concrete static freeze-frame poses without truncation', () => {
    // Case 1: Shot 21 bug (previously truncated to '奕辰身体')
    const pose21 = extractStaticFreezeFramePose('奕辰身体继续前倾，目光不离屏幕，手指快速敲击键盘；丽霞站在他身后半步处。');
    assert.ok(!pose21.includes('奕辰身体，'), 'Must not truncate to bare noun');
    assert.match(pose21, /上身前倾坐在书桌前/);
    assert.match(pose21, /双手手指搭在键盘按键上/);
    assert.match(pose21, /双眼专注凝视正前方屏幕/);

    // Case 2: Shot 17 bug (temporal glance action)
    const pose17 = extractStaticFreezeFramePose('红狼靠住断墙，快速向右侧岔路看了一眼');
    assert.ok(!pose17.includes('看了一眼'), 'Must not use temporal glance verb');
    assert.match(pose17, /目光警惕专注地注视着右侧岔路/);

    // Case 3: Shot 15 bug (abstract balance losing)
    const pose15 = extractStaticFreezeFramePose('蜂医身体失去平衡，前倾摔向断墙外侧地面。');
    assert.match(pose15, /身体大幅.*倾斜失衡/);
    assert.match(pose15, /单手.*撑向地面/);
    assert.match(pose15, /定格瞬间/);

    // Case 4: Shot 10 bug (previously truncated to '露娜')
    const pose10 = extractStaticFreezeFramePose('露娜向前跨一步挡住红狼半条行进路线，抬手指向黑暗厂房内部。');
    assert.notEqual(pose10, '露娜');
    assert.match(pose10, /侧身跨步停在红狼身前挡住路线/);
    assert.match(pose10, /单臂抬起直指黑暗厂房内部/);

    // Case 5: Shot 8 bug (video walking and sequence action)
    const pose8 = extractStaticFreezeFramePose('蜂医沿掩体后方走到露娜右侧，按下露娜准备起身的肩膀，两人保持低姿态。');
    assert.ok(!pose8.includes('走到'), 'Must not describe walking process');
    assert.match(pose8, /半蹲停在露娜旁/);
    assert.match(pose8, /单手按在露娜肩头/);
    assert.match(pose8, /维持低姿隐蔽警戒/);
  });

  it('detects flawed prompts and rebuildPromptsForStoryboard repairs them with static freeze-frame poses', () => {
    assert.equal(isFlawedImagePrompt('废弃工厂内部战斗区，夜晚，特写·平视·前左，奕辰身体，photorealistic，首帧静止画面'), true);
    assert.equal(isFlawedImagePrompt('废弃工厂外围，阴天，中景·平视·前左，露娜，photorealistic，首帧静止画面'), true);
    assert.equal(isFlawedImagePrompt('废弃工厂内部战斗区，阴天，特写·平视·正面，红狼靠住断墙，快速向右侧岔路看了一眼，photorealistic，首帧静止画面'), true);
    assert.equal(isFlawedImagePrompt('废弃工厂内部战斗区，阴天，中景·平视·正面，蜂医沿掩体后方走到露娜右侧，按下露娜准备起身的肩膀，两人保持低姿态，photorealistic，首帧静止画面'), true);

    // Insert flawed row into DB
    const info = db.prepare(`
      INSERT INTO storyboards (
        episode_id, scene_id, storyboard_number, title, location, time, duration,
        action, shot_type, angle_h, angle_v, angle_s,
        image_prompt, polished_prompt, status, created_at, updated_at
      ) VALUES (
        10, 100, 4, '书桌前倾', '双人书房·书桌区', '夜晚', 5,
        '奕辰身体继续前倾，目光不离屏幕，手指快速敲击键盘；丽霞站在他身后半步处。',
        '特写', 'front_left', 'eye_level', 'close_up',
        '双人书房·书桌区，夜晚，特写·平视·前左，奕辰身体，photorealistic, ultra-detailed，首帧静止画面',
        '双人书房·书桌区，夜晚，特写·平视·前左，奕辰身体，photorealistic, ultra-detailed，首帧静止画面',
        'pending', '2026-01-01', '2026-01-01'
      )
    `).run();
    const flawedId = info.lastInsertRowid;

    rebuildPromptsForStoryboard(db, console, flawedId);

    const repaired = db.prepare('SELECT image_prompt, polished_prompt FROM storyboards WHERE id = ?').get(flawedId);
    assert.ok(!repaired.image_prompt.includes('，奕辰身体，'), 'Must repair bare noun in image_prompt');
    assert.match(repaired.image_prompt, /上身前倾坐在书桌前/);
    assert.match(repaired.image_prompt, /双手手指搭在键盘按键上/);
    assert.match(repaired.polished_prompt, /上身前倾坐在书桌前/);
  });
});
