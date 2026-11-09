const PRESETS = [
  { id: 'balanced', label: '均衡叙事', description: '对白、必要旁白与可见动作共同推进。' },
  { id: 'narration', label: '旁白讲述', description: '旁白串联故事，保留关键人物对白，画面配合讲述。' },
  { id: 'atmosphere', label: '氛围慢节奏', description: '以可见行动和氛围为主，允许有意义的停顿。' },
];
function parse(value) { try { return typeof value === 'string' ? JSON.parse(value) : value || {}; } catch { return {}; } }
function normalize(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('叙事风格参数无效');
  // Retire the old choice without leaving existing projects with an invalid setting.
  const selected = raw.preset === 'dialogue_fast' ? 'balanced' : raw.preset || 'balanced';
  const preset = PRESETS.find(p => p.id === selected);
  if (!preset) throw new Error('未知叙事风格');
  // Speech speed control was retired: narrative presets affect writing/editing
  // rhythm only. Keep canonical legacy fields so old rows and callers remain
  // readable, but never let saved multipliers reach TTS or H3.
  return { preset: preset.id, speech_rate: 1, speech_mode: 'fixed' };
}
function fromMetadata(metadata) {
  const meta = parse(metadata);
  return normalize(meta.narrative_style || { preset: 'balanced', speech_rate: meta.tts_dubbing?.speed ?? 1 });
}
function withConfig(cfg, metadata) { return { ...cfg, narrative_style: fromMetadata(metadata) }; }
function mergeMetadata(existing, patch) {
  patch = parse(patch);
  const merged = { ...parse(existing), ...patch };
  if (Object.hasOwn(parse(patch), 'narrative_style')) {
    merged.narrative_style = normalize(patch.narrative_style);
    merged.tts_dubbing = { ...parse(existing).tts_dubbing, ...patch.tts_dubbing, speed: merged.narrative_style.speech_rate };
  }
  return merged;
}
function directorPrinciples() {
  return `
【通用导演原则 / UNIVERSAL DIRECTING PRINCIPLES】
适用于全部题材、视觉风格和叙事偏好。剧情信息优先通过人物对白或必要旁白让观众听懂，画面动作负责让已说清的事件变得可见；不要让观众靠猜测动作、道具、小字或表情来补全关键因果。不强制每镜有台词，也不把纯物理事件硬塞成对白。
每个情节承接上一段的结果并触发下一段，明确动机、选择与后果。同一信息只交代一次；新写剧情去除冗余，已有剧本台词仍逐字保留。对白长度服从剧情，不要求每句简短（longer lines allowed）。动作与节奏应服务因果推进；一个完整因果节拍可以在同一外层分镜内包含多个紧密相连的身体动作，但可以在 video_slots.shots_timeline 中写成一个连续动作节拍，也可以按真实机位、说话人或信息变化拆成多个正整数秒节拍；每个节拍都要让画内角色有动作、表情或因果反应。不得用“说一句话后互相看着”、无意义特写、空等或静止倾听填满剩余时长，也不得为了“一个动作一个外层镜头”机械拉长剧情。
两人对话优先采用有叙事作用的正反打或过肩反打，但它是镜内剪辑语言，不要求每句台词新建外层分镜；只有信息交接、关键反应、权力变化或轴线变化才切换。禁止用“说一句话后互相看着”、无意义特写或空等填满剩余时长；台词结束后的动作必须来自剧本因果，没有动作依据就让镜头在事件完成处结束。
只有发生说话人切换、场景或时间变化、空间轴线重大变化，或动作/对白确实超过单镜时长上限时才拆镜；需要拆台词时在语义边界（semantic boundaries）处理。拆镜后必须写清上一镜的结束状态、本镜的进入状态和因果承接。
按剧情需要规划每位画内人物的起始状态、动作过程、互动对象与结束状态；说明谁对谁说话、视线落点、听者为何反应。说话与动作可以同时发生，台词结束后继续完成本镜事件，或明确保持状态的剧情理由。不能把所有听者写成无反应的背景人。
迟疑或沉默可以是有意的叙事选择，但不能在 H3 时间线里成为没有动作合同的填充段；每个动作节拍仍需写清角色的可见动作、表情变化或因果反应。不为填满时长重复动作或拉长停顿，不根据台词里的动词擅自执行未来承诺、回忆或假设。
镜头按实际台词和必要动作分配时间，不添加固定的收尾静音。拿到实际 TTS 时长后，以实测为依据复核对白与动作时间线；若超出项目时长范围，返回导演 Agent 调整或按语义拆镜，后端不得静默删字、改动作或加速。
Maintain a coherent causal chain in every genre. Put essential motives, choices, rules and consequences into natural dialogue or concise narration when the image alone would make the audience guess; let visible action support the spoken information. Meaningful silent physical events remain allowed. Longer lines are allowed when the story needs them. One shot may contain several tightly linked physical beats in the same space, and should not be split mechanically into one action per shot. Split only for a speaker/scene/time/axis change or a real duration limit. After a split, state the previous end state and the current entry state explicitly. Speech and action may overlap; continue the intended event after speech finishes. Preserve existing dialogue verbatim. Reconcile measured TTS duration with the action timeline; return conflicts to the Director rather than silently rewriting content.
`;
}
function instructions(cfg) {
  const rawStyle = cfg?.narrative_style || {};
  const s = normalize(rawStyle);
  const modes = {
    balanced: '对白优先的均衡叙事 / DIALOGUE-FIRST BALANCED: 用自然对白或必要旁白交代关键因果，再用紧凑可见动作支撑；不机械地给每个动作拆镜，不用镜头动作替代剧情信息。',
    narration: '旁白讲述 / NARRATION-LED: 旁白串联背景、因果与进展，人物对白用于关键冲突与情绪；画面配合讲述，旁白与对白不复述同一信息。 Narration connects context and causality; retain key character dialogue and avoid duplicated information.',
    atmosphere: '氛围慢节奏 / ATMOSPHERIC: 允许有叙事作用的动作、反应和停顿，用简单可生成画面呈现氛围；关键因果仍须能理解，不用连续微动作或难以辨认的小字代替情节。 Allow meaningful pauses and visual atmosphere while keeping essential causality understandable.',
  };
  return `${directorPrinciples()}\n【项目叙事风格 / PROJECT NARRATIVE STYLE】\n${modes[s.preset]}\n人物对白与旁白的时长按实际 TTS 配置计算；IndexTTS 未配置时默认 1.25x，其他引擎按配置读取。叙事风格只控制内容与剪辑节奏，Agent 不自行改变声音倍率。${require('./speechDeliveryService').planningInstructions({ ...s, tts_speed: rawStyle.tts_speed })}\n服装连续性始终生效：同一人物在连续剧情中沿用当前造型；换场景或换集本身不表示换装。只有原剧情明确换装、穿越、梦境、闪回或时间跳转，才在新分镜开始前切换造型，并在返回原时间线时恢复对应造型。每个人物在同一分镜只用一套造型，首尾帧与视频全程一致；需要表现换装时必须拆成多个连续分镜，不做镜内变装。 Preserve wardrobe across continuous events and scene/episode cuts; establish a wardrobe change only from explicit story evidence.`;
}
function h3Delivery(settings) {
  normalize(settings || {});
  return 'Use clear delivery at the configured TTS speed (IndexTTS defaults to 1.25x when unset), with pauses appropriate to the scene and complete intelligible lines. Use this configured rate consistently for every line.';
}
module.exports = { PRESETS, parse, normalize, fromMetadata, withConfig, mergeMetadata, instructions, h3Delivery, directorPrinciples };
