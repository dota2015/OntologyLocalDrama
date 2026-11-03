// Shared policy for planning, TTS requests, H3 prompts and the shot preview.
const {createHash}=require('crypto');
const narrative=require('./narrativeStyleService');
const timing=require('../utils/speechTiming');
const round=value=>Math.round(value*100)/100;
const DEFAULT_TTS_SPEED = timing.DEFAULT_TTS_SPEED;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function sourceHash(shot){return hash(['speech-delivery-v2-natural-speed',...['dialogue','narration','universal_segment_text','duration','emotion','description','action','title'].map(k=>shot[k]??null)]);}
function textFor(shot,segments){
  if(Array.isArray(segments))return {
    dialogue:segments.filter(s=>s.kind==='dialogue').map(s=>`${s.speaker || '人物'}："${s.text}"`).join('\n'),
    narration:segments.filter(s=>s.kind==='narration').map(s=>s.text).join('\n'),
  };
  return timing.authoritativeSpeech(shot);
}
function resolve(settings = {}, shot = {}, options = {}) {
  narrative.normalize(settings || {});
  const text = textFor(shot, options.segments ?? shot.speech_plan?.segments);
  const duration = Number(options.duration ?? shot.duration) > 0 ? Number(options.duration ?? shot.duration) : 5;
  const original = timing.assessSpeechTiming(text, duration);
  const labels = [...String(text.dialogue).matchAll(/(?:^|[\n“”"「」『』。！？!?；;])\s*([\p{L}\p{N}_· .-]{1,24})[：:]/gu)].map(m => m[1].trim());
  if (timing.spokenText(text.narration)) labels.push('旁白');
  const turns = Array.isArray(options.segments ?? shot.speech_plan?.segments)
    ? (options.segments ?? shot.speech_plan.segments).map(s => s.kind === 'narration' ? '旁白' : s.speaker || '人物') : labels;
  const pauses = Math.max(0, Number(options.turnPauseSeconds) || 0);
  const hasSpeech = original.speechSeconds > 0;
  const requested = options.ttsSpeed ?? options.baseSpeed ?? options.speechRate ?? settings.tts_speed ?? settings.ttsSpeed;
  const effectiveRate = timing.normalizeSpeechRate(requested, DEFAULT_TTS_SPEED);
  const source = Number(requested) > 0
    ? (options.ttsSpeed != null || options.baseSpeed != null ? 'tts_configured' : 'tts_speed_setting')
    : 'default_indextts';
  const reason = hasSpeech
    ? `按实际 TTS 速度 ${effectiveRate}x 计算（IndexTTS 未配置时默认 1.25x）`
    : '本镜无对白及旁白';
  const assessment = timing.assessSpeechTiming(text, duration, { speechRate: effectiveRate, turnPauseSeconds: pauses });
  return { mode: 'tts_rate', speech_rate: effectiveRate, effective_rate: effectiveRate, reason, source, has_speech: hasSpeech,
    duration, turn_pause_seconds: pauses, end_reserve_seconds: 0, han_budget: assessment.hanBudget,
    english_word_budget: Math.floor(duration * timing.WORDS_PER_SECOND * effectiveRate),
    estimated_seconds: assessment.requiredSeconds, fits: assessment.ok };
}
function budgetOptions(plan){return {speechRate:plan.effective_rate,turnPauseSeconds:plan.turn_pause_seconds};}
function load(db,shotId){
  const row=db.prepare(`SELECT s.*,e.drama_id,d.metadata AS drama_metadata FROM storyboards s
    JOIN episodes e ON e.id=s.episode_id JOIN dramas d ON d.id=e.drama_id
    WHERE s.id=? AND s.deleted_at IS NULL AND e.deleted_at IS NULL AND d.deleted_at IS NULL`).get(Number(shotId));
  if(!row)throw new Error('分镜不存在或已删除');
  return row;
}
function configuredTtsSpeed(db, metadata = {}) {
  let speed = DEFAULT_TTS_SPEED;
  try {
    const aiConfig = require('./aiConfigService');
    const tts = require('./ttsService');
    const raw = metadata.tts_dubbing || {};
    const configs = aiConfig.listConfigs(db, 'tts').filter(c => c.is_active);
    const config = (raw.config_id && configs.find(c => Number(c.id) === Number(raw.config_id)))
      || configs.find(c => c.is_default) || configs[0];
    if (config) speed = tts.defaultSpeed(config);
  } catch (_) { /* draft/test DB: use the IndexTTS project default */ }
  return timing.normalizeSpeechRate(speed, DEFAULT_TTS_SPEED);
}
function forShot(db, shot, options = {}) {
  const row = load(db, shot.id);
  const metadata = narrative.parse(row.drama_metadata);
  const settings = narrative.fromMetadata(metadata);
  const ttsSpeed = configuredTtsSpeed(db, metadata);
  const current = { ...row, ...shot };
  return resolve({ ...settings, tts_speed: ttsSpeed }, current, { ...options, ttsSpeed });
}
function getShot(db,shotId){return forShot(db,load(db,shotId));}
function recordAiPlan(db,episodeId,shotId,aiShot){
  // Legacy entry point retained for compatibility. Per-shot speed plans are no
  // longer persisted or consumed.
  return undefined;
}
function planningInstructions(settings = {}, maxDuration, options = {}) {
  narrative.normalize(settings || {});
  const rate = timing.normalizeSpeechRate(options.ttsSpeed ?? options.speechRate ?? settings.tts_speed, DEFAULT_TTS_SPEED);
  const capacity = maxDuration ? timing.hanCapacity(maxDuration, rate) : null;
  return `\n【实际 TTS 速度与台词预算 / TTS-aware speech budget】
完整保留对白与旁白，按中文约 ${timing.HAN_PER_SECOND} 字/秒、英文约 ${timing.WORDS_PER_SECOND} 词/秒的自然基准估算，再乘以实际 TTS speed=${rate}x。IndexTTS 未配置速度时默认 1.25x，其他引擎按其配置读取；不要把 Agent 自己输出的 speed 当成可自由调整的语速。
对白与旁白共用本镜可用时间，不预留固定收尾静音；${capacity ? `在 ${maxDuration} 秒上限和当前速度下约可容纳 ${capacity} 个中文字，` : ''}超出时延长到配置范围或按语义拆镜，允许增加镜头数，逐字保留原文，不删字、不截断、不通过提示词伪造更快语速。动作与台词按显式时间轴同步安排。 Use the measured/configured TTS speed for every shot rather than a fixed characters-per-second limit.`;
}
module.exports={resolve,budgetOptions,forShot,getShot,recordAiPlan,planningInstructions,configuredTtsSpeed,sourceHash};
