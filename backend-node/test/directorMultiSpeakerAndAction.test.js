const test = require('node:test');
const assert = require('node:assert/strict');
const { isStaticGazeTrajectory, validateVideoSlots, PERFORMANCE_CONTRACT } = require('../src/ontology/videoSlots');

test('isStaticGazeTrajectory relies on structured action_atom rather than prose regex', () => {
  assert.equal(isStaticGazeTrajectory({
    start_state: 'sitting',
    result_state: 'turning_head',
    action_atom: { action: 'react', direction: 'down', contact: 'none', object_id: null },
  }), false);

  assert.equal(isStaticGazeTrajectory({
    start_state: 'sitting',
    result_state: 'sitting',
    action_atom: { action: 'look', direction: 'none', contact: 'none', object_id: null },
  }), true);
});

test('validateVideoSlots accepts only structured_sync and rejects legacy contracts', () => {
  assert.equal(PERFORMANCE_CONTRACT, 'structured_sync');
  const legacyViolations = validateVideoSlots(
    { storyboard_number: 5, duration: 4, semantic_slots: { h3_mode: 'ref2va', shot_duration: 4, visible_characters: [] } },
    { performance_contract: 'sync_v1', camera: {}, audio_lip_sync: {}, timing: { duration: 4 }, shots_timeline: [] }
  );
  assert.ok(legacyViolations.some((v) => v.rule === 'INVARIANT_H3_PERFORMANCE_CONTRACT_VERSION'));
});
