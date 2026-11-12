const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  CrossSlotInvariantsRule,
  checkCrossSlotInvariants,
} = require('../src/ontology/rules/crossSlotRules');
const { defaultEngine } = require('../src/ontology/invariants');
const { resolveH3Mode } = require('../src/services/h3ModeResolver');
const { auditGeneratedVideo, probeVideoMetadata } = require('../src/services/videoQualityGate');
const { compilePrompt } = require('../src/services/h3NativeService');
const {
  createSemanticSlots,
  IDENTITY_VISIBILITIES,
  CONTINUITY_TYPES,
  FIRST_FRAME_POLICIES,
  LAST_FRAME_POLICIES,
  AUDIO_LIP_SYNC_MODES,
} = require('../src/ontology/schema');

describe('Three-Tier Architectural Evolution: Agent First, Ontology Gatekeeper, Execution Compiler', () => {
  describe('Tier 1 & 2: 12 Cross-Slot Invariant Gatekeeper Rules', () => {
    it('Rule 1: Rejects offscreen dialogue with in-frame lip-sync (画外说话人与画内口型冲突)', () => {
      const shot = {
        shot_number: 1,
        dialogue: '长官，雷达有反应！',
        semantic_slots: {
          audio_lip_sync: AUDIO_LIP_SYNC_MODES.IN_FRAME_DIALOGUE,
          speech_plan: {
            speaker_name: '副官',
            is_offscreen: true,
            text: '长官，雷达有反应！',
          },
        },
      };
      const violations = checkCrossSlotInvariants([shot]);
      const v = violations.find(x => x.rule === 'INVARIANT_OFFSCREEN_SPEECH_LIP_SYNC_CONFLICT');
      assert.ok(v, 'Should detect offscreen lip-sync conflict');
      assert.equal(v.severity, 'error');
    });

    it('Rule 2: Rejects narration speaker conflicts (旁白被标成画内说话人)', () => {
      const shot = {
        shot_number: 2,
        semantic_slots: {
          speech_plan: {
            speaker_id: 101,
            speaker_name: '萧战',
            is_narration: true,
            text: '边疆的风雪从未停歇。',
          },
        },
      };
      const violations = checkCrossSlotInvariants([shot]);
      const v = violations.find(x => x.rule === 'INVARIANT_NARRATION_SPEAKER_CONFLICT');
      assert.ok(v, 'Should detect narration speaker conflict');
    });

    it('Rule 3: Rejects silent shot audio conflicts (静音镜头包含对白或音效)', () => {
      const shot = {
        shot_number: 3,
        semantic_slots: {
          sound_plan: {
            is_silent: true,
            sound_effects: ['爆炸巨响'],
          },
          speech_plan: {
            text: '不要说话！',
          },
        },
      };
      const violations = checkCrossSlotInvariants([shot]);
      const v = violations.find(x => x.rule === 'INVARIANT_SILENT_SHOT_AUDIO_CONFLICT');
      assert.ok(v, 'Should detect silent shot audio conflict');
    });

    it('distinguishes ambient-only, music-only, and complete-silence contracts', () => {
      const ambient = {
        shot_number: 31,
        dialogue: '',
        narration: '',
        sound_effect: '急促脚步声',
        semantic_slots: {
          audio_lip_sync: 'silent_ambient',
          speech_plan: { text: '' },
          sound_plan: { is_silent: false, sound_effects: ['急促脚步声'], bgm_prompt: '' },
        },
        video_slots: {
          audio_lip_sync: { mode: 'silent_ambient', dialogue_content: '' },
          trajectories: [{ character_id: 1, name: '红狼', mouth_state: 'closed' }],
          shots_timeline: [{ character_trajectories: [{ character_id: 1, name: '红狼', mouth_state: 'closed' }] }],
        },
      };
      const ambientViolations = checkCrossSlotInvariants([ambient]);
      assert.equal(ambientViolations.some((v) => /NONVERBAL|AMBIENT_ONLY|SILENT_SHOT/.test(v.rule)), false, JSON.stringify(ambientViolations));

      const unsealed = structuredClone(ambient);
      unsealed.video_slots.shots_timeline[0].character_trajectories[0].mouth_state = '自然张嘴';
      assert.ok(checkCrossSlotInvariants([unsealed]).some((v) => v.rule === 'INVARIANT_NONVERBAL_MOUTH_NOT_SEALED'));

      const musicWithSfx = structuredClone(ambient);
      musicWithSfx.semantic_slots.audio_lip_sync = 'bgm_only';
      musicWithSfx.semantic_slots.sound_plan = { is_silent: false, sound_effects: ['脚步声'], bgm_prompt: '纯器乐鼓点' };
      assert.ok(checkCrossSlotInvariants([musicWithSfx]).some((v) => v.rule === 'INVARIANT_BGM_ONLY_SFX_CONFLICT'));
    });

    it('Rule 4: Rejects dual-role character conflicts (同一角色同时为主体与背景人物)', () => {
      const shot = {
        shot_number: 4,
        semantic_slots: {
          visible_characters: [{ id: 1, name: '苏凤仪' }],
          background_characters: [{ id: 1, name: '苏凤仪' }],
        },
      };
      const violations = checkCrossSlotInvariants([shot]);
      const v = violations.find(x => x.rule === 'INVARIANT_CHARACTER_DUAL_ROLE_CONFLICT');
      assert.ok(v, 'Should detect dual-role character conflict');
    });

    it('Rule 5: Rejects framing vs character count mismatches (构图人数与实际在场人数不一致)', () => {
      const shot = {
        shot_number: 5,
        dialogue_framing: 'two_shot_face_to_face',
        semantic_slots: {
          visible_characters: [{ id: 1, name: '苏凤仪' }], // 只有 1 人，但是双人面对面构图
        },
      };
      const violations = checkCrossSlotInvariants([shot]);
      const v = violations.find(x => x.rule === 'INVARIANT_FRAMING_CHARACTER_COUNT_MISMATCH');
      assert.ok(v, 'Should detect framing count mismatch');
    });

    it('Rule 6: Rejects identity visibility vs back-view / silhouette conflicts (清晰正脸与背影/剪影冲突)', () => {
      const shot = {
        shot_number: 6,
        character_visuals: [
          { name: '洪浪', facing: 'away_from_camera' },
        ],
        semantic_slots: {
          identity_visibility: IDENTITY_VISIBILITIES.CLEAR_FRONTAL,
          visible_characters: [{ name: '洪浪' }],
        },
      };
      const violations = checkCrossSlotInvariants([shot]);
      const v = violations.find(x => x.rule === 'INVARIANT_IDENTITY_VISIBILITY_FACING_CONFLICT');
      assert.ok(v, 'Should detect visibility vs facing conflict');
    });

    it('Rule 7: Rejects multiple wardrobes in same shot for same character (同一角色单镜多套服装)', () => {
      const shot = {
        shot_number: 7,
        semantic_slots: {
          required_references: [
            { type: 'costume', id: 1, name: '苏凤仪_战袍A' },
            { type: 'costume', id: 1, name: '苏凤仪_便服B' },
          ],
        },
      };
      const violations = checkCrossSlotInvariants([shot]);
      const v = violations.find(x => x.rule === 'INVARIANT_SAME_SHOT_MULTIPLE_WARDROBES');
      assert.ok(v, 'Should detect multiple wardrobes conflict');
    });

    it('Rule 8: Rejects tail frame reuse across different scenes or times (跨场景/时间跨度复用尾帧)', () => {
      const prev = {
        shot_number: 7,
        scene_id: 1,
        time: '清晨',
      };
      const shot = {
        shot_number: 8,
        scene_id: 2, // 跨越场景
        time: '深夜',
        semantic_slots: {
          first_frame_policy: FIRST_FRAME_POLICIES.INHERIT_TAIL,
        },
      };
      const violations = checkCrossSlotInvariants([prev, shot]);
      const v = violations.find(x => x.rule === 'INVARIANT_CONTINUOUS_TAIL_MISMATCH');
      assert.ok(v, 'Should detect tail reuse across different scenes');
    });

    it('requires every long-dialogue continuation to use the immediately previous real tail through FL2VA', () => {
      const head = {
        shot_number: 20,
        scene_id: 1,
        time: '夜',
        long_take_group_id: 'speech_20',
        long_take_role: 'head',
        long_take_sequence: 1,
        semantic_slots: {
          h3_mode: 'ref2va',
          first_frame_policy: 'none',
          last_frame_policy: 'none',
          continuity_type: 'continuation',
          required_references: [{ type: 'character', id: 1 }],
          speech_plan: { audio_references: [] },
        },
      };
      const validContinuation = {
        shot_number: 21,
        scene_id: 1,
        time: '夜',
        long_take_group_id: 'speech_20',
        long_take_role: 'tail',
        long_take_sequence: 2,
        semantic_slots: {
          h3_mode: 'fl2va',
          first_frame_policy: 'inherit_tail',
          last_frame_policy: 'none',
          continuity_type: 'long_take_continuation',
          required_references: [],
          speech_plan: { audio_references: [] },
        },
      };
      const valid = checkCrossSlotInvariants([head, validContinuation]);
      assert.equal(valid.some((v) => v.rule.startsWith('INVARIANT_LONG_TAKE_')), false, JSON.stringify(valid));

      const invalid = structuredClone(validContinuation);
      invalid.semantic_slots.h3_mode = 'ref2va';
      invalid.semantic_slots.first_frame_policy = 'none';
      invalid.long_take_sequence = 3;
      const violations = checkCrossSlotInvariants([head, invalid]);
      assert.ok(violations.some((v) => v.rule === 'INVARIANT_LONG_TAKE_PREDECESSOR_MISSING'));
      assert.ok(violations.some((v) => v.rule === 'INVARIANT_LONG_TAKE_CONTINUATION_EXECUTION_CONFLICT'));
    });

    it('Rule 9: Rejects mid-shot wardrobe mutation (单镜包含换装变身描写)', () => {
      const shot = {
        shot_number: 9,
        action: '苏凤仪突然换上一身黑色劲装，迅速拔剑迎战',
        semantic_slots: {},
      };
      const violations = checkCrossSlotInvariants([shot]);
      const v = violations.find(x => x.rule === 'INVARIANT_MID_SHOT_WARDROBE_MUTATION');
      assert.ok(v, 'Should detect mid-shot wardrobe change');
    });

    it('Rule 10: Rejects reference capacity exceeded >9 images or >3 audios (素材超限严禁静默截断)', () => {
      const shot = {
        shot_number: 10,
        semantic_slots: {
          required_references: new Array(10).fill(0).map((_, i) => ({ type: 'character', id: i + 1 })),
          speech_plan: {
            audio_references: ['a1.wav', 'a2.wav', 'a3.wav', 'a4.wav'],
          },
        },
      };
      const violations = checkCrossSlotInvariants([shot]);
      const vImg = violations.find(x => x.rule === 'INVARIANT_REFERENCE_CAPACITY_EXCEEDED');
      assert.ok(vImg, 'Should detect image references capacity exceeded');
    });

    it('Rule 11: Rejects dangling <Picture N> tags without corresponding inputs (编号悬空冲突)', () => {
      const shot = {
        shot_number: 11,
        video_prompt: '摄影机聚焦于 <Picture 3> 中的神秘卷轴',
        semantic_slots: {
          required_references: [{ type: 'scene', name: '边关' }], // 只有 1 张参考图，但引用了 <Picture 3>
        },
      };
      const violations = checkCrossSlotInvariants([shot]);
      const v = violations.find(x => x.rule === 'INVARIANT_PICTURE_TAG_DANGLING');
      assert.ok(v, 'Should detect dangling picture tag');
    });

    it('Rule 12: Rejects FL2VA reference contamination (纯FL2VA请求混入Ref2VA专属多参考)', () => {
      const shot = {
        shot_number: 12,
        h3_mode: 'fl2va',
        semantic_slots: {
          required_references: [{ type: 'character', id: 1, name: '苏凤仪' }],
        },
      };
      const violations = checkCrossSlotInvariants([shot]);
      const v = violations.find(x => x.rule === 'INVARIANT_FL2VA_REF_CONTAMINATION');
      assert.ok(v, 'Should detect FL2VA reference contamination');
    });

    it('Rule 13: Rejects Ref2VA shot when both required_references and audio_references are empty', () => {
      const emptyRefShot = {
        shot_number: 13,
        scene_id: 38,
        semantic_slots: {
          h3_mode: 'ref2va',
          first_frame_policy: 'none',
          last_frame_policy: 'none',
          required_references: [],
          speech_plan: { audio_references: [] },
        },
      };
      const violations = checkCrossSlotInvariants([emptyRefShot]);
      assert.ok(
        violations.some((v) => v.rule === 'INVARIANT_REF2VA_REFERENCE_REQUIRED'),
        'CrossSlotInvariantsRule must reject Ref2VA with empty visual & audio references before persistence'
      );

      emptyRefShot.semantic_slots.required_references = [{ type: 'scene', id: 38, name: '工厂' }];
      assert.equal(
        checkCrossSlotInvariants([emptyRefShot]).some((v) => v.rule === 'INVARIANT_REF2VA_REFERENCE_REQUIRED'),
        false
      );
    });

    it('rejects multiple speaker turns in one outer shot and requires an Agent split', () => {
      const shot = {
        shot_number: 13,
        dialogue: '红狼：哪条是备用路线？露娜：简报第三项写得很清楚！',
        characters: [1, 2],
        background_characters: [],
        character_visuals: [{ character_id: 1 }, { character_id: 2 }],
        semantic_slots: {
          visible_characters: [{ id: 1, name: '红狼' }, { id: 2, name: '露娜' }],
          background_characters: [],
          speech_plan: { speaker_id: 1, speaker_name: '红狼', text: '哪条是备用路线？' },
        },
        video_slots: {
          audio_lip_sync: { speaker_name: '红狼', dialogue_content: '哪条是备用路线？' },
        },
      };
      const violations = checkCrossSlotInvariants([shot]);
      assert.ok(violations.some((v) => v.rule === 'INVARIANT_MULTI_SPEAKER_SHOT'));
      assert.ok(violations.some((v) => v.rule === 'INVARIANT_SPEECH_SLOT_DIVERGENCE'));
    });

    it('rejects a missing video speech field instead of silently choosing another authority', () => {
      const shot = {
        shot_number: 14,
        dialogue: '露娜：控制室撑不了多久。',
        characters: [2],
        background_characters: [],
        character_visuals: [{ character_id: 2 }],
        semantic_slots: {
          visible_characters: [{ id: 2, name: '露娜' }],
          background_characters: [],
          speech_plan: { speaker_id: 2, speaker_name: '露娜', text: '控制室撑不了多久。' },
        },
        video_slots: { audio_lip_sync: { speaker_name: '露娜', dialogue_content: '' } },
      };
      const violations = checkCrossSlotInvariants([shot]);
      assert.ok(violations.some((v) => v.rule === 'INVARIANT_SPEECH_SLOT_DIVERGENCE'));
    });

    it('Zero violations when semantic slots strictly adhere to all invariants', () => {
      const validShot = {
        shot_number: 1,
        scene_id: 1,
        time: '黄昏',
        dialogue: '苏凤仪：谁在那里？出来！',
        action: '苏凤仪警惕地拔出长剑，注视前方风雪',
        characters: [1],
        background_characters: [],
        character_visuals: [{ character_id: 1, name: '苏凤仪' }],
        semantic_slots: createSemanticSlots({
          visible_characters: [{ id: 1, name: '苏凤仪' }],
          identity_visibility: IDENTITY_VISIBILITIES.THREE_QUARTER,
          speech_plan: {
            speaker_id: 1,
            speaker_name: '苏凤仪',
            is_offscreen: false,
            is_narration: false,
            text: '谁在那里？出来！',
          },
          sound_plan: {
            is_silent: false,
            sound_effects: ['寒风呼啸'],
          },
          required_references: [
            { type: 'character', id: 1, name: '苏凤仪' },
            { type: 'scene', id: 1, name: '边关雪原' },
          ],
          h3_mode: 'ref2va',
          h3_mode_reason: '人物与场景一致性优先',
          first_frame_policy: FIRST_FRAME_POLICIES.NONE,
          first_frame_reason: '多参考已足够',
          last_frame_policy: LAST_FRAME_POLICIES.NONE,
          last_frame_reason: '自然收束',
          audio_lip_sync: AUDIO_LIP_SYNC_MODES.IN_FRAME_DIALOGUE,
          shot_duration: 5,
        }),
        video_slots: {
          audio_lip_sync: {
            speaker_name: '苏凤仪',
            dialogue_content: '谁在那里？出来！',
          },
        },
      };
      const violations = checkCrossSlotInvariants([validShot]);
      assert.equal(violations.length, 0, `Expected 0 violations, got ${JSON.stringify(violations)}`);
    });

    it('accepts equivalent character contracts loaded from SQLite JSON text', () => {
      const semanticSlots = createSemanticSlots({
        visible_characters: [{ id: 29, name: '苏承远' }, { id: 30, name: '沈清岚' }],
        background_characters: [{ character_id: 31, name: '苏砚' }],
        identity_visibility: IDENTITY_VISIBILITIES.THREE_QUARTER,
        speech_plan: { text: '' },
        sound_plan: { is_silent: false, sound_effects: ['风声'] },
        h3_mode: 'ref2va',
        h3_mode_reason: '三名人物身份一致性优先',
        first_frame_policy: FIRST_FRAME_POLICIES.NONE,
        first_frame_reason: '使用人物参考',
        last_frame_policy: LAST_FRAME_POLICIES.NONE,
        last_frame_reason: '自然收束',
        required_references: [
          { type: 'character', id: 29 },
          { type: 'character', id: 30 },
          { type: 'character', id: 31 },
        ],
        audio_lip_sync: 'silent_ambient',
        shot_duration: 5,
      });
      const shot = {
        shot_number: 2,
        characters: JSON.stringify([29, 30]),
        background_characters: JSON.stringify([{ character_id: 31, name: '苏砚' }]),
        character_visuals: JSON.stringify([
          { character_id: 29, name: '苏承远' },
          { character_id: 30, name: '沈清岚' },
          { character_id: 31, name: '苏砚' },
        ]),
        semantic_slots: JSON.stringify(semanticSlots),
      };
      const violations = checkCrossSlotInvariants([shot]);
      assert.equal(
        violations.some(v => v.rule === 'INVARIANT_CHARACTER_SLOT_DIVERGENCE' || v.rule === 'INVARIANT_CHARACTER_VISUAL_SLOT_DIVERGENCE'),
        false,
        JSON.stringify(violations)
      );
    });

    it('treats a matching speaker label in database dialogue as formatting', () => {
      const shot = {
        shot_number: 15,
        dialogue: '露娜：简报第三项写得很清楚！',
        characters: [1],
        background_characters: [],
        character_visuals: [{ character_id: 1 }],
        semantic_slots: {
          visible_characters: [{ id: 1, name: '露娜' }],
          background_characters: [],
          speech_plan: { speaker_id: 1, speaker_name: '露娜', text: '简报第三项写得很清楚！' },
        },
        video_slots: {
          audio_lip_sync: { speaker_name: '露娜', dialogue_content: '简报第三项写得很清楚！' },
        },
      };
      const violations = checkCrossSlotInvariants([shot]);
      assert.equal(violations.filter((v) => v.rule === 'INVARIANT_SPEECH_SLOT_DIVERGENCE').length, 0);
    });

    it('preserves invalid offscreen mode in createSemanticSlots and flags it in CrossSlotInvariantsRule', () => {
      const semantic = createSemanticSlots({
        visible_characters: [{ id: 1, name: '角色甲' }],
        offscreen_characters: [{ character_id: 2, name: '角色乙', mode: 'off_screen' }],
      });
      assert.equal(semantic.offscreen_characters[0].mode, 'off_screen');
      const violations = checkCrossSlotInvariants([{ shot_number: 1, characters: [1], semantic_slots: semantic }]);
      const warn = violations.find((v) => v.rule === 'INVARIANT_OFFSCREEN_MODE_INVALID');
      assert.ok(warn);
      assert.equal(warn.severity, 'warning');
    });
  });

  describe('Tier 3: Execution Layer H3 Agent-Plan Compiler', () => {
    it('Compiles the Agent Ref2VA plan with no reference frames', () => {
      const shot = {
        storyboard_number: 1,
        speaker_id: 10,
        semantic_slots: {
          h3_mode: 'ref2va',
          h3_mode_reason: '人物身份与声音一致性优先',
          first_frame_policy: 'none',
          last_frame_policy: 'none',
          speech_plan: { speaker_id: 10, speaker_name: '苏凤仪', text: '出发！' },
          required_references: [{ type: 'character', id: 10, name: '苏凤仪' }],
        },
      };
      const plan = resolveH3Mode(shot, { characterVoices: { 10: 'voice_sufengyi.wav' } });
      assert.equal(plan.mode, 'ref2va');
      assert.equal(plan.use_first_frame_guide, false);
      assert.equal(plan.requires_first_frame, false);
      assert.ok(plan.resolution_reason.includes('人物身份与声音一致性'));
    });

    it('Resolves Ref2VA when character or scene identity consistency is required', () => {
      const shot = {
        storyboard_number: 2,
        semantic_slots: {
          h3_mode: 'ref2va',
          h3_mode_reason: '世界观多参考一致性优先',
          first_frame_policy: 'none',
          last_frame_policy: 'none',
          required_references: [
            { type: 'character', id: 10, name: '苏凤仪' },
            { type: 'scene', id: 5, name: '边塞关隘' },
          ],
        },
      };
      const plan = resolveH3Mode(shot);
      assert.equal(plan.mode, 'ref2va');
      assert.equal(plan.use_first_frame_guide, false);
      assert.ok(plan.resolution_reason.includes('世界观多参考'));
    });

    it('Resolves FL2VA for pure action shots without character/scene ref dependencies', () => {
      const shot = {
        storyboard_number: 3,
        semantic_slots: {
          h3_mode: 'fl2va',
          h3_mode_reason: '精确起幅动作优先',
          first_frame_policy: 'generate_new',
          last_frame_policy: 'none',
          required_references: [],
          speech_plan: {},
        },
      };
      const plan = resolveH3Mode(shot);
      assert.equal(plan.mode, 'fl2va');
      assert.equal(plan.use_first_frame_guide, true);
      assert.equal(plan.first_frame_as_picture_1, false);
      assert.ok(plan.resolution_reason.includes('精确起幅动作'));
    });

    it('Respects explicit manual override and records reason', () => {
      const shot = {
        storyboard_number: 4,
        semantic_slots: {
          h3_mode: 'ref2va',
          h3_mode_reason: '角色一致性优先',
          first_frame_policy: 'none',
          last_frame_policy: 'none',
          required_references: [{ type: 'character', id: 10 }],
        },
      };
      const plan = resolveH3Mode(shot, { manualModeOverride: 'fl2va' });
      assert.equal(plan.mode, 'fl2va');
      assert.equal(plan.is_manual_override, true);
      assert.ok(plan.resolution_reason.includes('人工覆盖'));
      assert.equal(plan.first_frame_policy, 'generate_new');
      assert.equal(plan.valid, true);
      assert.deepEqual(plan.references, []);
      assert.equal(plan.suppressed_agent_references.length, 1);
    });

    it('rejects a manual Ref2VA override when no visual or audio reference contract exists', () => {
      const shot = {
        storyboard_number: 5,
        semantic_slots: {
          h3_mode: 'fl2va',
          first_frame_policy: 'layout_lock',
          last_frame_policy: 'none',
          required_references: [],
          speech_plan: {},
        },
      };
      assert.throws(
        () => resolveH3Mode(shot, { manualModeOverride: 'ref2va', throwOnViolation: true }),
        /禁止以空参考冒充 Ref2VA/
      );
    });

    it('uses the visible manual reference contract when overriding FL2VA with Ref2VA', () => {
      const shot = {
        storyboard_number: 6,
        semantic_slots: {
          h3_mode: 'fl2va',
          first_frame_policy: 'layout_lock',
          last_frame_policy: 'none',
          required_references: [],
          speech_plan: {},
        },
      };
      const plan = resolveH3Mode(shot, {
        manualModeOverride: 'ref2va',
        manualReferences: [{ type: 'character', id: 10, name: '苏凤仪' }],
        throwOnViolation: true,
      });
      assert.equal(plan.mode, 'ref2va');
      assert.equal(plan.requires_first_frame, false);
      assert.equal(plan.reference_source, 'manual_ref2va_shot_contract');
      assert.deepEqual(plan.references, [{ type: 'character', id: 10, name: '苏凤仪' }]);
    });
  });

  describe('Ref2VA Picture Alignment & Zero Negative Word Pollution', () => {
    it('CompilePrompt maps <Picture 1> to first frame and aligns references strictly', () => {
      const refs = [
        { source: 'img_first.png', kind: 'first_frame', name: '首帧' },
        { source: 'char_sufengyi.png', kind: 'character', character_id: 10, name: '苏凤仪' },
      ];
      const anchors = { first: 'img_first.png' };
      const speech = {
        lines: [{ key: 'character:10', text: '我们走！', speaker: '苏凤仪', kind: 'dialogue' }],
        references: [{ key: 'character:10', kind: 'dialogue', speaker: '苏凤仪' }],
      };
      const translated = {
        visual_description: 'An expansive snowy mountain pass.',
        overall_soundscape: 'Howling wind echoing across the canyon.',
        non_diegetic_music: 'Solemn orchestral strings.',
      };

      const compiled = compilePrompt(refs, speech, translated, anchors, {});
      assert.ok(compiled.includes('<Picture 1>'), 'Must reference <Picture 1> for first frame anchor');
      assert.ok(!compiled.includes('严禁克隆'), 'Must not contain negative exclusion prose pollution');
      assert.ok(!compiled.includes('不得正面'), 'Must not contain negative exclusion prose pollution');
    });
  });

  describe('Post-Generation Quality Gate: Video Audit', () => {
    it('Flags missing video files immediately with structured violation report', async () => {
      const result = await auditGeneratedVideo('/nonexistent/path/video.mp4', { shot_number: 1 });
      assert.equal(result.passed, false);
      assert.equal(result.violations[0].check, 'file_presence');
    });

    it('Flags duration truncation when video is significantly shorter than planned', async () => {
      // Create a temporary mock file
      const fs = require('fs');
      const path = require('path');
      const tmpFile = path.join(__dirname, 'test_dummy_video.mp4');
      fs.writeFileSync(tmpFile, 'dummy content');

      try {
        // With an invalid dummy video, probe returns duration 0 / error or frame extraction fails
        const result = await auditGeneratedVideo(tmpFile, {
          shot_number: 1,
          duration: 5,
        });
        assert.equal(result.passed, false);
        assert.ok(result.violations.length > 0, 'Must produce violation for invalid video stream');
      } finally {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      }
    });
  });
});
