/**
 * 剧集本体语义包编译器（Drama Semantic Package Compiler）
 * 参考 /home/nvidia/ontology-semantic-system 的不可变 Semantic Package 概念：
 * - 将角色、场景空间地标、道具物理尺度与剧本剧情打包为版本化不可变事实集合
 * - 所有智能体（剧本、提取、分镜、出图）统一以此语义包为唯一真实世界事实，严禁启发式瞎猜
 */

const crypto = require('crypto');
const {
  createCharacterEntity,
  createSceneSpatialEntity,
  createPropEntity,
  SHORT_DRAMA_ONTOLOGY_META_MODEL,
  createRelationEdge,
} = require('./schema');

/**
 * episodes.duration is persisted in minutes by both storyboard generators.  A
 * few old/imported rows used seconds, so values above ten are treated as that
 * legacy representation.  The script estimate prevents a previously
 * incomplete storyboard run (for example 31 seconds -> stored as 1 minute)
 * from shrinking the next Director run to the same incomplete duration.
 */
function resolveEpisodeDurationSeconds(ep) {
  const scriptLength = String(ep?.script_content || '').trim().length;
  const scriptEstimate = scriptLength > 0
    ? Math.max(30, Math.round(10 + (scriptLength / 600) * 60))
    : 60;
  const stored = Number(ep?.duration);
  const storedSeconds = Number.isFinite(stored) && stored > 0
    ? (stored <= 10 ? Math.round(stored * 60) : Math.round(stored))
    : 0;
  return Math.max(scriptEstimate, storedSeconds || 0);
}

/**
 * 编译指定剧集的全量本体语义包
 * @param {object} db - SQLite 数据库连接
 * @param {number|string} episodeId - 剧集 ID
 * @returns {object} 不可变的 DramaSemanticPackage
 */
function compileDramaSemanticPackage(db, episodeId) {
  const epId = Number(episodeId);
  const ep = db.prepare('SELECT * FROM episodes WHERE id = ? AND deleted_at IS NULL').get(epId);
  if (!ep) throw new Error(`剧集 ${episodeId} 不存在或已被删除`);

  const drama = db.prepare('SELECT * FROM dramas WHERE id = ? AND deleted_at IS NULL').get(ep.drama_id) || {};

  // 读取短剧持久化扩展元数据（人物恩怨关系与爽点节拍）
  let dramaMeta = {};
  try { dramaMeta = typeof drama.metadata === 'string' ? JSON.parse(drama.metadata) : (drama.metadata || {}); } catch (_) {}
  const rawGraph = dramaMeta.ontology_graph || {};
  const storedRelations = Array.isArray(rawGraph.relations) ? rawGraph.relations : [];
  const storedBeats = Array.isArray(rawGraph.beats?.[epId])
    ? rawGraph.beats[epId]
    : (Array.isArray(rawGraph.beats?.[String(epId)])
      ? rawGraph.beats[String(epId)]
      : (Array.isArray(rawGraph.beats) ? rawGraph.beats : []));

  // 1. 抽取角色本体目录（含身份锚点、造型阶段、音色、短剧人设与双层身份）
  const charRows = db.prepare('SELECT * FROM characters WHERE drama_id = ? AND deleted_at IS NULL ORDER BY id ASC').all(ep.drama_id);
  const episodeCharacterIds = new Set(db.prepare('SELECT character_id FROM episode_characters WHERE episode_id=?').all(epId).map(r => Number(r.character_id)));
  const charNameToIdMap = new Map();
  const characters = charRows.map((r) => {
    let anchors = null;
    if (r.identity_anchors) {
      try { anchors = typeof r.identity_anchors === 'string' ? JSON.parse(r.identity_anchors) : r.identity_anchors; } catch (_) {}
    }
    let voice = null;
    if (r.voice_id || r.custom_voice_id) {
      voice = { voice_id: r.voice_id || r.custom_voice_id, speed: r.speed || 1.0, pitch: r.pitch || 0 };
    }
    charNameToIdMap.set(r.name.trim(), r.id);
    return createCharacterEntity({
      id: r.id,
      name: r.name,
      gender: r.gender,
      role: r.role,
      appearance: r.appearance || r.description,
      wardrobeStageId: r.current_stage_id,
      state: 'normal',
      voice,
      identityAnchors: anchors,
      archetype: anchors?.archetype || 'hidden_tycoon',
      surfaceIdentity: anchors?.surface_identity || '',
      hiddenIdentity: anchors?.hidden_identity || '',
      powerStatus: anchors?.power_status || 'suppressed',
    });
  });

  // 2. 抽取场景空间本体目录（优先读取结构化地标、空间权力轴与采光）
  const sceneRows = db.prepare('SELECT * FROM scenes WHERE drama_id = ? AND deleted_at IS NULL ORDER BY id ASC').all(ep.drama_id);
  const scenes = sceneRows.map((r) => {
    let landmarks = [];
    if (Array.isArray(r.landmarks)) {
      landmarks = r.landmarks;
    } else if (typeof r.landmarks === 'string' && r.landmarks.trim().startsWith('[')) {
      try { landmarks = JSON.parse(r.landmarks); } catch (_) {}
    }
    if (landmarks.length === 0) {
      const desc = `${r.location || ''} ${r.prompt || ''}`.toLowerCase();
      if (/门|门口|door/.test(desc)) landmarks.push('doorway');
      if (/窗|窗口|window/.test(desc)) landmarks.push('window');
      if (/桌|案几|台|desk|table/.test(desc)) landmarks.push('desk');
      if (/箱|货箱|掩体|cover|crate/.test(desc)) landmarks.push('cover');
      if (/走廊|过道|通道|corridor/.test(desc)) landmarks.push('corridor');
      if (/主位|高台|宝座|main_seat/.test(desc)) landmarks.push('main_seat');
    }

    const lighting = r.lighting_style || r.lighting_env || 'natural';
    const spatialType = r.spatial_type || (/室外|街道|广场|荒野|outdoor/.test((r.location || '').toLowerCase()) ? 'exterior_open' : 'interior');
    const powerAxis = r.power_axis || 'center_stage_vs_crowd';

    return createSceneSpatialEntity({
      id: r.id,
      location: r.location,
      time: r.time,
      spatialType,
      lightingEnv: lighting,
      landmarks,
      powerAxis,
      acoustics: r.acoustics || 'standard',
    });
  });

  // 3. 抽取道具物理本体目录（优先读取结构化尺度、打脸信物属性）
  let props = [];
  try {
    const propRows = db.prepare('SELECT * FROM props WHERE drama_id = ? AND deleted_at IS NULL ORDER BY id ASC').all(ep.drama_id);
    props = propRows.map((r) => {
      let scale = r.physical_scale || '';
      if (!scale) {
        scale = '标准手持或环境尺寸物件';
      }
      const propRole = r.prop_role || (r.type === '打脸信物' || r.type === '核心信物' ? 'key_token' : 'ambient');
      const closeUp = r.close_up_required != null ? !!r.close_up_required : (propRole === 'key_token' || propRole === 'slap_evidence');

      return createPropEntity({
        id: r.id,
        name: r.name,
        type: r.type,
        propRole,
        closeUpRequired: closeUp,
        eraCategory: r.era_category || 'universal',
        eraCompatibility: r.era_compatibility || 'compatible',
        eraReason: r.era_reason || '',
        physicalScale: scale,
        description: r.description,
        ownerCharacterId: r.owner_character_id,
        prompt: r.image_prompt,
      });
    });
  } catch (_) {
    props = [];
  }

  // 4. 解析短剧时代与世界观（结构化优先 + 补充 fantasy 时代分支）
  const dramaEra = (() => {
    if (drama.era && typeof drama.era === 'string') return drama.era;
    const text = `${drama.title || ''} ${drama.genre || ''} ${drama.style || ''} ${ep.script_content || ''}`.toLowerCase();
    if (/奇幻|玄幻|修真|仙侠|魔法|神魔|魔幻|fantasy/.test(text)) return 'fantasy';
    if (/古装|古风|武侠|大宋|大明|大唐|汉服|朝代|historical|ancient|流放|大靖|朝廷|王爷|皇宫|嫡女|庶女/.test(text)) return 'ancient';
    if (/民国|上海滩|军阀|租界/.test(text)) return 'republic_china';
    if (/赛博|科幻|星际|太空|未来|战舰|全息|AI/.test(text)) return 'sci_fi';
    return 'modern';
  })();

  // 5. 构建显式短剧语义关系图边集合 (Relation Edges)
  const relations = [];
  // 5.1 人物社会恩怨关系边
  for (const rel of storedRelations) {
    const fromId = rel.from_character_id || charNameToIdMap.get(rel.from_character?.trim()) || 0;
    const toId = rel.to_character_id || charNameToIdMap.get(rel.to_character?.trim()) || 0;
    try {
      relations.push(createRelationEdge({
        type: 'REL_CHARACTER_SOCIAL',
        fromType: 'Character',
        fromId,
        toType: 'Character',
        toId,
        properties: {
          relation_kind: rel.relation_kind || 'enemy_of',
          from_character: rel.from_character || '',
          to_character: rel.to_character || '',
          description: rel.description || '',
        },
      }));
    } catch (_) {}
  }

  // 5.2 道具持有归属关系边
  for (const p of props) {
    if (p.owner_character_id) {
      try {
        relations.push(createRelationEdge({
          type: 'REL_CHARACTER_OWNS_PROP',
          fromType: 'Character',
          fromId: p.owner_character_id,
          toType: 'Prop',
          toId: p.id,
          properties: { prop_role: p.prop_role },
        }));
      } catch (_) {}
    }
  }

  const ontologyGraph = {
    meta_model: SHORT_DRAMA_ONTOLOGY_META_MODEL,
    objects: {
      characters,
      scenes,
      props,
      beats: storedBeats,
    },
    relations,
  };

  // 6. 计算不可变内容哈希（SHA-256 Content Hash）
  const contentDigest = JSON.stringify({
    drama_id: ep.drama_id,
    episode_id: epId,
    drama_era: dramaEra,
    script_hash: crypto.createHash('sha256').update(ep.script_content || '').digest('hex'),
    characters: characters.map(c => ({ id: c.id, name: c.name, stage: c.wardrobe_stage_id, in_episode: episodeCharacterIds.has(c.id) })),
    scenes: scenes.map(s => ({ id: s.id, loc: s.location, landmarks: s.landmarks })),
    props: props.map(p => ({ id: p.id, name: p.name, scale: p.physical_scale, era: p.era_category, compatibility: p.era_compatibility })),
    relations_count: relations.length,
    beats_count: storedBeats.length,
  });
  const revisionHash = crypto.createHash('sha256').update(contentDigest).digest('hex').slice(0, 16);

  return {
    semantic_revision: `sem_rev_${epId}_${revisionHash}`,
    drama: {
      id: ep.drama_id,
      title: drama.title || '',
      era: dramaEra,
      style: drama.style || 'cinematic',
    },
    episode: {
      id: epId,
      episode_number: ep.episode_number,
      title: ep.title || '',
      duration_target: resolveEpisodeDurationSeconds(ep),
      script_content: ep.script_content || '',
    },
    catalogs: {
      characters,
      scenes,
      props,
    },
    ontology_graph: ontologyGraph,
    narrative_beats: storedBeats,

    // 工具检索方法
    getCharacter(id) {
      return characters.find(c => c.id === Number(id)) || null;
    },
    getScene(id) {
      return scenes.find(s => s.id === Number(id)) || null;
    },
    getProp(id) {
      return props.find(p => p.id === Number(id)) || null;
    },
    // 生成供大模型理解的紧凑结构化提示词概要
    getSystemDigest() {
      const charLines = characters.map(c => `- ID:${c.id} [${c.name}] ${episodeCharacterIds.has(c.id) ? "【本集已关联】" : "【剧库可复用，未关联本集】"} (${c.gender}/${c.role}) [人设:${c.archetype || '主演'}] ${c.surface_identity ? `表:${c.surface_identity}` : ''} ${c.hidden_identity ? `底牌:${c.hidden_identity}` : ''} ${c.appearance ? `外貌:${c.appearance.slice(0, 50)}` : ''}`).join('\n');
      const sceneLines = scenes.map(s => `- ID:${s.id} [${s.location}] 地标:[${s.landmarks.join(',')}] 权力轴:[${s.power_axis || '中心焦点'}] 光照:${s.lighting_env || '自然光'}`).join('\n');
      const propLines = props.map(p => `- ID:${p.id} [${p.name}] 作用:${p.prop_role || 'ambient'}${p.close_up_required ? '【打脸信物必须给大特写】' : ''} 尺度:[${p.physical_scale}] 时代使用:${p.era_compatibility || '未声明'}${p.era_reason ? `(${p.era_reason})` : ''}`).join('\n');
      const relLines = relations.filter(r => r.type === 'REL_CHARACTER_SOCIAL').map(r => `- ${r.properties?.from_character || r.from_id} ➔ [${r.properties?.relation_kind || '恩怨'}] ➔ ${r.properties?.to_character || r.to_id}${r.properties?.description ? ` (${r.properties.description})` : ''}`).join('\n');
      const beatLines = storedBeats.map(b => `- 节拍${b.beat_number} [${b.beat_type}]: 张力${b.tension_level}星 | 主情绪:${b.dominant_emotion || '强冲突'} | ${b.event_summary || ''}`).join('\n');

      return `【短剧本体世界观】剧名：${drama.title || '短剧'} | 时代：${dramaEra} | 风格：${drama.style || '快节奏爽剧'}
【短剧人物关系网与身份反差】
${relLines || '(无预设关系边，依剧情推演)'}
【本集爽点节拍链（Beats）】
${beatLines || '(依短剧黄金钩子-施压-打脸-反转-卡点节奏推演)'}
【角色身份选择】人物身份以 ID 为准，名字不是唯一键。优先复用本集已关联人物；同名多个 ID 时必须核对本集选择、外貌与剧情身份，不能在不同镜头随机切换 ID。\n【可用角色本体目录】\n${charLines || '(暂无)'}
【可用场景空间地标】\n${sceneLines || '(暂无)'}
【可用短剧道具与打脸信物】\n${propLines || '(暂无)'}`;
    },
  };
}

module.exports = {
  compileDramaSemanticPackage,
  resolveEpisodeDurationSeconds,
};
