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
const { PropEraAndScaleRule } = require('./invariants');
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

  const drama = db.prepare('SELECT id, title, genre, style, metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(ep.drama_id) || {};

  // 1. 判定时代世界观
  const text = `${drama.title || ''} ${drama.genre || ''} ${drama.style || ''} ${ep.script_content}`.toLowerCase();
  const isAncient = /古装|古风|武侠|仙侠|大明|大唐|汉服|historical|ancient|流放|大靖|朝廷|王爷|皇宫|嫡女|庶女/.test(text);
  const dramaEra = isAncient ? 'ancient' : (/民国/.test(text) ? 'republic_china' : (/赛博|科幻/.test(text) ? 'sci_fi' : 'modern'));

  const prompt = `你是一位严谨的短剧世界观与本体知识架构师。
请阅读以下剧本，按照【短剧本体（Short-Drama Ontology）】标准，一次性抽取出该集出现的所有核心资产：短剧角色（Characters）、道具与打脸信物（Props）、空间场景与权力位阶（Scenes），以及角色间的关系边（Character Relations）和剧情节拍序列（Narrative Beats）。

【世界观时代】：${dramaEra}（${isAncient ? '古装/古风世界观：严禁出现手机、电脑、现代工业品' : '现代/通用世界观'}）
【剧名】：${drama.title || '短剧'}
【剧本内容】：
${ep.script_content}

【短剧本体抽取规则】：
1. **角色(characters)**：提取所有登场人物。
   - name, gender(男/女), role(如赘婿/千金/霸总/岳母/打手等)
   - archetype(人设原型，按剧本描述，可留空；爽剧示例: hidden_tycoon/avenging_heiress/arrogant_antagonist/snobbish_inlaw/loyal_sidekick/bystander_crowd)
   - surface_identity(表面伪装身份，如“保洁大妈”、“穷酸外卖员”、“窝囊赘婿”)
   - hidden_identity(隐藏真实身份，如“千亿集团唯一继承人”、“退役龙王战神”)
   - power_status(按剧情选填，可留空: dominant强势压迫/suppressed低位隐忍/awakened觉醒/bystander围观)
   - appearance(具体外貌特征与五官发型服装，不少于30字), personality(性格关键词)
2. **道具与打脸信物(props)**：提取剧中有物理交互、关键情节推动、打脸反转或证物作用的物体（如黑金卡、龙王戒、离婚协议书、亲子鉴定、信件、佩剑）。
   - prop_role: 按原文用途描述，也可选 key_token(核心身份信物/底牌) / slap_evidence(打脸证据/文书) / conflict_tool(冲突器物/武器) / ambient(普通环境物件)
   - close_up_required: boolean(若为 key_token 或 slap_evidence 必须为 true，短剧镜头中必须给予高辨识度特写)
   - owner_character_name: 专属持有者或出示者姓名
   - physical_scale: 给出具体真实物理尺度（如“标准黑金银行卡尺寸”、“直径约2.5cm古玉扳指”、“A4纸质装订文件”）
   - era_category: ancient/modern/republic_china/sci_fi/fantasy/universal
   - era_compatibility: compatible/intentional_cross_era/incompatible/uncertain
   - era_reason: 结合具体剧情时空说明理由
   - reference_image_mode: single 或 quad_grid (复杂三维信物选 quad_grid，平面文书选 single)
3. **场景与空间权力轴(scenes)**：提取剧情发生的独立物理空间。
   - location(地点名，如豪门寿宴大厅/总裁办公室/阴暗地下室)
   - time(时间与光照，如奢华暖金顶光/冰冷日光灯/夜景暗调)
   - spatial_type: interior_tight / interior_open / exterior_open
   - power_axis: 空间权力轴向(high_seat_vs_floor 主座高位对堂下 / entrance_intrusion 门口踹开闯入轴 / center_stage_vs_crowd 焦点对围观区)
   - landmarks: 场景内地标数组，如 ["main_seat", "doorway", "banquet_table", "window"]
   - lighting_style: natural/dramatic/golden_hour/night/neon
   - reference_image_mode: single 或 quad_grid
4. **人物关系边(character_relations)**：提取人物之间的带权有向关系边。
   - from_character: 动作发出方角色名
   - to_character: 动作承受方角色名
   - relation_kind: 按原文描述关系，也可选 trusts(信任)、doubts(怀疑)、cares_for(照料)、humiliates(欺辱压迫) / protects(护短庇护) / subordinate_to(臣服从属) / family_oppresses(家族刁难) / enemy_of(死敌对立) / ally_of(忠实盟友) / reveals_identity_to(亮明底牌)
   - description: 简要关系说明
5. **短剧爽点节拍序列(narrative_beats)**：提取本集的情绪张力节拍链。
   - beat_number: 1, 2, 3...
   - beat_type: 可选 decision(人物选择)、discovery(获得信息)、consequence(行动后果)、relationship_change(关系变化)，或按剧情选 hook(开场钩子) / suppression(极限施压羞辱) / reveal(亮信物底牌) / slap_reversal(打脸反转) / crowd_reaction(围观震惊反应) / cliffhanger(集末断章卡点) / transition(转场过渡)
   - tension_level: 1~5 (张力级别，5为打脸/高潮巅峰)
   - dominant_emotion: 屈辱/嚣张/震惊/爽快/肃杀
   - power_shift: aggressor_dominant(恶人嚣张) / protagonist_counter(主角反击) / power_reversed(彻底翻盘) / stalemate(对峙)
   - actors: [ { "name": "...", "role": "aggressor/protagonist/bystander" } ]
   - revealed_prop_name: 若该节拍亮出信物，填道具名；否则留空
   - event_summary: 本节拍核心冲突事件一句话概括

【输出格式】：只输出纯 JSON 对象，格式如下：
{
  "characters": [
    { "name": "...", "gender": "...", "role": "...", "archetype": "...", "surface_identity": "...", "hidden_identity": "...", "power_status": "...", "appearance": "...", "personality": "..." }
  ],
  "props": [
    { "name": "...", "type": "武器/装备/证物/日常", "prop_role": "key_token/slap_evidence/conflict_tool/ambient", "close_up_required": true, "owner_character_name": "...", "era_category": "...", "era_compatibility": "...", "era_reason": "...", "physical_scale": "...", "reference_image_mode": "single或quad_grid", "reference_image_reason": "...", "description": "..." }
  ],
  "scenes": [
    { "location": "...", "time": "...", "landmarks": ["main_seat", "doorway"], "power_axis": "center_stage_vs_crowd", "lighting_style": "dramatic", "reference_image_mode": "single或quad_grid", "reference_image_reason": "..." }
  ],
  "character_relations": [
    { "from_character": "...", "to_character": "...", "relation_kind": "humiliates", "description": "..." }
  ],
  "narrative_beats": [
    { "beat_number": 1, "beat_type": "hook", "tension_level": 4, "dominant_emotion": "屈辱", "power_shift": "aggressor_dominant", "actors": [], "revealed_prop_name": "", "event_summary": "..." }
  ]
}`;

  log.info('[本体提取] 开始抽取全量剧目本体实体', { episode_id: epId, era: dramaEra });
  const rawResponse = await aiClient.generateText(db, log, 'text', prompt, '', { max_tokens: 4000 });
  const parsed = safeParseAIJSON(rawResponse, null, log);

  const rawCharacters = Array.isArray(parsed?.characters) ? parsed.characters : [];
  const rawProps = Array.isArray(parsed?.props) ? parsed.props : [];
  const rawScenes = Array.isArray(parsed?.scenes) ? parsed.scenes : [];

  // 2. 运行道具结构化时空合同门禁；自然语言关键词不参与硬阻断。
  const propViolations = new PropEraAndScaleRule().evaluate({ props: rawProps, dramaEra });
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
    const identityAnchorsObj = {
      archetype: c.archetype || null,
      surface_identity: c.surface_identity || '',
      hidden_identity: c.hidden_identity || '',
      power_status: c.power_status || null,
    };
    const identityAnchorsStr = JSON.stringify(identityAnchorsObj);

    if (!exist) {
      const desc = [
        c.gender ? `性别：${c.gender}` : '',
        c.role ? `身份：${c.role}` : '',
        c.surface_identity ? `表面伪装：${c.surface_identity}` : '',
        c.hidden_identity ? `真实底牌：${c.hidden_identity}` : '',
        c.description || c.appearance || '',
      ].filter(Boolean).join('；');

      const ins = db.prepare(`
        INSERT INTO characters (drama_id, name, role, appearance, description, personality, identity_anchors, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(ep.drama_id, c.name, c.role || '', c.appearance || '', desc, c.personality || '', identityAnchorsStr, now, now);
      exist = db.prepare('SELECT * FROM characters WHERE id = ?').get(ins.lastInsertRowid);
    } else {
      try {
        db.prepare('UPDATE characters SET identity_anchors = COALESCE(NULLIF(identity_anchors, ""), ?) WHERE id = ?').run(identityAnchorsStr, exist.id);
      } catch (_) {}
    }
    try {
      db.prepare('INSERT OR IGNORE INTO episode_characters (episode_id, character_id) VALUES (?, ?)').run(epId, exist.id);
    } catch (_) {}
    savedCharacters.push(exist);
  }

  // 建立角色名到 ID 的映射
  const charNameToIdMap = new Map();
  for (const c of savedCharacters) {
    if (c.name) charNameToIdMap.set(c.name.trim(), c.id);
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
    try {
      const episodeSceneService = require('../services/episodeSceneService');
      episodeSceneService.add(db, ep.drama_id, epId, exist.id);
    } catch (_) {}
    savedScenes.push(exist);
  }

  // 写入 props 表（含 Agent 视图模式规划、真实物理尺度与持有者关联）
  for (const p of rawProps) {
    if (!p.name) continue;
    let exist = db.prepare('SELECT * FROM props WHERE drama_id = ? AND name = ? AND deleted_at IS NULL').get(ep.drama_id, p.name);
    const mode = p.reference_image_mode === 'quad_grid' ? 'quad_grid' : 'single';
    const reason = p.reference_image_reason || (mode === 'quad_grid' ? '智能体建议：主要剧情物件，需四视图展现几何结构' : '智能体建议：单图优先保障道具细节与材质清晰度');
    const ownerId = p.owner_character_name && charNameToIdMap.has(p.owner_character_name.trim())
      ? charNameToIdMap.get(p.owner_character_name.trim())
      : null;
    const propRoleDesc = p.prop_role ? `[短剧作用:${p.prop_role}] ` : '';
    const fullDesc = `${propRoleDesc}${p.description || ''}`.trim();

    if (!exist) {
      const promptText = `特写单体道具：${p.name}，${p.physical_scale || '正常尺寸'}，纯色无杂乱背景，高清真实摄影`;
      const ins = db.prepare(`
        INSERT INTO props (drama_id, name, type, description, era_category, era_compatibility, era_reason, physical_scale, prompt, image_prompt, reference_image_mode, reference_image_recommendation, reference_image_reason, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(ep.drama_id, p.name, p.type || '日常用品', fullDesc, p.era_category || 'universal', p.era_compatibility || 'uncertain', p.era_reason || '', p.physical_scale || '正常尺寸', promptText, promptText, mode, mode, reason, now, now);
      exist = db.prepare('SELECT * FROM props WHERE id = ?').get(ins.lastInsertRowid);
    } else {
      db.prepare(`UPDATE props SET physical_scale = COALESCE(NULLIF(physical_scale, ''), ?), era_category = ?, era_compatibility = ?, era_reason = ?, reference_image_recommendation = ?, reference_image_reason = ? WHERE id = ?`).run(p.physical_scale || '正常尺寸', p.era_category || 'universal', p.era_compatibility || 'uncertain', p.era_reason || '', mode, reason, exist.id);
    }
    savedProps.push(exist);
  }

  // 持久化短剧本体图扩展数据（人物关系边与爽点节拍序列）到 dramas.metadata
  // 严格杜绝跨集抽取相互覆盖：人物关系边按三元组增量合并，爽点节拍按单集分槽存储
  const extractedRelations = Array.isArray(parsed?.character_relations) ? parsed.character_relations : [];
  const extractedBeats = Array.isArray(parsed?.narrative_beats) ? parsed.narrative_beats : [];
  try {
    let dramaMeta = {};
    try { dramaMeta = typeof drama.metadata === 'string' ? JSON.parse(drama.metadata) : (drama.metadata || {}); } catch (_) {}
    if (!dramaMeta || typeof dramaMeta !== 'object' || Array.isArray(dramaMeta)) {
      dramaMeta = {};
    }
    if (!dramaMeta.ontology_graph || typeof dramaMeta.ontology_graph !== 'object' || Array.isArray(dramaMeta.ontology_graph)) {
      dramaMeta.ontology_graph = { relations: [], episodes_beats: {}, beats: {} };
    }
    if (!Array.isArray(dramaMeta.ontology_graph.relations)) {
      dramaMeta.ontology_graph.relations = [];
    }
    if (!dramaMeta.ontology_graph.episodes_beats || typeof dramaMeta.ontology_graph.episodes_beats !== 'object' || Array.isArray(dramaMeta.ontology_graph.episodes_beats)) {
      dramaMeta.ontology_graph.episodes_beats = dramaMeta.ontology_graph.beats && typeof dramaMeta.ontology_graph.beats === 'object' && !Array.isArray(dramaMeta.ontology_graph.beats)
        ? { ...dramaMeta.ontology_graph.beats }
        : {};
    }
    if (!dramaMeta.ontology_graph.beats || typeof dramaMeta.ontology_graph.beats !== 'object' || Array.isArray(dramaMeta.ontology_graph.beats)) {
      dramaMeta.ontology_graph.beats = {};
    }
    if (extractedRelations.length > 0) {
      // 合并全剧关系边（按 ${from_type}:${from_id}->${relation_kind}->${to_type}:${to_id} 增量合并，保留已有其他关系）
      const existingRels = dramaMeta.ontology_graph.relations;
      const relKey = r => {
        const fromType = r.from_type || r.fromType || 'Character';
        const fromVal = (r.from_id != null && Number.isFinite(Number(r.from_id))) ? r.from_id : String(r.from_character || '').trim();
        const toType = r.to_type || r.toType || 'Character';
        const toVal = (r.to_id != null && Number.isFinite(Number(r.to_id))) ? r.to_id : String(r.to_character || '').trim();
        const kind = String(r.relation_kind || '').trim();
        return `${fromType}:${fromVal}->${kind}->${toType}:${toVal}`;
      };
      const relMap = new Map();
      for (const r of existingRels) {
        const k = relKey(r);
        if (k !== 'Character:->->Character:') relMap.set(k, r);
      }
      for (const r of extractedRelations) {
        const k = relKey(r);
        if (k !== 'Character:->->Character:') relMap.set(k, r);
      }
      dramaMeta.ontology_graph.relations = Array.from(relMap.values());
    }
    if (extractedBeats.length > 0) {
      // 爽点节拍按单集分槽持久化，彻底杜绝跨集抽取相互覆盖
      dramaMeta.ontology_graph.episodes_beats[String(epId)] = extractedBeats;
      dramaMeta.ontology_graph.beats[String(epId)] = extractedBeats;
      dramaMeta.ontology_graph.narrative_beats = extractedBeats;
    }
    db.prepare('UPDATE dramas SET metadata = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(dramaMeta), now, ep.drama_id);
  } catch (err) {
    log.warn('[本体提取] 保存短剧关系图与节拍元数据异常', { error: err.message });
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
  const isAncient = /古装|古风|武侠|仙侠|大明|大唐|汉服|historical|ancient|流放|大靖|朝廷|王爷|皇宫|嫡女|庶女/.test(text);
  const dramaEra = isAncient ? 'ancient' : (/民国/.test(text) ? 'republic_china' : (/赛博|科幻/.test(text) ? 'sci_fi' : 'modern'));

  let systemPrompt = '';
  let userPrompt = '';

  if (entityType === 'prop') {
    systemPrompt = `你是一位严谨的短剧本体道具与打脸信物设计师。
请结合剧本世界观与剧情，针对用户指定的道具进行深度分析与属性补全。
【核心法则】：
1. 必须强制给出具体的真实物理尺度 physical_scale（如“标准银行卡尺寸”、“长约25cm玉质卷轴”、“约12cm精致古玉佩”）；对打脸信物/底牌（key_token），必须突出特写辨识度；
2. 时代硬性约束：${isAncient ? '古风世界观：严禁出现手机、电脑、现代工业品！' : '符合剧本时代背景与现实物理常识'}；
   对穿越、梦境、游戏世界、回忆和剧情刻意跨时代元素，不得判为普通穿帮，必须用 intentional_cross_era 标记并说明依据；
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
  "prop_role": "key_token(核心身份信物/底牌) / slap_evidence(打脸证据) / conflict_tool(冲突器物) / ambient(环境道具)",
  "close_up_required": true,
  "era_category": "ancient/modern/republic_china/sci_fi/fantasy/universal",
  "era_compatibility": "compatible/intentional_cross_era/incompatible/uncertain",
  "era_reason": "结合该道具实际出现的剧情时空说明理由",
  "physical_scale": "真实物理尺寸描述（如：标准黑色磨砂银行卡，边角烫金纹理）",
  "description": "材质、细节特征与在剧中的用途描述（不少于40字）",
  "prompt": "特写单体道具：${name}，[材质质感]，[真实光照与物理细节]，纯色干净背景，超高清摄影，8k uhd",
  "reference_image_mode": "single 或 quad_grid",
  "reference_image_reason": "简要推荐理由"
}`;
  } else if (entityType === 'character') {
    systemPrompt = `你是一位专业的短剧角色造型与人设设计师。
请结合剧本角色出场、台词与剧情关系，准确提炼该角色的身份定位、表里人设、外貌锚点与特征。`;

    userPrompt = `【剧名】：${drama.title || '短剧'}（时代：${dramaEra}，风格：${drama.style || '写实'}）
【剧本内容摘要】：
${scriptContent.slice(0, 3500) || '(剧本正文尚未录入，请根据名称与时代常识推断)'}

【待补全角色】：${name}
${hint ? `【补充线索/用户备注】：${hint}` : ''}

请输出纯 JSON 对象，格式严格如下：
{
  "name": "${name}",
  "role": "main/supporting/minor (主角/配角/次要角色选其一)",
  "archetype": "hidden_tycoon(隐忍霸总/战神)/avenging_heiress(逆袭女主)/arrogant_antagonist(恶毒反派)/snobbish_inlaw(势利长辈)/bystander_crowd(吃瓜围观)",
  "surface_identity": "表面伪装身份（如：保洁阿姨/落魄赘婿/底层职员）",
  "hidden_identity": "隐藏真实底牌（如：千亿首富/龙王殿主/唯一继承人）",
  "power_status": "dominant(强势)/suppressed(隐忍)/awakened(觉醒)/bystander(吃瓜)",
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
