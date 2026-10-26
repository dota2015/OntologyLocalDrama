/**
 * assetMatcher.js - 剧作资产与剧本/分镜智能语义对齐判定器
 *
 * 解决中文影视创作中场景、角色、道具命名丰富度（复合地名、角色别名、修饰语等）
 * 与剧本正文提及、分镜引用之间的精准对齐，防止新建资产或修饰性命名被误判为过时资产。
 */

/**
 * 智能判断资产（角色、道具、场地）是否在剧本文本中被提及
 * @param {'character'|'prop'|'scene'} type
 * @param {object} asset
 * @param {string} text 剧本文本或大纲
 * @returns {boolean}
 */
function isAssetMentionedInText(type, asset, text) {
  if (!asset || !text) return false;
  const script = String(text);
  if (!script.trim()) return false;

  if (type === 'character') {
    const rawName = String(asset.name || '').trim();
    if (!rawName) return false;
    // 1. 完全包含
    if (script.includes(rawName)) return true;

    // 2. 去除括号中的别名/角色定位：如 "蜂医（苏晴）" -> "蜂医"、"苏晴"
    const cleaned = rawName.replace(/[\(（].*?[\)）]/g, '').trim();
    if (cleaned && cleaned.length >= 2 && script.includes(cleaned)) return true;
    const bracketMatches = rawName.match(/[\(（](.*?)[\)）]/);
    if (bracketMatches && bracketMatches[1] && bracketMatches[1].trim().length >= 2) {
      if (script.includes(bracketMatches[1].trim())) return true;
    }

    // 3. 去除职业/称呼后缀：如 "赵总" -> "赵", "王经理" -> "王"
    const stem = rawName.replace(/(?:总|经理|队长|医生|老师|少爷|夫人|护士|警官|阿姨|叔叔|哥哥|姐姐|妹妹|弟弟)$/, '').trim();
    if (stem && stem.length >= 2 && script.includes(stem)) return true;

    // 4. 分割连接符
    const parts = rawName.split(/[\s·\-_/、,，:：()（）]+/).filter(w => w.length >= 2);
    if (parts.some(p => script.includes(p))) return true;

    return false;
  }

  if (type === 'prop') {
    const rawName = String(asset.name || '').trim();
    if (!rawName) return false;
    // 1. 完全包含
    if (script.includes(rawName)) return true;

    // 2. 分隔符拆分与词干提取（如 "全息通讯手环·战术版" -> "全息通讯手环", "战术版", "手环"）
    const parts = rawName.split(/[\s·\-_/、,，:：()（）]+/).filter(w => w.length >= 2);
    if (parts.some(p => script.includes(p))) return true;

    // 3. 去除常见量词与修饰后缀（如 "数学作业册" -> "数学作业"; "止血急救包" -> "止血", "急救包"）
    for (const part of parts) {
      const stem = part.replace(/(?:册|本|套|型|版|装|组|具|包|器|表|箱|支|把|条|件)$/, '');
      if (stem.length >= 2 && script.includes(stem)) return true;
    }

    // 4. 滑动 n-gram（3-4 字核心短语）
    for (let len = Math.min(4, rawName.length); len >= 2; len--) {
      for (let i = 0; i <= rawName.length - len; i++) {
        const sub = rawName.slice(i, i + len);
        if (script.includes(sub)) {
          if (!['一个', '这个', '那个', '物品', '东西', '道具'].includes(sub)) {
            return true;
          }
        }
      }
    }

    return false;
  }

  if (type === 'scene') {
    const loc = String(asset.location || '').trim();
    if (!loc) return false;
    // 1. 完全包含
    if (script.includes(loc)) return true;

    // 2. 分隔符拆分（支持 · - _ / 空格 顿号 等）
    const parts = loc.split(/[\s·\-_/、,，:：()（）]+/).filter(w => w.length >= 2);
    for (const part of parts) {
      if (script.includes(part)) return true;
      // 去除常见地点修饰后缀（如 "区", "室", "处", "角", "旁", "带", "门", "厅", "房", "部", "地", "线"）
      // 例如 "书桌区" -> "书桌"; "撤离区" -> "撤离"; "学习区" -> "学习"
      const stem = part.replace(/(?:区|室|处|角|旁|带|厅|部|地|界|线|门|面)$/, '');
      if (stem.length >= 2 && script.includes(stem)) return true;
    }

    // 3. 常见复合场景名与地标名词双向匹配
    const sceneKeywords = [
      '工厂', '仓库', '书房', '书桌', '卧室', '客厅', '厨房', '会议室', '办公室',
      '走廊', '走道', '大厅', '天台', '楼道', '楼梯', '地下室', '停车场', '车库',
      '战场', '营地', '基地', '控制室', '指挥部', '实验室', '病房', '诊所', '教室',
      '操场', '街区', '街道', '巷口', '码头', '森林', '荒野', '洞穴', '断墙', '高台',
      '掩体', '电脑房', '学习区', '儿童房', '通道', '入口', '外围', '内院', '花坛'
    ];
    for (const kw of sceneKeywords) {
      if (loc.includes(kw) && script.includes(kw)) {
        return true;
      }
    }

    // 4. 滑动窗口 / N-gram 智能匹配（4字、3字、2字）
    // 针对任意复合场景名（如 "废弃工厂内部战斗区" -> "废弃工厂"）
    const stopWords = new Set(['内部', '外部', '中心', '周围', '附近', '一角', '里面', '外面', '双人', '单人', '前面', '后面']);
    for (let len = Math.min(6, loc.length); len >= 2; len--) {
      for (let i = 0; i <= loc.length - len; i++) {
        const sub = loc.slice(i, i + len);
        if (!stopWords.has(sub) && script.includes(sub)) {
          return true;
        }
      }
    }

    return false;
  }

  return false;
}

/**
 * 安全解析时间字符串
 * @param {string|Date|number} dateStr
 * @returns {Date|null}
 */
function parseSafeDate(dateStr) {
  if (!dateStr) return null;
  if (dateStr instanceof Date) return isNaN(dateStr.getTime()) ? null : dateStr;
  let s = String(dateStr).trim();
  if (s.includes(' ') && !s.includes('T')) s = s.replace(' ', 'T');
  if (!/[Zz]|[+-]\d{2}(?::?\d{2})?$/.test(s)) s += 'Z';
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * 判断资产是否处于新建保护期（默认20分钟以内）
 * @param {object} asset
 * @param {number} [graceMinutes=20]
 * @returns {boolean}
 */
function isAssetRecentlyCreated(asset, graceMinutes = 20) {
  if (!asset || !asset.created_at) return false;
  const d = parseSafeDate(asset.created_at);
  if (!d) return false;
  return (Date.now() - d.getTime()) < graceMinutes * 60 * 1000;
}

/**
 * 判断资产是否在分镜列表中被引用
 * @param {'character'|'prop'|'scene'} type
 * @param {number|string} assetId
 * @param {Array<object>} [shots=[]]
 * @returns {boolean}
 */
function isAssetUsedInShots(type, assetId, shots = []) {
  if (!assetId || !Array.isArray(shots) || shots.length === 0) return false;
  const targetId = Number(assetId);

  if (type === 'character') {
    return shots.some(s => {
      if (!s.characters) return false;
      if (Array.isArray(s.characters)) {
        return s.characters.some(c => Number(typeof c === 'object' && c != null ? c.id : c) === targetId);
      }
      if (typeof s.characters === 'string') {
        try {
          const parsed = JSON.parse(s.characters);
          if (Array.isArray(parsed)) {
            return parsed.some(c => Number(typeof c === 'object' && c != null ? c.id : c) === targetId);
          }
        } catch (_) {}
      }
      return false;
    });
  }

  if (type === 'prop') {
    return shots.some(s => {
      const pids = Array.isArray(s.prop_ids) ? s.prop_ids : [];
      return pids.some(pid => Number(pid) === targetId);
    });
  }

  if (type === 'scene') {
    return shots.some(s => s.scene_id != null && Number(s.scene_id) === targetId);
  }

  return false;
}

/**
 * 综合判定资产是否为过时/孤儿资产
 * 规则：
 * 1. 处于新建保护期内（刚生成/刚提取） => 绝不过时
 * 2. 剧本正文有提及 => 不过时
 * 3. 任何分镜中有引用 => 不过时
 * 4. 仅当在剧本无提及且分镜无引用且不在保护期时 => 确认为过时资产
 */
function isAssetObsolete(type, asset, options = {}) {
  const {
    script = '',
    shots = [],
    graceMinutes = 20,
    ignoreGrace = false,
  } = options;

  if (!asset) return false;
  if (!ignoreGrace && isAssetRecentlyCreated(asset, graceMinutes)) {
    return false;
  }

  const inScript = isAssetMentionedInText(type, asset, script);
  if (inScript) return false;

  const inShots = isAssetUsedInShots(type, asset.id, shots);
  if (inShots) return false;

  return true;
}

module.exports = {
  isAssetMentionedInText,
  isAssetRecentlyCreated,
  isAssetUsedInShots,
  isAssetObsolete,
};
