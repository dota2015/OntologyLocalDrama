const test = require('node:test');
const assert = require('node:assert/strict');
const ontologyRoutes = require('../src/routes/ontology');

test('ontology getRules returns 12 registered invariant rules with metadata', () => {
  const routes = ontologyRoutes({}, console);
  let result = null;
  const res = {
    json: (payload) => { result = payload; },
    status: () => res,
  };
  routes.getRules({}, res);
  assert.equal(result?.success, true);
  assert.equal(Array.isArray(result?.data), true);
  assert.equal(result.data.length, 12);
  const ruleIds = result.data.map((r) => r.id);
  assert.equal(ruleIds.includes('RULE_AUDIO_CONTRACT'), true);
  assert.equal(ruleIds.includes('RULE_CROSS_SLOT_INVARIANTS'), true);
  assert.equal(ruleIds.includes('RULE_ASSET_REFERENCE_AND_PLANNING_FEASIBILITY'), true);
});

test('ontology getOverview returns principles, pipeline, stats, and action atoms', () => {
  const mockDb = {
    prepare: () => ({
      get: () => ({ c: 10 }),
    }),
  };
  const routes = ontologyRoutes(mockDb, console);
  let result = null;
  const res = {
    json: (payload) => { result = payload; },
    status: () => res,
  };
  routes.getOverview({}, res);
  assert.equal(result?.success, true);
  assert.equal(result.data.principles.length, 3);
  assert.equal(result.data.pipeline.length, 4);
  assert.equal(result.data.stats.rules_count, 12);
  assert.equal(result.data.action_atoms.actions_count > 0, true);
});
