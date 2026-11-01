const { planShotDuration, rangeTimingInstructions } = require('../utils/shotDurationRange');
const { assessSpeechTiming, assessVideoSpeech, timingError, timingInstructions, speechFingerprint } = require('../utils/speechTiming');
const { safeParseAIJSON, extractFirstArray } = require('../utils/safeJson');

function durationForShot(shot, target) {
  const requested = Number(target) > 0
    ? Math.round(Number(target))
    : Math.round(Number(String(shot.duration ?? '').trim().replace(/s$/i, '')) || 5);
  return Math.min(8, Math.max(4, requested));
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
 * Speech overflow is a technical continuation, not a new creative scene.  Make
 * that dependency explicit so the video worker must finish the previous clip,
 * extract its real tail frame, and only then submit the continuation to FL2VA.
 */
function wireContinuousSpeechSplit(source, fragments, groupOrdinal = 1) {
  if (!Array.isArray(fragments) || fragments.length < 2) return fragments;
  const sourceNumber = source?.storyboard_number ?? source?.shot_number ?? groupOrdinal;
  const groupId = `speech_split_${sourceNumber}_${groupOrdinal}`;
  return fragments.map((fragment, index) => {
    const semantic = parseObject(fragment.semantic_slots ?? source?.semantic_slots);
    const speechPlan = semantic.speech_plan && typeof semantic.speech_plan === 'object'
      ? { ...semantic.speech_plan }
      : semantic.speech_plan;
    const isContinuation = index > 0;
    if (isContinuation) {
      semantic.h3_mode = 'fl2va';
      semantic.h3_mode_reason = '长台词超过 H3 八秒上限，本镜承接上一段真实视频尾帧继续表演';
      semantic.first_frame_policy = 'inherit_tail';
      semantic.first_frame_reason = '使用上一拆分镜头生成视频的真实尾帧作为本镜首帧';
      semantic.last_frame_policy = 'none';
      semantic.last_frame_reason = '连续台词自然收束，不额外生成目标尾帧';
      semantic.continuity_type = 'long_take_continuation';
      semantic.required_references = [];
      if (speechPlan && typeof speechPlan === 'object') {
        speechPlan.audio_references = [];
        semantic.speech_plan = speechPlan;
      }
    }
    return {
      ...fragment,
      semantic_slots: semantic,
      long_take_group_id: groupId,
      long_take_role: index === 0 ? 'head' : (index === fragments.length - 1 ? 'tail' : 'continuation'),
      long_take_sequence: index + 1,
      ...(isContinuation ? { last_frame_visuals: [] } : {}),
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

async function enforceStoryboardSpeechTiming(storyboards, { targetDuration, durationRange, narrativeStyle, generate, onRepair = () => {} }) {
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
    if (assessment.ok) {
      result.push(planned.shot);
      continue;
    }
    onRepair(source, assessment);
    let fragments;
    let lastError = timingError(source, assessment);
    for (let attempt = 0; attempt < 2; attempt++) {
      const minCount = Math.max(2, Math.ceil(assessment.requiredSeconds / Math.max(1, (durationRange?.max || duration) - 1.5)));
      const maxBudgetPerShot = Math.floor(Math.max(0, (durationRange?.max || duration) - 1.5) * 4);
      const userPrompt = `将此超出对白预算的分镜按语义拆分为至少 ${minCount} 个连续分镜（当前台词/旁白约需 ${assessment.requiredSeconds} 秒，单镜上限 ${durationRange?.max || duration} 秒）。
【必须拆镜】严禁只返回 1 个分镜！拆分后每个新分镜的台词/旁白字数绝不能超过 ${maxBudgetPerShot} 个中文字！只返回 JSON 数组，每项保留原分镜的字段结构。
对白和旁白必须逐字完整、按句号/逗号原顺序分配切分到各个分镜中，保留说话人，禁止增删改写；不得重复整段台词。保持人物、场景、道具及动作连续，合理分配动作与停顿。
${durationRange ? `每镜 duration 在 ${durationRange.min}–${durationRange.max} 秒内按动作与台词分别规划，不突破上限。` : `每镜 duration 固定为 ${duration} 秒，不通过增加 duration 逃避拆镜。`}允许空旁白。重写各镜头的动作、结果、标题；不要返回 universal_segment_text/video_prompt/image_prompt，它们由系统重建。
原分镜：${JSON.stringify(source)}\n上次校验：${lastError}`;
      try {
        const raw = await generate(userPrompt, narrativeStyle ? rangeTimingInstructions(durationRange || {min:duration,max:duration},narrativeStyle) : durationRange ? rangeTimingInstructions(durationRange) : timingInstructions(duration));
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
        break;
      } catch (err) {
        fragments = null;
        lastError = err.message;
      }
    }
    if (!fragments) throw new Error(`对白拆镜校验失败，原分镜保持不变：${lastError}`);
    result.push(...fragments);
  }
  return result.map((shot, index) => ({ ...shot, shot_number: index + 1, storyboard_number: index + 1 }));
}

module.exports = { enforceStoryboardSpeechTiming, preservesSpeech, wireContinuousSpeechSplit };
