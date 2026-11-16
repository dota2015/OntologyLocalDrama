const { describe, it } = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const {
  getDefaultOntologyConfig,
  getEffectiveConfig,
  saveConfig,
  resetToDefaults,
  mergeOntologyConfig,
} = require('../src/ontology/ontologyConfigService');
const { InvariantRuleEngine } = require('../src/ontology/ruleEngine');

describe('Short Drama Ontology Configuration System (短剧本体配置系统测试)', () => {
  it('should generate valid default short drama ontology configuration', () => {
    const defaults = getDefaultOntologyConfig();
    assert.strictEqual(typeof defaults, 'object');
    assert.strictEqual(defaults.version, '1.0.0');

    // 1. 对象类型检验
    assert.ok(Array.isArray(defaults.object_types));
    const objIds = defaults.object_types.map(o => o.id);
    assert.ok(objIds.includes('shot'));
    assert.ok(objIds.includes('character'));
    assert.ok(objIds.includes('scene'));
    assert.ok(objIds.includes('prop'));
    assert.ok(objIds.includes('action_atom'));

    const shotObj = defaults.object_types.find(o => o.id === 'shot');
    assert.ok(shotObj.properties.length > 5);
    const shotTypeProp = shotObj.properties.find(p => p.key === 'shot_type');
    assert.ok(shotTypeProp);
    assert.strictEqual(shotTypeProp.type, 'enum');

    // 2. 关系拓扑检验
    assert.ok(Array.isArray(defaults.relation_types));
    const relIds = defaults.relation_types.map(r => r.id);
    assert.ok(relIds.includes('shot_features_character'));
    assert.ok(relIds.includes('shot_takes_place_in_scene'));
    assert.ok(relIds.includes('shot_uses_prop'));
    assert.ok(relIds.includes('character_interacts_with_prop'));

    // 3. 门禁规则检验
    assert.ok(typeof defaults.rules === 'object');
    assert.ok(defaults.rules.RULE_CROWD_CONTROL);
    assert.strictEqual(defaults.rules.RULE_CROWD_CONTROL.params.max_characters, 2);
    assert.strictEqual(defaults.rules.RULE_H3_REFERENCE_CAPACITY.params.max_references, 9);
  });

  it('should persist, merge, update and reset configuration in database', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS global_settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT ''
      )
    `);

    // 初始读取应为默认规范
    const initial = getEffectiveConfig(db);
    assert.strictEqual(initial.rules.RULE_CROWD_CONTROL.params.max_characters, 2);

    // 更新配置：修改群戏最大角色数为 3，关闭空间轴线规则，给角色添加自定义扩展属性
    const modified = {
      ...initial,
      object_types: initial.object_types.map(obj => {
        if (obj.id === 'character') {
          return {
            ...obj,
            custom_properties: [
              { key: 'faction', name_zh: '战术阵营', type: 'string', default: '正义盟友' },
            ],
          };
        }
        return obj;
      }),
      rules: {
        ...initial.rules,
        RULE_CROWD_CONTROL: {
          enabled: true,
          severity: 'error',
          params: { max_characters: 3 },
        },
        RULE_SPATIAL_CONTINUITY: {
          enabled: false,
          severity: 'warning',
          params: {},
        },
      },
    };

    const saved = saveConfig(db, modified);
    assert.strictEqual(saved.rules.RULE_CROWD_CONTROL.params.max_characters, 3);
    assert.strictEqual(saved.rules.RULE_CROWD_CONTROL.severity, 'error');
    assert.strictEqual(saved.rules.RULE_SPATIAL_CONTINUITY.enabled, false);

    // 重新从库中获取生效配置
    const fetched = getEffectiveConfig(db);
    assert.strictEqual(fetched.rules.RULE_CROWD_CONTROL.params.max_characters, 3);
    assert.strictEqual(fetched.rules.RULE_CROWD_CONTROL.severity, 'error');
    assert.strictEqual(fetched.rules.RULE_SPATIAL_CONTINUITY.enabled, false);

    const charObj = fetched.object_types.find(o => o.id === 'character');
    assert.strictEqual(charObj.custom_properties.length, 1);
    assert.strictEqual(charObj.custom_properties[0].key, 'faction');

    // 重置配置
    const reset = resetToDefaults(db);
    assert.strictEqual(reset.rules.RULE_CROWD_CONTROL.params.max_characters, 2);
    assert.strictEqual(reset.rules.RULE_SPATIAL_CONTINUITY.enabled, true);

    const afterReset = getEffectiveConfig(db);
    assert.strictEqual(afterReset.rules.RULE_CROWD_CONTROL.params.max_characters, 2);
  });

  it('should enforce dynamic rule thresholds in InvariantRuleEngine', () => {
    const engine = new InvariantRuleEngine();

    // 构造一个包含 3 名出场角色的分镜
    const shotsWith3Characters = [
      {
        shot_number: 1,
        title: '三人对峙镜头',
        characters: '角色A,角色B,角色C',
        character_ids: [101, 102, 103],
        duration: 5,
        movement: 'push',
      },
    ];

    // 默认配置（max_characters = 2）：应当触发 RULE_CROWD_CONTROL 告警
    const defaultRes = engine.validate(
      { shots: shotsWith3Characters },
      {
        ruleConfigs: {
          RULE_CROWD_CONTROL: {
            enabled: true,
            severity: 'warning',
            params: { max_characters: 2 },
          },
        },
      }
    );
    assert.strictEqual(defaultRes.warnings.length, 1);
    assert.strictEqual(defaultRes.warnings[0].rule, 'INVARIANT_CROWD_COLLAPSE_RISK');

    // 动态调整配置：放宽 max_characters = 3
    const relaxedRes = engine.validate(
      { shots: shotsWith3Characters },
      {
        ruleConfigs: {
          RULE_CROWD_CONTROL: {
            enabled: true,
            severity: 'warning',
            params: { max_characters: 3 },
          },
        },
      }
    );
    assert.strictEqual(relaxedRes.warnings.length, 0);

    // 动态调整配置：禁用该规则
    const disabledRes = engine.validate(
      { shots: shotsWith3Characters },
      {
        ruleConfigs: {
          RULE_CROWD_CONTROL: {
            enabled: false,
            severity: 'warning',
            params: { max_characters: 2 },
          },
        },
      }
    );
    assert.strictEqual(disabledRes.warnings.length, 0);
  });
});
