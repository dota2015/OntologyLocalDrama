// Shared by story expansion, storyboard generation and the prompt editor.
function english(cfg) { return (cfg?.app?.language || 'zh').toLowerCase() === 'en'; }

function storytellingRules(cfg) {
  return baseStorytellingRules(cfg) + require('./narrativeStyleService').instructions(cfg);
}

// Script composition can simplify newly written action. Storyboard breakdown
// still preserves the approved script and every existing spoken line.
function storyExpansionRules(cfg) {
  const common = storytellingRules(cfg) + (english(cfg) ? `
[STABLE CHARACTER NAMES — script writing only]
Before writing, silently establish a consistent name and identity for each important individual. Reuse supplied personal names and established game names/callsigns exactly; do not shorten, respell or rename them unless the user explicitly requests it. A callsign such as Red Wolf is already a valid fixed character name.
When an important individual is identified only as Mother, Younger Sister or a similar relationship title, establish an appropriate fixed personal name in the new script, unless the user explicitly requires anonymity. Introduce the name together with the relationship at the first appearance, then use that name consistently in action descriptions and dialogue speaker labels across every episode. Family titles can remain in spoken words. For legacy title-only catalog entries, clearly connect the new name to that existing role instead of inventing another person. Never change a name that is already established in the premise or prior episodes.
Keep real-world people and their game counterparts distinct unless the premise explicitly makes them the same identity: describe who controls an avatar or who resembles whom once, and label speech with the identity currently on screen. A resemblance does not justify merging two characters.
Do not turn anonymous enemy forces, crowds or background gunfire into named individual characters, invent dialogue for them or expand their biographies merely to populate a cast. A genuinely individualized antagonist may be named when the story requires it. Silently check that all important dialogue speakers have consistent names; return only the required episode JSON, without a separate cast list.` : `
【固定人物姓名——仅用于剧本创作】
写作前内部确定每位重要个体的固定姓名与身份。优先复用用户梗概、本剧角色及前文已明确的姓名，逐字保持一致，不随意省姓、换字或另起名，除非用户明确要求更名。红狼、蜂医、露娜等已确定的游戏名或代号本身就是有效角色名，无须强行改成现实姓名。
重要人物若只以妈妈、妹妹等关系称谓出现，在新剧本中为其明确一个合适且固定的姓名（用户明确要求匿名时除外），首次出场以“姓名（某人的妈妈／妹妹）”交代关系，后续动作描述和对白说话人标签统一用该姓名，所有集次保持一致。台词正文仍可自然称呼“妈妈、哥哥”等。本剧旧角色若仅以称谓保存，首次介绍要明确新姓名对应这个已有身份，不另造一个人；已有确定姓名的角色不得重新起名。
现实人物与游戏映射人物分别标名；仅在梗概明确同一身份时才作为同一人。说明操控或相貌映射关系一次即可，谁在当前场景实际说话就用谁的角色名，不能因长得像就把妈妈与蜂医、妹妹与露娜合并。
敌人、敌军、围观者等未个体化的群体，以及背景枪声，不为凑角色而起名、添加独立对白或扩写成个人传记；确有独立身份与剧情需要的反派才建立固定姓名。输出前内部检查重要对白说话人姓名是否完整一致，只返回规定的分集JSON，不额外输出人物表。`);
  return common + (english(cfg) ? `
[GENERAL SCRIPT COMPOSITION — before storyboard breakdown]
Build each dramatic beat around an event that changes information, a decision, relationship or outcome. Choose dialogue, action, narration or meaningful silence according to the story; conversations are not mandatory for every beat. Dialogue may include complete explanations and multiple turns; do not pad the episode with speeches or force every line to be short.
Keep action economical and easy to generate. Retain necessary danger, rescue and turning points, but condense routes, minor obstacles, equipment handling and repeated attempts into the essential decision and visible result. Do not expand a simple setback into a chain of running, climbing, alarm triggers, closing gates, blocked paths and elaborate rescue choreography merely to fill the episode.
Keep a coherent exchange in one space and timeline where possible. Switch between reality, a game, dreams or flashbacks only when the switch changes information, decisions or consequences. Do not interrupt a scene for every reaction or explanatory remark. Preserve any explicitly established crossing; never invent a physical crossing merely because the genre is fantasy. Preserve the user's character-to-avatar mappings and world relationships, and make necessary identity connections understandable without repeatedly announcing them.
Let characters disagree, negotiate, ask for help, choose and react to consequences. State each rule, cause or lesson once through the person who needs to say it. Do not add several supporting characters explaining the same mistake in turn, or narration repeating dialogue. Keep emotional reactions that change the relationship or next choice.
Necessary rules, choices, consequences and cliffhangers must be understandable; use speech when the visual event alone is unclear, and do not force dialogue into clear silent action; a readable backpack inventory, map, subtitle, reflection or facial expression cannot be their only explanation. Complement clear words with a simple visible event rather than narrating every obvious action.
Before returning the script, silently remove redundant explanations, unnecessary world switches and action chains without new causal information. Preserve the core plot, important events, character mappings and episode continuity; do not output this review or turn the script into shot-by-shot timing instructions.` : `
【通用剧本组织——在拆分镜之前生效】
1. 每个情节节拍围绕推动信息、决定、关系或后果的事件，根据剧情选择对白、动作、旁白或有意义的沉默；不要求每一拍都有交流。允许完整解释、较长台词和多轮交流；不靠堆对白凑篇幅，也不要求每句简短。
2. 动作集中在关键节点：保留必要的危险、救援和转折，把路线移动、次要障碍、装备操作、重复尝试压缩为关键选择与可见结果。不要为扩写篇幅，把一次受阻铺成奔跑、翻越、警报、落门、封路、折返、复杂救援的连续动作链；每次动作都须产生新的因果信息。
3. 一轮完整交流尽量留在同一空间与时间线。现实、游戏、梦境、闪回之间，仅在带来新信息、改变决定或展示后果时切换，不为每次反应或点评来回跳转。保留原文明确的穿越设定；不能仅因选择“奇幻”就擅自添加肉身进入游戏。保持用户明确的人物与游戏身份映射、世界关系，必要的身份联系应让观众理解，不反复点名解释映射。
4. 用人物间的争论、协商、求助、选择及其代价推进剧情。同一条规则、原因或道理，由最需要说的人讲清一次；不要让多个配角轮流总结同一个错误，不让旁白重复对白。保留会影响人物关系或下一步选择的情绪反应。
5. 关键规则、选择、后果和结尾悬念须能理解；画面难以表达时用对白或旁白补足，清楚的无对白事件可以保持安静。不能只靠背包界面、地图小字、点题字幕、倒影或微表情表达。清楚的台词配合简单可见事件，不把显而易见的每个动作都口头复述。
6. 输出前内部检查并删去重复解释、无必要的时间线切换，以及没有新增因果信息的动作链。保留核心情节、重要事件、人物映射与上下集衔接；不输出检查过程，不在剧本阶段写成逐镜秒数清单。`);
}
function baseStorytellingRules(cfg) {
  if (english(cfg)) return `
[STORY COMPREHENSION — applies even with custom prompts]
Convey essential motives, conflict, rules, choices, consequences and turning points through clear visible events, adding natural dialogue or concise narration when needed. Clear silent action may remain silent. Do not rely solely on subtle gestures, tiny legible text, clocks, symbolic effects or changes in facial expression.
The audience must understand each important causal link without reading the screenplay. Prefer in-character speech; use narration for context, elapsed time or inner states that the image cannot reliably explain. Do not narrate obvious actions, repeat the same information in both voices, or add speech to every transition.
Write speech explicitly as Character: "spoken words" and Narrator: "narration" on separate lines in scripts. Use the established full character names consistently. Labels and delivery instructions are metadata, not spoken words.
Example of procrastination: a boy sits at his desk; he says "I'll play first. Homework can wait." Alternatively the narrator explains that he has put off starting his homework. Do not copy this example into unrelated stories.
46: Use natural, situation-specific dialogue with complete meaning; longer lines, explanations and multi-turn exchanges are allowed when needed. Do not impose short lines or remove essential information to shorten dialogue. Do not fill scripts with image style tokens, camera instructions or generic moral lectures. Preserve the user's plot, character relationships and continuity.
47: Character spatial continuity within scenes: when multiple characters speak or appear consecutively in the same scene, naturally describe their entry, exit, or relative position changes in action (e.g. "peeks out from behind the door", "steps aside to make room", "turns to leave"). Never let a character vanish into thin air or have another instantly substitute their position without physical justification.`;
  return `
【剧情可理解性——自定义提示词也必须遵守】
1. 用清楚可见的事件交代关键动机、冲突、规则、选择、后果和转折，画面不足以表达时用自然对白或简短旁白补足；已能理解的无对白动作可以保持安静。禁止只靠摸橡皮、转铅笔、微表情、钟表、小字、符号变化或特效让观众猜剧情。
2. 检查：观众不读剧本、看不清纸上文字，也应理解关键因果。角色能自然说出的信息优先用对白；时间跳转、背景、难以拍出的心理用必要旁白补足。不要复述显而易见的动作，不要让对白与旁白重复同一信息，也不要给每个过场硬加台词。
3. 剧本中台词单独成行，格式为 角色全名："实际说的话"；旁白单独成行，格式为 旁白："实际解说"。使用已有角色的准确全名，同一人物不换称呼。角色名、语气与动作说明不属于朗读内容。
4. 例如表达拖延：画面只拍少年坐在书桌前；对白可为 "先玩一会儿，作业等会儿再写。"；或用旁白交代他迟迟没有开始作业。按剧情选一种即可，不照抄例子到无关故事。
5. 台词要口语化、有具体对象与缘由，表达完整的动机与因果；允许较长台词、解释或多轮交流，不要求每句简短，不为压字数省略必要信息，避免空泛说教。剧本正文不要混入英文画风词、复杂运镜或生图提示词。保持用户的大纲、人物关系与上下集连续性。
6. 场景内角色进出场空间连续性：同一场景内多角色连续对话或切换出现时，动作中须自然交代角色的进出场与站位变化（如“从门后探出头”、“侧身让出门口”、“转身离开”），严禁在无动作交代的情况下前一人凭空消失、后一人瞬间替代站位。`;
}

function storyboardRules(cfg, includeNarration) {
  const en = english(cfg);
  const mode = includeNarration === undefined ? '' : includeNarration
    ? (en ? '\nNarration is enabled: add it only where needed for comprehension; silent transitions and dialogue-only shots are allowed.' : '\n已允许按需补充旁白：关键背景或因果无法靠画面与对白交代时写 narration；对白已讲清或纯过场时可为空。禁止每镜强制旁白。')
    : (en ? '\nDo not invent new narration in this mode. Preserve explicit narration from the source script; convey missing essential information through natural character dialogue. Never place narrator speech in dialogue.' : '\n未开启补充旁白：保留原剧本明确写出的旁白；新增的必要解释用自然角色对白表达，不得把旁白塞进 dialogue 或仅留在 action。');
  return storytellingRules(cfg) + (en ? `
[GENERATABLE SHOTS AND SPEECH FIELDS — 5 CORE RULES]
1. Causal Beat & Compact Action: one shot carries one understandable causal beat, but may contain several tightly linked physical actions in the same space (for example: run to the cover, see the blast, and stop). Do not split every verb into a new shot. Split only when the speaker, scene/time, screen axis, or real duration limit changes. A complete dialogue may use one continuous static shot; cuts and camera movement are creative choices, not quotas.
2. Ban On-Screen Text/UI for Plot Delivery: strictly forbidden to request rendering timer countdown numbers (e.g. "19 seconds remaining"), screen text, handwriting, or floating UI overlays in action, result, or layout. Such information must 100% be spoken via dialogue or narration.
3. Shot-Reverse-Shot Syntax (avoid multi-character crowding): multi-character interactions (dialogues, confrontations, rescues) must prioritize shot-reverse-shot breakdowns ("subject action in medium/close shot + reactor facial close-up"). Never force 3+ characters into the same medium shot (causes AI face distortion and duplicate figures). Keep major visible characters per shot to <= 2.
4. Pure Physical Visual Description (ban literary metaphors): strictly ban abstract literary metaphors or psychological prose ("contrast of high and low", "frozen anxiety", "abruptly interrupted hope"). Describe ONLY concrete physical postures, spatial positions, and lighting.
5. Spatial Continuity & Anti-Jump-Cut (ban character teleportation and abrupt vanishing): in consecutive shots within the same physical space, strictly forbid abruptly replacing a character standing at a key landmark (e.g. doorframe, desk side) with a new character without spatial/movement justification (e.g. mom standing at doorway in shot 1, then younger sister suddenly standing at the exact same doorway in shot 2). Changing interaction partners must use: (a) angle cut (switch to protagonist's close-up/reverse angle before introducing new character), or (b) physical movement (previous character steps aside/exits, new character peeks in or enters). Never create jarring jump cuts.
6. Preserve source dialogue/narration verbatim. Where essential meaning is only implicit, add natural, sufficiently informative speech consistent with the story without changing facts, adding spoilers or inventing new characters.
7. Keep character speech in dialogue as Character: "words"; keep narrator speech ONLY in narration as plain spoken text, without the Narrator label. Both fields are required strings; use "" when absent. Never hide needed speech only in action, emotion, sound_effect or universal_segment_text. Copy exactly the same speech into the universal text when that mode is enabled.
8. Plan durations within the configured shot range. Dialogue and narration share a sequential speech budget, not parallel full budgets: base rate 4 Chinese characters/second or 2.5 English words/second, adjusted by the per-shot speech pace budget below, reserving at least 1 second for the ending. Split long lines at semantic boundaries without dropping words; do not use forced 5-second clips, accelerated speech or truncated endings.
9. For image prompts, describe a single visible state; speech belongs in the speech fields, not rendered text.` : `
【可生成的分镜五大铁律与语音规范】
1. 动作与节奏、剧情信息：每个分镜聚焦一个能被观众听懂的因果节拍；同一空间内可以承载多个紧密相连的身体动作和即时结果。关键动机、选择、规则、后果和转折必须放入自然对白或必要旁白，不能只藏在 action/result 里。只有说话人、场景/时间、视线轴线重大变化或确实超过4～8秒时才拆镜。按叙事需要选择固定或运动机位，不设固定镜头比例或切镜频率。
2. 禁止画面文字/UI交代剧情（严禁画面小字与UI依赖，纯正面描写）：严禁在 action、result、layout_description 或画面提示词中要求渲染倒计时数字（如“倒计时19秒”）、屏幕文字、作业本字迹、浮动UI界面；此类剧情关键信息 100% 必须由角色对白（dialogue）或旁白（narration）直接说出或念出。提示词中只做纯写实物理正面陈述，绝对禁止在提示词中书写“不出现倒计时/不显示UI”等负向禁令词句。
3. 推行短剧正反打语法（避免全员同框群戏）：多人交互场景（对话、冲突、救援）必须优先拆解为短剧正反打语法：“主体行动中景/近景 + 反应者面部特写”，严禁超过3人塞入同一大中景导致生图人脸崩溃或画面人数错乱失真。单镜出场角色原则上不超过3人（推荐1~2人，至多3人），优先聚焦关键单人。
4. 纯物理视觉描写（严禁文学修辞与心理隐喻）：分镜中的 action、result、layout_description 严禁使用“高低对照”、“焦急凝结”、“心理落差”、“希望被突发打断”、“时间压力凝结”等抽象文学修辞和心理隐喻，只写纯物理姿态、空间相对位置、动作轨迹和真实光影。
5. 镜头间空间连续性与防跳切铁律（严禁角色瞬移与同机位大变活人）：在同一场景中连续切换镜头时，严禁在同一机位/相同取景角度下让上一镜的角色凭空消失并在同位置瞬间变成新角色（如门口上一秒站妈妈、下一秒同机位突然换成妹妹）。更换交互角色时必须：① 切换机位（切主角面部特写/反打，再切新角色进场）；或 ② 动作交代（前一角色侧身让出门口/转身出画，新角色从门后探头或走入）；绝不允许同视角死切硬换人物造成视觉跳切穿帮。
6. 原剧本已有对白和旁白逐字保留；只有画面暗示、却影响理解的关键信息，应补成符合剧情且意思完整的自然对白或必要旁白，不改变事实、不剧透、不凭空增加人物。
7. 每镜必须分别输出 dialogue 与 narration 字符串，无内容填 ""。dialogue 格式为 角色全名："实际台词"，多人物分别标名；narration 只放实际解说正文，不带 "旁白：" 标签。禁止把旁白混入 dialogue，禁止把关键台词仅藏在 action、emotion、sound_effect 或 universal_segment_text；全能片段内的台词须与这两个字段逐字一致。
8. 时长按配置范围按需规划。对白和旁白按顺序共用本镜预算，不各占一整段：自然语速下中文每秒约4字、英文每秒约2.5词，至少留1.5秒收尾。长句在语义边界拆镜并保留全部文字，不固定5秒、不加速硬塞、不截断结尾。
9. 画面只描述可见的简单状态；不要要求把台词、心理或精确文字绘制在图片上。
10. 视听语言视线轴线铁律（参考选择题基准，严禁面向镜头跟空气说话）：对话场景中角色绝对禁止双双正面直视摄影机对着空气说话！建议按电影视听语法设定 dialogue_framing（字典枚举优先作为标准基准参考，支持结合剧情微调）：双人对话优先参考 two_shot_face_to_face（双人面对面对视，视线交汇）或 over_the_shoulder（过肩拍摄，一前一后有纵深）；单人说话镜头优先参考 single_reaction_offscreen（单人身体微侧，眼神专注看向画外搭档，严禁直视镜头）；双人同向看前方威胁参考 joint_observation；单人动作参考 solo_action。允许根据具体剧情进行更精细的镜头设计与扩展。`) + mode;
}

const storyboardBodyZh = `【角色】你是为本地 AI 视频制作短剧的分镜师。
【任务】将剧本按叙事节拍拆分为清楚、可生成、能听懂的分镜。
每镜聚焦一个能被观众听懂的因果节拍，可在同一空间内承载多个紧密相连的动作与明确结果。关键动机、选择、规则、后果和转折必须由对白或必要旁白表达，画面动作负责支撑；不能让观众只靠镜头猜剧情。运镜与切镜由叙事需要决定，固定镜头与安静倾听均有效，不设运镜配额。
【五大分镜铁律】
1. 紧凑因果节拍：1个分镜承载1个观众能听懂的因果节拍，同一空间内允许包含多个紧密相连的身体动作（如“冲向掩体、看见爆炸、停下受击”）。禁止把每个动词机械拆成独立镜头；只有人物/说话人切换、场景或时间变化、视线轴线重大变化，或动作与对白超过4～8秒时才拆镜。拆镜必须写明上一镜结束状态、本镜进入状态和因果关系。
2. 禁止画面文字/UI交代剧情：严禁画面倒计时数字、屏幕文字或UI小字，关键信息100%由角色对白或旁白说出；提示词中做纯正面写实描写，禁止写入“不出现倒计时/文字”等负向禁令词句。
3. 推行短剧正反打：多人交互拆为“主体行动中景 + 反应者特写”，单镜出场角色原则上不超过3人，严禁超过3人塞入同框导致人脸崩溃或画面人数错乱。
4. 纯物理视觉描写：严禁“高低对照”、“焦急凝结”等抽象文学修辞，只写纯物理姿态、空间位置和真实光影。
5. 空间连续与防跳切：同一场景同视角严禁上一镜角色凭空消失、同位置瞬移换人；换人交互须切换机位（如主角反应特写）或动作交代（让出门口/探头走入）。
连续镜头按叙事段落分组，segment_index 从0递增，同段使用相同 segment_title；短剧可用1–3段，较长剧本按情节增加。
emotion 写简短情绪；emotion_intensity 使用3/2/1/0/-1表达强弱。保留剧本完整剧情与所有台词。`;

function storyboardSchema(cfg) {
  const schema = english(cfg)
    ? '\nReturn ONLY valid JSON: {"storyboards":[...]}. Each shot requires shot_number (from 1), segment_index, segment_title, title, shot_type, angle, dialogue_framing, movement, lighting_style, depth_of_field, location, time, scene_id, action, result, dialogue, narration, emotion, emotion_intensity, atmosphere, duration, bgm_prompt, sound_effect, characters, props, is_primary and layout_description. Speech always uses natural 1.0x speed; extend or split shots when the exact dialogue does not fit. Use only supplied IDs. Only for an explicitly scripted wardrobe/time/dream/flashback transition, optionally add wardrobe_change:{boundary:"before_shot",reason,evidence,characters:[{character_id,stage_id,description}]}; evidence must be a verbatim source-script quote establishing that transition. One outfit per character per shot: split costume transitions across separate shots, with the new look established before its shot starts. Use an existing stage_id when available; description is a fallback. Scene/episode changes alone do not establish wardrobe changes. No markdown.'
    : '\n【输出格式】只返回纯JSON对象 {"storyboards":[...]}，不要markdown。每镜包含 shot_number（从1递增）, segment_index, segment_title, title, shot_type, angle, dialogue_framing（视听构图参考，字典仅供启发参考，支持根据剧情自由填写贴切构图）, movement, lighting_style, depth_of_field, location, time, scene_id, action, result, dialogue, narration, emotion, emotion_intensity, atmosphere, duration, bgm_prompt, sound_effect, characters, props, is_primary, layout_description。语音固定为自然语速1.0x，原文台词说不完时延长或拆镜，禁止加速。角色、场景和道具仅使用用户提供的ID。仅在剧本明确换装、梦境、穿越、闪回或时间跳转时可额外输出 wardrobe_change:{boundary:"before_shot",reason,evidence,characters:[{character_id,stage_id,description}]}，evidence 必须逐字引用原剧本中触发造型变化的原文，description 为明确服装；优先选择已有 stage_id，description 仅用于未建立造型时；换装必须拆成旧造型、新造型的连续分镜，同一分镜内不得切换；否则不输出此字段，普通换场景/换集不构成变化。';
  return schema + lightingAndDepth;
}

// Keep vocabulary compatible with the existing lighting/depth controls.
const lightingAndDepth = '\ndialogue_framing（字典仅供参考，不是必须死板填这些固定值，可自由给出贴切的构图描述；常见参考选项：two_shot_face_to_face 双人面对面对视中景 / over_the_shoulder 经典过肩拍 / single_reaction_offscreen 单人近景目光看画外 / joint_observation 双人同向警戒或看大屏 / solo_action 单人动作无对话）. lighting_style: natural/front/side/backlit/top/under/soft/dramatic/golden_hour/blue_hour/night/neon. depth_of_field: extreme_shallow/shallow/medium/deep. movement: push/pull/pan/tilt/tracking/crane_up/crane_dn/orbit/handheld/static（按叙事需要选择，允许static）. Audio: if dialogue is empty, bgm_prompt MUST contain a cinematic background music description for video AI (H3); if dialogue is present, bgm_prompt should be empty "".';

module.exports = { storytellingRules, storyExpansionRules, storyboardRules, storyboardBodyZh, storyboardSchema };
