'use strict';

/**
 * Continuum execution contract.
 *
 * A normal H3 request is limited to 4–8 seconds.  Continuum is a separate
 * workflow which joins sequential chunks and is therefore used only for
 * 9–30-second logical shots.  Keeping this decision in one module prevents
 * the director, speech gate and video bridge from silently disagreeing.
 */
const MIN_SHOT_SECONDS = 4;
const SINGLE_MAX_SECONDS = 8;
const CONTINUUM_MIN_SECONDS = 9;
const CONTINUUM_MAX_SECONDS = 30;
const DEFAULT_CHUNK_SECONDS = 10;

function integerSeconds(value, fallback = 5) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function backendForDuration(duration, requested) {
  const explicit = String(requested || '').trim().toLowerCase();
  const seconds = integerSeconds(duration);
  if (explicit === 'h3_single' || explicit === 'h3_continuum') return explicit;
  return seconds >= CONTINUUM_MIN_SECONDS ? 'h3_continuum' : 'h3_single';
}

function chunkPlan(duration, options = {}) {
  const total = integerSeconds(duration, 0);
  if (!Number.isInteger(total) || total < CONTINUUM_MIN_SECONDS || total > CONTINUUM_MAX_SECONDS) {
    throw new Error(`Continuum 单个逻辑分镜必须为 ${CONTINUUM_MIN_SECONDS}～${CONTINUUM_MAX_SECONDS} 秒整数，当前为 ${duration}`);
  }
  const preferred = integerSeconds(options.chunk_seconds || options.chunkSeconds, DEFAULT_CHUNK_SECONDS);
  if (!Number.isInteger(preferred)) {
    throw new Error(`Continuum chunk_seconds 必须是整数，当前为 ${preferred}`);
  }
  const preferredSeconds = Math.max(4, Math.min(15, preferred));
  // Physical chunks are integer seconds.  H3's public contract and the
  // director timeline both use whole-second boundaries; fractional chunks
  // make speech deadlines and continuation frames drift.
  let chunks = Math.max(2, Math.ceil(total / preferredSeconds));
  while (chunks > 2 && Math.floor(total / chunks) < 4) chunks -= 1;
  const minChunks = Math.ceil(total / 15);
  if (chunks < minChunks) chunks = minChunks;
  if (chunks < 2 || Math.floor(total / chunks) < 4 || Math.ceil(total / chunks) > 15) {
    throw new Error(`Continuum 无法把 ${total} 秒划分为 4～15 秒整数物理片段`);
  }
  const slices = [];
  let start = 0;
  const base = Math.floor(total / chunks);
  const remainder = total % chunks;
  for (let i = 0; i < chunks; i += 1) {
    // Put the remainder on the first slices, keeping every slice integral and
    // within the same 4–15 second physical range.
    const seconds = base + (i < remainder ? 1 : 0);
    slices.push({ chunk_index: i, start_seconds: start, duration_seconds: seconds, end_seconds: start + seconds });
    start += seconds;
  }
  return {
    enabled: true,
    total_duration: total,
    chunks,
    chunk_seconds: base,
    prompt_mode: options.prompt_mode || 'timeline',
    audio_continuity: options.audio_continuity !== false,
    motion_continuity: options.motion_continuity !== false,
    slices,
  };
}

function normalizeExecutionPlan(duration, raw = {}) {
  const seconds = integerSeconds(duration, 0);
  const requested = raw.execution_backend || raw.backend || raw.executionBackend;
  const backend = backendForDuration(seconds, requested);
  if (!Number.isInteger(seconds) || seconds < MIN_SHOT_SECONDS || seconds > CONTINUUM_MAX_SECONDS) {
    throw new Error(`H3 单个逻辑分镜必须为 ${MIN_SHOT_SECONDS}～${CONTINUUM_MAX_SECONDS} 秒整数，当前为 ${duration}`);
  }
  if (backend === 'h3_single' && seconds > SINGLE_MAX_SECONDS) {
    throw new Error(`${seconds} 秒镜头必须使用 Continuum，普通 H3 只支持 ${MIN_SHOT_SECONDS}～${SINGLE_MAX_SECONDS} 秒`);
  }
  if (backend === 'h3_continuum' && seconds < CONTINUUM_MIN_SECONDS) {
    throw new Error(`${seconds} 秒镜头不应使用 Continuum；${CONTINUUM_MIN_SECONDS} 秒起才启用 Continuum`);
  }
  const plan = backend === 'h3_continuum'
    ? chunkPlan(seconds, raw.continuum_plan || raw.continuumPlan || raw)
    : null;
  if (plan && Number(plan.total_duration) !== seconds) {
    throw new Error('Continuum total_duration 必须等于分镜 duration');
  }
  return { execution_backend: backend, continuum_plan: plan };
}

function timelinePrompt(timeline, totalDuration) {
  if (!Array.isArray(timeline) || !timeline.length) return '';
  let cursor = 0;
  const lines = timeline.map((segment, index) => {
    const seconds = integerSeconds(segment?.duration, 0);
    if (!Number.isInteger(seconds) || seconds < 1) {
      throw new Error(`Continuum 镜内时间线第 ${index + 1} 段必须使用正整数秒`);
    }
    const start = cursor;
    cursor += seconds;
    const end = cursor;
    const text = [segment?.camera, segment?.action, segment?.result]
      .filter(Boolean).join('；');
    return `[${start}-${end}s] ${text || `Continue the planned action for beat ${index + 1}.`}`;
  });
  if (cursor !== Number(totalDuration)) throw new Error(`镜内时间线合计 ${cursor} 秒，与分镜 ${totalDuration} 秒不一致`);
  return lines.join('\n');
}

module.exports = {
  MIN_SHOT_SECONDS,
  SINGLE_MAX_SECONDS,
  CONTINUUM_MIN_SECONDS,
  CONTINUUM_MAX_SECONDS,
  DEFAULT_CHUNK_SECONDS,
  backendForDuration,
  chunkPlan,
  normalizeExecutionPlan,
  timelinePrompt,
};
