/**
 * 剧集本体语义包编译器（Drama Semantic Package Compiler）
 * 参考 /home/nvidia/ontology-semantic-system 的不可变 Semantic Package 概念：
 * - 将角色、场景空间地标、道具物理尺度与剧本剧情打包为版本化不可变事实集合
 * - 所有智能体（剧本、提取、分镜、出图）统一以此语义包为唯一真实世界事实，严禁启发式瞎猜
 */

const crypto = require('crypto');
const { createCharacterEntity, createSceneSpatialEntity, createPropEntity } = require('./schema');

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

  // 1. 抽取角色本体目录（含身份锚点、造型阶段、音色）
  const charRows = db.prepare('SELECT * FROM characters WHERE drama_id = ? AND deleted_at IS NULL ORDER BY id ASC').all(ep.drama_id);
  const episodeCharacterIds = new Set(db.prepare('SELECT character_id FROM episode_characters WHERE episode_id=?').all(epId).map(r => Number(r.character_id)));
  const characters = charRows.map((r) => {
    let anchors = null;
    if (r.identity_anchors) {
      try { anchors = typeof r.identity_anchors === 'string' ? JSON.parse(r.identity_anchors) : r.identity_anchors; } catch (_) {}
    }
    let voice = null;
    if (r.voice_id || r.custom_voice_id) {
      voice = { voice_id: r.voice_id || r.custom_voice_id, speed: r.speed || 1.0, pitch: r.pitch || 0 };
    }
    return createCharacterEntity({
      id: r.id,
      name: r.name,
      gender: r.gender,
      role: r.role,
      appearance: r.appearance || r.description,
      wardrobeStageId: r.current_stage_id,
      state: 'normal',
      voice,
    });
  });

  // 2. 抽取场景空间本体目录（含空间地标、采光）
  const sceneRows = db.prepare('SELECT * FROM scenes WHERE drama_id = ? AND deleted_at IS NULL ORDER BY id ASC').all(ep.drama_id);
  const scenes = sceneRows.map((r) => {
    const desc = `${r.location || ''} ${r.prompt || ''}`.toLowerCase();
    const landmarks = [];
    if (/门|门口|door/.test(desc)) landmarks.push('doorway');
    if (/窗|窗口|window/.test(desc)) landmarks.push('window');
    if (/桌|案几|台|desk|table/.test(desc)) landmarks.push('desk');
    if (/箱|货箱|掩体|cover|crate/.test(desc)) landmarks.push('cover');
    if (/走廊|过道|通道|corridor/.test(desc)) landmarks.push('corridor');

    let lighting = 'natural';
    if (/夜|暗|night|dark/.test(desc)) lighting = 'night';
    else if (/夕阳|黄昏|sunset|golden/.test(desc)) lighting = 'golden_hour';
    else if (/蓝调|冷|blue/.test(desc)) lighting = 'blue_hour';
    else if (/霓虹|赛博|neon/.test(desc)) lighting = 'neon';

    return createSceneSpatialEntity({
      id: r.id,
      location: r.location,
      time: r.time,
      spatialType: /室外|街道|广场|荒野|outdoor/.test(desc) ? 'exterior_open' : 'interior',
      lightingEnv: lighting,
      landmarks,
      acoustics: /仓库|大厅|空旷/.test(desc) ? 'echo_hall' : 'standard',
    });
  });

  // 3. 抽取道具物理本体目录（含尺寸、时代）
  let props = [];
  try {
    const propRows = db.prepare('SELECT * FROM props WHERE drama_id = ? AND deleted_at IS NULL ORDER BY id ASC').all(ep.drama_id);
    props = propRows.map((r) => {
      let scale = r.physical_scale || '';
      if (!scale) {
        if (/枪|刀|剑|武器/.test(r.name)) scale = '长约40-80cm单兵持有物，不可放大';
        else if (/箱|盒子/.test(r.name)) scale = '长约30-50cm手提物件，放置于平整表面';
        else scale = '环境正常尺寸小件道具，次要元素';
      }
      return createPropEntity({
        id: r.id,
        name: r.name,
        type: r.type,
        eraCategory: r.era_category || 'universal',
        eraCompatibility: r.era_compatibility || '',
        eraReason: r.era_reason || '',
        physicalScale: scale,
        description: r.description,
        prompt: r.image_prompt,
      });
    });
  } catch (_) {
    // 兼容尚未建立 props 表的环境
    props = [];
  }

  // 4. 解析剧情时代与世界观
  const dramaEra = (() => {
    const text = `${drama.title || ''} ${drama.genre || ''} ${drama.style || ''} ${ep.script_content || ''}`.toLowerCase();
    if (/古装|古风|武侠|仙侠|修真|大宋|大明|大唐|汉服|朝代|historical|ancient|流放|大靖|朝廷|王爷|皇宫|嫡女|庶女/.test(text)) return 'ancient';
    if (/民国|上海滩|军阀|租界/.test(text)) return 'republic_china';
    if (/赛博|科幻|星际|太空|未来|战舰|全息|AI/.test(text)) return 'sci_fi';
    return 'modern';
  })();

  // 5. 计算不可变内容哈希（SHA-256 Content Hash）
  const contentDigest = JSON.stringify({
    drama_id: ep.drama_id,
    episode_id: epId,
    drama_era: dramaEra,
    script_hash: crypto.createHash('sha256').update(ep.script_content || '').digest('hex'),
    characters: characters.map(c => ({ id: c.id, name: c.name, stage: c.wardrobe_stage_id, in_episode: episodeCharacterIds.has(c.id) })),
    scenes: scenes.map(s => ({ id: s.id, loc: s.location, landmarks: s.landmarks })),
    props: props.map(p => ({ id: p.id, name: p.name, scale: p.physical_scale, era: p.era_category, compatibility: p.era_compatibility })),
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
      const charLines = characters.map(c => `- ID:${c.id} [${c.name}] ${episodeCharacterIds.has(c.id) ? "【本集已关联】" : "【剧库可复用，未关联本集】"} (${c.gender}/${c.role}) ${c.appearance ? `外貌:${c.appearance.slice(0, 50)}` : ''}`).join('\n');
      const sceneLines = scenes.map(s => `- ID:${s.id} [${s.location}] 地标:[${s.landmarks.join(',')}] 光照:${s.lighting_env || '自然光'}`).join('\n');
      const propLines = props.map(p => `- ID:${p.id} [${p.name}] 尺度:[${p.physical_scale}] 时代使用:${p.era_compatibility || '未声明'}${p.era_reason ? `(${p.era_reason})` : ''}`).join('\n');
      return `【剧目本体世界观】剧名：${drama.title || '短剧'} | 时代：${dramaEra} | 风格：${drama.style || '写实电影感'}
【角色身份选择】人物身份以 ID 为准，名字不是唯一键。优先复用本集已关联人物；同名多个 ID 时必须核对本集选择、外貌与剧情身份，不能在不同镜头随机切换 ID，也不能把同名记录当作同一个角色。仅在剧情确实需要时明确选择剧库其他人物，发布时会按所选 ID 建立本集关联。\n【可用角色本体目录】\n${charLines || '(暂无)'}
【可用场景空间地标】\n${sceneLines || '(暂无)'}
【可用物理道具目录】\n${propLines || '(暂无)'}`;
    },
  };
}

module.exports = {
  compileDramaSemanticPackage,
  resolveEpisodeDurationSeconds,
};
