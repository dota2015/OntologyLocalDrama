'use strict';

const VERSION = 'h3_contract_v1';

function parse(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

/** Build the single persisted contract used by the H3 submitter and UI. */
function buildH3Contract(shot, options = {}) {
  const semantic = parse(shot?.semantic_slots, {}) || {};
  const video = parse(shot?.video_slots, {}) || {};
  const characterVisuals = parse(shot?.character_visuals, []) || [];
  const lastFrameVisuals = parse(shot?.last_frame_visuals, []) || [];
  const contract = {
    version: VERSION,
    storyboard_id: Number(shot?.id || 0) || null,
    shot_number: Number(shot?.storyboard_number || shot?.shot_number || 0) || null,
    duration: Number(semantic.shot_duration || shot?.duration || video.timing?.duration || 0) || null,
    mode: 'ref2va',
    semantic_slots: semantic,
    characters: parse(shot?.characters, []),
    background_characters: parse(shot?.background_characters, []),
    character_visuals: characterVisuals,
    last_frame_visuals: lastFrameVisuals,
    video_slots: video,
    continuity: semantic.continuity_from_previous || null,
    references: Array.isArray(semantic.required_references) ? semantic.required_references : [],
    audio_strategy: {
      mode: 'timbre_reference_plus_h3_native_audio',
      references: semantic.speech_plan?.audio_references || [],
      soundtrack_copy: false,
    },
    execution_backend: semantic.execution_backend || video.execution_backend || options.execution_backend || null,
    continuum_plan: semantic.continuum_plan || video.continuum_plan || null,
    timeline: Array.isArray(video.shots_timeline) ? video.shots_timeline : [],
  };
  return contract;
}

module.exports = { VERSION, buildH3Contract };
