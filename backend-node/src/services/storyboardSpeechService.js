const { planShotDuration, rangeTimingInstructions } = require('../utils/shotDurationRange');
const { assessSpeechTiming, assessVideoSpeech, timingError, timingInstructions, speechFingerprint, hanCapacity } = require('../utils/speechTiming');
const { shotSpeechTurns } = require('./dialogueDubbingService');
const { safeParseAIJSON, extractFirstArray } = require('../utils/safeJson');

function durationForShot(shot, target) {
  const requested = Number(target) > 0
    ? Math.round(Number(target))
    : Math.round(Number(String(shot.duration ?? '').trim().replace(/s$/i, '')) || 5);
  return Math.min(30, Math.max(4, requested));
}

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return structuredClone(value);
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

/**
 * Speech overflow is split into independent Ref2VA shots. The Director owns
 * the creative split; this service only preserves the exact speech and clears
 * legacy long-take relay metadata. FL2VA remains a manual post-generation
 * execution override and is never selected here.
 */
function wireContinuousSpeechSplit(source, fragments, groupOrdinal = 1) {
  if (!Array.isArray(fragments) || fragments.length < 2) return fragments;
  return fragments.map((fragment, index) => {
    const semantic = parseObject(fragment.semantic_slots ?? source?.semantic_slots);
    if (semantic.h3_mode === 'fl2va') {
      throw new Error('对白拆镜遇到 FL2VA Agent 方案；当前导演链路只允许 Ref2VA，请手动修复该分镜后再拆镜');
    }
    semantic.h3_mode = 'ref2va';
    semantic.first_frame_policy = 'none';
    semantic.last_frame_policy = 'none';
    semantic.continuity_type = semantic.continuity_type === 'long_take_continuation'
      ? 'continuation'
      : (semantic.continuity_type || 'continuation');
    return {
      ...fragment,
      semantic_slots: semantic,
      long_take_group_id: null,
      long_take_role: null,
      long_take_sequence: null,
      last_frame_visuals: [],
    };
  });
}

function speakerTracks(value, defaultSpeaker = '') {
  const text = String(value || '');
  const labels = [...text.matchAll(/(?:^|[\n“”"「」『』。！？!?；;])\s*([\p{L}\p{N}_· .-]{1,24})[：:]/gu)];
  const tracks = new Map();
  const add = (speaker, speech) => tracks.set(speaker, (tracks.get(speaker) || '') + speechFingerprint(speech));
  let cursor = 0;
  let speaker = defaultSpeaker;
  for (const label of labels) {
    add(speaker, text.slice(cursor, label.index));
    speaker = label[1].trim();
    cursor = label.index + label[0].length;
  }
  add(speaker, text.slice(cursor));
  return new Map([...tracks].filter(([, speech]) => speech));
}

function preservesSpeech(source, fragments) {
  if (!['dialogue', 'narration'].every(key =>
    speechFingerprint(source[key]) === fragments.map(s => speechFingerprint(s[key])).join(''))) return false;
  const original = speakerTracks(source.dialogue);
  if (!original.size || original.has('')) return true;
  const inferredSpeaker = original.size === 1 ? original.keys().next().value : '';
  const repaired = new Map();
  for (const fragment of fragments) {
    for (const [speaker, speech] of speakerTracks(fragment.dialogue, inferredSpeaker)) {
      repaired.set(speaker, (repaired.get(speaker) || '') + speech);
    }
  }
  return original.size === repaired.size && [...original].every(([speaker, speech]) => repaired.get(speaker) === speech);
}

async function enforceStoryboardSpeechTiming(storyboards, {
  targetDuration,
  durationRange,
  narrativeStyle,
  generate,
  onRepair = () => {},
  enforceSingleSpeaker = false,
  keepUnresolvedForRepair = false,
  onSplitFailure = () => {},
}) {
  const delivery = require('./speechDeliveryService');
  const plan = shot => {
    if (!narrativeStyle) {
      const duration = durationRange ? planShotDuration(shot,durationRange) : durationForShot(shot,targetDuration);
      return {shot:{...shot,duration},options:{}};
    }
    let current={...shot,duration:durationForShot(shot,targetDuration)};
    const chosen=delivery.resolve(narrativeStyle,current);
    const options=delivery.budgetOptions(chosen);
    current.duration=durationRange ? planShotDuration(current,durationRange,options) : current.duration;
    delete current.speech_rate;
    delete current.speech_rate_reason;
    return {shot:current,options};
  };
  const result = [];
  for (const source of storyboards) {
    const planned=plan(source);
    const duration=planned.shot.duration;
    const assessment = assessVideoSpeech(planned.shot, source.universal_segment_text, duration, planned.options);
    const speechTurns = shotSpeechTurns(planned.shot);
    const needsSpeakerSplit = enforceSingleSpeaker && speechTurns.length > 1;
    if (assessment.ok && !needsSpeakerSplit) {
      result.push(planned.shot);
      continue;
    }
    onRepair(source, assessment);
    let fragments;
    let lastError = needsSpeakerSplit && assessment.ok
      ? `分镜包含 ${speechTurns.length} 个发言段，单镜最多只允许 1 个说话人的单轮对白或 1 段旁白`
      : timingError(source, assessment);
    const maxShotDur = Math.max(1, durationRange?.max || duration);
    const perTurnCount = speechTurns.reduce((sum, turn) => {
      const turnShot = turn.kind === 'narration' ? { narration: turn.text } : { dialogue: `${turn.speaker ? `${turn.speaker}：` : ''}${turn.text}` };
      const turnReq = assessSpeechTiming(turnShot, duration, planned.options).requiredSeconds;
      return sum + Math.max(1, Math.ceil(turnReq / maxShotDur));
    }, 0);
    for (let attempt = 0; attempt < 2; attempt++) {
      const minCount = Math.max(
        2,
        Math.ceil(assessment.requiredSeconds / maxShotDur),
        needsSpeakerSplit ? Math.max(speechTurns.length, perTurnCount) : 2,
      );
      const maxBudgetPerShot = hanCapacity(durationRange?.max || duration, planned.options?.speechRate);
      const speakerRuleLine = enforceSingleSpeaker
        ? '每个新分镜最多只保留 1 个说话人的单轮台词（或 1 段旁白）；严禁同一镜内多名角色交替说话，也严禁把对白和旁白混在同一镜；对白放入 dialogue 并保留说话人前缀，旁白放入 narration。'
        : '';
      const reasonHeader = needsSpeakerSplit && assessment.ok
        ? `将此包含 ${speechTurns.length} 个发言段的分镜按说话轮次拆分为至少 ${minCount} 个连续分镜。`
        : `将此超出对白预算或包含多发言段的分镜按语义与说话轮次拆分为至少 ${minCount} 个连续分镜（当前约需 ${assessment.requiredSeconds} 秒，单镜上限 ${durationRange?.max || duration} 秒）。`;
      const userPrompt = `${reasonHeader}
【必须拆镜】严禁只返回 1 个分镜！${speakerRuleLine}拆分后每个新分镜的台词/旁白字数绝不能超过 ${maxBudgetPerShot} 个中文字！只返回 JSON 数组，每项保留原分镜的字段结构。
对白和旁白必须逐字完整、按句号/逗号原顺序分配切分到各个分镜中，保留说话人，禁止增删改写；不得重复整段台词。保持人物、场景、道具及动作连续，合理分配动作与停顿。
${durationRange ? `每镜 duration 在 ${durationRange.min}–${durationRange.max} 秒内按动作与台词分别规划，不突破上限。` : `每镜 duration 固定为 ${duration} 秒，不通过增加 duration 逃避拆镜。`}允许空旁白。重写各镜头的动作、结果、标题；不要返回 universal_segment_text/video_prompt/image_prompt，它们由系统重建。
原分镜：${JSON.stringify(source)}\n上次校验：${lastError}`;
      try {
        const raw = await generate(userPrompt, narrativeStyle ? rangeTimingInstructions(durationRange || {min:duration,max:duration},narrativeStyle) : durationRange ? rangeTimingInstructions(durationRange) : timingInstructions(duration, planned.options));
        const parsed = safeParseAIJSON(raw);
        const items = Array.isArray(parsed) ? parsed : extractFirstArray(parsed);
        if (!items?.length || items.length < 2 || items.some(s => !s || typeof s !== 'object' || Array.isArray(s))) {
          throw new Error(`拆镜结果必须拆分为至少 2 个分镜数组，当前返回 ${items?.length || 0} 个`);
        }
        if (!preservesSpeech(source, items)) throw new Error('拆镜结果遗漏、重复或改写了原对白/旁白');
        fragments = items.map((item,index) => {
          const fragment = { ...source, ...item, dialogue: item.dialogue || '', narration: item.narration || '' };
          Object.assign(fragment,plan(fragment).shot);
          // Scene/character/prop associations remain authoritative.
          for (const key of ['scene_id', 'characters', 'props', 'segment_index', 'segment_title']) {
            if (source[key] !== undefined) fragment[key] = source[key];
          }
          if(index>0)delete fragment.wardrobe_change;
          delete fragment.universal_segment_text;
          delete fragment.video_prompt;
          delete fragment.image_prompt;
          return fragment;
        });
        fragments = wireContinuousSpeechSplit(source, fragments, result.length + 1);
        const assessmentFor=s=>assessSpeechTiming(s,s.duration,narrativeStyle?delivery.budgetOptions(delivery.resolve(narrativeStyle,s)):{});
        const bad = fragments.find(s => !assessmentFor(s).ok);
        if (bad) throw new Error(timingError(bad, assessmentFor(bad)));
        if (enforceSingleSpeaker) {
          const multi = fragments.find((s) => shotSpeechTurns(s).length > 1);
          if (multi) {
            throw new Error(`拆分后仍有镜头包含 ${shotSpeechTurns(multi).length} 个发言段，必须按说话轮次进一步拆为单人单轮镜头`);
          }
        }
        break;
      } catch (err) {
        fragments = null;
        lastError = err.message;
      }
    }
    if (!fragments) {
      if (keepUnresolvedForRepair) {
        onSplitFailure(planned.shot, lastError);
        result.push(planned.shot);
        continue;
      }
      throw new Error(`对白拆镜校验失败，原分镜保持不变：${lastError}`);
    }
    result.push(...fragments);
  }
  return result.map((shot, index) => ({ ...shot, shot_number: index + 1, storyboard_number: index + 1 }));
}

module.exports = { enforceStoryboardSpeechTiming, preservesSpeech, wireContinuousSpeechSplit };
