/**
 * 影视世界观实体本体统一抽取服务（Ontology Entity Extraction Agent）
 * 贯穿【剧本 ➔ 角色 ➔ 道具 ➔ 场景空间】全流程：
 * - 提取具名角色并绑定身份锚点（Identity Anchors）
 * - 提取关键道具并强制注入时代与物理尺度锚点（Physical Scale Anchors）
 * - 提取场景并分析空间地标（Spatial Landmarks）与声学光照
 * - 经 SHACL 风格门禁校验合格后原子化入库
 */

const { safeParseAIJSON, extractFirstArray } = require('../utils/safeJson');
const aiClient = require('../services/aiClient');
const { checkPropEraAndScale } = require('./invariants');
const { isAssetObsolete } = require('./assetMatcher');

/**
 * 从剧本中一次性结构化抽取全量本体资产（角色、道具、场景）
 * @param {object} db - SQLite 数据库
 * @param {object} log - 日志记录器
 * @param {object} cfg - 全局配置
 * @param {number|string} episodeId - 剧集 ID
 * @returns {Promise<{ characters: Array, scenes: Array, props: Array, revision: string }>}
 */
async function extractAllEntitiesFromScript(db, log, cfg, episodeId) {
  const epId = Number(episodeId);
  const ep = db.prepare('SELECT id, drama_id, script_content, title FROM episodes WHERE id = ? AND deleted_at IS NULL').get(epId);
  if (!ep) throw new Error('剧集不存在');
  if (!ep.script_content || !ep.script_content.trim()) throw new Error('剧本内容为空，无法提取实体');

  const drama = db.prepare('SELECT id, title, genre, style FROM dramas WHERE id = ? AND deleted_at IS NULL').get(ep.drama_id) || {};

  // 1. 判定时代世界观
  const text = `${drama.title || ''} ${drama.genre || ''} ${drama.style || ''} ${ep.script_content}`.toLowerCase();
  const isAncient = /古装|古风|武侠|仙侠|大明|大唐|汉服/.test(text);
  const dramaEra = isAncient ? 'ancient' : (/民国/.test(text) ? 'republic_china' : (/赛博|科幻/.test(text) ? 'sci_fi' : 'modern'));

  const prompt = `你是一位严谨的影视世界观与本体知识设计师。
请阅读以下剧本，按照【短剧影视视听本体】标准，一次性抽取出该集出现的所有核心资产：角色（Characters）、关键道具（Props）、空间场景（Scenes）。

【世界观时代】：${dramaEra}（${isAncient ? '古装/古风世界观：严禁出现手机、电脑、现代工业品' : '现代/通用世界观'}）
【剧名】：${drama.title || '短剧'}
【剧本内容】：
${ep.script_content}

【抽取硬性规则】：
1. **角色(characters)**：提取所有有台词或关键动作的具体人物。写出 name, gender(男/女), role(身份如干员/侦察兵/母亲), appearance(具体外貌特征，五官/发型/体型，不少于30字), personality(性格关键词)。
2. **道具(props)**：提取剧中有物理交互、关键情节作用的物体（如武器、情报箱、药剂包、信件、案几）。
   - **强制要求 physical_scale**：必须给出具体的真实物理尺度（如“长约45cm的手提密码箱”、“高度约75cm的木案”），并标明“次要环境小物件，绝不可夸大夺焦”。
   - **时代约束**：${isAncient ? '严禁出现任何现代物品！' : '符合时代常理。'}
   - **参考图多视图智能规划(reference_image_mode & reason)**：
     - 若为剧情核心主武器、复杂几何结构或需全方位展示的物体，选 "quad_grid"（四视图）；
     - 若为单一视角小件或次要道具，选 "single"（单图，优先保证高清晰度）；
     - 给出 reference_image_reason 简明推荐理由。
3. **场景(scenes)**：提取剧情发生的独立物理空间。
   - 写出 location(地点名，如仓库掩体区/家庭书房), time(时间与光照，如黄昏金光/深夜冷光), landmarks(场景内地标数组，如 ["doorway", "cover", "desk", "window"]), lighting_style(侧光/柔光/夜景/戏剧光等)。
   - **参考图多视图智能规划(reference_image_mode & reason)**：
     - 若为反复出场的常驻复杂多机位主场景（需要多方向视角与家具陈设一致性），选 "quad_grid"（四视图）；
     - 若为一次性过场场地或简单外景，选 "single"（单图，优先保障景深与大景别画质）；
     - 给出 reference_image_reason 简明推荐理由。

【输出格式】：只输出纯 JSON 对象，格式如下：
{
  "characters": [
    { "name": "...", "gender": "...", "role": "...", "appearance": "...", "personality": "..." }
  ],
  "props": [
    { "name": "...", "type": "武器/装备/证物/日常", "physical_scale": "长约40cm，次要环境物件", "reference_image_mode": "single或quad_grid", "reference_image_reason": "...", "description": "..." }
  ],
  "scenes": [
    { "location": "...", "time": "...", "landmarks": ["doorway", "cover"], "lighting_style": "dramatic", "reference_image_mode": "single或quad_grid", "reference_image_reason": "..." }
  ]
}`;

  log.info('[本体提取] 开始抽取全量剧目本体实体', { episode_id: epId, era: dramaEra });
  const rawResponse = await aiClient.generateText(db, log, 'text', prompt, '', { max_tokens: 4000 });
  const parsed = safeParseAIJSON(rawResponse, null, log);

  const rawCharacters = Array.isArray(parsed?.characters) ? parsed.characters : [];
  const rawProps = Array.isArray(parsed?.props) ? parsed.props : [];
  const rawScenes = Array.isArray(parsed?.scenes) ? parsed.scenes : [];

  // 2. 运行道具时代约束硬门禁
  const propViolations = checkPropEraAndScale(rawProps, dramaEra);
  const fatalErrors = propViolations.filter(v => v.severity === 'error');
  if (fatalErrors.length > 0) {
    log.warn('[本体提取] 发现道具时代穿帮硬门禁违规', { violations: fatalErrors });
  }

  // 3. 过滤并入库入表（保持幂等与复用）
  const now = new Date().toISOString();
  const savedCharacters = [];
  const savedScenes = [];
  const savedProps = [];

  // 写入 characters 表
  for (const c of rawCharacters) {
    if (!c.name) continue;
    let exist = db.prepare('SELECT * FROM characters WHERE drama_id = ? AND name = ? AND deleted_at IS NULL').get(ep.drama_id, c.name);
    if (!exist) {
      const ins = db.prepare(`
        INSERT INTO characters (drama_id, name, gender, role, appearance, description, personality, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(ep.drama_id, c.name, c.gender || '未知', c.role || '', c.appearance || '', c.appearance || '', c.personality || '', now, now);
      exist = db.prepare('SELECT * FROM characters WHERE id = ?').get(ins.lastInsertRowid);
    }
    savedCharacters.push(exist);
  }

  // 写入 scenes 表（含 Agent 视图模式规划）
  for (const s of rawScenes) {
    if (!s.location) continue;
    let exist = db.prepare('SELECT * FROM scenes WHERE drama_id = ? AND location = ? AND deleted_at IS NULL').get(ep.drama_id, s.location);
    const mode = s.reference_image_mode === 'quad_grid' ? 'quad_grid' : 'single';
    const reason = s.reference_image_reason || (mode === 'quad_grid' ? '智能体建议：常驻核心多功能区域，需四视图保持多机位空间一致' : '智能体建议：单图优先保障景深纵深与整体光影层次');
    if (!exist) {
      const promptText = `${s.location}，${s.time}，${s.lighting_style || '写实光影'}，纯真实环境无人物，电影质感`;
      const ins = db.prepare(`
        INSERT INTO scenes (drama_id, location, time, prompt, reference_image_mode, reference_image_recommendation, reference_image_reason, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(ep.drama_id, s.location, s.time || '日景', promptText, mode, mode, reason, now, now);
      exist = db.prepare('SELECT * FROM scenes WHERE id = ?').get(ins.lastInsertRowid);
    } else {
      db.prepare(`UPDATE scenes SET reference_image_recommendation = ?, reference_image_reason = ? WHERE id = ?`).run(mode, reason, exist.id);
    }
    savedScenes.push(exist);
  }

  // 写入 props 表（含 Agent 视图模式规划与真实物理尺度）
  for (const p of rawProps) {
    if (!p.name) continue;
    let exist = db.prepare('SELECT * FROM props WHERE drama_id = ? AND name = ? AND deleted_at IS NULL').get(ep.drama_id, p.name);
    const mode = p.reference_image_mode === 'quad_grid' ? 'quad_grid' : 'single';
    const reason = p.reference_image_reason || (mode === 'quad_grid' ? '智能体建议：主要剧情物件，需四视图展现几何结构' : '智能体建议：单图优先保障道具细节与材质清晰度');
    if (!exist) {
      const promptText = `特写单体道具：${p.name}，${p.physical_scale || '正常尺寸'}，纯色无杂乱背景，高清真实摄影`;
      const ins = db.prepare(`
        INSERT INTO props (drama_id, name, type, description, physical_scale, prompt, image_prompt, reference_image_mode, reference_image_recommendation, reference_image_reason, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(ep.drama_id, p.name, p.type || '日常用品', p.description || '', p.physical_scale || '正常尺寸', promptText, promptText, mode, mode, reason, now, now);
      exist = db.prepare('SELECT * FROM props WHERE id = ?').get(ins.lastInsertRowid);
    } else {
      db.prepare(`UPDATE props SET physical_scale = COALESCE(NULLIF(physical_scale, ''), ?), reference_image_recommendation = ?, reference_image_reason = ? WHERE id = ?`).run(p.physical_scale || '正常尺寸', mode, reason, exist.id);
    }
    savedProps.push(exist);
  }

  // 4. 智能体世界观诊断：检测已存在但最新剧本中已无提及的“过时/孤儿资产”，建议删除
  // 必须综合全剧所有集剧本与分镜引用，且当前刚提取/更新的资产绝不可诊断为过时
  const obsoleteAssets = [];
  const episodes = db.prepare('SELECT script_content FROM episodes WHERE drama_id = ? AND deleted_at IS NULL').all(ep.drama_id);
  const fullDramaScript = episodes.map(e => e.script_content || '').filter(Boolean).join('\n') || (ep.script_content || '');
  const dramaShots = db.prepare(`
    SELECT s.id, s.scene_id, s.characters, sp.prop_id
    FROM storyboards s
    JOIN episodes e ON e.id = s.episode_id
    LEFT JOIN storyboard_props sp ON sp.storyboard_id = s.id
    WHERE e.drama_id = ? AND s.deleted_at IS NULL
  `).all(ep.drama_id);

  const savedCharIds = new Set(savedCharacters.map(c => Number(c.id)));
  const savedSceneIds = new Set(savedScenes.map(s => Number(s.id)));
  const savedPropIds = new Set(savedProps.map(p => Number(p.id)));

  const allDramaChars = db.prepare('SELECT id, name, created_at FROM characters WHERE drama_id = ? AND deleted_at IS NULL').all(ep.drama_id);
  const allDramaProps = db.prepare('SELECT id, name, created_at FROM props WHERE drama_id = ? AND deleted_at IS NULL').all(ep.drama_id);
  const allDramaScenes = db.prepare('SELECT id, location, created_at FROM scenes WHERE drama_id = ? AND deleted_at IS NULL').all(ep.drama_id);

  for (const ec of allDramaChars) {
    if (savedCharIds.has(Number(ec.id))) continue;
    if (isAssetObsolete('character', ec, { script: fullDramaScript, shots: dramaShots })) {
      obsoleteAssets.push({
        type: 'character',
        id: ec.id,
        name: ec.name,
        typeLabel: '角色',
        reason: `角色「${ec.name}」在全剧最新剧本与分镜中未见任何出场或台词，疑似废弃或剧情调整后的残留，建议删除。`,
      });
    }
  }

  for (const ep_item of allDramaProps) {
    if (savedPropIds.has(Number(ep_item.id))) continue;
    if (isAssetObsolete('prop', ep_item, { script: fullDramaScript, shots: dramaShots })) {
      obsoleteAssets.push({
        type: 'prop',
        id: ep_item.id,
        name: ep_item.name,
        typeLabel: '道具',
        reason: `道具「${ep_item.name}」在全剧剧本与分镜中无使用记录，建议删除以精简世界观。`,
      });
    }
  }

  for (const es of allDramaScenes) {
    if (savedSceneIds.has(Number(es.id))) continue;
    if (isAssetObsolete('scene', es, { script: fullDramaScript, shots: dramaShots })) {
      obsoleteAssets.push({
        type: 'scene',
        id: es.id,
        name: es.location,
        typeLabel: '场地',
        reason: `场地「${es.location}」在全剧最新剧本与分镜中未被涉及，建议删除。`,
      });
    }
  }

  log.info('[本体提取] 全量实体入库就绪', {
    characters_count: savedCharacters.length,
    scenes_count: savedScenes.length,
    props_count: savedProps.length,
    obsolete_assets_count: obsoleteAssets.length,
  });

  return {
    characters: savedCharacters,
    scenes: savedScenes,
    props: savedProps,
    obsolete_assets: obsoleteAssets,
    violations: propViolations,
  };
}

/**
 * 人机协同实体补全分析（根据名称、用户线索与剧本世界观上下文，自动提取完整本体属性）
 * @param {object} db - SQLite 数据库
 * @param {object} log - 日志记录器
 * @param {object} cfg - 全局配置
 * @param {object} params - { dramaId, episodeId, entityType, name, hint }
 * @returns {Promise<object>} 结构化实体字段
 */
async function autocompleteEntityFromScript(db, log, cfg, { dramaId, episodeId, entityType, name, hint }) {
  const dId = Number(dramaId);
  const drama = db.prepare('SELECT id, title, genre, style FROM dramas WHERE id = ? AND deleted_at IS NULL').get(dId) || {};

  let scriptContent = '';
  if (episodeId) {
    const ep = db.prepare('SELECT script_content FROM episodes WHERE id = ? AND deleted_at IS NULL').get(Number(episodeId));
    scriptContent = ep?.script_content || '';
  }
  if (!scriptContent) {
    const eps = db.prepare('SELECT script_content FROM episodes WHERE drama_id = ? AND deleted_at IS NULL ORDER BY episode_number ASC').all(dId);
    scriptContent = eps.map((e) => e.script_content || '').filter(Boolean).join('\n\n');
  }

  // 判定世界观时代
  const text = `${drama.title || ''} ${drama.genre || ''} ${drama.style || ''} ${scriptContent}`.toLowerCase();
  const isAncient = /古装|古风|武侠|仙侠|大明|大唐|汉服/.test(text);
  const dramaEra = isAncient ? 'ancient' : (/民国/.test(text) ? 'republic_china' : (/赛博|科幻/.test(text) ? 'sci_fi' : 'modern'));

  let systemPrompt = '';
  let userPrompt = '';

  if (entityType === 'prop') {
    systemPrompt = `你是一位严谨的短剧影视视听本体道具设计师。
请结合剧本世界观与剧情，针对用户指定的道具进行深度分析与属性补全。
【核心法则】：
1. 必须强制给出具体的真实物理尺度 physical_scale（如“长约18cm单兵佩戴护目镜，贴合面部轮廓”、“长约45cm手提密码箱”），并注明为次要环境物件，严禁生图时夸大夺焦；
2. 时代硬性约束：${isAncient ? '古风世界观：严禁出现手机、电脑、现代工业品！' : '符合剧本时代背景与现实物理常识'}；
3. 参考图模式 reference_image_mode：若为主武器或复杂结构选 "quad_grid"，单一视角物件选 "single"。`;

    userPrompt = `【剧名】：${drama.title || '短剧'}（时代：${dramaEra}，风格：${drama.style || '写实'}）
【剧本内容摘要】：
${scriptContent.slice(0, 3500) || '(剧本正文尚未录入，请根据名称与时代常识推断)'}

【待补全道具】：${name}
${hint ? `【补充线索/用户备注】：${hint}` : ''}

请输出纯 JSON 对象，格式严格如下：
{
  "name": "${name}",
  "type": "武器/装备/证物/日常/其他",
  "physical_scale": "真实物理尺寸描述（如：长约18cm单兵佩戴护目镜，紧密贴合面部，次要战术物件）",
  "description": "材质、细节特征与在剧中的用途描述（不少于40字）",
  "prompt": "特写单体道具：${name}，[材质质感]，[真实光照与物理细节]，纯色干净背景，超高清摄影，8k uhd",
  "reference_image_mode": "single 或 quad_grid",
  "reference_image_reason": "简要推荐理由"
}`;
  } else if (entityType === 'character') {
    systemPrompt = `你是一位专业的短剧影视角色造型与人设设计师。
请结合剧本角色出场、台词与剧情关系，准确提炼该角色的身份定位、外貌锚点与人设特征。`;

    userPrompt = `【剧名】：${drama.title || '短剧'}（时代：${dramaEra}，风格：${drama.style || '写实'}）
【剧本内容摘要】：
${scriptContent.slice(0, 3500) || '(剧本正文尚未录入，请根据名称与时代常识推断)'}

【待补全角色】：${name}
${hint ? `【补充线索/用户备注】：${hint}` : ''}

请输出纯 JSON 对象，格式严格如下：
{
  "name": "${name}",
  "role": "main/supporting/minor (主角/配角/次要角色选其一)",
  "gender": "男/女",
  "appearance": "详细外貌特征（年龄外貌感、五官面容、发型发色、体型身材、典型服装配饰，不少于50字，供保持画风与人脸一致）",
  "description": "角色背景与在剧情中的身份定位（不少于30字）",
  "personality": "性格关键词（如：果决、隐忍、临危不乱）",
  "polished_prompt": "四视图角色概念设计，多角度：正面、侧面、四分之三侧面、背面，同一角色保持外貌一致，${name}，[外貌服装摘要]，纯白简单背景，大师画质"
}`;
  } else {
    // scene
    systemPrompt = `你是一位专业的短剧影视美术与场景空间设计师。
请结合剧本情节发生的空间，准确分析该场景的地点、时间、空间格局与环境氛围。`;

    userPrompt = `【剧名】：${drama.title || '短剧'}（时代：${dramaEra}，风格：${drama.style || '写实'}）
【剧本内容摘要】：
${scriptContent.slice(0, 3500) || '(剧本正文尚未录入，请根据名称与时代常识推断)'}

【待补全场景】：${name}
${hint ? `【补充线索/用户备注】：${hint}` : ''}

请输出纯 JSON 对象，格式严格如下：
{
  "location": "${name}",
  "time": "时间与光影（如：日景·阴冷微光 / 夜景·昏暗微光）",
  "landmarks": ["主要空间地标1", "地标2"],
  "description": "空间环境详细描述（空间格局、陈设地标、质感与环境氛围，不少于40字）",
  "prompt": "宽幅环境建立镜头，${name}内部，[陈设与地标]，[光影与氛围]，纯真实环境无人物，电影质感，超写实摄影，8k uhd",
  "reference_image_mode": "single 或 quad_grid",
  "reference_image_reason": "简要推荐理由"
}`;
  }

  log.info('[人机协同实体补全] 开始分析实体', { dramaId: dId, entityType, name });
  const rawResponse = await aiClient.generateText(db, log, 'text', userPrompt, systemPrompt, {
    scene_key: 'collaborative_autocomplete',
    max_tokens: 1500,
    temperature: 0.3,
  });

  const parsed = safeParseAIJSON(rawResponse, null, log);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('AI 未能返回有效的结构化数据');
  }

  return parsed;
}

module.exports = {
  extractAllEntitiesFromScript,
  autocompleteEntityFromScript,
};
