const aiClient = require('./aiClient');
const promptI18n = require('./promptI18n');
const { buildUniversalSegmentUserPromptBundle } = require('./universalSegmentPromptBundle');
const { normalizeUniversalSegmentShotDurations } = require('./universalSegmentDurationNormalize');
const { stripChineseExclusions } = require('../utils/framePromptSanitize');

/** 润色接口：邻镜结构化摘要（含全能片段与其它提示词字段） */
function formatNeighborShotPolishContext(row) {
  if (!row) return '(none)';
  const chunk = (k, v) => {
    const s = v != null && String(v).trim() ? String(v).trim() : '';
    return s ? `${k}: ${s}` : null;
  };
  const bits = [
    chunk('SHOT_NUM', row.storyboard_number),
    chunk('TITLE', row.title),
    chunk('DESCRIPTION', row.description),
    chunk('ACTION', row.action),
    chunk('DIALOGUE', row.dialogue),
    chunk('NARRATION', row.narration),
    chunk('VIDEO_PROMPT', row.video_prompt),
    chunk('UNIVERSAL_SEGMENT_TEXT', row.universal_segment_text),
  ].filter(Boolean);
  return bits.length ? bits.join('\n') : '(empty)';
}

/** 全能片段：@图片N 与中英字、引号之间补半角空格，便于模型与接口解析 */
function normalizeUniversalSegmentAtImageSpacing(text) {
  if (!text || typeof text !== 'string') return text;
  return text.replace(
    /@图片(\d+)(?=[\u4e00-\u9fffA-Za-z「『【（])/gu,
    '@图片$1 '
  );
}

async function polishUniversalSegment(db, log, sbId, body, { onStart, onDelta } = {}) {
  const draftRaw =
    body && body.draft_universal_segment_text != null
      ? String(body.draft_universal_segment_text)
      : '';
  const draft = draftRaw.trim();
  if (!draft) {
    throw new Error('请先填写或生成全能片段描述后再润色（编辑器内容不能为空）');
  }
  const built = buildUniversalSegmentUserPromptBundle(db, sbId, body || {}, {
    universalSegmentOverride: draftRaw,
  });
  if (!built.ok) {
    throw Object.assign(new Error(built.message), { code: built.code });
  }
  const { userPrompt: baseUser, durationLabel, durationSec, episodeId, storyboardNumber } = built;

  let scriptText = '';
  try {
    const ep = db
      .prepare('SELECT script_content, title FROM episodes WHERE id = ? AND deleted_at IS NULL')
      .get(episodeId);
    scriptText = (ep?.script_content && String(ep.script_content).trim()) || '';
  } catch (_) {}

  let prevRow = null;
  let nextRow = null;
  try {
    prevRow = db
      .prepare(
        `SELECT storyboard_number, title, description, action, dialogue, narration, video_prompt, universal_segment_text
         FROM storyboards WHERE episode_id = ? AND storyboard_number < ? AND deleted_at IS NULL
         ORDER BY storyboard_number DESC LIMIT 1`
      )
      .get(episodeId, storyboardNumber);
    nextRow = db
      .prepare(
        `SELECT storyboard_number, title, description, action, dialogue, narration, video_prompt, universal_segment_text
         FROM storyboards WHERE episode_id = ? AND storyboard_number > ? AND deleted_at IS NULL
         ORDER BY storyboard_number ASC LIMIT 1`
      )
      .get(episodeId, storyboardNumber);
  } catch (_) {}

  const userFeedback = (body?.user_feedback || body?.direction || body?.instruction || body?.feedback || '').toString().trim();
  const polishPassStamp = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  const polishUserPrompt = [
    'TASK: POLISH_UNIVERSAL_OMNI_SEGMENT',
    `POLISH_PASS_STAMP: ${polishPassStamp}`,
    userFeedback ? `USER_MODIFICATION_DIRECTIVE（用户特别调整意见/创作指令·最高优先级·必须严格遵循并在成稿中重点体现）:\n${userFeedback}` : null,
    'POLISH_REFRESH（多次点击「润色」时强制）: 在严格遵守 MULTI_BEAT_OUTPUT、子分镜秒数之和=TOTAL_CLIP_SECONDS、IMAGE_SLOT_MAP、不编造剧本外情节的前提下，**本轮输出须与 CURRENT_OMNI_DRAFT 在中文表述上有明显差异**（换动词/语序、合并或拆分从句、加强或收紧运镜与情绪描写均可；**第3行仍须与 LINE3_REQUIRED 完全一致**）。除第3行外，**禁止**与草稿逐字相同或仅标点差异；若 M 与秒数分配不变，子分镜正文也须重写措辞。',
    'DIALOGUE_RETENTION（硬性，与 system 全能润色一致）: BASE_OMNI_CONTRACT 内 STORYBOARD FIELDS 的 DIALOGUE、NARRATION、VIDEO_PROMPT 及 CURRENT_OMNI_DRAFT 中一切对白/旁白/引号句，成稿各「分镜k」行须**逐条以「」或明确旁白写出**，保留笑点、数字、剧名、奖项名等关键信息；禁止用「两人对话」「念词带过」等概括替代具体台词。总秒数与各 Tk 不变前提下提高信息密度：台词与反应优先，少写无推进的纯氛围叠句。',
    'You are refining the CURRENT omni multi-beat prompt for a short drama vertical-video shot.',
    `FULL_EPISODE_SCRIPT（本集完整剧本，用于信息对齐与连戏；不得引入剧本未写的情节）:\n${scriptText || '(本集剧本正文为空，请仅依据下方 STORYBOARD FIELDS 与邻镜信息)'}`,
    '',
    'NEIGHBOR_PREV（上一分镜：含其全能片段与其它提示词字段，供衔接）:',
    formatNeighborShotPolishContext(prevRow),
    '',
    'NEIGHBOR_NEXT（下一分镜）:',
    formatNeighborShotPolishContext(nextRow),
    '',
    'CURRENT_OMNI_DRAFT（用户当前全能片段文本，必须在此基础上增强而非另起无关故事）:',
    draft,
    '',
    '--- BASE_OMNI_CONTRACT（与生成接口相同的约束与分镜字段块）---',
    baseUser,
  ].filter(Boolean).join('\n');

  onStart?.();
  const finalRaw = await aiClient.streamGenerateText(
      db,
      log,
      'text',
      polishUserPrompt,
      promptI18n.getUniversalOmniPolishPrompt(),
      {
        scene_key: 'image_polish',
        max_tokens: 4096,
        temperature: 0.52,
        silence_timeout_ms: 180000,
      },
      delta => onDelta?.(delta)
    );
  if (!finalRaw || String(finalRaw).trim().length < 20) {
    throw new Error('AI 返回内容过短，请检查文本模型配置');
  }
  let text = String(finalRaw).trim();
  text = stripChineseExclusions(text);
  text = normalizeUniversalSegmentShotDurations(text, durationLabel, durationSec);
  text = normalizeUniversalSegmentAtImageSpacing(text);
  const nowIso = new Date().toISOString();
  db.prepare('UPDATE storyboards SET universal_segment_text = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').run(
    text,
    nowIso,
    sbId
  );
  log.info('[分镜] polishUniversalSegmentStream 完成', { id: sbId, len: text.length, duration_sec: durationSec });
  return text;
}

module.exports = { polishUniversalSegment, normalizeUniversalSegmentAtImageSpacing };
