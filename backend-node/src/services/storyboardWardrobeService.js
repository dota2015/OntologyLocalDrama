const { safeParseAIJSON, extractFirstArray } = require('../utils/safeJson');
const { preservesSpeech } = require('./storyboardSpeechService');
const wardrobe = require('./wardrobeService');

function splitReason(shot) {
  const change = shot.wardrobe_change;
  if (change && (!Array.isArray(change.characters) || !change.characters.length)) throw new Error('换装选择需包含本镜人物和新造型；没有切换时请省略 wardrobe_change');
  if (shot.wardrobe_transition || (change?.boundary && change.boundary !== 'before_shot')) return '造型变化被安排在同一镜头内';
  const ids = new Set();
  for (const c of change?.characters || []) {
    if (!c || typeof c !== 'object') throw new Error('换装人物选择格式无效');
    const id = Number(c.character_id);
    if (ids.has(id) || Array.isArray(c.stage_id) || c.first_stage_id != null || c.last_stage_id != null) return '同一人物在一个镜头选择了多套造型';
    ids.add(id);
  }
  const action = String(shot.action || '');
  if (/(?:换上|脱下|穿上|更换).{0,8}(?:衣|服|装|外套|制服|鞋|帽|裤|裙|衫|披风)|变装|换装过程|(?:衣服|服装|衣着).{0,12}(?:变成|变为|渐变)|(?:puts? on|takes? off|changes? into).{0,35}(?:shirt|jacket|uniform|clothes|outfit)|costume transformation/iu.test(action)) return '动作包含穿脱或镜内变装';
  if (change && /进入光门.*(?:走出|抵达|出现)|从现实.*(?:进入|来到|抵达).*三角洲/u.test(action)) return '一次换装跨越了旧造型与新造型两个场面';
  return '';
}
function assertSingleOutfit(shot) {
  const reason = splitReason(shot);
  if (reason) throw new Error(`${reason}：每个分镜只使用一套造型，请拆成旧造型与新造型的连续分镜`);
}
function validateChoices(db, dramaId, shot, episodeId) {
  if (shot.wardrobe_change && episodeId) {
    const source = db.prepare('SELECT script_content FROM episodes WHERE id=? AND drama_id=? AND deleted_at IS NULL').get(Number(episodeId), Number(dramaId));
    const evidence = shot.wardrobe_change.evidence;
    if (typeof evidence !== 'string' || evidence.trim().length < 6 || !String(source?.script_content || '').includes(evidence.trim())) throw new Error('换装依据需逐字引用本集剧本中的剧情事件，原分镜保留');
  }
  for (const choice of shot.wardrobe_change?.characters || []) {
    const person = wardrobe.getCharacter(db, dramaId, choice.character_id);
    if (Array.isArray(shot.characters) && !shot.characters.some(c => Number(c?.id ?? c) === Number(choice.character_id))) throw new Error('造型人物必须属于本镜出场人物');
    if (choice.stage_id && !person.stages.some(s => s.id === choice.stage_id)) throw new Error(`人物「${person.name}」的造型不存在，请使用本剧造型库中的编号`);
    if (!choice.stage_id && (typeof choice.description !== 'string' || !choice.description.trim())) throw new Error('换装需选择已有造型或填写明确的服装描述');
  }
}
async function enforceSingleOutfit(storyboards, { db, dramaId, episodeId, generate, onRepair = () => {} }) {
  const output = [];
  for (const source of storyboards) {
    const reason = splitReason(source);
    if (!reason) { validateChoices(db, dramaId, source, episodeId); output.push(source); continue; }
    onRepair(source, reason);
    let repaired = null, lastError = reason;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await generate(`将此镜头拆成至少两个连续分镜，衣服变化发生在镜头之间，不显示穿脱或衣服渐变。只返回 JSON 数组，保留原分镜字段结构。逐字完整分配原对白和旁白，保持说话人、顺序、剧情因果及人物身份；不能删改或重复台词。旧造型镜头保留原服装，新造型镜头开始时已经穿着新服装；只在新造型首次出现的镜头声明 wardrobe_change，boundary 必须为 before_shot。每镜使用一个场景、同一人物只选一套造型。不要输出旧 universal_segment_text/video_prompt/image_prompt，它们由系统重建。\n原分镜：${JSON.stringify(source)}\n上次校验：${lastError}`, wardrobe.planningContext(db, dramaId));
        const parsed = safeParseAIJSON(raw);
        const items = Array.isArray(parsed) ? parsed : extractFirstArray(parsed);
        if (!items || items.length < 2 || items.some(s => !s || typeof s !== 'object' || Array.isArray(s))) throw new Error('换装至少拆为两个有效分镜');
        if (!preservesSpeech(source, items)) throw new Error('换装拆镜遗漏、重复或改写了原对白/旁白');
        repaired = items.map(item => {
          const shot = { ...source, ...item, dialogue: item.dialogue || '', narration: item.narration || '' };
          for (const key of ['wardrobe_transition', 'universal_segment_text', 'video_prompt', 'image_prompt']) delete shot[key];
          if (!item.wardrobe_change) delete shot.wardrobe_change;
          assertSingleOutfit(shot);
          validateChoices(db, dramaId, shot, episodeId);
          return shot;
        });
        break;
      } catch (error) { repaired = null; lastError = error.message; }
    }
    if (!repaired) throw new Error(`换装拆镜校验失败，原分镜保留：${lastError}`);
    output.push(...repaired);
  }
  return output;
}
module.exports = { splitReason, assertSingleOutfit, validateChoices, enforceSingleOutfit };
