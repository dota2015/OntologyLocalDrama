const test = require('node:test');
const assert = require('node:assert/strict');
const { isGazeOnlyHold, validateVideoSlots, PERFORMANCE_CONTRACT } = require('../src/ontology/videoSlots');

test('isGazeOnlyHold recognizes domestic/subtle physical actions and speech', () => {
  // Action with lowering head, hands on desk, shoulders dropping
  const values = [
    '继续低声承认，肩膀微微下沉',
    '坐姿，双手搭在桌沿，肩膀下沉，嘴唇开合',
    '被点破后的沉默与承认',
    '丽霞的注视',
  ];
  assert.equal(isGazeOnlyHold(values), false, 'Should recognize physical actions like 下沉/低头/开合/搭在');

  // Pure gaze without physical event should still be true
  const gazeValues = [
    '两人互相看着，保持不动',
    '坐着等待，眼神对视',
  ];
  assert.equal(isGazeOnlyHold(gazeValues), true, 'Pure gaze without physical action should be true');
});

test('validateVideoSlots accepts only structured_sync and rejects legacy contracts', () => {
  assert.equal(PERFORMANCE_CONTRACT, 'structured_sync');
  const legacyViolations = validateVideoSlots(
    { storyboard_number: 5, duration: 4, semantic_slots: { h3_mode: 'ref2va', shot_duration: 4, visible_characters: [] } },
    { performance_contract: 'sync_v1', camera: {}, audio_lip_sync: {}, timing: { duration: 4 }, shots_timeline: [] }
  );
  assert.ok(legacyViolations.some((v) => v.rule === 'INVARIANT_H3_PERFORMANCE_CONTRACT_VERSION'));
});
