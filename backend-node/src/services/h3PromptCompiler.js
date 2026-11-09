'use strict';

/**
 * The only formatter for prompts submitted to MiniMax H3.
 *
 * H3 has a deliberately small, stable contract.  Planning data may remain
 * structured in SQLite, but the request sent to the model is always rendered
 * through these section builders.  Keeping the assembly here prevents the
 * storyboard preview compiler and the real video request from drifting apart.
 */

function clean(value, fallback = 'N/A') {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text || fallback;
}

function joinLines(lines, fallback) {
  const value = (Array.isArray(lines) ? lines : []).map(line => clean(line, '')).filter(Boolean).join('\n');
  return value || fallback;
}

function assembleRef2va({ subjectDefinitions, summary, retentionAnalysis, detailedDescription, overallSoundscape, nonDiegeticMusic }) {
  return [
    `subject_definitions:\n${joinLines(subjectDefinitions, 'The supplied references define the planned subjects and environment.')}`,
    `summary:\n${clean(summary, '[reference generation] The target video follows the supplied references and the planned audiovisual timeline.')}`,
    `retention_analysis:\n${joinLines(retentionAnalysis, 'The supplied identities, clothing and scene references remain consistent throughout the video.')}`,
    `detailed_description:\n${clean(detailedDescription, 'The video follows the planned continuous action and preserves the supplied spatial relationships.')}`,
    `overall_soundscape:\n${clean(overallSoundscape)}`,
    `non_diegetic_music:\n${clean(nonDiegeticMusic)}`,
  ].join('\n\n');
}

function assembleBase({ alignment = '', integratedDescription, overallSoundscape, nonDiegeticMusic }) {
  return [
    alignment ? `${alignment.trim()}\n` : '',
    `integrated_multimodal_description: ${clean(integratedDescription, 'The video follows the supplied audiovisual timeline.')}`,
    `overall_soundscape:\n${clean(overallSoundscape)}`,
    `non_diegetic_music:\n${clean(nonDiegeticMusic)}`,
  ].filter(Boolean).join('\n\n');
}

module.exports = { assembleRef2va, assembleBase };
