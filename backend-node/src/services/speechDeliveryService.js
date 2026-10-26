// Shared policy for planning, TTS requests, H3 prompts and the shot preview.
const {createHash}=require('crypto');
const narrative=require('./narrativeStyleService');
const timing=require('../utils/speechTiming');
const round=value=>Math.round(value*100)/100;
const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function sourceHash(shot){return hash(['speech-delivery-v1',...['dialogue','narration','universal_segment_text','duration','emotion','description','action','title'].map(k=>shot[k]??null)]);}
function textFor(shot,segments){
  if(Array.isArray(segments))return {
    dialogue:segments.filter(s=>s.kind==='dialogue').map(s=>`${s.speaker || '人物'}："${s.text}"`).join('\n'),
    narration:segments.filter(s=>s.kind==='narration').map(s=>s.text).join('\n'),
  };
  const parsed=timing.speechFromPrompt(shot.universal_segment_text || '');
  const longer=(a,b)=>timing.assessSpeechTiming({dialogue:a},1e6).speechSeconds>=timing.assessSpeechTiming({dialogue:b},1e6).speechSeconds?a:b;
  return {dialogue:longer(shot.dialogue || '',parsed.dialogue || ''),narration:longer(shot.narration || '',parsed.narration || '')};
}
function resolve(settings,shot,options={}){
  const style=narrative.normalize(settings);
  const text=textFor(shot,options.segments ?? shot.speech_plan?.segments);
  const duration=Number(options.duration ?? shot.duration)>0?Number(options.duration ?? shot.duration):5;
  const plain=timing.spokenText(text.dialogue)+'\n'+timing.spokenText(text.narration);
  const original=timing.assessSpeechTiming(text,duration);
  const longest=Math.max(0,...plain.split(/[。！？.!?\n；;]/u).map(s=>{
    const a=timing.assessSpeechTiming({dialogue:s},1e6);return a.han+a.words*1.6;
  }));
  const labels=[...String(text.dialogue).matchAll(/(?:^|[\n“”"「」『』。！？!?；;])\s*([\p{L}\p{N}_· .-]{1,24})[：:]/gu)].map(m=>m[1].trim());
  if(timing.spokenText(text.narration))labels.push('旁白');
  const turns=Array.isArray(options.segments ?? shot.speech_plan?.segments)
    ? (options.segments ?? shot.speech_plan.segments).map(s=>s.kind==='narration'?'旁白':s.speaker || '人物') : labels;
  const switches=turns.reduce((n,s,i)=>n+(i>0 && s!==turns[i-1]?1:0),0);
  const pauses=round(Math.min(2,switches*.25));
  const cue=[shot.emotion,shot.action,shot.description].filter(Boolean).join(' ');
  const urgent=/急促|急切|争吵|争执|怒吼|大喊|催促|语速快|rapid|urgent|argu(?:e|ing|ment)|shout|frantic/iu.test(cue);
  const deliberate=/哽咽|抽泣|哭泣|迟疑|悲伤|缓慢|艰难开口|低声倾诉|sobbing|hesitant|slowly|tearful/iu.test(cue);
  const hasSpeech=original.speechSeconds>0;
  let rate=style.speech_rate,reason='使用项目固定倍率',source='fixed';
  if(style.speech_mode==='auto' && hasSpeech){
    const base=style.speech_rate<=1.25?clamp(style.speech_rate,1.2,1.3):clamp(style.speech_rate,1.2,2.0);
    const density=original.speechSeconds/Math.max(.1,duration-1-pauses);
    const deliberateCap=style.speech_rate<=1.25?1.2:Math.max(1.2,round(base-0.2));
    const urgentMax=style.speech_rate<=1.25?1.4:Math.min(2.0,round(base+0.15));
    const normalMax=style.speech_rate<=1.25?1.3:Math.min(2.0,round(base+0.05));
    const maximum=deliberate?deliberateCap:urgent && longest<=24?urgentMax:normalMax;
    const requested=Number(options.requestedRate ?? shot.speech_rate);
    if(Number.isFinite(requested) && requested>=.5 && requested<=2){
      rate=clamp(requested,deliberate?deliberateCap:Math.min(base,1.2),maximum);source='ai';reason=String(options.requestedReason ?? shot.speech_rate_reason ?? '按分镜规划语速').slice(0,200);
      if(rate!==requested)reason+='；已按长句或情绪限制调整';
    }else if(deliberate){rate=deliberateCap;reason='情绪或停顿较重，优先清楚表达';source='rules';}
    else if(urgent && longest<=24){rate=urgentMax;reason='急促短句，采用较快接话';source='rules';}
    else {rate=density>.75?Math.min(maximum,round(base+.05)):density<.45?Math.max(deliberateCap,round(base-.05)):base;reason=longest>24?'长句保持清晰，优先延长或拆镜':'根据台词密度与镜头时长调整';source='rules';}
    rate=round(clamp(rate,deliberate?deliberateCap:Math.min(base,1.2),maximum));
  }
  if(!hasSpeech){source='silent';reason='本镜无对白及旁白';}
  // H3 pace is a target. When project baseline rate >= 1.4 (e.g. 1.5x), credit 80% speed-up;
  // otherwise credit conservative 50% speed-up to reserve pronunciation margin.
  const creditRatio=style.speech_rate>=1.4?0.8:0.5;
  const effectiveRate=rate>1?round(1+(rate-1)*creditRatio):rate;
  const assessment=timing.assessSpeechTiming(text,duration,{speechRate:effectiveRate,turnPauseSeconds:pauses});
  return {mode:style.speech_mode,speech_rate:rate,effective_rate:effectiveRate,reason,source,has_speech:hasSpeech,
    duration,turn_pause_seconds:pauses,end_reserve_seconds:1,han_budget:assessment.hanBudget,
    english_word_budget:Math.floor(Math.max(0,duration-1-pauses)*2.5*effectiveRate),
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
  if(options.baseSpeed!==undefined)settings.speech_rate=Number(options.baseSpeed);
  const current={...row,...shot};
  const saved=metadata.speech_delivery?.shots?.[row.id];
  const valid=saved && saved.source_hash===sourceHash(current) && saved.settings_hash===hash(settings);
  return resolve(settings,valid?{...current,emotion:current.emotion || saved.emotion}:current,{...options,requestedRate:valid?saved.speech_rate:undefined,requestedReason:valid?saved.reason:undefined});
}
function getShot(db,shotId){return forShot(db,load(db,shotId));}
function recordAiPlan(db,episodeId,shotId,aiShot){
  if(aiShot.speech_rate==null || !Number.isFinite(Number(aiShot.speech_rate)))return;
  const row=load(db,shotId);
  if(row.episode_id!==Number(episodeId))return;
  const metadata=narrative.parse(row.drama_metadata),settings=narrative.fromMetadata(metadata);
  if(settings.speech_mode!=='auto')return;
  const plan=resolve(settings,{...row,emotion:aiShot.emotion},{requestedRate:aiShot.speech_rate,requestedReason:aiShot.speech_rate_reason});
  metadata.speech_delivery={...metadata.speech_delivery,shots:{...metadata.speech_delivery?.shots,
    [row.id]:{speech_rate:plan.speech_rate,reason:plan.reason,emotion:String(aiShot.emotion || '').slice(0,100),source_hash:sourceHash(row),settings_hash:hash(settings)}}};
  db.prepare('UPDATE dramas SET metadata=?,updated_at=? WHERE id=?').run(JSON.stringify(metadata),new Date().toISOString(),row.drama_id);
}
function planningInstructions(settings,maxDuration){
  const s=narrative.normalize(settings),auto=s.speech_mode==='auto';
  const baseRate=s.speech_rate || 1.5;
  const rates=auto
    ?(baseRate>=1.4?[round(baseRate-0.2),baseRate,round(baseRate+0.15)]:[1.2,1.3,1.4])
    :[baseRate];
  const examples=rates.map(rate=>{
    const plan=resolve({...s,speech_mode:'fixed',speech_rate:rate},{duration:5,dialogue:'例'});
    return `${rate}x → 5秒单人镜约${plan.han_budget}个中文字`;
  }).join('；');
  const paceRule=auto
    ?(baseRate>=1.4
      ?`项目基准语速为 ${baseRate}x。每镜 speech_rate 以基准 ${baseRate} 为基础，根据剧情和情绪微调（普通紧凑对白约 ${baseRate}x，急促短句可达 ${round(baseRate+0.15)}x，情绪沉重或长句约 ${round(baseRate-0.2)}x）。`
      :'先按剧情选择每镜 speech_rate：普通紧凑对白1.2–1.3，急促短句最多1.4；情绪停顿或长句优先1.2，长句不得超过1.3。禁止为了塞字提高倍率，不自动使用1.5。')
    :`项目使用固定倍率 ${s.speech_rate}x，每镜 speech_rate 使用此值。`;
  const speedCredit=s.speech_rate>=1.4?'0.8':'0.5';
  return `\n【逐镜语速与台词字数联动 / Per-shot speech pace and word budget】
${paceRule}
进入分镜阶段，每镜额外输出 speech_rate 数字和 speech_rate_reason 简短原因，再规划 duration 与对白、旁白；剧本阶段保持原有返回结构，写完整、自然、信息清楚的对白；可以有较长台词或多轮交流，提供自然语义停顿以便按预算连贯拆镜，不要求一律短句。字数随语速变化：预算系数 r = speech_rate > 1 ? 1 + (speech_rate - 1) × ${speedCredit} : speech_rate；可说话时间 = duration - 1秒收尾 - 0.25秒 × 说话者切换次数（切换预留最多2秒）。中文预算 floor(可说话时间 × 4 × r)，英文预算 floor(可说话时间 × 2.5 × r)，混合语言按用时相加。${examples}；不是必须填满的字数目标。
H3实际语速不保证精确达到倍率，因此这里计入加速收益并预留清晰发音余量。dialogue 与 narration 共用这份预算，人物名、语气标签不计入朗读字数。先根据剧情表达完整台词，再结合符合情境的语速规划镜头时长与拆分点；单镜文字必须在预算内，不为追求短句删减必要信息，也不提高语速硬塞长段。已有剧本台词逐字保留，超预算时在配置范围内延长镜头，超过${maxDuration?maxDuration+'秒':'项目时长范围'}上限则按语义拆镜，不截断、不删字。 Preserve the conservative speech budget and exact source dialogue; per-shot speed informs word planning, not a license to rush or truncate speech.`;
}
module.exports={resolve,budgetOptions,forShot,getShot,recordAiPlan,planningInstructions,sourceHash};
