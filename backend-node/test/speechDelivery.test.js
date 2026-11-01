const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const delivery = require('../src/services/speechDeliveryService');
const narrative = require('../src/services/narrativeStyleService');
const { enforceStoryboardSpeechTiming } = require('../src/services/storyboardSpeechService');
const { speechFingerprint } = require('../src/utils/speechTiming');
const auto = { preset: 'dialogue_fast', speech_rate: 1.25, speech_mode: 'auto' };

test('Chinese and English generation rules allow complete longer dialogue with budgeted semantic splits', () => {
  const prompts = require('../src/services/storytellingPrompts');
  for (const language of ['zh', 'en']) {
    const cfg = { app: { language }, narrative_style: auto };
    for (const prompt of [prompts.storytellingRules(cfg), prompts.storyboardRules(cfg, true)]) {
      assert.match(prompt, /longer lines/);
      assert.match(prompt, /(?:semantic boundaries|语义边界)/);
      if (language === 'zh') assert.match(prompt, /不要求(?:一律短句|每句简短)/);
      assert.doesNotMatch(prompt, /Keep spoken lines short|台词要短|台词用短句|一轮简短交流/);
    }
  }
});

test('legacy pace inputs, density and emotion all resolve to natural speed', () => {
  const shot = { duration: 5, dialogue: '王奕宸："你好。"' };
  for (const input of [shot, { ...shot, dialogue: '好'.repeat(18) }, { ...shot, emotion: '急促争吵' },
    { ...shot, emotion: '急促争吵', dialogue: '好'.repeat(25), speech_rate: 1.9 }, { ...shot, emotion: '哽咽', speech_rate: 1.4 }]) {
    const resolved = delivery.resolve(auto, input);
    assert.equal(resolved.speech_rate, 1.25);
    assert.equal(resolved.effective_rate, 1.25);
    assert.equal(resolved.mode, 'tts_rate');
  }
  assert.equal(delivery.resolve({ ...auto, speech_mode: 'fixed', speech_rate: 1.5 }, shot).speech_rate, 1.25);
  assert.equal(delivery.resolve(auto, { duration: 5, dialogue: '无对白', narration: '无' }).has_speech, false);
  assert.equal(narrative.normalize({ preset: 'dialogue_fast' }).speech_mode, 'fixed');
  assert.deepEqual(narrative.normalize({ ...auto, speech_mode: 'unknown' }), { preset: 'balanced', speech_rate: 1, speech_mode: 'fixed' });
});

test('dialogue and narration share the full measured shot duration without implicit tail reserves', () => {
  const fixed = rate => ({ ...auto, speech_mode: 'fixed', tts_speed: rate });
  const shot = { duration: 5, dialogue: '王奕宸："好'.concat('好'.repeat(17), '。"') };
  const ordinary = delivery.resolve(fixed(1), shot);
  const brisk = delivery.resolve(fixed(1.3), shot);
  assert.equal(ordinary.han_budget, 20);
  assert.equal(ordinary.fits, true);
  assert.equal(brisk.han_budget, 26);
  assert.equal(brisk.fits, true);
  const mixed = delivery.resolve(fixed(1.3), { duration: 5 }, { segments: [
    { kind: 'dialogue', speaker: '王奕宸', text: '你好' },
    { kind: 'dialogue', speaker: '林教官', text: 'hello friend' },
    { kind: 'narration', text: '他们笑了' },
  ] });
  assert.equal(mixed.turn_pause_seconds, 0);
  assert.equal(mixed.han_budget, 26);
  assert.equal(mixed.estimated_seconds, 1.8);
  assert.equal(mixed.fits, true);
});

test('legacy 1.5x settings are ignored and cannot expand the natural-speed budget', () => {
  const auto15 = { preset: 'dialogue_fast', speech_rate: 1.5, speech_mode: 'auto' };
  const shot = { duration: 5, dialogue: '好'.repeat(22) };
  const res = delivery.resolve(auto15, shot);
  assert.equal(res.speech_rate, 1.25);
  assert.equal(res.han_budget, 25);
  assert.equal(res.fits, true);
  const instructions = delivery.planningInstructions(auto15, 5);
  assert.match(instructions, /实际 TTS speed=1.25x/);
  assert.doesNotMatch(instructions, /基准语速为 1\.5x|approximately 1\.5 times/);
  assert.match(instructions, /不要把 Agent 自己输出的 speed 当成可自由调整/);
});

function setup(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE dramas(id INTEGER PRIMARY KEY, metadata TEXT, updated_at TEXT, deleted_at TEXT);
    CREATE TABLE episodes(id INTEGER PRIMARY KEY, drama_id INTEGER, deleted_at TEXT);
    CREATE TABLE storyboards(id INTEGER PRIMARY KEY, episode_id INTEGER, duration REAL, dialogue TEXT, narration TEXT, description TEXT, action TEXT, deleted_at TEXT);
    INSERT INTO dramas(id,metadata) VALUES(1,'{}');
    INSERT INTO episodes(id,drama_id) VALUES(10,1);
    INSERT INTO storyboards(id,episode_id,duration,dialogue) VALUES(80,10,5,'你好');`);
  db.prepare('UPDATE dramas SET metadata=? WHERE id=1').run(JSON.stringify({ narrative_style: auto, keep: true }));
  return db;
}

test('AI pace plans are no longer persisted or consumed', t => {
  const db = setup(t);
  delivery.recordAiPlan(db, 10, 80, { speech_rate: 1.4, speech_rate_reason: '紧张短句', emotion: '急促争吵' });
  assert.equal(delivery.getShot(db, 80).speech_rate, 1.25);
  assert.match(delivery.getShot(db, 80).reason, /实际 TTS 速度 1.25x/);
  assert.equal(JSON.parse(db.prepare('SELECT metadata FROM dramas').get().metadata).keep, true);
  assert.equal(JSON.parse(db.prepare('SELECT metadata FROM dramas').get().metadata).speech_delivery, undefined);
  db.prepare('UPDATE storyboards SET dialogue=? WHERE id=80').run('修改后的短句');
  assert.equal(delivery.getShot(db, 80).speech_rate, 1.25);
  const meta = JSON.parse(db.prepare('SELECT metadata FROM dramas').get().metadata);
  meta.narrative_style = { ...auto, speech_mode: 'fixed', speech_rate: 1.1 };
  db.prepare('UPDATE dramas SET metadata=? WHERE id=1').run(JSON.stringify(meta));
  assert.equal(delivery.getShot(db, 80).speech_rate, 1.25);
});

test('speech planning uses natural speed before splitting and never loses overlong source speech', async () => {
  const short = await enforceStoryboardSpeechTiming([{ duration: 5, dialogue: '好'.repeat(14), speech_rate: 1.3 }], {
    durationRange: { min: 4, max: 5 }, narrativeStyle: auto,
    generate() { assert.fail('14 characters fit at natural speed without repair'); },
  });
  assert.equal(short[0].duration, 5);
  const source = { duration: 5, dialogue: '王奕宸："' + '好'.repeat(50) + '。"', speech_rate: 1.9 };
  let system = '';
  const split = await enforceStoryboardSpeechTiming([source], {
    durationRange: { min: 4, max: 5 }, narrativeStyle: auto,
    generate: async (_, instructions) => {
      system = instructions;
      return JSON.stringify([14,14,14,8].map(n => ({ duration: 5, dialogue: '王奕宸："' + '好'.repeat(n) + '。"', speech_rate: 1.3 })));
    },
  });
  assert.equal(split.length, 4);
  assert.equal(split.map(s => speechFingerprint(s.dialogue)).join(''), speechFingerprint(source.dialogue));
  assert.match(system, /不要把 Agent 自己输出的 speed 当成可自由调整/);
  assert.match(system, /实际 TTS speed=1.25x/);
  assert.doesNotMatch(system, /0\.25秒/);
  assert.match(system, /对白与旁白共用本镜/);
});
