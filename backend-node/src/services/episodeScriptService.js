const aiClient = require('./aiClient');
const promptI18n = require('./promptI18n');
const { loadConfig } = require('../config');
const { safeParseAIJSON } = require('../utils/safeJson');
const { normalizeDurationRange } = require('../utils/shotDurationRange');

function getEpisode(db, episodeId) {
  const id = Number(episodeId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('分集不存在');
  const episode = db.prepare(`SELECT e.*, d.description AS story_premise, d.metadata AS drama_metadata
    FROM episodes e JOIN dramas d ON d.id = e.drama_id
    WHERE e.id = ? AND e.deleted_at IS NULL AND d.deleted_at IS NULL`).get(id);
  if (!episode) throw new Error('分集不存在');
  return episode;
}

// Returns a draft only. No episodes, storyboards, assets or project settings are written.
async function generateEpisodeDraft(db, log, episodeId, body = {}) {
  const episode = getEpisode(db, episodeId);
  let cfg = loadConfig();
  const en = promptI18n.isEnglish(cfg);
  let metadata = {};
  try { metadata = JSON.parse(episode.drama_metadata || '{}'); } catch { /* legacy metadata */ }
  cfg = require('./narrativeStyleService').withConfig(cfg, metadata);
  const durationRange = normalizeDurationRange(metadata.shot_duration_range, metadata.video_clip_duration);
  const characters = db.prepare(`SELECT name, description FROM characters
    WHERE drama_id = ? AND deleted_at IS NULL ORDER BY id`).all(episode.drama_id);
  const previous = db.prepare(`SELECT episode_number, title, script_content FROM episodes
    WHERE drama_id = ? AND deleted_at IS NULL AND episode_number < ?
    ORDER BY episode_number DESC LIMIT 1`).get(episode.drama_id, episode.episode_number);
  const next = db.prepare(`SELECT episode_number, title, script_content FROM episodes
    WHERE drama_id = ? AND deleted_at IS NULL AND episode_number > ?
    ORDER BY episode_number ASC LIMIT 1`).get(episode.drama_id, episode.episode_number);
  const context = {
    target_episode: episode.episode_number,
    total_episodes: db.prepare('SELECT COUNT(*) AS n FROM episodes WHERE drama_id = ? AND deleted_at IS NULL').get(episode.drama_id).n,
    premise: String(body.premise || episode.story_premise || '').trim(),
    current_episode: { title: episode.title, content: episode.script_content || episode.description || '' },
    previous_episode: previous ? { title: previous.title, ending: (previous.script_content || '').slice(-1800) } : null,
    next_episode: next ? { title: next.title, opening: (next.script_content || '').slice(0, 600) } : null,
    characters,
    shot_duration_range: durationRange,
  };
  const scope = en
    ? `\n[CURRENT EPISODE ONLY — highest priority]\nRewrite only episode ${episode.episode_number}. Preserve its core plot, character names and established facts. Continue from the previous ending and leave later events to the next episode. Return exactly one JSON array item with episode=${episode.episode_number}, title and content. Do not include episode headings inside content. Typical clips last ${durationRange.min}–${durationRange.max}s: write complete natural dialogue, including longer lines and multi-turn exchanges when needed. Do not require short lines. Plan clip duration against the per-shot speech budget, reserve 1s for the ending, and split at semantic boundaries without dropping words when the duration limit is reached. Do not output other episodes.`
    : `\n【只重写当前集——最高优先级】\n只生成第${episode.episode_number}集，保留本集原稿的核心情节、人物准确全名和既定事实。衔接上一集结尾，为下一集留出衔接，不重讲第一集、不提前演完后续集。只返回含1项的JSON数组，episode必须为${episode.episode_number}，另含title、content。content内不加第N集标题或分集标记。项目每镜${durationRange.min}–${durationRange.max}秒，对白以剧情表达完整为先，可有较长台词和多轮交流，不要求每句简短；按自然语速和实际时间轴分配时长，不预留固定收尾静音，超出上限时按语义连贯拆镜，不删字、不硬塞一镜。不要输出其他集。`;
  const systemPrompt = promptI18n.getStoryExpansionSystemPrompt(cfg, 1) + scope;
  const userPrompt = (en ? 'Rewrite using this episode context:\n' : '请按以下分集上下文重写当前集：\n') + JSON.stringify(context);
  const raw = await aiClient.generateText(db, log, 'text', userPrompt, systemPrompt, {
    scene_key: 'story_generation', model: body.model || undefined, temperature: 0.7, min_max_tokens: 3000,
  });
  const parsed = safeParseAIJSON(raw, log);
  const items = Array.isArray(parsed) ? parsed : parsed?.episodes;
  const draft = items?.[0];
  if (!Array.isArray(items) || items.length !== 1 || Number(draft?.episode) !== episode.episode_number ||
      typeof draft.content !== 'string' || !draft.content.trim()) {
    throw new Error('AI 未返回有效的当前集剧本，原剧本未修改，请重试');
  }
  return {
    episode_id: episode.id, episode_number: episode.episode_number,
    title: typeof draft.title === 'string' && draft.title.trim() ? draft.title.trim() : episode.title,
    script_content: draft.content.trim(),
  };
}

function saveEpisodeScript(db, episodeId, body = {}) {
  const episode = getEpisode(db, episodeId);
  if (typeof body.script_content !== 'string' || !body.script_content.trim()) throw new Error('剧本内容必填');
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare('UPDATE episodes SET title = ?, script_content = ?, updated_at = ? WHERE id = ?').run(
      typeof body.title === 'string' && body.title.trim() ? body.title.trim() : episode.title,
      body.script_content.trim(), now, episode.id);
    db.prepare('UPDATE dramas SET updated_at = ? WHERE id = ?').run(now, episode.drama_id);
  })();
  return { episode_id: episode.id, episode_number: episode.episode_number };
}

module.exports = { generateEpisodeDraft, saveEpisodeScript };
