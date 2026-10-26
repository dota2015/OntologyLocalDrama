const { normalizeDurationRange, planShotDuration, rangeTimingInstructions } = require('../utils/shotDurationRange');
// 与 Go StoryboardService.GenerateStoryboard + processStoryboardGeneration 对齐
const taskService = require('./taskService');
const aiClient = require('./aiClient');
const promptI18n = require('./promptI18n');
const { syncStoryboardCharacters } = require('./imageService');
const safeJson = require('../utils/safeJson');
const { safeParseAIJSON, extractJsonCandidate, repairTruncatedJsonArray, extractFirstArray } = safeJson;
const loadConfig = require('../config').loadConfig;
const angleService = require('./angleService');
const { timingInstructions } = require('../utils/speechTiming');
const { enforceStoryboardSpeechTiming } = require('./storyboardSpeechService');

/**
 * 分镜专用 generateText 包装：
 * 1. 默认携带 max_tokens:16384，让模型输出更长，减少截断续写次数。
 * 2. 若 API 因 max_tokens 超上限报参数错误，由 aiClient 统一降级重试
 *    （有上限值则按上限重试，否则去掉 max_tokens），此处的包装不再需要自己处理。
 * 3. 所有尝试均记录日志。
 */
const DEFAULT_STORYBOARD_MAX_TOKENS = 16384;

/** 统一镜号（AI 可能返回字符串 "1"，须与 Set 去重键一致） */
function normalizeStoryboardShotNumber(rawOrSb) {
  const raw =
    rawOrSb != null && typeof rawOrSb === 'object'
      ? rawOrSb.shot_number ?? rawOrSb.storyboard_number
      : rawOrSb;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** 同集相同 storyboard_number 多行时保留 id 最大的一条（通常为最新入库） */
function dedupeStoryboardRowsByNumber(rows) {
  const byNum = new Map();
  const extras = [];
  for (const r of rows || []) {
    const num = normalizeStoryboardShotNumber(r.storyboard_number ?? r);
    if (num > 0) {
      const prev = byNum.get(num);
      if (!prev || Number(r.id) > Number(prev.id)) byNum.set(num, r);
    } else {
      extras.push(r);
    }
  }
  return [...byNum.values(), ...extras].sort(
    (a, b) =>
      normalizeStoryboardShotNumber(a.storyboard_number) - normalizeStoryboardShotNumber(b.storyboard_number) ||
      Number(a.id) - Number(b.id)
  );
}

async function generateTextForStoryboard(db, log, userPrompt, systemPrompt, options = {}) {
  const { model, streamCallback, temperature = 0.7 } = options;

  // max_tokens 超厂商上限时的降级重试由 aiClient.generateText 内部统一处理
  log.info('Storyboard generateText', { model: model || '(default)', max_tokens: DEFAULT_STORYBOARD_MAX_TOKENS });
  return aiClient.generateText(db, log, 'text', userPrompt, systemPrompt, {
    scene_key: 'storyboard_extraction',
    model: model || undefined,
    temperature,
    max_tokens: DEFAULT_STORYBOARD_MAX_TOKENS,
    streamCallback,
  });
}

function rowToScene(r) {
  if (!r) return null;
  return {
    id: r.id,
    drama_id: r.drama_id,
    location: r.location,
    time: r.time,
    prompt: r.prompt,
    storyboard_count: r.storyboard_count ?? 1,
    image_url: r.image_url,
    local_path: r.local_path,
    status: r.status || 'pending',
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/** 规范为数字秒：前端左侧用 {{ shot.duration }}s，右侧用 Math.round(duration)；避免 "5s" 导致 5ss，或非数字导致 NaN */
function normalizeDuration(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  const s = String(v).trim().replace(/s$/i, '');
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

const _SB_PROMPT_LOG_CHUNK = 14000;

/**
 * 调试：完整打印分镜 system / user 提示词（可能很长，按块写入日志）。
 * 启动后端前设置环境变量：DEBUG_STORYBOARD_PROMPTS=1
 */
function logDebugStoryboardPrompts(log, tag, userPrompt, systemPrompt) {
  const on = String(process.env.DEBUG_STORYBOARD_PROMPTS || '').trim();
  if (on !== '1' && on.toLowerCase() !== 'true') return;
  const sp = systemPrompt != null ? String(systemPrompt) : '';
  const up = userPrompt != null ? String(userPrompt) : '';
  log.info(`[StoryboardPrompt:${tag}] system_prompt_bytes=${sp.length} user_prompt_bytes=${up.length}`);
  for (let i = 0; i < sp.length; i += _SB_PROMPT_LOG_CHUNK) {
    log.info(`[StoryboardPrompt:${tag}] system_part_${Math.floor(i / _SB_PROMPT_LOG_CHUNK) + 1}\n${sp.slice(i, i + _SB_PROMPT_LOG_CHUNK)}`);
  }
  for (let i = 0; i < up.length; i += _SB_PROMPT_LOG_CHUNK) {
    log.info(`[StoryboardPrompt:${tag}] user_part_${Math.floor(i / _SB_PROMPT_LOG_CHUNK) + 1}\n${up.slice(i, i + _SB_PROMPT_LOG_CHUNK)}`);
  }
}

/** 将 lighting_style 枚举转为中文布光提示（兜底用） */
function lightingStyleHintZh(code) {
  const m = {
    natural: '自然窗光或环境散射光',
    front: '正面柔光面部受光均匀',
    side: '侧光约45°勾勒轮廓',
    backlit: '逆光轮廓光发丝边缘发亮',
    top: '顶光压暗眼窝',
    under: '底光或脚光非常规氛围',
    soft: '软光低反差过渡柔和',
    dramatic: '戏剧高反差主辅分明',
    golden_hour: '金色时刻暖斜阳',
    blue_hour: '蓝调时刻冷环境光',
    night: '夜景人工点光源',
    neon: '霓虹混合色温',
  };
  return m[String(code || '').trim()] || '主光方向明确侧光或窗光';
}

/** 按时长与已有运镜字段拼灵境式「运镜链」（强调摄影机动态流动，严格少用定镜） */
function buildCameraMotionChain(movement, shotType, durationSec) {
  const dur = Math.max(1, Number(durationSec) || 5);
  const mv = String(movement || '').trim();
  const st = String(shotType || '').trim();
  const parts = [];
  if (dur >= 12) {
    if (/跟|追随|尾随|track/.test(mv)) parts.push('侧后方平稳跟拍主体位移');
    else if (/摇|pan/.test(mv)) parts.push('轻摇镜头拓展环境纵深画幅');
    else if (/手持|handheld/.test(mv)) parts.push('手持呼吸感微晃记录现场动态');
    else if (/拉|pull/.test(mv)) parts.push('由主体向外缓拉后退展开全景');
    else parts.push('缓推轨贴近动作与神态核心');
    parts.push('横移从前景遮挡或门框一侧滑出拓宽视野带出纵深与环境细节');
  } else if (dur >= 8) {
    if (/跟|track/.test(mv)) parts.push('跟拍主体动线');
    else if (/手持|handheld/.test(mv)) parts.push('微手持呼吸感运镜');
    else if (/拉|pull/.test(mv)) parts.push('缓拉镜头拓宽画幅');
    else if (/摇|pan/.test(mv)) parts.push('水平横移扫过空间');
    else parts.push('缓推轨由远及近');
    parts.push('微横移让背景纵深与环境细节可读');
  } else if (dur >= 5) {
    if (/跟|track/.test(mv)) parts.push('短跟拍强化主体动线');
    else if (/手持|handheld/.test(mv)) parts.push('手持临场呼吸感');
    else if (/拉|pull/.test(mv)) parts.push('缓拉带出空间关系');
    else if (/摇|pan/.test(mv)) parts.push('轻摇展现动作延伸');
    else parts.push('缓推轨贴近动作');
  } else {
    if (/跟|track/.test(mv)) parts.push('短跟拍');
    else if (/手持|handheld/.test(mv)) parts.push('微手持动感');
    else if (/拉|pull/.test(mv)) parts.push('微拉');
    else if (/摇|pan/.test(mv)) parts.push('微摇');
    else parts.push('微推');
  }
  if ((st.includes('远') || st.includes('全景')) && !parts.some((p) => /推|移|跟|摇|拉/.test(p))) {
    parts.push('缓推轨或轻摇向事件中心');
  }
  const chain = [...new Set(parts)].filter(Boolean).join('，');
  return chain || '缓推轨贴近动作核心';
}

/** 全能分镜：模型未返回 universal_segment_text 时的灵境式高密度单行（视频时间轴 + 运镜链） */
function buildFallbackUniversalSeedanceLine(sb, d, styleHint) {
  const act = (d.action || '').replace(/\s+/g, ' ').trim().slice(0, 220);
  const res = (d.result || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const emo = (d.emotion || sb.emotion || '').replace(/\s+/g, ' ').trim().slice(0, 24);
  const atm = (sb.atmosphere || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  const shotBits = [d.shotType, d.angle].filter(Boolean).join('，').trim();
  const loc = [sb.location, sb.time].filter(Boolean).join('，').trim() || '叙事空间';
  const dur = Math.max(1, Number(d.durationSec) || normalizeDuration(sb.duration) || 5);
  const lightZh = lightingStyleHintZh(d.lightingStyle);
  const dof = d.depthOfField === 'extreme_shallow' ? '浅景深前景虚化明显' : d.depthOfField === 'shallow' ? '浅景深背景柔化' : d.depthOfField === 'deep' ? '深焦前后景均清晰' : d.depthOfField === 'medium' ? '景深适中' : '景深随景别可感';
  const shotNum = Math.max(1, Number(d.shotNumber) || 1);
  const link = shotNum <= 1 ? '开篇情绪奠基' : '延续上一镜动势与视线';
  const motionCore =
    act ||
    '在镜内时长里完成一段可感知的动作阶段变化，含走位或身体重心的转移，避免单姿势摆拍';
  const emoParen = emo ? `（${emo}）` : '（专注投入）';
  const fg = atm ? `${atm.slice(0, 42)}与主体相关的虚化层次` : '与动作相关的近景细节或桌面器物';
  const mg = act ? '主体动作与表情核心区' : '主体占据画面叙事中心';
  const bg = loc ? `${loc}的环境延展与氛围层次` : '环境纵深与空间气氛';
  const lightBlock = `[${lightZh}；结合${loc}，建议色温具象化如4500K-5600K区间择一；明暗比约2:1至3:1；${dof}]`;
  const camChain = buildCameraMotionChain(d.movement, d.shotType, dur);
  const narrDyn = `约${dur}秒内——在${loc}，@人物1${act ? `先后：${act}` : '持续推进戏内动作'}，${res ? `阶段收束为：${res}` : '动作与视线随时间有阶段推进'}；镜头以「${camChain}」配合人物动线，读出空间纵深与时间流逝`;
  const lensBlock = `运镜链：${camChain}；景别机位：${shotBits || '中景，平视'}，三分法或对角线择一（结尾动势：[${res || '视线或身体动线指向下一个节拍，动势渐收可衔接下镜'}]）`;
  const sfx = `环境层-[与${loc}一致的环境声底与远处细节] 动作层-[与动作同步的物理接触声] 情绪层-[无旋律仅以空间混响与材质细微声烘托情绪张力]`;
  const styleTail = (styleHint && String(styleHint).trim()) || '电影感叙事光色';
  const dia = (d.dialogue || '').trim().replace(/"/g, "'");
  let line = `主体：@人物1${emoParen}[朝向：依轴线面向戏中对象或画左/画右择一并保持统一] 正在 ${motionCore}（与上镜衔接：${link}） 叙事动态：${narrDyn} 空间：前景-[${fg}] 中景-[${mg}] 背景-[${bg}] 光影：${lightBlock} 镜头：${lensBlock}`;
  if (dia) line += ` 台词：第1秒 @人物1："${dia}"`;
  if (sb.narration) line += ` 旁白：“${String(sb.narration)}”`;
  line += ` 音效：${sfx} ${styleTail} [禁BGM][禁字幕]`;
  return line.replace(/\r?\n/g, ' ');
}

function getStoryboardsForEpisode(db, episodeId) {
  const rows = dedupeStoryboardRowsByNumber(
    db.prepare(
      'SELECT * FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL ORDER BY storyboard_number ASC, id ASC'
    ).all(episodeId)
  );
  return rows.map((r) => {
    let background = null;
    if (r.scene_id != null) {
      const sceneRow = db.prepare('SELECT * FROM scenes WHERE id = ? AND deleted_at IS NULL').get(r.scene_id);
      if (sceneRow) background = rowToScene(sceneRow);
    }
    return {
      id: r.id,
      episode_id: r.episode_id,
      scene_id: r.scene_id,
      storyboard_number: r.storyboard_number,
      title: r.title,
      description: r.description,
      location: r.location,
      time: r.time,
      duration: normalizeDuration(r.duration),
      dialogue: r.dialogue,
      narration: r.narration ?? null,
      action: r.action,
      result: r.result,
      atmosphere: r.atmosphere,
      image_prompt: r.image_prompt,
      video_prompt: r.video_prompt,
      video_model: r.video_model ?? null,
      shot_type: r.shot_type,
      angle: r.angle,
      angle_h: r.angle_h ?? null,
      angle_v: r.angle_v ?? null,
      angle_s: r.angle_s ?? null,
      movement: r.movement,
      lighting_style: r.lighting_style ?? null,
      depth_of_field: r.depth_of_field ?? null,
      bgm_prompt: r.bgm_prompt ?? null,
      sound_effect: r.sound_effect ?? null,
      segment_index: r.segment_index ?? 0,
      segment_title: r.segment_title ?? null,
      creation_mode: r.creation_mode === 'universal' ? 'universal' : 'classic',
      universal_segment_text: r.universal_segment_text ?? null,
      layout_description: r.layout_description ?? null,
      characters: (() => {
        if (!r.characters) return [];
        if (typeof r.characters !== 'string') return Array.isArray(r.characters) ? r.characters : [];
        try { return JSON.parse(r.characters); } catch (_) { return []; }
      })(),
      composed_image: r.composed_image,
      video_url: r.video_url,
      selected_video_id: r.selected_video_id != null ? Number(r.selected_video_id) : null,
      audio_local_path: r.audio_local_path ?? null,
      narration_audio_local_path: r.narration_audio_local_path ?? null,
      long_take_group_id: r.long_take_group_id ?? null,
      long_take_role: r.long_take_role ?? null,
      long_take_sequence: r.long_take_sequence != null ? Number(r.long_take_sequence) : null,
      status: r.status || 'pending',
      created_at: r.created_at,
      updated_at: r.updated_at,
      background,
    };
  });
}

function extractStaticFreezeFramePose(action, sb = {}) {
  if (!action || typeof action !== 'string') return '';
  const { stripChineseExclusions } = require('../utils/framePromptSanitize');
  let text = stripChineseExclusions(action).trim();

  // 1. 过滤单纯的运镜描述（如：镜头从会议室上方缓缓下降。镜头缓推，）
  text = text.replace(/镜头(?:从|沿|顺着|向|由|小幅|缓推|推进|拉开|横摇|横移|跟随|轻轻|微微|持续).*?[，。；]/g, '');
  text = text.replace(/，?镜头(?:缓推|推近|靠近|推进|拉远|横摇|跟随|停在).*$/g, '');

  // 2. 特殊多角色/多步骤剧本描述优先转译（在通用替换前生效）
  text = text.replace(/露娜伏在低矮掩体后[，,]抬头观察高台与仓库二层窗口[，,]右手按住通讯器位置/g, '露娜身体紧贴低矮掩体俯伏，微仰起头目光警惕锁定高台二层窗口，右手紧按在战术通讯耳机上');
  text = text.replace(/红狼没有停步[，,]从掩体后冲出[，,]沿装卸道路(?:快速)?奔向([^，。；]+)/g, '红狼位于装卸道路中央，屈膝大步奔冲，背向镜头动作迅猛，正对着前方$1');
  text = text.replace(/红狼缩在金属桌后[，,]低头按住护甲弹痕并抬起通讯器位置/g, '红狼屈膝蜷缩在金属桌内侧，一手按在胸前受创的护甲弹痕上，一手按住战术通讯耳机，低头咬牙隐蔽');
  text = text.replace(/二层窗口连续闪出枪口火光[，,]红狼急停后横向翻滚到一张倾倒金属桌后/g, '二层窗口枪火迸发，红狼侧身蜷缩扑倒在倾倒的厚重金属桌后方，单臂护头，身体紧贴地面掩体躲避弹雨');
  text = text.replace(/急停后横向翻滚到([^，。；]+?)(?:后|旁)/g, '侧身扑倒蜷缩在$1后方，单手撑地掩蔽');
  text = text.replace(/先指向二层窗口[，,]再沿厂房侧面比出撤离方向/g, '单臂平举直指厂房侧面撤离方向，身体压低重心，侧脸神情严肃果断');
  text = text.replace(/听完后停止翻找装备/g, '单膝跪地，双手停在装备包拉链处定格，侧头凝神倾听耳机中的通讯，神情严峻');
  text = text.replace(/奕馨在另一张书桌前合上练习册[，,]转身看向哥哥[；;]奕辰先侧头回应.*$/g, '奕馨坐在书桌前侧身转头看向哥哥，双手按在合拢的练习册上；奕辰侧头面向妹妹，眼神游移，身子仍斜向亮起的电脑');
  text = text.replace(/奕辰的操作速度(?:逐渐)?变慢[，,]但仍看着屏幕/g, '奕辰双手手指悬在键盘按键上方僵持停滞，双眼仍固执地紧盯屏幕冷光');
  text = text.replace(/奕辰嘴唇闭合[，,]右手停在鼠标上[；;]显示器冷光在眼镜镜片中重新映出工厂火光/g, '奕辰紧抿嘴唇面容紧绷，右手僵持握住鼠标，眼镜镜片强烈反光映出工厂爆炸火光，面孔被幽蓝冷光勾勒');
  text = text.replace(/救援装置上的数字从十秒连续下降/g, '胸前战术救援装置的荧光红字定格在紧急倒计时读数，目光焦急注视前方');
  text = text.replace(/倒计时跳到五秒[，,]红狼从断墙后冲向蜂医[，,]连续弹着点从他身后追到脚边[；;]数字降至一秒时[，,]他伸手扑向蜂医/g, '红狼身体凌空大幅前跃扑出，单臂竭力朝倒地的蜂医伸展手指，周围地面弹着点碎屑激射，背景废墟火光冲天，决绝悲壮的定格瞬间');
  text = text.replace(/间歇闪烁/g, '亮起微弱指示灯光');
  text = text.replace(/两束标记光[，,]分别扫过高台和二层窗口/g, '两道醒目的战术激光标记光束直射向高台与二层窗口，照亮昏暗环境');
  text = text.replace(/红狼的游戏画面出现纵向像素断层[，,]工厂影像向两侧错位[，,]中央逐渐露出书房屏幕反光/g, '游戏画面定格出现纵向像素故障与撕裂断层，工厂影像向两侧撕裂错位，画面正中心隐约映出书房与少年眼镜的幽蓝冷光反影');

  // 3. 统一替换时间过渡连接词为空间静态连接
  text = text.replace(/(?:然后|紧接着|接着|随后重新|随后|接下来)/g, '，');
  text = text.replace(/(?:开始|逐渐|慢慢)/g, '');

  // 4. 动态时序动词 -> 静态决定性瞬间定格抓拍转换
  // 4.1 视线与头部：快速看了一眼 -> 静态注视姿态
  text = text.replace(/(?:快速|猛然|急忙|悄悄|顺势|侧头)?(?:向|朝|往)([^，。；]+?)(?:看了一眼|瞄了一眼|扫视一眼|望了一眼|看去)/g, '头微偏向$1，目光警惕专注地注视着$1');
  text = text.replace(/(?:快速|猛然)?转头看向([^，。；]+?)(并|，|。|；|$)/g, '侧头面向$1，目光紧盯着$1$2');
  text = text.replace(/(?:转头)?扫视([^，。；]+?)[，,](?:在两个岔口之间来回确认|目光在两个岔口之间警惕扫视锁定)/g, '头部转向$1，锐利的目光警惕锁定前方岔路口，双手持枪戒备');
  text = text.replace(/在两个岔口之间来回确认/g, '目光警惕锁定岔路口');
  text = text.replace(/快速查看([^，。；]+)/g, '侧头警惕注视$1');
  text = text.replace(/又低头检查([^，。；]+)/g, '一手托起$1低头凝视');

  // 4.2 走动位移：沿...走到... -> 静态到达站位
  text = text.replace(/沿([^，。；]+?)(?:快步|低姿|慢慢)?走到([^，。；]+?)(?:右侧|左侧|身边|身旁|旁)/g, '半蹲停在$2旁，身体压低保持隐蔽');
  text = text.replace(/快步走到([^，。；]+?)(?:身边|身旁|旁|左侧|右侧)?/g, '停在$1旁，身体重心前移');
  text = text.replace(/走到([^，。；]+?)身边[，,]站在([^，。；]+?)旁[，,]低头看着([^，。；]+?)/g, '站在$2旁，身体微前倾，低头注视着$3');
  text = text.replace(/走到([^，。；]+?)(?:左侧|右侧|旁)[，,]低头看向([^，。；]+?)/g, '站在$1侧旁微前倾上身，低头凝视$2');
  text = text.replace(/(?:从走廊掩体后起身[，,])?压低上身(?:大步|向红狼所在方向快速)?冲出/g, '蜂医压低上身呈半俯冲奔跑姿态，单腿大步向前跨出，双手护持装备，头部微抬目光焦急注视红狼方向');
  text = text.replace(/(?:快速|全力|奋力)?奔向([^，。；]+)/g, '屈膝大步冲向$1');
  text = text.replace(/(?:向|朝)([^，。；]+?)(?:快速|全力)?冲出/g, '大步冲向$1');
  text = text.replace(/压低(?:上身|身姿|身体|身形)压低(?:上身|身姿|身体|身形)/g, '压低身姿');

  // 4.3 复合肢体互动：按下...准备起身的肩膀
  text = text.replace(/按下([^，。；]+?)准备起身的肩膀[，,]两人保持低姿态/g, '单手按在$1肩头，两人身体紧贴掩体压低重心，维持低姿隐蔽警戒');
  text = text.replace(/按下([^，。；]+?)的?肩膀/g, '单手按在$1肩头压低身形');
  text = text.replace(/按住护甲弹痕并抬起通讯器位置/g, '一手按在胸前受创的护甲弹痕上，一手按住战术通讯耳机，低头咬牙隐蔽');
  text = text.replace(/身体重心移向([^，。；]+)/g, '身体前倾蓄势待发，目光紧锁$1');
  text = text.replace(/对着通讯器发问/g, '单手手指按在战术通讯器上，神情凝重');

  // 4.4 身体失衡与跌倒：身体失去平衡
  text = text.replace(/身体失去平衡[，,]?(?:(?:向前|向后|向左|向右|前倾)?(?:跪倒|摔向|跌向|倒向|侧翻)[^，。；]*)?/g, '身体大幅向侧方倾斜失衡，单手紧急撑向地面，重心倾倒翻落的惊险定格瞬间');
  text = text.replace(/身体失去平衡[，,]?(?:前倾)?(?:摔向|跌向|倒向)?([^，。；]+)?/g, '身体大幅向侧方倾斜失衡，单手紧急撑向地面，重心倾倒翻落的惊险定格瞬间');

  // 4.5 掩体躲避与探身
  text = text.replace(/贴着断墙/g, '背靠断墙屈膝隐蔽');
  text = text.replace(/先指向([^，。；]+?)[，,、]再指向([^，。；]+)/g, '抬手直指$1与$2，身体保持低伏警戒');
  text = text.replace(/顺着两个方向快速转头/g, '侧头密切注视指引方向');
  text = text.replace(/从断墙右缘探出半个上身[，,]墙角立即被连续子弹击中[，,]他迅速缩回并压低头部/g, '红狼侧身紧贴断墙内侧，屈膝蹲伏压低头部避开碎石，双手握紧武器保持隐蔽低姿，头微低咬牙警戒');
  text = text.replace(/贴近断墙移动时[，,]前方爆炸掀起碎石[，,]一发子弹擦过头盔上沿[，,]他立即屈膝侧扑到墙后/g, '屈膝侧扑至断墙掩体后方，身体压低双手护住武器，周围碎石飞溅');
  text = text.replace(/向前跨一步挡住([^，。；]+?)半条行进路线[，,]抬手指向([^，。；]+)/g, '侧身跨步停在$1身前挡住路线，单臂抬起直指$2，神情严肃戒备');

  // 4.6 电脑书桌姿态（奕辰等）
  text = text.replace(/身体(?:继续)?前倾[，,]目光不离屏幕[，,]手指(?:快速)?敲击键盘/g, '上身前倾坐在书桌前，双手手指搭在键盘按键上，双眼专注凝视正前方屏幕');
  text = text.replace(/戴着耳机坐在书桌前[，,]右手手指连续敲击键盘[，,]身体前倾盯着电脑屏幕/g, '戴着耳机前倾坐在书桌前，右手搭在键盘上，目光专注凝视亮起的电脑屏幕');
  text = text.replace(/坐在电脑前[，,]未打开的书包留在座椅旁[，,]数学作业本刚被放到桌边/g, '端坐在电脑椅上，双手置于桌前，书包留在座椅旁，桌边放着作业本，目光注视屏幕');

  // 5. 清理破损结尾标点与冗余逗号
  text = text.replace(/，[，\s、]+/g, '，');
  text = text.replace(/^[，。；、\s]+|[，。；、\s]+$/g, '').trim();

  // 6. 终极残片与无姿态拦截修复 (解决 奕辰身体、露娜、抬手指 等严重缺陷)
  const isBareSubject = /^(?:[\u4e00-\u9fa5]{2,4}(?:与[\u4e00-\u9fa5]{2,4})?)(?:身体)?$/i.test(text);
  const isTruncatedFragment = text.length < 5 || /(?:抬手指|贴着断墙|操作速度|先指)$/.test(text);

  if (isBareSubject || isTruncatedFragment) {
    if (text.includes('奕辰') || (sb.location && sb.location.includes('书房'))) {
      text = '上身前倾坐在书桌前，双手搭在键盘上，目光专注注视着正前方屏幕';
    } else if (text.includes('露娜')) {
      text = '侧身站立在掩体边缘，单臂抬起指向前方，压低身姿神情警惕严肃';
    } else if (text.includes('蜂医')) {
      text = '侧身半卧在掩体后方地面，用前臂撑起上身，抬手指向前方，神色急迫';
    } else if (text.includes('红狼')) {
      text = '背靠断墙屈膝压低重心隐蔽，双手紧握突击步枪，目光警戒注视通道';
    } else {
      text = text + '，身体保持低姿警惕隐蔽，双手持备，目光专注注视前方';
    }
  }

  return text;
}

function extractInitialPose(action, sb) {
  return extractStaticFreezeFramePose(action, sb);
}

function isFlawedImagePrompt(prompt) {
  if (!prompt || typeof prompt !== 'string') return true;
  const p = prompt.trim();
  if (!p) return true;

  // 1. 包含被截断的残片或残缺短语
  if (/，(?:[\u4e00-\u9fa5]{2,4}(?:与[\u4e00-\u9fa5]{2,4})?)(?:身体)?，/i.test(p)) return true;
  if (/，(?:抬手指|贴着断墙|先指|操作速度|抬手指向|身体)[\s，]/i.test(p)) return true;
  if (/，[^，。；]+?(?:抬手指|贴着断墙|先指|操作速度|身体)[，\s]/i.test(p)) return true;
  if (/，(?:[^，。；]*?)(?:向[^，。；]+方向|沿[^，。；]+道路|沿[^，。；]+后方)[，\s]/i.test(p)) return true;
  if (/压低(?:上身|身姿)压低/i.test(p)) return true;
  if (/重心向向/i.test(p)) return true;
  if (/露娜半蹲在掩体边缘，露娜/i.test(p)) return true;
  if (/红狼没有停步/i.test(p)) return true;
  if (/侧身侧头面向哥哥/i.test(p)) return true;

  // 2. 包含明显的动态/视频时序动词、多步时序动作或过程词（违背纯静态定格摄影抓拍原则）
  if (/(?:镜头|分镜)[0-9一二三四五]/i.test(p)) return true;
  if (/切到|切至/i.test(p)) return true;
  if (/镜头(?:从|随|缓推|推进|侧向推进|后拉|下降|螺旋|向)/i.test(p)) return true;
  if (/持续缓推/i.test(p)) return true;
  if (/缓缓转身|缓缓抬眼|缓慢收拢|逐渐绷白/i.test(p)) return true;
  if (/掌心猛地拍在|手指划过/i.test(p)) return true;
  if (/冲昏了头脑|静静潜伏|灾难预感|不祥预感/i.test(p)) return true;
  if (/(?:快速|猛然|顺势|急忙|回头)?向[^，。；]+?看了一眼/i.test(p)) return true;
  if (/转头向[^，。；]+?看了一眼/i.test(p)) return true;
  if (/沿[^，。；]+?走到[^，。；]+?/i.test(p)) return true;
  if (/按下[^，。；]+?准备起身的肩膀/i.test(p)) return true;
  if (/身体失去平衡[，,]/i.test(p)) return true;
  if (/随后重新/i.test(p)) return true;
  if (/先指向.+?再/i.test(p)) return true;
  if (/急停后/i.test(p)) return true;
  if (/翻滚到/i.test(p)) return true;
  if (/停止翻找/i.test(p)) return true;
  if (/间歇闪烁/i.test(p)) return true;
  if (/连续下降/i.test(p)) return true;
  if (/倒计时跳到/i.test(p)) return true;
  if (/操作速度变慢/i.test(p)) return true;
  if (/转向屏幕/i.test(p)) return true;
  if (/抬起通讯器位置/i.test(p)) return true;
  if (/抬头观察高台/i.test(p)) return true;

  return false;
}

function sanitizeStaticImagePrompt(prompt, sb = {}, style = '') {
  if (!prompt || typeof prompt !== 'string') return generateImagePrompt(sb, style);
  if (isFlawedImagePrompt(prompt)) {
    return generateImagePrompt(sb, style);
  }
  let text = prompt.trim();
  text = extractStaticFreezeFramePose(text, sb);
  return text;
}

function generateImagePrompt(sb, style) {
  const { stripChineseExclusions } = require('../utils/framePromptSanitize');

  // 若包含预置槽位（character_visuals），优先使用确定性槽位编译器
  let visuals = sb.character_visuals;
  if (typeof visuals === 'string') {
    try { visuals = JSON.parse(visuals); } catch (_) { visuals = null; }
  }
  if (Array.isArray(visuals) && visuals.length > 0) {
    const { compileImagePromptFromSlots } = require('../ontology/visualSlots');
    return compileImagePromptFromSlots(sb, visuals, { style });
  }

  const parts = [];
  // 场景位置与时间
  if (sb.location) {
    let locationDesc = stripChineseExclusions(sb.location);
    if (sb.time) locationDesc += '，' + stripChineseExclusions(sb.time);
    parts.push(locationDesc);
  }
  // 镜头视角：优先结构化三元组（中文标签），降级到旧文本
  if (sb.angle_h && sb.angle_v && sb.angle_s) {
    parts.push(angleService.toChineseLabel(sb.angle_h, sb.angle_v, sb.angle_s));
  } else if (sb.angle || sb.shot_type) {
    const { h, v, s } = angleService.parseFromLegacyText(sb.angle || '', sb.shot_type || '');
    parts.push(angleService.toChineseLabel(h, v, s));
  }
  // 画面动作（取定格瞬间的纯静态摄影姿态）
  if (sb.action) {
    const staticPose = extractStaticFreezeFramePose(stripChineseExclusions(sb.action), sb);
    if (staticPose) parts.push(staticPose);
  }
  // 情绪
  if (sb.emotion) parts.push(sb.emotion);
  // 风格（英文 prompt token，保持英文以兼容图片 AI）
  const styleText = style && String(style).trim();
  if (styleText) parts.push(styleText);
  parts.push('首帧静止画面');
  return parts.join('，');
}

function generateVideoPrompt(sb, style, videoRatio) {
  // 结构化视频语义槽位契约优先：若已持久化 video_slots，直接由确定性编译器编译
  let slots = sb.video_slots;
  if (typeof slots === 'string') {
    try { slots = JSON.parse(slots); } catch (_) { slots = null; }
  }
  const { synthesizeVideoSlots, compileVideoPromptFromSlots } = require('../ontology/videoSlots');
  if (!slots || typeof slots !== 'object' || !slots.camera || !slots.audio_lip_sync) {
    slots = synthesizeVideoSlots(sb, []);
  }
  return compileVideoPromptFromSlots(sb, slots, { style, videoRatio });
}

function generateLastFramePrompt(sb, style) {
  let lastVisuals = sb.last_frame_visuals;
  if (typeof lastVisuals === 'string') {
    try { lastVisuals = JSON.parse(lastVisuals); } catch (_) { lastVisuals = null; }
  }
  const { compileLastFramePromptFromSlots, synthesizeLastFrameVisualSlots } = require('../ontology/visualSlots');
  if (!Array.isArray(lastVisuals) || lastVisuals.length === 0) {
    lastVisuals = synthesizeLastFrameVisualSlots(sb, []);
  }
  return compileLastFramePromptFromSlots(sb, lastVisuals, { style });
}

/**
 * 从 AI 分镜的 characters 字段提取角色造型文本（#38）。
 * @param {Array} sbCharacters AI 返回的角色列表，元素为 {id,name} / id / name
 * @param {Object<string,string>} [appearanceMap] id 或 `name:姓名` → 「姓名」造型 的映射
 * @returns {string} 每行一个角色的造型文本；无可用信息时返回空串
 */
function buildCharacterAppearancesFromAiCharacters(sbCharacters, appearanceMap) {
  if (!appearanceMap || !Array.isArray(sbCharacters) || sbCharacters.length === 0) return '';
  const lines = [];
  const seen = new Set();
  for (const item of sbCharacters) {
    let line = null;
    if (item != null && typeof item === 'object') {
      line = (item.id != null ? appearanceMap[String(item.id)] : null)
        || (item.name ? appearanceMap['name:' + String(item.name).trim()] : null);
    } else if (item != null) {
      const key = String(item).trim();
      line = appearanceMap[key] || appearanceMap['name:' + key];
    }
    if (line && !seen.has(line)) {
      seen.add(line);
      lines.push(line);
    }
  }
  return lines.join('\n');
}

/**
 * 本剧角色造型映射（#38）：id / `name:姓名` → 「姓名」造型。
 * AI 分镜只带角色 id 与姓名，须在入库前把外貌补进视频提示词，
 * 否则视频模型无从获知人物形象，每次生成结果随机。
 */
function buildDramaCharacterAppearanceMap(characters) {
  const map = {};
  for (const c of characters || []) {
    const appearance = String(c.appearance || '').trim();
    if (!appearance) continue;
    const line = c.name ? `「${c.name}」${appearance}` : appearance;
    map[String(c.id)] = line;
    if (c.name) map['name:' + String(c.name).trim()] = line;
  }
  return map;
}

/**
 * 从 AI 输出的单个分镜对象计算入库字段（INSERT/UPDATE 共用）。
 * 会就地写入 sb.location / sb.time（由 scene_description 拆分）。
 */
function deriveStoryboardFieldsFromAi(sb, style, videoRatio, opts = {}) {
  const universalOmni = !!opts.universalOmni;
  const angleValFn = (x) => x.angle ?? x.camera_angle ?? null;
  const shotNumber = normalizeStoryboardShotNumber(sb);
  const title = sb.title ?? '';
  let shotType = sb.shot_type ?? '';
  let movement = sb.movement ?? sb.camera_movement ?? '';
  const angle = angleValFn(sb);
  const action = sb.action ?? '';
  const dialogue = sb.dialogue ?? '';
  const narration = sb.narration ?? '';
  const result = sb.result ?? '';
  const emotion = sb.emotion ?? '';
  const segmentIndex = sb.segment_index != null ? Number(sb.segment_index) : 0;
  const segmentTitle = sb.segment_title ?? null;
  let lightingStyle = sb.lighting_style ?? null;
  let depthOfField = sb.depth_of_field ?? null;

  // 摄影参数归一化与自动推断（确保分镜视角、灯光、景别、运镜、景深全量就绪）
  const inferred = angleService.inferPhotographyParams(sb, { upgradeStatic: true });
  const normMovement = angleService.normalizeMovement(movement);
  // 严格少用固定镜头 static：若 AI 输出了 static 或为空，自动升级为推断的动态运镜（除非剧情明确要求固定）
  if (!normMovement || (normMovement === 'static' && inferred.movement && inferred.movement !== 'static')) {
    movement = inferred.movement;
  } else {
    movement = normMovement;
  }
  lightingStyle = angleService.normalizeLighting(lightingStyle) || inferred.lighting_style || 'natural';
  depthOfField = angleService.normalizeDof(depthOfField) || inferred.depth_of_field || 'medium';

  // 镜头视角三元组 (h, v, s) 归一化与自动推断
  const { h: angleH, v: angleV, s: angleS } = angleService.inferAngleTriple({
    ...sb,
    shot_type: shotType,
    angle,
    action,
    atmosphere: sb.atmosphere,
  });

  if (!shotType && angleS) {
    shotType = angleS === 'close_up' ? '特写' : (angleS === 'wide' ? '远景' : '中景');
  }

  let durationSec = normalizeDuration(sb.duration) || 5;
  const targetClip = opts.targetClipDuration != null ? Number(opts.targetClipDuration) : 0;
  if (opts.durationRange) {
    durationSec = planShotDuration(sb, opts.durationRange);
  } else if (Number.isFinite(targetClip) && targetClip > 0) {
    durationSec = Math.round(targetClip);
  }
  durationSec = Math.min(120, Math.max(1, Math.round(durationSec)));
  sb.duration = durationSec;
  if (!sb.location && sb.scene_description) {
    const sceneDesc = String(sb.scene_description).trim();
    const sepIdx = sceneDesc.search(/[，,、]/);
    if (sepIdx > 0) {
      sb.location = sceneDesc.slice(0, sepIdx).trim();
      if (!sb.time) sb.time = sceneDesc.slice(sepIdx + 1).trim();
    } else {
      sb.location = sceneDesc;
    }
  }
  const description = `【镜头类型】${shotType}\n【运镜】${movement}\n【动作】${action}\n【对话】${dialogue}\n【解说】${narration}\n【结果】${result}\n【情绪】${emotion}`;
  // 背景音乐与音效设计：无对白镜头必须配上背景音乐描述，专供 H3 等视频模型原生生成高质量背景音乐
  let bgmPrompt = (sb.bgm_prompt || '').toString().trim();
  const soundEffect = (sb.sound_effect || '').toString().trim();
  if (!dialogue && (!bgmPrompt || bgmPrompt === '无' || /禁bgm|无背景音乐|no\s*bgm/i.test(bgmPrompt))) {
    bgmPrompt = angleService.inferBgmPrompt(sb);
  }
  const sbWithAngles = { ...sb, shot_type: shotType, movement, lighting_style: lightingStyle, depth_of_field: depthOfField, angle_h: angleH, angle_v: angleV, angle_s: angleS, bgm_prompt: bgmPrompt, sound_effect: soundEffect };

  // 首尾帧双关键帧槽位与视频语义槽位契约（消灭无槽位、正则匹配、尾帧形变与口型错乱）
  let characterVisuals = sb.character_visuals;
  if (typeof characterVisuals === 'string') {
    try { characterVisuals = JSON.parse(characterVisuals); } catch (_) { characterVisuals = null; }
  }
  const { synthesizeCharacterVisualSlots, synthesizeLastFrameVisualSlots } = require('../ontology/visualSlots');
  if (!Array.isArray(characterVisuals) || characterVisuals.length === 0) {
    characterVisuals = synthesizeCharacterVisualSlots(sbWithAngles, []);
  }

  let lastFrameVisuals = sb.last_frame_visuals;
  if (typeof lastFrameVisuals === 'string') {
    try { lastFrameVisuals = JSON.parse(lastFrameVisuals); } catch (_) { lastFrameVisuals = null; }
  }
  if (!Array.isArray(lastFrameVisuals) || lastFrameVisuals.length === 0) {
    lastFrameVisuals = synthesizeLastFrameVisualSlots(sbWithAngles, [], characterVisuals);
  }

  // 角色造型注入（#38）：视频提示词须携带角色外貌，否则视频模型每次随机生成人物形象
  const characterAppearances = buildCharacterAppearancesFromAiCharacters(sb.characters, opts.characterAppearances);

  const { synthesizeVideoSlots } = require('../ontology/videoSlots');
  let videoSlots = sb.video_slots;
  if (typeof videoSlots === 'string') {
    try { videoSlots = JSON.parse(videoSlots); } catch (_) { videoSlots = null; }
  }
  if (!videoSlots || typeof videoSlots !== 'object' || !videoSlots.camera || !videoSlots.audio_lip_sync) {
    videoSlots = synthesizeVideoSlots({
      ...sbWithAngles,
      character_visuals: characterVisuals,
      last_frame_visuals: lastFrameVisuals,
      character_appearances: characterAppearances,
    }, []);
  }

  const sbWithSlots = {
    ...sbWithAngles,
    character_visuals: characterVisuals,
    last_frame_visuals: lastFrameVisuals,
    video_slots: videoSlots,
    character_appearances: characterAppearances,
  };

  const imagePrompt = generateImagePrompt(sbWithSlots, style);
  const videoPrompt = generateVideoPrompt(sbWithSlots, style, videoRatio);
  const sceneId = sb.scene_id != null ? Number(sb.scene_id) : null;
  const charactersJson = Array.isArray(sb.characters) ? JSON.stringify(sb.characters) : (sb.characters ? JSON.stringify([].concat(sb.characters)) : '[]');
  const propIds = Array.isArray(sb.props) ? sb.props.map(Number).filter(Number.isFinite) : [];
  let universalSegmentText = '';
  if (sb.universal_segment_text != null && String(sb.universal_segment_text).trim()) {
    universalSegmentText = String(sb.universal_segment_text).trim().replace(/\r?\n/g, ' ');
  }
  if (universalOmni && !universalSegmentText) {
    universalSegmentText = buildFallbackUniversalSeedanceLine(
      sb,
      {
        shotNumber,
        durationSec,
        shotType,
        movement,
        angle,
        action,
        dialogue,
        result,
        emotion,
        lightingStyle,
        depthOfField,
      },
      style
    );
  }
  const creationMode = universalOmni ? 'universal' : 'classic';
  if (!universalOmni) universalSegmentText = null;
  const layoutDescription = (sb.layout_description && String(sb.layout_description).trim()) || null;
  return {
    shotNumber,
    title,
    shotType,
    movement,
    angle,
    action,
    dialogue,
    narration,
    result,
    emotion,
    segmentIndex,
    segmentTitle,
    lightingStyle,
    depthOfField,
    bgmPrompt,
    soundEffect,
    description,
    imagePrompt,
    videoPrompt,
    characterVisuals,
    lastFrameVisuals,
    videoSlots,
    sceneId,
    charactersJson,
    angleH,
    angleV,
    angleS,
    propIds,
    creationMode,
    universalSegmentText,
    layoutDescription,
  };
}

/** 用最终解析的分镜对象覆盖已存在的行（修正流式增量先入库时缺 narration 等字段的问题） */
function updateStoryboardRowFromDerived(db, existingId, episodeIdNum, d, sb, now) {
  try {
    db.prepare(
      `UPDATE storyboards SET
        scene_id = ?, title = ?, description = ?, location = ?, time = ?, duration = ?,
        dialogue = ?, narration = ?, action = ?, result = ?, atmosphere = ?,
        image_prompt = ?, video_prompt = ?, characters = ?,
        character_visuals = ?, last_frame_visuals = ?, video_slots = ?,
        shot_type = ?, angle = ?, angle_h = ?, angle_v = ?, angle_s = ?, movement = ?,
        lighting_style = ?, depth_of_field = ?, bgm_prompt = ?, sound_effect = ?, segment_index = ?, segment_title = ?,
        creation_mode = ?, universal_segment_text = ?,
        layout_description = COALESCE(?, layout_description),
        updated_at = ?
       WHERE id = ? AND episode_id = ? AND deleted_at IS NULL`
    ).run(
      d.sceneId,
      d.title || null,
      d.description,
      sb.location ?? null,
      sb.time ?? null,
      sb.duration ?? 5,
      d.dialogue || null,
      d.narration || null,
      d.action || null,
      d.result || null,
      sb.atmosphere ?? null,
      d.imagePrompt,
      d.videoPrompt,
      d.charactersJson,
      d.characterVisuals ? JSON.stringify(d.characterVisuals) : null,
      d.lastFrameVisuals ? JSON.stringify(d.lastFrameVisuals) : null,
      d.videoSlots ? JSON.stringify(d.videoSlots) : null,
      d.shotType || null,
      d.angle,
      d.angleH,
      d.angleV,
      d.angleS,
      d.movement || null,
      d.lightingStyle,
      d.depthOfField,
      d.bgmPrompt || null,
      d.soundEffect || null,
      d.segmentIndex,
      d.segmentTitle,
      d.creationMode || 'classic',
      d.universalSegmentText != null ? d.universalSegmentText : null,
      d.layoutDescription,
      now,
      existingId,
      episodeIdNum
    );
  } catch (upErr) {
    if ((upErr.message || '').includes('character_visuals') || (upErr.message || '').includes('layout_description') || (upErr.message || '').includes('bgm_prompt')) {
      db.prepare(
        `UPDATE storyboards SET
          scene_id = ?, title = ?, description = ?, location = ?, time = ?, duration = ?,
          dialogue = ?, narration = ?, action = ?, result = ?, atmosphere = ?,
          image_prompt = ?, video_prompt = ?, characters = ?,
          shot_type = ?, angle = ?, angle_h = ?, angle_v = ?, angle_s = ?, movement = ?,
          lighting_style = ?, depth_of_field = ?, segment_index = ?, segment_title = ?,
          creation_mode = ?, universal_segment_text = ?,
          updated_at = ?
         WHERE id = ? AND episode_id = ? AND deleted_at IS NULL`
      ).run(
        d.sceneId,
        d.title || null,
        d.description,
        sb.location ?? null,
        sb.time ?? null,
        sb.duration ?? 5,
        d.dialogue || null,
        d.narration || null,
        d.action || null,
        d.result || null,
        sb.atmosphere ?? null,
        d.imagePrompt,
        d.videoPrompt,
        d.charactersJson,
        d.shotType || null,
        d.angle,
        d.angleH,
        d.angleV,
        d.angleS,
        d.movement || null,
        d.lightingStyle,
        d.depthOfField,
        d.segmentIndex,
        d.segmentTitle,
        d.creationMode || 'classic',
        d.universalSegmentText != null ? d.universalSegmentText : null,
        now,
        existingId,
        episodeIdNum
      );
    } else {
      throw upErr;
    }
  }
  require('./wardrobeService').recordAiChange(db, episodeIdNum, existingId, sb);
  require('./speechDeliveryService').recordAiPlan(db, episodeIdNum, existingId, sb);
  try {
    db.prepare('DELETE FROM storyboard_props WHERE storyboard_id = ?').run(existingId);
    if (d.propIds.length > 0) {
      const insProp = db.prepare('INSERT OR IGNORE INTO storyboard_props (storyboard_id, prop_id) VALUES (?, ?)');
      for (const pid of d.propIds) insProp.run(existingId, pid);
    }
  } catch (_) {}
}

/**
 * 将单个分镜对象插入 DB，供增量流式保存使用。
 * 返回插入后的 id，出错则返回 null（不抛异常）。
 */
function insertOneStoryboard(db, episodeIdNum, sb, style, videoRatio, now, deriveOpts = {}) {
  const d = deriveStoryboardFieldsFromAi(sb, style, videoRatio, deriveOpts);
  const shotNumber = d.shotNumber;
  try {
    let newId;
    try {
      const info = db.prepare(
        `INSERT INTO storyboards (episode_id, scene_id, storyboard_number, title, description, location, time, duration, dialogue, narration, action, result, atmosphere, image_prompt, video_prompt, characters, character_visuals, last_frame_visuals, video_slots, shot_type, angle, angle_h, angle_v, angle_s, movement, lighting_style, depth_of_field, bgm_prompt, sound_effect, segment_index, segment_title, creation_mode, universal_segment_text, layout_description, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      ).run(
        episodeIdNum, d.sceneId, shotNumber, d.title || null, d.description,
        sb.location ?? null, sb.time ?? null, sb.duration ?? 5,
        d.dialogue || null, d.narration || null, d.action || null, d.result || null, sb.atmosphere ?? null,
        d.imagePrompt, d.videoPrompt, d.charactersJson,
        d.characterVisuals ? JSON.stringify(d.characterVisuals) : null,
        d.lastFrameVisuals ? JSON.stringify(d.lastFrameVisuals) : null,
        d.videoSlots ? JSON.stringify(d.videoSlots) : null,
        d.shotType || null, d.angle, d.angleH, d.angleV, d.angleS,
        d.movement || null, d.lightingStyle, d.depthOfField, d.bgmPrompt || null, d.soundEffect || null, d.segmentIndex, d.segmentTitle,
        d.creationMode || 'classic',
        d.universalSegmentText != null ? d.universalSegmentText : null,
        d.layoutDescription,
        now, now
      );
      newId = info.lastInsertRowid;
    } catch (colErr) {
      if ((colErr.message || '').includes('character_visuals') || (colErr.message || '').includes('layout_description') || (colErr.message || '').includes('bgm_prompt')) {
        const info = db.prepare(
          `INSERT INTO storyboards (episode_id, scene_id, storyboard_number, title, description, location, time, duration, dialogue, narration, action, result, atmosphere, image_prompt, video_prompt, characters, shot_type, angle, angle_h, angle_v, angle_s, movement, lighting_style, depth_of_field, segment_index, segment_title, creation_mode, universal_segment_text, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
        ).run(
          episodeIdNum, d.sceneId, shotNumber, d.title || null, d.description,
          sb.location ?? null, sb.time ?? null, sb.duration ?? 5,
          d.dialogue || null, d.narration || null, d.action || null, d.result || null, sb.atmosphere ?? null,
          d.imagePrompt, d.videoPrompt, d.charactersJson,
          d.shotType || null, d.angle, d.angleH, d.angleV, d.angleS,
          d.movement || null, d.lightingStyle, d.depthOfField, d.segmentIndex, d.segmentTitle,
          d.creationMode || 'classic',
          d.universalSegmentText != null ? d.universalSegmentText : null,
          now, now
        );
        newId = info.lastInsertRowid;
      } else {
        throw colErr;
      }
    }
    require('./wardrobeService').recordAiChange(db, episodeIdNum, newId, sb);
    require('./speechDeliveryService').recordAiPlan(db, episodeIdNum, newId, sb);
    if (d.propIds.length > 0) {
      try {
        const insProp = db.prepare('INSERT OR IGNORE INTO storyboard_props (storyboard_id, prop_id) VALUES (?, ?)');
        for (const pid of d.propIds) insProp.run(newId, pid);
      } catch (_) {}
    }
    return newId;
  } catch (_) {
    return null;
  }
}

/**
 * 在流式输出过程中，从已积累的文本尝试解析并保存尚未保存的分镜。
 * savedNums：已保存的 storyboard_number Set，用于去重。
 */
function tryIncrementalSave(db, log, episodeIdNum, accumulated, savedNums, style, videoRatio, deriveOpts = {}) {
  if (deriveOpts.deferPersistence) return;
  try {
    let cleaned = accumulated.trim()
      .replace(/^```json\s*/gm, '').replace(/^```\s*/gm, '').replace(/```\s*$/gm, '').trim();
    // 转义字符串字段里的原始换行符，防止 JSON.parse 报 "Unterminated string"
    cleaned = safeJson.escapeNewlinesInStrings(cleaned);
    let candidate = extractJsonCandidate(cleaned);
    if (!candidate) return;

    // 如果 AI 将数组包在对象里（如 doubao 的 {"storyboards":[...]}），提取内部数组
    const innerArray = safeJson.extractWrappedArrayStr(candidate);
    const arrayCandidate = innerArray || candidate;

    // 策略A：截断修复（找到已完整闭合的顶层元素）
    let parsed = null;
    const repaired = repairTruncatedJsonArray(arrayCandidate);
    if (repaired) {
      try { parsed = JSON.parse(repaired); } catch (_) {}
      // 策略B：截断修复 + jsonrepair
      if (!parsed && safeJson._jsonrepair) {
        try { parsed = JSON.parse(safeJson._jsonrepair(repaired)); } catch (_) {}
      }
    }
    // 策略C：直接 jsonrepair 整体修复
    if (!parsed && safeJson._jsonrepair) {
      try { parsed = JSON.parse(safeJson._jsonrepair(arrayCandidate)); } catch (_) {}
    }
    if (!parsed) return;
    const items = Array.isArray(parsed) ? parsed : extractFirstArray(parsed);
    if (!items || items.length === 0) return;
    const now = new Date().toISOString();
    let newCount = 0;
    for (const sb of items) {
      const shotNumber = normalizeStoryboardShotNumber(sb);
      if (shotNumber > 0 && savedNums.has(shotNumber)) continue;
      const id = insertOneStoryboard(db, episodeIdNum, sb, style, videoRatio, now, deriveOpts);
      if (id !== null) {
        savedNums.add(shotNumber);
        newCount++;
      }
    }
    if (newCount > 0) {
      log.info('Storyboard incremental save', { episode_id: episodeIdNum, new_count: newCount, total_saved: savedNums.size });
    }
  } catch (_) { /* 流式解析错误静默忽略，等待最终完整解析 */ }
}

/**
 * @param {Set|null} skipShotNumbers - 已通过增量流式保存的 storyboard_number 集合，跳过重复插入
 */
function saveStoryboards(db, log, episodeId, storyboards, cfg, styleOverride, skipShotNumbers = null, deriveOpts = {}) {
  const episodeIdNum = Number(episodeId);
  if (storyboards.length === 0) {
    throw new Error('AI生成分镜失败：返回的分镜数量为0');
  }
  const style = (styleOverride && String(styleOverride).trim()) || cfg?.style?.default_style || '';
  const videoRatio = cfg?.style?.default_video_ratio || '16:9';
  const now = new Date().toISOString();

  // 仅在非增量模式下才删除旧数据（增量模式时已在流式开始前删除）
  if (skipShotNumbers === null) {
    const existing = db.prepare('SELECT id FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL').all(episodeIdNum);
    if (existing.length > 0) {
      db.prepare('UPDATE storyboards SET deleted_at = ? WHERE episode_id = ?').run(now, episodeIdNum);
    }
  }

  const saved = [];
  const processedInSave = new Set();
  for (const sb of storyboards) {
    const shotNumber = normalizeStoryboardShotNumber(sb);
    if (shotNumber > 0 && processedInSave.has(shotNumber)) {
      log.warn('Duplicate storyboard_number in final AI batch, skipping extra row', {
        episode_id: episodeIdNum,
        storyboard_number: shotNumber,
      });
      continue;
    }

    // 已由增量流式保存过的分镜：必须用**最终完整 JSON** 再 UPDATE 一行（否则首镜常在流式阶段缺 narration 等字段且永不修正）
    if (skipShotNumbers && skipShotNumbers.has(shotNumber)) {
      const existing = db.prepare(
        'SELECT * FROM storyboards WHERE episode_id = ? AND storyboard_number = ? AND deleted_at IS NULL'
      ).get(episodeIdNum, shotNumber);
      if (existing) {
        const d = deriveStoryboardFieldsFromAi(sb, style, videoRatio, deriveOpts);
        updateStoryboardRowFromDerived(db, existing.id, episodeIdNum, d, sb, now);
        log.info('Storyboard merged from final parse after incremental save', {
          episode_id: episodeIdNum,
          storyboard_id: existing.id,
          storyboard_number: shotNumber,
        });
        const refreshed = db.prepare(
          'SELECT * FROM storyboards WHERE id = ? AND deleted_at IS NULL'
        ).get(existing.id);
        let propIds = [];
        try {
          const propLinks = db.prepare('SELECT prop_id FROM storyboard_props WHERE storyboard_id = ?').all(refreshed.id);
          propIds = propLinks.map((p) => p.prop_id);
        } catch (_) {}
        saved.push({
          id: refreshed.id,
          episode_id: episodeIdNum,
          scene_id: refreshed.scene_id,
          storyboard_number: shotNumber,
          title: refreshed.title,
          description: refreshed.description,
          location: refreshed.location,
          time: refreshed.time,
          duration: refreshed.duration,
          dialogue: refreshed.dialogue,
          narration: refreshed.narration ?? null,
          action: refreshed.action,
          result: refreshed.result,
          atmosphere: refreshed.atmosphere,
          image_prompt: refreshed.image_prompt,
          video_prompt: refreshed.video_prompt,
          shot_type: refreshed.shot_type,
          angle: refreshed.angle,
          movement: refreshed.movement,
          segment_index: refreshed.segment_index ?? 0,
          segment_title: refreshed.segment_title ?? null,
          creation_mode: refreshed.creation_mode === 'universal' ? 'universal' : 'classic',
          universal_segment_text: refreshed.universal_segment_text ?? null,
          characters: (() => { try { return JSON.parse(refreshed.characters || '[]'); } catch (_) { return []; } })(),
          prop_ids: propIds,
          status: refreshed.status,
          created_at: refreshed.created_at,
          updated_at: refreshed.updated_at,
        });
        if (shotNumber > 0) processedInSave.add(shotNumber);
        continue;
      }
      // 流式阶段已登记镜号但库中无行（竞态/异常）：不再 INSERT 重复行
      if (shotNumber > 0) {
        log.warn('Incremental shot missing in DB at final save, skipping insert', {
          episode_id: episodeIdNum,
          storyboard_number: shotNumber,
        });
        continue;
      }
    }

    const d = deriveStoryboardFieldsFromAi(sb, style, videoRatio, deriveOpts);

    try {
      db.prepare(
        `INSERT INTO storyboards (episode_id, scene_id, storyboard_number, title, description, location, time, duration, dialogue, narration, action, result, atmosphere, image_prompt, video_prompt, characters, shot_type, angle, angle_h, angle_v, angle_s, movement, lighting_style, depth_of_field, bgm_prompt, sound_effect, segment_index, segment_title, creation_mode, universal_segment_text, layout_description, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      ).run(
        episodeIdNum, d.sceneId, shotNumber, d.title || null, d.description,
        sb.location ?? null, sb.time ?? null, sb.duration ?? 5,
        d.dialogue || null, d.narration || null, d.action || null, d.result || null, sb.atmosphere ?? null,
        d.imagePrompt, d.videoPrompt, d.charactersJson,
        d.shotType || null, d.angle, d.angleH, d.angleV, d.angleS,
        d.movement || null, d.lightingStyle, d.depthOfField, d.bgmPrompt || null, d.soundEffect || null, d.segmentIndex, d.segmentTitle,
        d.creationMode || 'classic',
        d.universalSegmentText != null ? d.universalSegmentText : null,
        d.layoutDescription,
        now, now
      );
    } catch (e) {
      if ((e.message || '').includes('shot_type') || (e.message || '').includes('angle') || (e.message || '').includes('movement') || (e.message || '').includes('result') || (e.message || '').includes('segment') || (e.message || '').includes('narration') || (e.message || '').includes('layout_description') || (e.message || '').includes('bgm_prompt')) {
        db.prepare(
          `INSERT INTO storyboards (episode_id, scene_id, storyboard_number, title, description, location, time, duration, dialogue, action, atmosphere, image_prompt, video_prompt, characters, creation_mode, universal_segment_text, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
        ).run(
          episodeIdNum, d.sceneId, shotNumber, d.title || null, d.description,
          sb.location ?? null, sb.time ?? null, sb.duration ?? 5,
          d.dialogue || null, d.action || null, sb.atmosphere ?? null,
          d.imagePrompt, d.videoPrompt, d.charactersJson,
          d.creationMode || 'classic',
          d.universalSegmentText != null ? d.universalSegmentText : null,
          now, now
        );
      } else {
        throw e;
      }
    }
    const id = db.prepare('SELECT last_insert_rowid() as id').get().id;
    require('./wardrobeService').recordAiChange(db, episodeIdNum, id, sb);
    require('./speechDeliveryService').recordAiPlan(db, episodeIdNum, id, sb);
    if (d.propIds.length > 0) {
      try {
        const insProp = db.prepare('INSERT OR IGNORE INTO storyboard_props (storyboard_id, prop_id) VALUES (?, ?)');
        for (const pid of d.propIds) insProp.run(id, pid);
      } catch (_) {}
    }
    saved.push({
      id,
      episode_id: episodeIdNum,
      scene_id: d.sceneId,
      storyboard_number: shotNumber,
      title: d.title || null,
      description: d.description,
      location: sb.location ?? null,
      time: sb.time ?? null,
      duration: sb.duration ?? 5,
      dialogue: d.dialogue || null,
      narration: d.narration || null,
      action: d.action || null,
      result: d.result || null,
      atmosphere: sb.atmosphere ?? null,
      image_prompt: d.imagePrompt,
      video_prompt: d.videoPrompt,
      shot_type: d.shotType || null,
      angle: d.angle,
      movement: d.movement || null,
      segment_index: d.segmentIndex,
      segment_title: d.segmentTitle,
      creation_mode: d.creationMode || 'classic',
      universal_segment_text: d.universalSegmentText != null ? d.universalSegmentText : null,
      characters: Array.isArray(sb.characters) ? sb.characters : [],
      prop_ids: d.propIds,
      status: 'pending',
      created_at: now,
      updated_at: now,
    });
    if (shotNumber > 0) processedInSave.add(shotNumber);
  }
  log.info('Storyboards saved', { episode_id: episodeId, count: saved.length });
  return saved;
}

/**
 * 构建续写 prompt：当首次响应被截断时，携带已生成分镜完整列表 + 末尾详情作为上下文，
 * 请求 AI 从 lastShotNum+1 继续生成剩余分镜。
 * 关键：必须把所有已生成分镜的 shot_number + segment_title + title 全部列出，
 * 防止 AI 因不知道哪些情节已覆盖而重复生成相同内容。
 */
function buildContinuationPrompt(originalUserPrompt, alreadySaved, lastShotNum, attempt, includeNarration, universalOmni = false) {
  const narrLine = includeNarration
    ? '\n- 每条新增分镜均有 narration 字符串；仅在需要解释关键背景或因果时补旁白，已讲清的对白镜头与过场可为空。'
    : '';
  const uniLine = universalOmni
    ? '\n- 每条新增分镜必须含 creation_mode:"universal" 与非空 universal_segment_text，沿用首轮的多行段落格式；默认一个连续子分镜、至多一种简单运镜，台词与 dialogue/narration 逐字一致。'
    : '';
  // 全量已生成分镜摘要（每行一个，仅 shot_number + segment + title）
  const allSummary = alreadySaved.map((sb) => {
    const num = sb.shot_number ?? sb.storyboard_number ?? 0;
    const seg = (sb.segment_title || '').replace(/"/g, '\\"');
    const title = (sb.title || '').replace(/"/g, '\\"');
    return `  ${num}. [${seg}] ${title}`;
  }).join('\n');

  // 末尾 5 个分镜的详细内容（供衔接用）
  const lastCtx = alreadySaved.slice(-5).map((sb) => {
    const num = sb.shot_number ?? sb.storyboard_number ?? 0;
    const title = (sb.title || '').replace(/"/g, '\\"');
    const loc = (sb.location || '').replace(/"/g, '\\"');
    const action = (sb.action || '').slice(0, 120).replace(/"/g, '\\"');
    return `  {"shot_number": ${num}, "title": "${title}", "location": "${loc}", "action": "${action}"}`;
  }).join(',\n');

  return `[续写指令 - 第${attempt}次续写]
之前的分镜生成因长度限制在 shot_number ${lastShotNum} 处中断，已生成 ${alreadySaved.length} 个分镜。

━━━ 已生成分镜完整列表（绝对不能重复以下内容）━━━
${allSummary}
━━━ 列表结束 ━━━

以上所有情节均已覆盖，请勿重复。末尾几个分镜详情供衔接参考：
[
${lastCtx}
]

请从 shot_number ${lastShotNum + 1} 继续生成剩余分镜，直至剧本全部场景覆盖完毕。
要求：
- 仅返回新增分镜（JSON数组），shot_number 从 ${lastShotNum + 1} 开始递增
- 格式与之前完全相同，字段保持一致${narrLine}${uniLine}
- 严禁重复已生成列表中的任何情节或场景
- 不要输出任何解释文字，直接输出 JSON

原始剧本与任务说明：
${originalUserPrompt}`;
}

async function processStoryboardGeneration(db, log, cfg, taskId, episodeId, model, style, userPrompt, systemPrompt, includeNarration, universalOmni, targetClipDurationSec = null, durationRange = null) {
  // 增量保存状态放在 try 外，catch 里可用于部分恢复
  const episodeIdNum = Number(episodeId);
  const streamSavedNums = new Set();
  const streamStyle = (style && String(style).trim()) || cfg?.style?.default_style || '';
  const streamVideoRatio = cfg?.style?.default_video_ratio || '16:9';
  // 角色造型映射（#38）：流式增量入库同样需要，否则视频提示词丢失人物外貌
  const streamEpisode = db.prepare('SELECT drama_id FROM episodes WHERE id = ? AND deleted_at IS NULL').get(episodeIdNum);
  const characterAppearances = streamEpisode?.drama_id
    ? buildDramaCharacterAppearanceMap(
        db.prepare('SELECT id, name, appearance FROM characters WHERE drama_id = ? AND deleted_at IS NULL ORDER BY name ASC').all(streamEpisode.drama_id)
      )
    : {};
  const deriveOpts = {
    universalOmni: !!universalOmni,
    // Publish only after the entire result passes speech validation.
    deferPersistence: true,
    durationRange,
    targetClipDuration: targetClipDurationSec != null && Number(targetClipDurationSec) > 0 ? Number(targetClipDurationSec) : null,
    characterAppearances,
  };
  let streamThrottle = 0;

  try {
    taskService.updateTaskStatus(db, taskId, 'processing', 10, '开始生成分镜头...');
    log.info('Processing storyboard generation', { task_id: taskId, episode_id: episodeId });
    log.info('Storyboard prompt preview', {
      user_prompt_len: userPrompt ? userPrompt.length : 0,
      system_prompt_len: systemPrompt ? systemPrompt.length : 0,
      user_prompt_head: userPrompt ? userPrompt.slice(0, 200) : '',
    });
    logDebugStoryboardPrompts(log, `task-${taskId}-initial`, userPrompt, systemPrompt);

    // Keep existing shots visible until validated replacements can be saved atomically.

    // 不使用 json_mode：response_format:json_object 要求返回 JSON 对象而非数组，会导致模型包装成
    // {"storyboards":[...]} 或产生乱码 key，改由 extractFirstArray 统一处理任意包装格式。
    const text = await generateTextForStoryboard(db, log, userPrompt, systemPrompt, {
      model: model || undefined,
      // 每积累约 400 字符触发一次增量解析，尝试提前保存已完成的分镜
      streamCallback: (accumulated) => {
        if (accumulated.length - streamThrottle < 400) return;
        streamThrottle = accumulated.length;
        tryIncrementalSave(db, log, episodeIdNum, accumulated, streamSavedNums, streamStyle, streamVideoRatio, deriveOpts);
        // 同步更新任务进度（根据已保存分镜数量）
        if (streamSavedNums.size > 0) {
          taskService.updateTaskStatus(db, taskId, 'processing', 30,
            `已解析 ${streamSavedNums.size} 个分镜，生成中...`);
        }
      },
    });

    taskService.updateTaskStatus(db, taskId, 'processing', 50, '分镜头生成完成，正在解析结果...');

    log.info('AI raw response received', {
      task_id: taskId,
      text_type: typeof text,
      text_length: text ? String(text).length : 0,
      text_preview: text ? String(text).slice(0, 2000) : '(empty)',
    });

    let storyboards = [];
    const parseMeta = {};
    try {
      const parsed = safeParseAIJSON(text, null, log, parseMeta);
      storyboards = extractFirstArray(parsed) || [];
    } catch (e) {
      log.error('Parse storyboard JSON failed', {
        error: e.message,
        task_id: taskId,
        text_type: typeof text,
        text_length: text ? String(text).length : 0,
        raw_text: text ? String(text).slice(0, 2000) : '(empty)',
      });

      // 解析失败时，若流式增量保存已有部分分镜，视为截断的部分成功
      if (streamSavedNums.size > 0) {
        const partialBoards = getStoryboardsForEpisode(db, episodeIdNum);
        if (partialBoards.length > 0) {
          const totalDuration = partialBoards.reduce((s, sb) => s + (Number(sb.duration) || 0), 0);
          log.warn('Parse failed but partial storyboards already saved incrementally, treating as truncated success', {
            task_id: taskId, recovered_count: partialBoards.length, parse_error: e.message,
          });
          taskService.updateTaskResult(db, taskId, {
            storyboards: partialBoards,
            total: partialBoards.length,
            total_duration: totalDuration,
            duration_minutes: Math.ceil((totalDuration + 59) / 60),
            truncated: true,
            error_message: `AI输出含JSON格式缺陷（${e.message}），已恢复 ${partialBoards.length} 个分镜`,
          });
          return;
        }
      }

      taskService.updateTaskError(db, taskId, '解析分镜头结果失败: ' + (e.message || ''));
      return;
    }

    if (storyboards.length === 0) {
      // 最终解析为空，但流式已保存了内容，同样回退使用增量结果
      if (streamSavedNums.size > 0) {
        const partialBoards = getStoryboardsForEpisode(db, episodeIdNum);
        if (partialBoards.length > 0) {
          const totalDuration = partialBoards.reduce((s, sb) => s + (Number(sb.duration) || 0), 0);
          log.warn('Final parse returned 0 items but incremental saves exist, using those', {
            task_id: taskId, recovered_count: partialBoards.length,
          });
          taskService.updateTaskResult(db, taskId, {
            storyboards: partialBoards,
            total: partialBoards.length,
            total_duration: totalDuration,
            duration_minutes: Math.ceil((totalDuration + 59) / 60),
            truncated: true,
          });
          return;
        }
      }
      log.error('AI returned 0 storyboards', { task_id: taskId });
      taskService.updateTaskError(db, taskId, 'AI生成分镜失败：返回的分镜数量为0');
      return;
    }

    if (parseMeta.truncated) {
      log.warn('Storyboard JSON was truncated by AI (max_tokens limit), will attempt continuation', {
        task_id: taskId, episode_id: episodeId,
        rescued_count: storyboards.length,
        raw_text_length: text ? String(text).length : 0,
      });
    }
    log.info('Storyboard initial parse', { task_id: taskId, episode_id: episodeId, count: storyboards.length, truncated: parseMeta.truncated || false });

    // ── 自动续写：若 AI 输出被截断，最多续写 3 次直到完整 ──────────────────
    const MAX_CONTINUATION = 3;
    let contAttempt = 0;
    while (parseMeta.truncated && storyboards.length > 0 && contAttempt < MAX_CONTINUATION) {
      contAttempt++;
      const lastShot = Math.max(...storyboards.map(s => Number(s.shot_number ?? s.storyboard_number) || 0));
      log.info('Storyboard continuation start', { task_id: taskId, attempt: contAttempt, last_shot: lastShot, current_count: storyboards.length });
      taskService.updateTaskStatus(db, taskId, 'processing', 50 + contAttempt * 5,
        `已生成 ${storyboards.length} 个分镜，正在续写剩余部分（第${contAttempt}次）...`);

      const contPrompt = buildContinuationPrompt(userPrompt, storyboards, lastShot, contAttempt, !!includeNarration, !!universalOmni);
      logDebugStoryboardPrompts(log, `task-${taskId}-continuation-${contAttempt}`, contPrompt, systemPrompt);
      streamThrottle = 0; // 重置节流，让续写段落也能增量保存

      // 等待 3 秒后再发续写请求：避免流式请求刚结束服务端连接未释放导致 "socket hang up"
      await new Promise(r => setTimeout(r, 3000));

      let contText;
      try {
        contText = await generateTextForStoryboard(db, log, contPrompt, systemPrompt, {
          model: model || undefined,
          streamCallback: (accumulated) => {
            if (accumulated.length - streamThrottle < 400) return;
            streamThrottle = accumulated.length;
            tryIncrementalSave(db, log, episodeIdNum, accumulated, streamSavedNums, streamStyle, streamVideoRatio, deriveOpts);
          },
        });
      } catch (e) {
        log.warn('Continuation request failed', { task_id: taskId, attempt: contAttempt, error: e.message });
        break;
      }

      const contMeta = {};
      let contItems = [];
      try {
        const contParsed = safeParseAIJSON(contText, null, log, contMeta);
        contItems = extractFirstArray(contParsed) || [];
      } catch (e) {
        log.warn('Continuation parse failed', { task_id: taskId, attempt: contAttempt, error: e.message });
        break;
      }

      if (contItems.length === 0) {
        log.warn('Continuation returned 0 items', { task_id: taskId, attempt: contAttempt });
        break;
      }

      // 按 shot_number 去重，防止 AI 重复已生成的分镜
      const existingNums = new Set(storyboards.map((s) => normalizeStoryboardShotNumber(s)));
      const newItems = contItems.filter((s) => !existingNums.has(normalizeStoryboardShotNumber(s)));
      if (newItems.length === 0) {
        log.warn('Continuation returned only duplicate items', { task_id: taskId, attempt: contAttempt });
        break;
      }

      storyboards = [...storyboards, ...newItems];
      parseMeta.truncated = contMeta.truncated || false;
      log.info('Storyboard continuation done', {
        task_id: taskId, attempt: contAttempt,
        new_items: newItems.length, total_count: storyboards.length, still_truncated: parseMeta.truncated,
      });
    }
    // ── 续写结束 ────────────────────────────────────────────────────────────

    if (parseMeta.truncated) {
      throw new Error('分镜结果仍不完整，未覆盖原分镜；请重试或减少单次剧本长度');
    }
    const wardrobePlanner=require('./storyboardWardrobeService');
    taskService.updateTaskStatus(db, taskId, 'processing', 63, '正在校验单镜造型，换装按镜头拆分...');
    storyboards=await wardrobePlanner.enforceSingleOutfit(storyboards,{
      db,dramaId:streamEpisode.drama_id,episodeId:episodeIdNum,
      generate:(user,system)=>generateTextForStoryboard(db,log,user,system,{model:model || undefined,temperature:0.2}),
      onRepair:(shot,reason)=>log.info('Splitting costume transition',{task_id:taskId,shot_number:normalizeStoryboardShotNumber(shot),reason}),
    });
    taskService.updateTaskStatus(db, taskId, 'processing', 65, '正在校验对白时长，必要时按语义拆镜...');
    storyboards = await enforceStoryboardSpeechTiming(storyboards, {
      targetDuration: deriveOpts.targetClipDuration,
      durationRange: deriveOpts.durationRange,
      narrativeStyle: cfg.narrative_style,
      generate: (user, system) => generateTextForStoryboard(db, log, user, system, { model: model || undefined, temperature: 0.2 }),
      onRepair: (shot, assessment) => log.info('Splitting over-budget storyboard', {
        task_id: taskId, shot_number: normalizeStoryboardShotNumber(shot),
        duration: assessment.duration, estimated_seconds: assessment.requiredSeconds,
      }),
    });

    storyboards.forEach(shot=>{wardrobePlanner.assertSingleOutfit(shot);wardrobePlanner.validateChoices(db,streamEpisode.drama_id,shot,episodeIdNum);});
    const totalDuration = storyboards.reduce((sum, sb) => sum + (Number(sb.duration) || 0), 0);
    if (parseMeta.truncated) {
      log.warn('Storyboard still truncated after max continuations', {
        task_id: taskId, final_count: storyboards.length, continuation_attempts: contAttempt,
      });
    }
    log.info('Storyboard generated', { task_id: taskId, episode_id: episodeId, count: storyboards.length, total_duration_seconds: totalDuration, truncated: parseMeta.truncated || false, continuation_attempts: contAttempt });

    taskService.updateTaskStatus(db, taskId, 'processing', 70, '正在保存分镜头...');

    // Soft deletion and all inserts roll back together if saving fails.
    const saved = db.transaction(() =>
      saveStoryboards(db, log, episodeId, storyboards, cfg, style, null, deriveOpts)
    )();

    // ── 分镜角色补全（字符串匹配，无 AI，极快）──────────────────────────────────
    taskService.updateTaskStatus(db, taskId, 'processing', 75, '正在校验分镜角色关联...');
    let totalCharAdded = 0;
    for (const sb of saved) {
      if (!sb?.id) continue;
      const { added } = syncStoryboardCharacters(db, log, sb.id);
      totalCharAdded += added.length;
    }
    if (totalCharAdded > 0) {
      log.info('[分镜] 角色补全完成', { episode_id: episodeId, total_added: totalCharAdded });
    }

    taskService.updateTaskStatus(db, taskId, 'processing', 90, '正在更新剧集时长...');

    const durationMinutes = Math.ceil((totalDuration + 59) / 60);
    db.prepare('UPDATE episodes SET duration = ?, updated_at = ? WHERE id = ?').run(durationMinutes, new Date().toISOString(), Number(episodeId));
    log.info('Episode duration updated', { episode_id: episodeId, duration_seconds: totalDuration, duration_minutes: durationMinutes });

    const resultData = {
      storyboards: saved,
      total: saved.length,
      total_duration: totalDuration,
      duration_minutes: durationMinutes,
      truncated: parseMeta.truncated || false,
    };
    taskService.updateTaskResult(db, taskId, resultData);
    log.info('Storyboard generation completed', { task_id: taskId, episode_id: episodeId });
  } catch (err) {
    log.error('Storyboard generation failed', { error: err.message, task_id: taskId });

    // 若连接中断（ECONNRESET 等）但已通过增量流式保存了部分分镜，视为部分成功而非彻底失败
    if (streamSavedNums.size > 0) {
      try {
        const partialBoards = getStoryboardsForEpisode(db, episodeIdNum);
        if (partialBoards.length > 0) {
          const totalDuration = partialBoards.reduce((s, sb) => s + (Number(sb.duration) || 0), 0);
          log.warn('Partial storyboards recovered after error, treating as truncated success', {
            task_id: taskId, recovered_count: partialBoards.length, error: err.message,
          });
          taskService.updateTaskResult(db, taskId, {
            storyboards: partialBoards,
            total: partialBoards.length,
            total_duration: totalDuration,
            duration_minutes: Math.ceil((totalDuration + 59) / 60),
            truncated: true,
            error_message: `连接中断（${err.message}），已恢复 ${partialBoards.length} 个分镜`,
          });
          return;
        }
      } catch (_) {}
    }

    taskService.updateTaskError(db, taskId, (err.message || '生成分镜头失败'));
  }
}

function generateStoryboard(db, log, episodeId, model, style, storyboardCount, videoDuration, aspectRatio, includeNarration, universalOmni, requestedDurationRange) {
  let cfg = loadConfig();
  const episode = db.prepare(
    'SELECT id, script_content, description, drama_id FROM episodes WHERE id = ? AND deleted_at IS NULL'
  ).get(Number(episodeId));
  if (!episode) {
    throw new Error('剧集不存在或无权限访问');
  }

  // 获取剧集风格和比例（如果未指定，则从 drama metadata / style 中获取完整提示词）
  const drama = db.prepare('SELECT style, metadata FROM dramas WHERE id = ?').get(episode.drama_id);
  cfg = require('./narrativeStyleService').withConfig(cfg, drama?.metadata);
  const { resolvedStreamStyleFromDrama } = require('../utils/dramaStyleMerge');
  const finalStyle = resolvedStreamStyleFromDrama(style, drama);

  // 图片比例 + 每镜时长：优先用传入值，再从 drama.metadata 读，最后兜底全局配置
  let dramaAspectRatio = null;
  let videoClipDuration = null;
  let savedDurationRange = null;
  try {
    if (drama && drama.metadata) {
      const meta = typeof drama.metadata === 'string' ? JSON.parse(drama.metadata) : drama.metadata;
      if (meta && meta.aspect_ratio) dramaAspectRatio = meta.aspect_ratio;
      if (meta && meta.shot_duration_range) savedDurationRange = meta.shot_duration_range;
      if (meta && meta.video_clip_duration) videoClipDuration = Number(meta.video_clip_duration) || null;
    }
  } catch (_) {}
  const durationRange = normalizeDurationRange(requestedDurationRange || savedDurationRange, videoClipDuration);
  const imageRatio = aspectRatio || dramaAspectRatio || cfg?.style?.default_video_ratio || '16:9';

  // 计算单镜建议时长（秒）：
  // 项目 metadata 中的 video_clip_duration（如 15 秒/段）优先于「总时长÷镜数」，
  // 否则前端同时传总时长+镜数时会把每镜压成过短（与「每段秒数」配置矛盾）。
  // 无项目配置时再使用总时长÷镜数；再否则 null。
  let effectiveShotDuration = null;
  const impliedFromTotal =
    videoDuration && storyboardCount
      ? Math.round(Number(videoDuration) / Number(storyboardCount))
      : null;
  if (videoClipDuration && Number(videoClipDuration) > 0) {
    effectiveShotDuration = Number(videoClipDuration);
  } else if (impliedFromTotal && impliedFromTotal > 0) {
    effectiveShotDuration = impliedFromTotal;
  } else {
    effectiveShotDuration = null;
  }

  let scriptContent = (episode.script_content && String(episode.script_content).trim())
    ? String(episode.script_content)
    : (episode.description && String(episode.description).trim())
      ? String(episode.description)
      : '';
  if (!scriptContent) {
    throw new Error('剧本内容为空，请先生成剧集内容');
  }

  const characters = db.prepare(
    'SELECT id, name FROM characters WHERE drama_id = ? AND deleted_at IS NULL ORDER BY name ASC'
  ).all(episode.drama_id);
  let characterList = '无角色';
  if (characters.length > 0) {
    characterList = '[' + characters.map((c) => `{"id": ${c.id}, "name": "${(c.name || '').replace(/"/g, '\\"')}"}`).join(', ') + ']';
  }

  const scenes = db.prepare(
    'SELECT id, location, time FROM scenes WHERE drama_id = ? AND deleted_at IS NULL ORDER BY location ASC, time ASC'
  ).all(episode.drama_id);
  let sceneList = '无场景';
  if (scenes.length > 0) {
    sceneList = '[' + scenes.map((s) => `{"id": ${s.id}, "location": "${(s.location || '').replace(/"/g, '\\"')}", "time": "${(s.time || '').replace(/"/g, '\\"')}"}`).join(', ') + ']';
  }

  const props = db.prepare(
    'SELECT id, name, type FROM props WHERE drama_id = ? AND deleted_at IS NULL ORDER BY id ASC'
  ).all(episode.drama_id);
  let propList = '无道具';
  if (props.length > 0) {
    propList = '[' + props.map((p) => `{"id": ${p.id}, "name": "${(p.name || '').replace(/"/g, '\\"')}"${p.type ? `, "type": "${p.type.replace(/"/g, '\\"')}"` : ''}}`).join(', ') + ']';
  }

  const scriptLabel = promptI18n.formatUserPrompt(cfg, 'script_content_label');
  const taskLabel = promptI18n.formatUserPrompt(cfg, 'task_label');
  const taskInstruction = promptI18n.formatUserPrompt(cfg, 'task_instruction');
  
  // 处理分镜数量和时长约束
  let extraConstraint = '';
  // 宽松判断：只要有值（包括字符串形式的数字），就尝试转换并添加约束
  if (storyboardCount) {
    const countVal = Number(storyboardCount);
    if (Number.isFinite(countVal) && countVal > 0) {
      const countLabel = promptI18n.formatUserPrompt(cfg, 'storyboard_count_constraint', countVal);
      if (countLabel) extraConstraint += `\n${countLabel}`;
    }
  }
  if (videoDuration) {
    const durationVal = Number(videoDuration);
    if (Number.isFinite(durationVal) && durationVal > 0) {
      const durationLabel = promptI18n.formatUserPrompt(cfg, 'video_duration_constraint', durationVal);
      if (durationLabel) extraConstraint += `\n${durationLabel}`;
    }
  }
  // 当同时指定总时长和数量时，补充单镜 duration 说明（与项目「每段秒数」一致时勿用总÷镜压短）
  if (!durationRange && storyboardCount && videoDuration && effectiveShotDuration) {
    const isEn = promptI18n.isEnglish(cfg);
    const clipFromProject = videoClipDuration && Number(videoClipDuration) > 0;
    const implied =
      impliedFromTotal && impliedFromTotal > 0 ? impliedFromTotal : Math.round(Number(videoDuration) / Number(storyboardCount));
    if (clipFromProject) {
      const clip = Number(videoClipDuration);
      if (isEn) {
        extraConstraint += `\nEach shot "duration" field: prioritize **~${clip}s per shot** (project clip-length setting); ±1s OK. Total ~${Number(videoDuration)}s and ~${Number(storyboardCount)} shots are overall planning hints—do NOT force every shot to ~${implied}s (total÷count) when it conflicts with the project clip length.`;
      } else {
        extraConstraint += `\n每个镜头的 **duration** 请优先按项目「每段约 **${clip} 秒**」填写（可 ±1 秒微调）。全片总时长约 ${Number(videoDuration)} 秒、镜头数约 ${Number(storyboardCount)} 为整体规划参考，**禁止**为机械凑「总时长÷镜数」（约 ${implied}s）而把每镜普遍写成过短镜头；除非该镜对白与动作为实需的极短镜头。`;
      }
    } else if (isEn) {
      extraConstraint += `\nEach shot target duration: approximately ${effectiveShotDuration}s (= total ${Number(videoDuration)}s ÷ ${Number(storyboardCount)} shots). Set each shot's duration field to this value, adjusting ±1s for dialogue/action length.`;
    } else {
      extraConstraint += `\n每镜头目标时长：约 ${effectiveShotDuration} 秒（= 总时长 ${Number(videoDuration)}s ÷ ${Number(storyboardCount)} 个镜头）。每个镜头的 duration 字段请设为此值，可根据对话/动作长短适当调整 ±1 秒。`;
    }
  }

  log.info('Storyboard generation params', {
    storyboard_count: storyboardCount,
    video_duration: videoDuration,
    video_clip_duration: videoClipDuration,
    effective_shot_duration: effectiveShotDuration,
  });

  const charListLabel = promptI18n.formatUserPrompt(cfg, 'character_list_label');
  const charConstraint = promptI18n.formatUserPrompt(cfg, 'character_constraint');
  const sceneListLabel = promptI18n.formatUserPrompt(cfg, 'scene_list_label');
  const sceneConstraint = promptI18n.formatUserPrompt(cfg, 'scene_constraint');
  const propListLabel = promptI18n.formatUserPrompt(cfg, 'prop_list_label');
  const propConstraint = promptI18n.formatUserPrompt(cfg, 'prop_constraint');
  const suffix = promptI18n.getStoryboardUserPromptSuffix(cfg, durationRange ? null : effectiveShotDuration);

  let userPrompt =
    `${scriptLabel}\n${scriptContent}\n\n${taskLabel}\n${taskInstruction}${extraConstraint}\n\n${charListLabel}\n${characterList}\n\n${charConstraint}\n\n${sceneListLabel}\n${sceneList}\n\n${sceneConstraint}\n\n${propListLabel}\n${propList}\n\n${propConstraint}\n\n${suffix}`;

  const wantNarration = includeNarration === true || includeNarration === 1 || String(includeNarration).toLowerCase() === 'true';
  if (wantNarration) {
    userPrompt += promptI18n.getStoryboardNarrationExtraInstructions(cfg);
  }

  let systemPrompt = promptI18n.getStoryboardSystemPrompt(cfg);
  const wardrobe = require('./narrativeStyleService').parse(drama?.metadata).wardrobe;
  if (wardrobe?.characters) systemPrompt += '\n本剧已审核的默认服装 / Approved base costumes: '+JSON.stringify(wardrobe.characters);
  systemPrompt += require('./wardrobeService').planningContext(db,episode.drama_id);

  // Shot count is a planning target; speech completeness and timing take precedence.
  if (storyboardCount && Number(storyboardCount) > 0) {
    const targetCount = Number(storyboardCount);
    const isEn = systemPrompt.includes('[Role]');
    if (isEn) {
      systemPrompt += `\n\n[USER REQUESTED SHOT COUNT]
Aim for ${targetCount} shots (±10%) where the speech timing budget allows.
Merge related actions or split key moments while preserving complete dialogue and narration.
If words cannot fit, increase the shot count rather than omit words, rush speech, or inflate each clip's duration.`;
    } else {
      systemPrompt += `\n\n【目标分镜数量】
尽量生成 ${targetCount} 个分镜（允许 ±10% 偏差），前提是对白与旁白能在镜头预算内完整说完。
可合并相关连续动作或拆分关键情节；若台词超时，必须按语义增加镜头，禁止为凑镜数删字、加速对白或擅自拉长每段时长。`;
    }
  }

  const wantUniversalOmni =
    universalOmni === true ||
    universalOmni === 1 ||
    String(universalOmni || '').toLowerCase() === 'true';
  if (wantUniversalOmni) {
    systemPrompt += promptI18n.getStoryboardUniversalOmniModeSuffix(cfg);
  }

  // Keep comprehension, speech separation and the narration option consistent across modes/overrides.
  systemPrompt += promptI18n.getStoryboardNarrationModeInstructions(cfg, wantNarration);

  // Append after custom/mode/count prompts so timing and full dialogue take precedence.
  systemPrompt += rangeTimingInstructions(durationRange || {min:effectiveShotDuration,max:effectiveShotDuration},cfg.narrative_style);

  const task = taskService.createTask(db, log, 'storyboard_generation', String(episodeId));
  log.info('Generating storyboard asynchronously', {
    task_id: task.id,
    episode_id: episodeId,
    drama_id: episode.drama_id,
    script_length: scriptContent.length,
    character_count: characters.length,
    scene_count: scenes.length,
    storyboard_count: storyboardCount,
    video_duration: videoDuration,
    universal_omni_storyboard: wantUniversalOmni,
  });

  setImmediate(() => {
    // 传入 imageRatio 同时覆盖 default_video_ratio 和 default_image_ratio，
    // 确保分镜图/视频提示词、场景提取提示词都使用项目设定的比例
    const runCfg = { ...cfg, style: { ...(cfg?.style || {}), default_video_ratio: imageRatio, default_image_ratio: imageRatio } };
    // 如果 model 为 null，则传 undefined，让 generateText 内部去兜底找默认配置
    const clipSec =
      videoClipDuration && Number(videoClipDuration) > 0 ? Number(videoClipDuration) : null;
    processStoryboardGeneration(
      db,
      log,
      runCfg,
      task.id,
      String(episodeId),
      model || undefined,
      finalStyle,
      userPrompt,
      systemPrompt,
      wantNarration,
      wantUniversalOmni,
      durationRange ? null : clipSec,
      durationRange
    );
  });

  return { task_id: task.id, status: 'pending', message: '分镜生成任务已创建，正在后台处理...' };
}


/**
 * 分镜绑定角色的 id 列表（#38）。
 * 权威顺序与 universalSegmentPromptBundle 一致：storyboards.characters JSON → storyboard_characters 关联表。
 */
function loadStoryboardCharacterIds(db, storyboardId) {
  const sid = Number(storyboardId);
  if (!Number.isFinite(sid) || sid <= 0) return [];
  const ids = [];
  let usedExplicit = false;
  try {
    const sbRow = db.prepare('SELECT characters FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(sid);
    if (sbRow && sbRow.characters != null && String(sbRow.characters).trim() !== '') {
      const parsed = JSON.parse(sbRow.characters);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item != null && typeof item === 'object' && item.id != null) ids.push(Number(item.id));
          else if (typeof item === 'number' || (typeof item === 'string' && /^\d+$/.test(item))) ids.push(Number(item));
        }
        usedExplicit = ids.length > 0;
      }
    }
  } catch (_) {}
  if (!usedExplicit) {
    try {
      const links = db.prepare('SELECT character_id FROM storyboard_characters WHERE storyboard_id = ? ORDER BY id ASC').all(sid);
      for (const link of links) ids.push(Number(link.character_id));
    } catch (_) {}
  }
  return [...new Set(ids.filter((n) => Number.isFinite(n) && n > 0))];
}

/** 按 id 列表读取角色造型：本剧 characters 优先，缺失时回退角色库 character_libraries */
function loadCharacterAppearanceRows(db, ids) {
  const uniq = [...new Set((ids || []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  if (uniq.length === 0) return [];
  const placeholders = uniq.map(() => '?').join(',');
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT id, name, appearance FROM characters WHERE id IN (${placeholders}) AND deleted_at IS NULL`
    ).all(...uniq);
  } catch (_) {
    rows = [];
  }
  if (rows.length === 0) {
    try {
      rows = db.prepare(
        `SELECT id, name, description AS appearance FROM character_libraries WHERE id IN (${placeholders}) AND deleted_at IS NULL`
      ).all(...uniq);
    } catch (_) {
      rows = [];
    }
  }
  return rows;
}

/**
 * 分镜角色造型文本（#38）：每行一个角色，无造型信息的角色跳过。
 * 供视频提示词注入，修复「主角已指定造型但每次生成视频形象随机」。
 */
function buildCharacterAppearanceText(db, storyboardId) {
  const rows = loadCharacterAppearanceRows(db, loadStoryboardCharacterIds(db, storyboardId));
  const lines = [];
  const seen = new Set();
  for (const r of rows) {
    const appearance = String(r.appearance || '').trim();
    if (!appearance) continue;
    const name = String(r.name || '').trim();
    const key = name || `#${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(name ? `「${name}」${appearance}` : appearance);
  }
  return lines.join('\n');
}

function rebuildVideoPromptForStoryboard(db, log, storyboardId) {
  const sbId = Number(storyboardId);
  if (!Number.isFinite(sbId) || sbId <= 0) return null;

  const row = db.prepare(
    `SELECT s.*, e.drama_id
     FROM storyboards s
     JOIN episodes e ON e.id = s.episode_id AND e.deleted_at IS NULL
     WHERE s.id = ? AND s.deleted_at IS NULL`
  ).get(sbId);
  if (!row) return null;

  const loadConfig = require('../config').loadConfig;
  const cfg = loadConfig();
  const drama = row.drama_id
    ? db.prepare('SELECT style, metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(row.drama_id)
    : null;
  const { resolvedStreamStyleFromDrama } = require('../utils/dramaStyleMerge');
  const finalStyle = resolvedStreamStyleFromDrama('', drama) || cfg?.style?.default_style || '';

  let dramaAspectRatio = null;
  try {
    if (drama?.metadata) {
      const meta = typeof drama.metadata === 'string' ? JSON.parse(drama.metadata) : drama.metadata;
      if (meta?.aspect_ratio) dramaAspectRatio = meta.aspect_ratio;
    }
  } catch (_) {}

  const videoRatio = dramaAspectRatio || cfg?.style?.default_video_ratio || '16:9';

  const characterAppearances = buildCharacterAppearanceText(db, sbId);

  const sbForPrompt = {
    ...row,
    character_appearances: characterAppearances,
  };

  const { synthesizeVideoSlots, compileVideoPromptFromSlots } = require('../ontology/videoSlots');
  let videoSlots = row.video_slots;
  if (typeof videoSlots === 'string') {
    try { videoSlots = JSON.parse(videoSlots); } catch (_) { videoSlots = null; }
  }
  const charsForVid = db.prepare('SELECT id, name FROM characters WHERE drama_id = ? AND deleted_at IS NULL').all(row.drama_id || 0);
  if (!videoSlots || typeof videoSlots !== 'object' || !videoSlots.camera || !videoSlots.audio_lip_sync) {
    videoSlots = synthesizeVideoSlots(row, charsForVid);
  }

  const videoPrompt = compileVideoPromptFromSlots(sbForPrompt, videoSlots, { style: finalStyle, videoRatio });
  const now = new Date().toISOString();
  try {
    db.prepare('UPDATE storyboards SET video_prompt = ?, video_slots = ?, updated_at = ? WHERE id = ?').run(videoPrompt, JSON.stringify(videoSlots), now, sbId);
  } catch (err) {
    if ((err.message || '').includes('video_slots')) {
      db.prepare('UPDATE storyboards SET video_prompt = ?, updated_at = ? WHERE id = ?').run(videoPrompt, now, sbId);
    } else {
      throw err;
    }
  }

  if (log?.info) {
    log.info('[分镜] 已按最新视频语义槽位契约重建 video_prompt 与 video_slots', {
      id: sbId,
      len: videoPrompt.length,
      has_character_appearances: !!characterAppearances,
    });
  }

  const storyboardService = require('./storyboardService');
  return storyboardService.getStoryboardById(db, sbId);
}

function rebuildPromptsForStoryboard(db, log, storyboardId) {
  const sbId = Number(storyboardId);
  if (!Number.isFinite(sbId) || sbId <= 0) return null;

  const row = db.prepare(
    `SELECT s.*, e.drama_id
     FROM storyboards s
     JOIN episodes e ON e.id = s.episode_id AND e.deleted_at IS NULL
     WHERE s.id = ? AND s.deleted_at IS NULL`
  ).get(sbId);
  if (!row) return null;

  const loadConfig = require('../config').loadConfig;
  const cfg = loadConfig();
  const drama = row.drama_id
    ? db.prepare('SELECT style, metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(row.drama_id)
    : null;
  const { resolvedStreamStyleFromDrama } = require('../utils/dramaStyleMerge');
  const finalStyle = resolvedStreamStyleFromDrama('', drama) || cfg?.style?.default_style || '';

  // 0. 槽位完整性检查与自动补全：若未持久化 character_visuals 或提示词有缺陷，调用智能槽位合成器更新
  const chars = db.prepare('SELECT id, name FROM characters WHERE drama_id = ? AND deleted_at IS NULL').all(row.drama_id || 0);
  const { synthesizeCharacterVisualSlots, synthesizeLastFrameVisualSlots, validateCharacterVisualSlots } = require('../ontology/visualSlots');

  let charVisuals = row.character_visuals;
  if (typeof charVisuals === 'string') {
    try { charVisuals = JSON.parse(charVisuals); } catch (_) { charVisuals = null; }
  }
  const hasInvalidSlots = !Array.isArray(charVisuals) || charVisuals.length === 0 || validateCharacterVisualSlots(row, charVisuals).length > 0;
  if (hasInvalidSlots || isFlawedImagePrompt(row.image_prompt)) {
    charVisuals = synthesizeCharacterVisualSlots(row, chars);
    try {
      db.prepare('UPDATE storyboards SET character_visuals = ? WHERE id = ?').run(JSON.stringify(charVisuals), sbId);
      row.character_visuals = charVisuals;
    } catch (_) {}
  }

  // 0.1 尾帧槽位补齐
  let lastFrameVisuals = row.last_frame_visuals;
  if (typeof lastFrameVisuals === 'string') {
    try { lastFrameVisuals = JSON.parse(lastFrameVisuals); } catch (_) { lastFrameVisuals = null; }
  }
  if (!Array.isArray(lastFrameVisuals) || lastFrameVisuals.length === 0) {
    lastFrameVisuals = synthesizeLastFrameVisualSlots(row, chars, charVisuals);
    try {
      db.prepare('UPDATE storyboards SET last_frame_visuals = ? WHERE id = ?').run(JSON.stringify(lastFrameVisuals), sbId);
      row.last_frame_visuals = lastFrameVisuals;
    } catch (_) {}
  }

  // 1. 若 image_prompt 为空或存在截断残片/时序动态动词，按静态定格规则自动重构
  let imagePrompt = (row.image_prompt || '').trim();
  if (!imagePrompt || isFlawedImagePrompt(imagePrompt)) {
    imagePrompt = generateImagePrompt(row, finalStyle);
  } else {
    imagePrompt = sanitizeStaticImagePrompt(imagePrompt, row, finalStyle);
  }
  let polishedPrompt = (row.polished_prompt || '').trim();
  if (!polishedPrompt || isFlawedImagePrompt(polishedPrompt)) {
    polishedPrompt = imagePrompt;
  } else {
    polishedPrompt = sanitizeStaticImagePrompt(polishedPrompt, row, finalStyle);
  }

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE storyboards
     SET image_prompt = ?,
         polished_prompt = ?,
         updated_at = ?
     WHERE id = ?`
  ).run(imagePrompt, polishedPrompt, now, sbId);

  // 2. 重建并补齐 video_prompt
  rebuildVideoPromptForStoryboard(db, log, sbId);

  const storyboardService = require('./storyboardService');
  return storyboardService.getStoryboardById(db, sbId);
}

function rebuildPromptsForEpisode(db, log, episodeId) {
  const epId = Number(episodeId);
  if (!Number.isFinite(epId) || epId <= 0) return 0;
  const rows = db.prepare(
    'SELECT id FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL ORDER BY storyboard_number ASC'
  ).all(epId);
  let count = 0;
  for (const r of rows) {
    try {
      rebuildPromptsForStoryboard(db, log, r.id);
      count++;
    } catch (err) {
      if (log?.warn) log.warn('[分镜] 重建提示词失败', { id: r.id, error: err.message });
    }
  }
  return count;
}

function copyStoryboardAssetLinks(db, fromSbId, toSbId) {
  const from = Number(fromSbId);
  const to = Number(toSbId);
  const now = new Date().toISOString();
  try {
    const chars = db.prepare('SELECT character_id FROM storyboard_characters WHERE storyboard_id = ?').all(from);
    const insC = db.prepare(
      'INSERT OR IGNORE INTO storyboard_characters (storyboard_id, character_id, created_at) VALUES (?, ?, ?)'
    );
    for (const c of chars) insC.run(to, c.character_id, now);
  } catch (_) {}
  try {
    const props = db.prepare('SELECT prop_id FROM storyboard_props WHERE storyboard_id = ?').all(from);
    const insP = db.prepare('INSERT OR IGNORE INTO storyboard_props (storyboard_id, prop_id) VALUES (?, ?)');
    for (const p of props) insP.run(to, p.prop_id);
  } catch (_) {}
}

function durationForSplitSegment(type, text) {
  const w = charSpeechWeight(text);
  if (type === 'narration') return Math.min(12, Math.max(6, Math.round(w + 2)));
  return Math.min(10, Math.max(5, Math.round(w)));
}

function buildSplitPlansFromStoryboard(row) {
  const dialogueEntries = parseDialogueToEntries(row.dialogue);
  const narrationText = row.narration != null ? String(row.narration).trim() : '';
  const segmentCount = dialogueEntries.length + (narrationText ? 1 : 0);
  if (segmentCount < 2) {
    throw new Error('当前分镜仅有一段对白或旁白，无需拆镜');
  }
  if (dialogueEntries.length === 0 && narrationText) {
    throw new Error('仅有旁白无法按对白拆镜');
  }

  const allSpeakers = dialogueEntries.map((d) => d.speaker).filter(Boolean);
  const plans = [];

  for (const { speaker, text } of dialogueEntries) {
    const who = speaker || '角色';
    const others = allSpeakers.filter((n) => n && n !== who);
    const closed = others.length ? others.join('、') : '对方';
    const isReporter = /记者/.test(who) || who === '小雅';
    plans.push({
      type: 'dialogue',
      speaker: who,
      dialogue: `${who}：${text}`,
      narration: null,
      title: `${(row.title || '分镜').trim()}·${who}对白`,
      duration: durationForSplitSegment('dialogue', text),
      action: isReporter
        ? `采访场景，${who}面向对方发问，仅${who}开口说话，${closed}闭口聆听无口型。`
        : `镜头聚焦${who}，仅${who}开口对口型说话，${closed}全程闭口无口型。`,
      result: isReporter ? `${closed}保持静默聆听。` : `${who}完成台词，情绪鲜明。`,
      shot_type: isReporter ? row.shot_type || '中景' : '近景',
      movement: isReporter ? row.movement || '固定' : '推镜',
    });
  }

  if (narrationText) {
    const focus =
      inferPrimaryOnScreenCharacter(
        { action: row.action, result: row.result, title: row.title, dialogue: row.dialogue },
        allSpeakers
      ) || allSpeakers[allSpeakers.length - 1] || '角色';
    plans.push({
      type: 'narration',
      speaker: null,
      dialogue: null,
      narration: narrationText,
      title: `${(row.title || '分镜').trim()}·画外旁白`,
      duration: durationForSplitSegment('narration', narrationText),
      action: `${focus}在画面中保持静止，双唇闭合，无口型，听画外纪录片旁白。`,
      result: `${focus}表情维持强硬自信，无唇动。`,
      shot_type: '近景',
      movement: row.movement || '固定',
    });
  }

  return plans;
}

function persistSplitStoryboardRow(db, episodeId, storyboardNumber, baseRow, plan, now) {
  const info = db.prepare(
    `INSERT INTO storyboards (
      episode_id, scene_id, storyboard_number, title, description, layout_description,
      location, time, duration, dialogue, narration, action, result, atmosphere,
      image_prompt, characters, shot_type, angle, angle_h, angle_v, angle_s,
      movement, lighting_style, depth_of_field, segment_index, segment_title,
      creation_mode, universal_segment_text, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).run(
    episodeId,
    baseRow.scene_id ?? null,
    storyboardNumber,
    plan.title,
    baseRow.description ?? null,
    baseRow.layout_description ?? null,
    baseRow.location ?? null,
    baseRow.time ?? null,
    plan.duration,
    plan.dialogue,
    plan.narration,
    plan.action,
    plan.result,
    baseRow.atmosphere ?? null,
    baseRow.image_prompt ?? null,
    baseRow.characters ?? null,
    plan.shot_type ?? baseRow.shot_type ?? null,
    baseRow.angle ?? null,
    baseRow.angle_h ?? null,
    baseRow.angle_v ?? null,
    baseRow.angle_s ?? null,
    plan.movement ?? baseRow.movement ?? null,
    baseRow.lighting_style ?? null,
    baseRow.depth_of_field ?? null,
    baseRow.segment_index ?? null,
    baseRow.segment_title ?? null,
    baseRow.creation_mode === 'universal' ? 'universal' : 'classic',
    null,
    now,
    now
  );
  return info.lastInsertRowid;
}

function updateStoryboardAsSplitSegment(db, sbId, baseRow, plan, now) {
  db.prepare(
    `UPDATE storyboards SET
      title = ?, duration = ?, dialogue = ?, narration = ?, action = ?, result = ?,
      shot_type = ?, movement = ?, universal_segment_text = NULL,
      video_prompt = NULL, video_url = NULL, audio_local_path = NULL,
      narration_audio_local_path = NULL, status = 'pending', updated_at = ?
     WHERE id = ? AND deleted_at IS NULL`
  ).run(
    plan.title,
    plan.duration,
    plan.dialogue,
    plan.narration,
    plan.action,
    plan.result,
    plan.shot_type ?? baseRow.shot_type ?? null,
    plan.movement ?? baseRow.movement ?? null,
    now,
    sbId
  );
}

/**
 * 按对白/旁白拆成多条分镜（每条仅一人说话或仅旁白），解决多角色同镜串音。
 * @returns {{ source_id, storyboard_ids, created_count, plans_summary }}
 */
function splitStoryboardByAudio(db, log, storyboardId) {
  const sbId = Number(storyboardId);
  if (!Number.isFinite(sbId) || sbId <= 0) throw new Error('无效的分镜 id');

  const row = db
    .prepare('SELECT * FROM storyboards WHERE id = ? AND deleted_at IS NULL')
    .get(sbId);
  if (!row) throw new Error('分镜不存在');

  const plans = buildSplitPlansFromStoryboard(row);
  const extraCount = plans.length - 1;
  const now = new Date().toISOString();
  const episodeId = row.episode_id;
  const baseNumber = Number(row.storyboard_number) || 0;

  if (extraCount > 0) {
    db.prepare(
      `UPDATE storyboards SET storyboard_number = storyboard_number + ?, updated_at = ?
       WHERE episode_id = ? AND storyboard_number > ? AND deleted_at IS NULL`
    ).run(extraCount, now, episodeId, baseNumber);
  }

  const storyboardIds = [];
  updateStoryboardAsSplitSegment(db, sbId, row, plans[0], now);
  storyboardIds.push(sbId);

  for (let i = 1; i < plans.length; i++) {
    const newNum = baseNumber + i;
    const newId = persistSplitStoryboardRow(db, episodeId, newNum, row, plans[i], now);
    copyStoryboardAssetLinks(db, sbId, newId);
    storyboardIds.push(newId);
  }

  for (const id of storyboardIds) {
    rebuildVideoPromptForStoryboard(db, log, id);
  }

  const summary = plans.map((p) => `${p.duration}s ${p.title}`).join('；');
  if (log?.info) {
    log.info('[分镜] 按对白拆镜完成', { source_id: sbId, storyboard_ids: storyboardIds, plans: summary });
  }

  const storyboardService = require('./storyboardService');
  return {
    source_id: sbId,
    storyboard_ids: storyboardIds,
    created_count: extraCount,
    plans_summary: summary,
    storyboards: storyboardIds.map((id) => storyboardService.getStoryboardById(db, id)),
  };
}

module.exports = {
  processStoryboardGeneration,
  normalizeStoryboardShotNumber,
  dedupeStoryboardRowsByNumber,
  getStoryboardsForEpisode,
  generateStoryboard,
  extractStaticFreezeFramePose,
  extractInitialPose,
  isFlawedImagePrompt,
  sanitizeStaticImagePrompt,
  /** 与分镜入库时一致的「图片提示词」拼装 */
  composeStoryboardImagePrompt: generateImagePrompt,
  /** 尾帧确定性提示词拼装（首尾帧模式） */
  generateLastFramePrompt,
  /** 与分镜入库时一致的「视频提示词」拼装（供经典模式润色等复用） */
  composeStoryboardVideoPrompt: generateVideoPrompt,
  /** AI 分镜对象的入库字段计算（含角色造型注入，供测试与复用） */
  deriveStoryboardFieldsFromAi,
  /** 批量入库（与后台任务同一 deriveOpts 通道，供测试与复用） */
  saveStoryboards,
  rebuildVideoPromptForStoryboard,
  rebuildPromptsForStoryboard,
  rebuildPromptsForEpisode,
  splitStoryboardByAudio,
  copyStoryboardAssetLinks,
};
