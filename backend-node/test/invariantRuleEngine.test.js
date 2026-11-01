const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  InvariantRuleEngine,
  defaultEngine,
  BaseInvariantRule,
  checkAudioContract,
  validateAllInvariants,
} = require('../src/ontology/invariants');

describe('SHACL InvariantRuleEngine (Specification Pattern)', () => {
  it('defaultEngine contains all built-in rules', () => {
    const rules = defaultEngine.getRules();
    assert.ok(rules.length >= 11, `Expected at least 11 rules, got ${rules.length}`);
    assert.ok(!defaultEngine.getRule('RULE_MOVEMENT_DYNAMISM'));
    assert.ok(defaultEngine.getRule('RULE_AUDIO_CONTRACT'));
    assert.ok(defaultEngine.getRule('RULE_SPEECH_TIMING'));
    assert.ok(defaultEngine.getRule('RULE_VISUAL_SLOT_COMPLETENESS'));
    assert.ok(defaultEngine.getRule('RULE_VIDEO_SLOTS'));
    assert.ok(defaultEngine.getRule('RULE_CROWD_CONTROL'));
    assert.ok(defaultEngine.getRule('RULE_H3_REFERENCE_CAPACITY'));
    assert.ok(defaultEngine.getRule('RULE_PHYSICAL_DESCRIPTION'));
    assert.ok(defaultEngine.getRule('RULE_SPATIAL_CONTINUITY'));
    assert.ok(defaultEngine.getRule('RULE_PROP_ERA_AND_SCALE'));
    assert.ok(defaultEngine.getRule('RULE_OBSOLETE_ASSETS'));
  });

  it('allows registering and executing custom invariant rules', () => {
    const customEngine = new InvariantRuleEngine();

    class CustomLightingRule extends BaseInvariantRule {
      constructor() {
        super({
          id: 'RULE_CUSTOM_LIGHTING',
          name: '高对比度打光审查',
          category: 'lighting',
          defaultSeverity: 'warning',
        });
      }

      evaluate(context) {
        const violations = [];
        (context.shots || []).forEach((shot, idx) => {
          if (shot.lighting_style === 'pitch_black') {
            violations.push({
              rule: this.id,
              shot_number: shot.shot_number || idx + 1,
              severity: this.defaultSeverity,
              message: '镜头打光全黑，生图模型将无法成像',
            });
          }
        });
        return violations;
      }
    }

    customEngine.registerRule(new CustomLightingRule());
    assert.ok(customEngine.getRule('RULE_CUSTOM_LIGHTING'));

    const res = customEngine.validate({
      shots: [
        { shot_number: 1, movement: 'push', lighting_style: 'pitch_black', dialogue: '撤退！' },
      ],
    });

    assert.equal(res.warning_count, 1);
    assert.equal(res.warnings[0].rule, 'RULE_CUSTOM_LIGHTING');
  });

  it('does not emit the removed legacy missing-BGM violation', () => {
    const badShots = [
      { shot_number: 1, movement: 'static' },
      { shot_number: 2, movement: 'static' },
    ];

    const res1 = validateAllInvariants(badShots);
    assert.ok(!res1.violations.some((v) => v.rule === 'INVARIANT_SILENT_SHOT_MISSING_BGM'));

    const res2 = validateAllInvariants(badShots, {
      disabledRules: ['RULE_AUDIO_CONTRACT'],
    });
    assert.ok(!res2.violations.some((v) => v.rule === 'INVARIANT_SILENT_SHOT_MISSING_BGM'));
  });

  it('keeps the removed missing-BGM rule absent from severity overrides', () => {
    const badShots = [
      { shot_number: 1, movement: 'static' },
      { shot_number: 2, movement: 'static' },
    ];

    const res = validateAllInvariants(badShots, {
      severityOverrides: {
        RULE_AUDIO_CONTRACT: 'warning',
      },
    });

    const movWarn = res.warnings.find((w) => w.rule === 'INVARIANT_SILENT_SHOT_MISSING_BGM');
    assert.equal(movWarn, undefined);
  });

  it('supports options.onlyCategories to filter rules by domain category', () => {
    const shots = [
      { shot_number: 1, movement: 'static', dialogue: '', narration: '', bgm_prompt: '' },
    ];

    const res = defaultEngine.validate({ shots }, { onlyCategories: ['audio'] });
    assert.ok(!res.violations.some((v) => v.rule === 'INVARIANT_SILENT_SHOT_MISSING_BGM'));
    assert.ok(!res.violations.some((v) => v.rule.startsWith('INVARIANT_STATIC')));
  });

  it('computes audiovisual metrics accurately in stats object', () => {
    const shots = [
      { shot_number: 1, movement: 'push', dialogue: '第一句' },
      { shot_number: 2, movement: 'static', dialogue: '', narration: '', bgm_prompt: '紧张' },
      { shot_number: 3, movement: 'tracking', dialogue: '', narration: '', bgm_prompt: '' },
    ];

    const res = defaultEngine.validate({ shots });
    assert.equal(res.stats.total_shots, 3);
    assert.equal(res.stats.static_shots, 1);
    assert.equal(res.stats.dynamic_shots, 2);
    assert.equal(res.stats.silent_shots, 2);
    assert.equal(res.stats.silent_with_bgm, 1);
  });
});
