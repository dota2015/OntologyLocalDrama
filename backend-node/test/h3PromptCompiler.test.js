const test = require('node:test');
const assert = require('node:assert/strict');
const { assembleRef2va, assembleBase } = require('../src/services/h3PromptCompiler');

test('H3 Ref2VA compiler emits the official six sections in order', () => {
  const prompt = assembleRef2va({
    subjectDefinitions: ['<Subject 1> is one person across <Picture 1>.'],
    summary: '[reference generation] one shot',
    retentionAnalysis: ['<Subject 1>: fully_preserved - identity'],
    detailedDescription: '[Shot 1] The subject walks and speaks: <d>[Chinese] 你好。</d>',
    overallSoundscape: 'Footsteps.',
    nonDiegeticMusic: 'N/A',
  });
  const fields = [...prompt.matchAll(/^(subject_definitions|summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music):/gmu)].map(m => m[1]);
  assert.deepEqual(fields, ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music']);
  assert.match(prompt, /<d>\[Chinese\] 你好。<\/d>/);
});

test('base compiler keeps keyframe alignment before integrated description', () => {
  const prompt = assembleBase({ alignment: 'How the reference pictures align...', integratedDescription: '[Shot 1] continuous action', overallSoundscape: 'Room tone', nonDiegeticMusic: 'N/A' });
  assert.ok(prompt.indexOf('How the reference pictures align') < prompt.indexOf('integrated_multimodal_description:'));
});
