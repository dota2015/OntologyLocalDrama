const { parse } = require('./narrativeStyleService');
const { readStages, episodeStage } = require('../utils/characterStages');
function project(db, dramaId) {
  const row = db.prepare('SELECT id,metadata FROM dramas WHERE id=? AND deleted_at IS NULL').get(Number(dramaId));
  if (!row) throw new Error('项目不存在');
  return { ...row, metadata: parse(row.metadata) };
}
function shotProject(db, shotId) {
  const shot = db.prepare(`SELECT s.*,e.drama_id FROM storyboards s JOIN episodes e ON e.id=s.episode_id
    WHERE s.id=? AND s.deleted_at IS NULL AND e.deleted_at IS NULL`).get(Number(shotId));
  if (!shot) throw new Error('分镜不存在或已删除');
  return { shot, drama: project(db, shot.drama_id) };
}
function characterIds(db, shot) {
  const raw = parse(shot.characters);
  if (Array.isArray(raw)) return [...new Set(raw.map(x => Number(x?.id ?? x)).filter(x => x > 0))];
  return db.prepare('SELECT character_id FROM storyboard_characters WHERE storyboard_id=?').all(shot.id).map(r => r.character_id);
}
function mutate(db, dramaId, fn) {
  db.transaction(() => {
    const { metadata } = project(db, dramaId);
    const wardrobe = { ...metadata.wardrobe, characters: { ...metadata.wardrobe?.characters }, changes: { ...metadata.wardrobe?.changes } };
    fn(wardrobe);
    metadata.wardrobe = wardrobe;
    db.prepare('UPDATE dramas SET metadata=?,updated_at=? WHERE id=?').run(JSON.stringify(metadata),new Date().toISOString(),Number(dramaId));
  })();
}
function text(value, limit) {
  if (value != null && typeof value !== 'string') throw new Error('服装描述必须为文字');
  const result = (value || '').trim();
  if (result.length > limit) throw new Error('服装描述过长');
  return result;
}
function getCharacter(db, dramaId, characterId) {
  const drama = project(db,dramaId);
  const c=db.prepare('SELECT * FROM characters WHERE id=? AND drama_id=? AND deleted_at IS NULL').get(Number(characterId),drama.id);
  if (!c) throw new Error('人物不属于当前项目或已删除');
  return { id:c.id,name:c.name,description:drama.metadata.wardrobe?.characters?.[c.id]?.description || '',
    reference_url:c.local_path ? '/static/'+c.local_path : c.ref_image || c.image_url || '', stages:readStages(c.stages) };
}
function saveCharacter(db, dramaId, characterId, body) {
  const c=getCharacter(db,dramaId,characterId);
  const description=text(body.description,1500);
  mutate(db,dramaId,w=>{w.characters[c.id]={description};});
  return getCharacter(db,dramaId,characterId);
}
function getShot(db, shotId) {
  const {shot,drama}=shotProject(db,shotId);
  const wardrobe=drama.metadata.wardrobe || {};
  const people=characterIds(db,shot).flatMap(id=>{
    const c=db.prepare('SELECT * FROM characters WHERE id=? AND drama_id=? AND deleted_at IS NULL').get(id,drama.id);
    return c ? [{id:c.id,name:c.name,stages:readStages(c.stages)}] : [];
  });
  const timeline=db.prepare(`SELECT s.id,s.episode_id,s.storyboard_number,e.episode_number FROM storyboards s JOIN episodes e ON e.id=s.episode_id
    WHERE e.drama_id=? AND e.deleted_at IS NULL AND s.deleted_at IS NULL ORDER BY e.episode_number,e.id,s.storyboard_number,s.id`).all(drama.id);
  const effective=new Map(people.map(c=>[c.id,{description:wardrobe.characters?.[c.id]?.description || '',stage_id:null,stage_name:'默认造型',reference_image:'',source_storyboard_id:null,source:'default'}]));
  let episodeId=null,reset=false;
  const applyStage=(stage,sourceId,source)=>({description:stage.appearance,stage_id:stage.id,stage_name:stage.name,reference_image:stage.reference_image || '',source_storyboard_id:sourceId,source});
  for (const entry of timeline) {
    let changed=false;
    if (entry.episode_id!==episodeId) {
      for (const c of people) {
        const stage=episodeStage(c.stages,entry.episode_number);
        if (stage) {
          if (effective.get(c.id).stage_id!==stage.id) changed=true;
          effective.set(c.id,applyStage(stage,null,'episode_range'));
        }
      }
      episodeId=entry.episode_id;
    }
    const change=wardrobe.changes?.[entry.id];
    if (change?.reason) for (const choice of change.characters || []) {
      const c=people.find(c=>c.id===Number(choice.character_id));
      if (!c) continue;
      const stage=c.stages.find(s=>s.id===choice.stage_id);
      effective.set(c.id,stage ? applyStage(stage,entry.id,change.source || 'manual') : {
        description:choice.description || '',stage_id:choice.stage_id || null,stage_name:choice.stage_id?'已移除造型（保留原描述）':'自定义造型',reference_image:'',
        source_storyboard_id:entry.id,source:change.source || 'manual',stage_missing:!!choice.stage_id,
      });
      changed=true;
    }
    if (entry.id===shot.id) {reset=changed;break;}
  }
  return {drama_id:drama.id,storyboard_id:shot.id,characters:people.map(c=>({...c,...effective.get(c.id)})),
    change:wardrobe.changes?.[shot.id] || null,continuity_reset:reset};
}
function saveShot(db, shotId, body) {
  const current=getShot(db,shotId);
  if (!body.change) {
    mutate(db,current.drama_id,w=>{delete w.changes[shotId];});
    return getShot(db,shotId);
  }
  if (body.change.boundary && body.change.boundary!=='before_shot') throw new Error('一个分镜只能使用一套造型；换装过程请拆成多个分镜，在新镜头开始前选择新造型');
  const reason=text(body.change.reason,1000);
  if (!reason) throw new Error('请说明换装或时间线变化的剧情原因');
  if (!Array.isArray(body.change.characters) || !body.change.characters.length) throw new Error('请填写变化后的人物服装');
  const used=new Set();
  const characters=body.change.characters.map(c=>{
    const id=Number(c.character_id),person=current.characters.find(x=>x.id===id);
    if (!person || used.has(id) || c.first_stage_id!=null || c.last_stage_id!=null || Array.isArray(c.stage_id)) throw new Error('换装人物必须属于本镜，每个人物只能选择一套造型；需要换装请拆镜');
    const stage=c.stage_id ? person.stages.find(s=>s.id===c.stage_id) : null;
    if (c.stage_id && !stage) throw new Error('所选人物造型不存在，请刷新后重新选择');
    const description=stage ? stage.appearance : text(c.description,1500);
    if (!description) throw new Error('请选择人物造型或填写服装描述');
    used.add(id);return {character_id:id,description,...(stage?{stage_id:stage.id}:{})};
  });
  mutate(db,current.drama_id,w=>{w.changes[shotId]={boundary:'before_shot',reason,characters,source:body.source==='ai'?'ai':'manual',evidence:text(body.change.evidence,1000)};});
  return getShot(db,shotId);
}
function recordAiChange(db, episodeId, shotId, aiShot) {
  const raw=aiShot.wardrobe_change;
  if (!raw) return;
  const {shot,drama}=shotProject(db,shotId);
  if (Number(episodeId)!==shot.episode_id || drama.metadata.wardrobe?.changes?.[shot.id]?.source==='manual') return;
  const episode=db.prepare('SELECT script_content FROM episodes WHERE id=?').get(shot.episode_id);
  if (typeof raw.evidence !== 'string' || raw.evidence.length>1000) return;
  const evidence=raw.evidence.trim();
  if (evidence.length<6 || !String(episode.script_content || '').includes(evidence)) return;
  // Without a verbatim source event this is never allowed to establish a new costume.
  try { saveShot(db,shotId,{change:{...raw,evidence},source:'ai'}); } catch { /* Invalid model suggestions retain inherited wardrobe. */ }
}
function promptContext(db, shotId, frameKind = 'first') {
  const state=getShot(db,shotId);
  const lines=state.characters.map(c=>`${c.name}${c.stage_id?' ['+c.stage_name+']':''}: ${c.description || '沿用本人物主参考图中既定的服装与配饰 / retain the established clothing and accessories in this character reference'}`);
  return `\n【服装连续性 / WARDROBE CONTINUITY】\n${lines.join('\n')}\n${state.change ? '本镜明确造型变化 / Explicit change: '+state.change.reason : state.continuity_reset ? '本镜按已配置的阶段造型集数范围，在镜头开始前使用新造型。' : '本镜沿用已确定造型；换场景、换集、情绪与科幻画风均不构成换装原因。 Preserve the established outfit across scene/episode changes.'}\n造型变化只发生在镜头之间；本镜开始前已完成换装，画面不展示穿脱、变装或衣服渐变；需要表现变化时拆成旧造型镜头与新造型镜头。每个人物在同一镜头及其首尾帧保持同一套服装：颜色、款式、图案、层次、鞋子、配饰一致。${frameKind==='last' ? '尾帧服装以本镜首帧的实际穿着为权威；动作与表情可变化，服装保持连续。 The first-frame image governs the ending-frame wardrobe.' : '人物参考图负责身份；明确的当前服装描述负责本时间线的着装，未指定变化时沿用参考图。 Character references govern facial identity; explicit current outfit descriptions govern clothing.'}`;
}
function hasChange(db, shotId) { const state=getShot(db,shotId);return !!state.change || state.continuity_reset; }
function planningContext(db,dramaId) {
  const {metadata}=project(db,dramaId);
  const people=db.prepare('SELECT * FROM characters WHERE drama_id=? AND deleted_at IS NULL ORDER BY id').all(Number(dramaId));
  return '\n【单镜单造型 / ONE OUTFIT PER SHOT】\n每个人物在同一分镜的首帧、尾帧和全段视频只使用一套造型，不展示穿脱、衣服渐变或镜内变装。剧情需要换装、穿越、梦境或返回现实时，必须拆为多个连续镜头：旧造型进入过渡，新镜头以新造型出现；过渡空镜按需使用。不要为了换装删改台词。使用已有 stages 的 id 选择造型，不重复创建人物。每次真正切换时输出 wardrobe_change:{boundary:"before_shot",reason,evidence,characters:[{character_id,stage_id}]}，evidence 逐字引用本集剧本中的切换依据；后续镜头继承，不重复声明换装。没有可用阶段造型时可使用 characters:[{character_id,description}] 描述明确的新服装。同一人物在一个镜头不能同时选择两套造型。集数范围只作为该集默认；多个范围重叠时不自动选定，按剧情明确选择。\nOne outfit per character per shot, identical in opening and ending frames. Split any costume transition across separate consecutive shots; the new outfit is established before the new shot starts. Preserve exact source speech.\n本剧人物造型库 / Existing character looks: '+JSON.stringify(people.map(c=>({id:c.id,name:c.name,default_outfit:metadata.wardrobe?.characters?.[c.id]?.description || '',stages:readStages(c.stages)})))+'\n本剧可用场景 / Existing scene IDs: '+JSON.stringify(db.prepare('SELECT id,location,time FROM scenes WHERE drama_id=? AND deleted_at IS NULL ORDER BY id').all(Number(dramaId)));
}
module.exports={getCharacter,saveCharacter,getShot,saveShot,recordAiChange,promptContext,hasChange,planningContext};
