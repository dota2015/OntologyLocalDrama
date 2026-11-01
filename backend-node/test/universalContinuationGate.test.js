const test = require('node:test');
const assert = require('node:assert/strict');
const { CrossSlotInvariantsRule } = require('../src/ontology/rules/crossSlotRules');

function pair() {
  const head = { shot_number: 1, scene_id: 1, creation_mode: 'universal', universal_segment_text: '场景 @图片1 中继续交谈',
    long_take_group_id: 'speech-split', long_take_role: 'head', long_take_sequence: 1,
    semantic_slots: { h3_mode: 'ref2va', first_frame_policy: 'none', last_frame_policy: 'none',
      continuity_type: 'hard_cut', visible_characters: [], background_characters: [], speech_plan: { audio_references: [] },
      required_references: [{ type: 'scene', id: 1 }] } };
  const tail = structuredClone(head);
  Object.assign(tail, { shot_number: 2, long_take_role: 'tail', long_take_sequence: 2, universal_segment_text: '继承前段尾帧继续交谈' });
  Object.assign(tail.semantic_slots, { h3_mode: 'fl2va', first_frame_policy: 'inherit_tail', continuity_type: 'long_take_continuation', required_references: [] });
  return [head, tail];
}
function gate(shots) {
  return new CrossSlotInvariantsRule().evaluate({ shots, options: { directorPlanningMode: 'universal' } });
}
test('universal split continuation rejects the legacy Agent FL2VA contract', () => {
  const shots = pair(), before = structuredClone(shots);
  const errors = gate(shots).filter(v => /UNIVERSAL_|LONG_TAKE_|FL2VA_|REF2VA_/.test(v.rule));
  assert.ok(errors.some(v => v.rule === 'INVARIANT_UNIVERSAL_REF2VA_REQUIRED'));
  assert.ok(errors.some(v => v.rule === 'INVARIANT_UNIVERSAL_SCENE_REFERENCE_REQUIRED'));
  assert.deepEqual(shots, before);
});
test('independent universal shots still require Ref2VA and its references', () => {
  const shot = pair()[1];
  delete shot.long_take_group_id; delete shot.long_take_role; delete shot.long_take_sequence;
  assert.ok(gate([shot]).some(v => v.rule === 'INVARIANT_UNIVERSAL_REF2VA_REQUIRED'));
});
test('continuation exemption does not bypass predecessor, frame or reference gates', () => {
  const shots = pair();
  assert.ok(gate([shots[1]]).some(v => v.rule === 'INVARIANT_LONG_TAKE_PREDECESSOR_MISSING'));
  shots[1].semantic_slots.h3_mode = 'ref2va';
  assert.ok(gate(shots).some(v => v.rule === 'INVARIANT_LONG_TAKE_CONTINUATION_EXECUTION_CONFLICT'));
  shots[1].semantic_slots.h3_mode = 'fl2va';
  shots[1].semantic_slots.required_references = [{ type: 'scene', id: 1 }];
  assert.ok(gate(shots).some(v => v.rule === 'INVARIANT_FL2VA_REF_CONTAMINATION'));
});
