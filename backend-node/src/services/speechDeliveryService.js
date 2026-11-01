// Shared policy for planning, TTS requests, H3 prompts and the shot preview.
const {createHash}=require('crypto');
const narrative=require('./narrativeStyleService');
const timing=require('../utils/speechTiming');
const round=value=>Math.round(value*100)/100;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function sourceHash(shot){return hash(['speech-delivery-v2-natural-speed',...['dialogue','narration','universal_segment_text','duration','emotion','description','action','title'].map(k=>shot[k]??null)]);}
function textFor(shot,segments){
  if(Array.isArray(segments))return {
    dialogue:segments.filter(s=>s.kind==='dialogue').map(s=>`${s.speaker || '人物'}："${s.text}"`).join('\n'),
    narration:segments.filter(s=>s.kind==='narration').map(s=>s.text).join('\n'),
  };
  return timing.authoritativeSpeech(shot);
}
function resolve(settings,shot,options={}){
  narrative.normalize(settings);
  const text=textFor(shot,options.segments ?? shot.speech_plan?.segments);
  const duration=Number(options.duration ?? shot.duration)>0?Number(options.duration ?? shot.duration):5;
  const original=timing.assessSpeechTiming(text,duration);
  const labels=[...String(text.dialogue).matchAll(/(?:^|[\n“”"「」『』。！？!?；;])\s*([\p{L}\p{N}_· .-]{1,24})[：:]/gu)].map(m=>m[1].trim());
  if(timing.spokenText(text.narration))labels.push('旁白');
  const turns=Array.isArray(options.segments ?? shot.speech_plan?.segments)
    ? (options.segments ?? shot.speech_plan.segments).map(s=>s.kind==='narration'?'旁白':s.speaker || '人物') : labels;
  const switches=turns.reduce((n,s,i)=>n+(i>0 && s!==turns[i-1]?1:0),0);
  const pauses=round(Math.min(2,switches*.25));
  const hasSpeech=original.speechSeconds>0;
  const rate=1;
  let reason='语音倍速已停用，统一使用自然语速',source='fixed';
  if(!hasSpeech){source='silent';reason='本镜无对白及旁白';}
  const effectiveRate=1;
  const assessment=timing.assessSpeechTiming(text,duration,{speechRate:effectiveRate,turnPauseSeconds:pauses});
  return {mode:'fixed',speech_rate:rate,effective_rate:effectiveRate,reason,source,has_speech:hasSpeech,
    duration,turn_pause_seconds:pauses,end_reserve_seconds:assessment.endReserveSeconds,han_budget:assessment.hanBudget,
    english_word_budget:Math.floor(Math.max(0,duration-assessment.endReserveSeconds-pauses)*2.5*effectiveRate),
    estimated_seconds:assessment.requiredSeconds,fits:assessment.ok};
}
function budgetOptions(plan){return {speechRate:plan.effective_rate,turnPauseSeconds:plan.turn_pause_seconds};}
function load(db,shotId){
  const row=db.prepare(`SELECT s.*,e.drama_id,d.metadata AS drama_metadata FROM storyboards s
    JOIN episodes e ON e.id=s.episode_id JOIN dramas d ON d.id=e.drama_id
    WHERE s.id=? AND s.deleted_at IS NULL AND e.deleted_at IS NULL AND d.deleted_at IS NULL`).get(Number(shotId));
  if(!row)throw new Error('分镜不存在或已删除');
  return row;
}
function forShot(db,shot,options={}){
  const row=load(db,shot.id),metadata=narrative.parse(row.drama_metadata),settings=narrative.fromMetadata(metadata);
  const current={...row,...shot};
  return resolve(settings,current,options);
}
function getShot(db,shotId){return forShot(db,load(db,shotId));}
function recordAiPlan(db,episodeId,shotId,aiShot){
  // Legacy entry point retained for compatibility. Per-shot speed plans are no
  // longer persisted or consumed.
  return undefined;
}
function planningInstructions(settings,maxDuration){
  narrative.normalize(settings);
  return `\n【自然语速与台词字数预算 / Natural speech budget】
人物对白与旁白统一使用自然语速 1.0x，禁止输出或使用 speech_rate、speech_rate_reason，禁止通过加速把长台词塞入短镜头。可说话时间 = duration - 1.5秒收尾 - 0.25秒 × 说话者切换次数（切换预留最多2秒）；中文预算 floor(可说话时间 × 4)，英文预算 floor(可说话时间 × 2.5)，混合语言按用时相加。对白与旁白共用预算，人物名和表演标签不计入朗读字数。先完整表达剧情；单镜超出预算时，在配置范围内延长镜头，超过${maxDuration?maxDuration+'秒':'项目时长范围'}上限则按语义拆镜，逐字保留原文，不截断、不删字。 Use ordinary natural speech speed only; extend or split shots instead of time-stretching speech.`;
}
module.exports={resolve,budgetOptions,forShot,getShot,recordAiPlan,planningInstructions,sourceHash};
