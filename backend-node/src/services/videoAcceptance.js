const { referenceSource, canonicalSource, sourceVersion } = require('./h3ReferenceBindings');
const { resolveH3SubmissionPlan, previousStoryboard } = require('./h3ModeResolver');
const { createHash } = require('node:crypto');
// Only fields that can alter the prepared H3 request belong in the concurrency
// fingerprint. Output/status columns are written by generation jobs and must not
// make an otherwise immutable input look stale while the prompt is translated.
function shotInputSnapshot(shot) {
  const fields = [
    'id', 'episode_id', 'storyboard_number', 'scene_id', 'description', 'location',
    'time', 'duration', 'dialogue', 'narration', 'action', 'result', 'atmosphere',
    'characters', 'background_characters', 'character_visuals', 'last_frame_visuals',
    'video_slots', 'semantic_slots', 'shot_type', 'angle', 'angle_h', 'angle_v',
    'angle_s', 'movement', 'lighting_style', 'depth_of_field', 'sound_effect',
    'bgm_prompt', 'start_framing', 'end_framing', 'layout_description', 'dialogue_framing',
    'image_url', 'local_path', 'first_frame_image_id', 'last_frame_image_id',
    'last_frame_image_url', 'last_frame_local_path', 'long_take_group_id', 'long_take_sequence', 'long_take_role',
  ];
  return Object.fromEntries(fields.map(field => [field, shot?.[field] ?? null]));
}

// Excludes generated prompt caches, selected output and task timestamps.
function shotRevision(db, shot) {
  if (!shot) return null;
  const row = db.prepare('SELECT d.id AS drama_id,d.metadata,d.style FROM dramas d JOIN episodes e ON e.drama_id=d.id WHERE e.id=?').get(shot.episode_id);
  const meta = JSON.parse(row?.metadata || '{}');
  const style = require('../utils/dramaStyleMerge').resolvedStreamStyleFromDrama('', row);
  const settings = [style, meta.aspect_ratio, meta.narrative_style, meta.h3_default_engine_mode,
    meta.h3_default_continuity, meta.h3_shots?.[shot.id]];
  const manual = shot.h3_prompt_manual ? [shot.h3_prompt_snapshot, shot.h3_prompt_fingerprint] : null;
  const plan = resolveH3SubmissionPlan(db, row?.drama_id, shot, {}, { throwOnViolation: false });
  const sources = plan.references.map(ref => referenceSource(db, row.drama_id, shot, ref));
  if (plan.requires_first_frame && plan.first_frame_policy !== 'inherit_tail') sources.push(shot.local_path || shot.image_url);
  if (plan.last_frame_policy === 'generate_tail') sources.push(shot.last_frame_local_path || shot.last_frame_image_url);
  const media = [];
  if (sources.some(Boolean)) {
    const root = require('../config').loadConfig().storage?.local_path || './data/storage';
    for (const input of sources) {
      const source = canonicalSource(root, input);
      try { media.push([source, sourceVersion(root, source)]); }
      catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
        media.push([source, null]);
      }
    }
  }
  if (plan.first_frame_policy === 'inherit_tail') {
    const prior = previousStoryboard(db, shot);
    const video = prior && usableVideo(db, prior, { localOnly: true });
    media.push(['previous_tail', prior?.id ?? null, video?.id ?? null, video?.local_path ?? null]);
  }
  return createHash('sha256').update(JSON.stringify([shotInputSnapshot(shot), manual, settings, media])).digest('hex');
}

function reviewReason(audit) {
  const reasons = [];
  if (audit?.outcome?.status === 'mismatch') reasons.push('片末状态与导演规划不符');
  if (audit?.asr?.status === 'completed' && !audit.asr.passed) reasons.push('实录台词与分镜不符');
  return reasons.join('，');
}

function usableVideo(db, shot, { localOnly = false } = {}) {
  const revision = shotRevision(db, shot);
  return db.prepare(`SELECT * FROM video_generations WHERE storyboard_id=? AND deleted_at IS NULL
    AND shot_revision=? AND (status='completed' OR (status='needs_review' AND id=?))
    ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END,id DESC`).all(shot.id, revision, shot.selected_video_id ?? null, shot.selected_video_id ?? null)
    .find(v => v.local_path || (!localOnly && require('./videoClient').isPlausibleHttpVideoUrl(v.video_url)));
}

module.exports = { shotInputSnapshot, shotRevision, reviewReason, usableVideo };
