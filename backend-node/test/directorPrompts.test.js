const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
  runDirectorAgent,
  auditDirectorDraft,
  planDirectorSourceAssignments,
  validTimelineDurationPlans,
  directorOutputTokenBudget,
  directorRepairTokenBudget,
  buildDirectorDraftBatches,
  assertDirectorDraftBatch,
  isolateDirectorDraftBatchPrompt,
  normalizeCoverageText,
  repairContextForViolations,
  applyDirectorRepairPlan,
  selectDirectorRepairTarget,
  directorAtomicRepairHint,
  directorAtomicPatchSchema,
  requiresDirectorStructuralRepair,
} = require('../src/ontology/directorAgent');
const { resolveEpisodeDurationSeconds } = require('../src/ontology/semanticPackage');
const {
  rebuildPromptsForStoryboard,
  rebuildPromptsForEpisode,
  extractStaticFreezeFramePose,
  isFlawedImagePrompt,
  sanitizeStaticImagePrompt,
} = require('../src/services/episodeStoryboardService');
const agentsRuntime = require('../src/services/agentsRuntime');

function semanticSlots({ characterId, characterName, dialogue = '', bgm = '', soundEffect = '' }) {
  return {
    visible_characters: [{ id: characterId, name: characterName }],
    background_characters: [],
    identity_visibility: 'three_quarter',
    wardrobe_id: null,
    speech_plan: {
      speaker_id: dialogue ? characterId : null,
      speaker_name: dialogue ? characterName : '',
      is_offscreen: false,
      is_narration: false,
      text: dialogue,
      speed: 1.2,
      emotion: '',
      audio_references: [],
    },
    sound_plan: {
      sound_effects: soundEffect ? [soundEffect] : [],
      bgm_prompt: bgm,
      acoustic_env: '',
      is_silent: false,
    },
    continuity_type: 'continuation',
    continuity_from_previous: {
      relationship: 'opening',
      previous_end_state: '上一镜结束时角色仍在当前场景中，动作已收束',
      entry_state: '角色在当前场景的起始位置与姿态已建立',
      causal_link: '本镜建立当前因果节拍',
      sound_bridge: '',
      requires_previous_tail: false,
    },
    h3_mode: 'ref2va',
    h3_mode_reason: '角色镜头需要人物卡保持跨镜身份一致',
    first_frame_policy: 'none',
    first_frame_reason: 'Ref2VA 直接使用人物参考，不生成首帧',
    last_frame_policy: 'none',
    last_frame_reason: '动作自然收束，无需锁定尾帧',
    required_references: [{ id: characterId, character_id: characterId, type: 'character', name: characterName }],
    audio_lip_sync: dialogue ? 'in_frame_dialogue' : 'none',
    shot_duration: 5,
  };
}

function videoSlots({ characterId, characterName, dialogue = '', movement = 'push' }) {
  return {
    camera: {
      shot_type: '中景', angle_h: 'front_left', angle_v: 'eye_level', angle_s: 'medium',
      movement, movement_description: '摄影机沿主体动作方向平稳移动',
    },
    audio_lip_sync: {
      mode: dialogue ? 'in_frame_dialogue' : 'silent_ambient',
      speaker_name: dialogue ? characterName : '',
      speaker_in_frame: !!dialogue,
      delivery_medium: 'direct_speech',
      dialogue_content: dialogue,
      visible_characters_lip_state: dialogue ? 'speaker_synced' : 'relaxed closed lips',
    },
    trajectories: [{
      character_id: characterId,
      name: characterName,
      start_anchor: '画面中心偏左',
      trajectory: '保持在当前动作区域内',
      terminal_pose: '动作稳定收束',
      facial_expression: '保持当前情绪',
      facing: dialogue ? '四分之三侧身朝向画外受话人' : '四分之三侧身朝向前方动作区',
      head_pose: dialogue ? '头部转向画外受话人面部' : '头部微俯朝向前方动作区',
      gaze: dialogue ? '双眼看向画外受话人眼睛' : '目光锁定前方动作区',
      attention_target: dialogue ? '画外受话人面部' : '前方动作区',
      gaze_motivation: dialogue ? '直接对话' : '专注当前动作',
      reaction_trigger: dialogue ? '自己开口说话' : '当前动作持续',
      mouth_state: dialogue ? 'speaker_synced' : '双唇自然闭合',
    }],
    environment_vfx: { physical_interactions: [], atmosphere: '', lighting_change: '' },
    timing: { duration: 5, beats: [] },
    shots_timeline: [2, 2, 1].map((segmentDuration, index) => {
      const shotNumber = index + 1;
      return {
      shot_number: shotNumber,
      duration: segmentDuration,
      camera: { shot_type: shotNumber === 1 ? '中景' : '近景', movement: shotNumber === 1 ? movement : 'static', movement_description: '短剧节奏切换' },
      action: shotNumber === 1 ? '主体动作推进' : '角色反应收束',
      result: shotNumber === 1 ? '' : '动作完成',
      character_trajectories: [{
        character_id: characterId,
        name: characterName,
        start_anchor: '画面中心偏左',
        trajectory: shotNumber === 1 ? '完成主要动作' : '抬眼并调整重心作出反应',
        terminal_pose: '动作稳定收束',
        facial_expression: shotNumber === 1 ? '神情专注' : '目光收紧作出反应',
        facing: dialogue ? '四分之三侧身朝向画外受话人' : '四分之三侧身朝向前方动作区',
        head_pose: dialogue ? '头部转向画外受话人面部' : '头部微俯朝向前方动作区',
        gaze: dialogue ? '双眼看向画外受话人眼睛' : '目光锁定前方动作区',
        attention_target: dialogue ? '画外受话人面部' : '前方动作区',
        gaze_motivation: dialogue ? '直接对话' : '专注当前动作',
        reaction_trigger: dialogue
          ? (shotNumber === 1 ? '自己开口说话' : '对方对台词作出反应')
          : (shotNumber === 1 ? '主要动作启动' : '主要动作完成'),
        mouth_state: dialogue ? 'speaker_synced' : '双唇自然闭合',
      }],
      audio_lip_sync: {
        mode: dialogue ? 'in_frame_dialogue' : 'silent_ambient', speaker_name: dialogue ? characterName : '',
        speaker_in_frame: !!dialogue, dialogue_content: dialogue, lip_sync_rule: '跨切口连续',
      },
      };
    }),
  };
}

describe('Director Agent Prompt Generation & Persistence', () => {
  let db;

  it('continues a Director layer beyond three gate feedback rounds', async (t) => {
    let calls = 0;
    const progressMessages = [];
    t.mock.method(agentsRuntime, 'runAgent', async () => {
      calls += 1;
      if (calls <= 3) return { assignments: [] };
      return {
        assignments: [
          { shot_slot: 1, source_script_unit_ids: ['U1'] },
          { shot_slot: 2, source_script_unit_ids: ['U2', 'U3'] },
        ],
      };
    });

    const result = await planDirectorSourceAssignments(console, console, {
      index: 0,
      shot_count: 2,
      source_units: [{ id: 'U1' }, { id: 'U2' }, { id: 'U3' }],
    }, {
      maxAttempts: 5,
      onProgress: (_progress, message) => progressMessages.push(message),
    });

    assert.deepEqual(result, [['U1'], ['U2', 'U3']]);
    assert.equal(calls, 4);
    assert.match(progressMessages.at(-1), /第 3\/5 轮/);
  });

  it('enumerates only exact timeline duration plans for every supported shot length', () => {
    for (let duration = 4; duration <= 8; duration++) {
      const plans = validTimelineDurationPlans(duration);
      assert.ok(plans.length > 0);
      for (const plan of plans) {
        assert.ok(plan.every((seconds) => Number.isInteger(seconds) && seconds >= 1 && seconds <= 2));
        assert.equal(plan.reduce((sum, seconds) => sum + seconds, 0), duration);
      }
    }
    assert.ok(validTimelineDurationPlans(7).every(plan => plan.length >= 4));
    assert.equal(validTimelineDurationPlans(7).some((plan) => plan.some((seconds) => !Number.isInteger(seconds))), false);
  });

  before(() => {
    try {
      db = new Database(':memory:');
      require('../src/db/migrate').runMigrationsAndEnsure(db);
      db.exec(`
        INSERT INTO dramas (id, title, genre, style, metadata, status, created_at, updated_at) VALUES (1, '末日行动', '科幻', 'photorealistic', '{"aspect_ratio":"16:9"}', 'active', '2026-10-24', '2026-10-24');
        INSERT INTO episodes (id, drama_id, episode_number, title, duration, script_content, status, created_at, updated_at) VALUES (10, 1, 1, '突围', 60, '红狼在废弃仓库断墙后换弹，掩护蜂医撤离。', 'draft', '2026-10-24', '2026-10-24');
        INSERT INTO characters (id, drama_id, name, role, appearance, description) VALUES (1, 1, '红狼', '队长', '身穿深灰色战术服，戴防风眼镜与战术耳机', '战术突击手');
        INSERT INTO characters (id, drama_id, name, role, appearance, description) VALUES (2, 1, '蜂医', '医护', '金发马尾，身穿白色医疗防护服', '战地医生');
        INSERT INTO scenes (id, drama_id, episode_id, location, time, prompt) VALUES (100, 1, 10, '废弃工厂内部战斗区', '日景', '废弃厂房断墙');
        INSERT INTO props (id, drama_id, name, type, description, physical_scale, image_prompt) VALUES (200, 1, '军用情报箱', '道具', '黑色密码箱', '40cm', '金属箱');
      `);
    } catch (e) {
      console.error('BEFORE HOOK ERROR:', e);
      throw e;
    }
  });

  after(() => {
    if (db) db.close();
  });

  it('scales the initial Director budget without an application-level output cap and keeps repair turns compact', () => {
    assert.equal(directorOutputTokenBudget(2), 32768);
    assert.ok(directorOutputTokenBudget(22) >= 34000);
    assert.equal(directorOutputTokenBudget(100), 144000);
    assert.equal(directorRepairTokenBudget(2, 2), 8192);
    assert.equal(directorRepairTokenBudget(100, 22), 24576);
  });

  it('treats persisted episode duration as minutes and never lets an incomplete prior run shrink a long script', () => {
    assert.equal(resolveEpisodeDurationSeconds({ duration: 1, script_content: '字'.repeat(1214) }), 131);
    assert.equal(resolveEpisodeDurationSeconds({ duration: 2, script_content: '短剧本' }), 120);
    assert.equal(resolveEpisodeDurationSeconds({ duration: 60, script_content: '短剧本' }), 60);
  });

  it('splits a long Director draft into complete contiguous source batches and rejects partial output', () => {
    const script = Array.from({ length: 18 }, (_, index) => `第${index + 1}段剧情。`).join('\n');
    const batches = buildDirectorDraftBatches(script, 27);
    assert.equal(batches.length, 9);
    assert.equal(batches.reduce((sum, batch) => sum + batch.shot_count, 0), 27);
    assert.equal(normalizeCoverageText(batches.map((batch) => batch.script_segment).join('')), normalizeCoverageText(script));

    const first = batches[0];
    const ids = first.source_units.map((unit) => unit.id);
    const shots = ids.map((id) => ({ semantic_slots: { source_script_unit_ids: [id] } }));
    assert.doesNotThrow(() => assertDirectorDraftBatch(first, shots, {}));
    assert.throws(() => assertDirectorDraftBatch(first, shots, { truncated: true }), /截断/);
    assert.throws(() => assertDirectorDraftBatch(first, shots.slice(0, 2), {}), /应返回 3 镜/);
    assert.throws(() => assertDirectorDraftBatch(first, [
      shots[0], shots[1], { semantic_slots: { source_script_unit_ids: ['B1U999'] } },
    ], {}), /原文单元分配不完整/);
  });

  it('reserves source for every batch even when a long final paragraph exceeds the proportional target', () => {
    const script = [...Array.from({ length: 24 }, (_, i) => `第${i}段。`), '结尾剧情'.repeat(80)].join('\n');
    const batches = buildDirectorDraftBatches(script, 74);
    assert.equal(batches.length, 25);
    assert.equal(batches.reduce((sum, b) => sum + b.shot_count, 0), 74);
    assert.equal(normalizeCoverageText(batches.map(b => b.script_segment).join('')), normalizeCoverageText(script));
    for (const batch of batches) {
      assert.ok(batch.script_segment.trim(), `batch ${batch.index + 1} must have source`);
      assert.ok(batch.source_units.length >= batch.shot_count);
      assert.ok(agentsRuntime.buildContiguousSourcePartitions(batch.source_units, batch.shot_count).length);
    }
  });

  it('creates enough source units for short indivisible text and fails impossible transport plans before drafting', () => {
    // ceil(length / count) used to yield only two units for four characters / three shots.
    const script = Array(4).fill('甲乙丙丁').join('\n');
    const batches = buildDirectorDraftBatches(script, 12);
    assert.ok(batches.every(b => b.source_units.length === 3));
    assert.equal(normalizeCoverageText(batches.flatMap(b => b.source_units.map(u => u.text)).join('')), normalizeCoverageText(script));
    assert.throws(() => buildDirectorDraftBatches('甲乙', 74), /无法分配/);
    assert.throws(() => buildDirectorDraftBatches(Array(4).fill('甲').join('\n'), 12), /无法分配/);
  });

  it('removes the complete episode script from every atomic draft batch request', () => {
    const fullScript = '第一段只属于前批。\n第二段是当前批。\n第三段只属于后批。';
    const basePrompt = `【剧本内容】：\n${fullScript}\n\n【任务要求】：只返回 JSON`;
    const isolated = isolateDirectorDraftBatchPrompt(basePrompt, fullScript, '第二段是当前批。');
    assert.match(isolated, /【当前批次唯一允许处理的剧本内容】：\n第二段是当前批。/);
    assert.doesNotMatch(isolated, /第一段只属于前批/);
    assert.doesNotMatch(isolated, /第三段只属于后批/);
    assert.throws(
      () => isolateDirectorDraftBatchPrompt('无剧本边界', fullScript, '第二段是当前批。'),
      /无法安全隔离当前批次/
    );
  });

  it('selects one violation on one target shot and keeps only continuity neighbours as read-only context', () => {
    const shots = Array.from({ length: 6 }, (_, index) => ({ shot_number: index + 1, title: `镜头${index + 1}` }));
    const violations = [{ rule: 'A', shot_number: 3 }, { rule: 'B', shot_number: 3 }, { rule: 'C', shot_number: 5 }];
    const target = selectDirectorRepairTarget(shots, violations);
    assert.equal(target.shot_number, 3);
    assert.deepEqual(target.violations.map((item) => item.rule), ['A']);
    const selected = repairContextForViolations(shots, violations);
    assert.deepEqual(selected.map((shot) => shot.shot_number), [2, 3, 4]);

    const globalShots = shots.map((shot, index) => ({ ...shot, movement: index === 2 ? 'static' : 'push' }));
    const globalTarget = selectDirectorRepairTarget(globalShots, [{ rule: 'INVARIANT_STATIC_RATIO_EXCEEDED', shot_number: null }]);
    assert.equal(globalTarget.shot_number, 3);
    assert.deepEqual(repairContextForViolations(globalShots, globalTarget.violations).map((shot) => shot.shot_number), [2, 3, 4]);
  });

  it('gives atomic visual-slot repairs an exact character path and full-array contract', () => {
    const hint = directorAtomicRepairHint({
      rule: 'INVARIANT_SLOT_MISSING_HEAD_POSE',
      character_id: 17,
      character_name: '蜂医',
      conflict_slots: ['character_visuals[1].head_pose'],
    });
    assert.match(hint, /character_visuals\[1\]\.head_pose/);
    assert.match(hint, /蜂医/);
    assert.match(hint, /完整的 character_visuals 数组/);
    assert.match(hint, /头部/);
  });

  it('restricts universal-mode repair to the one deterministic top-level field', () => {
    const schema = directorAtomicPatchSchema({ rule: 'INVARIANT_UNIVERSAL_CREATION_MODE_REQUIRED' });
    assert.deepEqual(schema.required, ['creation_mode']);
    assert.deepEqual(schema.properties.creation_mode, { const: 'universal' });
    assert.equal(schema.additionalProperties, false);
    const outputType = agentsRuntime.directorPatchRepairOutputType(1, schema);
    const patchSchema = outputType.schema.properties.repairs.prefixItems[0].properties.patch;
    assert.equal(patchSchema.additionalProperties, false);
    assert.deepEqual(patchSchema.properties.creation_mode, { const: 'universal' });
  });

  it('locks every visual-array value except the one Agent-owned invalid field', () => {
    const visuals = [
      { character_id: 25, name: '红狼', posture: '身体', gaze: '目光锁定蜂医' },
      { character_id: 26, name: '蜂医', posture: '单膝跪地', gaze: '目光看向红狼' },
    ];
    const schema = directorAtomicPatchSchema({
      rule: 'INVARIANT_SLOT_MISSING_POSTURE',
      character_id: 25,
      character_name: '红狼',
      conflict_slots: ['character_visuals[0].posture'],
    }, { character_visuals: visuals });
    const items = schema.properties.character_visuals.prefixItems;
    assert.equal(items.length, 2);
    assert.equal(items[0].properties.character_id.const, 25);
    assert.ok(items[0].properties.posture.enum.some((value) => value.includes('站')));
    assert.deepEqual(items[1].properties.posture, { const: '单膝跪地' });
    assert.equal(schema.additionalProperties, false);
  });

  it('extends speech within H3 duration capacity and only splits beyond the limit', () => {
    assert.equal(requiresDirectorStructuralRepair({ rule: 'INVARIANT_SPEECH_OVER_BUDGET', max_duration: 5, assessment: { recommendedDuration: 7 } }), true);
    assert.equal(requiresDirectorStructuralRepair({
      rule: 'INVARIANT_SPEECH_OVER_BUDGET',
      assessment: { recommendedDuration: 7 },
    }), false);
    assert.equal(requiresDirectorStructuralRepair({
      rule: 'INVARIANT_SPEECH_OVER_BUDGET',
      assessment: { recommendedDuration: 11 },
    }), true);

    const schema = directorAtomicPatchSchema({
      rule: 'INVARIANT_SPEECH_OVER_BUDGET',
      assessment: { recommendedDuration: 7 },
    }, { semantic_slots: { shot_duration: 6 } });
    assert.equal(schema.properties.duration.const, 7);
    assert.equal(schema.properties.semantic_slots.properties.shot_duration.const, 7);
    assert.equal(schema.properties.video_slots.properties.timing.properties.duration.const, 7);
    const plans = schema.properties.video_slots.properties.shots_timeline.oneOf;
    assert.ok(plans.length > 0);
    for (const plan of plans) {
      assert.equal(plan.prefixItems.reduce((sum, item) => sum + item.properties.duration.const, 0), 7);
      assert.ok(plan.prefixItems.every((item) => Number.isInteger(item.properties.duration.const) && item.properties.duration.const >= 1 && item.properties.duration.const <= 7));
    }
  });

  it('requires an Agent structural split when one outer shot contains multiple speakers', () => {
    assert.equal(requiresDirectorStructuralRepair({ rule: 'INVARIANT_MULTI_SPEAKER_SHOT' }), true);
  });

  it('adds only missing universal references while preserving the existing ordered list', () => {
    const schema = directorAtomicPatchSchema({
      rule: 'INVARIANT_UNIVERSAL_CHARACTER_REFERENCE_MISSING',
    }, {
      scene_id: 38,
      semantic_slots: {
        visible_characters: [{ id: 18, name: '露娜' }],
        background_characters: [],
        required_references: [{ type: 'scene', id: 38, scene_id: 38 }],
      },
    });
    const refs = schema.properties.semantic_slots.properties.required_references.prefixItems;
    assert.deepEqual(refs[0].const, { type: 'scene', id: 38, scene_id: 38 });
    assert.deepEqual(refs[1].const, { type: 'character', id: 18, character_id: 18, name: '露娜' });
    assert.equal(schema.properties.semantic_slots.additionalProperties, false);
  });

  it('returns audio-contract conflicts to the Agent instead of choosing a creative repair', () => {
    const schema = directorAtomicPatchSchema({ rule: 'INVARIANT_SILENT_SHOT_AUDIO_CONFLICT' }, {
      dialogue: '红狼：快撤！',
      semantic_slots: {
        speech_plan: { text: '快撤！', is_narration: false, is_offscreen: false },
        sound_plan: { is_silent: true },
        audio_lip_sync: 'silent_ambient',
      },
    });
    assert.equal(schema, null, 'runtime falls back to an Agent-owned patch schema for this creative choice');
  });

  it('applies Agent-owned field patches deterministically without changing unspecified slots', () => {
    const original = [{
      shot_number: 1,
      movement: 'static',
      semantic_slots: { h3_mode: 'fl2va', first_frame_policy: 'generate_new', required_references: [] },
      characters: [1],
    }];
    const result = applyDirectorRepairPlan(original, {
      repairs: [{
        shot_number: 1,
        patch: { movement: 'tracking', semantic_slots: { h3_mode_reason: '跟随动作保持人物连续性' } },
      }],
    });
    assert.equal(result.shots[0].movement, 'tracking');
    assert.equal(result.shots[0].semantic_slots.h3_mode, 'fl2va');
    assert.equal(result.shots[0].semantic_slots.h3_mode_reason, '跟随动作保持人物连续性');
    assert.deepEqual(result.shots[0].characters, [1]);
    assert.equal(original[0].movement, 'static');

    assert.throws(() => applyDirectorRepairPlan([
      { shot_number: 1, movement: 'static' },
      { shot_number: 2, movement: 'static' },
    ], {
      repairs: [
        { shot_number: 1, patch: { movement: 'push' } },
        { shot_number: 2, patch: { movement: 'tracking' } },
      ],
    }), /每轮只允许修复一个/);
  });

  it('supports explicit Agent-directed shot splitting and only renumbers the resulting sequence', () => {
    const result = applyDirectorRepairPlan(
      [{ shot_number: 1, title: '前镜' }, { shot_number: 2, title: '长对白' }, { shot_number: 3, title: '后镜' }],
      { structural_repairs: [{ replace_shot_number: 2, storyboards: [{ title: '上半句' }, { title: '下半句' }] }] },
    );
    assert.deepEqual(result.shots.map((shot) => [shot.shot_number, shot.title]), [
      [1, '前镜'], [2, '上半句'], [3, '下半句'], [4, '后镜'],
    ]);

    const covered = [{ shot_number: 1, semantic_slots: { source_script_excerpt: '完整原文' } }];
    assert.throws(() => applyDirectorRepairPlan(covered, {
      structural_repairs: [{ replace_shot_number: 1, storyboards: [{ h3_mode: 'ref2va' }, { h3_mode: 'fl2va' }] }],
    }), /缺少 semantic_slots.source_script_excerpt.*完整 semantic_slots 对象/);
    assert.throws(() => applyDirectorRepairPlan(covered, {
      structural_repairs: [{
        replace_shot_number: 1,
        storyboards: [{ semantic_slots: { source_script_excerpt: '只剩一半' } }],
      }],
    }), /拼接结果必须与原镜完全一致/);
    assert.doesNotThrow(() => applyDirectorRepairPlan(covered, {
      structural_repairs: [{
        replace_shot_number: 1,
        storyboards: [
          { semantic_slots: { source_script_excerpt: '完整' } },
          { semantic_slots: { source_script_excerpt: '原文' } },
        ],
      }],
    }));
  });

  it('runDirectorAgent persists image prompts and authoritative H3 slots without video_prompt', async (t) => {
    const directorCallOptions = [];
    t.mock.method(agentsRuntime, 'runAgent', async (...args) => {
      directorCallOptions.push(args[2] || {});
      if(args[2]?.name === 'director-episode-pacing') return {feasible:true, reason:'两段动作', shots:[{duration:5,purpose:'换弹'},{duration:4,purpose:'撤离'}]};
      return {
        storyboards: [
          {
            shot_number: 1,
            title: '断墙换弹',
            scene_id: 100,
            characters: [1],
            props: [200],
            shot_type: '中景',
            dialogue_framing: 'solo_action',
            angle_h: 'front_left',
            angle_v: 'low',
            angle_s: 'medium',
            movement: 'push',
            lighting_style: 'dramatic',
            depth_of_field: 'shallow',
            duration: 5,
            action: '红狼背靠断墙快速更换步枪弹匣，警惕观察通道',
            result: '弹匣卡紧，推膛上锁',
            dialogue: '',
            narration: '',
            bgm_prompt: '低频紧迫战术脉冲音',
            sound_effect: '弹匣撞击声',
            layout_description: '红狼位于画面中心偏左，情报箱置于断墙边',
            emotion: '紧张戒备',
            image_prompt: '写实电影感，红狼躲在废弃工厂断墙后低姿换弹，侧光，浅景深',
            character_visuals: [
              {
                character_id: 1,
                name: '红狼',
                depth_layer: 'midground',
                screen_position: '画面中心偏左中景',
                environmental_anchor: '倚靠断墙',
                facing: '身体微侧30度（3/4侧面视角）',
                expression: '眼神冷峻警惕',
                head_pose: '头部微侧朝向通道',
                gaze: '双眼紧盯前方通道',
                posture: '低姿半蹲，重心压低',
                hands: '双手快速更换步枪弹匣',
                prop_interaction: '双手握持步枪与弹匣',
                appearance_details: '黑色战术作战服'
              }
            ],
            video_slots: videoSlots({ characterId: 1, characterName: '红狼', movement: 'push' }),
            semantic_slots: semanticSlots({ characterId: 1, characterName: '红狼', bgm: '低频紧迫战术脉冲音', soundEffect: '弹匣撞击声' }),
          },
          {
            shot_number: 2,
            title: '蜂医撤离',
            scene_id: 100,
            characters: [2],
            props: [],
            shot_type: '特写',
            dialogue_framing: 'single_reaction_offscreen',
            angle_h: 'front',
            angle_v: 'eye_level',
            angle_s: 'close_up',
            movement: 'tracking',
            lighting_style: 'side',
            depth_of_field: 'shallow',
            duration: 4,
            action: '蜂医扶住受损护甲，压低身体朝后方撤离点冲刺',
            result: '翻入掩体后方',
            dialogue: '蜂医: "我已就位！"',
            narration: '',
            bgm_prompt: '',
            sound_effect: '急促脚步声',
            layout_description: '蜂医从画右冲向画左',
            emotion: '决绝',
            character_visuals: [
              {
                character_id: 2,
                name: '蜂医',
                depth_layer: 'foreground',
                screen_position: '画面中央特写',
                environmental_anchor: '撤离点掩体前',
                facing: '正面面对镜头',
                expression: '决绝紧绷',
                head_pose: '头部微低',
                gaze: '目光锁定掩体后方',
                posture: '前倾冲刺定格',
                hands: '左手扶住受损护甲',
                prop_interaction: '',
                appearance_details: '战术医疗甲受损'
              }
            ],
            video_slots: videoSlots({ characterId: 2, characterName: '蜂医', dialogue: '我已就位！', movement: 'tracking' }),
            semantic_slots: semanticSlots({ characterId: 2, characterName: '蜂医', dialogue: '我已就位！', soundEffect: '急促脚步声' }),
          },
        ],
      };
    });

    const result = await runDirectorAgent(db, console, {}, 10);
    assert.equal(result.total_shots, 2);
    assert.equal(result.max_reflection_rounds, 500);
    assert.ok(directorCallOptions.length > 0);
    const draftInstructions = directorCallOptions.find(options => options.name === 'director-storyboard-draft').instructions;
    assert.match(draftInstructions, /对白与动作完成合同：提交前由导演自检/);
    assert.match(draftInstructions, /区分当场执行的意图、未来承诺/);
    assert.match(draftInstructions, /UNIVERSAL DIRECTING PRINCIPLES/);
    assert.match(draftInstructions, /不以任何风格选项为开关/);
    assert.match(draftInstructions, /实际 TTS 时长/);
    assert.match(draftInstructions, /语音收尾预留只限制发声，不要求身体静止/);
    assert.match(draftInstructions, /后端不替你推测或补写语义/);
    assert.equal(directorCallOptions.some((options) => Object.hasOwn(options, 'reasoningEffort') || Object.hasOwn(options, 'reasoning_effort')), false,
      '导演不应覆盖 AI 配置中的思考强度');

    const sbs = db.prepare('SELECT * FROM storyboards WHERE episode_id = 10 AND deleted_at IS NULL ORDER BY storyboard_number ASC').all();
    assert.equal(sbs.length, 2);

    // Shot 1 check
    assert.ok(sbs[0].image_prompt, 'Shot 1 must have image_prompt');
    assert.match(sbs[0].image_prompt, /红狼/);
    assert.equal(sbs[0].video_prompt, null);
    assert.ok(sbs[0].polished_prompt, 'Shot 1 must have polished_prompt');
    assert.equal(JSON.parse(sbs[0].semantic_slots).sound_plan.bgm_prompt, '低频紧迫战术脉冲音');
    assert.equal(JSON.parse(sbs[0].video_slots).camera.movement, 'push');

    // Prompt text is compiled deterministically from the Agent-owned slots.
    assert.ok(sbs[1].image_prompt, 'Shot 2 must have a compiled image_prompt');
    assert.match(sbs[1].image_prompt, /蜂医/);
    assert.equal(sbs[1].video_prompt, null);
    assert.equal(JSON.parse(sbs[1].semantic_slots).speech_plan.text, '我已就位！');
    assert.equal(JSON.parse(sbs[1].video_slots).audio_lip_sync.dialogue_content, '我已就位！');
  });

  it('repairs the tail frame, feeds back a rejected patch, and durably records both attempts', async (t) => {
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const { withTaskTrace } = require('../src/services/directorTrace');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'director-repair-trace-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const planned = db.prepare('SELECT * FROM storyboards WHERE episode_id=10 AND deleted_at IS NULL ORDER BY storyboard_number').all().map(row => ({
      ...row,
      characters: JSON.parse(row.characters || '[]'),
      background_characters: JSON.parse(row.background_characters || '[]'),
      character_visuals: JSON.parse(row.character_visuals || '[]'),
      last_frame_visuals: JSON.parse(row.last_frame_visuals || '[]'),
      video_slots: JSON.parse(row.video_slots || '{}'),
      semantic_slots: JSON.parse(row.semantic_slots || '{}'),
    }));
    planned[0].last_frame_visuals = structuredClone(planned[0].character_visuals);
    planned[0].last_frame_visuals[0].facing = '';
    Object.assign(planned[0].semantic_slots, { h3_mode: 'fl2va', first_frame_policy: 'generate_new',
      first_frame_reason: '测试首帧', last_frame_policy: 'generate_tail', last_frame_reason: '测试尾帧', required_references: [] });
    const repairs = [];
    t.mock.method(agentsRuntime, 'runAgent', async (_db, _log, options) => {
      if (options.name === 'director-episode-pacing') return { feasible: true, reason: '测试原规划', shots: planned.map(s => ({ duration: s.duration, purpose: s.action })) };
      if (options.name === 'director-storyboard-draft') return { storyboards: structuredClone(planned) };
      assert.equal(options.name, 'director-invariant-repair');
      repairs.push(options);
      assert.ok(options.outputType.schema.properties.repairs.prefixItems[0].properties.patch.properties.last_frame_visuals);
      if (repairs.length === 1) return { repairs: [{ shot_number: 1, patch: { character_visuals: [{ ...planned[0].character_visuals[0], facing: '侧身朝向画面左侧' }] } }] };
      assert.match(options.input, /上轮修复被拒绝的完整反馈/);
      assert.match(options.input, /original_patch/);
      assert.match(options.input, /last_frame_visuals\[0\]\.facing/);
      return { repairs: [{ shot_number: 1, patch: { last_frame_visuals: [{ ...planned[0].last_frame_visuals[0], facing: '侧身朝向画面右侧' }] } }] };
    });
    const result = await withTaskTrace({ name: path.join(root, 'db.sqlite') }, 'repair-test',
      () => runDirectorAgent(db, console, {}, 10, { maxReflectionRounds: 3 }));
    assert.equal(repairs.length, 2);
    assert.equal(result.total_shots, 2);
    const events = fs.readFileSync(path.join(root, result.trace_file), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(events.filter(e => e.event === 'repair_response').length, 2);
    assert.equal(events.filter(e => e.event === 'repair_rejected').length, 1);
    assert.equal(events.filter(e => e.event === 'repair_accepted').length, 1);
    assert.equal(events.find(e => e.event === 'repair_rejected').original_patch.repairs[0].patch.character_visuals[0].facing, '侧身朝向画面左侧');
    const saved = db.prepare('SELECT character_visuals,last_frame_visuals FROM storyboards WHERE episode_id=10 AND deleted_at IS NULL ORDER BY storyboard_number').get();
    assert.equal(JSON.parse(saved.character_visuals)[0].facing, planned[0].character_visuals[0].facing);
    assert.equal(JSON.parse(saved.last_frame_visuals)[0].facing, '侧身朝向画面右侧');
  });

  it('feeds the checked universal mode into Director planning and persists its Ref2VA contract', async (t) => {
    const current = db.prepare(
      'SELECT * FROM storyboards WHERE episode_id = 10 AND deleted_at IS NULL ORDER BY storyboard_number ASC'
    ).all();
    const planned = current.map((row) => {
      const characters = JSON.parse(row.characters || '[]');
      const semantic = JSON.parse(row.semantic_slots || '{}');
      return {
        ...row,
        characters,
        background_characters: JSON.parse(row.background_characters || '[]'),
        character_visuals: JSON.parse(row.character_visuals || '[]'),
        last_frame_visuals: [],
        video_slots: JSON.parse(row.video_slots || '{}'),
        semantic_slots: {
          ...semantic,
          h3_mode: 'ref2va',
          h3_mode_reason: '用户选择全能分镜，以场景和人物多参考保持一致性',
          first_frame_policy: 'none',
          first_frame_reason: '全能分镜直接使用多参考，不生成首帧',
          last_frame_policy: 'none',
          last_frame_reason: 'Ref2VA 不生成尾帧',
          required_references: [
            { type: 'scene', id: Number(row.scene_id), name: '废弃工厂内部战斗区' },
            ...characters.map((id) => ({ type: 'character', id: Number(id) })),
          ],
        },
        props: db.prepare('SELECT prop_id FROM storyboard_props WHERE storyboard_id=? ORDER BY prop_id')
          .all(row.id).map((item) => item.prop_id),
        creation_mode: 'universal',
        universal_segment_text: `画面风格和类型: 真人写实, 电影风格, 高清画质\n生成一个由以下1个分镜组成的视频。\n环境参考 @图片1，人物参考 @图片2。\n分镜1： ${row.duration}秒: @图片2 完成本镜动作。`,
      };
    });
    let sawUniversalPlanningContract = false;
    t.mock.method(agentsRuntime, 'runAgent', async (...args) => {
      if(args[2]?.name === 'director-episode-pacing') return {feasible:true,reason:'沿用剧情任务',shots:planned.map(s=>({duration:s.duration,purpose:s.title}))};
      sawUniversalPlanningContract = String(args[2]?.instructions || '').includes('用户已勾选全能分镜模式');
      return { storyboards: planned };
    });

    const result = await runDirectorAgent(db, console, {}, 10, { universal_omni_storyboard: true });
    assert.equal(result.planning_mode, 'universal');
    assert.equal(sawUniversalPlanningContract, true);

    const rows = db.prepare(
      'SELECT creation_mode, universal_segment_text, semantic_slots FROM storyboards WHERE episode_id=10 AND deleted_at IS NULL ORDER BY storyboard_number'
    ).all();
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.creation_mode, 'universal');
      assert.match(row.universal_segment_text, /@图片1/);
      const slots = JSON.parse(row.semantic_slots);
      assert.equal(slots.h3_mode, 'ref2va');
      assert.equal(slots.first_frame_policy, 'none');
      assert.equal(slots.required_references[0].type, 'scene');
    }
  });

  it('resumes a persisted mid-batch failure after reopening SQLite without regenerating completed stages', async t => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const cp = require('../src/services/directorCheckpoint');
    const tasks = require('../src/services/taskService');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'director-resume-'));
    const file = path.join(dir, 'test.db');
    await db.backup(file);
    let connection = new Database(file);
    t.after(() => { connection?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const planned = connection.prepare('SELECT * FROM storyboards WHERE episode_id=10 AND deleted_at IS NULL ORDER BY storyboard_number').all().map(row => ({
      ...row, shot_number: row.storyboard_number,
      characters: JSON.parse(row.characters), background_characters: JSON.parse(row.background_characters || '[]'),
      props: connection.prepare('SELECT prop_id FROM storyboard_props WHERE storyboard_id=?').all(row.id).map(r => r.prop_id),
      character_visuals: JSON.parse(row.character_visuals), last_frame_visuals: JSON.parse(row.last_frame_visuals),
      semantic_slots: JSON.parse(row.semantic_slots), video_slots: JSON.parse(row.video_slots),
    }));
    const before = connection.prepare('SELECT id FROM storyboards WHERE deleted_at IS NULL').all();
    let resume = false;
    const calls = [];
    t.mock.method(agentsRuntime, 'runAgent', async (_db, _log, opts) => {
      calls.push(opts.name);
      if (resume) {
        assert.equal(opts.name, 'director-video-slots-planner', 'completed planning and draft must not run again');
        return { video_slots: planned[1].video_slots };
      }
      if (opts.name === 'director-episode-pacing') return { feasible: true, reason: '测试', shots: planned.map(s => ({ duration: s.duration, purpose: s.action })) };
      if (opts.name === 'director-storyboard-draft') {
        const result = structuredClone(planned); result[1].video_slots = null;
        return { storyboards: result };
      }
      throw new Error('模拟第二镜视频槽位网络中断');
    });
    const first = tasks.createTask(connection, console, 'director_storyboard_generation', '10');
    const options = { taskId: first.id, maxReflectionRounds: 1, universal_omni_storyboard: true };
    await assert.rejects(runDirectorAgent(connection, console, {}, 10, options), /模拟第二镜/);
    tasks.updateTaskError(connection, first.id, '模拟服务中断');
    assert.deepEqual(connection.prepare('SELECT id FROM storyboards WHERE deleted_at IS NULL').all(), before);
    const saved = cp.read(connection, first.id);
    assert.ok(saved.state.pacingPlan);
    assert.equal(saved.state.batchShots.length, 2);
    assert.deepEqual(saved.state.batchShots[0].video_slots, planned[0].video_slots);
    assert.equal(tasks.getTask(connection, first.id).checkpoint.available, true);
    assert.throws(() => cp.requireResume(connection, first.id, 11, {}), /当前集/);
    connection.prepare('UPDATE episodes SET script_content=script_content||? WHERE id=10').run('改动');
    assert.throws(() => cp.requireResume(connection, first.id, 10, {}), /剧本.*已变化/);
    connection.prepare('UPDATE episodes SET script_content=? WHERE id=10').run(db.prepare('SELECT script_content FROM episodes WHERE id=10').get().script_content);
    connection.close(); connection = new Database(file);
    resume = true; calls.length = 0;
    const next = tasks.createTask(connection, console, 'director_storyboard_generation', '10');
    const result = await runDirectorAgent(connection, console, {}, 10, { ...cp.requireResume(connection, first.id, 10, {}).options, taskId: next.id, resume_task_id: first.id });
    assert.equal(result.total_shots, 2);
    assert.deepEqual(calls, ['director-video-slots-planner']);
    assert.equal(cp.summary(connection, next.id).available, false);
    tasks.updateTaskError(connection, next.id, '模拟发布后状态写入前崩溃');
    assert.throws(() => cp.requireResume(connection, next.id, 10, {}), /已经发布/);
    assert.throws(() => cp.requireResume(connection, first.id, 10, {}), /已发布分镜.*已变化/);
    assert.equal(connection.prepare('SELECT count(*) n FROM storyboards WHERE episode_id=10 AND deleted_at IS NULL').get().n, 2);
  });

  it('retains accepted ReAct patches across failure and resumes only the remaining violation', async t => {
    const cp = require('../src/services/directorCheckpoint');
    const tasks = require('../src/services/taskService');
    const initial = db.prepare('SELECT * FROM storyboards WHERE episode_id=10 AND deleted_at IS NULL ORDER BY storyboard_number').all().map(row => ({
      ...row, shot_number: row.storyboard_number,
      characters: JSON.parse(row.characters), background_characters: JSON.parse(row.background_characters || '[]'),
      props: db.prepare('SELECT prop_id FROM storyboard_props WHERE storyboard_id=?').all(row.id).map(r => r.prop_id),
      character_visuals: JSON.parse(row.character_visuals), last_frame_visuals: JSON.parse(row.last_frame_visuals),
      semantic_slots: JSON.parse(row.semantic_slots), video_slots: JSON.parse(row.video_slots),
    }));
    const first = tasks.createTask(db, console, 'director_storyboard_generation', '10');
    const opts = { taskId: first.id, maxReflectionRounds: 1, universal_omni_storyboard: true };
    const checkpoint = cp.open(db, first.id, 10, {}, opts);
    const damaged = structuredClone(initial);
    damaged.forEach(s => { s.character_visuals[0].facing = ''; });
    Object.assign(checkpoint.state, { pacingPlan: { total_shots: 2, total_duration: 10, shots: initial.map(s => ({ duration: s.duration, purpose: s.action })) },
      draftBatches: [{ index: 0, shot_count: 2, script_segment: '' }], nextBatch: 1, shots: damaged });
    checkpoint.save();
    tasks.updateTaskError(db, first.id, '模拟初稿完成后中断');
    let calls = 0;
    t.mock.method(agentsRuntime, 'runAgent', async (_db, _log, options) => {
      assert.equal(options.name, 'director-invariant-repair');
      calls++;
      const target = calls;
      return { repairs: [{ shot_number: target, patch: { character_visuals: initial[target - 1].character_visuals } }] };
    });
    const second = tasks.createTask(db, console, 'director_storyboard_generation', '10');
    await assert.rejects(runDirectorAgent(db, console, {}, 10, { ...opts, taskId: second.id, resume_task_id: first.id }), /仍未通过/);
    tasks.updateTaskError(db, second.id, '本轮次数用尽');
    const saved = cp.read(db, second.id).state;
    assert.deepEqual(saved.shots[0].character_visuals, initial[0].character_visuals);
    assert.equal(saved.shots[1].character_visuals[0].facing, '');
    assert.equal(saved.reflectionRound, 1);
    const third = tasks.createTask(db, console, 'director_storyboard_generation', '10');
    const result = await runDirectorAgent(db, console, {}, 10, { ...opts, taskId: third.id, resume_task_id: second.id });
    assert.equal(calls, 2);
    assert.equal(result.total_shots, 2);
    assert.equal(cp.read(db, third.id).state.reflectionRound, 2);
  });

  it('audits missing empty-scene arrays once, and accepts only the Agent-authored empty array', () => {
    const shot = require('./fixtures/director-empty-frame.json');
    const options = { directorPlanningMode: 'universal' };
    for (const value of [undefined, null, '[]']) {
      const candidate = { ...shot, character_visuals: value };
      const audit = auditDirectorDraft([candidate], options);
      assert.equal(audit.error_count, 1);
      assert.equal(audit.violations[0].rule, 'INVARIANT_REQUIRED_AGENT_SLOT_MISSING');
      assert.deepEqual(audit.violations[0].conflict_slots, ['character_visuals']);
      assert.equal(candidate.character_visuals, value, 'the gate must not fill missing content');
    }
    assert.equal(auditDirectorDraft([{ ...shot, character_visuals: [] }], options).valid, true);
    const longShot = { ...shot, character_visuals: [], duration: 6 };
    const limited = auditDirectorDraft([longShot], { ...options, requestedPacing: { range: { min: 4, max: 5 } } });
    assert.ok(limited.violations.some(v => v.rule === 'INVARIANT_DIRECTOR_DURATION_RANGE'));
  });

  it('resumes an empty-scene final-gate failure through Agent repair without regenerating the episode', async t => {
    const cp = require('../src/services/directorCheckpoint');
    const tasks = require('../src/services/taskService');
    // Isolate this publication from the other shared episode fixtures.
    db.exec("INSERT INTO episodes(id,drama_id,episode_number,title,duration,script_content) VALUES(11,1,2,'无人镜头测试',1,'游戏画面暗下。')");
    const shot = structuredClone(require('./fixtures/director-empty-frame.json'));
    const original = structuredClone(shot);
    const first = tasks.createTask(db, console, 'director_storyboard_generation', '11');
    const opts = { taskId: first.id, maxReflectionRounds: 2, universal_omni_storyboard: true, shot_duration_range: { min: 4, max: 8 } };
    const checkpoint = cp.open(db, first.id, 11, {}, opts);
    Object.assign(checkpoint.state, { pacingPlan: { total_shots: 1, total_duration: 4, shots: [{ duration: 4, purpose: '画面暗下' }] },
      draftBatches: [{ index: 0, shot_count: 1, script_segment: '游戏画面暗下。' }], nextBatch: 1, shots: [shot] });
    checkpoint.save();
    tasks.updateTaskError(db, first.id, '最终检查缺少人物数组');
    const calls = [];
    t.mock.method(agentsRuntime, 'runAgent', async (_db, _log, options) => {
      calls.push(options.name);
      assert.equal(options.name, 'director-invariant-repair');
      assert.match(options.input, /character_visuals/);
      assert.deepEqual(Object.keys(options.outputType.schema.properties.repairs.prefixItems[0].properties.patch.properties), ['character_visuals']);
      return { repairs: [{ shot_number: 1, patch: { character_visuals: [] } }] };
    });
    const next = tasks.createTask(db, console, 'director_storyboard_generation', '11');
    const result = await runDirectorAgent(db, console, {}, 11, { ...opts, taskId: next.id, resume_task_id: first.id });
    assert.deepEqual(calls, ['director-invariant-repair']);
    assert.equal(result.audit.valid, true);
    assert.equal(result.total_shots, 1);
    assert.equal(cp.read(db, next.id).state.published, true);
    assert.deepEqual(cp.read(db, next.id).state.shots[0], { ...original, character_visuals: [] });
    assert.equal(db.prepare('SELECT character_visuals FROM storyboards WHERE episode_id=11 AND deleted_at IS NULL').get().character_visuals, '[]');

    // A fresh draft must ask the visual planner for [] before reaching ReAct.
    calls.length = 0;
    t.mock.method(agentsRuntime, 'runAgent', async (_db, _log, options) => {
      calls.push(options.name);
      if (options.name === 'director-episode-pacing') return { feasible: true, reason: '一个转场镜头', shots: [{ duration: 4, purpose: '画面暗下' }] };
      if (options.name === 'director-storyboard-draft') return { storyboards: [structuredClone(original)] };
      assert.equal(options.name, 'director-character-visuals-planner');
      return { character_visuals: [], last_frame_visuals: [] };
    });
    await runDirectorAgent(db, console, {}, 11, { universal_omni_storyboard: true, maxReflectionRounds: 1 });
    assert.deepEqual(calls, ['director-episode-pacing', 'director-storyboard-draft', 'director-character-visuals-planner']);
  });

  it('manual capacity conflicts and Director advice leave existing storyboards intact', async t => {
    const before = db.prepare('SELECT * FROM storyboards ORDER BY id').all();
    let calls = 0;
    t.mock.method(agentsRuntime, 'runAgent', async (_db, _log, options) => {
      calls++;
      assert.equal(options.name, 'director-episode-pacing');
      return {feasible:false, reason:'一个镜头无法完整表达换弹和撤离及对白', shots:[{duration:5,purpose:'换弹'},{duration:4,purpose:'撤离'}]};
    });
    await assert.rejects(runDirectorAgent(db, console, {}, 10, {storyboard_count:1,video_duration:100}), /无法同时满足/);
    assert.equal(calls,0);
    await assert.rejects(runDirectorAgent(db, console, {}, 10, {storyboard_count:1}), /建议 2 镜、共 9 秒/);
    assert.equal(calls,1);
    assert.deepEqual(db.prepare('SELECT * FROM storyboards ORDER BY id').all(), before);
  });

  it('rebuildPromptsForStoryboard rejects legacy rows that lack Agent-owned semantic slots', () => {
    // Insert a blank legacy row with null prompts
    const info = db.prepare(`
      INSERT INTO storyboards (
        episode_id, scene_id, storyboard_number, title, description, location, time, duration,
        action, dialogue, movement, shot_type, status, created_at, updated_at
      ) VALUES (
        10, 100, 3, '老旧镜头', '无提示词历史分镜', '废弃工厂内部战斗区', '黄昏', 5,
        '红狼抬头看向高台敌军火力点', '', 'tilt', '仰拍全景', 'pending', '2026-01-01', '2026-01-01'
      )
    `).run();
    const blankId = info.lastInsertRowid;

    let row = db.prepare('SELECT * FROM storyboards WHERE id = ?').get(blankId);
    assert.equal(row.image_prompt, null);
    assert.equal(row.video_prompt, null);

    assert.throws(
      () => rebuildPromptsForStoryboard(db, console, blankId),
      (err) => err.status === 422 && err.violations.some((v) => v.rule === 'INVARIANT_CHARACTER_VISUAL_SLOTS_REQUIRED')
    );

    row = db.prepare('SELECT * FROM storyboards WHERE id = ?').get(blankId);
    assert.equal(row.image_prompt, null, 'Rejected rows must remain unchanged');
    assert.equal(row.video_prompt, null, 'Rejected rows must remain unchanged');
  });

  it('transforms dynamic video actions into concrete static freeze-frame poses without truncation', () => {
    // Case 1: Shot 21 bug (previously truncated to '奕辰身体')
    const pose21 = extractStaticFreezeFramePose('奕辰身体继续前倾，目光不离屏幕，手指快速敲击键盘；丽霞站在他身后半步处。');
    assert.ok(!pose21.includes('奕辰身体，'), 'Must not truncate to bare noun');
    assert.match(pose21, /上身前倾坐在书桌前/);
    assert.match(pose21, /双手手指搭在键盘按键上/);
    assert.match(pose21, /双眼专注凝视正前方屏幕/);

    // Case 2: Shot 17 bug (temporal glance action)
    const pose17 = extractStaticFreezeFramePose('红狼靠住断墙，快速向右侧岔路看了一眼');
    assert.ok(!pose17.includes('看了一眼'), 'Must not use temporal glance verb');
    assert.match(pose17, /目光警惕专注地注视着右侧岔路/);

    // Case 3: Shot 15 bug (abstract balance losing)
    const pose15 = extractStaticFreezeFramePose('蜂医身体失去平衡，前倾摔向断墙外侧地面。');
    assert.match(pose15, /身体大幅.*倾斜失衡/);
    assert.match(pose15, /单手.*撑向地面/);
    assert.match(pose15, /定格瞬间/);

    // Case 4: Shot 10 bug (previously truncated to '露娜')
    const pose10 = extractStaticFreezeFramePose('露娜向前跨一步挡住红狼半条行进路线，抬手指向黑暗厂房内部。');
    assert.notEqual(pose10, '露娜');
    assert.match(pose10, /侧身跨步停在红狼身前挡住路线/);
    assert.match(pose10, /单臂抬起直指黑暗厂房内部/);

    // Case 5: Shot 8 bug (video walking and sequence action)
    const pose8 = extractStaticFreezeFramePose('蜂医沿掩体后方走到露娜右侧，按下露娜准备起身的肩膀，两人保持低姿态。');
    assert.ok(!pose8.includes('走到'), 'Must not describe walking process');
    assert.match(pose8, /半蹲停在露娜旁/);
    assert.match(pose8, /单手按在露娜肩头/);
    assert.match(pose8, /维持低姿隐蔽警戒/);
  });

  it('detects flawed prompts and rebuildPromptsForStoryboard repairs them with static freeze-frame poses', () => {
    assert.equal(isFlawedImagePrompt('废弃工厂内部战斗区，夜晚，特写·平视·前左，奕辰身体，photorealistic，首帧静止画面'), true);
    assert.equal(isFlawedImagePrompt('废弃工厂外围，阴天，中景·平视·前左，露娜，photorealistic，首帧静止画面'), true);
    assert.equal(isFlawedImagePrompt('废弃工厂内部战斗区，阴天，特写·平视·正面，红狼靠住断墙，快速向右侧岔路看了一眼，photorealistic，首帧静止画面'), true);
    assert.equal(isFlawedImagePrompt('废弃工厂内部战斗区，阴天，中景·平视·正面，蜂医沿掩体后方走到露娜右侧，按下露娜准备起身的肩膀，两人保持低姿态，photorealistic，首帧静止画面'), true);

    // Insert flawed row into DB
    const info = db.prepare(`
      INSERT INTO storyboards (
        episode_id, scene_id, storyboard_number, title, location, time, duration,
        action, shot_type, angle_h, angle_v, angle_s,
        image_prompt, polished_prompt, character_visuals, video_slots, status, created_at, updated_at
      ) VALUES (
        10, 100, 4, '书桌前倾', '双人书房·书桌区', '夜晚', 5,
        '奕辰身体继续前倾，目光不离屏幕，手指快速敲击键盘；丽霞站在他身后半步处。',
        '特写', 'front_left', 'eye_level', 'close_up',
        '双人书房·书桌区，夜晚，特写·平视·前左，奕辰身体，photorealistic, ultra-detailed，首帧静止画面',
        '双人书房·书桌区，夜晚，特写·平视·前左，奕辰身体，photorealistic, ultra-detailed，首帧静止画面',
        ?, ?,
        'pending', '2026-01-01', '2026-01-01'
      )
    `).run(
      JSON.stringify([{
        character_id: 1,
        name: '奕辰',
        depth_layer: 'midground',
        screen_position: '画面左侧中景',
        environmental_anchor: '书桌前',
        facing: '四分之三侧身面朝屏幕',
        head_pose: '头部微低朝向屏幕',
        gaze: '双眼专注凝视正前方屏幕',
        posture: '上身前倾坐在书桌前',
        hands: '双手手指搭在键盘按键上',
        appearance_details: '居家服装',
        prop_interaction: '双手接触键盘',
      }]),
      JSON.stringify(videoSlots({ characterId: 1, characterName: '奕辰', movement: 'push' }))
    );
    const flawedId = info.lastInsertRowid;

    rebuildPromptsForStoryboard(db, console, flawedId);

    const repaired = db.prepare('SELECT image_prompt, polished_prompt FROM storyboards WHERE id = ?').get(flawedId);
    assert.ok(!repaired.image_prompt.includes('，奕辰身体，'), 'Must repair bare noun in image_prompt');
    assert.match(repaired.image_prompt, /上身前倾坐在书桌前/);
    assert.match(repaired.image_prompt, /双手手指搭在键盘按键上/);
    assert.match(repaired.polished_prompt, /上身前倾坐在书桌前/);
  });
});
