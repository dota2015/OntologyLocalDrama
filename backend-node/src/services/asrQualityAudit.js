'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { getFfmpegPath } = require('../utils/ffmpegPath');
const { spawn } = require('node:child_process');

function normalizeText(value) {
  return String(value || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

function extractWav(videoPath, target) {
  return new Promise((resolve, reject) => {
    const ffmpeg = getFfmpegPath();
    const child = spawn(ffmpeg, ['-y', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', target]);
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(target) : reject(new Error(stderr.slice(-500) || `ffmpeg exited ${code}`)));
  });
}

/**
 * Optional post-generation ASR check. It is deliberately advisory when the
 * local ASR endpoint is unavailable: video generation must remain usable, but
 * a successful transcript is stored for missing-word and phantom-speech review.
 */
async function auditGeneratedSpeech(videoPath, shot, options = {}) {
  const endpoint = String(options.endpoint || process.env.QWEN_ASR_URL || process.env.ASR_URL || '').trim().replace(/\/$/u, '');
  if (!endpoint) return { status: 'unavailable', reason: '未配置 Qwen3-ASR endpoint' };
  const expected = String(shot?.dialogue || shot?.narration || '').trim();
  const tmp = path.join(path.dirname(videoPath), `.asr-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`);
  try {
    await extractWav(videoPath, tmp);
    const bytes = await fs.readFile(tmp);
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'audio/wav' }), path.basename(tmp));
    form.append('model', String(options.model || process.env.QWEN_ASR_MODEL || 'Qwen3-ASR-0.6B'));
    const response = await fetch(endpoint.includes('/audio/transcriptions') ? endpoint : `${endpoint}/v1/audio/transcriptions`, { method: 'POST', body: form });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error?.message || body.message || `ASR HTTP ${response.status}`);
    const transcript = String(body.text || body.transcript || body.result?.text || '').trim();
    const expectedNorm = normalizeText(expected);
    const transcriptNorm = normalizeText(transcript);
    const hasSpeech = Boolean(transcriptNorm);
    const missingWords = expectedNorm && !transcriptNorm.includes(expectedNorm);
    return {
      status: 'completed',
      passed: expectedNorm ? !missingWords : !hasSpeech,
      expected,
      transcript,
      missing_expected_dialogue: Boolean(missingWords),
      unexpected_speech: !expectedNorm && hasSpeech,
    };
  } catch (error) {
    return { status: 'error', passed: false, reason: error.message };
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

module.exports = { auditGeneratedSpeech };
