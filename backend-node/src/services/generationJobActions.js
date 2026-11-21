const { resources, shots, step } = require('./generationJobService');
const taskService = require('./taskService');
const hasImage = row => !!(row?.image_url || row?.local_path);
const FRAME_TYPES = { first:['storyboard_first','first','first_frame'],last:['storyboard_last','last','tail','last_frame'],image:[] };
function metadata(db,id) { try { return JSON.parse(db.prepare('SELECT metadata FROM dramas WHERE id=?').get(id)?.metadata || '{}'); } catch (_) { return {}; } }
function frame(db,sb,slot) {
  if (slot === 'first' && sb.first_frame_image_id) {
    const bound = db.prepare("SELECT * FROM image_generations WHERE id=? AND storyboard_id=? AND status='completed' AND deleted_at IS NULL").get(sb.first_frame_image_id,sb.id);
    if (hasImage(bound)) return bound;
  }
  if (slot === 'last' && sb.last_frame_image_id) {
    const bound = db.prepare("SELECT * FROM image_generations WHERE id=? AND storyboard_id=? AND status='completed' AND deleted_at IS NULL").get(sb.last_frame_image_id,sb.id);
    if (hasImage(bound)) return bound;
  }
  const rows = db.prepare("SELECT * FROM image_generations WHERE storyboard_id=? AND status='completed' AND deleted_at IS NULL ORDER BY id DESC").all(sb.id);
  const found = rows.find(r => hasImage(r) && (slot === 'image' ? !FRAME_TYPES.last.includes(r.frame_type) && !String(r.frame_type || '').startsWith('quad_panel_') : FRAME_TYPES[slot].includes(r.frame_type)));
  if (found) return found;
  if (slot !== 'last' && (sb.image_url || /\.(png|jpe?g|webp|avif)(?:$|\?)/i.test(sb.local_path || ''))) return sb;
  if (slot === 'last' && (sb.last_frame_local_path || sb.last_frame_image_url)) return {local_path:sb.last_frame_local_path,image_url:sb.last_frame_image_url};
  return null;
}
function framePrompt(db,id,slot) {
  const fromDb = db.prepare('SELECT prompt FROM frame_prompts WHERE storyboard_id=? AND frame_type=? ORDER BY id DESC LIMIT 1').get(id,slot)?.prompt?.trim();
  if (fromDb) return fromDb;
  if (slot === 'last') {
    const sb = db.prepare('SELECT * FROM storyboards WHERE id=? AND deleted_at IS NULL').get(id);
    if (sb) {
      const { generateLastFramePrompt } = require('./episodeStoryboardService');
      const drama = db.prepare('SELECT style FROM dramas WHERE id=(SELECT drama_id FROM episodes WHERE id=?)').get(sb.episode_id);
      return generateLastFramePrompt(sb, drama?.style || '');
    }
  }
  return '';
}
function mediaUrl(row) {
  if (!row) return '';
  if (row.local_path) return '/static/' + row.local_path.replace(/^\/?static\//,'').replace(/^\//,'');
  return row.image_url || '';
}
function createExecutor(db,cfg,log) {
  function validShot(job,id) {
    const sb = db.prepare(`SELECT s.* FROM storyboards s JOIN episodes e ON s.episode_id=e.id
      WHERE s.id=? AND e.drama_id=? AND s.deleted_at IS NULL AND e.deleted_at IS NULL`).get(Number(id),job.drama_id);
    if (!sb || (job.episode_id && sb.episode_id !== job.episode_id)) throw new Error('分镜已删除或移出当前任务范围');
    return sb;
  }
  function imagePlan(job,options,sb,force=false,slotsOverride) {
    // 单镜按钮传入 slotsOverride 时尊重用户的显式操作；批量任务必须读取
    // Agent 规划 + 人工模式覆盖后的同一份 H3 执行方案，禁止再看项目全局开关。
    let slots = slotsOverride;
    if (!slots) {
      const { resolveH3SubmissionPlan, frameSlotsForPlan } = require('./h3ModeResolver');
      const plan = resolveH3SubmissionPlan(db, job.drama_id, sb, { h3_mode: options.h3_mode });
      slots = frameSlotsForPlan(plan);
    }
    return slots.filter(slot=>force || !frame(db,sb,slot)).flatMap(slot => [
      ...(slot === 'image' ? [] : [step('frame_prompt',`#${sb.storyboard_number} ${slot==='first'?'首帧':'尾帧'}提示词`,{storyboard_id:sb.id,slot,force})]),
      step('image',`#${sb.storyboard_number} ${slot==='last'?'尾帧':slot==='first'?'首帧':'分镜图'}`,{storyboard_id:sb.id,slot,force}),
    ]);
  }
  function videoDone(sb) {
    return require('./videoAcceptance').usableVideo(db, sb);
  }
  async function observe(type,id) {
    if (type === 'timer') return Number(id) > Date.now() ? {pending:true} : {};
    if (type === 'task') {
      const task = taskService.getTask(db,id);
      if (!task) return {error:'关联任务不存在或已删除'};
      if (['pending','processing','running'].includes(task.status)) return {pending:true};
      if(task.status==='completed') {
        let result;try{result=JSON.parse(task.result || '{}')}catch(_){}
        if(result?.failed) return {error:`子任务完成但有${result.failed}项失败：${(result.results || []).filter(r=>r.error).map(r=>r.error).slice(0,3).join('；')}`};
        return {};
      }
      return {error:task.error || task.message || '子任务失败'};
    }
    if (type === 'video_batch') {
      const batch = require('./videoBatchService').getBatch(db,id);
      if (!batch) return {error:'视频批次不存在'};
      if (['running','stopping'].includes(batch.status)) return {pending:true};
      return batch.status === 'completed' ? {} : {error:`视频批次${batch.status}，${batch.failed}镜失败，请补齐后合成`};
    }
    throw new Error('不支持的子任务类型');
  }
  async function execute(job,item,options,payload,attach) {
    if(item.action==='wait'){attach('timer',Date.now()+Math.max(0,Math.min(60,payload.seconds||0))*1000);return;}
    if (item.action === 'expand_references') {
      const groups = resources(db,job);
      const labels={character:'角色',scene:'场景',prop:'道具'};
      return {steps:Object.entries(groups).flatMap(([type,rows]) => options.scope && options.scope !== 'all' && options.scope !== type ? [] : rows.filter(r=>!hasImage(r)).map(r=>step('reference',`${labels[type]}：${r.name||r.location}`,{type,id:r.id})))};
    }
    if (item.action === 'expand_images') return {steps:shots(db,job,options).flatMap(sb => imagePlan(job,options,sb,!!options.force, options.slots))};
    if (item.action === 'expand_polish' && ['pipeline','repair','text_framework'].includes(job.kind) && !db.prepare("SELECT id FROM generation_job_items WHERE job_id=? AND action='extract' AND payload LIKE '%storyboards%' AND status='completed'").get(job.id)) return {skipped:true};
    if (item.action === 'expand_polish') return {steps:shots(db,job,options).filter(sb=>sb.creation_mode==='universal' && String(sb.universal_segment_text||'').trim()).map(sb=>step('polish',`#${sb.storyboard_number} 全能片段润色`,{storyboard_id:sb.id}))};
    if (item.action === 'expand_canvas') {
      const byId = new Map(shots(db,job,options).map(s=>[s.id,s]));
      return {steps:options.storyboard_ids.flatMap(id => (options.pipeline || ['image','video','audio']).flatMap(action => {
        const sb=byId.get(id);if(!sb) throw new Error('工作流分镜已删除');
        return action==='image' ? imagePlan(job,options,sb,true) : [step(action,`#${sb.storyboard_number} ${action==='video'?'视频':'配音'}`,{storyboard_id:id,force:true})];
      }))};
    }
    if (item.action === 'extract') {
      if (payload.kind === 'storyboards') {
        if (!payload.force && shots(db,job).length) return {skipped:true};
        const sbOptions = options.storyboard || options;
        const id = require('./directorTaskService').startDirectorTask(db, log, cfg, job.episode_id, { ...sbOptions, existingShotsOnly: false });
        attach('task', id);
      } else {
        if (resources(db,job)[payload.kind].length) return {skipped:true};
        let id;
        if (payload.kind === 'character') id=require('./characterGenerationService').generateCharacters(db,cfg,log,{drama_id:job.drama_id,episode_id:job.episode_id,outline:options.outline || db.prepare('SELECT script_content FROM episodes WHERE id=?').get(job.episode_id)?.script_content});
        if (payload.kind === 'scene') id=require('./backgroundExtractionService').extractBackgroundsForEpisode(db,cfg,log,job.episode_id,undefined,options.style,options.language);
        if (payload.kind === 'prop') {
          id = require('./propExtractionService').extractPropsForEpisode(db, log, job.episode_id, cfg);
        }
        attach('task',id);
      }
      return;
    }
    if (item.action === 'reference') {
      const row=resources(db,job)[payload.type]?.find(r=>r.id===payload.id);
      if(!row) throw new Error('参考素材已删除或移出当前集');
      if(hasImage(row)) return {skipped:true};
      const resourceId=payload.type==='prop' ? String(row.id) : `${payload.type}_${row.id}`;
      const active=db.prepare("SELECT id FROM async_tasks WHERE resource_id=? AND type=? AND status IN ('pending','processing') AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1").get(resourceId,payload.type==='prop'?'prop_image_generation':'image_generation');
      if(active){attach('task',active.id);return;}
      const body={style:options.style,use_quad_grid:row.reference_image_mode==='quad_grid'};
      if (payload.type === 'prop') {
        const id = require('./propImageGenerationService').generatePropImage(db, log, row.id, body);
        if (!id) throw new Error('道具生图任务未创建');
        attach('task', id);
      } else {
        const result = payload.type === 'scene'
          ? await require('./sceneReferenceGeneration').generateReferenceImage(db, log, cfg, row.id, body)
          : await require('./characterLibraryService').generateCharacterFourViewImage(db, log, cfg, row.id, undefined, body.style);
        if (!result.ok || !result.image_generation?.task_id) throw new Error(result.error || '参考图任务未创建');
        attach('task', result.image_generation.task_id);
      }
      return;
    }
    if (item.action === 'reference_barrier') {
      const missing=Object.values(resources(db,job)).flat().filter(r=>!hasImage(r));
      if(missing.length) throw new Error(`仍有${missing.length}个参考素材缺少图片，已停止后续生成`);
      return;
    }
    if (item.action === 'frame_prompt' || item.action === 'image') {
      const sb=validShot(job,payload.storyboard_id);
      if(!payload.force && frame(db,sb,payload.slot)) return {skipped:true};
      if(payload.slot==='last' && !frame(db,sb,'first')) throw new Error('首帧尚未成功，尾帧未提交');
      if(item.action==='frame_prompt') {
        if(framePrompt(db,sb.id,payload.slot)) return {skipped:true};
        // Existing prompt jobs are adopted; never send another paid call on browser refresh.
        const active=db.prepare("SELECT id FROM async_tasks WHERE resource_id=? AND type='frame_prompt_generation' AND status IN ('pending','processing') AND deleted_at IS NULL LIMIT 1").get(String(sb.id));
        if(active){attach('task',active.id);return;}
        db.transaction(()=>attach('task',require('./framePromptService').generateFramePrompt(db,log,sb.id,payload.slot,0,'')))();
        return;
      }
      const kind=payload.slot==='image' ? options.grid_mode && options.grid_mode !== 'single' ? options.grid_mode : null : `storyboard_${payload.slot}`;
      const active=db.prepare("SELECT task_id FROM image_generations WHERE storyboard_id=? AND COALESCE(frame_type,'')=COALESCE(?,'') AND status IN ('pending','processing') AND deleted_at IS NULL ORDER BY id DESC LIMIT 1").get(sb.id,kind);
      if(active?.task_id){attach('task',active.task_id);return;}
      const prompt=payload.slot==='image' ? sb.polished_prompt||sb.image_prompt||sb.description : framePrompt(db,sb.id,payload.slot);
      if(!String(prompt||'').trim()) throw new Error('图片提示词为空，未提交生成');
      const lock=payload.slot==='last' && options.layout_lock !== false;
      const first=lock ? mediaUrl(frame(db,sb,'first')) : '';
      db.transaction(()=>{
        const result=require('./imageService').create(db,log,{drama_id:job.drama_id,storyboard_id:sb.id,prompt,style:options.style,
          aspect_ratio:options.aspect_ratio,frame_type:kind,reference_images:first?[first]:undefined,use_first_frame_layout_lock:lock});
        attach('task',result.task_id);
      })();
      return;
    }
    if (item.action === 'image_barrier') {
      const incomplete=shots(db,job,options).filter(sb => imagePlan(job,options,sb).some(s=>s.action==='image' && !frame(db,sb,s.payload.slot)));
      if(incomplete.length) throw new Error(`仍有${incomplete.length}镜的图片不完整，视频尚未开始`);
      return;
    }
    if (item.action === 'polish') {
      const sb=validShot(job,payload.storyboard_id);
      await require('./universalSegmentPolishService').polishUniversalSegment(db, log, sb.id, {draft_universal_segment_text:sb.universal_segment_text,duration:sb.duration,force_without_reference_images:true});
      return;
    }
    if (item.action === 'expand_videos') {
      const rows=shots(db,job,options);
      if(!rows.length) throw new Error('没有可生成视频的分镜');
      return {steps:rows.filter(sb=>!videoDone(sb)).map(sb=>step('video',`#${sb.storyboard_number} 分镜视频`,{storyboard_id:sb.id}))};
    }
    if (item.action === 'video') {
      const sb=validShot(job,payload.storyboard_id);
      if(!payload.force && videoDone(sb)) return {skipped:true};
      const active=db.prepare("SELECT * FROM video_generations WHERE storyboard_id=? AND status='processing' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1").get(sb.id);
      if(active?.task_id){attach('task',active.task_id);return;}
      const requested=videoPayload(job,options,sb);
      if(db.prepare('SELECT status FROM generation_jobs WHERE id=?').get(job.id)?.status==='stopping') return {skipped:true};
      let record;
      db.transaction(()=>{record=require('./videoSubmissionService').submitVideo(db,log,requested);attach('task',record.task_id);})();
      setImmediate(()=>require('./videoService').processVideoGeneration(db,log,record.id).catch(e=>log.error('Canvas video failed',{error:e.message})));
      return;
    }
    if (item.action === 'video_barrier') {
      if(shots(db,job,options).some(sb=>!videoDone(sb))) throw new Error('仍有分镜缺少视频，未进行不完整合成');
      return;
    }
    if (item.action === 'merge') {
      const result = require('./dramaService').finalizeEpisode(db, log, job.episode_id, cfg?.storage?.base_url || '', options.merge || {});
      if (!result?.task_id) throw new Error(result?.message || '合成任务未创建');
      attach('task', result.task_id);
      return;
    }
    if (item.action === 'audio') {
      const sb=validShot(job,payload.storyboard_id);
      if (!require('./speechExtractionService').meaningful(sb.dialogue)) return {skipped:true};
      // Use the established role-aware dubbing pipeline instead of voicing a raw speaker label.
      const root = require('path').resolve(cfg?.storage?.local_path || './data/storage');
      const task = require('./dialogueDubbingService').startBatch(db, log, job.drama_id, { episode_id:sb.episode_id, storyboard_ids:[sb.id], tts_kind:'dialogue' }, root);
      attach('task', task.id);
      return;
    }
    throw new Error('未知后台步骤：'+item.action);
  }
  function videoPayload(job,options,sb) {
    let universal=sb.creation_mode==='universal';
    const selected=require('./storyboardVideoModelService').resolveStoryboardModel(db,{drama_id:job.drama_id,storyboard_id:sb.id,model:sb.video_model || undefined});

    // 自动解析与推导 H3 模式（Ref2VA + AddGuide vs FL2VA）并持久化依据
    const { resolveH3SubmissionPlan } = require('./h3ModeResolver');
    let slots = sb.semantic_slots;
    if (typeof slots === 'string') {
      try { slots = JSON.parse(slots); } catch (_) { slots = null; }
    }
    const plan = resolveH3SubmissionPlan(db, job.drama_id, { ...sb, semantic_slots: slots || sb.semantic_slots }, { h3_mode: options.h3_mode });
    try {
      db.prepare('UPDATE storyboards SET h3_generation_plan=? WHERE id=?').run(JSON.stringify(plan), sb.id);
    } catch (_) {}

    const first = plan.requires_first_frame ? mediaUrl(frame(db,sb,'first') || frame(db,sb,'image')) : '';
    const last = plan.mode === 'fl2va' && plan.last_frame_policy === 'generate_tail'
      ? mediaUrl(frame(db,sb,'last'))
      : '';

    if (plan.requires_first_frame && !first && plan.first_frame_policy !== 'inherit_tail') {
      throw new Error(`分镜 #${sb.storyboard_number} 缺少首帧图片（首帧生成失败或未就绪），已终止任务，禁止静默降级为无首帧生成！`);
    }

    let refs=[first,last].filter(Boolean);
    if(plan.mode === 'ref2va') {
      if (Array.isArray(plan.references) && plan.references.length > 0) {
        refs = plan.references.map(r => {
          if (r.url) return r.url;
          if (r.type === 'scene' && r.id) {
            const sc = db.prepare('SELECT * FROM scenes WHERE id=? AND drama_id=? AND deleted_at IS NULL').get(r.id, job.drama_id);
            return mediaUrl(sc);
          }
          if (r.type === 'character' && r.id) {
            const ch = db.prepare('SELECT * FROM characters WHERE id=? AND drama_id=? AND deleted_at IS NULL').get(r.id, job.drama_id);
            return mediaUrl(ch);
          }
          if (r.type === 'prop' && r.id) {
            const pr = db.prepare('SELECT * FROM props WHERE id=? AND drama_id=? AND deleted_at IS NULL').get(r.id, job.drama_id);
            return mediaUrl(pr);
          }
          return '';
        }).filter(Boolean);
      } else if (universal) {
        // Match the editor's @图片 slots: scene, characters in shot order, props.
        const scene=sb.scene_id ? db.prepare('SELECT * FROM scenes WHERE id=? AND drama_id=? AND deleted_at IS NULL').get(sb.scene_id,job.drama_id) : null;
        let ids=[];try{ids=JSON.parse(sb.characters || '[]').map(c=>Number(typeof c==='object'?c.id:c))}catch(_){}
        if(!ids.length) ids=db.prepare('SELECT character_id FROM storyboard_characters WHERE storyboard_id=? ORDER BY id').all(sb.id).map(c=>c.character_id);
        const chars=ids.map(id=>db.prepare('SELECT * FROM characters WHERE id=? AND drama_id=? AND deleted_at IS NULL').get(id,job.drama_id));
        const props=db.prepare('SELECT p.* FROM props p JOIN storyboard_props sp ON sp.prop_id=p.id WHERE sp.storyboard_id=? AND p.drama_id=? AND p.deleted_at IS NULL ORDER BY p.id').all(sb.id,job.drama_id);
        refs=[...new Set([scene,...chars,...props].filter(hasImage).map(mediaUrl))];
      }
      if (refs.length > 9) {
        throw new Error(`分镜 #${sb.storyboard_number} 参考图片数量 (${refs.length}) 超过上限 (9 张)，已终止任务以避免静默截断！请调整分镜参考素材。`);
      }
    }

    if(plan.mode === 'ref2va' && !refs.length && !(plan.audio_references || []).length) {
      const speech=slots?.speech_plan || {};
      if(!String(speech.text || sb.dialogue || sb.narration || '').trim()) throw new Error(`分镜#${sb.storyboard_number}的 Ref2VA 计划缺少图片或声音参考，未提交视频`);
    }
    return {drama_id:job.drama_id,storyboard_id:sb.id,model:selected.model || undefined,
      image_url:plan.requires_first_frame?first:refs[0],first_frame_url:first || undefined,last_frame_url:last || undefined,
      reference_image_urls:refs,universal,h3_mode:plan.mode,resolution_plan:plan,
      aspect_ratio:options.aspect_ratio,style:options.style,resolution:options.resolution,duration:sb.duration};
  }
  return {execute,observe};
}
module.exports={createExecutor,frame,framePrompt};
