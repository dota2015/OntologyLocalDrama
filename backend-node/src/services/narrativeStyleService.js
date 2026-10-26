const PRESETS = [
  { id: 'dialogue_fast', label: '对白驱动·快节奏', speed: 1.25, speech_mode: 'auto', description: '对白推动因果与冲突，剧情连贯紧凑，少重复解释、少空镜。' },
  { id: 'balanced', label: '均衡叙事', speed: 1, description: '对白、必要旁白与可见动作共同推进。' },
  { id: 'narration', label: '旁白讲述', speed: 1.2, description: '旁白串联故事，保留关键人物对白，画面配合讲述。' },
  { id: 'atmosphere', label: '氛围慢节奏', speed: 1, description: '以可见行动和氛围为主，允许有意义的停顿。' },
];
function parse(value) { try { return typeof value === 'string' ? JSON.parse(value) : value || {}; } catch { return {}; } }
function normalize(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('叙事风格参数无效');
  const preset = PRESETS.find(p => p.id === (raw.preset || 'balanced'));
  if (!preset) throw new Error('未知叙事风格');
  const speed = Number(raw.speech_rate ?? preset.speed);
  if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) throw new Error('目标语速需在 0.5～2 倍之间');
  const mode = raw.speech_mode ?? 'fixed';
  if (!['auto','fixed'].includes(mode)) throw new Error('请选择自动或固定语速');
  return { preset: preset.id, speech_rate: Math.round(speed * 100) / 100, speech_mode: mode };
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
function instructions(cfg) {
  const s = normalize(cfg?.narrative_style || {});
  const modes = {
    dialogue_fast: '对白驱动·快节奏 / DIALOGUE-DRIVEN FAST: 主要通过人物对白推进冲突、动机、选择与后果，旁白只补不可替代的信息。画面承载说话、反应与必要动作；不为摸橡皮、看时钟、转铅笔等每个小动作拆镜，不堆叠重复反应或纯解释性空镜。每段交流必须推进新信息、冲突、决定或后果，承接上一段的结果并触发下一段；人物动机、地点与时间变化要交代清楚，不跳过关键因果。同一信息只交代一次，不用重复问答、空泛感叹、说教、反复犹豫或旁白复述拖延剧情。合并没有新信息的重复反应，删去不影响理解的过场；新写剧情去除冗余，已有剧本台词仍逐字保留。对白长度由剧情信息和人物情绪决定，允许完整解释、较长台词或多轮交流，不要求每句简短。优先保证动机、因果、选择与后果表达完整。同一空间中能在配置时长预算内完成的一轮交流尽量保留在一个镜头；说不完则按语义衔接拆镜，不能删改原台词。根据必要台词和动作按需分配镜头时长，不为填满时长重复动作或拉长停顿。多人按顺序接话，不重叠抢话。开口及时、接话紧凑、句间短停顿，仍完整清晰发音。 Dialogue carries the plot with a compact causal chain: each exchange advances information, conflict, a decision or its consequence, building on the previous beat and leading to the next. Establish motives and necessary time or location transitions clearly. State each fact once; eliminate repetitive questions, filler reactions, repeated hesitation and duplicated narration in newly written material. Preserve existing source dialogue verbatim. Allocate only the duration needed for the spoken turns and necessary action; maintain prompt responses and meaningful reactions. Minimize explanatory action-only shots and redundant narration. Dialogue need not be short: retain complete explanations, longer lines and multiple turns when the story needs them. Keep a coherent exchange together when the configured duration budget allows; otherwise split at semantic boundaries with exact wording and continuity. Prompt starts, brisk turns and short pauses.',
    balanced: '均衡叙事 / BALANCED: 用自然对白、必要旁白和简单可见动作推进剧情，保持信息清楚；不机械地给每个动作拆镜。 Balance dialogue, necessary narration and simple visible actions.',
    narration: '旁白讲述 / NARRATION-LED: 旁白串联背景、因果与进展，人物对白用于关键冲突与情绪；画面配合讲述，旁白与对白不复述同一信息。 Narration connects context and causality; retain key character dialogue and avoid duplicated information.',
    atmosphere: '氛围慢节奏 / ATMOSPHERIC: 允许有叙事作用的动作、反应和停顿，用简单可生成画面呈现氛围；关键因果仍须能理解，不用连续微动作或难以辨认的小字代替情节。 Allow meaningful pauses and visual atmosphere while keeping essential causality understandable.',
  };
  return `\n【项目叙事风格 / PROJECT NARRATIVE STYLE】\n${modes[s.preset]}\n基准语速 / baseline delivery: ${s.speech_rate}x；${s.speech_mode==='auto'?'逐镜自动规划，具体倍率随台词与情绪变化':'各镜使用固定倍率'}。TTS 按本镜倍率生成，H3 以参考声音和本镜节奏提示引导，不能假定 H3 精确达到倍率。${require('./speechDeliveryService').planningInstructions(s)}\n服装连续性始终生效：同一人物在连续剧情中沿用当前造型；换场景或换集本身不表示换装。只有原剧情明确换装、穿越、梦境、闪回或时间跳转，才在新分镜开始前切换造型，并在返回原时间线时恢复对应造型。每个人物在同一分镜只用一套造型，首尾帧与视频全程一致；需要表现换装时必须拆成多个连续分镜，不做镜内变装。 Preserve wardrobe across continuous events and scene/episode cuts; establish a wardrobe change only from explicit story evidence.`;
}
function h3Delivery(settings) {
  const s = normalize(settings || {});
  const brisk = s.preset === 'dialogue_fast' || s.speech_rate > 1;
  return brisk
    ? `Speak briskly and clearly at a target pace of approximately ${s.speech_rate} times ordinary delivery, with prompt speech onset, short natural pauses and tight sequential turn-taking. Complete each spoken line intelligibly and preserve the ending beat.`
    : `Use clear natural delivery at a target pace of approximately ${s.speech_rate} times ordinary speech, with pauses appropriate to the scene and complete intelligible lines.`;
}
module.exports = { PRESETS, parse, normalize, fromMetadata, withConfig, mergeMetadata, instructions, h3Delivery };
