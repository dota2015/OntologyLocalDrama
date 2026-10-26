const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isAssetMentionedInText,
  isAssetRecentlyCreated,
  isAssetUsedInShots,
  isAssetObsolete,
} = require('../src/ontology/assetMatcher');

describe('Ontology Asset Matcher & Obsolete Diagnostics', () => {
  const sampleShootoutScript = `
爆炸掀起碎石，子弹贴着红狼的头盔飞过。红狼躲到断墙后换弹，蜂医倒在十几米外，身旁的救援倒计时不断跳动。
露娜：“红狼，别从正面过去！敌人在高台和仓库二层交叉射击，先等我找安全路线！”
蜂医：“我还能撑住。红狼，利用右边的掩体靠近，别再乱冲。”
时间回到任务开始前。红狼、蜂医和露娜站在废弃工厂外围，远处的情报箱闪着微光。
露娜：“地图情报还没确认。工厂里至少有两个火力点，撤离路线也可能已经暴露。”
红狼握着武器冲进工厂。下一刻，隐藏在二层的敌人突然开火。
丽霞端着水果走到书桌旁，看见数学作业仍然空着。
丽霞：“奕辰，你答应打完这一局就写作业。已经过去半个小时了。”
奕辰紧盯屏幕，手指飞快操作。
坐在另一张书桌前的奕馨合上练习册，转头看向哥哥。
奕馨：“你刚才也说马上。可你的作业一个字都没写。”
  `.trim();

  it('correctly matches compound scenes without explicit separators (e.g. 废弃工厂内部战斗区)', () => {
    const scene = { location: '废弃工厂内部战斗区' };
    const matched = isAssetMentionedInText('scene', scene, sampleShootoutScript);
    assert.equal(matched, true, '废弃工厂内部战斗区 should match script with 废弃工厂 and 工厂');
  });

  it('correctly matches scenes with multiple character names and sub-areas (e.g. 奕辰与奕馨家中双人书房·书桌区)', () => {
    const scene = { location: '奕辰与奕馨家中双人书房·书桌区' };
    const matched = isAssetMentionedInText('scene', scene, sampleShootoutScript);
    assert.equal(matched, true, '奕辰与奕馨家中双人书房·书桌区 should match script with 奕辰, 奕馨 and 书桌');
  });

  it('correctly identifies irrelevant or obsolete scenes as false', () => {
    const oldScene1 = { location: '火星殖民地太空舱' };
    const oldScene2 = { location: '大宋开封府公堂' };
    assert.equal(isAssetMentionedInText('scene', oldScene1, sampleShootoutScript), false);
    assert.equal(isAssetMentionedInText('scene', oldScene2, sampleShootoutScript), false);
  });

  it('correctly matches character names with parenthesized titles/aliases', () => {
    const char1 = { name: '蜂医（苏晴）' };
    const char2 = { name: '红狼 [突击队长]' };
    const char3 = { name: '李阿姨' };
    assert.equal(isAssetMentionedInText('character', char1, sampleShootoutScript), true);
    assert.equal(isAssetMentionedInText('character', char2, sampleShootoutScript), true);
    assert.equal(isAssetMentionedInText('character', char3, sampleShootoutScript), false);
  });

  it('correctly matches prop names with measure-word and version suffixes', () => {
    const prop1 = { name: '数学作业册' };
    const prop2 = { name: '军事情报箱' };
    const prop3 = { name: '青铜三足鼎' };
    assert.equal(isAssetMentionedInText('prop', prop1, sampleShootoutScript), true);
    assert.equal(isAssetMentionedInText('prop', prop2, sampleShootoutScript), true);
    assert.equal(isAssetMentionedInText('prop', prop3, sampleShootoutScript), false);
  });

  it('grace period protects newly created assets regardless of storyboard links', () => {
    const justCreatedScene = {
      id: 999,
      location: '未在剧本提及的临时测试场地',
      created_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(), // 2 minutes ago
    };
    // Even if not in script and not in shots, recent creation should NOT be marked obsolete
    const isObsolete = isAssetObsolete('scene', justCreatedScene, {
      script: sampleShootoutScript,
      shots: [],
      graceMinutes: 20,
    });
    assert.equal(isObsolete, false, 'Newly created asset within grace period must not be marked obsolete');
  });

  it('flags genuinely obsolete assets created long ago and missing from both script and storyboards', () => {
    const oldObsoleteScene = {
      id: 888,
      location: '古老魔法森林祭坛',
      created_at: '2026-01-01T00:00:00.000Z',
    };
    const isObsolete = isAssetObsolete('scene', oldObsoleteScene, {
      script: sampleShootoutScript,
      shots: [{ storyboard_number: 1, scene_id: 100 }],
      graceMinutes: 20,
    });
    assert.equal(isObsolete, true, 'Old scene not in script or shots must be marked obsolete');
  });

  it('preserves assets that are referenced in storyboards even if script omitted them', () => {
    const sceneInShots = {
      id: 555,
      location: '未在剧本提及的转场黑屏或特写背景',
      created_at: '2026-01-01T00:00:00.000Z',
    };
    const shots = [{ storyboard_number: 1, scene_id: 555 }];
    const isObsolete = isAssetObsolete('scene', sceneInShots, {
      script: sampleShootoutScript,
      shots,
      graceMinutes: 20,
    });
    assert.equal(isObsolete, false, 'Asset referenced by active storyboard must not be marked obsolete');
  });
});
