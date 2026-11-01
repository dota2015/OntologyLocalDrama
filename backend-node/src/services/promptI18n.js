const { storyExpansionRules, storyboardRules, storyboardBodyZh, storyboardSchema } = require('./storytellingPrompts');
// 内存覆盖缓存：key => body（仅存可编辑部分，不含锁定的 JSON 格式要求）
const _overrideCache = {};

function loadOverridesIntoCache(overrides) {
  for (const o of overrides) {
    _overrideCache[o.key] = o.content;
  }
}

function setOverrideInMemory(key, content) {
  _overrideCache[key] = content;
}

function clearOverrideInMemory(key) {
  delete _overrideCache[key];
}

// 与 Go application/services/prompt_i18n.go 对齐：提示词与语言
function getLanguage(cfg) {
  return (cfg?.app?.language || 'zh').toLowerCase();
}

function isEnglish(cfg) {
  return getLanguage(cfg) === 'en';
}

/** 画风由前端写入 dramas.metadata.style_prompt_zh / style_prompt_en，mergeCfgStyleWithDrama 注入 cfg.style */

function styleTextForCfgLang(cfg) {
  const z = (cfg?.style?.default_style_zh || '').trim();
  const e = (cfg?.style?.default_style_en || '').trim();
  const d = (cfg?.style?.default_style || '').trim();
  if (isEnglish(cfg)) return e || d;
  return z || d;
}

function styleTextZhForPolish(cfg) {
  return (cfg?.style?.default_style_zh || cfg?.style?.default_style || '').trim();
}

function styleTextEnForImage(cfg) {
  return (cfg?.style?.default_style_en || cfg?.style?.default_style || '').trim();
}

function getCharacterExtractionPrompt(cfg) {
  const style = styleTextForCfgLang(cfg);
  const imageRatio = cfg?.style?.default_image_ratio || '16:9';
  if (isEnglish(cfg)) {
    return `You are a professional character analyst, skilled at extracting and analyzing character information from scripts.

Your task is to extract and organize character settings for all named characters in the script.

Requirements:
1. Extract all characters with names (ignore unnamed passersby or background characters)
2. For each character, extract:
   - name: Character name
   - role: Character role (main/supporting/minor)
   - appearance: Detailed physical appearance for AI image generation (gender, age, body type, facial features, hairstyle, clothing style — NO scene or background info)
   - description: Brief background and relationships (50-100 words)
3. Main characters need detailed appearance; supporting characters can be simplified
- **Style Requirement**: ${style}
- **Image Ratio**: ${imageRatio}
Output Format:
**CRITICAL: Return ONLY a valid JSON array. Do NOT include any markdown code blocks, explanations, or other text. Start directly with [ and end with ].**
Each element is a character object containing the above fields.`;
  }
  const _charOverride = _overrideCache['character_extraction'];
  if (_charOverride) {
    return _charOverride + `\n- **风格要求**：${style}\n- **图片比例**：${imageRatio}\n输出格式：\n**重要：必须只返回纯JSON数组，不要包含任何markdown代码块、说明文字或其他内容。直接以 [ 开头，以 ] 结尾。**\n每个元素是一个角色对象，包含上述字段。`;
  }
  return `你是一个专业的角色分析师，擅长从剧本中提取和分析角色信息。

**【语言要求】所有字段的值必须使用中文，禁止出现英文内容（role字段的值除外，固定为 main/supporting/minor）。**

你的任务是根据提供的剧本内容，提取并整理剧中出现的所有有名字角色的设定。

要求：
1. 提取所有有名字的角色（忽略无名路人或背景角色）
2. 对每个角色，提取以下信息（全部用中文填写）：
   - name: 角色名字（中文）
   - role: 角色类型，固定值之一：main / supporting / minor
   - appearance: 外貌描述（中文，100-200字，包含性别、年龄、体型、面部特征、发型、服装风格等，不含任何场景或环境信息）
   - description: 背景故事和角色关系（中文，50-100字）
3. 主要角色外貌要详细，次要角色可简化
- **风格要求**：${style}
- **图片比例**：${imageRatio}
输出格式：
**重要：必须只返回纯JSON数组，不要包含任何markdown代码块、说明文字或其他内容。直接以 [ 开头，以 ] 结尾。**
每个元素是一个角色对象，包含上述字段。`;
}

function getStoryboardSystemPrompt(cfg) {
  const base = isEnglish(cfg)
    ? '[Role] You create clear, generatable storyboards for local AI video. Group continuous shots into narrative segments indexed from 0. Give each shot a clear action and result; emotion_intensity is 3/2/1/0/-1.'
    : (_overrideCache['storyboard_system'] || storyboardBodyZh);
  return base + storyboardRules(cfg) + storyboardSchema(cfg);
}

function getUniversalOmniMultiBeatFormatSpec(cfg) {
  const { DEFAULT_LINE3 } = require('./universalOmniMultiBeatFormat');
  if (isEnglish(cfg)) {
    return `
[UNIVERSAL_SEGMENT_TEXT — MULTI-BEAT BLOCK FORMAT ONLY]
FORBIDDEN: legacy single-line rows (主体:/叙事动态:/空间:/[禁BGM]); FORBIDDEN @人物N — use @图片1, @图片2, … only.

Field "universal_segment_text" is a **multi-line string** (use \\n in JSON). Structure:
Line 1: 画面风格和类型: 真人写实, 电影风格, 高清画质, <short style from project>
Line 2: 生成一个由以下M个分镜组成的视频. (M integer 1–8)
Line 3 (copy verbatim): ${DEFAULT_LINE3}
Lines 4..(3+M): 分镜k： Tk秒: <cinematic Chinese prose for that slice; one simple camera move or a fixed view; light; emotion>
Sum(T1..TM) MUST equal this shot's JSON "duration" seconds exactly.

Reference tokens: @图片1 = scene/environment only; @图片2+ = characters in characters[] order; then props if any.
Dialogue: @图片2 says:"verbatim line" or …嗓音…："line". No speech: end with 无对白。
Narration: 旁白（画面无声）："verbatim narration"
Default to M=1 continuous shot with simple action and at most one camera move; fixed views are allowed. Split into extra beats only when the plot requires them, never to fill time.`;
  }
  return `
【universal_segment_text — 多子分镜段落格式（与「生成全能提示词」「润色」完全一致）】
**禁止**使用已废弃的灵境/SoulLens **单行**格式（含「主体：」「叙事动态：」「空间：」「镜头：」段标、行末 [禁BGM][禁字幕]、@人物N 指代参考图）。

本字段为 **多行字符串**（JSON 中用 \\n 换行），结构固定：
第1行：画面风格和类型: 真人写实, 电影风格, 高清画质, <可再加项目风格短语>
第2行：生成一个由以下M个分镜组成的视频。（M 为 1–8 的整数，与下文分镜条数一致）
第3行（必须逐字一致）：${DEFAULT_LINE3}
第4行起：分镜1： T1秒: …、分镜2： T2秒: … … 分镜M： TM秒: …
**硬性约束**：T1+T2+…+TM 必须严格等于本镜 JSON 的 duration（秒）；每行一条子分镜，禁止额外说明行。

子分镜正文写法（电影化中文长句，参考产品范例）：
- **参考图**：仅用 @图片1、@图片2…（阿拉伯数字）；@图片1 只写环境/光影/陈设；角色从 @图片2 起按 characters[] 顺序；有道具则继续 @图片3 …
- **运镜**：每段最多一种连贯动态运镜（微推、后拉、横摇、跟拍、手持呼吸感等），【严格少用定镜/固定镜头】，保持电影动态；默认 M=1 连续镜头，不为凑时长增加子分镜或运镜链。
- **对白**：有 dialogue 时必须写出原文，格式如 @图片2 的嗓音…："对白原文" 或 @图片2 说："对白原文"；无对白则句末写 **无对白。**
- **解说**：有 narration 时写在合适子分镜：**旁白（画面无声）："解说原文"**
- **禁止**：概括式台词（如「他说了一句重要的话」）、@人物N、markdown、SoulLens 段标签

范例结构（勿照抄剧情，仅学排版）：
画面风格和类型: 真人写实, 电影风格, 高清画质, 日本动漫画风
生成一个由以下3个分镜组成的视频。
${DEFAULT_LINE3}
分镜1： 5秒: 镜头从 @图片1 … 无对白。
分镜2： 5秒: … @图片2 …："台词原文"
分镜3： 5秒: … 旁白（画面无声）："解说原文"`;
}

/**
 * 分镜生成「全能分镜模式」：JSON 每镜带 creation_mode + universal_segment_text（多子分镜段落格式）
 */
function getStoryboardUniversalOmniModeSuffix(cfg) {
  const spec = getUniversalOmniMultiBeatFormatSpec(cfg);
  if (isEnglish(cfg)) {
    return `

[HIGHEST PRIORITY — UNIVERSAL OMNI STORYBOARD MODE]
Every shot object MUST also include:
1. "creation_mode": exact string "universal".
2. "universal_segment_text": multi-line block per spec below (NOT a single SoulLens line).
${spec}`;
  }
  return `

【最高优先级——全能分镜模式】
每个镜头在保留上述全部原有字段的同时，还必须额外包含：
1. "creation_mode"：固定字符串 "universal"（不可省略）。
2. "universal_segment_text"：按下列 **多子分镜段落** 规范书写（与后续「生成全能提示词」「润色」同一套版式，禁止单行灵境格式）。
${spec}`;
}

/** 分镜生成勾选「解说旁白」时追加到用户提示词末尾 */
function getStoryboardNarrationExtraInstructions(cfg) {
  return storyboardRules(cfg, true);
}

function getStoryboardNarrationModeInstructions(cfg, enabled) {
  return storyboardRules(cfg, enabled);
}

function formatUserPrompt(cfg, key, ...args) {
  const style = styleTextForCfgLang(cfg);
  const imageRatio = cfg?.style?.default_image_ratio || '16:9';
  const templates = {
    en: {
      character_request: 'Script content:\n%s\n\nPlease extract and organize detailed character profiles for ALL named characters from the script.',
      drama_info_template: `Title: %s\nSummary: %s\nGenre: %s\nStyle: ${style}\nImage ratio: ${imageRatio}`,
      script_content_label: '【Script Content】',
      task_label: '【Task】',
      character_list_label: '【Available Character List】',
      scene_list_label: '【Extracted Scene Backgrounds】',
      task_instruction: 'Break down the script into compact causal beats. Keep tightly linked actions in one shot when they share the same space and event; use dialogue or narration for essential motives, choices and consequences.',
      character_constraint: '**Important** — characters field rules:\n1. Only use character IDs (numbers) from the above character list. Do not invent IDs.\n2. Only include characters who **physically appear and act** in this specific shot. Do NOT list characters who are merely mentioned, offscreen, or appear in the overall scene but not in this shot.\n3. The number of characters listed must match who is described in the action/dialogue fields. If the action only describes one person, list only that one character.\n4. **Shot Character Limit**: Focus each shot on 1-2 core characters maximum. Do NOT crowd 3+ characters into a single shot; split group scenes into shot-reverse-shot or coverage angles.',
      scene_constraint: '**Important**: In the scene_id field, select the most matching background ID (number) from the above background list. If no suitable background exists, use null.',
      prop_list_label: '【Available Prop List】',
      prop_constraint: '**Important** — props field rules:\n1. Only use prop IDs (numbers) from the above prop list. Do not invent IDs.\n2. Only include props that are **visually present and actively used or prominently featured** in this specific shot.\n3. If no props from the list appear in the shot, use an empty array [].\n4. **Shot Prop Limit**: Include at most 1 key prop actively used or featured; ambient environment items (e.g. crates, tables, doors) must NOT be added as props.',
      frame_info: 'Shot information:\n%s\n\nPlease directly generate the image prompt for the first frame without any explanation:',
      key_frame_info: 'Shot information:\n%s\n\nPlease directly generate the image prompt for the key frame without any explanation:',
      last_frame_info: 'Shot information:\n%s\n\nPlease directly generate the image prompt for the last frame without any explanation:',
      shot_description_label: 'Shot description: %s',
      scene_label: 'Scene: %s, %s',
      characters_label: 'Characters: %s',
      action_label: 'Action: %s',
      result_label: 'Result: %s',
      dialogue_label: 'Dialogue: %s',
      atmosphere_label: 'Atmosphere: %s',
      shot_type_label: 'Shot type: %s',
      angle_label: 'Angle: %s',
      movement_label: 'Movement: %s',
      storyboard_count_constraint: '**Constraint**: Total shot count must be around %s (allow ±20%). Please merge or split actions to meet this requirement.',
      video_duration_constraint: '**Constraint**: Total video duration must be around %s seconds (allow ±10%). Please adjust shot count and duration to meet this requirement.',
    },
    zh: {
      character_request: '剧本内容：\n%s\n\n请提取剧本中所有有名字角色的设定。',
      drama_info_template: `剧名：%s\n简介：%s\n类型：%s\n风格: ${style}\n图片比例: ${imageRatio}`,
      script_content_label: '【剧本内容】',
      task_label: '【任务】',
      character_list_label: '【本剧可用角色列表】',
      scene_list_label: '【本剧已提取的场景背景列表】',
      task_instruction: '将剧本按紧凑的因果节拍拆解为分镜头方案：同一空间内的连续动作尽量合并，关键动机、选择与后果用对白或必要旁白说清。',
      character_constraint: '**重要** — characters字段填写规则：\n1. 只能使用上述角色列表中的角色ID（数字），不得自创ID。\n2. 只填写在**本镜头中实际出现并有具体行为**的角色。不要把"提到的"、"画面外的"、或整个场景里有但本镜头动作中未描述的角色也列进去。\n3. characters数量必须与action/dialogue中实际描写的人物数量一致。如果action只描述了一个人的动作，characters里就只填那一个人的ID。\n4. 【单镜头角色控制】：每个镜头必须聚焦 1~2 个核心主体角色（严禁单镜头堆砌 3 个以上角色；若遇多人场景，必须按正反打、过肩或反应镜头拆分成多个连续分镜）。',
      scene_constraint: '**重要**：在scene_id字段中，必须从上述背景列表中选择最匹配的背景ID（数字）。如果没有合适的背景，则填null。',
      prop_list_label: '【本集可用道具列表】',
      prop_constraint: '**重要** — props字段填写规则：\n1. 只能使用上述道具列表中的道具ID（数字），不得自创ID。\n2. 只填写在**本镜头中视觉上出现并被使用或显著展示**的道具。\n3. 如果本镜头中没有列表中的道具出现，则填空数组[]。\n4. 【单镜头道具控制】：每镜最多只填 1 个有特写或关键交互的核心道具；场景固有的大环境物品（如货箱、桌椅、地面、门窗）严禁作为道具添加。',
      frame_info: '镜头信息：\n%s\n\n请直接生成首帧的图像提示词（JSON 的 prompt 字段必须全文中文），不要任何解释：',
      key_frame_info: '镜头信息：\n%s\n\n请直接生成关键帧的图像提示词（JSON 的 prompt 字段必须全文中文），不要任何解释：',
      last_frame_info: '镜头信息：\n%s\n\n请直接生成尾帧的图像提示词（JSON 的 prompt 字段必须全文中文），不要任何解释：',
      shot_description_label: '镜头描述: %s',
      scene_label: '场景: %s, %s',
      characters_label: '角色: %s',
      action_label: '动作: %s',
      result_label: '结果: %s',
      dialogue_label: '对白: %s',
      atmosphere_label: '氛围: %s',
      shot_type_label: '景别: %s',
      angle_label: '角度: %s',
      movement_label: '运镜: %s',
      storyboard_count_constraint: '**重要约束**：总分镜数量必须控制在 %s 个左右（允许 ±20% 的偏差）。请务必合并或拆分动作以满足此数量要求。',
      video_duration_constraint: '**重要约束**：视频总时长必须控制在 %s 秒左右（允许 ±10% 的偏差）。请调整分镜数量和单镜时长以满足此要求。',
    },
  };
  const lang = isEnglish(cfg) ? 'en' : 'zh';
  const t = templates[lang][key] || templates.zh[key];
  if (!t) return args[0] != null ? String(args[0]) : '';
  let i = 0;
  return t.replace(/%[sd]/g, () => (args[i] != null ? String(args[i++]) : ''));
}

/** 分镜用户提示词后缀：详细输出格式与要求
 * @param {object} cfg - 配置对象
 * @param {number|null} shotDuration - 单镜建议时长（秒），由后端从项目配置或总时长/数量推算后注入
 */
function getStoryboardUserPromptSuffix(cfg, shotDuration) {
  const lang = isEnglish(cfg) ? 'en' : 'zh';
  const durationHint = shotDuration && Number.isFinite(Number(shotDuration)) && Number(shotDuration) > 0
    ? Number(shotDuration)
    : null;
  if (lang === 'en') {
    const durationInstruction = durationHint
      ? `approximately ${durationHint}s per shot (project setting), adjust ±1s based on dialogue length and action complexity`
      : 'estimate per shot from dialogue length, action complexity, and emotion';
    return `

**Four Core Storyboard Rules**:
1. Compact Causal Beat: one shot carries one understandable causal beat, and may contain several tightly linked physical actions, dialogue, and immediate reactions in the same space. Do not split every verb, line, or reaction into its own shot. Split only for a speaker/subject change, scene or time change, major eyeline/axis change, or a real 4-8 second capacity limit. Every split must state the previous shot's end state, this shot's entry state, and the causal link.
2. Ban On-Screen Text/UI: Strictly forbidden to request countdown timers, UI overlays, or screen text in action/result/layout. Deliver via dialogue/narration.
3. Vertical Drama Shot-Reverse-Shot Syntax: Prioritize subject action + reactor close-up. Avoid 3+ characters crowded in one shot. Keep characters per shot <= 2.
4. Pure Physical Description: Strictly ban literary metaphors ("frozen anxiety", "contrast of high and low"). Concrete postures and positions only.

**dialogue field**: "Character: \"line\"". Multiple: "A: \"...\" B: \"...\"". Monologue: "(Monologue) content". No dialogue: "".

**scene_id**: Select the most matching background ID from the scene list above, or null if none suitable.

**duration (seconds)**: ${durationInstruction}.

**Audio rule**: For shots WITH dialogue, focus on character speech clarity and diegetic foley in sound_effect (keep bgm_prompt as ""). For shots WITHOUT dialogue (silent beats, action, suspense, environment, tension), **MUST provide bgm_prompt** describing cinematic background music matching the shot's mood (e.g. "tense low-frequency synth pulse with heartbeat percussion", "gentle piano and cello", "driving cinematic drums", etc.) so that video AI (like MiniMax-H3) synthesizes native background music.

**Output**: JSON with "storyboards" array. Each item: shot_number, segment_index, segment_title, title, shot_type, angle, time, location, scene_id, movement, lighting_style, depth_of_field, action, dialogue, narration, result, atmosphere, emotion, duration, bgm_prompt, sound_effect, characters (array of IDs), props (array of prop IDs), is_primary. Return ONLY valid JSON, no markdown.`;
  }
  const _sbUserLocked = `\n\n【输出格式】请以JSON格式输出，包含 "storyboards" 数组。每个镜头包含：shot_number, segment_index, segment_title, title, shot_type（大远景/远景/中景/近景/特写）, angle（运镜机位与视角，如 平视/低角仰拍/高角俯拍/斜侧45度/过肩背拍等，视角富有层次）, dialogue_framing（视听构图参考：字典仅供启发参考非必选死板值，如 two_shot_face_to_face/over_the_shoulder/single_reaction_offscreen/joint_observation/solo_action 等，支持结合剧情自由扩充）, time, location, scene_id, movement（运镜，从 push/pull/pan/tilt/tracking/crane_up/crane_dn/orbit/handheld/static 选择；按剧情需要选择，static固定机位与连续镜头均可使用，不设比例或固定切镜频率）, lighting_style（灯光风格，从 natural/front/side/backlit/top/under/soft/dramatic/golden_hour/blue_hour/night/neon 选择）, depth_of_field（景深，从 extreme_shallow/shallow/medium/deep 选择）, action, dialogue, narration, result, atmosphere, emotion, duration, bgm_prompt（无对白镜头必填背景音乐描述，供H3等模型合成配乐；有对白填空串""）, sound_effect, characters（角色ID数组）, props（道具ID数组）, is_primary, **layout_description（画面布局与人物站位描述，必填，最高优先级空间合同）**。**必须只返回纯JSON，不要markdown。**`;
  const _sbUserOverride = _overrideCache['storyboard_user_suffix'];
  if (_sbUserOverride) {
    return '\n\n' + _sbUserOverride + _sbUserLocked;
  }
  const durationInstruction = durationHint
    ? `每镜头约${durationHint}秒（项目配置），综合对话、动作、情绪可适当调整±1秒`
    : '综合对话、动作、情绪估算每镜时长（秒）';
  return `

【分镜四大硬性铁律（必须遵守，违反即不合格）】
1. **紧凑因果节拍**：1个分镜承载1个观众能听懂的因果节拍，同一空间内允许包含多个紧密相连的身体动作（如“冲向掩体、看见爆炸、停下受击”）。关键动机、选择、规则、后果和转折必须放入自然对白或必要旁白，不能只藏在 action/result 里。禁止把每个动词机械拆成独立镜头；只有人物/说话人切换、场景或时间变化、视线轴线重大变化，或动作与对白超过4～8秒时才拆镜。拆镜必须写明上一镜结束状态、本镜进入状态和因果关系。
2. **禁止画面文字/UI交代剧情，提示词纯正面陈述**：严禁在 action、result、layout_description 或画面提示词中要求渲染倒计时数字（如“倒计时19秒”）、屏幕文字、作业本字迹、浮动UI界面；此类信息 100% 必须由角色对白（dialogue）或旁白（narration）直接说出。提示词中只正向描述真实环境与动作，**绝对禁止将“不出现倒计时/不显示文字”等负向禁令短语写入提示词**。
3. **推行短剧正反打语法与电影化视听设计（根据人物关系规划视线）**：多人交互场景（对话、冲突、救援）必须优先拆解为“主体行动中景/近景 + 反应者面部特写”，严禁超过3人塞入同一大中景导致生图人脸崩溃或画面人数错乱。单镜出场角色原则上不超过3人（推荐1~2人，至多3人），优先聚焦关键单人。**视线轴线铁律（字典仅供参考启发，严禁正脸对空气讲话）**：角色严禁双双正脸面对镜头对空气说话！建议参考电影视听模式填写 dialogue_framing（字典枚举仅供模型参考启发，不是必须填这些固定词，可根据剧情自由给出贴切构图）：① two_shot_face_to_face（双人面对面对视中景，微侧身左看右、右看左，视线交汇形成闭环）；② over_the_shoulder（过肩拍，前景露出肩背，焦点在后景角色）；③ single_reaction_offscreen（单人特写/近景，眼神专注看画外搭档，严禁直视镜头）；④ joint_observation（双人同向警戒/看前方目标）；⑤ solo_action（单人无对话动作）等。**机位角度多样化**：对话/对峙穿插低角仰拍（压迫感）、高角俯拍（弱势/全局）、斜侧45°，拒绝全篇千篇一律正面平视；**机位与节奏由剧情决定**：可以保持固定镜头呈现完整对白、安静倾听与反应，也可以按信息变化切镜。不设固定镜头比例或强制切镜频率。
4. **纯物理视觉描写**：分镜中严禁使用“高低对照”、“焦急凝结”、“心理落差”、“希望被突发打断”等抽象文学修辞和心理隐喻，只写纯物理姿态、空间相对位置和真实光影。

【分镜要素】每个分镜聚焦一个叙事节拍（单一连续画面，可包含多个紧密相连动作），描述要具体、紧凑，避免为填充时长重复动作：
1. **镜头标题(title)**：用3-5个字概括该镜头的核心内容或情绪
2. **时间**：[清晨/午后/深夜/具体时分+详细光线描述]
3. **地点**：[场景完整描述+空间布局+环境细节]
4. **镜头设计**：**景别(shot_type)**、**镜头角度(angle)**、**运镜方式(movement)**、**灯光风格(lighting_style)**、**景深(depth_of_field)**
5. **人物行为**：**详细动作描述**
6. **对话/独白**：提取该镜头中的完整对话或独白内容（如无对话则为空字符串）
7. **画面结果**：动作的即时后果+视觉细节+氛围变化
8. **环境氛围**：光线质感+色调+声音环境+整体氛围
9. **声音设计（核心铁律）**：
   - **有对白分镜**：bgm_prompt 填空字符串""，让位于角色说话清晰度；sound_effect 写现场环境声、动作音效、对白/旁白音色（如低沉、沙哑、颤抖、冷静、急促等）和口型同步要求。
   - **无对白分镜（纯动作/环境/对峙/潜伏/发现/定格等）**：**必须填写 bgm_prompt（背景音乐描述）**，给出符合该镜头情节与情绪的电影配乐风格（如“低沉紧迫的战术电子合成脉冲与心跳低音”、“激昂爆发的打击乐重音”、“冷峻悬疑的环境低频嗡鸣”、“轻柔舒缓的大提琴独奏”等），供 H3 视频模型原生生成高质量背景音乐！
10. **观众情绪**：[情绪类型]（[强度：↑↑↑/↑↑/↑/→/↓]）

**【最高优先级空间合同 - layout_description（必填，最高优先级铁律）】**
这是本分镜的**核心空间锚点 + 真实物体尺度 + 运镜呼吸空间**铁律，用于 H3 FL2VA 的首帧/尾帧图片生成，在保持一致性的同时为运镜留出必要空间：

- 必须明确写出**主要角色在画面中的核心站位**（画面左/中/右三分、朝向、与关键道具的基本空间关系）。这是硬性锁定。
- **必须同时写出所有主要道具的真实物理尺度与相对比例**（仅描述本分镜/剧本中实际出现的道具，尺度须符合其所属时代与场景；例如古代场景写案几高度、书卷尺寸、铜器体量等，现代场景写对应家具与小物件真实尺寸；所有道具均为次要环境元素）。严禁任何会导致AI把道具做大、立起或当成主导元素的描述；**严禁写入与时代背景不符的道具**（古代/古装分镜不得出现智能手机、遥控器、现代茶几等现代物品）。
- 必须写明**整体构图方式和基本机位距离感**（中景、三分法等）。
- **必须为 declared movement（运镜方式）预留电影化演化空间**：明确说明首尾帧在核心站位和真实尺度保持一致的前提下，允许根据 movement 进行自然的取景微调（例如：缓推时尾帧可比首帧稍紧；手持时允许轻微取景晃动与不完美平衡；横摇/跟拍时允许画面左右自然的进入/退出变化）。目标是让首尾帧既像“同一场同一空间的连续镜头”，又能真正支持运镜产生动态视频，而不是变成几乎定格的画面。
- **严禁写入会导致比例失真或完全锁死运镜的表述**（即使剧本里有相关描述也禁止）："道具作为视觉焦点/占画面主导"、"手持晃动带来纪实感"、"完全相同的构图平衡"等。
- 好示例（古代场景，带运镜空间）："主角坐画面左中榻上，是绝对视觉焦点；右下前景木质案几高约75cm，书卷平放于案面为正常尺寸，铜灯与茶具均为次要环境小物件，绝不可夸大；中景，三分法构图，核心平衡稳定。若 movement 为缓推，尾帧允许人物在画面中占比自然增加、背景稍被压缩；若为手持，允许轻微取景不完美偏移。"
- **执行原则**：首帧按此锚点生成初始画面；尾帧必须保持核心站位、角色与道具的真实尺度与基本空间关系，仅根据 movement 和 result 进行自然的取景演化。违背核心锁定 = 失败；完全没有运镜演化空间也属于不合格结果。

**dialogue字段说明**：角色名："台词内容"。无对话时填空字符串""。
**scene_id**：从上方场景列表中选择最匹配的背景ID，如无合适背景则填null。
**duration时长**：${durationInstruction}。
**声音一致性**：有对白镜头优先保证人声清晰；无对白镜头必须配上精准契合情节情绪的背景音乐描述(bgm_prompt)，以便视频模型合成原声配乐。

【输出格式】请以JSON格式输出，包含 "storyboards" 数组。每个镜头包含：shot_number, segment_index, segment_title, title, shot_type, angle, time, location, scene_id, movement, lighting_style, depth_of_field, action, dialogue, narration, result, atmosphere, emotion, duration, bgm_prompt, sound_effect, characters（角色ID数组）, props（道具ID数组）, is_primary。**必须只返回纯JSON，不要markdown。**`;
}

/**
 * 真实物理尺度铁律 — 时代/场景自适应，专治布局描述冲突与跨时代道具幻觉
 */
function getRealisticPhysicalScaleContract(isEn) {
  if (isEn) {
    return `【HIGHEST PRIORITY REALISTIC PHYSICAL SCALE & PROPORTION CONTRACT — ERA-AWARE, ABSOLUTE OVERRIDE】
Every visible object in the scene MUST be rendered at 100% correct real-world physical dimensions for its era/setting, with correct relative proportions and accurate photographic perspective. This rule has HIGHER PRIORITY than any conflicting instruction in the layout_description / spatial anchor above.
CRITICAL RULES:
- **Era fidelity (MANDATORY)**: Props MUST match the story's time period and location. In ancient/historical/costume drama scenes, NEVER include smartphones, remote controls, modern coffee tables, A4 books, or any anachronistic modern items. Only describe props that actually belong in this shot according to the script and scene context.
- **Scale only for props actually present**: For each major prop visible in the frame, state realistic size relative to the human figure and environment (e.g. ancient: writing desk ~70–85 cm, scroll ~25–35 cm; modern: side table ~38–52 cm, small handheld device lying flat at true size). Never invent props not in the shot.
- **Secondary props**: The human character is the ONLY primary visual subject. All props are strictly secondary environmental elements — never oversized, never upright as dominant elements, never breaking perspective.
- If layout_description contains scale-distorting phrases, IGNORE those implications and follow era-appropriate realistic scale and "secondary prop" rules above.
This contract applies to BOTH first frame and last frame with zero exception.
Violation (anachronistic props, oversized objects, broken perspective, props as dominant elements) = critical generation failure.`;
  }
  return `【最高优先级真实物理尺度与道具比例铁律 — 时代自适应，绝对覆盖，违反即严重失败】
本分镜内所有可见物体必须100%遵循其所属时代/场景的真实世界物理尺寸、正确相对比例和电影摄影透视法则。本铁律的优先级绝对高于上方布局描述中任何可能导致比例失真的表述。
【关键规则（即使布局描述写得有问题也必须遵守）】
- **时代一致性（强制）**：道具必须严格符合剧本设定的时代背景。古代/古装/架空历史场景中**严禁**出现智能手机、遥控器、现代茶几、A4书籍、平板等任何现代物品；只描述本分镜中实际存在且符合时代的道具。
- **仅描述画面内实际道具的尺度**：对每个主要道具写出相对人体与环境的合理真实尺寸（例如古代：案几高约70-85cm、书卷长约25-35cm、铜镜直径约15-20cm；现代：边桌高约38-52cm等），不得凭空添加剧本未出现的道具。
- **次要环境元素**：角色是画面中唯一的首要视觉主体和焦点；所有道具均为严格次要的小型环境元素，不得夸大、立起成为主导视觉、或破坏透视。
- 若布局描述中有会导致不真实尺度的表述，必须忽略其对物体尺寸和透视的影响，只严格执行本铁律中符合时代的真实尺度与「次要道具」要求。
本铁律同时适用于首帧和尾帧生成，零例外。
任何生成结果出现时代错乱道具、物体过大失真、透视错误、道具成为主导元素，均视为严重失败。`;
}

function getFirstFramePrompt(cfg) {
  const style = isEnglish(cfg) ? styleTextEnForImage(cfg) : styleTextZhForPolish(cfg);
  const imageRatio = cfg?.style?.default_image_ratio || '16:9';
  if (isEnglish(cfg)) {
    return `You are a professional cinematic storyboard image prompt expert. Generate AI image generation prompts based on the shot information provided.

Important: This is the FIRST FRAME - a completely static image showing the initial state BEFORE the action begins.

Core Rules:
1. Static initial state only - the moment before any action
2. NO movement or action descriptions
3. Describe character's initial posture, screen position (left/center/right), and expression
4. ONLY characters listed in "ALLOWED CHARACTERS IN THIS SHOT" may appear — never add unlisted characters
5. For each allowed character write ONLY "Name (use appearance from reference image)" plus position/posture/expression/props — NEVER put hair, face, skin, makeup, or temperament inside parentheses or anywhere else. Scene/environment lines must contain ZERO human appearance descriptions
6. Include character appearance details if provided (ONLY fixed identity anchors from the provided CHARACTER VISUAL ANCHORS block. Copy exactly the traits listed there. NEVER hallucinate new hair style/color/length, face shape, expression details, or temperament not explicitly present in the anchor. If no detailed anchor is provided for a character, write only "Name (use appearance from reference image)" and add ZERO invented visual details)

Cinematic Language (must apply):
- COMPOSITION: Choose based on shot type: Rule of Thirds (subject at grid intersections), Frame Composition (use doors/windows/branches as natural frame), Center Composition (symmetrical, ceremonial), Foreground Layering (blurred foreground for depth)
- LIGHTING: Specify light source direction (left/right/top/backlight/bottom), quality (hard light=dramatic shadows / soft light=natural warmth), color temperature (warm=golden/orange, cool=blue/cyan)
- DEPTH OF FIELD: Close-up/medium-close=shallow DOF, background blur; Medium shot=medium DOF; Long shot/wide=deep DOF, full scene clarity
- CHARACTER POSITION: Describe placement in frame, facing direction (toward/away from camera/profile), body language
- **Style Requirement**: ${style}
- **Image Ratio**: ${imageRatio}
Output Format:
Return a JSON object containing:
- prompt: Complete image generation prompt (detailed cinematic description)
- description: Simplified Chinese description (for reference)`;
  }
  const _ffLocked = `\n- **风格要求**：${style}\n- **图片比例**：${imageRatio}\n输出格式：\n返回一个JSON对象，包含：\n- prompt：完整的中文图片生成提示词（详细的电影语言描述）\n- description：简化的中文描述（供参考）`;
  const _ffOverride = _overrideCache['first_frame_prompt'];
  if (_ffOverride) {
    return _ffOverride + _ffLocked;
  }
  const ffScaleContract = getRealisticPhysicalScaleContract(false);
  return `你是一个专业的电影分镜图像生成提示词专家。请根据提供的镜头信息，生成适合AI图像生成的提示词。

重要：这是镜头的首帧 - 一个完全静态的画面，展示动作发生之前的初始状态。

${ffScaleContract}

核心规则：
1. 聚焦初始静态状态 - 动作发生之前的那一瞬间，禁止包含任何动作或运动描述
2. 描述角色在画面中的位置（画面左/中/右）、朝向（面向/背对/侧面）、初始姿态和表情
3. 【出场角色铁律】仅允许 CONTEXT 中「本分镜允许出场的角色」名单内的人物出现；名单外角色严禁写入 prompt（不得出现其名字、站位、动作、表情）
4. 【角色外貌写法铁律 - 违反即失败】每个允许出场的角色在 prompt 中**只能**写为「角色名（参考图中的人物形象）」+ 画面位置 + 姿态 + 表情 + 手持道具；括号内及前后**严禁**写发型、发色、发长、五官、面容、眉眼、轮廓、肤质、妆容、气质等任何外貌词。**禁止**把锚点/appearance 里的外貌特征抄进 prompt（图生图由参考图锁定外貌）
5. 【场景描写铁律】「场景为…」「环境…」等空间/环境句**严禁**出现任何人物外貌描写，只写空间、道具、光线、氛围
6. 如 CONTEXT 提供了角色视觉锚点，仅供理解身份，**不得**将锚点内容写入 prompt 正文
7. 【严禁文学隐喻修辞】严禁使用“高低对照”、“焦急凝结”、“心理落差”等抽象修辞，只写纯物理姿态、位置、空间和光影
8. 【严禁画面文字与UI，纯正面物理描写】严禁出现“倒计时”、“悬浮界面”、“剩余xx秒”、“屏幕小字”等UI或文字元素；画面只做纯写实物理场景。**严禁在 prompt 中写入“不出现文字/无倒计时”等负向排除句**，只正向描述客观存在的实体与光影。
9. 【空间连续与防跳切】若当前分镜动作描述新角色进入房间或开口发言，应正面描述其自然的入画站位与空间关系（例如“角色从侧旁进门”、“站在门侧向室内张望”），避免生硬覆盖导致视觉瞬移。

【电影语言规范（必须应用）】

构图规则（根据景别选择）：
- 三分法：主体置于三分线交点，稳定平衡，适合大多数叙事镜头
- 框架构图：用门窗/树枝/栏杆形成自然画框，突出主体，增加纵深
- 中心构图：对称庄重，适合特写和仪式感场景
- 前景遮挡：前景虚化元素增加层次感

光线设计（必须描述）：
- 光源方向：左侧光/右侧光/顶光/逆光（轮廓光）/底光
- 光线质感：硬光（强烈阴影，戏剧张力）/ 柔光（柔和过渡，自然温馨）
- 色温：暖光（金黄/橙红，温暖怀旧）/ 冷光（蓝调/青白，冷漠疏离）

景深设置：
- 特写/近景：浅景深，背景虚化，突出人物情绪
- 中景：中等景深，人物与环境均清晰
- 远景/全景：深景深，前后均清晰，交代空间关系
- **风格要求**：${style}
- **图片比例**：${imageRatio}

【5层结构输出格式 + 尺度强制要求】
返回JSON对象，prompt 字段按以下5层顺序拼接成**中文**，各层间用中文逗号「，」分隔（不加「第1层」等层标签文字）。**在第3层“内容焦点”中必须包含一段符合时代背景的真实物体尺度描述**（仅写本分镜实际出现的道具；古代场景示例：“所有道具严格符合古代真实物理比例，案几高约75cm，书卷为正常尺寸平放于案面，铜灯与茶具均为次要环境小物件，绝不可夸大，主角为绝对视觉焦点”）。
第1层-镜头设计：景别 + 机位角度 + 构图方式（如「中景，平视角度，三分法构图」）
第2层-光线：光源方向 + 光线质感 + 色温（如「左侧柔暖光，黄金时刻暖调」）
第3层-内容焦点：角色（仅「名字（参考图中的人物形象）」+初始姿态+表情，不写外貌）+ 场景环境关键细节（不含人物外貌） + **必须包含真实物体尺度描述（见上方强制要求）**
第4层-氛围：情绪基调 + 色彩倾向（如「安静紧张氛围，低饱和冷色调」）
第5层-视觉风格：${style ? style + '，' : ''}电影分镜质感，${imageRatio} 画幅，高清细节，所有物体严格真实尺度

JSON字段：
- prompt：**必须全文中文**的图片生成提示词（直接给图片AI使用；禁止整句英文，仅允许必要风格专有名如 realistic 等单个词；必须自然融入符合时代的真实尺度描述，严禁时代错乱道具或物体过大失真）
- description：一句话中文描述（供人类参考）`;
}

function getKeyFramePrompt(cfg) {
  const style = isEnglish(cfg) ? styleTextEnForImage(cfg) : styleTextZhForPolish(cfg);
  const imageRatio = cfg?.style?.default_image_ratio || '16:9';
  if (isEnglish(cfg)) {
    return `You are a professional cinematic storyboard image prompt expert. Generate AI image generation prompts based on the shot information provided.

Important: This is the KEY FRAME - capturing the most intense and climactic moment of the action.

Core Rules:
1. Focus on the peak moment of the action - maximum dramatic tension
2. Capture the emotional climax - character's most expressive state
3. Can include dynamic effects (motion blur, impact lines, visual tension)
4. Include character appearance details if provided (ONLY fixed identity anchors from the provided CHARACTER VISUAL ANCHORS block. Copy exactly the traits listed there. NEVER hallucinate new hair style/color/length, face shape, expression details, or temperament not explicitly present in the anchor. If no detailed anchor is provided for a character, write only "Name (use appearance from reference image)" and add ZERO invented visual details)
5. Show character's body language and expression at climax

Cinematic Language (must apply):
- COMPOSITION: For action/climax - diagonal composition (dynamic tension, leads viewer's eye), Dutch angle (unease/intensity for conflict scenes), over-shoulder (confrontation/dialogue tension)
- LIGHTING: Dramatic lighting for peak moments - rim light separating subject from background, strong chiaroscuro (light/shadow contrast), or explosive bright key light for revelations
- DEPTH OF FIELD: Usually shallow to isolate the critical action; deep for wide action involving environment
- EMOTIONAL COLOR: Warm saturated (passion/anger), cool desaturated (shock/loss), high contrast (climax/confrontation)
- **Style Requirement**: ${style}
- **Image Ratio**: ${imageRatio}
Output Format:
Return a JSON object containing:
- prompt: Complete image generation prompt (detailed cinematic description)
- description: Simplified Chinese description (for reference)`;
  }
  const _kfLocked = `\n- **风格要求**：${style}\n- **图片比例**：${imageRatio}\n输出格式：\n返回一个JSON对象，包含：\n- prompt：完整的中文图片生成提示词（详细的电影语言描述）\n- description：简化的中文描述（供参考）`;
  const _kfOverride = _overrideCache['key_frame_prompt'];
  if (_kfOverride) {
    return _kfOverride + _kfLocked;
  }
  return `你是一个专业的电影分镜图像生成提示词专家。请根据提供的镜头信息，生成适合AI图像生成的提示词。

重要：这是镜头的关键帧 - 捕捉动作最激烈、情绪最饱满的高潮瞬间。

核心规则：
1. 聚焦动作高潮时刻，最大化戏剧张力
2. 捕捉情绪顶点，角色表情和肢体语言处于最强烈状态
3. 可包含动态效果（动作模糊、视觉冲击感）
4. 【出场角色铁律】仅允许「本分镜允许出场的角色」名单内人物；名单外角色严禁出现
5. 【角色外貌写法铁律】每个角色只写「名字（参考图中的人物形象）」+ 姿态 + 表情，严禁外貌描写；锚点内容不得写入 prompt
6. 【场景描写铁律】环境/场景句严禁人物外貌描写
7. 展示角色高潮状态下的肢体姿态和神情

【电影语言规范（必须应用）】

构图规则（高潮/动作场景）：
- 对角线构图：强烈动态感，视觉引导，适合冲突/行动镜头
- 荷兰角/斜角：不安感和紧张感，适合对峙/心理冲击场景
- 过肩镜头：适合对话高潮、面对面对峙

光线设计（高潮时刻）：
- 轮廓光：将主体从背景中分离，突出人物
- 强烈明暗对比（硬光）：戏剧张力，冲突感
- 爆发性亮光：适合揭示真相、情绪爆发时刻
- 色温情绪化：暖色饱和（激情/愤怒）/ 冷色低饱和（震惊/失落）

景深与色调：
- 通常使用浅景深聚焦关键动作，隔离背景
- 高对比度色调强化高潮感
- **风格要求**：${style}
- **图片比例**：${imageRatio}

【5层结构输出格式 + 尺度强制要求】
返回JSON对象，prompt 字段按以下5层顺序拼接成**中文**，各层间用中文逗号「，」分隔（不加层标签文字）。**在第3层“内容焦点”中必须包含一段符合时代背景的真实物体尺度描述**（仅写本分镜实际出现的道具，严禁写入与时代不符的现代物品）。
第1层-镜头设计：景别 + 机位角度 + 构图方式（如「特写，低角度，对角线构图」）
第2层-光线：光源方向 + 光线质感 + 色温（如「轮廓光，强明暗对比，暖色饱和」）
第3层-内容焦点：角色（仅「名字（参考图中的人物形象）」+高潮姿态+情绪表情）+ 场景关键细节（不含外貌） + **必须包含真实物体尺度描述**
第4层-氛围：情绪基调 + 色彩倾向（如「激烈对峙，高对比，鲜艳饱和色调」）
第5层-视觉风格：${style ? style + '，' : ''}电影分镜质感，${imageRatio} 画幅，动态张力，所有物体严格真实尺度

JSON字段：
- prompt：**必须全文中文**的图片生成提示词（直接给图片AI使用；禁止整句英文；必须自然融入真实尺度描述）
- description：一句话中文描述（供人类参考）`;
}

function getLastFramePrompt(cfg) {
  const style = isEnglish(cfg) ? styleTextEnForImage(cfg) : styleTextZhForPolish(cfg);
  const imageRatio = cfg?.style?.default_image_ratio || '16:9';
  if (isEnglish(cfg)) {
    return `You are a professional cinematic storyboard image prompt expert. Generate AI image generation prompts based on the shot information provided.

Important: This is the LAST FRAME - a purely STATIC snapshot showing the final state AFTER the action ends.

Core Rules:
1. PURE FREEZE-FRAME SNAPSHOT: The prompt must describe a single instantaneous still moment in time.
2. STRICT BAN ON TRANSITIONAL / PROCESS VERBS:
   - Strictly FORBIDDEN to use phrases like "turning from X to Y", "changing from standing to lying down", "propping up and then turning", or describing action progression.
   - Each character MUST have exactly ONE determined, unambiguous static posture and ONE expression. NEVER describe two states for the same character (violating this causes diffusion models to duplicate the person into multiple figures).
3. STRICT BAN ON META-COMMENTARY AND EVOLUTION EXPLANATIONS:
   - Strictly FORBIDDEN to write editorial commentary such as "first and last frame differences are formed by...", "after 5-15s clip maintains angle without artificial panning", or "action evolves naturally". Image generation diffusion models are spatial-only and will hallucinate malformed artifacts from such text.
4. Show the visible result/consequence of the action as a static scene.
5. Describe character's final posture, position, and emotional expression.
6. Emphasize the emotional aftermath - relief, tension, sadness, triumph.
7. ONLY characters in "ALLOWED CHARACTERS IN THIS SHOT" may appear; write each as "Name (use appearance from reference image)" plus position/posture/expression only — no hair/face/skin in scene or character lines.
8. Include character appearance details if provided (ONLY fixed identity anchors from the provided CHARACTER VISUAL ANCHORS block. Copy exactly the traits listed there. NEVER hallucinate new hair style/color/length, face shape, expression details, or temperament not explicitly present in the anchor. If no detailed anchor is provided for a character, write only "Name (use appearance from reference image)" and add ZERO invented visual details).
9. CORE POSITION + SCALE LOCK:
   - Must keep core character screen placement (left/center/right third, facing), realistic physical sizes of all props, and basic spatial relationships consistent with the layout contract (no left-right swaps, no scale distortion).
   - If camera movement changes framing (e.g. push-in), simply specify the tighter shot type directly (e.g. close-up) without verbally explaining the transition.

Cinematic Language (must apply):
- COMPOSITION: Specific composition of this final static moment.
- LIGHTING: Reflect emotional aftermath - soft warm light (resolution/comfort), lingering dramatic shadows (unresolved tension), fading light (loss/ending).
- DEPTH OF FIELD: Shallow for intimate emotional close, deep for consequential wide shots showing impact on environment.
- CHARACTER POSITION: Single exact static resting posture/expression per RESULT.
- ATMOSPHERE: Describe color tone and mood that carries the emotional weight of the scene's conclusion.
- **Style Requirement**: ${style}
- **Image Ratio**: ${imageRatio}
Output Format:
Return a JSON object containing:
- prompt: Complete image generation prompt (detailed cinematic description of the final static freeze-frame). Strictly no meta-text, no action transition descriptions.
- description: Simplified Chinese description (for reference)`;
  }
  const _lfLocked = `\n- **风格要求**：${style}\n- **图片比例**：${imageRatio}\n输出格式：\n返回一个JSON对象，包含：\n- prompt：完整的中文图片生成提示词（详细的电影语言描述）\n- description：简化的中文描述（供参考）`;
  const _lfOverride = _overrideCache['last_frame_prompt'];
  if (_lfOverride) {
    return _lfOverride + _lfLocked;
  }
  const lfScaleContract = getRealisticPhysicalScaleContract(false);
  return `你是一个专业的电影分镜图像生成提示词专家。请根据提供的镜头信息，生成适合AI图像生成的提示词。

重要：这是镜头的尾帧 - 一个纯静态画面，展示动作结束后的最终定格状态和结果。

【最高优先级真实物理尺度与道具比例铁律】（详见本分镜“空间布局锚点”中的完整铁律）
本分镜内所有可见物体必须100%遵循其所属时代/场景的真实世界物理尺寸、正确相对比例和电影摄影透视法则；仅描述实际出现的道具，严禁时代错乱物品。所有道具均为次要环境元素。

核心规则：
1. 【纯静态定格快门铁律（Freeze Frame）】尾帧是快门按下一瞬的纯静态照片。只能描述该瞬间视觉上能直接看到的画面，绝对不要描述时间的流逝或动态演变。
2. 【严禁时间流动与时态转换动词（严重违反会导致画面出现多个人/重影）】
   - 严禁出现“由……转为……”、“从……变为……”、“撑起后……”、“身体转向……”、“动作发生前/后”等任何状态转变动词！
   - 每个出场角色必须且只能有唯一确定的最终姿态和单一表情（例如：直接写“某角色倒卧在地面，双目闭合，表情痛苦”，严禁写“某角色由站姿变为倒卧”）。
3. 【严禁首尾对比与运镜元指令】
   - 严禁在 prompt 里写入“首尾视觉差异由……形成”、“五至十五秒镜头结束后……”、“保持原机位不虚构推拉摇移”、“动作结果自然演化”等任何对比解释或导演元指令！生图模型只接收画面实体描述，此类文字会严重扰乱生图质量。
4. 展示动作的可见结果和后果（最终静态画面）
5. 描述角色在动作完成后的最终姿态、位置和情绪表情
6. 强调情绪余韵：释然/平静/悲伤/胜利/遗憾
7. 【出场角色铁律】仅允许「本分镜允许出场的角色」名单内人物；名单外角色严禁出现
8. 【角色外貌写法铁律】每个角色只写「名字（参考图中的人物形象）」+ 唯一最终姿态 + 单一表情，严禁外貌描写；锚点不得写入 prompt
9. 【场景描写铁律】环境/场景句严禁人物外貌描写
10. 【人物站位铁律】如果提供了首帧参考图或空间布局锚点，必须保持核心站位、真实物理尺度、基本空间关系与透视一致（主要角色不左右互换、主要道具不大幅移位、所有物体真实尺寸不变）。如因运镜（例如推镜）导致取景更紧，直接在第1层写更紧的景别（如近景/特写），严禁在正文中用文字解释演化。
11. 【严禁文学隐喻修辞】严禁使用“高低对照”、“焦急与时间压力凝结”、“希望被突发打断”、“心理落差”等抽象文学修辞，只写纯物理姿态、空间相对位置与真实光影
12. 【严禁画面文字与UI元素，纯正面物理描写】严禁在尾帧画面中添加“倒计时界面”、“悬浮UI”、“剩余xx秒”或屏幕小字，画面只呈现真实的物理环境与人物定格。**严禁在成文里书写“不出现文字/无倒计时”等负向排除短语**。

【电影语言规范（必须应用）】

构图规则（收尾镜头）：
- 收尾镜头必须在核心站位、真实物体尺度、基本空间关系上与首帧保持一致（硬锁）。
- 直接描述尾帧时刻的最终景别和机位，严禁大幅移动主要角色或道具位置、破坏真实尺度或透视。

光线设计（情绪余韵）：
- 柔和暖光：事件解决后的温情/宽慰
- 残留戏剧阴影：未解决的张力，悬念延续
- 渐弱光线/冷调：失去/结束/遗憾的情绪
- 色调整体偏暗或偏亮反映情绪归宿

景深与氛围：
- 情绪收场：浅景深，聚焦面部情绪细节
- 结果展示：深景深，展示行动对环境/他人的影响
- 整体色调和氛围承载本镜头情绪的收尾重量
- **风格要求**：${style}
- **图片比例**：${imageRatio}

【5层结构输出格式 + 尺度强制要求】
返回JSON对象，prompt 字段按以下5层顺序拼接成**中文**，各层间用中文逗号「，」分隔（不加层标签文字）。**在第3层“内容焦点”中必须包含一段符合时代背景的真实物体尺度描述**。
第1层-镜头设计：景别 + 机位角度 + 构图方式（直接写尾帧时刻的确定镜头设计）
第2层-光线：光源方向 + 光线质感 + 色温
第3层-内容焦点：角色（仅「名字（参考图中的人物形象）」+唯一最终静态姿态+单一情绪表情，严禁时态转换词）+ 场景道具最终静态位置（不含人物外貌） + **必须包含真实物体尺度描述**
第4层-氛围：情绪基调 + 色彩倾向
第5层-视觉风格：${style ? style + '，' : ''}电影分镜质感，${imageRatio} 画幅，所有物体严格真实尺度

JSON字段：
- prompt：**必须全文中文**的纯静态图片生成提示词（直接给图片AI使用；禁止整句英文；必须自然融入真实尺度描述；严禁包含任何首尾对比说明或时态过渡动词）
- description：一句话中文描述（供人类参考）`;
}

/** 道具提取系统提示词（system prompt，剧本内容由 user prompt 单独传入） */
function getPropExtractionPrompt(cfg) {
  const base = styleTextForCfgLang(cfg);
  const propExtra = (cfg?.style?.default_prop_style || '').toString().trim();
  const style = [base, propExtra].filter(Boolean).join(', ');
  const imageRatio = cfg?.style?.default_prop_ratio || cfg?.style?.default_image_ratio || '16:9';
  if (isEnglish(cfg)) {
    return `You are a professional script prop analyst, skilled at extracting key props with visual characteristics from scripts.

Your task is to extract and organize all key props that are important to the plot or have special visual characteristics from the provided script content.

[Requirements]
1. Extract ONLY key props that are important to the plot or have special visual characteristics.
2. Do NOT extract common daily items (e.g., normal cups, pens) unless they have special plot significance.
3. If a prop has a clear owner, note it **only** in "description" (Chinese OK). **Never** put character names, nicknames, or relationship words in "image_prompt".
4. "image_prompt" must be **English**, written as a **professional catalog / product-hero** shot for a single prop: describe shape, material, color, wear, scale cues, and finish in detail.
5. In "image_prompt" you **must** specify: **one seamless solid-color studio backdrop** (matte, no gradient), **only the prop as the sole subject**, **soft even studio lighting** (readable micro-detail, no dramatic movie lighting), and explicitly forbid people, hands, furniture, floors, tables, scenery, packaging (unless the prop *is* the package), text, logos, dust/debris, or any secondary objects.
6. **No script leakage in "image_prompt"**: forbid character names, place names, organization names, dialogue, plot beats, and other **original-script identifiers**. Replace with generic visual terms (e.g. "engraved serif lettering" instead of a name). The **only** exception is text that is **visibly printed or engraved on the prop itself** as part of its graphic design—describe that text generically if possible ("small engraved inscription") unless the script explicitly requires exact wording on the object.
7. **Strict, non-expanding "image_prompt"**: include **only** attributes grounded in the script or the "description" you output—**no** invented accessories, era/brand backstory, mood adjectives unrelated to materials, or "hero story" filler. Prefer a **tight** prompt over a long one.
- **Style Requirement**: ${style}
- **Image Ratio**: ${imageRatio}

[Output Format]
**CRITICAL: Return ONLY a valid JSON array. Do NOT include any markdown code blocks, explanations, or other text. Start directly with [ and end with ].**
Each object containing:
- name: Prop Name
- type: Type (e.g., Weapon/Key Item/Daily Item/Special Device)
- description: Role in the drama and visual description
- image_prompt: English hero product shot prompt (single prop, solid seamless backdrop, no clutter, no environment, soft studio light, tight wording, no names/places from script, ultra-detailed only where visually grounded)`;
  }
  const _propLocked = `\n- **风格要求**：${style}\n- **图片比例**：${imageRatio}\n\n【输出格式】\n**重要：必须只返回纯JSON数组，不要包含任何markdown代码块、说明文字或其他内容。直接以 [ 开头，以 ] 结尾。**\n每个对象包含：\n- name: 道具名称\n- type: 类型 (如：武器/关键证物/日常用品/特殊装置)\n- description: 在剧中的作用和中文外观描述（人名、归属可写在此字段，勿写入 image_prompt）\n- image_prompt: 单道具主图提示词（纯色无缝背景、仅主体、无杂物无场景、柔和棚拍光；**禁止**剧本人名/地名/组织名/台词/剧情标签；只写有依据的外观词，**不脑补、不扩写**；中文项目输出中文提示词并匹配项目「语音」与尺度铁律）`;
  const _propOverride = _overrideCache['prop_extraction'];
  if (_propOverride) {
    return _propOverride + _propLocked;
  }
  return `你是一位专业的剧本道具分析师，擅长从剧本中提取具有视觉特征的关键道具。

你的任务是根据提供的剧本内容，提取并整理所有对剧情有重要作用或有特殊视觉特征的关键道具。

要求：
1. 只提取对剧情发展有重要作用、或有特殊视觉特征的关键道具。
2. 普通的生活用品（如普通的杯子、笔）如果无特殊剧情意义不需要提取。
3. 若道具有明确归属者，**仅**写在 "description" 中（可用中文人名）；**禁止**在 "image_prompt" 中出现任何角色名、昵称、称谓或人际关系用语。
4. **description 字段强制纯中文**：必须输出**纯中文、80-150字**的详细视觉外观描述 + 该道具在剧中的核心作用/归属/剧情功能。必须严格遵循本项目一贯的中文影视提示词「语音」：融入符合道具所属时代的真实物理尺度意识、材质工艺细节、磨损痕迹、柔和棚拍光质感、电影化构图暗示。严禁任何英文单词/句子，严禁只写剧情不写可用于画图的外观细节，严禁空泛或翻译腔。
5. "image_prompt" 按项目语言撰写（**中文项目必须输出纯中文提示词**、英文项目用英文），按**影视资产库 / 电商主图级**单道具产品照标准：写清轮廓、材质、颜色、磨损与工艺细节、体量感。必须完整匹配项目中文影视提示词「语音」（融入真实尺度铁律、次要道具原则、电影化细节、纯色无缝背景、柔和均匀棚光）。
6. "image_prompt" 中**必须**写明：**单一无缝纯色棚拍背景**（哑光、无渐变）、**画面中仅有该道具一个主体**、**柔和均匀的棚拍光**（便于看清细节，避免电影化强反差光），并**明确禁止**：人物、手、家具、地面/台面、室内外环境、散落杂物、其他道具、文字商标、包装（除非该道具本身就是包装）、烟尘粒子等任何多余元素。
7. **image_prompt 禁止泄漏剧本特征**：不得出现剧本人名、地名、组织名、台词、情节梗专有称呼等；一律改写为**泛化视觉描述**（如用 "刻有细小铭文" 而非具体人名）。**唯一例外**：文字**实体印/刻在道具表面**且剧本明确要求还原该字样时，可保留该可见字样；否则用泛化描述。
8. **image_prompt 严格不扩展**：只写剧本与你在本对象 "description" 中已交代、且**肉眼可见**的外观信息；禁止凭空增加配饰、品牌故事、时代煽情形容词、叙事性铺垫；宁可**短而准**，不要为凑字数扩写。必须自然融入「符合时代的真实物理比例」等项目铁律。
- **风格要求**：${style}
- **图片比例**：${imageRatio}

【输出格式】
**重要：必须只返回纯JSON数组，不要包含任何markdown代码块、说明文字或其他内容。直接以 [ 开头，以 ] 结尾。**
每个对象包含：
- name: 道具名称
- type: 类型 (如：武器/关键证物/日常用品/特殊装置)
- description: **纯中文**的在剧中的作用 + 详细视觉外观描述（必须80-150字，严格遵循项目中文提示词语音：真实尺度、次要元素、电影化细节等）
- image_prompt: **纯中文**（中文项目）单道具主图提示词（纯色无缝背景、仅主体、无杂物无场景、柔和棚拍光；融入项目真实尺度铁律与次要道具语音；无剧本人名地名等；只写有依据的外观词，简练不扩写）`;
}

function getSceneExtractionPrompt(cfg, style) {
  const styleText = (style || '').toString().trim();
  const s = styleText || styleTextForCfgLang(cfg);
  const imageRatio = cfg?.style?.default_image_ratio || '16:9';
  if (isEnglish(cfg)) {
    return `[Task] Extract all unique scene backgrounds from the script

[Requirements]
1. Identify all different scenes (location + time combinations) in the script
2. Generate detailed **English** image generation prompts for each scene
3. **Important**: Scene descriptions must be **pure backgrounds** without any characters, people, or actions
4. Prompt requirements:
   - Must use **English**, no Chinese characters
   - Detailed description of scene, time, atmosphere, style
   - Must explicitly specify "no people, no characters, empty scene"
   - **Style Requirement**: ${s}
   - **Image Ratio**: ${imageRatio}

[Output Format]
**CRITICAL: Return ONLY a valid JSON array. Do NOT include any markdown code blocks. Start directly with [ and end with ].**
Each element: location, time, prompt (English image generation prompt for pure background).`;
  }
  const _sceneLocked = `\n5. **风格要求**：${s}\n   - **图片比例**：${imageRatio}\n\n【输出格式】\n**重要：必须只返回纯JSON数组，不要包含任何markdown代码块。直接以 [ 开头，以 ] 结尾。**\n每个元素包含：location（地点）, time（时间）, prompt（完整的中文图片生成提示词，纯背景，明确说明无人物）。`;
  const _sceneOverride = _overrideCache['scene_extraction'];
  if (_sceneOverride) {
    return _sceneOverride + _sceneLocked;
  }
  return `【任务】从剧本中提取所有唯一的场景背景

【要求】
1. 识别剧本中所有不同的场景（地点+时间组合）
2. 为每个场景生成详细的**中文**图片生成提示词（Prompt）
3. **重要**：场景描述必须是**纯背景**，不能包含人物、角色、动作等元素；只做纯写实物理环境与光影的正面陈述，**严禁在 prompt 中写入“不出现文字/无倒计时/无UI”等负向禁令词句**
4. **重要**：prompt 字段必须为中文，不得使用英文（风格词如 realistic 可保留）
5. **风格要求**：${s}
   - **图片比例**：${imageRatio}

【输出格式】
**重要：必须只返回纯JSON数组，不要包含任何markdown代码块。直接以 [ 开头，以 ] 结尾。**
每个元素包含：location（地点）, time（时间）, prompt（完整的中文图片生成提示词，纯背景，明确说明无人物）。`;
}

/**
 * 故事扩展：根据梗概生成短片剧本正文（中英文系统提示词）
 */
function getStoryExpansionSystemPrompt(cfg, episodeCount) {
  const n = Number(episodeCount) > 1 ? Number(episodeCount) : 1;
  const jsonNote = `\n\n**输出格式（必须严格遵守）**：\n返回一个 JSON 数组，包含 ${n} 个对象，每个对象格式如下：\n[\n  {\n    "episode": 1,\n    "title": "第一集标题（5-10字，概括本集核心内容）",\n    "content": "本集剧本正文（约800字）"\n  }\n]\n**必须只返回纯 JSON 数组，不要任何 markdown 代码块、说明文字。直接以 [ 开头，以 ] 结尾。**`;
  if (isEnglish(cfg)) {
    const enNote = `\n\n**Output format (STRICTLY required)**:\nReturn a JSON array with ${n} object(s), each in this format:\n[\n  {\n    "episode": 1,\n    "title": "Episode title (5-15 words)",\n    "content": "Episode script body (~800 words)"\n  }\n]\n**Return ONLY the JSON array. No markdown, no explanation. Start directly with [ and end with ].**`;
    return `You are a professional screenwriter. Your task is to expand the user's story premise into ${n} episode(s) of a short-film script.

Requirements:
1. Write in clear, fluent English suitable for later storyboard breakdown.
2. Include scene descriptions, character actions and dialogue. Do NOT use shot numbers, "INT./EXT." headings, or screenplay formatting marks.
3. Each episode: approximately 800 words. Episodes must be connected in story continuity — each episode picks up from where the previous one ended.
4. Each episode should have a clear beginning, development, and a hook or turning point at the end.${storyExpansionRules(cfg)}${enNote}`;
  }
  const _storyOverride = _overrideCache['story_expansion_system'];
  const base = _storyOverride || `你是一位专业的编剧。你的任务是根据用户提供的故事梗概，创作 ${n} 集完整的短片剧本。

要求：
1. 用中文写作，叙事清晰流畅，适合后续拆分为分镜。
2. 可以包含场景描述、角色动作与对话，但不要输出分镜格式、镜头编号或「内景/外景」等场次标记。
3. 每集约 800 字。如有多集，剧情必须前后衔接——每集从上一集结尾处推进，确保整体故事连贯。
4. 每集有清晰的起承转合，结尾留有悬念或转折，吸引观众看下一集。`;
  return base + storyExpansionRules(cfg) + jsonNote;
}

const STORY_STYLE_LABELS = {
  en: { modern: 'Modern', ancient: 'Period/Ancient', fantasy: 'Fantasy', daily: 'Slice of life' },
  zh: { modern: '现代', ancient: '古风', fantasy: '奇幻', daily: '日常' },
};
const STORY_TYPE_LABELS = {
  en: { drama: 'Drama', comedy: 'Comedy', adventure: 'Adventure' },
  zh: { drama: '剧情', comedy: '喜剧', adventure: '冒险' },
};

/**
 * 故事扩展：构建用户侧提示（梗概 + 可选风格/类型/集数），中英文
 */
function buildStoryExpansionUserPrompt(cfg, premise, style, type, episodeCount) {
  const lang = isEnglish(cfg) ? 'en' : 'zh';
  const n = Number(episodeCount) > 1 ? Number(episodeCount) : 1;
  const styleLabels = STORY_STYLE_LABELS[lang];
  const typeLabels = STORY_TYPE_LABELS[lang];
  if (lang === 'en') {
    let prompt = `Please create ${n} episode(s) of a short-film script based on the following story premise:\n\n${premise}`;
    if (style && styleLabels[style]) {
      prompt += `\n\nStyle: ${styleLabels[style]}`;
    }
    if (type && typeLabels[type]) {
      prompt += `\nGenre: ${typeLabels[type]}`;
    }
    if (n > 1) {
      prompt += `\nEpisodes: ${n}`;
    }
    return prompt;
  }
  let prompt = `请根据以下故事梗概，创作 ${n} 集短片剧本：\n\n${premise}`;
  if (style && styleLabels[style]) {
    prompt += `\n\n故事风格：${styleLabels[style]}`;
  }
  if (type && typeLabels[type]) {
    prompt += `\n剧本类型：${typeLabels[type]}`;
  }
  if (n > 1) {
    prompt += `\n生成集数：${n} 集`;
  }
  return prompt;
}

/**
 * 返回指定提示词 key 的可编辑默认正文（中文，不含动态锁定部分）。
 * promptOverrides.js 调用此函数，确保 UI 展示的内容与 promptI18n.js 始终一致。
 */
function getDefaultPromptBody(key) {
  switch (key) {
    case 'story_expansion_system':
      return '你是一位专业的编剧。你的任务是根据用户提供的故事梗概，创作 ${n} 集完整的短片剧本。\n\n要求：\n1. 用中文写作，叙事清晰流畅，适合后续拆分为分镜。\n2. 可以包含场景描述、角色动作与对话，但不要输出分镜格式、镜头编号或「内景/外景」等场次标记。\n3. 每集约 800 字。如有多集，剧情必须前后衔接——每集从上一集结尾处推进，确保整体故事连贯。\n4. 每集有清晰的起承转合，结尾留有悬念或转折，吸引观众看下一集。';

    case 'storyboard_system':
      return storyboardBodyZh;

    case 'character_extraction':
      return '你是一个专业的角色分析师，擅长从剧本中提取和分析角色信息。\n\n**【语言要求】所有字段的值必须使用中文，禁止出现英文内容（role字段的值除外，固定为 main/supporting/minor）。**\n\n你的任务是根据提供的剧本内容，提取并整理剧中出现的所有有名字角色的设定。\n\n要求：\n1. 提取所有有名字的角色（忽略无名路人或背景角色）\n2. 对每个角色，提取以下信息（全部用中文填写）：\n   - name: 角色名字（中文）\n   - role: 角色类型，固定值之一：main / supporting / minor\n   - appearance: 外貌描述（中文，100-200字，包含性别、年龄、体型、面部特征、发型、服装风格等，不含任何场景或环境信息）\n   - description: 背景故事和角色关系（中文，50-100字）\n3. 主要角色外貌要详细，次要角色可简化';

    case 'scene_extraction':
      return '【任务】从剧本中提取所有唯一的场景背景\n\n【要求】\n1. 识别剧本中所有不同的场景（地点+时间组合）\n2. 为每个场景生成详细的**中文**图片生成提示词（Prompt）\n3. **重要**：场景描述必须是**纯背景**，不能包含人物、角色、动作等元素；只做纯写实物理环境与光影的正面陈述，**严禁在 prompt 中写入“不出现文字/无倒计时/无UI”等负向禁令词句**\n4. **重要**：prompt 字段必须为中文，不得使用英文（风格词如 realistic 可保留）';

    case 'prop_extraction':
      return '你是一位专业的剧本道具分析师，擅长从剧本中提取具有视觉特征的关键道具。\n\n你的任务是根据提供的剧本内容，提取并整理所有对剧情有重要作用或有特殊视觉特征的关键道具。\n\n要求：\n1. 只提取对剧情发展有重要作用、或有特殊视觉特征的关键道具。\n2. 普通的生活用品（如普通的杯子、笔）如果无特殊剧情意义不需要提取。\n3. 若道具有明确归属者，**仅**写在 "description" 中（可用中文人名）；**禁止**在 "image_prompt" 中出现任何角色名、昵称、称谓或人际关系用语。\n4. "image_prompt" 按项目语言撰写（中文项目优先用中文），按「产品主图 / 资产白模照」标准撰写：只描述该道具本体（造型、材质、颜色、工艺与磨损），并强制纯色无缝棚拍背景、无场景无杂物。匹配项目中文提示词语音（融入真实尺度、次要元素原则）。\n5. "image_prompt" 须明确排除人物、手、家具、台面、其他物体与环境叙事元素。\n6. "image_prompt" **禁止**出现剧本人名、地名、组织名、台词、剧情专有词；用泛化视觉词替代，且**禁止无依据扩写**（不凭空加配饰、品牌叙事、煽情形容词）。';

    case 'storyboard_user_suffix':
      return '【分镜要素】每个分镜聚焦一个叙事节拍（单一连续画面，可包含多个紧密相连动作），描述要具体、紧凑，避免为填充时长重复动作：\n1. **镜头标题(title)**：用3-5个字概括该镜头的核心内容或情绪\n2. **时间**：[清晨/午后/深夜/具体时分+详细光线描述]\n3. **地点**：[场景完整描述+空间布局+环境细节]\n4. **镜头设计**：**景别(shot_type)**、**镜头角度(angle)**、**运镜方式(movement)**、**灯光风格(lighting_style)**、**景深(depth_of_field)**\n5. **人物行为**：**详细但紧凑的动作描述；同一空间内可包含多个连续身体动作**\n6. **对话/独白**：提取该镜头中的完整对话或独白内容；关键动机、选择、规则、后果和转折不能只写在 action/result 中\n7. **画面结果**：动作的即时后果+视觉细节+氛围变化\n8. **环境氛围**：光线质感+色调+声音环境+整体氛围\n9. **声音设计**：\n   - **有对白分镜**：bgm_prompt 填空字符串""；sound_effect 只写现场环境声、动作音效、对白/旁白音色与口型同步要求。\n   - **无对白分镜**：**必须填写 bgm_prompt（背景音乐描述）**，给出契合情节情绪的电影配乐风格（如“低沉紧迫的战术电子脉冲与心跳低音”等），供 H3 视频模型生成背景音乐！\n10. **观众情绪**：[情绪类型]（[强度：↑↑↑/↑↑/↑/→/↓]）\n\n**拆镜条件**：只有人物/说话人切换、场景或时间变化、视线轴线重大变化，或动作与对白超过4～8秒时才拆镜；拆镜必须写明上一镜结束状态、本镜进入状态和因果关系。\n**dialogue字段说明**：角色名："台词内容"。无对话时填空字符串""。\n**scene_id**：从上方场景列表中选择最匹配的背景ID，如无合适背景则填null。\n**duration时长**：综合对话、动作、情绪估算每镜时长（具体目标秒数由系统自动注入）。\n**声音一致性**：有对白优先保人声清晰；无对白镜头必须配上精准契合情节的背景音乐描述(bgm_prompt)。';

    case 'first_frame_prompt':
      return '你是一个专业的电影分镜图像生成提示词专家。请根据提供的镜头信息，生成适合AI图像生成的提示词。\n\n重要：这是镜头的首帧 - 一个完全静态的画面，展示动作发生之前的初始状态。\n\n核心规则：\n1. 聚焦初始静态状态 - 动作发生之前的那一瞬间，禁止包含任何动作或运动描述\n2. 描述角色在画面中的位置（画面左/中/右）、朝向（面向/背对/侧面）、初始姿态和表情\n3. 如提供了角色外貌信息，必须将其融入提示词（仅使用固定身份特征：脸型、五官、发型、肤质、标记等，严禁添加或推断任何服装、衣着、服饰描述，服装由参考图决定）\n\n【电影语言规范（必须应用）】\n\n构图规则（根据景别选择）：\n- 三分法：主体置于三分线交点，稳定平衡，适合大多数叙事镜头\n- 框架构图：用门窗/树枝/栏杆形成自然画框，突出主体，增加纵深\n- 中心构图：对称庄重，适合特写和仪式感场景\n- 前景遮挡：前景虚化元素增加层次感\n\n光线设计（必须描述）：\n- 光源方向：左侧光/右侧光/顶光/逆光（轮廓光）/底光\n- 光线质感：硬光（强烈阴影，戏剧张力）/ 柔光（柔和过渡，自然温馨）\n- 色温：暖光（金黄/橙红，温暖怀旧）/ 冷光（蓝调/青白，冷漠疏离）\n\n景深设置：\n- 特写/近景：浅景深，背景虚化，突出人物情绪\n- 中景：中等景深，人物与环境均清晰\n- 远景/全景：深景深，前后均清晰，交代空间关系';

    case 'key_frame_prompt':
      return '你是一个专业的电影分镜图像生成提示词专家。请根据提供的镜头信息，生成适合AI图像生成的提示词。\n\n重要：这是镜头的关键帧 - 捕捉动作最激烈、情绪最饱满的高潮瞬间。\n\n核心规则：\n1. 聚焦动作高潮时刻，最大化戏剧张力\n2. 捕捉情绪顶点，角色表情和肢体语言处于最强烈状态\n3. 可包含动态效果（动作模糊、视觉冲击感）\n4. 如提供了角色外貌信息，必须将其融入提示词（仅使用固定身份特征：脸型、五官、发型、肤质、标记等，严禁添加或推断任何服装、衣着、服饰描述，服装由参考图决定）\n5. 展示角色高潮状态下的肢体姿态和神情\n\n【电影语言规范（必须应用）】\n\n构图规则（高潮/动作场景）：\n- 对角线构图：强烈动态感，视觉引导，适合冲突/行动镜头\n- 荷兰角/斜角：不安感和紧张感，适合对峙/心理冲击场景\n- 过肩镜头：适合对话高潮、面对面对峙\n\n光线设计（高潮时刻）：\n- 轮廓光：将主体从背景中分离，突出人物\n- 强烈明暗对比（硬光）：戏剧张力，冲突感\n- 爆发性亮光：适合揭示真相、情绪爆发时刻\n- 色温情绪化：暖色饱和（激情/愤怒）/ 冷色低饱和（震惊/失落）\n\n景深与色调：\n- 通常使用浅景深聚焦关键动作，隔离背景\n- 高对比度色调强化高潮感';

    case 'last_frame_prompt':
      return '你是一个专业的电影分镜图像生成提示词专家。请根据提供的镜头信息，生成适合AI图像生成的提示词。\n\n重要：这是镜头的尾帧 - 一个静态画面，展示动作结束后的最终状态和结果。\n\n核心规则：\n1. 聚焦动作完成后的最终静态状态\n2. 展示动作的可见结果和后果\n3. 描述角色在动作完成后的最终姿态、位置和情绪表情\n4. 强调情绪余韵：释然/平静/悲伤/胜利/遗憾\n5. 如提供了角色外貌信息，必须将其融入提示词（仅使用固定身份特征：脸型、五官、发型、肤质、标记等，严禁添加或推断任何服装、衣着、服饰描述，服装由参考图决定）\n\n【电影语言规范（必须应用）】\n\n构图规则（收尾镜头）：\n- 通常用较宽的景别重建空间背景，或用紧镜头聚焦情绪收场\n- 留白构图：大面积空旷空间传递孤独/结束感\n- 呼应开场构图：收尾镜头可与首帧构图呼应，形成闭环\n\n光线设计（情绪余韵）：\n- 柔和暖光：事件解决后的温情/宽慰\n- 残留戏剧阴影：未解决的张力，悬念延续\n- 渐弱光线/冷调：失去/结束/遗憾的情绪\n- 色调整体偏暗或偏亮反映情绪归宿\n\n景深与氛围：\n- 情绪收场：浅景深，聚焦面部情绪细节\n- 结果展示：深景深，展示行动对环境/他人的影响';

    default:
      return '';
  }
}

/**
 * 返回指定提示词 key 的锁定后缀（供 UI 展示，动态字段用占位符替代）。
 */
function getLockedSuffix(key) {
  switch (key) {
    case 'story_expansion_system':
      return storyExpansionRules({}) + '\n只返回指定集数的JSON数组，每项含 episode、title、content。';
    case 'storyboard_system':
      return storyboardRules({}) + storyboardSchema({});
    case 'character_extraction':
      return '\n- **风格要求**：[当前剧集风格]\n- **图片比例**：[当前比例]\n输出格式：\n**重要：必须只返回纯JSON数组，不要包含任何markdown代码块、说明文字或其他内容。直接以 [ 开头，以 ] 结尾。**\n每个元素是一个角色对象，包含上述字段。';
    case 'scene_extraction':
      return '\n5. **风格要求**：[当前剧集风格]\n   - **图片比例**：[当前比例]\n\n【输出格式】\n**重要：必须只返回纯JSON数组，不要包含任何markdown代码块。直接以 [ 开头，以 ] 结尾。**\n每个元素包含：location（地点）, time（时间）, prompt（完整的中文图片生成提示词，纯背景，明确说明无人物）。';
    case 'prop_extraction':
      return '\n- **风格要求**：[当前道具风格]\n- **图片比例**：[当前比例]\n\n【输出格式】\n**重要：必须只返回纯JSON数组，不要包含任何markdown代码块、说明文字或其他内容。直接以 [ 开头，以 ] 结尾。**\n每个对象包含：\n- name: 道具名称\n- type: 类型 (如：武器/关键证物/日常用品/特殊装置)\n- description: 在剧中的作用和中文外观描述（人名归属可写此处，勿写入 image_prompt）\n- image_prompt: 单道具主图提示词（纯色底、仅主体；无剧本人名地名等；简练、不扩写；中文项目用中文并匹配项目语音与真实尺度铁律）';
    case 'storyboard_user_suffix':
      return '\n\n【输出格式】请以JSON格式输出，包含 "storyboards" 数组。每个镜头包含：shot_number, title, shot_type, angle, time, location, scene_id, movement, lighting_style, depth_of_field, action, dialogue, narration, result, atmosphere, emotion, duration, bgm_prompt, sound_effect, characters, is_primary。**必须只返回纯JSON，不要markdown。**';
    case 'first_frame_prompt':
    case 'key_frame_prompt':
    case 'last_frame_prompt':
      return '\n- **风格要求**：[当前剧集风格]\n- **图片比例**：[当前比例]\n输出格式：\n返回一个JSON对象，包含：\n- prompt：完整的中文图片生成提示词（详细的电影语言描述）\n- description：简化的中文描述（供参考）';
    default:
      return null;
  }
}

/**
 * 场景单图提示词生成：文本AI将场景描述转化为单图场景参考图提示词（非四宫格）
 */
function getScenePolishPromptSingle(cfg) {
  const style = styleTextZhForPolish(cfg);
  return `# 场景单图参考图生成器

## 你的身份
你是专业的影视美术设计师，负责将场景描述转换为AI绘图标准单图场景参考图提示词（**非四宫格**）。

## 核心规则

### 提取与统一
- **单张连续画面**：生成一段完整、统一的场景描述，用于绘制**一张**图片
- **完整展示**：必须包含场景的全貌、主要建筑结构、地面材质、关键陈设、光线/时段、氛围
- **禁止出现**：角色、人物剪影、文字标注、水印、四宫格/分格/第1格/第2格等字样
- **真实可信**：建筑风格、材质、植被必须符合场景所属时代和地域${style ? '\n- **画风风格**：' + style : ''}

### 单图内容设计原则
- 用最宽/最合适的视角一次性展示整体空间关系，不遗漏边界
- 清晰呈现人物最常活动的区域（对话区/行动区）
- 突出最具场景辨识度的标志性细节
- 强调光线、材质、氛围的统一性

### 避免与生图侧重复
- **不要**写四宫格顺序、无人物、无文字水印等与版面/负面清单相关的长段说明（生图 API 会统一注入）；只写场景可视信息与完整画面内容

## 输出要求
直接输出一段连贯的场景描述文字，不要分段落标题，不要出现「第X格」字样。`;

}

/**
 * 场景四视图提示词生成：文本AI将场景描述转化为四格场景参考图提示词
 */
function getScenePolishPrompt(cfg) {
  const style = styleTextZhForPolish(cfg);
  return `# 场景四视图参考图生成器

## 你的身份
你是专业的影视美术设计师，负责将场景描述转换为AI绘图标准四视图参考图提示词。

## 核心规则

### 提取与统一
- **完全统一**：四格图中的建筑结构、地面材质、主要陈设、光线/时段必须完全一致，只有焦距与机位角度可变
- **禁止出现**：角色、人物剪影、文字标注、水印
- **真实可信**：建筑风格、材质、植被必须符合场景所属时代和地域${style ? '\n- **画风风格**：' + style : ''}

### 四格内容设计原则
- 第1格用最宽视角展示整体空间关系，不遗漏边界
- 第2格聚焦人物最常活动的区域（对话区/行动区），中景视角
- 第3格选择最具场景辨识度的标志性细节进行特写
- 第4格使用与第1格不同的机位角度（如微俯/高俯/仰视/斜角），展示同一场景的空间纵深与结构关系

### 避免与生图侧重复
- **不要**写四宫格顺序、无人物、无文字水印、四格建筑一致等与版面/负面清单相关的长段说明（生图 API 会统一注入）；只写场景可视信息与各格差异化镜头内容

## 四格固定顺序

| 位置 | 视图类型 | 构图与功能 |
|------|---------|-----------|
| 第1格 | 全景建立镜头 | 最宽视角，展示完整空间格局、建筑边界、环境背景，无人物 |
| 第2格 | 主体焦点区域 | 主要活动区域中景，清晰展示人物站位空间、地面细节、主要陈设 |
| 第3格 | 环境特征细节 | 场景最具辨识度的标志性元素特写（建筑纹理、招牌、装饰品等） |
| 第4格 | 角度变体 | 相同场景、相同光线/时段，但不同机位角度（如微俯/高俯/仰视/斜角），展示空间纵深 |

## 时代场景匹配表

| 类型 | 场景风格 |
|------|---------|
| 古风/仙侠 | 中国古代建筑，青砖黑瓦，红柱彩梁，庭院回廊 |
| 武侠 | 江湖风貌，茶馆客栈，山野林间，镖局武馆 |
| 西幻/奇幻 | 欧洲中世纪，石砌城堡，酒馆，森林，魔法元素 |
| 现代都市 | 现代建筑，办公室，咖啡厅，街道，居家空间 |

## 输出格式

【场景基础设定】
场景类型: 室内/室外/自然场景
地点特征: 建筑风格，主要材质，空间规模，标志性元素
默认光线: 自然光/人工光，色温，时段
气氛基调: 整体色调倾向，视觉情绪

【第1格-全景建立镜头】
镜头高度，视角（地面平视/微俯/高俯），场景全貌描述
建筑/地形轮廓，背景天空/远景，整体色调
无人物，无道具遮挡，展示完整空间边界

【第2格-主体焦点区域】
活动核心区、地面与陈设；中景、光线落点；功能（对话区/打斗区等，勿复述「无人物」等禁令）

【第3格-环境特征细节】
标志性元素的材质/纹理/色彩；特写与景深；该元素的指示意义

【第4格-角度变体】
与第1格不同的机位高度与视角（如微俯/高俯/仰视/斜角）；保持与前三格相同的光线/时段/天气；展示空间纵深与建筑结构关系`;
}

/**
 * 场景四视图图片生成：图片AI的system prompt（简短；画风由用户消息首部强调）
 */
function getSceneGenerateImagePrompt() {
  return `Scene environment reference sheet — image only, no text reply.

ONE image: 2×2 grid. TL=establishing wide (full space, boundaries, context). TR=main activity zone medium shot (floor, key furnishings). BL=signature environmental detail close-up. BR=alternate angle view (same place, same lighting/time/weather, different camera angle such as elevated/low/high/oblique).

No people: no characters, silhouettes, human shadows. No text/labels/watermarks/location lettering. Same architecture, terrain, ground materials, and key props across all panels; same light, time, and weather; only focal length and camera angle may change. Unified palette and depth; high detail. Follow ART STYLE / 画风 block at the start of the user message if present.`;
}

/**
 * 场景单图提示词生成：图片AI的system prompt（单图场景，非四宫格）
 */
function getSceneGenerateSingleImagePrompt() {
  return `Scene environment reference — image only, no text reply.

ONE single continuous image (no grid, no split panels, no collage).
Show the complete scene in one unified view: wide establishing shot capturing the full space, key architectural features, lighting, atmosphere, and environmental details.
No people: no characters, silhouettes, human shadows. No text/labels/watermarks/location lettering.
Follow ART STYLE / 画风 block at the start of the user message if present.`;
}

/**
 * 角色参考表提示词生成：文本AI将角色外貌描述转化为工业分栏角色参考表绘图提示词（非四宫格）
 */
function getRolePolishPrompt(cfg) {
  const style = styleTextZhForPolish(cfg);
  return `# 工业角色参考表标准提示词生成器

## 你的身份
你是专业的角色视觉设计师，负责将角色描述转换为「工业角色参考表」绘图提示词：分栏、标签清晰、主体填满画幅；**不是**四宫格拼图、**不是**海报、**不是**真人棚拍写真、**不是**漫画分镜、**不是**贴纸拼贴。

## 核心规则

### 提取与限制
- **仅提取**：角色描述中明确的外貌与服装特征
- **严禁添加**：场景、环境、叙事性光影特效、情绪形容词堆砌
- **标志性道具（可选）**：仅当原文明确写出身份关键道具时，写在「SIGNATURE PROP / EQUIPMENT DETAIL」小窗内容里；**不得**凭空加武器或剧情道具
- **全版面一致**：所有面板同一角色、同一年龄段与妆面；发型、瞳色、服装、体型、比例完全一致
- **时代匹配**：服装与发型必须符合作品类型所属时代背景${style ? '\n- **画风风格（须贯穿各栏描述，与下长生图侧画风块一致）**：' + style : ''}

### 版式（强制，减少留白）
- **顶部标题栏**：浅灰细边框技术标题条，标题使用用户提供的角色名称（或作品内统一称呼），与正文描述一致
- **左约三分之一竖栏**：仅放置 **FACE HERO CLOSE-UP**（主面部特写竖条，大块面部占位，减少无用留白；画面主体严格为面部特写。若画面下方露出颈部或衣领，其衣领款式和颜色必须严格与右侧 FRONT VIEW 的设定服装一致，严禁引入任何未设定的外套或参考图中的私服外套）
- **右约三分之二区域**：放置 **FRONT VIEW**、**BACK VIEW**、**SIDE PROFILE CLOSE-UP**、**COSTUME / SUIT DETAIL VIEW**、**MATERIAL & TEXTURE NOTES**；各分区配有清晰英文/中英对照标签
- **禁止侧身全身**：不设置 90° 侧面全身面板
- **FRONT VIEW 与 BACK VIEW**：同一角色、同一套服装版本、同一身高比例、同一灯光与同一标尺尺度；正面与背面均为稳定直立全身（头顶到脚底），不做动作姿势，无扭身；双臂自然下垂于体侧，手部自然
- **SIDE PROFILE CLOSE-UP**：90° 侧面脸部特写（非全身），展示侧脸轮廓、鼻梁侧面、耳部、发型侧面与下颌线；**必须与左侧 FACE HERO CLOSE-UP 同一张脸**（不可变成另一年龄或另一妆面），与正脸形成互补而非重复
- **COSTUME / SUIT DETAIL VIEW 与 MATERIAL & TEXTURE NOTES**：仅在右侧区域内展示衣领、袖口、腰带、鞋靴、配饰、边缘轮廓及布料/金属/皮革/绷带等材质；**MATERIAL & TEXTURE NOTES** 只能用**短标签**（如 cloth、metal、leather、wet fabric、edge wear），**不得**写成横跨全画幅的底部长文说明栏
- **可选**：**SIGNATURE PROP / EQUIPMENT DETAIL** 小窗（按需）
- **取消**：色板条、调色块模块
- **分隔**：各面板之间细浅灰分割线，边界规整、留白克制；整体 4K 级细节密度、结构稳定的电影工业参考表质感

### 输出语言约束
- **禁止情绪描写**：禁止「带憧憬」、「给人…感」等
- **禁止抽象形容**：禁止「俊美」「自信」「温柔」等无法直接画出的词
- **只用具象描述**：可视化物理特征

### 避免与生图侧重复
- **不要**重复赘述纯白底、禁止拼贴分镜等生图 API 系统提示里已有的硬性条款
- **须**在润色输出中明确：标题条应显示的标题文字、各分区的英文标签名（如 FACE HERO CLOSE-UP、FRONT VIEW、SIDE PROFILE CLOSE-UP、MATERIAL & TEXTURE NOTES），并与上方【输出格式】各节一一对应（参考表画面上的技术标签不是「水印」）
- 正文仍以具象外貌/服装/材质为主，避免空洞「8K」「超高清」堆砌

## 时代服装匹配表

| 类型 | 服装体系 |
|------|---------|
| 古风/仙侠/玄幻 | 中国古代汉服体系，交领右衽、广袖长袍 |
| 武侠 | 中国古代劲装体系，交领窄袖劲装 |
| 西幻/奇幻 | 欧洲中世纪服饰，束腰长袍、斗篷 |
| 现代都市 | 现代服装，T恤、衬衫、西装、连衣裙 |

## 抽象词汇转具象示例

| 禁用词 | 替换为 |
|-------|--------|
| 俊美/英俊 | 五官比例协调，鼻梁挺直 |
| 自信 | 下巴微抬，目光平视前方 |
| 温柔 | 眉毛弧度柔和，眼角微圆 |

## 输出格式

【基础设定】
人物基础: 性别，年龄段，身高体型，肤色
五官: 眉形，眼型，瞳色，鼻型，唇形
表情（全身与主特写）: 中性、无表情或统一证件照式平静
发型: 颜色，长度，质感，发型结构
服装: 款式名称，主色，材质，领型，袖型

【标题栏】
标题条内要显示的确切标题文字（通常即角色名）

【FACE HERO CLOSE-UP｜左竖栏】
主脸特写（竖向大画幅）：发际线到下颌，肤质、眉眼妆面、唇形与整体脸型比例。画面严格以面部特写为主；若露出颈部或衣领，衣领样式与颜色必须与【FRONT VIEW】中设定的服装完全一致，严禁画入任何外套、夹克或参考照片中的服装

【FRONT VIEW｜右区-正面全身】
正面全身：从头到脚完整入画，站姿稳定，服装前襟与裤/裙正面结构

【BACK VIEW｜右区-背面全身】
背面全身：从头到脚后跟完整入画，与正面同比例同服装；后脑发型、后领、背身裁片与下摆

【SIDE PROFILE CLOSE-UP｜右区】
90° 侧面脸部特写：侧脸轮廓、鼻梁侧面、耳部、发型侧面、下颌线与唇线侧面（与左栏正脸同一人，互补不重复）

【COSTUME / SUIT DETAIL VIEW｜右区】
衣领、袖口、腰带、鞋靴、配饰、裁片边缘等（不写整景）

【MATERIAL & TEXTURE NOTES｜右区小标签】
若干短英文或中英标签列举材质关键词（非长段落）

【SIGNATURE PROP / EQUIPMENT DETAIL｜可选】
仅当有原文依据时写道具局部特写说明`;
}

/**
 * 角色参考表图片生成：图片AI 的 system prompt，工业分栏版式（非四宫格），画风由用户消息首部强调
 */
function getRoleGenerateImagePrompt() {
  return `Industrial character reference sheet — image only, no text reply.

ONE image, single canvas (NOT a 2×2 or 4×4 grid, NOT four equal quadrants). Layout:
- Top: thin light-gray technical TITLE BAR; title text must be legible (use the character name / title given in the user prompt body).
- Main area FIXED SPLIT: LEFT ~1/3 COLUMN = FACE HERO CLOSE-UP (tall vertical hero face close-up from hairline to chin; maximize face scale, reduce empty margin. If neck or collar is visible, it MUST match the designated outfit in FRONT VIEW; STRICTLY FORBIDDEN to draw any jacket, coat, or clothing from photo references).
- RIGHT ~2/3 = labeled sub-panels: FRONT VIEW (front full body), BACK VIEW (back full body), SIDE PROFILE CLOSE-UP (90° profile face close-up, not full body), COSTUME / SUIT DETAIL VIEW, MATERIAL & TEXTURE NOTES (short tags only: cloth, metal, leather, edge wear — NOT a full-width bottom text bar). Optional SIGNATURE PROP / EQUIPMENT DETAIL if the user prompt mentions that prop.
- NO left-profile full-body panel. FRONT and BACK: same character, same outfit, same proportions, same lighting and scale; neutral standing, head-to-toe, arms at sides, no action pose. SIDE PROFILE CLOSE-UP complements FACE HERO (same identity/age/makeup; profile view, not duplicate front face).
- Costume/material only in right-side panels. No color-swatch strip. Fine light-gray dividers. Cinematic industrial reference sheet, 4K detail density — not a poster, not a comic grid, not a photo collage.

Solid white only (RGB 255,255,255). No watermark logos. Panel titles and material tags printed ON the reference sheet are required. No environment/ground beyond minimal foot contact if needed. Follow ART STYLE / 画风 / MANDATORY ART STYLE at the start of the user message if present.`;
}

/**
 * 分镜图片 prompt 二次优化：将分镜叙事描述转化为图片生成模型优化的 prompt
 * 供 imageService.js Step3.5 调用，结果回写 image_generations.prompt
 */
function getImagePolishPrompt(cfg) {
  const isEn = isEnglish(cfg);
  if (isEn) {
    return `You are an expert image prompt engineer specializing in AI image generation for cinematic storyboards.

Your task: Transform a storyboard description into an optimized STATIC IMAGE generation prompt.

CRITICAL RULES:
1. Output ONLY the final prompt — no explanations, no labels, no JSON, no preamble
2. STATIC SINGLE FRAME — describe ONE frozen millisecond only. BANNED WORDS: camera, pan, push, pull, zoom, dolly, track, transition, shift, move, slowly, gradually, becomes, opens (as motion), as [subject] does X, while, then, cut to, scene shifts, glanced, looked over, walked over, loses balance. Characters must have concrete frozen postures, physical stances, hand/limb placements, head and gaze directions (never bare names or 'body' like 'Luna' or 'Yichen body').
3. SINGLE CONTINUOUS IMAGE — no split panels, no side-by-side layout, no collage, no comparison view. All characters share one unified scene space
4. Length: 50–100 words
5. Structure: [Shot framing] + [Scene/environment] + [Characters' frozen poses/expressions] + [Lighting at this exact instant] + [Atmosphere] + [Style tokens]
6. Describe characters' POSE and EXPRESSION at peak moment — not their motion arc
7. Preserve character names exactly as listed in ASSETS (they are reference image anchors)
8. **Style (mandatory):** Honor the 画风 / MANDATORY ART STYLE lines at the TOP of the user message AND the STYLE_TOKENS line — weave the same visual style through the whole prompt; the closing clause must repeat those style keywords (do not drop or replace them with generic words)
9. CONTINUITY: If PREV_CONTINUITY_STATE is provided, you MUST maintain consistency with the previous shot:
   - Match character clothing exactly (same outfit, same accessories)
   - Respect character body_posture logically (e.g. if prev shot shows character lying on bed, current shot must also show them lying on bed unless ACTION explicitly describes them moving)
   - Match lighting color temperature as described in PREV_CONTINUITY_STATE
   - If current ACTION explicitly changes character posture (e.g. "stands up", "sits down", "rises"), that override takes precedence over body_posture

Input format:
PROMPT: <original storyboard image prompt>
ACTION: <what characters are doing in this frozen moment>
DIALOGUE: <spoken dialogue — use for context only, do not quote it>
RESULT: <visual outcome visible in the frame>
ATMOSPHERE: <lighting and mood>
SHOT_TYPE: <framing type>
STYLE_TOKENS: <art style keywords — must appear in your output>
ASSETS: <character/scene names with reference images>
PREV_CONTINUITY_STATE: <JSON snapshot of character states from previous shot — clothing, position, expression>
CONTEXT_PREV: <previous shot action summary for continuity>
CONTEXT_NEXT: <next shot summary — ignore for image, relevant only for mood>`;
  }

  // 中文版：输出中文 prompt，铁律禁止服装描述
  return `你是一个专业的电影分镜图像生成提示词优化专家，专长于将分镜描述转化为适合AI图片生成模型的**静态单帧**优化提示词。

你的任务：输出**仅最终中文 prompt**（直接给图片AI使用，无任何解释、无标签、无JSON、无前言）。

【核心严格规则】

1. **静态单帧画面与定格姿态铁律**：只描述决断瞬间的一个冻结摄影画面。严禁任何动态/时序动词（推镜、拉镜、摇镜、移动、逐渐、然后、看了一眼、转头看了一眼、沿...走到...、身体失去平衡、切到、while、as [subject] does 等）。严禁只写人名或“某某身体”等导致缺乏姿态的残缺表述。必须具体刻画人物身体重心姿态（站立/深蹲/半蹲/单膝跪/倾斜）、双手四肢具体动作、头部角度与目光注视点。遇失衡摔倒必须描述具体倾斜角度与支撑定格姿势。

2. **单一连续完整画面**：无分割、无四宫格、无并列、无拼贴、无对比布局。所有角色共享同一统一空间。

3. 输出长度约 80-160 字中文，用中文逗号「，」自然流畅连接成一段提示词。

4. 推荐 5 层结构（不加“第X层”标签，直接用逗号拼接）：
   第1层-镜头设计：景别 + 机位角度 + 构图方式
   第2层-光线：光源方向 + 光线质感 + 色温
   第3层-内容焦点：角色（**仅固定身份特征**：脸型、五官、发型、肤质、皮肤纹理、独特标记、年龄/性别等 + 结果姿态 + 情绪余韵） + 场景最终状态 + 关键道具位置
   第4层-氛围：情绪基调 + 色彩倾向 + 凝滞感/紧绷感
   第5层-视觉风格：必须完整重复用户消息顶部的画风词 + 电影分镜质感 + 图片比例 + 情绪收束

5. **角色外貌描述铁律（最高优先级，任何违反均视为失败）**：
   - 角色外貌**仅允许使用固定身份特征**（脸型、五官、发型、肤质、皮肤纹理、独特标记、年龄性别等）。
   - **严禁在 prompt 任何位置添加、推断、暗示任何服装、衣着、服饰、配饰、鞋帽、居家服、西装、裙装、loungewear 等描述**。
   - 服装、穿着、配饰完全由参考图（ASSETS 中列出的角色参考图）决定，**文字提示词中绝不出现任何服装相关词汇**。
   - 只有当固定身份特征中本来就包含眼镜、疤痕、纹身等辨识标记时，才可极简提及；否则一律不提。

6. 严格保留 ASSETS 列表中的角色名称（它们是参考图锚点），格式示例：“李娟（圆脸、高鼻梁、短发、面容略带疲惫）”。

7. **画风·最高优先级**：必须完全融入用户消息顶部的【画风·最高优先级】和 STYLE_TOKENS 行，结尾必须重复这些关键词（不要用泛化词替换）。

8. **服装与连戏一致性铁律**：
   - 如果提供了 PREV_CONTINUITY_STATE，必须**逐字匹配**上一镜头中该角色的服装描述（若有）。
   - 当前 ACTION 未明确写明“换衣服/脱外套/换装”等动作，则**绝不改变或重新描述服装**。
   - 没有 PREV_CONTINUITY_STATE 时，**完全不在 prompt 中出现任何服装相关词**。
   - 参考图的视觉优先级永远高于文字描述。

输入格式（与之前相同）：
PROMPT: <原始分镜图像提示词>
ACTION: <该冻结瞬间角色的动作>
DIALOGUE: <对白，仅供上下文参考，不要直接引用>
RESULT: <画面可见的结果>
ATMOSPHERE: <光线与情绪>
SHOT_TYPE: <景别>
STYLE_TOKENS: <必须在输出中重复的画风关键词>
ASSETS: <角色/场景名称 + 参考图说明>
PREV_CONTINUITY_STATE: <上一镜头的连戏状态快照 JSON，含服装/位置/表情>
CONTEXT_PREV / CONTEXT_NEXT: 上下文（仅用于情绪参考）

请直接输出一段纯中文 prompt 文字。`;
}

/**
 * H3 Ref2VA 多参考模式：模板 + 仅用 @图片1/@图片2…（与参考图顺序一致，不用 @姓名）
 */
function getUniversalOmniSegmentPrompt() {
  const specZh = getUniversalOmniMultiBeatFormatSpec({ language: 'zh' });
  return `You write the main prompt for MiniMax H3 Ref2VA multi-reference video "片段描述" in Chinese.

The USER message includes MULTI_BEAT_OUTPUT, TOTAL_CLIP_SECONDS, SHOT_PACING_AND_POSITION, EPISODE_SCRIPT, NEIGHBOR_* detail, IMAGE_SLOT_MAP, LINE3_REQUIRED, STYLE_HINT, and storyboard fields.

FORBIDDEN output styles: legacy single-line rows (主体:/叙事动态:/[禁BGM]); @人物N as image tokens. Use ONLY the multi-beat block below — same as「全能分镜模式」batch storyboard output.
${specZh}

This is **one** API clip whose wall-clock length is TOTAL_CLIP_SECONDS. Split into **M** internal beats (子分镜, M = 1–8 you choose). Each beat = one line「分镜k： Tk秒:」. Sum of all Tk = TOTAL_CLIP_SECONDS exactly.

Output structure (no lines before or after this block):

Line 1 — exactly:
画面风格和类型: <comma-separated tags; MUST include 真人写实, 电影风格, 高清画质; MAY add STYLE_HINT / DRAMA_GENRE phrase>

Line 2 — exactly (M must match count of 分镜k lines):
生成一个由以下M个分镜组成的视频。

Line 3 — copy LINE3_REQUIRED from the USER message verbatim.

Lines 4 through (3+M) — for each k, one full line:
分镜k： Tk秒: <Rich cinematic Chinese prose for this slice only: at most one simple camera move, or a fixed view, @图片N bindings per IMAGE_SLOT_MAP, light, emotion. Dialogue: …说："verbatim" or …："verbatim". No speech: 无对白。 Narration: 旁白（画面无声）："verbatim". Avoid static snapshot captions.>

DIALOGUE — CRITICAL (when USER message contains DIALOGUE_VERBATIM):
- Every line listed under「必须逐字出现在输出中的台词」MUST appear in some子分镜 line inside 「」, character-for-character (only spacing around @图片N may vary).
- NEVER replace dialogue with summaries like「他选择了一个亿」「说完台词」without the actual quoted words.
- Distribute lines across beats by story order; longer Tk beats that contain speech must include the full quoted line(s), not paraphrase.
- If DIALOGUE / DESCRIPTION【对话】/ VIDEO_PROMPT_对话段 / EPISODE_SCRIPT imply spoken lines, include them verbatim even when CURRENT_UNIVERSAL_SEGMENT omitted them.
- Silent shots: state silence explicitly; do not invent dialogue.

Reference images — CRITICAL (applies to every子分镜 line’s prose):
- Use ONLY IMAGE_SLOT_MAP tokens @图片1, @图片2, … (Arabic digits).
- Follow CHARACTER_IMAGE_BINDING. When @图片1 is 场景, never put character face/body/costume on @图片1; characters start at @图片2 as mapped.
- Spacing: ASCII space after each @图片N before following Chinese/Latin.
- No @姓名 as image token; no markdown.

Pacing & M selection (professional):
- Read SHOT_PACING_AND_POSITION, EPISODE_SCRIPT, NEIGHBOR_* , STORYBOARD FIELDS (movement, shot_type, dialogue density). Default to M=1 with one simple action. Use extra beats only for essential scene changes; simplify complex beats across separate clips when possible.
- Never change the **total** seconds: T1+…+TM must equal TOTAL_CLIP_SECONDS.

Scene reference layout — CRITICAL (when SCENE_REFERENCE_LAYOUT applies):
- Reference may be multi-panel; do NOT make the final video mimic grids. Each子分镜 line’s prose should reinforce: one continuous full frame, no split-screen collage in the delivered clip.

If CURRENT_UNIVERSAL_SEGMENT is non-empty, preserve narrative beats but rewrite to satisfy MULTI_BEAT_OUTPUT, duration sum, and IMAGE_SLOT_MAP.`;
}

/**
 * 全能片段「润色」模式：在 getUniversalOmniSegmentPrompt 的硬性格式与参考图规则之上，强化短剧叙事与上下文一致。
 */
function getUniversalOmniPolishPrompt() {
  return `${getUniversalOmniSegmentPrompt()}

ADDITIONAL_POLISH_MODE (short drama enhancement — still MUST obey MULTI_BEAT_OUTPUT, TOTAL_CLIP_SECONDS sum, IMAGE_SLOT_MAP, LINE3_REQUIRED above):
- You receive FULL_EPISODE_SCRIPT plus NEIGHBOR blocks and structured fields. Use them only for **continuity** and **information completeness**; do NOT invent plot absent from SCRIPT + STORYBOARD FIELDS + CURRENT omni draft.
- **Information parity**: every script-relevant fact must appear across the子分镜 lines (lines 4…3+M), without losing information when expanding; if the draft was an old SoulLens single-line, **rewrite** into this multi-beat block; keep the same facts and total seconds.
- **Re-polish / anti-stagnation**: USER may click polish repeatedly on the same draft. Each response MUST deliver **substantially rephrased** Chinese on lines 1, 2 (if M changes), and all子分镜 body lines — same facts, same total seconds, same @图片 bindings, but **not** a copy-paste of CURRENT_OMNI_DRAFT except line 3 which must stay **character-identical** to LINE3_REQUIRED. If you would otherwise output nearly identical prose, deliberately vary verbs, clause order, and camera wording while preserving meaning.
- **Short drama rhythm**: vertical-drama density — stakes, micro-expressions, blocking, camera motion; distribute across beats when M>1.
- **Inner monologue & dialogue**: brief 心想 / 「」 only when supported by DIALOGUE / NARRATION / SCRIPT / draft. When DIALOGUE_VERBATIM is present, **every** listed line must remain verbatim in 「」 after polish; rephrase motion/camera text freely but **not** quoted dialogue.
- **Neighbors**: align entry/exit with NEIGHBOR_* ; no redundant retelling of the previous shot.
- Language: Chinese for子分镜 prose; lines 1–3 format as in base prompt; M must match line 2 and match the count of「分镜k」lines.`;
}

/**
 * 经典图生视频提示词二次润色（Polish Classic Video Prompt）
 */
function getClassicVideoPromptPolishPrompt() {
  return `你是「分镜静帧 → 图生视频（image-to-video）」方向的资深提示词作者与摄影指导，熟悉竖屏短剧、首帧锁定下的动效与运镜描写。

## 任务
将 CURRENT_VIDEO_DRAFT 润色为**一段**可直接提交视频模型的**专业中文主叙述**；**必须保留**原文中所有技术/声画标签下的信息。末段可追加**英文**光影、镜头与风格 token（可与「镜头角度」括号内英文衔接；英文段总长建议 ≤ 420 字符，须包含原稿风格关键词）。

## 输入块（你会在 user 消息里看到）
- PROJECT / SHOT_SEQUENCE / VIDEO_RATIO
- FULL_EPISODE_SCRIPT
- NEIGHBOR_PREV / NEIGHBOR_NEXT（加长邻镜上下文）
- STORYBOARD_FIELDS
- **REQUIRED_COVERAGE_DIGEST**（结构化字段；成稿须全部覆盖）
- **RETENTION_CLAUSES_FROM_SOURCE**（从原「场景：…。配乐：…」式文案拆出的标签分句；**防丢项**的核心依据）
- FIRST_FRAME_VISUAL_ANCHOR
- AUTO_COMPOSED_VIDEO_PROMPT、CURRENT_VIDEO_DRAFT
- VISUAL_STYLE（STYLE_ZH + STYLE_EN）

## 硬性规则
1) **只输出成稿提示词**：禁止标题、Markdown、代码块、元话语。**禁止**在成稿里使用「1. 2. 3.」编号列表；须为连贯自然段（允许多句）。
2) **RETENTION_CLAUSES 防丢项（与 Digest 同级重要）**：若存在 **RETENTION_CLAUSES_FROM_SOURCE** 列表，则其中**每一条**对应原文里的一个标签分句（场景、镜头标题、动作、对话、结果、景别、镜头角度、运镜、氛围、情绪、情绪强度、配乐、音效、时长、风格、=VideoRatio 等）。成稿必须让读者与模型能还原出**该分句中的全部要点**：
   - **配乐**：若原文有「配乐：…」，成稿须**单独写出**配乐侧写（如忙音渐弱、心跳隐现等），**禁止**仅用「寂静」「不安」等笼统氛围一笔带过而不再提配乐层次。
   - **音效**：若原文有「音效：…」，须**逐项或等价列举**原文中的听感（忙音、被褥摩擦、呼吸声等），不得整类省略。
   - **情绪强度**：若原文有「情绪强度：数字/等级」，须在成稿中体现**强弱程度**（可与情绪描写合并，但不可删掉强度含义）。
   - **镜头角度**：若原文「镜头角度：」后含**中文标签 + 括号内英文**（含 medium shot / depth of field / eye-level / shooting from the front 等），英文技术短语须**原样保留或同信息量复述**（关键词不得丢），不得压缩成仅「中景平视」四字而无英文细节。
   - **风格与画幅**：若原文「风格：」后有长英文 token，须在成稿末段**保留等价英文质感词**；若含 **=VideoRatio: 9:16**（或同类），成稿须保留**竖屏画幅 9:16** 的明确表述（可写「竖屏 9:16」或保留 \`=VideoRatio: 9:16\` 形式之一）。
3) **REQUIRED_COVERAGE_DIGEST**：凡列出的「- 维度：」行，成稿须全部覆盖语义（同规则 2，不得省略）。
4) **首帧锁定**：FIRST_FRAME_VISUAL_ANCHOR 与参考静帧一致；禁止改妆造、换场景时代。
5) **事实与时长**：与 STORYBOARD_FIELDS、AUTO_COMPOSED、CURRENT_VIDEO_DRAFT 一致；**时长秒数**不得改动。
6) **剧本与邻镜**：FULL_EPISODE_SCRIPT、NEIGHBOR_* 用于衔接与语气，勿编造无据情节。
7) **禁止编造**：无来源的新角色、道具、事件。
8) **纯正面肯定陈述，严禁在成文里输出负面禁令短语**：MiniMax H3 对负面否定词非常敏感（写了“不出现文字/倒计时”反而更容易误生成文字）。成稿中**严禁出现任何负面排除短语**（如“不出现任何文字界面或倒计时”、“无文字”、“不要UI”、“避免晃动”等）。若输入的原稿、场景摘要或剧本中出现此类负面禁令短语，润色时必须**直接从成文中彻底剔除**，只保留客观物理环境、人物动作与光影的正面肯定描述！

## 成稿内在顺序（仍为一段连续文字）
在满足「防丢项」前提下，建议：入戏与场景时间 → 动作与对白（「」）→ 结果与氛围 → **配乐与音效层次**（显式写出）→ 景别+运镜+**完整镜头角度（中英）**+光线景深 → 情绪与强度 → 时长 → 风格与画幅（含英文 token）。

若 RETENTION_CLAUSES 为空，则须将 CURRENT_VIDEO_DRAFT 全文各类子句信息等价写入成稿，禁止删减类别。`;
}

/**
 * 从已完成的 polished_prompt 中提取连戏状态快照（角色服装/位置/表情）
 * 结果为 JSON 字符串，存入 storyboards.continuity_snapshot
 */
function getContinuitySnapshotPrompt() {
  return `You are a script supervisor (continuity analyst) for a film production.

Given a completed image generation prompt for a storyboard shot, extract a structured continuity state snapshot.

Output ONLY a valid JSON object — no explanations, no markdown fences.

JSON schema:
{
  "characters": {
    "<character_name>": {
      "screen_position": "<EXACT screen standing position for layout lock — e.g. 'left third of frame, facing camera', 'right side of frame standing behind table', 'center, slightly left of partner', 'far left background'. Include relative to other characters and camera. This is CRITICAL for position consistency between first/last frames and cross-shot continuity.>",
      "body_posture": "<BODY POSTURE only — e.g. 'lying on bed', 'sitting on edge of bed', 'standing', 'kneeling on floor', 'crouching'. NEVER write camera framing here (no 'close-up', 'extreme close-up', etc). If shot is close-up but context implies lying/sitting, infer from scene context>",
      "clothing": "<clothing description, e.g. 'white hanfu robe, loosened collar'>",
      "expression": "<facial expression, e.g. 'pained, eyes closed', 'tearful, concerned'>",
      "props": ["<prop1>", "<prop2>"]
    }
  },
  "lighting": "<color temperature and direction, e.g. 'warm amber sidelight from window'>",
  "location": "<scene location, e.g. 'ancient Chinese bedroom, daytime'>",
  "overall_composition": "<brief overall layout note e.g. 'two-shot, woman left, man right, medium wide framing'>"
}

Rules:
- Only include characters that are explicitly described in the prompt
- Keep each field concise (≤15 words)
- **screen_position is the MOST IMPORTANT field for solving "人物站位经常变"** — extract or infer precise left/center/right placement + relation to other characters/camera from the prompt description. If the prompt mentions "left", "right", "beside", "opposite", "in front of", use that. For first/last frame pairs this enables layout locking.
- body_posture MUST describe physical body state, NOT camera shot type. Infer from scene context if needed (e.g. bedroom scene + lying character → 'lying on bed')
- If a detail truly cannot be determined even by inference, use null

Input:
PROMPT: <the completed image generation prompt>
ASSETS: <character names present in this shot>`;
}

/**
 * 为单个分镜重新生成/优化 layout_description（空间布局与人物站位合同）
 * 专为首尾帧一致性 + 上下分镜连贯性设计
 */
function getRegenerateLayoutDescriptionPrompt(cfg) {
  const isEn = isEnglish(cfg);
  if (isEn) {
    return `You are a professional film continuity supervisor and storyboard spatial designer.

Your task: Regenerate or optimize a precise, concise "layout_description" (spatial layout anchor / 画面布局锚点) for the CURRENT shot.

Core Requirements (HIGHEST PRIORITY):
1. Output ONLY the new layout_description text (1-2 short sentences, max ~120 characters). No explanations, no JSON, no labels.
2. Be extremely specific about screen positions: left/center/right third of frame, relative distances between characters, facing directions, relation to props/environment, overall composition (rule of thirds / center / frame etc.), and camera distance feel.
3. **Realistic physical scale awareness (MANDATORY)**: Explicitly state realistic sizes and proportions of major props that actually appear in the shot, matching the story's era/setting (e.g. ancient: writing desk ~75cm, scroll at normal size; modern: side table ~45cm). Never write phrases that would cause scale errors or anachronistic modern props in period settings.
4. **Cinematic breathing room for movement (MANDATORY)**: Reserve natural evolution space for the shot's declared camera_movement (push/pull/pan/handheld etc.). State that first/last frames must keep core character placement and realistic prop scales, but allow natural framing adjustments that result from the movement (e.g. slight tighter framing on push-in, slight handheld drift, natural entry/exit on pan). Goal: enable real dynamic video instead of near-static locked shots.
5. **Cross-shot continuity (CRITICAL)**: The new layout MUST form a natural, believable spatial continuation from PREV_LAYOUT (if provided) and must logically lead into NEXT_LAYOUT (if provided). Avoid sudden unexplained left-right flips or major repositioning of characters between adjacent shots unless the ACTION/RESULT of the current shot explicitly requires it.
6. The description must be directly usable as the highest-priority contract for H3 FL2VA first-frame and last-frame image generation, and must embed both realistic scale anchors AND movement breathing room to prevent prop drift and motion suppression in AI image/video generation.

Style: Professional, film-precise, actionable for AI image generators. Use Chinese if the project is Chinese, otherwise English.`;
  }
  return `你是一位专业的电影连戏监督与分镜空间设计师。

任务：为**当前分镜**重新生成或优化一个精确、简洁的「layout_description」（空间布局锚点 / 画面布局与人物站位合同）。

核心要求（最高优先级）：
1. **只输出新的 layout_description 文本**（1-2 句短句，总字数建议控制在 120 字以内）。不要任何解释、不要 JSON、不要前缀后缀。
2. 必须极度具体描述画面站位：画面左/中/右三分、人物间相对距离、朝向、与道具/环境的关系、整体构图方式（三分法/中心/框架等）、机位距离感。
3. **真实物体尺度意识（强制）**：必须明确写出主要道具的真实物理尺度与相对比例，且**必须符合剧本时代背景**（仅写本分镜实际出现的道具；古代场景示例：“木质案几位于右下前景，高度约75cm，书卷平放为正常尺寸，铜灯与茶具均为次要环境小物件，绝不夸大”）。严禁写出任何会导致比例失真的表述，**严禁写入与时代不符的现代道具**。
4. **运镜呼吸空间（强制）**：必须为本分镜的 movement（推/拉/摇/跟/手持等）预留自然演化空间。说明首尾帧在核心站位和真实尺度一致的前提下，允许根据 movement 进行取景微调（缓推可稍紧、手持可轻微晃动偏移、横摇可有自然进入/退出）。目标是让首尾帧支持真正动态的视频，而不是几乎定格。
5. **跨镜连贯性（铁律）**：新布局必须与「上一分镜的布局描述」形成自然延续，同时能引向下一分镜。除非 action/result 明确要求，否则严禁突然左右互换或大幅跳跃。
6. 该描述将作为 H3 FL2VA 首帧/尾帧生成的最高优先级合同，必须同时包含真实尺度锚点 + 运镜演化空间，防止AI生图时道具比例漂移或运镜被锁死。

语气：专业、电影化、精确、可直接喂给图像 AI 使用。必须用中文输出。`;
}

/**
 * 角色视觉锚点提取：从 appearance 文本中提炼 6层结构化锚点 JSON
 * 供 characterGenerationService 调用，生成结果存入 identity_anchors 字段
 */
function getIdentityAnchorsPrompt() {
  return `You are a character visual analyst. Extract precise visual identity anchors from character appearance descriptions.

Output ONLY a valid JSON object with these exact 6 keys:
{
  "face_shape": "precise description of face/skull shape, jawline, cheekbones (e.g. oval face, sharp jawline, high cheekbones)",
  "facial_features": "eye shape+color+Hex, nose bridge+tip, lip thickness+shape (e.g. almond eyes #3D2B1F, straight nose, thin lips)",
  "unique_marks": "scars, moles, tattoos, birthmarks, distinctive features — or 'none'",
  "color_anchors": {
    "hair": "#HexCode (e.g. #1A0A00 for black, #C8A96E for blonde)",
    "eyes": "#HexCode",
    "skin": "#HexCode (e.g. #F5DEB3 for wheat, #FDDBB4 for fair)",
    "primary_outfit": "#HexCode of dominant clothing color"
  },
  "skin_texture": "skin tone description + texture (e.g. fair porcelain smooth, tanned slightly weathered)",
  "hair_style": "length + style + texture (e.g. shoulder-length wavy black hair with loose strands, short crew cut)"
}

Rules:
- Use Hex color codes for ALL color values — never use color names like "black" or "brown"
- Extract ONLY what is explicitly stated; infer Hex values from color descriptions
- Keep each field concise (1-2 sentences max)
- If information is missing for a field, write "unspecified"
- Output ONLY the JSON object, no markdown, no explanation`;
}

/**
 * 道具单视图图片提示词润色器
 * 将道具描述转换为精准的 AI 绘图提示词（单图，突出道具本体）
 */
function getPropPolishPrompt(cfg) {
  const styleZh = styleTextZhForPolish(cfg);
  const styleEn = styleTextEnForImage(cfg);
  if (isEnglish(cfg)) {
    return `# 道具图片提示词生成器

## 你的身份
你是专业的影视道具美术与产品摄影指导，负责把道具描述写成**资产主图级**英文生图提示词（供剧组道具库 / AI 参考单图使用）。

## 核心规则

### 剧本信息隔离（强制）
- 用户输入可能含剧本人名、地名、台词或剧情——**一律不得**写入最终英文 prompt（含音译名、拼音、引号对话）。若输入出现姓名，用 **generic role-neutral** 措辞改写或删除（例如仅保留 "small engraved lettering" 而**不写**具体名字）。
- **零扩展**：只保留输入里**已写明或可合理从材质/形制直接读出**的视觉信息；**禁止**新增配饰、品牌/朝代故事、情绪叙事、电影化形容词堆砌、与物体无关的联想词。

### 主体与背景（【最高优先级强制铁律】- 违反即严重失败）
- **唯一主体 + 零背景铁律（CRITICAL）**：画面中**只能有这一件道具**，**100% 纯色无缝无限影棚背景（seamless cyclorama / infinite solid color backdrop）**，**绝对禁止任何环境、地面、台面、墙壁、地板、阴影投射在表面、渐变、纹理、室内外元素**。背景必须是单一哑光纯色（推荐与道具形成高对比的中性浅灰或中性深灰，便于抠像），**不得出现任何除道具本体以外的像素**。
- **严禁模型常见错误**：严禁生成“漂亮的室内场景”“木质桌面”“大理石台面”“柔焦背景”“环境光影”“地面反射”“轻微景深”“工作室一角”“放在架子上”等任何背景或支撑面描述。任何导致背景不是纯色的输出都属于失败。
- **零杂物**：禁止桌面散落物、书本、植物、器皿、布料堆叠、包装箱、工具、第二件道具、灰尘烟雾粒子、景深虚化里的「远处物体」等；除非描述明确该物为道具不可分割的一部分，否则一律不出现。

### 质感与光
- 材质、镀层、磨损、刻字（若有）、比例暗示要写具体（可量化词汇：brushed / matte / polished / micro-scratches）；**句子宁少勿多**。
- **光**：柔和均匀的棚拍光（large softbox, even illumination），仅允许**极轻**的接触阴影以锚定体量，**禁止**戏剧轮廓光、强逆光、体积光、镜头眩光、色散、电影级低 key 高反差。

### 硬性排除
- 禁止：人物、手、身体任何部分、文字水印、商标（除非剧情指定且为道具本体一部分）、叙事性场景词、**任何专有名词式剧本标签**。${styleZh ? '\n- **画风风格**（仅作用于渲染质感，不改变「单道具 + 纯色底」版式）：' + styleZh : ''}

### 输出格式
直接输出**一段**英文 prompt（约 **45–90 词**，能更短则更短），不要解释、标题、列表或引号。
**必须**在同一段内显式包含短语或等价表达：**single prop only**, **seamless solid-color studio backdrop**, **no extra objects**, **no people**, **no hands**, **no environment**；末尾再接画风：${styleEn ? styleEn + ' render style' : 'photorealistic product hero shot'}`;
  }

  // 中文版：根据项目「语音」（专业影视中文提示词风格 + 真实尺度铁律 + 次要元素原则）输出中文图生提示词
  return `# 道具图片提示词生成器（中文版）

## 你的身份
你是专业的影视道具美术与产品摄影指导，负责把道具描述写成**资产主图级中文生图提示词**（供剧组道具库 / AI 参考单图使用，匹配项目中文影视提示词语音与真实尺度铁律）。

## 核心规则

### 剧本信息隔离（强制）
- 用户输入可能含剧本人名、地名、台词或剧情——**一律不得**写入最终中文 prompt（含音译名、拼音、引号对话）。若输入出现姓名，用泛化中性描述改写或删除（例如仅保留"刻有细小铭文"而**不写**具体名字）。
- **零扩展**：只保留输入里**已写明或可合理从材质/形制直接读出**的视觉信息；**禁止**新增配饰、品牌/朝代故事、情绪叙事、电影化形容词堆砌、与物体无关的联想词。

### 主体与背景（【最高优先级强制铁律 - 违反即严重失败】）
- **唯一主体 + 纯色零背景铁律（CRITICAL）**：画面中**只能有这一件道具**，**100% 纯色无缝无限影棚背景（单一哑光纯色 seamless cyclorama / infinite solid color backdrop）**，**绝对禁止任何环境、地面、台面、墙壁、地板、阴影投射、渐变、纹理、室内外元素**。背景必须是与道具形成高对比的中性纯色（浅灰或深灰最佳，便于抠像），**不得出现任何除道具本体以外的像素**。
- **严禁模型常见错误**：严禁生成“漂亮的室内场景”“木质桌面”“大理石台面”“柔焦背景”“环境光影”“地面反射”“轻微景深”“工作室一角”“放在架子上”“放在地板上”等任何背景或支撑面描述。任何导致背景不是纯色的输出都属于失败。
- **零杂物**：禁止桌面散落物、书本、植物、器皿、布料堆叠、包装箱、工具、第二件道具、灰尘烟雾粒子、景深虚化里的「远处物体」等；除非描述明确该物为道具不可分割的一部分，否则一律不出现。
- **真实物理尺度铁律（最高优先级）**：道具必须严格遵循其所属时代的真实世界物理尺寸与相对比例；道具在画面中为**严格次要环境元素**，严禁夸大、立起、成为主导视觉或破坏透视。

### 质感与光
- 材质、镀层、磨损、刻字（若有）、比例暗示要写具体（可量化词汇：拉丝/哑光/抛光/微细划痕）；**句子宁少勿多**。
- **光**：柔和均匀的棚拍光，仅允许**极轻**的接触阴影以锚定体量，**禁止**戏剧轮廓光、强逆光、体积光、镜头眩光、色散、电影级低 key 高反差。

### 硬性排除
- 禁止：人物、手、身体任何部分、文字水印、商标（除非剧情指定且为道具本体一部分）、叙事性场景词、**任何专有名词式剧本标签**。${styleZh ? '\n- **画风风格**（仅作用于渲染质感，不改变「单道具 + 纯色底」版式）：' + styleZh : ''}

### 输出格式
直接输出**一段**中文提示词（约 **45–90 字**，能更短则更短），不要解释、标题、列表或引号。
**必须**在同一段内自然包含以下关键约束的中文表述（或等价流畅说法）：单一主体、纯色无缝棚拍背景、无多余物体、无人物、无手、无环境；并融入真实尺度与次要元素要求；末尾再接画风：${styleZh ? styleZh + ' 渲染质感' : '写实产品主图质感'}`;
}

module.exports = {
  getLanguage,
  isEnglish,
  getCharacterExtractionPrompt,
  getPropExtractionPrompt,
  formatUserPrompt,
  getFirstFramePrompt,
  getKeyFramePrompt,
  getLastFramePrompt,
  getSceneExtractionPrompt,
  getStoryboardSystemPrompt,
  getUniversalOmniMultiBeatFormatSpec,
  getStoryboardUniversalOmniModeSuffix,
  getStoryboardUserPromptSuffix,
  getStoryboardNarrationExtraInstructions,
  getStoryboardNarrationModeInstructions,
  getStoryExpansionSystemPrompt,
  buildStoryExpansionUserPrompt,
  getRolePolishPrompt,
  getRoleGenerateImagePrompt,
  getScenePolishPrompt,
  getScenePolishPromptSingle,
  getSceneGenerateImagePrompt,
  getSceneGenerateSingleImagePrompt,
  getImagePolishPrompt,
  getClassicVideoPromptPolishPrompt,
  getUniversalOmniSegmentPrompt,
  getUniversalOmniPolishPrompt,
  getContinuitySnapshotPrompt,
  getIdentityAnchorsPrompt,
  getPropPolishPrompt,
  loadOverridesIntoCache,
  setOverrideInMemory,
  clearOverrideInMemory,
  getDefaultPromptBody,
  getLockedSuffix,
  getRegenerateLayoutDescriptionPrompt,
  getRealisticPhysicalScaleContract,
};
