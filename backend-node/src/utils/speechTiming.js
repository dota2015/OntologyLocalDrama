// Conservative planning estimate, not a guarantee of generated speech fidelity.
const HAN_PER_SECOND = 4;
const WORDS_PER_SECOND = 2.5;
const END_RESERVE_SECONDS = 1;

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

function assessSpeechTiming(shot, duration = shot?.duration, options = {}) {
  const seconds = Number(duration) > 0 ? Number(duration) : 5;
  const dialogue = secondsForText(shot?.dialogue);
  const narration = secondsForText(shot?.narration);
  const rate = Number(options.speechRate) > 0 ? Number(options.speechRate) : 1;
  const turnPauses = Math.max(0, Number(options.turnPauseSeconds) || 0);
  const speechSeconds = (dialogue.seconds + narration.seconds) / rate;
  const requiredSeconds = speechSeconds > 0 ? speechSeconds + END_RESERVE_SECONDS + turnPauses : 0;
  return {
    ok: requiredSeconds <= seconds + 0.2,
    duration: seconds,
    speechSeconds,
    requiredSeconds: Math.ceil(requiredSeconds * 10) / 10,
    recommendedDuration: Math.ceil(requiredSeconds),
    han: dialogue.han + narration.han,
    words: dialogue.words + narration.words,
    hanBudget: Math.floor(Math.max(0, seconds - END_RESERVE_SECONDS - turnPauses) * HAN_PER_SECOND * rate),
  };
}

function timingError(shot, assessment) {
  const num = shot?.storyboard_number ?? shot?.shot_number;
  return `${num ? `分镜 ${num}` : '当前镜头'}对白与旁白超出时长预算：${assessment.duration} 秒镜头约可容纳 ${assessment.hanBudget} 个中文字（对白与旁白合计，含收尾预留），当前约需 ${assessment.requiredSeconds} 秒。请按语义拆分镜头，或延长镜头并确认模型支持该时长；不会自动删减台词。`;
}

function timingInstructions(duration = 5) {
  const d = Number(duration) > 0 ? Number(duration) : 5;
  return `\n\n【强制对白时长预算 / Mandatory speech timing】
完整保留剧本中的对白、旁白及其顺序，不得缩写、删字或用加速说话来凑镜头数。
按每秒约 ${HAN_PER_SECOND} 个中文字或 ${WORDS_PER_SECOND} 个英文单词估算；混合语言相加，dialogue 与 narration 共用时间，每镜至少预留 ${END_RESERVE_SECONDS} 秒收尾，动作、停顿、情绪重的镜头应进一步减少对白。
${d} 秒镜头最多约 ${Math.floor(Math.max(0, d - 1) * HAN_PER_SECOND)} 个中文字；超过时按完整语义拆成连续镜头，保持人物、场景、动作衔接，每个新镜头 duration 使用 ${d} 秒。
此预算及台词完整性优先于镜头数量和总时长目标；允许增加镜头数。不要给每个镜头强塞重复旁白。台词分别写入 dialogue/narration，视频提示词中的台词必须与字段一致。`;
}

function speechFingerprint(value) {
  const tokens = spokenText(value).toLowerCase().replace(/\p{Script=Han}/gu, ' $& ').match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || [];
  return tokens.map(token => token + '\u001f').join('');
}

// Read explicit speech cues only; quoted visual descriptions are not dialogue.
function speechFromPrompt(prompt) {
  const text = String(prompt || '');
  const dialogue = [];
  const narration = [];
  const keywords = '场景|镜头标题|角色造型|动作|对话|对白|台词|解说旁白|旁白|结果|景别|镜头角度|运镜|氛围|情绪|情绪强度|配乐|音效|时长|风格|光线|=VideoRatio|narration|dialogue';
  const labelled = new RegExp(
    `(?:【(对白|对话|台词|解说旁白|解说|旁白)】|(?:^|[\\n。\\s])(dialogue|narration|voice[ -]?over|对白|对话|台词|解说旁白|解说|旁白)\\s*[：:])\\s*([\\s\\S]*?)(?=【|(?:[。；;！？!?，,、…\\n\\s“”"’'「」『』）)》>])?\\s*(?:${keywords})\\s*[：:]|$)`,
    'gimu'
  );
  let match;
  while ((match = labelled.exec(text))) {
    (/narration|voice|解说|旁白/iu.test(match[1] || match[2]) ? narration : dialogue).push(match[3]);
  }
  const cues = /(?:说(?:道|着)?|喊(?:道)?|问(?:道)?|答(?:道)?|念(?:道)?|says?|speaks?)[：:,，\s]*[“"「『]([^”"」』]+)[”"」』]/giu;
  const quoted = [];
  const speakerQuotes = [];
  while ((match = cues.exec(text))) quoted.push(match[1]);
  // Explicit speaker labels also occur in manually edited universal prompts.
  const speakers = /(?:^|[\n。；;\s])(@?人物\d+|[\p{L}·]{1,16})[：:]\s*[“"「『]([^”"」』]+)[”"」』]/gu;
  while ((match = speakers.exec(text))) {
    if (!/^(?:场景|标题|镜头标题|风格|造型|角色造型|动作|结果|音效|景别|镜头角度|运镜|氛围|情绪|情绪强度|配乐|时长|光线|style|title|dialogue|narration|action|result|movement|shot_type|atmosphere)$/iu.test(match[1])) speakerQuotes.push(match[2]);
  }
  const labelledShot = { dialogue: dialogue.join('\n'), narration: narration.join('\n') };
  const quoteShot = [quoted, speakerQuotes].map(lines => ({ dialogue: lines.join('\n') }))
    .sort((a, b) => assessSpeechTiming(b, 1e6).speechSeconds - assessSpeechTiming(a, 1e6).speechSeconds)[0];
  return assessSpeechTiming(labelledShot, 1e6).speechSeconds >= assessSpeechTiming(quoteShot, 1e6).speechSeconds
    ? labelledShot : quoteShot;
}

function assessVideoSpeech(shot, prompt, duration, options = {}) {
  // Prompts repeat structured text: take the larger candidate per speech channel.
  const parsed = speechFromPrompt(prompt);
  const merged = {};
  for (const key of ['dialogue', 'narration']) {
    const stored = shot?.[key] || '';
    merged[key] = secondsForText(stored).seconds >= secondsForText(parsed[key]).seconds ? stored : parsed[key];
  }
  return assessSpeechTiming(merged, duration, options);
}

module.exports = { speechFromPrompt, assessSpeechTiming, assessVideoSpeech, timingError, timingInstructions, spokenText, speechFingerprint };
