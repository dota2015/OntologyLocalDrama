import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import {
  DEPTH_LAYER_OPTIONS,
  SCREEN_POSITION_OPTIONS,
  FACING_OPTIONS,
  HEAD_POSE_OPTIONS,
  GAZE_TYPE_OPTIONS,
  POSTURE_OPTIONS,
  HAND_STATE_OPTIONS,
  EXPRESSION_OPTIONS,
  MOUTH_STATE_OPTIONS,
  STATE_OPTIONS,
  ACTION_OPTIONS,
  BODY_PART_OPTIONS,
  TARGET_TYPE_OPTIONS,
  DIRECTION_OPTIONS,
  CONTACT_OPTIONS,
  TRIGGER_TYPE_OPTIONS,
  normalizeCharacterVisualSlot,
  normalizeCharacterVisualList,
  normalizeCharacterTrajectorySlot,
  normalizeSpeechActionAlignment,
  normalizeVideoSlots,
  createEmptyTimelineSegment,
  buildVisualSlotsPreviewText,
  toNullablePositiveInt,
} from '../src/constants/structuredSync.js'

const require = createRequire(import.meta.url)
const actionAtoms = require('../../backend-node/src/ontology/actionAtoms.js')

const SAMPLE_EP17_SHOT1_VISUAL = {
  character_id: 26,
  name: '蜂医',
  depth_layer: 'background',
  screen_position: 'center_background',
  environmental_anchor: '背景火光区域，位于倒计时屏幕后方',
  facing: 'away_from_camera',
  facing_target_id: null,
  head_pose: 'neutral',
  gaze_type: 'none',
  gaze_target_id: null,
  gaze_target_label: '无（背对镜头撤离）',
  posture: 'walking',
  hands_state: 'relaxed',
  hands_object_id: null,
  hands_target_id: null,
  expression: 'neutral',
  expression_detail: '背影不可见面部，轮廓清晰',
  appearance_details: '深色战术作训服背影，身形在背景暖橙火光中勾勒出剪影轮廓',
}

const SAMPLE_EP17_SHOT1_VIDEO = {
  performance_contract: 'structured_sync',
  camera: { shot_type: '特写', angle_h: 'front', angle_v: 'eye_level', angle_s: 'close_up', movement: 'static', movement_description: '固定镜头' },
  timing: { duration: 5, pacing: 'tense', beats: [] },
  shots_timeline: [
    {
      shot_number: 1,
      timestamp: null,
      duration: 5,
      camera: { shot_type: '特写', movement: 'static', movement_description: '固定镜头' },
      action: '倒计时数字快速跳动直至归零，蜂医剪影在背景火光中迅速移动并消失',
      result: '倒计时数字定格在零，蜂医完全消失于火光中',
      visible_characters: [{ character_id: 26, name: '蜂医' }],
      character_trajectories: [
        {
          character_id: 26,
          name: '蜂医',
          start_state: 'standing',
          action_atom: {
            action: 'walk',
            action_detail: '在背景火光区域背对镜头迅速走出视野并消失',
            body_part: 'whole_body',
            object_id: null,
            target_type: 'event',
            target_id: null,
            target_label: '背景火光深处',
            direction: 'away_from_target',
            contact: 'ground',
          },
          result_state: 'standing',
          reaction_trigger: { type: 'none', source_id: null, source_label: '无' },
          facing: 'away_from_camera',
          facing_target_id: null,
          head_pose: 'neutral',
          gaze_type: 'none',
          gaze_target_id: null,
          gaze_target_label: '无',
          posture: 'walking',
          hands_state: 'relaxed',
          hands_object_id: null,
          hands_target_id: null,
          expression: 'neutral',
          expression_detail: '背影不可见面部',
          mouth_state: 'closed',
        },
      ],
      audio_lip_sync: {
        mode: 'narration_voiceover',
        speaker_name: '旁白',
        speaker_in_frame: false,
        dialogue_content: '定格的倒计时归零，蜂医的身影消失在火光中。',
        lip_sync_rule: '全员闭口',
      },
      speech_action_alignment: {
        mode: 'concurrent',
        speech_window: { start: 0, end: 5 },
        speaker_character_id: null,
        speaker_action_window: { start: 0, end: 5 },
        speaker_action: '',
        listener_reactions: [{ character_id: 26, action_window: { start: 0, end: 5 }, action: '持续撤离', trajectory_action: 'none' }],
        pause_reason: '',
      },
    },
  ],
}

test('frontend enum dictionaries strictly cover all backend actionAtoms values', () => {
  const valuesOf = (opts) => opts.map((o) => o.value)
  assert.deepEqual(valuesOf(FACING_OPTIONS), [...actionAtoms.FACING])
  assert.deepEqual(valuesOf(HEAD_POSE_OPTIONS), [...actionAtoms.HEAD_POSES])
  assert.deepEqual(valuesOf(GAZE_TYPE_OPTIONS), [...actionAtoms.GAZE_TYPES])
  assert.deepEqual(valuesOf(POSTURE_OPTIONS), [...actionAtoms.POSTURES])
  assert.deepEqual(valuesOf(HAND_STATE_OPTIONS), [...actionAtoms.HAND_STATES])
  assert.deepEqual(valuesOf(EXPRESSION_OPTIONS), [...actionAtoms.EXPRESSIONS])
  assert.deepEqual(valuesOf(MOUTH_STATE_OPTIONS), [...actionAtoms.MOUTH_STATES])
  assert.deepEqual(new Set(valuesOf(STATE_OPTIONS)), new Set(actionAtoms.STATES))
  assert.deepEqual(valuesOf(ACTION_OPTIONS), [...actionAtoms.ACTIONS])
  assert.deepEqual(valuesOf(BODY_PART_OPTIONS), [...actionAtoms.BODY_PARTS])
  assert.deepEqual(valuesOf(TARGET_TYPE_OPTIONS), [...actionAtoms.TARGET_TYPES])
  assert.deepEqual(valuesOf(DIRECTION_OPTIONS), [...actionAtoms.DIRECTIONS])
  assert.deepEqual(valuesOf(CONTACT_OPTIONS), [...actionAtoms.CONTACTS])
  assert.equal(new Set(valuesOf(TRIGGER_TYPE_OPTIONS)).size, actionAtoms.TRIGGER_TYPES.length)
  assert.equal(DEPTH_LAYER_OPTIONS.length, 3)
  assert.equal(SCREEN_POSITION_OPTIONS.length, 9)
})

test('normalizing visual and video slots preserves structured_sync fields, nullable IDs, and strips V1 keys', () => {
  const dirtyVisual = {
    ...SAMPLE_EP17_SHOT1_VISUAL,
    spatial_anchor: '旧字段不应保留',
    gaze: '旧视线',
    hands: '旧手部',
    head_gaze: '旧头眼',
    prop_interaction: '旧道具',
  }
  const cleanVisual = normalizeCharacterVisualSlot(dirtyVisual, 0)
  assert.deepEqual(cleanVisual, SAMPLE_EP17_SHOT1_VISUAL)
  assert.equal('spatial_anchor' in cleanVisual, false)
  assert.equal('prop_interaction' in cleanVisual, false)

  const normalizedList = normalizeCharacterVisualList([dirtyVisual])
  assert.equal(normalizedList.length, 1)
  assert.equal(normalizedList[0].gaze_target_id, null)

  const normalizedVideo = normalizeVideoSlots(SAMPLE_EP17_SHOT1_VIDEO)
  const traj = normalizedVideo.shots_timeline[0].character_trajectories[0]
  assert.equal(traj.start_state, 'standing')
  assert.equal(traj.result_state, 'standing')
  assert.equal(traj.action_atom.action, 'walk')
  assert.equal(traj.action_atom.object_id, null)
  assert.deepEqual(traj.reaction_trigger, { type: 'none', source_id: null, source_label: '无' })
  assert.equal(normalizedVideo.shots_timeline[0].speech_action_alignment.mode, 'concurrent')
  assert.equal(normalizedVideo.shots_timeline[0].speech_action_alignment.speaker_character_id, null)
  assert.equal(toNullablePositiveInt(''), null)
  assert.equal(toNullablePositiveInt('26'), 26)
})

test('buildVisualSlotsPreviewText renders Chinese descriptions from structured_sync slots', () => {
  const preview = buildVisualSlotsPreviewText({
    location: '基地控制室',
    time: '夜晚',
    environment_depth: '前景控制屏虚化，后景火光摇曳',
    shot_type: '特写',
    angle_h: 'front',
    angle_v: 'eye_level',
    depth_of_field: 'shallow',
    character_visuals: [SAMPLE_EP17_SHOT1_VISUAL],
    lighting_chiaroscuro: '暖橙火光轮廓照明',
  })
  assert.match(preview, /景深层级后景/)
  assert.match(preview, /画面中央后景/)
  assert.match(preview, /背离镜头方向/)
  assert.match(preview, /行进迈步姿态/)
  assert.match(preview, /双手放松垂落/)
  assert.match(preview, /无固定视线（无（背对镜头撤离））/)
})

test('createEmptyTimelineSegment produces clean structured_sync segment without V1 keys', () => {
  const seg = createEmptyTimelineSegment(2, '00:05.000', SAMPLE_EP17_SHOT1_VIDEO.shots_timeline[0].character_trajectories)
  assert.equal(seg.shot_number, 2)
  assert.equal(seg.timestamp, '00:05.000')
  assert.deepEqual(seg.visible_characters, [{ character_id: 26, name: '蜂医' }])
  assert.equal(seg.character_trajectories.length, 1)
  assert.equal(seg.character_trajectories[0].action_atom.action, 'walk')
  assert.equal('start_anchor' in seg.character_trajectories[0], false)
  assert.equal(normalizeSpeechActionAlignment(seg.speech_action_alignment).mode, 'none')
  assert.equal(normalizeCharacterTrajectorySlot({}, 0, 2).reaction_trigger.type, 'none')
})
