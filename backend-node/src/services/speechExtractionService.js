const { createHash } = require('crypto');
const { safeParseAIJSON } = require('../utils/safeJson');

function parseJson(value) { try { return JSON.parse(value || '{}'); } catch (_) { return {}; } }
function sourceHash(shot) {
  return createHash('sha256').update(JSON.stringify([shot.dialogue, shot.narration, shot.universal_segment_text, shot.description, shot.action, shot.title])).digest('hex');
}
function isNarrator(name) { return /^(?:旁白|解说|解说旁白|画外音|旁白解说|narrator|narration|voice[- ]?over)$/iu.test(name || ''); }
function meaningful(text) { return text?.trim() && !/^(?:无|无对白|无对话|无台词|无旁白|无解说|none|null|silent)[。.!！\s]*$/iu.test(text.trim()); }
function plainText(value) {
  return String(value || '').replace(/^[“”"「」『』']+|[“”"「」『』']+$/gu, '')
    .replace(/[（(](?:停顿|低声|大喊|小声|笑着|叹气|哭着|温柔|愤怒|pause|sigh)[^）)]*[）)]/giu, '').trim();
}
function cache(db, dramaId, shot) {
  const row = db.prepare('SELECT metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(Number(dramaId));
  const stored = parseJson(row?.metadata).tts_speech_plans?.[shot.id];
  return stored?.source_hash === sourceHash(shot) ? stored : null;
}
function automaticPlan(db, dramaId, shot, parseDialogue) {
  const saved = cache(db, dramaId, shot);
  if (saved) return saved;
  const segments = [];
  for (const line of parseDialogue(shot.dialogue)) {
    const text = plainText(line.text);
    if (!meaningful(text)) continue;
    segments.push({ kind: isNarrator(line.speaker) ? 'narration' : 'dialogue', speaker: isNarrator(line.speaker) ? '' : line.speaker, text });
  }
  if (meaningful(shot.narration)) {
    const text = plainText(shot.narration.replace(/^\s*(?:旁白|解说|解说旁白|画外音)\s*[：:]\s*/u, ''));
    if (!segments.some(s => s.kind === 'narration' && s.text === text)) segments.push({ kind: 'narration', speaker: '', text });
  }
  return { source_hash: sourceHash(shot), segments, method: 'labels' };
}
function needsModel(shot, plan) {
  if (['model', 'edited'].includes(plan.method)) return false;
  if (plan.segments.some(s => s.kind === 'dialogue' && (!s.speaker || /(?:说(?:道|着)?|回答|问道|喊道)$/u.test(s.speaker) || /[\s，,。！？!?；;][\p{L}\p{N}·]{1,24}\s*[：:]/u.test(s.text)))) return true;
  return !plan.segments.length && /对白|对话|旁白|说[：:“"]|dialogue|narration/iu.test(shot.universal_segment_text || '');
}
function savePlan(db, dramaId, shot, plan) {
  const current = db.prepare('SELECT * FROM storyboards WHERE id = ? AND deleted_at IS NULL').get(shot.id);
  if (!current || sourceHash(current) !== sourceHash(shot)) throw new Error('提取期间分镜文案已变更，请重试');
  const metadata = parseJson(db.prepare('SELECT metadata FROM dramas WHERE id = ?').get(Number(dramaId))?.metadata);
  metadata.tts_speech_plans = { ...(metadata.tts_speech_plans || {}), [shot.id]: plan };
  db.prepare('UPDATE dramas SET metadata = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(metadata), new Date().toISOString(), Number(dramaId));
}
async function ensurePlan(db, log, dramaId, shot, parseDialogue, forceModel = false) {
  const initial = automaticPlan(db, dramaId, shot, parseDialogue);
  if (!forceModel && !needsModel(shot, initial)) return initial;
  const characters = db.prepare('SELECT name FROM characters WHERE drama_id = ? AND deleted_at IS NULL').all(Number(dramaId)).map(c => c.name);
  const structured = meaningful(shot.dialogue) || meaningful(shot.narration);
  const speechSource = structured ? [shot.dialogue, shot.narration].filter(Boolean).join('\n')
    : (shot.universal_segment_text || [shot.description, shot.action].filter(Boolean).join('\n'));
  const input = { characters, storyboard: structured
    ? { dialogue: shot.dialogue, narration: shot.narration }
    : { source_text: speechSource } };
  const raw = await require('./aiClient').generateText(db, log, 'text', JSON.stringify(input),
    '你是配音台词提取器。只从分镜已经存在的明确对白与解说中提取，禁止创作、改写、摘要或补充台词，不要把动作、景物、镜头标题当旁白。返回 JSON：{"segments":[{"kind":"dialogue","speaker":"人物姓名","text":"实际朗读台词"},{"kind":"narration","speaker":"","text":"实际旁白"}]}。保持台词顺序。speaker 优先匹配给定人物名，也可保留原文明示的其他说话者。text 不得包含角色名标签、冒号前缀、表演说明或外层引号。没有旁白就不添加旁白；没有说话内容返回空数组。', { temperature: 0.1 });
  const parsed = safeParseAIJSON(raw);
  if (!Array.isArray(parsed?.segments)) throw new Error('模型未返回有效配音清单');
  const source = speechSource.replace(/\s+/gu, '');
  const segments = parsed.segments.map(item => {
    if (!['dialogue', 'narration'].includes(item.kind) || typeof item.text !== 'string' || typeof item.speaker !== 'string') throw new Error('模型配音清单格式无效');
    const text = plainText(item.text);
    if (!text || !source.includes(text.replace(/\s+/gu, ''))) throw new Error('提取台词与分镜原文不符，已停止，避免读出改写内容');
    const speaker = item.kind === 'narration' || isNarrator(item.speaker) ? '' : item.speaker.trim();
    if (speaker && text.startsWith(speaker + '：')) throw new Error('模型把角色标签混入朗读内容，请重试提取');
    return { kind: item.kind === 'narration' || isNarrator(item.speaker) ? 'narration' : 'dialogue', speaker, text };
  });
  const spoken = segments.map(s => s.text).join('').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
  let cursor = 0;
  for (const quoted of speechSource.matchAll(/[“"「『]([^”"」』]+)[”"」』]/gu)) {
    const words = quoted[1].replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
    if (!words) continue;
    const position = spoken.indexOf(words, cursor);
    if (position < 0) throw new Error('模型遗漏或打乱了原文中的台词，请重试提取');
    cursor = position + words.length;
  }
  if (initial.segments.length && !segments.length) throw new Error('模型遗漏了已有台词，请重试提取');
  const plan = { source_hash: sourceHash(shot), segments, method: 'model' };
  savePlan(db, dramaId, shot, plan);
  return plan;
}
function recordAudio(db, dramaId, shot, result, kind) {
  if (!dramaId || !result.speech_plan || !result.parts) return;
  const plan = cache(db, dramaId, shot) || result.speech_plan;
  plan.audio_by_kind = { ...(plan.audio_by_kind || {}), [kind]: { local_path: result.local_path, parts: result.parts } };
  savePlan(db, dramaId, shot, plan);
}
function orderedAudioFiles(db, shotId, row) {
  const shot = db.prepare('SELECT s.*, e.drama_id FROM storyboards s JOIN episodes e ON e.id=s.episode_id WHERE s.id=? AND s.deleted_at IS NULL').get(Number(shotId));
  if (!shot) return null;
  const plan = cache(db, shot.drama_id, shot);
  if (!plan?.audio_by_kind) return null;
  const rendered = plan.audio_by_kind;
  if (plan.segments.some(s => s.kind === 'dialogue') && rendered.dialogue?.local_path !== row.audio_local_path) return null;
  if (plan.segments.some(s => s.kind === 'narration') && rendered.narration?.local_path !== row.narration_audio_local_path) return null;
  const parts = [...(rendered.dialogue?.parts || []), ...(rendered.narration?.parts || [])];
  const files = plan.segments.map((segment, index) => parts.find(p => p.index === index)?.local_path);
  return files.length && files.every(Boolean) ? files : null;
}
module.exports = { recordAudio, orderedAudioFiles, automaticPlan, ensurePlan, needsModel, meaningful, sourceHash, isNarrator };
