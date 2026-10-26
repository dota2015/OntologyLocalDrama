/**
 * 影视导演视听编排智能体（Audiovisual Director ReAct Agent）
 * 践行 /home/nvidia/ontology-semantic-system 的核心哲学：
 * 1. 语义图绑定：以不可变 DramaSemanticPackage 为世界事实底座
 * 2. 动能调度：严格少用固定镜头，根据情绪与动作调度推拉摇跟
 * 3. 音画多模态：无对白分镜绑定原生 BGM 描述供 H3 视频生成
 * 4. 自我反思纠偏环（Critic & Reflection Loop）：通过 SHACL 风格的 validateAllInvariants 检验草稿，发现违规自动修正
 */

const { compileDramaSemanticPackage } = require('./semanticPackage');
const { validateAllInvariants } = require('./invariants');
const { extractAllEntitiesFromScript } = require('./extractionAgent');
const { isAssetObsolete } = require('./assetMatcher');
const {
  composeStoryboardImagePrompt,
  composeStoryboardVideoPrompt,
  rebuildPromptsForStoryboard,
  isFlawedImagePrompt,
  sanitizeStaticImagePrompt,
} = require('../services/episodeStoryboardService');
const aiClient = require('../services/aiClient');
const { safeParseAIJSON, extractFirstArray } = require('../utils/safeJson');
const angleService = require('../services/angleService');
const dramaService = require('../services/dramaService');
const { generateStory } = require('../services/storyGenerationService');

/**
 * 运行影视导演智能体，完成从剧本/资产到高精分镜的闭环推演
 * @param {object} db - SQLite 数据库
 * @param {object} log - 日志记录器
 * @param {object} cfg - 全局配置
 * @param {number|string} episodeId - 剧集 ID
 * @param {object} [options] - 选项 (storyboardCount, premise, forceExtractEntities)
 * @returns {Promise<{ storyboards: Array, audit: object, semantic_revision: string }>}
 */
async function runDirectorAgent(db, log, cfg, episodeId, options = {}, progressCallback = null) {
  const epId = Number(episodeId);
  const onProgress = typeof options.onProgress === 'function'
    ? options.onProgress
    : (typeof progressCallback === 'function' ? progressCallback : () => {});

  log.info('[导演Agent] 启动剧集视听本体调度', { episode_id: epId });
  onProgress(5, '启动剧集视听本体调度，准备解析剧本...');

  // 确保 storyboards 具有 character_visuals, last_frame_visuals, video_slots 槽位列
  try {
    const cols = db.prepare('PRAGMA table_info(storyboards)').all().map(c => c.name);
    if (!cols.includes('character_visuals')) {
      db.prepare('ALTER TABLE storyboards ADD COLUMN character_visuals TEXT').run();
    }
    if (!cols.includes('last_frame_visuals')) {
      db.prepare('ALTER TABLE storyboards ADD COLUMN last_frame_visuals TEXT').run();
    }
    if (!cols.includes('video_slots')) {
      db.prepare('ALTER TABLE storyboards ADD COLUMN video_slots TEXT').run();
    }
    if (!cols.includes('long_take_group_id')) {
      db.prepare('ALTER TABLE storyboards ADD COLUMN long_take_group_id TEXT').run();
    }
    if (!cols.includes('long_take_role')) {
      db.prepare('ALTER TABLE storyboards ADD COLUMN long_take_role TEXT').run();
    }
    if (!cols.includes('long_take_sequence')) {
      db.prepare('ALTER TABLE storyboards ADD COLUMN long_take_sequence INTEGER').run();
    }
  } catch (_) {}

  const epRow = db.prepare('SELECT id, drama_id, script_content, title, duration FROM episodes WHERE id = ? AND deleted_at IS NULL').get(epId);
  if (!epRow) throw new Error('剧集不存在');
  const dramaId = epRow.drama_id;

  // 阶段零：故事与分集剧本创编（若提供了梗概 premise 或原剧本为空）
  let scriptContent = (epRow.script_content || '').trim();
  if (options.premise || !scriptContent) {
    onProgress(10, '根据故事梗概推演剧本戏剧冲突与正文...');
    log.info('[导演Agent] 阶段零：根据故事梗概推演剧本戏剧冲突与正文...', { episode_id: epId });
    const premiseText = (options.premise || epRow.title || '精彩短剧').trim();
    const dramaRow = db.prepare('SELECT title, genre, style FROM dramas WHERE id = ?').get(dramaId) || {};
    const scriptPrompt = `你是一位院线级短剧导演兼总编剧。
请为短剧《${dramaRow.title || '短剧'}》（题材：${dramaRow.genre || '剧情'}，风格：${dramaRow.style || '写实'}）撰写第 ${epRow.title || '1'} 集的完整拍摄剧本。

【故事大纲 / 梗概】：
${premiseText}

【编剧要求】：
1. 包含核心戏剧冲突与转折，剧情节奏紧凑，扣人心弦。
2. 包含清晰的角色对白与动作描写。
3. 纯正剧本格式，约 600-1000 字。`;

    const generatedScript = await aiClient.generateText(db, log, 'text', scriptPrompt, '你是一位专业影视导演兼编剧。', { max_tokens: 3000, reasoning_effort: 'high' });
    if (generatedScript && generatedScript.trim()) {
      scriptContent = generatedScript.trim();
      db.prepare('UPDATE episodes SET script_content = ?, updated_at = ? WHERE id = ?').run(scriptContent, new Date().toISOString(), epId);
      log.info('[导演Agent] 阶段零：剧本推演完成并持久化', { length: scriptContent.length });
    }
  }

  if (!scriptContent || !scriptContent.trim()) {
    throw new Error('剧本为空，无法执行导演分镜推演');
  }

  // 阶段一：世界观资产自动统一抽取（角色外貌锚点、道具真实物理尺寸、场景空间地标）
  const existingChars = db.prepare('SELECT id FROM characters WHERE drama_id = ? AND deleted_at IS NULL').all(dramaId);
  const existingScenes = db.prepare('SELECT id FROM scenes WHERE drama_id = ? AND deleted_at IS NULL').all(dramaId);

  let extractedAssets = null;
  if (options.forceExtractEntities || existingChars.length === 0 || existingScenes.length === 0) {
    onProgress(20, '自动抽取全量世界观实体资产（角色、道具真实尺度、场景地标）...');
    log.info('[导演Agent] 阶段一：自动抽取全量世界观实体资产（角色、道具真实尺度、场景地标）...', { drama_id: dramaId, episode_id: epId });
    extractedAssets = await extractAllEntitiesFromScript(db, log, cfg, epId);
  }

  // 阶段二：编译不可变剧目语义包（Semantic Package）
  onProgress(30, '编译不可变剧目语义包与镜头时长预算...');
  const semPkg = compileDramaSemanticPackage(db, epId);

  const targetCount = options.storyboardCount || options.storyboard_count || Math.max(6, Math.min(35, Math.ceil(scriptContent.length / 45)));
  const targetDuration = semPkg.episode.duration_target || 60;
  const singleShotDuration = Math.round(targetDuration / targetCount);

  // 2. 组织具有本体约束的导演推演提示词
  const userDirectives = (options.userDirectives || options.directives || options.feedback || '').trim();
  const directiveSection = userDirectives
    ? `\n【用户导演最新指导与调整记忆（最高优先级执行，必须严格遵从）】：\n${userDirectives}\n`
    : '';

  const systemPrompt = `你是一位严谨的院线级短剧导演与场面调度摄影指导（Cinematographer & Director Agent）。
你必须依据提供的【不可变剧目本体世界观与实体资产】，将剧本拆解为富有电影流动感的专业分镜。

${semPkg.getSystemDigest()}
${directiveSection}
【导演核心视听铁律（必须遵守，违反将被质检打回）】：
1. **严格少用固定镜头 (static)**：短剧切忌死板定格如幻灯片！全片固定镜头占比严格控制在 10% 以下。
   - 对白/反应镜头：使用微推(push)或微拉(pull)锁定情绪与呼吸感；
   - 动作/位移镜头：使用平稳跟拍(tracking)或横摇(pan)；
   - 紧张冲突/负伤/混乱：使用手持微晃(handheld)增强临场感；
   - 展现环境/全貌：使用后拉(pull)或横摇(pan)。
2. **多模态音频设计**：
   - 有台词分镜：bgm_prompt 填空串""，保障说话人声与口型清晰；
   - 无台词分镜（纯动作/潜行/环境/对峙）：**必须在 bgm_prompt 填写具体的电影原声配乐描述**（如“低沉紧迫的战术重低音脉冲与心跳打击乐”），供 H3 视频模型原生合成高质量背景音乐。
3. **H3 视频生成物理硬约束与智能拆镜（适配 H3 模型 9 张参考图物理上限）**：
   - **模型物理上限为 9 张参考图**：MiniMax H3 单镜头输入包含：首尾帧锚点（至多2张）+ 场景图（1张）+ 角色人设图（每人1张）+ 道具图（每件1张）。一旦超出 9 张或单镜要素过多，模型将严重变形、崩溃或报错！
   - **单镜出场角色严格限制在 1～2 人**：绝不可把 3 个及以上角色塞入同一个分镜！遇多人交互场景，**必须主动拆镜**为正反打镜头序列（如：镜1「角色A动作中景」➔ 镜2「角色B反应特写/反打」➔ 镜3「角色C介入动作」）。
   - **单镜核心交互道具严格限制在 1 件**（至多不超过 2 件）：每个分镜只能聚焦 1 个核心交互道具（如拔枪、递药、看屏幕）。无实质物理交互的静态背景物件不作为道具挂载，**严禁在一个镜头中挂载 3 件以上道具**！
   - **单镜动作原子化**：单个 4~8 秒分镜只承载 1 个连贯物理动作弧线。复杂长动作必须拆解为连续镜头序列，避免模型动作失真或无法收敛。
4. **空间站位与真实尺度合同（layout_description）**：必须指明角色在画面左/中/右的站位，并标明出现的道具真实尺度（如案几高约75cm），确保为 movement 预留演化呼吸空间。
5. **纯物理视觉描写**：严禁心理修辞与文学隐喻（如“焦急凝结”、“高低对照”），只写可见姿态与光影。
6. **生图提示词（image_prompt）与视频提示词（video_prompt）的绝对区分与定格物理法则**：
   - 视频提示词（video_prompt）描述时间流逝、运镜推拉、动作发生全过程（如“从A走到B，按下肩膀，随后转头”）。
   - 图片提示词（image_prompt）必须是【首帧决断时刻的纯静态画面定格摄影描写（Freeze-frame photo）】：
     a. **严禁视频化时序动态与过程动词**：绝对禁止出现“看了一眼”、“沿...走到...”、“开始转向”、“突然扑向”、“随后”等动态叙事词！必须转化为定格姿态（如：“蜂医沿掩体走到露娜右侧按下肩膀” ➔ 必须写成：“蜂医半蹲停在露娜右侧，单手按在露娜肩头，两人身体压低隐蔽在掩体后”；“快速向右侧岔路看了一眼” ➔ 必须写成：“头偏向右侧，目光警戒地注视着右侧岔路口”）。
     b. **严禁抽象或残缺姿态**：绝对禁止只写人物名字或“某某身体”！遇到动态失衡（如“失去平衡”），必须明确具体定格姿态（如“身体大幅向侧方倾斜失衡，单手伸出撑向地面，重心向下滑落的惊险定格瞬间”）。
     c. **静态构图三要素必须完整**：
        - 躯干重心与体态（站立/深蹲/半蹲/单膝跪姿/身体前倾30度/侧身靠墙）；
        - 四肢与双手动作（双手搭在键盘上/单手按住掩体/右手紧握武器/单手按住对方肩膀）；
        - 头部角度与视线朝向（侧头注视右侧/目光紧盯屏幕/双眼戒备注视通道）。
7. **台词时长硬预算与强制语义拆镜（Speech Timing Budget & Atomic Split）**：
   - 视频模型标准语速每秒约 3.5~4 个中文字，且每个镜头必须保留至少 1 秒收尾动作与呼吸停顿。
   - 镜头时长预算铁律：4秒<=12字；5秒<=16字；6秒<=20字；7秒<=24字；8秒<=28~32字。
   - **绝对禁止在一个镜头内塞入超出时长预算的冗长对白或旁白！**
   - **长台词必须拆镜**：遇长台词或包含多句话的对白，必须在标点符号（逗号/句号/感叹号）处主动切分拆解为 2 个以上连续分镜（如正反打镜头：前一句配说话人动作，后一句切听者反应特写或说话人进一步动作承接）；
   - **禁止删改剧本台词**：拆镜时必须逐字完整保留原剧本对白与说话人，按顺序分配到拆解后的各分镜中，不允许缩写、偷换或通过强行加速说话来逃避拆镜！
8. **角色与生图构图五层视听矩阵（Cinematic Visual Slots Matrix）**：
   - **杜绝模板式假槽位套话**：严禁出现“身体保持戒备低姿，重心稳固隐蔽”、“双手紧握装备保持待发状态”、“目光专注注视前方”等万能模板套话！必须根据该分镜的【剧本具体动作、场景空间反差与人物生理微状态】进行具象定格描写！
   - **单镜五维视听构图槽位**：
     * environment_depth: 空间三层纵深（必须明确：前景虚化遮挡物、中景主体物理接触地表/构件、背景视线尽头材质与灭点透视；如“前景右下角虚化遮挡着锈蚀钢架，中景地表散落碎石与断裂线缆，背景纵深处是雨水横流的防爆玻璃窗与闪烁微弱绿色荧光的故障控制台”）
     * lighting_chiaroscuro: 影视打光与影调质感（主光方向、轮廓光/侧逆光、局部冷暖发光、高反差阴影；如“自破损天窗斜射而入的硬质冷白天光，右侧荧光屏在人物面颊勾勒出幽蓝侧轮廓光，伴随深重电影级侧影暗部”）
     * cinematic_lens: 电影镜头光学参数（如“35mm宽银幕电影镜头抓拍，f/2.8浅景深焦外散景，微弱柯达35mm胶片颗粒质感”）
     * character_visuals 内部强类型槽位（出场角色必须填写）：
       - character_id: 角色ID
       - name: 角色名字
       - screen_position: 画面构图位置【极其重要】（必须明确：画面左侧前景 / 画面正中央 / 画面右侧中景 / 画面左侧三分线 等，双人戏严禁两人挤在正中央重叠穿模）
       - environmental_anchor: 物理环境依托（低矮断墙后 / 实木书桌前 / 走廊转角掩体）
       - facing: 人物朝向（必须明确：正面面对镜头 / 背向镜头 / 侧身朝向画面左侧 / 侧身朝向画面右侧 / 侧向四分之三面朝左 / 侧向四分之三面朝右）
       - expression: 面部微表情与神态（如：咬肌紧绷、瞳孔微聚盯防、下颌微收、冷峻警惕、嘴角抿直）
       - head_pose: 头部姿态（头部正对前方 / 头部微仰 / 低头咬牙 / 侧头偏向右侧 / 侧头偏向左侧 / 转头回望）
       - gaze: 目光视线落点（双眼紧盯前方冷光屏幕 / 目光警惕锁定高窗火力点 / 视线锁定右侧岔路）
       - posture: 躯干体态与重心（必须结合剧本写实，禁止套话：如“双膝跪地双手撑在碎石地上” / “身体前倾靠在控制台边缘”）
       - hands: 双手具体四肢定格（必须结合具体动作与接触点）
       - prop_interaction: 手指与道具具体的物理接触点（如：食指扣在磨砂黑战术终端侧键边缘，拇指悬停在确认键上方）
       - appearance_details: 服装质感与生理状态（如：额角渗出的细密冷汗与被汗浸湿贴在前额的凌乱碎发、粗糙抗撕裂战术背心上的泥渍刮擦）
   - 槽位中严禁出现“从A到B”、“跑向”、“走到”、“随后”、“看了一眼”等动态时序过程词，文生图模型会将两地各画一人产生克隆分身！必须是首帧决定性瞬间的纯静态摄影描写！
9. **连贯长镜头结构化拆解与接力规范（Long Take Relaying & Sequential Splitting）**：
   - **适用情境**：影视短剧中，连续动作追逐、长走廊/房间连续漫游、连贯推移跟拍等大段无切机位的视听情境。因 AI 视频模型单镜仅能生成 4~8 秒，必须将长镜头拆分为多个连续子镜头（如镜头2~5）。
   - **长镜头结构化输出**：
     * long_take_group_id: 组标识（同一个长镜头的所有子镜头填写相同字符串，如 "ltg_1"；普通独立切换机位镜头填 null 或 ""）
     * long_take_role: 组内角色：
       - "head": 长镜头组首（必须有完整的首帧纯静态摄影 image_prompt，供文生图生成起始帧）；
       - "continuation": 接力续镜（动作接力延续，系统视频生成时自动提取上一镜视频尾帧作为起始帧，无需独立盲画首帧图）；
       - "tail": 终镜收束（长镜头组收尾镜头，同样承接上一镜尾帧）。
     * long_take_sequence: 组内接力次序（1, 2, 3...）。
   - **长镜头动线与运镜合同**：
     * 组首、续镜、终镜机位与运镜必须具备空间与动线连续性（如 tracking -> pan/tracking -> handheld 逼近）；
     * continuation/tail 镜头的 action 与 video_prompt 必须明确写出动作承接（例如：“紧接上一画面奔跑惯性，红狼冲入掩体并顺势滑铲...”）。

【目标参数】：总分镜数约 ${targetCount} 镜，单镜平均约 ${singleShotDuration} 秒。`;

  const userPrompt = `【剧本内容】：
${scriptContent}

【任务要求】：
请以纯 JSON 格式输出 {"storyboards": [...]}。每个分镜包含：
- shot_number: 镜头序号 (从 1 递增)
- long_take_group_id: 长镜头组ID (属于同一长镜头的子镜头填相同ID如 "ltg_1"，独立镜头填 null)
- long_take_role: 长镜头角色 (head / continuation / tail，独立镜头填 null)
- long_take_sequence: 长镜头组内次序 (1, 2, 3...，独立镜头填 null)
- title: 3-5字镜头标题
- scene_id: 所属场景ID (必须选自可用场景目录)
- characters: 出场角色ID数组 (如 [1, 2]，单镜出场角色最多3人（<=3人），严禁超过3人（>3人）)
- props: 出场或交互的核心道具ID数组 (如 [1]，选自可用道具目录，严格0~2件，无道具填 [])
- shot_type: 景别 (大远景/远景/全景/中景/近景/特写)
- angle_h: 水平视角 (front/front_left/front_right/left/right/back)
- angle_v: 俯仰角 (eye_level/low/high/worm)
- angle_s: 景别尺度 (wide/medium/close_up)
- movement: 运镜 (push/pull/pan/tilt/tracking/handheld/crane_up/crane_dn/orbit；少用 static)
- lighting_style: 灯光风格 (natural/side/backlit/dramatic/soft/golden_hour/blue_hour/night/neon)
- lighting_chiaroscuro: 影视打光与影调质感 (主光方向、轮廓光/侧逆光、局部冷暖发光、高反差明暗影调描写)
- environment_depth: 空间三层纵深 (前景虚化遮挡、中景主体物理接触地表/构件、背景纵深透视与材质细节)
- cinematic_lens: 电影镜头光学参数 (如 35mm宽银幕变形镜头/85mm定焦大光圈浅景深焦外散景)
- depth_of_field: 景深 (shallow/medium/deep)
- duration: 本镜秒数 (整数，4~8之间，必须匹配台词字数预算)
- action: 核心物理动作
- result: 动作收束结果
- dialogue: 台词 ("角色名: \"台词\""，无对话填 "")
- narration: 旁白 (无则 "")
- bgm_prompt: 背景音乐描述 (无对话时必填具体的音乐风格与节奏)
- sound_effect: 现场音效与动作声音
- layout_description: 画面站位与物体尺度空间合同
- emotion: 核心情绪
- character_visuals: 出场角色视觉槽位数组 (每个出场角色必须完整填写槽位，严禁套话：
    {"character_id": 1, "name": "角色名", "screen_position": "画面构图位置（画面左侧前景/画面正中央/画面右侧中景等）", "environmental_anchor": "物理环境依托（掩体后/书桌前等）", "facing": "朝向（正面面对镜头/背向镜头/侧身朝向画面左侧/侧身朝向画面右侧）", "expression": "具象面部微表情（咬肌紧绷/瞳孔微聚/嘴角抿直等）", "head_pose": "头部姿态（头部正对前方/头部微仰/低头/侧头偏向右侧）", "gaze": "目光视线（双眼紧盯前方/目光警惕锁定右侧岔路）", "posture": "具体的躯干体态与重心定格", "hands": "双手与四肢具体动作", "prop_interaction": "手指与道具具体的物理接触点", "appearance_details": "服装质地与生理战损微状态"}
  无角色填 [])
- image_prompt: 画面视觉构图提示词 (供AI生图使用，按上述槽位综合生成的首帧纯静态定格摄影描写)

只返回纯 JSON，不要 markdown。`;

  onProgress(40, '导演智能体正在规划场面调度、机位构图与动感运镜...');
  log.info('[导演Agent] 阶段一：初稿推演生成中...');
  const firstDraftRaw = await aiClient.generateText(db, log, 'text', userPrompt, systemPrompt, { max_tokens: 8000, reasoning_effort: 'high' });
  const parsedFirstDraft = safeParseAIJSON(firstDraftRaw, null, log);
  let shots = extractFirstArray(parsedFirstDraft) || [];

  if (shots.length === 0) {
    throw new Error('导演智能体生成分镜失败：模型未返回合法分镜数组');
  }

  // 3. 阶段二：运行视听本体质量门禁（SHACL Invariants Check）
  onProgress(70, '初稿分镜推演完成，正在执行视听本体硬门禁审查...');
  log.info('[导演Agent] 阶段二：执行视听本体硬门禁审查', { shot_count: shots.length });
  let audit = validateAllInvariants(shots, { db, props: semPkg.catalogs.props, dramaEra: semPkg.drama.era });

  // 4. 阶段三：反思自纠环（Critic & Reflection Loop）
  if (!audit.valid && audit.error_count > 0) {
    onProgress(75, '检测到门禁规则瑕疵，触发导演智能体自省纠偏推理中...');
    log.warn('[导演Agent] 阶段三：发现硬门禁违规，触发自省纠偏环', { violations: audit.violations });
    const reflectionPrompt = `你在刚才推演的分镜草稿中违反了视听本体硬门禁规则：
${audit.violations.map(v => `- [${v.rule}] 镜头 ${v.shot_number || '全局'}: ${v.message}`).join('\n')}

请进行专业导演自省反思：
1. 立即将违规的固定镜头(static)修改为符合剧情动线的动态运镜（推镜 push、跟镜 tracking、手持 handheld 等）；
2. 为所有无对白的镜头补充高质量具体的 bgm_prompt 背景音乐描述；
3. 修正任何群戏或人脸拥挤违规；
4. 针对所有超出台词时长预算的分镜（INVARIANT_SPEECH_OVER_BUDGET），必须在标点符号处按语义拆分为 2 个以上连续分镜，或在 4~8 秒安全范围内适当延长镜头时长，严禁删减台词！
5. 针对生图槽位不全或包含动态动词的分镜（INVARIANT_SLOT_*）：
   必须为每个出场角色补齐完整槽位：screen_position(画面构图位置)、facing(朝向)、expression(微表情)、head_pose(头部姿态)、gaze(视线目光)、posture(体态重心)、hands(双手动作)、prop_interaction(道具物理接触点)，彻底消除“从A走到B”等导致多角色的时序位移动态词！
6. 严禁使用千篇一律的机械套话（如“身体保持戒备低姿，重心稳固隐蔽”、“双手紧握装备保持待发状态”），必须根据每个镜头剧本具体动作重写为具象的肢体定格姿态、手部微接触与生动微表情！

请输出修正后的完整 JSON: {"storyboards": [...]}`;

    try {
      const repairedRaw = await aiClient.generateText(db, log, 'text', `${userPrompt}\n\n当前草稿：\n${JSON.stringify({ storyboards: shots })}\n\n${reflectionPrompt}`, systemPrompt, { max_tokens: 8000, reasoning_effort: 'high' });
      const parsedRepaired = safeParseAIJSON(repairedRaw, null, log);
      const repairedShots = extractFirstArray(parsedRepaired);
      if (Array.isArray(repairedShots) && repairedShots.length > 0) {
        shots = repairedShots;
        audit = validateAllInvariants(shots, { db, props: semPkg.catalogs.props, dramaEra: semPkg.drama.era });
        log.info('[导演Agent] 自省纠偏完成，重新质检', { valid: audit.valid, remaining_errors: audit.error_count });
        onProgress(82, '自省纠偏完成，视听门禁质检通过...');
      }
    } catch (refErr) {
      log.warn('[导演Agent] 自我纠偏推理异常，回退使用工程兜底修复', { error: refErr.message });
    }
  }

  // 5. 阶段四：实体对齐与工程终检（确保每个镜头的数据完整性）
  onProgress(86, '正在校准对白节奏与分镜时长安全区间...');
  const speechDelivery = require('../services/speechDeliveryService');
  const { planShotDuration } = require('../utils/shotDurationRange');
  const { assessVideoSpeech } = require('../utils/speechTiming');
  const { enforceStoryboardSpeechTiming } = require('../services/storyboardSpeechService');
  const {
    synthesizeCharacterVisualSlots,
    compileImagePromptFromSlots,
    validateCharacterVisualSlots,
  } = require('./visualSlots');

  const finalShots = shots.map((s, idx) => {
    const shotNum = idx + 1;
    // 强制消除遗留的 static 违规
    let mov = angleService.normalizeMovement(s.movement);
    if (!mov || mov === 'static') {
      mov = angleService.inferMovement(s, { upgradeStatic: true });
    }

    // 强制消除无对白漏 BGM 违规
    let bgm = String(s.bgm_prompt || '').trim();
    if (!s.dialogue && (!bgm || bgm === '无' || bgm === '无BGM' || bgm === '禁BGM')) {
      bgm = angleService.inferBgmPrompt(s);
    }

    // H3 视频生成物理上限铁律：出场角色严格限制 <= 2，核心道具严格限制 <= 2（优先单件）
    const chars = (Array.isArray(s.characters) ? s.characters : []).slice(0, 2);
    const pids = (Array.isArray(s.props) ? s.props : (Array.isArray(s.prop_ids) ? s.prop_ids : [])).slice(0, 2);

    return {
      ...s,
      shot_number: shotNum,
      characters: chars,
      props: pids,
      movement: mov,
      bgm_prompt: bgm,
      lighting_style: angleService.normalizeLighting(s.lighting_style) || 'dramatic',
      depth_of_field: angleService.normalizeDof(s.depth_of_field) || 'medium',
      long_take_group_id: s.long_take_group_id ? String(s.long_take_group_id).trim() : null,
      long_take_role: s.long_take_role ? String(s.long_take_role).trim().toLowerCase() : null,
      long_take_sequence: s.long_take_sequence != null ? Number(s.long_take_sequence) : null,
    };
  });

  // 台词时长预算硬门禁兜底：自动时长适配或安全拆镜
  const speechValidatedShots = [];
  for (const s of finalShots) {
    const hasDialogue = !!(s.dialogue && String(s.dialogue).trim() && !/^(?:无|无对白|无对话|无台词|none|null|n\/a)[。.!！\s]*$/iu.test(String(s.dialogue).trim()));
    const hasNarration = !!(s.narration && String(s.narration).trim() && !/^(?:无|无旁白|无解说|none|null|n\/a)[。.!！\s]*$/iu.test(String(s.narration).trim()));

    if (!hasDialogue && !hasNarration) {
      speechValidatedShots.push(s);
      continue;
    }

    let dur = Number(s.duration) > 0 ? Number(s.duration) : 5;
    let delOptions = {};
    try {
      const del = speechDelivery.resolve(semPkg.drama?.style, s);
      delOptions = speechDelivery.budgetOptions(del);
    } catch (_) {
      delOptions = { speechRate: 1.44, turnPauseSeconds: 0 };
    }

    const assessment = assessVideoSpeech(s, s.video_prompt || '', dur, delOptions);
    if (assessment.ok) {
      speechValidatedShots.push(s);
      continue;
    }

    // 若超载，优先在安全时长范围 [4, 8] 秒内尝试扩展镜头时长适配
    const plannedDur = planShotDuration(s, { min: 4, max: 8 }, delOptions);
    const reAssessment = assessVideoSpeech(s, s.video_prompt || '', plannedDur, delOptions);
    if (reAssessment.ok) {
      log.info('[导演Agent] 镜头对白超出时长预算，自动在安全范围内微调镜头时长', {
        shot_number: s.shot_number,
        old_duration: dur,
        new_duration: plannedDur,
        required: reAssessment.requiredSeconds,
      });
      speechValidatedShots.push({ ...s, duration: plannedDur });
      continue;
    }

    // 若在 8 秒上限内仍放不下（长台词），启动智能拆镜
    log.info('[导演Agent] 镜头对白严重超长（8秒安全上限无法容纳），执行强制语义拆镜', {
      shot_number: s.shot_number,
      required: assessment.requiredSeconds,
    });
    try {
      const splitFragments = await enforceStoryboardSpeechTiming([s], {
        durationRange: { min: 4, max: 8 },
        generate: async (user, sys) => aiClient.generateText(db, log, 'text', user, sys, { max_tokens: 4000, reasoning_effort: 'high' }),
        onRepair: () => {},
      });
      speechValidatedShots.push(...splitFragments);
    } catch (splitErr) {
      log.warn('[导演Agent] 智能拆镜异常，采用上限时长兜底', { error: splitErr.message });
      speechValidatedShots.push({ ...s, duration: Math.min(10, Math.ceil(assessment.requiredSeconds)) });
    }
  }

  // 角色构图预置槽位、首尾帧与视频语义槽位硬门禁终检与自动补齐
  const { synthesizeLastFrameVisualSlots } = require('./visualSlots');
  const { synthesizeVideoSlots, compileVideoPromptFromSlots } = require('./videoSlots');

  const normalizedShots = speechValidatedShots.map((s, idx) => {
    const shotNum = idx + 1;
    let visuals = s.character_visuals;
    if (typeof visuals === 'string') {
      try { visuals = JSON.parse(visuals); } catch (_) { visuals = null; }
    }
    if (!Array.isArray(visuals) || visuals.length === 0 || validateCharacterVisualSlots(s, visuals).length > 0) {
      visuals = synthesizeCharacterVisualSlots(s, semPkg.catalogs.characters);
    }

    let lastVisuals = s.last_frame_visuals;
    if (typeof lastVisuals === 'string') {
      try { lastVisuals = JSON.parse(lastVisuals); } catch (_) { lastVisuals = null; }
    }
    if (!Array.isArray(lastVisuals) || lastVisuals.length === 0) {
      lastVisuals = synthesizeLastFrameVisualSlots(s, semPkg.catalogs.characters, visuals);
    }

    let vidSlots = s.video_slots;
    if (typeof vidSlots === 'string') {
      try { vidSlots = JSON.parse(vidSlots); } catch (_) { vidSlots = null; }
    }
    if (!vidSlots || typeof vidSlots !== 'object' || !vidSlots.camera || !vidSlots.audio_lip_sync) {
      vidSlots = synthesizeVideoSlots({ ...s, character_visuals: visuals, last_frame_visuals: lastVisuals }, semPkg.catalogs.characters);
    }

    return {
      ...s,
      shot_number: shotNum,
      character_visuals: visuals,
      last_frame_visuals: lastVisuals,
      video_slots: vidSlots,
    };
  });

  // 6. 阶段五：原子化持久化入库（软删除历史分镜，插入新分镜并生成完整图片与视频提示词）
  onProgress(92, '视听本体质检通过，正在持久化写入分镜数据...');
  const now = new Date().toISOString();
  let totalDuration = 0;

  const dramaRow = db.prepare('SELECT style, metadata FROM dramas WHERE id = ?').get(dramaId) || {};
  const { resolvedStreamStyleFromDrama } = require('../utils/dramaStyleMerge');
  const finalStyle = resolvedStreamStyleFromDrama('', dramaRow) || cfg?.style?.default_style || '';
  let dramaAspectRatio = null;
  try {
    if (dramaRow.metadata) {
      const meta = typeof dramaRow.metadata === 'string' ? JSON.parse(dramaRow.metadata) : dramaRow.metadata;
      if (meta?.aspect_ratio) dramaAspectRatio = meta.aspect_ratio;
    }
  } catch (_) {}
  const videoRatio = dramaAspectRatio || cfg?.style?.default_video_ratio || '16:9';

  const insertedIds = [];

  db.transaction(() => {
    db.prepare('UPDATE storyboards SET deleted_at = ? WHERE episode_id = ? AND deleted_at IS NULL').run(now, epId);

    const insertStmt = db.prepare(`
      INSERT INTO storyboards (
        episode_id, scene_id, storyboard_number, title, description, location, time, duration,
        dialogue, narration, action, result, atmosphere, movement, lighting_style, depth_of_field,
        angle_h, angle_v, angle_s, shot_type, bgm_prompt, sound_effect, layout_description,
        characters, character_visuals, last_frame_visuals, video_slots, image_prompt, video_prompt, polished_prompt,
        long_take_group_id, long_take_role, long_take_sequence,
        status, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?,
        'pending', ?, ?
      )
    `);

    for (const s of normalizedShots) {
      const scene = semPkg.getScene(s.scene_id) || semPkg.catalogs.scenes[0] || {};
      const dur = Math.max(1, Number(s.duration) || singleShotDuration);
      totalDuration += dur;

      const charJson = Array.isArray(s.characters) ? JSON.stringify(s.characters) : '[]';

      const sbWithAngles = {
        ...s,
        location: scene.location || '场景',
        time: scene.time || '日景',
        environment_depth: s.environment_depth || '',
        lighting_chiaroscuro: s.lighting_chiaroscuro || '',
        cinematic_lens: s.cinematic_lens || '',
        shot_type: s.shot_type || '中景',
        movement: s.movement || 'push',
        lighting_style: s.lighting_style || 'natural',
        depth_of_field: s.depth_of_field || 'medium',
        angle_h: s.angle_h || 'front',
        angle_v: s.angle_v || 'eye_level',
        angle_s: s.angle_s || 'medium',
        bgm_prompt: s.bgm_prompt || '',
        sound_effect: s.sound_effect || '',
      };

      const charAppearances = (Array.isArray(s.characters) ? s.characters : []).map(cid => {
        const c = semPkg.getCharacter(cid);
        return c ? (c.appearance ? `「${c.name}」${c.appearance}` : c.name) : null;
      }).filter(Boolean).join('\n');

      const visuals = s.character_visuals || [];
      const lastVisuals = s.last_frame_visuals || [];
      const vidSlots = s.video_slots || {};

      const compiledImgPrompt = compileImagePromptFromSlots(sbWithAngles, visuals, { style: finalStyle });
      const imgPrompt = compiledImgPrompt || (s.image_prompt && !isFlawedImagePrompt(s.image_prompt)
        ? sanitizeStaticImagePrompt(s.image_prompt, sbWithAngles, finalStyle)
        : composeStoryboardImagePrompt(sbWithAngles, finalStyle));
      const vidPrompt = compileVideoPromptFromSlots(
        charAppearances ? { ...sbWithAngles, character_appearances: charAppearances } : sbWithAngles,
        vidSlots,
        { style: finalStyle, videoRatio }
      );
      const polishedPrompt = imgPrompt;
      const charVisualsJson = JSON.stringify(visuals);
      const lastVisualsJson = JSON.stringify(lastVisuals);
      const videoSlotsJson = JSON.stringify(vidSlots);

      const info = insertStmt.run(
        epId,
        s.scene_id || scene.id || null,
        s.shot_number,
        s.title || `镜头${s.shot_number}`,
        s.action || '',
        scene.location || '场景',
        scene.time || '日景',
        dur,
        s.dialogue || '',
        s.narration || '',
        s.action || '',
        s.result || '',
        s.atmosphere || s.emotion || '',
        s.movement,
        s.lighting_style,
        s.depth_of_field,
        s.angle_h || 'front',
        s.angle_v || 'eye_level',
        s.angle_s || 'medium',
        s.shot_type || '中景',
        s.bgm_prompt || '',
        s.sound_effect || '',
        s.layout_description || '',
        charJson,
        charVisualsJson,
        lastVisualsJson,
        videoSlotsJson,
        imgPrompt,
        vidPrompt,
        polishedPrompt,
        s.long_take_group_id || null,
        s.long_take_role || null,
        s.long_take_sequence != null ? Number(s.long_take_sequence) : null,
        now,
        now
      );
      const insertedId = info.lastInsertRowid;
      insertedIds.push(insertedId);
      for (const pid of s.props || []) {
        const numPid = Number(pid);
        if (numPid > 0) {
          db.prepare('INSERT INTO storyboard_props (storyboard_id, prop_id) VALUES (?, ?)').run(insertedId, numPid);
        }
      }
    }
  })();

  // 强化：为入库的分镜全量复核并重建角色造型与视频提示词
  for (const sid of insertedIds) {
    try {
      rebuildPromptsForStoryboard(db, log, sid);
    } catch (_) {}
  }

  // 阶段六：世界观资产自动对齐与清理（自动软删除在全剧剧本与分镜中均未使用的陈旧残留道具）
  reconcileObsoleteDramaAssets(db, log, dramaId);

  // 更新剧集总时长
  const durationMinutes = Math.ceil(totalDuration / 60);
  db.prepare('UPDATE episodes SET duration = ?, updated_at = ? WHERE id = ?').run(durationMinutes, now, epId);

  log.info('[导演Agent] 分镜入库成功', {
    episode_id: epId,
    shot_count: finalShots.length,
    total_duration: totalDuration,
    semantic_revision: semPkg.semantic_revision,
  });

  onProgress(100, `导演智能体分镜推演完成，共生成 ${finalShots.length} 个分镜。`);

  return {
    storyboards: finalShots,
    total_shots: finalShots.length,
    audit,
    semantic_revision: semPkg.semantic_revision,
    total_duration: totalDuration,
  };
}

/**
 * 运行全生命周期全剧导演智能体（Full-Lifecycle Autonomous Director Agent）
 * 覆盖：【故事梗概 ➔ 多集大纲与剧本 ➔ 角色/道具尺寸/场景地标抽取 ➔ 逐集动态分镜与BGM ➔ SHACL门禁自检自纠】
 * @param {object} db - SQLite 数据库
 * @param {object} log - 日志记录器
 * @param {object} cfg - 全局配置
 * @param {number|string} dramaId - 短剧 ID
 * @param {object} [options] - 选项 (premise, episodeCount, style, genre, storyboardCount)
 * @param {Function} [progressCallback] - 进度回调 (progress, message)
 */
async function runFullDramaDirectorAgent(db, log, cfg, dramaId, options = {}, progressCallback = null) {
  const did = Number(dramaId);
  const drama = dramaService.getDramaById(db, did);
  if (!drama) throw new Error('短剧项目不存在');

  const premise = (options.premise || drama.description || drama.summary || '').trim();
  if (!premise) throw new Error('请提供故事梗概以启动全流程导演智能体推演');

  const episodeCount = Math.max(1, Math.min(20, Math.floor(Number(options.episode_count || options.episodeCount) || 3)));
  const style = options.style || drama.style || 'modern';
  const genre = options.genre || drama.genre || 'drama';

  if (progressCallback) progressCallback(10, `导演智能体正在根据梗概规划全剧 ${episodeCount} 集大纲与剧本...`);

  // 1. 故事与剧本创编：生成多集剧本
  log.info('[全流程导演Agent] 阶段一：推演多集大纲与剧本正文...', { drama_id: did, episodeCount, premise: premise.slice(0, 100) });
  const storyResult = await generateStory(db, log, {
    premise,
    style,
    genre,
    episode_count: episodeCount,
    drama_id: did,
  });

  const rawEpisodes = storyResult?.episodes || [];
  if (rawEpisodes.length === 0) {
    throw new Error('导演智能体规划故事失败：未生成有效分集剧本');
  }

  // 保存分集剧本入库
  dramaService.saveEpisodes(db, log, did, {
    episodes: rawEpisodes.map((ep, idx) => ({
      episode_number: ep.episode ?? (idx + 1),
      title: ep.title || `第${ep.episode ?? (idx + 1)}集`,
      script_content: ep.content || '',
    })),
  });

  const dbEpisodes = db.prepare('SELECT id, episode_number, title, script_content FROM episodes WHERE drama_id = ? AND deleted_at IS NULL ORDER BY episode_number ASC').all(did);
  if (dbEpisodes.length === 0) throw new Error('分集剧本入库失败');

  if (progressCallback) progressCallback(30, '导演智能体正在构建世界观，统一抽取角色、道具物理尺度与场景地标...');

  // 2. 世界观资产抽取：以第 1 集为锚点统一抽取全剧核心角色、道具尺度与场景地标
  log.info('[全流程导演Agent] 阶段二：抽取世界观本体资产...', { drama_id: did });
  const extractedEntities = await extractAllEntitiesFromScript(db, log, cfg, dbEpisodes[0].id);

  // 3. 逐集导演视听编排与门禁自纠
  const episodeResults = [];
  const totalEps = dbEpisodes.length;

  for (let i = 0; i < totalEps; i++) {
    const ep = dbEpisodes[i];
    const currentProgress = 35 + Math.round(((i + 1) / totalEps) * 55);
    if (progressCallback) {
      progressCallback(currentProgress, `导演智能体正在推演第 ${ep.episode_number} 集《${ep.title}》场面调度、动感运镜与BGM...`);
    }

    log.info('[全流程导演Agent] 阶段三：编排第 ' + ep.episode_number + ' 集视听分镜', { episode_id: ep.id });
    const epRes = await runDirectorAgent(db, log, cfg, ep.id, {
      storyboardCount: options.storyboardCount,
      forceExtractEntities: false, // 实体已在阶段二统一抽取
      userDirectives: options.userDirectives || options.directives || options.feedback,
    });
    episodeResults.push({
      episode_id: ep.id,
      episode_number: ep.episode_number,
      title: ep.title,
      shot_count: epRes.storyboards.length,
      audit: epRes.audit,
      semantic_revision: epRes.semantic_revision,
    });
  }

  if (progressCallback) progressCallback(95, '全生命周期推演完毕，正在原子化归档与持久化...');

  const totalShots = episodeResults.reduce((sum, r) => sum + r.shot_count, 0);
  log.info('[全流程导演Agent] 全生命周期闭环推演完成', {
    drama_id: did,
    episodes_count: episodeResults.length,
    total_shots: totalShots,
  });

  return {
    drama_id: did,
    episodes: episodeResults,
    worldview_assets: {
      characters_count: extractedEntities.characters.length,
      scenes_count: extractedEntities.scenes.length,
      props_count: extractedEntities.props.length,
    },
    total_shots: totalShots,
    summary: `导演智能体全流程闭环推演完成：已创作 ${episodeCount} 集剧本，构建包含 ${extractedEntities.characters.length} 个角色、${extractedEntities.scenes.length} 个场景、${extractedEntities.props.length} 个道具的世界观，并完成全集 ${totalShots} 个高动感分镜调度与音频闭环契约。`,
  };
}

/**
 * 针对单个分镜的原子级导演定向微调（Micro Shot-Level Director Refinement）
 * 用户指令直指该镜头的特定元素（如：特写拔剑、侧逆光、运镜改为微推、加紧张BGM等）
 * 智能体结合本体语义包（角色锚点、道具真实物理尺度、场景地标）与前后连戏快照精准重构该镜头
 * @param {object} db - SQLite 数据库
 * @param {object} log - 日志记录器
 * @param {object} cfg - 配置
 * @param {number|string} storyboardId - 分镜 ID
 * @param {string} userInstruction - 用户针对该元素的定向调整意见
 * @returns {Promise<object>} 更新后的分镜与质检结果
 */
async function refineSingleStoryboard(db, log, cfg, storyboardId, userInstruction = '') {
  const sbId = Number(storyboardId);
  const sb = db.prepare('SELECT * FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(sbId);
  if (!sb) throw new Error('分镜不存在');

  const instruction = (userInstruction || '').trim();
  if (!instruction) throw new Error('请提供针对该分镜的具体导演调整指令');

  // 1. 编译当前剧集的不可变本体语义包
  const semPkg = compileDramaSemanticPackage(db, sb.episode_id);

  // 2. 读取前后镜头上下文与连戏快照
  let prevContinuity = null;
  const prevShot = db.prepare(
    'SELECT id, storyboard_number, action, location, time, movement, continuity_snapshot FROM storyboards WHERE episode_id = ? AND storyboard_number < ? AND deleted_at IS NULL ORDER BY storyboard_number DESC LIMIT 1'
  ).get(sb.episode_id, sb.storyboard_number);
  if (prevShot && prevShot.continuity_snapshot) {
    try { prevContinuity = JSON.parse(prevShot.continuity_snapshot); } catch (_) {}
  }

  const nextShot = db.prepare(
    'SELECT id, storyboard_number, action, location, time FROM storyboards WHERE episode_id = ? AND storyboard_number > ? AND deleted_at IS NULL ORDER BY storyboard_number ASC LIMIT 1'
  ).get(sb.episode_id, sb.storyboard_number);

  // 3. 构造精准定向的 Prompt
  const systemPrompt = `你是一位严谨的院线级导演与摄影指导（Director Agent）。
你正在对第 ${sb.storyboard_number} 镜进行【原子级定向微调（Targeted Shot Refine）】。
用户给出了直指特定元素的微调指令，你必须精准响应用户的要求，调整指定的视听要素（如运镜、机位、情绪、道具持有、光影、BGM或对白）。
同时，你必须遵从【不可变本体世界观契约】，严禁破坏角色外貌锚点、道具物理真实尺寸与场景地标，并保持与上一镜的连戏一致性。

${semPkg.getSystemDigest()}

【导演视听铁律】：
1. 严格少用固定镜头 (static)，非必要不使用 static；
2. 若无对白，必须在 bgm_prompt 中给出具体的配乐风格与情绪描写；
3. 出场人物控制在 2 人以内；
4. layout_description 必须标明人物站位与道具真实尺度。`;

  const userPrompt = `【当前第 ${sb.storyboard_number} 镜原始参数】：
- 标题: ${sb.title || ''}
- 场景ID: ${sb.scene_id || ''} (${sb.location || ''} ${sb.time || ''})
- 景别: ${sb.shot_type || '中景'}
- 运镜: ${sb.movement || 'push'}
- 视角: 水平 ${sb.angle_h || 'front'} / 俯仰 ${sb.angle_v || 'eye_level'} / 尺度 ${sb.angle_s || 'medium'}
- 动作描述: ${sb.action || ''}
- 动作结果: ${sb.result || ''}
- 对白: ${sb.dialogue || ''}
- 画面站位: ${sb.layout_description || ''}
- 情绪: ${sb.emotion || ''}
- 背景音乐: ${sb.bgm_prompt || ''}
- 生图提示词: ${sb.polished_prompt || sb.image_prompt || ''}

【上一镜头连戏快照上下文】：
${prevContinuity ? JSON.stringify(prevContinuity) : (prevShot ? `上一镜动作: ${prevShot.action}` : '本镜为首镜')}
${nextShot ? `下一镜动作: ${nextShot.action}` : '本镜为尾镜'}

【用户导演直指定向微调指令（最高优先级执行，精准响应微调元素）】：
${instruction}

【任务要求】：
请以纯 JSON 格式输出微调后的单个分镜对象：
{
  "title": "3-5字标题",
  "scene_id": ${sb.scene_id || 1},
  "characters": ${sb.characters || '[]'},
  "shot_type": "特写/近景/中景/全景/远景",
  "angle_h": "front/front_left/front_right/left/right/back",
  "angle_v": "eye_level/low/high/worm",
  "angle_s": "close_up/medium/wide",
  "movement": "push/pull/pan/tilt/tracking/handheld/orbit (尽量不用 static)",
  "lighting_style": "natural/side/backlit/dramatic/soft/golden_hour/blue_hour/night/neon",
  "depth_of_field": "shallow/medium/deep",
  "duration": ${sb.duration || 5},
  "action": "微调后的物理动作",
  "result": "动作结果收束",
  "dialogue": "对白或空串",
  "bgm_prompt": "无对白时必填高质量配乐描述",
  "sound_effect": "音效",
  "layout_description": "画面站位与物体尺度合同",
  "emotion": "核心情绪",
  "polished_prompt": "针对生图模型的专业单帧高质量提示词（融入角色外貌、道具尺度、场景光影与微调细节）"
}`;

  log.info('[导演Agent] 单分镜定向原子微调推理中...', { storyboard_id: sbId, instruction });
  const rawResponse = await aiClient.generateText(db, log, 'text', userPrompt, systemPrompt, { max_tokens: 3000, reasoning_effort: 'high' });
  const parsed = safeParseAIJSON(rawResponse, null, log);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('导演智能体未能解析微调结果');
  }

  // 门禁规则自纠
  let mov = angleService.normalizeMovement(parsed.movement);
  if (mov === 'static' && (!instruction.includes('固定') && !instruction.includes('static') && !instruction.includes('静止'))) {
    mov = 'push';
  }
  let bgm = (parsed.bgm_prompt || '').trim();
  if (!parsed.dialogue && !bgm) {
    bgm = '富有张力的影视原声配乐，与当前情绪紧密咬合';
  }

  // 生成新的连戏快照
  const newContinuitySnapshot = JSON.stringify({
    characters: (Array.isArray(parsed.characters) ? parsed.characters : []).reduce((acc, charId) => {
      const char = semPkg.getCharacter(charId);
      if (char) {
        acc[char.name] = {
          screen_position: parsed.layout_description || 'in frame',
          clothing: char.appearance || null,
          expression: parsed.emotion || null,
        };
      }
      return acc;
    }, {}),
    lighting: parsed.lighting_style || 'natural',
    location: sb.location || 'scene',
    overall_composition: parsed.layout_description || `${parsed.shot_type || '中景'} ${mov}`,
  });

  let finalStyle = '';
  try {
    const dramaRow = db.prepare('SELECT d.style, d.metadata FROM dramas d JOIN episodes e ON e.drama_id = d.id WHERE e.id = ?').get(sb.episode_id) || {};
    const { resolvedStreamStyleFromDrama } = require('../utils/dramaStyleMerge');
    finalStyle = resolvedStreamStyleFromDrama('', dramaRow) || dramaRow.style || '';
  } catch (_) {
    try {
      const dramaRow = db.prepare('SELECT d.style FROM dramas d JOIN episodes e ON e.drama_id = d.id WHERE e.id = ?').get(sb.episode_id) || {};
      finalStyle = dramaRow.style || '';
    } catch (__) {}
  }

  const candidateImg = parsed.image_prompt || parsed.polished_prompt || (parsed.action ? composeStoryboardImagePrompt({ ...sb, ...parsed }, finalStyle) : sb.image_prompt);
  const newImgPrompt = candidateImg && !isFlawedImagePrompt(candidateImg)
    ? sanitizeStaticImagePrompt(candidateImg, { ...sb, ...parsed }, finalStyle)
    : composeStoryboardImagePrompt({ ...sb, ...parsed }, finalStyle);
  const newPolishedPrompt = parsed.polished_prompt && !isFlawedImagePrompt(parsed.polished_prompt)
    ? sanitizeStaticImagePrompt(parsed.polished_prompt, { ...sb, ...parsed }, finalStyle)
    : newImgPrompt;

  const now = new Date().toISOString();
  try {
    db.prepare(`
      UPDATE storyboards SET
        title = ?,
        shot_type = ?,
        angle_h = ?,
        angle_v = ?,
        angle_s = ?,
        movement = ?,
        lighting_style = ?,
        depth_of_field = ?,
        duration = ?,
        action = ?,
        result = ?,
        dialogue = ?,
        bgm_prompt = ?,
        sound_effect = ?,
        layout_description = ?,
        emotion = ?,
        image_prompt = ?,
        polished_prompt = ?,
        continuity_snapshot = ?,
        updated_at = ?
      WHERE id = ? AND deleted_at IS NULL
    `).run(
      parsed.title || sb.title,
      parsed.shot_type || sb.shot_type,
      parsed.angle_h || sb.angle_h,
      parsed.angle_v || sb.angle_v,
      parsed.angle_s || sb.angle_s,
      mov,
      angleService.normalizeLighting(parsed.lighting_style) || sb.lighting_style,
      angleService.normalizeDof(parsed.depth_of_field) || sb.depth_of_field,
      Math.max(1, Number(parsed.duration) || sb.duration || 5),
      parsed.action || sb.action,
      parsed.result || sb.result,
      parsed.dialogue ?? sb.dialogue,
      bgm,
      parsed.sound_effect ?? sb.sound_effect,
      parsed.layout_description || sb.layout_description,
      parsed.emotion || sb.emotion,
      newImgPrompt,
      newPolishedPrompt,
      newContinuitySnapshot,
      now,
      sbId
    );
  } catch (upErr) {
    if ((upErr.message || '').includes('image_prompt')) {
      db.prepare(`
        UPDATE storyboards SET
          title = ?,
          shot_type = ?,
          angle_h = ?,
          angle_v = ?,
          angle_s = ?,
          movement = ?,
          lighting_style = ?,
          depth_of_field = ?,
          duration = ?,
          action = ?,
          result = ?,
          dialogue = ?,
          bgm_prompt = ?,
          sound_effect = ?,
          layout_description = ?,
          emotion = ?,
          polished_prompt = ?,
          continuity_snapshot = ?,
          updated_at = ?
        WHERE id = ? AND deleted_at IS NULL
      `).run(
        parsed.title || sb.title,
        parsed.shot_type || sb.shot_type,
        parsed.angle_h || sb.angle_h,
        parsed.angle_v || sb.angle_v,
        parsed.angle_s || sb.angle_s,
        mov,
        angleService.normalizeLighting(parsed.lighting_style) || sb.lighting_style,
        angleService.normalizeDof(parsed.depth_of_field) || sb.depth_of_field,
        Math.max(1, Number(parsed.duration) || sb.duration || 5),
        parsed.action || sb.action,
        parsed.result || sb.result,
        parsed.dialogue ?? sb.dialogue,
        bgm,
        parsed.sound_effect ?? sb.sound_effect,
        parsed.layout_description || sb.layout_description,
        parsed.emotion || sb.emotion,
        newPolishedPrompt,
        newContinuitySnapshot,
        now,
        sbId
      );
    } else {
      throw upErr;
    }
  }

  try {
    rebuildPromptsForStoryboard(db, log, sbId);
  } catch (_) {}

  const updatedSb = db.prepare('SELECT * FROM storyboards WHERE id = ?').get(sbId);
  log.info('[导演Agent] 单分镜定向原子微调已完成入库', { storyboard_id: sbId });

  return {
    storyboard: updatedSb,
    continuity_snapshot: newContinuitySnapshot,
    instruction,
  };
}

/**
 * 自动对齐与清理剧目中的陈旧/孤儿道具资产
 * 当道具在当前全剧所有有效集剧本中均未提及，且未被任何现有分镜引用时，执行软删除归档
 */
function reconcileObsoleteDramaAssets(db, log, dramaId) {
  const dId = Number(dramaId);
  const episodes = db.prepare('SELECT script_content FROM episodes WHERE drama_id = ? AND deleted_at IS NULL').all(dId);
  const fullDramaScript = episodes.map(e => e.script_content || '').join('\n');
  if (!fullDramaScript.trim()) return { pruned_props: 0, pruned_scenes: 0 };

  const dramaShots = db.prepare(`
    SELECT s.id, s.scene_id, sp.prop_id
    FROM storyboards s
    JOIN episodes e ON e.id = s.episode_id
    LEFT JOIN storyboard_props sp ON sp.storyboard_id = s.id
    WHERE e.drama_id = ? AND s.deleted_at IS NULL
  `).all(dId);

  let props = [];
  try {
    props = db.prepare('SELECT id, name, created_at FROM props WHERE drama_id = ? AND deleted_at IS NULL').all(dId);
  } catch (_) {
    try { props = db.prepare('SELECT id, name FROM props WHERE drama_id = ? AND deleted_at IS NULL').all(dId); } catch (__) {}
  }
  let prunedProps = 0;
  const now = new Date().toISOString();

  for (const p of props) {
    if (isAssetObsolete('prop', p, { script: fullDramaScript, shots: dramaShots })) {
      db.prepare('UPDATE props SET deleted_at = ? WHERE id = ?').run(now, p.id);
      prunedProps++;
    }
  }

  // 清理过时场地
  let scenes = [];
  try {
    scenes = db.prepare('SELECT id, location, created_at FROM scenes WHERE drama_id = ? AND deleted_at IS NULL').all(dId);
  } catch (_) {
    try { scenes = db.prepare('SELECT id, location FROM scenes WHERE drama_id = ? AND deleted_at IS NULL').all(dId); } catch (__) {}
  }
  let prunedScenes = 0;
  for (const s of scenes) {
    if (isAssetObsolete('scene', s, { script: fullDramaScript, shots: dramaShots })) {
      db.prepare('UPDATE scenes SET deleted_at = ? WHERE id = ?').run(now, s.id);
      prunedScenes++;
    }
  }

  log.info('[导演Agent] 世界观资产自动对齐完成', { drama_id: dId, pruned_props: prunedProps, pruned_scenes: prunedScenes });
  return { pruned_props: prunedProps, pruned_scenes: prunedScenes };
}

module.exports = {
  runDirectorAgent,
  runFullDramaDirectorAgent,
  refineSingleStoryboard,
  reconcileObsoleteDramaAssets,
};
