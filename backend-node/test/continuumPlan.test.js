const { test } = require('node:test');
const assert = require('node:assert/strict');
const plan = require('../src/services/continuumPlan');

test('H3 execution backend follows the 4–8 / 9–30 contract', () => {
  assert.equal(plan.normalizeExecutionPlan(4).execution_backend, 'h3_single');
  assert.equal(plan.normalizeExecutionPlan(8).execution_backend, 'h3_single');
  const long = plan.normalizeExecutionPlan(20);
  assert.equal(long.execution_backend, 'h3_continuum');
  assert.equal(long.continuum_plan.total_duration, 20);
  assert.deepEqual(long.continuum_plan.slices.map(s => s.duration_seconds), [10, 10]);
  const odd = plan.normalizeExecutionPlan(11);
  assert.equal(odd.continuum_plan.chunks, 2);
  assert.equal(odd.continuum_plan.chunk_seconds, 5);
  assert.deepEqual(odd.continuum_plan.slices.map(s => s.duration_seconds), [6, 5]);
  assert.throws(() => plan.normalizeExecutionPlan(31), /4～30/);
  assert.throws(() => plan.normalizeExecutionPlan(8.5), /4～30/);
  assert.throws(() => plan.normalizeExecutionPlan(10, { execution_backend: 'h3_single' }), /Continuum/);
});

test('Continuum timeline prompt covers the complete integer timeline', () => {
  assert.equal(plan.timelinePrompt([
    { duration: 2, action: 'A moves', result: 'A stops' },
    { duration: 3, action: 'B reacts', result: 'B answers' },
  ], 5), '[0-2s] A moves；A stops\n[2-5s] B reacts；B answers');
  assert.throws(() => plan.timelinePrompt([{ duration: 2, action: 'A' }], 3), /合计/);
});
