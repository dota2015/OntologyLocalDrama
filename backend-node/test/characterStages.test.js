const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const migrate = require('../src/db/migrate');
const stages = require('../src/utils/characterStages');
const wardrobe = require('../src/services/wardrobeService');
const characters = require('../src/services/characterLibraryService');
const planner = require('../src/services/storyboardWardrobeService');
const { speechFingerprint } = require('../src/utils/speechTiming');
const log = { info() {}, warn() {}, error() {} };
const looks = [
  { id: 'home', name: '现实装', appearance: '灰色卫衣，深蓝长裤', reference_image: 'home.png' },
  { id: 'training', name: '三角洲训练装', appearance: '白色翻领拉链训练套装', reference_image: 'training.png' },
];
function setup(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  migrate.runMigrationsAndEnsure(db);
  db.exec(`INSERT INTO dramas(id,title,metadata) VALUES(1,'测试','{"keep":true}'),(2,'外剧','{}');
    INSERT INTO episodes(id,drama_id,episode_number,script_content) VALUES(10,1,1,'王奕宸走进光门，来到三角洲训练场。他返回现实，走回家中的书桌。'),(11,1,2,'连续剧情'),(20,2,1,'外剧');
    INSERT INTO characters(id,drama_id,name,appearance,local_path) VALUES(5,1,'王奕宸','黑发少年','identity.png'),(6,2,'外人','','');
    INSERT INTO storyboards(id,episode_id,storyboard_number,characters,duration) VALUES(80,10,1,'[5]',5),(81,10,2,'[5]',5),(82,10,3,'[5]',5),(83,10,4,'[5]',5),(84,11,1,'[5]',5);`);
  characters.updateCharacter(db, log, 5, { stages: looks });
  wardrobe.saveCharacter(db, 1, 5, { description: '原有默认服装' });
  return db;
}
test('legacy JSON ranges remain readable and stage saves validate IDs, ranges and reference paths', t => {
  const db = setup(t);
  characters.updateCharacter(db, log, 5, { stages: '[{"episode_range":[1,3],"appearance":"白衣少年"}]' });
  const saved = wardrobe.getCharacter(db, 1, 5).stages[0];
  assert.equal(saved.id, 'legacy-1');
  assert.equal(wardrobe.getShot(db, 80).characters[0].description, '白衣少年');
  for (const value of ['bad', '{}', [{ appearance: '' }], [{ ...looks[0], episode_range: [3,1] }], [looks[0], looks[0]], [{ ...looks[0], reference_image: '../secret' }]]) {
    assert.throws(() => characters.updateCharacter(db, log, 5, { stages: value }));
  }
  assert.equal(wardrobe.getCharacter(db, 1, 5).stages[0].id, saved.id);
  assert.equal(db.prepare('SELECT appearance FROM characters WHERE id=5').get().appearance, '黑发少年');
  characters.updateCharacter(db, log, 5, { stages: [] });
  assert.deepEqual(wardrobe.getCharacter(db, 1, 5).stages, []);
});
test('a selected stage inherits within and across episodes; returning to reality restores the same saved look', t => {
  const db = setup(t);
  wardrobe.saveShot(db, 80, { change: { boundary: 'before_shot', reason: '现实日常', characters: [{ character_id: 5, stage_id: 'home' }] } });
  wardrobe.saveShot(db, 81, { change: { boundary: 'before_shot', reason: '进入三角洲', characters: [{ character_id: 5, stage_id: 'training' }] } });
  assert.equal(wardrobe.getShot(db, 82).characters[0].stage_id, 'training');
  assert.equal(wardrobe.getShot(db, 84).characters[0].reference_image, 'training.png');
  assert.equal(wardrobe.hasChange(db, 81), true);
  assert.equal(wardrobe.hasChange(db, 82), false);
  wardrobe.saveShot(db, 83, { change: { reason: '返回现实', characters: [{ character_id: 5, stage_id: 'home' }] } });
  assert.equal(wardrobe.getShot(db, 84).characters[0].stage_id, 'home');
  assert.equal(wardrobe.getShot(db, 84).characters[0].description, looks[0].appearance);
  assert.match(wardrobe.promptContext(db, 83, 'last'), /本镜开始前已完成换装/);
  assert.match(wardrobe.promptContext(db, 83, 'last'), /首帧的实际穿着为权威/);
  assert.throws(() => wardrobe.saveShot(db, 82, { change: { boundary: 'during_shot', reason: '镜内变装', characters: [{ character_id: 5, stage_id: 'home' }] } }), /拆成多个分镜/);
  for (const choices of [[{ character_id: 5, stage_id: 'missing' }], [{ character_id: 6, stage_id: 'home' }], [{ character_id: 5, stage_id: ['home','training'] }], [{ character_id: 5, stage_id: 'home' }, { character_id: 5, stage_id: 'training' }]]) {
    assert.throws(() => wardrobe.saveShot(db, 82, { change: { reason: '无效选择', characters: choices } }));
  }
});
test('non-overlapping episode defaults apply at episode boundaries; overlapping ranges require a shot choice', t => {
  const db = setup(t);
  characters.updateCharacter(db, log, 5, { stages: looks.map((s,i) => ({ ...s, episode_range: [i+1,i+1] })) });
  assert.equal(wardrobe.getShot(db, 80).characters[0].stage_id, 'home');
  assert.equal(wardrobe.getShot(db, 84).characters[0].stage_id, 'training');
  assert.equal(wardrobe.getShot(db, 84).continuity_reset, true);
  characters.updateCharacter(db, log, 5, { stages: looks.map(s => ({ ...s, episode_range: [1,3] })) });
  assert.equal(wardrobe.getShot(db, 80).characters[0].stage_id, null);
  assert.equal(wardrobe.getShot(db, 80).characters[0].description, '原有默认服装');
});
test('editing a stage updates linked shots; deleting it retains a visible snapshot instead of silently changing clothes', t => {
  const db = setup(t);
  wardrobe.saveShot(db, 81, { change: { reason: '训练场', characters: [{ character_id: 5, stage_id: 'training' }] } });
  characters.updateCharacter(db, log, 5, { stages: [looks[0], { ...looks[1], appearance: '白色训练装、黑色腰带' }] });
  assert.equal(wardrobe.getShot(db, 82).characters[0].description, '白色训练装、黑色腰带');
  characters.updateCharacter(db, log, 5, { stages: [looks[0]] });
  const shot = wardrobe.getShot(db, 82).characters[0];
  assert.equal(shot.stage_missing, true);
  assert.equal(shot.description, looks[1].appearance);
});
test('AI selects a saved stage from script evidence and cannot overwrite a manual selection', t => {
  const db = setup(t);
  const change = { boundary: 'before_shot', reason: '进入三角洲', evidence: '王奕宸走进光门，来到三角洲训练场。', characters: [{ character_id: 5, stage_id: 'training' }] };
  wardrobe.recordAiChange(db, 10, 81, { wardrobe_change: change });
  assert.equal(wardrobe.getShot(db, 82).characters[0].stage_id, 'training');
  wardrobe.saveShot(db, 81, { change: { ...change, characters: [{ character_id: 5, stage_id: 'home' }] } });
  wardrobe.recordAiChange(db, 10, 81, { wardrobe_change: change });
  assert.equal(wardrobe.getShot(db, 82).characters[0].stage_id, 'home');
  assert.match(wardrobe.planningContext(db, 1), /"id":"training"/);
});
test('costume transitions are split before speech budgeting while preserving every spoken word', async t => {
  const db = setup(t);
  const source = { characters: [5], action: '王奕宸换上训练服，走到任务台前。', dialogue: '王奕宸："我先进去。现在开始训练。"', narration: '', duration: 10, wardrobe_change: { boundary: 'during_shot', reason: '进入基地', characters: [{ character_id: 5, stage_id: 'training' }] } };
  const output = await planner.enforceSingleOutfit([source], { db, dramaId: 1, generate: async () => JSON.stringify([
    { action: '王奕宸走向光门。', dialogue: '王奕宸："我先进去。"', narration: '', duration: 4 },
    { action: '王奕宸站在任务台前。', dialogue: '王奕宸："现在开始训练。"', narration: '', duration: 5, wardrobe_change: { ...source.wardrobe_change, boundary: 'before_shot' } },
  ]) });
  assert.equal(output.length, 2);
  assert.equal(output[0].wardrobe_change, undefined);
  assert.equal(output[1].wardrobe_change.boundary, 'before_shot');
  assert.equal(output.map(s => speechFingerprint(s.dialogue)).join(''), speechFingerprint(source.dialogue));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM storyboards').get().n, 5);
  await assert.rejects(planner.enforceSingleOutfit([source], { db, dramaId: 1, generate: async () => JSON.stringify([{ dialogue: '' }, { dialogue: '' }]) }), /遗漏、重复或改写/);
  await assert.rejects(planner.enforceSingleOutfit([{ wardrobe_change: { characters: [{ character_id: 5, stage_id: 'bad' }] } }], { db, dramaId: 1 }), /造型不存在/);
  assert.doesNotThrow(() => planner.assertSingleOutfit({ action: '王奕宸穿着白色训练服站在任务台前。' }));
});
