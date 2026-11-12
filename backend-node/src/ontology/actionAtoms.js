/**
 * Structured physical action contract used by the second-stage director.
 *
 * The agent chooses from these small semantic atoms.  H3 never receives the
 * JSON shape directly; videoSlots compiles it into natural language.
 */

const PERFORMANCE_CONTRACT = 'structured_sync';

const ACTIONS = Object.freeze([
  'hold', 'grasp', 'release', 'reach', 'touch', 'support', 'lift', 'push', 'pull',
  'turn', 'walk', 'run', 'crouch', 'stand_up', 'sit_down', 'fall', 'look',
  'speak', 'listen', 'react', 'use', 'point', 'block',
]);

const BODY_PARTS = Object.freeze([
  'whole_body', 'left_hand', 'right_hand', 'both_hands', 'left_arm', 'right_arm',
  'both_arms', 'head', 'eyes', 'torso', 'legs',
]);

const TARGET_TYPES = Object.freeze(['none', 'character', 'prop', 'event', 'scene']);
const DIRECTIONS = Object.freeze([
  'none', 'left', 'right', 'forward', 'backward', 'up', 'down',
  'toward_target', 'away_from_target',
]);
const CONTACTS = Object.freeze([
  'none', 'hand', 'forearm', 'both_arms', 'shoulder_back', 'upper_arm',
  'wrist', 'clothing', 'weapon_grip', 'object_surface', 'ground',
]);
const STATES = Object.freeze([
  'neutral', 'standing_alert', 'standing', 'sitting', 'lying', 'crouched',
  'walking', 'running', 'falling', 'holding', 'gripping', 'touching',
  'reaching', 'supported', 'turned_to_target', 'looking_at_target',
  'weapon_ready', 'object_on_surface', 'object_released', 'target_sitting_supported',
]);
const FACING = Object.freeze([
  'front_camera', 'back_camera', 'left_profile', 'right_profile',
  'three_quarter_left', 'three_quarter_right', 'toward_character',
  'toward_object', 'toward_event', 'away_from_camera',
]);
const HEAD_POSES = Object.freeze([
  'neutral', 'turned_left', 'turned_right', 'tilted_up', 'tilted_down',
  'turned_to_target', 'lowered', 'raised', 'recoiling',
]);
const GAZE_TYPES = Object.freeze([
  'camera', 'character', 'prop', 'event', 'scene', 'offscreen', 'ground', 'none',
]);
const POSTURES = Object.freeze([
  'standing', 'sitting', 'kneeling', 'crouching', 'lying', 'leaning',
  'walking', 'running', 'falling', 'supported',
]);
const EXPRESSIONS = Object.freeze([
  'neutral', 'focused', 'alert', 'worried', 'angry', 'surprised', 'pain',
  'fear', 'relief', 'determined', 'sad', 'confused', 'exhausted',
]);
const HAND_STATES = Object.freeze([
  'free', 'holding_object', 'reaching', 'supporting_target', 'pointing',
  'covering_mouth', 'on_surface', 'clenched', 'relaxed',
]);
const MOUTH_STATES = Object.freeze(['closed', 'speaker_synced', 'offscreen_sealed']);
const TRIGGER_TYPES = Object.freeze(['dialogue', 'character_action', 'environment_event', 'state_change', 'none']);

function enumSchema(values) {
  return { type: 'string', enum: [...values] };
}

function nullableEnumSchema(values) {
  return { anyOf: [enumSchema(values), { type: 'null' }] };
}

function nullableIntegerSchema() {
  return { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] };
}

function actionAtomSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['action', 'body_part', 'object_id', 'target_type', 'target_id', 'target_label', 'direction', 'contact'],
    properties: {
      // Core actions are recommended, but H3 scenes often need concrete
      // actions outside a small vocabulary (sit up, support a parent, pour a
      // bowl, kneel, etc.). Keep the atom shape structured while allowing a
      // natural-language detail instead of rejecting the entire shot.
      action: { anyOf: [enumSchema(ACTIONS), { type: 'string', minLength: 1, maxLength: 80 }] },
      action_detail: { type: 'string', maxLength: 240 },
      body_part: enumSchema(BODY_PARTS),
      object_id: nullableIntegerSchema(),
      target_type: enumSchema(TARGET_TYPES),
      target_id: nullableIntegerSchema(),
      target_label: { type: 'string', maxLength: 100 },
      direction: enumSchema(DIRECTIONS),
      contact: enumSchema(CONTACTS),
    },
  };
}

function reactionTriggerSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'source_id', 'source_label'],
    properties: {
      type: enumSchema(TRIGGER_TYPES),
      source_id: nullableIntegerSchema(),
      source_label: { type: 'string', maxLength: 100 },
    },
  };
}

function structuredTrajectorySchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'character_id', 'name', 'start_state', 'action_atom', 'result_state',
      'reaction_trigger', 'facing', 'facing_target_id', 'head_pose',
      'gaze_type', 'gaze_target_id', 'gaze_target_label', 'posture',
      'hands_state', 'hands_object_id', 'hands_target_id', 'expression',
      'expression_detail', 'mouth_state',
    ],
    properties: {
      character_id: { type: 'integer', minimum: 1 },
      name: { type: 'string', maxLength: 80 },
      start_state: enumSchema(STATES),
      action_atom: actionAtomSchema(),
      action_detail: { type: 'string', maxLength: 240 },
      result_state: enumSchema(STATES),
      reaction_trigger: reactionTriggerSchema(),
      facing: enumSchema(FACING),
      facing_target_id: nullableIntegerSchema(),
      head_pose: enumSchema(HEAD_POSES),
      gaze_type: enumSchema(GAZE_TYPES),
      gaze_target_id: nullableIntegerSchema(),
      gaze_target_label: { type: 'string', maxLength: 100 },
      posture: enumSchema(POSTURES),
      hands_state: enumSchema(HAND_STATES),
      hands_object_id: nullableIntegerSchema(),
      hands_target_id: nullableIntegerSchema(),
      expression: enumSchema(EXPRESSIONS),
      expression_detail: { type: 'string', maxLength: 120 },
      mouth_state: enumSchema(MOUTH_STATES),
    },
  };
}

function structuredVisualSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'character_id', 'name', 'depth_layer', 'screen_position', 'environmental_anchor',
      'facing', 'facing_target_id', 'head_pose', 'gaze_type', 'gaze_target_id',
      'gaze_target_label', 'posture', 'hands_state', 'hands_object_id',
      'hands_target_id', 'expression', 'expression_detail', 'appearance_details',
    ],
    properties: {
      character_id: { type: 'integer', minimum: 1 },
      name: { type: 'string', maxLength: 80 },
      depth_layer: enumSchema(['foreground', 'midground', 'background']),
      screen_position: enumSchema([
        'left_foreground', 'left_midground', 'left_background', 'center_foreground',
        'center_midground', 'center_background', 'right_foreground', 'right_midground',
        'right_background',
      ]),
      environmental_anchor: { type: 'string', maxLength: 160 },
      facing: enumSchema(FACING),
      facing_target_id: nullableIntegerSchema(),
      head_pose: enumSchema(HEAD_POSES),
      gaze_type: enumSchema(GAZE_TYPES),
      gaze_target_id: nullableIntegerSchema(),
      gaze_target_label: { type: 'string', maxLength: 100 },
      posture: enumSchema(POSTURES),
      hands_state: enumSchema(HAND_STATES),
      hands_object_id: nullableIntegerSchema(),
      hands_target_id: nullableIntegerSchema(),
      expression: enumSchema(EXPRESSIONS),
      expression_detail: { type: 'string', maxLength: 120 },
      appearance_details: { type: 'string', maxLength: 240 },
    },
  };
}

function isStructuredTrajectory(value) {
  return Boolean(value && value.action_atom && typeof value.action_atom === 'object');
}

function isStructuredVisual(value) {
  return Boolean(value && value.gaze_type && value.posture && value.hands_state);
}

module.exports = {
  PERFORMANCE_CONTRACT,
  ACTIONS,
  BODY_PARTS,
  TARGET_TYPES,
  DIRECTIONS,
  CONTACTS,
  STATES,
  FACING,
  HEAD_POSES,
  GAZE_TYPES,
  POSTURES,
  EXPRESSIONS,
  HAND_STATES,
  MOUTH_STATES,
  TRIGGER_TYPES,
  actionAtomSchema,
  reactionTriggerSchema,
  structuredTrajectorySchema,
  structuredVisualSchema,
  isStructuredTrajectory,
  isStructuredVisual,
};
