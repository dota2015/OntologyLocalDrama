// Conservative planning estimate, not a guarantee of generated speech fidelity.
// Natural-language reference rates. A shot's capacity is adjusted by the
// actual TTS speed that will render it; these are not fixed shot limits.
const HAN_PER_SECOND = 4;
const WORDS_PER_SECOND = 2.5;
const DEFAULT_TTS_SPEED = 1.25; // IndexTTS is the project's default engine.
// Speech windows are planned to the actual shot boundary.  Do not reserve a
// fixed silent tail: H3/TTS timing is now explicit at the second level and a
// hard-coded tail needlessly clips otherwise valid dialogue.
const END_RESERVE_SECONDS = 0;

function spokenText(value) {
  let text = String(value ?? '').trim();
  if (/^(?:无|无对白|无对话|无旁白|无台词|无解说|none|null|n\/a|silent)[。.!！\s]*$/iu.test(text)) return '';
  return text
    .replace(/第\d+(?:\.\d+)?秒\s*/gu, '')
    .replace(/@人物\d+\s*[：:]/gu, '')
    .replace(/[（(](?:停顿|沉默|动作|表情|低声|大喊|叹气|笑|哭|pause|sigh)[^）)\n]*[）)]/giu, '')
    .replace(/(?:^|[\n“”"「」『』。！？!?；;])\s*[\p{L}\p{N}_· .-]{1,24}[：:]/gu, ' ')
    .replace(/[“”"「」『』]/gu, '').trim();
}

function secondsForText(value) {
  const text = spokenText(value);
  const han = (text.match(/\p{Script=Han}/gu) || []).length;
  const words = (text.replace(/\p{Script=Han}/gu, ' ').match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || []).length;
  return { seconds: han / HAN_PER_SECOND + words / WORDS_PER_SECOND, han, words };
}

function normalizeSpeechRate(value, fallback = DEFAULT_TTS_SPEED) {
  const rate = Number(value);
  return Number.isFinite(rate) && rate > 0 ? rate : fallback;
}

function hanCapacity(duration, speechRate = DEFAULT_TTS_SPEED, turnPauseSeconds = 0) {
  const seconds = Math.max(0, Number(duration) || 0) - Math.max(0, Number(turnPauseSeconds) || 0);
  return Math.floor(seconds * HAN_PER_SECOND * normalizeSpeechRate(speechRate));
}

function assessSpeechTiming(shot, duration = shot?.duration, options = {}) {
  const seconds = Number(duration) > 0 ? Number(duration) : 5;
  const dialogue = secondsForText(shot?.dialogue);
  const narration = secondsForText(shot?.narration);
  const rate = normalizeSpeechRate(options.speechRate);
  const turnPauses = Math.max(0, Number(options.turnPauseSeconds) || 0);
  const speechSeconds = (dialogue.seconds + narration.seconds) / rate;
  const requiredSeconds = speechSeconds > 0 ? speechSeconds + END_RESERVE_SECONDS + turnPauses : 0;
  return {
    ok: requiredSeconds <= seconds + 0.2,
    duration: seconds,
    speechSeconds,
    speechRate: rate,
    requiredSeconds: Math.ceil(requiredSeconds * 10) / 10,
    recommendedDuration: Math.ceil(requiredSeconds),
    endReserveSeconds: END_RESERVE_SECONDS,
    han: dialogue.han + narration.han,
    words: dialogue.words + narration.words,
    hanBudget: hanCapacity(seconds - END_RESERVE_SECONDS, rate, turnPauses),
  };
}

function timingError(shot, assessment) {
  const num = shot?.storyboard_number ?? shot?.shot_number;
  return `${num ? `分镜 ${num}` : '当前镜头'}对白与旁白超出时长预算：${assessment.duration} 秒镜头约可容纳 ${assessment.hanBudget} 个中文字（对白与旁白合计，按实际 TTS ${assessment.speechRate || DEFAULT_TTS_SPEED}x），当前约需 ${assessment.requiredSeconds} 秒。请按语义拆分镜头，或延长镜头并确认模型支持该时长；不会自动删减台词。`;
}

function timingInstructions(duration = 5, options = {}) {
  const d = Number(duration) > 0 ? Number(duration) : 5;
  const rate = normalizeSpeechRate(options.speechRate);
  const capacity = hanCapacity(d, rate);
  return `\n\n【强制对白时长预算 / Mandatory speech timing】
完整保留剧本中的对白、旁白及其顺序，不得缩写、删字或截断。
先按中文约 ${HAN_PER_SECOND} 字/秒、英文约 ${WORDS_PER_SECOND} 词/秒的自然基准估算，再乘以本项目实际 TTS 速度 ${rate}x；IndexTTS 未配置速度时默认 1.25x，其他引擎使用其配置值。对白与旁白共用本镜实际时间，不预留固定收尾静音；动作、停顿、情绪重的镜头应按时间轴显式安排。
${d} 秒镜头按当前 TTS 速度约可容纳 ${capacity} 个中文字；超过时按完整语义拆成连续镜头，保持人物、场景、动作衔接，每个新镜头重新按其实际 TTS 速度计算 duration。
此预算及台词完整性优先于镜头数量和总时长目标；允许增加镜头数。不要给每个镜头强塞重复旁白。台词分别写入 dialogue/narration，视频提示词中的台词必须与字段一致。`;
}

function speechFingerprint(value) {
  const tokens = spokenText(value).toLowerCase().replace(/\p{Script=Han}/gu, ' $& ').match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || [];
  return tokens.map(token => token + '\u001f').join('');
}

// Read explicit speech cues only; quoted visual descriptions are not dialogue.
function cleanExtractedSpeech(str) {
  if (!str) return '';
  return String(str)
    .replace(/（(?:仅限说话人|画面其余人物|双唇紧闭|严格保持|严禁开口|口型同步|无对白).*?）/gu, '')
    .replace(/\((?:lip sync|all other|keep mouth|strictly no).*?\)/giu, '')
    .replace(/（(?:无|无对白|无对话|无台词|none|null|n\/a)[。.!！\s]*）/giu, '')
    .trim();
}

function speechFromPrompt(prompt) {
  const text = String(prompt || '');
  const dialogue = [];
  const narration = [];
  const keywords = '场景|镜头标题|角色造型|动作|对话|对白|台词|解说旁白|旁白|结果收束|结果|景别|镜头角度|运镜|角色动态与轨迹|口型状态|画面与口型要求|氛围|情绪|情绪强度|配乐|音效|时长|风格|光线|=VideoRatio|narration|dialogue';
  const labelled = new RegExp(
    `(?:【(对白|对话|台词|解说旁白|解说|旁白)】|(?:^|[\\n。\\s])(dialogue|narration|voice[ -]?over|对白|对话|台词|解说旁白|解说|旁白)\\s*[：:])\\s*([\\s\\S]*?)(?=【|(?:[。；;！？!?，,、…\\n\\s“”"’'「」『』）)》>])?\\s*(?:${keywords})\\s*[：:]|$)`,
    'gimu'
  );
  let match;
  while ((match = labelled.exec(text))) {
    const speech = cleanExtractedSpeech(match[3]);
    if (speech) {
      (/narration|voice|解说|旁白/iu.test(match[1] || match[2]) ? narration : dialogue).push(speech);
    }
  }
  const cues = /(?:说(?:道|着)?|喊(?:道)?|问(?:道)?|答(?:道)?|念(?:道)?|says?|speaks?)[：:,，\s]*[“"「『]([^”"」』]+)[”"」』]/giu;
  const quoted = [];
  const speakerQuotes = [];
  while ((match = cues.exec(text))) {
    const speech = cleanExtractedSpeech(match[1]);
    if (speech) quoted.push(speech);
  }
  // Explicit speaker labels also occur in manually edited universal prompts.
  const speakers = /(?:^|[\n。；;\s])(@?人物\d+|[\p{L}·]{1,16})[：:]\s*[“"「『]([^”"」』]+)[”"」』]/gu;
  while ((match = speakers.exec(text))) {
    if (!/^(?:场景|标题|镜头标题|风格|造型|角色造型|动作|结果收束|结果|音效|景别|镜头角度|运镜|角色动态与轨迹|口型状态|画面与口型要求|氛围|情绪|情绪强度|配乐|时长|光线|style|title|dialogue|narration|action|result|movement|shot_type|atmosphere)$/iu.test(match[1])) {
      const speech = cleanExtractedSpeech(match[2]);
      if (speech) speakerQuotes.push(speech);
    }
  }
  const labelledShot = { dialogue: dialogue.join('\n'), narration: narration.join('\n') };
  const quoteShot = [quoted, speakerQuotes].map(lines => ({ dialogue: lines.join('\n') }))
    .sort((a, b) => assessSpeechTiming(b, 1e6).speechSeconds - assessSpeechTiming(a, 1e6).speechSeconds)[0];
  return assessSpeechTiming(labelledShot, 1e6).speechSeconds >= assessSpeechTiming(quoteShot, 1e6).speechSeconds
    ? labelledShot : quoteShot;
}

function parseSlotObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function longestSpeech(candidates) {
  return candidates
    .map(cleanExtractedSpeech)
    .filter(Boolean)
    .sort((a, b) => secondsForText(b).seconds - secondsForText(a).seconds)[0] || '';
}

/**
 * Resolve speech only from persisted execution data. The three representations
 * mirror the same utterance, so use the longest value in each channel instead
 * of adding duplicates together.
 */
function authoritativeSpeech(shot = {}) {
  const s = shot || {};
  const semantic = parseSlotObject(s.semantic_slots);
  const video = parseSlotObject(s.video_slots);

  const dbDialogue = longestSpeech([s.dialogue]);
  const dbNarration = longestSpeech([s.narration]);
  const dialogue = dbDialogue ? [dbDialogue] : [];
  const narration = dbNarration ? [dbNarration] : [];
  const dbDialogueFp = dbDialogue ? speechFingerprint(dbDialogue) : '';
  const dbNarrationFp = dbNarration ? speechFingerprint(dbNarration) : '';

  // An identical utterance mirrored across dialogue and narration channels by
  // a misclassified slot must be counted once in its authoritative channel.
  const speechPlan = semantic?.speech_plan;
  const planText = speechPlan && typeof speechPlan === 'object' ? cleanExtractedSpeech(speechPlan.text) : '';
  const planFp = planText ? speechFingerprint(planText) : '';
  const planIsNarration = speechPlan?.is_narration === true;
  const planBlocked = (planIsNarration && !dbNarrationFp && dbDialogueFp && planFp === dbDialogueFp)
    || (!planIsNarration && !dbDialogueFp && dbNarrationFp && planFp === dbNarrationFp);
  let claimedPlanFp = '';
  if (planText && !planBlocked) {
    claimedPlanFp = planFp;
    (planIsNarration ? narration : dialogue).push(speechPlan.text);
  }

  const lipSync = video?.audio_lip_sync;
  const lipText = lipSync && typeof lipSync === 'object' ? cleanExtractedSpeech(lipSync.dialogue_content) : '';
  const lipFp = lipText ? speechFingerprint(lipText) : '';
  const lipIsNarration = String(lipSync?.mode || '').toLowerCase() === 'narration';
  const lipBlocked = (lipIsNarration && !dbNarrationFp
      && ((dbDialogueFp && lipFp === dbDialogueFp) || (!planIsNarration && claimedPlanFp && lipFp === claimedPlanFp)))
    || (!lipIsNarration && !dbDialogueFp
      && ((dbNarrationFp && lipFp === dbNarrationFp) || (planIsNarration && claimedPlanFp && lipFp === claimedPlanFp)));
  if (lipText && !lipBlocked) {
    (lipIsNarration ? narration : dialogue).push(lipSync.dialogue_content);
  }

  return {
    dialogue: longestSpeech(dialogue),
    narration: longestSpeech(narration),
    hasStructuredSlots: semantic !== null || video !== null,
  };
}

function assessVideoSpeech(shot, _prompt, duration, options = {}) {
  const authoritative = authoritativeSpeech(shot);
  // Compiled prompts are presentation output. Execution gates only consume the
  // persisted database fields and structured semantic/video slots above.
  return assessSpeechTiming(authoritative, duration, options);
}

module.exports = { speechFromPrompt, authoritativeSpeech, assessSpeechTiming, assessVideoSpeech, timingError, timingInstructions, spokenText, speechFingerprint, cleanExtractedSpeech, normalizeSpeechRate, hanCapacity, HAN_PER_SECOND, WORDS_PER_SECOND, DEFAULT_TTS_SPEED };
