const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildDirectorModelSettings,
  buildContiguousSourcePartitions,
  sourceAssignmentOutputType,
  storyboardBatchOutputType,
  directorTimelineOutputType,
  directorRepairOutputType,
  directorPatchRepairOutputType,
  directorStructuralRepairOutputType,
  directorRefinementOutputType,
} = require('../src/services/agentsRuntime');

describe('OpenAI Agents SDK director runtime', () => {
  it('maps Qwen thinking settings to vLLM chat_template_kwargs', () => {
    const settings = buildDirectorModelSettings({
      model: 'qwen3_5_122b',
      config: {},
      settings: { thinking: 'disabled', max_tokens: 65536 },
    }, { maxTokens: 32768, temperature: 0.2 });

    assert.equal(settings.providerData.chat_template_kwargs.enable_thinking, false);
    assert.equal(settings.maxTokens, 32768);
    assert.equal(settings.temperature, 0.2);
    assert.equal(settings.timeoutMs, 1_800_000);
    assert.equal(settings.reasoning, undefined);
  });

  it('uses configured reasoning effort when thinking is enabled', () => {
    const settings = buildDirectorModelSettings({
      model: 'deepseek-v4',
      config: {},
      settings: { thinking: 'enabled', reasoning_effort: 'high' },
    }, { maxTokens: 8192 });

    assert.deepEqual(settings.providerData.thinking, { type: 'enabled' });
    assert.deepEqual(settings.reasoning, { effort: 'high' });
  });

  it('defines SDK JSON schemas for draft, repair, and refinement runs', () => {
    const draft = storyboardBatchOutputType(3);
    assert.equal(draft.type, 'json_schema');
    assert.equal(draft.schema.properties.storyboards.minItems, 3);
    assert.equal(draft.schema.properties.storyboards.maxItems, 3);
    assert.equal(directorRepairOutputType.type, 'json_schema');
    assert.equal(directorRefinementOutputType.type, 'json_schema');
    const patchRepair = directorPatchRepairOutputType(7);
    assert.deepEqual(patchRepair.schema.required, ['repairs']);
    assert.equal(patchRepair.schema.anyOf, undefined);
    assert.equal(patchRepair.schema.properties.repairs.prefixItems[0].properties.shot_number.const, 7);
    const structuralRepair = directorStructuralRepairOutputType(9);
    assert.deepEqual(structuralRepair.schema.required, ['structural_repairs']);
    assert.equal(structuralRepair.schema.anyOf, undefined);
    assert.equal(structuralRepair.schema.properties.structural_repairs.prefixItems[0].properties.replace_shot_number.const, 9);

    const constrained = storyboardBatchOutputType(3, [{ id: 'B8U1' }, { id: 'B8U2' }, { id: 'B8U3' }]);
    const items = constrained.schema.properties.storyboards.prefixItems;
    assert.equal(items.length, 3);
    assert.deepEqual(
      items.map((item) => item.properties.semantic_slots.properties.source_script_unit_ids.prefixItems[0].const),
      ['B8U1', 'B8U2', 'B8U3'],
    );

    const units = ['B6U1', 'B6U2', 'B6U3', 'B6U4'].map((id) => ({ id }));
    const partitions = buildContiguousSourcePartitions(units, 3);
    assert.deepEqual(partitions, [
      [['B6U1'], ['B6U2'], ['B6U3', 'B6U4']],
      [['B6U1'], ['B6U2', 'B6U3'], ['B6U4']],
      [['B6U1', 'B6U2'], ['B6U3'], ['B6U4']],
    ]);
    assert.equal(sourceAssignmentOutputType(3, units).schema.properties.assignments.oneOf.length, 3);

    const shotSchema = items[0];
    assert.ok(shotSchema.required.includes('shot_number'));
    assert.ok(shotSchema.required.includes('semantic_slots'));
    assert.equal(shotSchema.required.includes('video_slots'), false);
    assert.equal(shotSchema.required.includes('character_visuals'), false);
    assert.ok(shotSchema.properties.semantic_slots.required.includes('source_script_unit_ids'));
    assert.equal(shotSchema.additionalProperties, false);

    const timeline = directorTimelineOutputType(5).schema.properties.shots_timeline;
    assert.equal(timeline.minItems, 1);
    assert.equal(timeline.maxItems, 5);
    assert.equal(timeline.items.properties.duration.type, 'integer');
    assert.equal(timeline.items.properties.duration.minimum, 1);
    assert.equal(timeline.items.properties.duration.maximum, 30);
    assert.equal(timeline.items.properties.action.maxLength, 120);
    assert.ok(timeline.items.required.includes('shot_number'));
    assert.ok(timeline.items.required.includes('timestamp'));
    assert.ok(timeline.items.required.includes('action'));
    assert.ok(timeline.items.required.includes('result'));
    assert.equal(timeline.items.properties.duration_seconds, undefined);
    const trajectory = timeline.items.properties.character_trajectories.items;
    assert.ok(trajectory.required.includes('gaze'));
    assert.ok(trajectory.required.includes('reaction_trigger'));
    assert.equal(trajectory.properties.gaze.maxLength, 80);
  });
});
