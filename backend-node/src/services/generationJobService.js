// Durable orchestration only. Model calls remain in their existing services.
const { randomUUID } = require('crypto');
const ACTIVE = ['running', 'paused', 'stopping', 'queued'];
const KINDS = new Set(['storyboard_images', 'reference_images', 'pipeline', 'text_framework', 'repair', 'omni_polish', 'storyboards', 'canvas_workflow', 'canvas_videos', 'extraction']);
const now = () => new Date().toISOString();
const parse = value => JSON.parse(value || '{}');
const step = (action, label, payload = {}) => ({ action, label, payload });

function episode(db, dramaId, episodeId) {
  const row = db.prepare('SELECT * FROM episodes WHERE id=? AND drama_id=? AND deleted_at IS NULL').get(Number(episodeId), Number(dramaId));
  if (!row) throw new Error('分集不属于当前项目或已删除');
  return row;
}
function shots(db, job, options = {}) {
  const rows = db.prepare(`SELECT s.* FROM storyboards s JOIN episodes e ON e.id=s.episode_id
    WHERE e.drama_id=? AND e.deleted_at IS NULL AND s.deleted_at IS NULL
    ${job.episode_id ? 'AND e.id=?' : ''} ORDER BY e.episode_number,s.storyboard_number,s.id`).all(...(job.episode_id ? [job.drama_id, job.episode_id] : [job.drama_id]));
  return options.storyboard_ids ? rows.filter(r => options.storyboard_ids.includes(r.id)) : rows;
}
function resources(db, job) {
  episode(db, job.drama_id, job.episode_id);
  return {
    character: db.prepare(`SELECT c.* FROM characters c JOIN episode_characters ec ON ec.character_id=c.id
      WHERE ec.episode_id=? AND c.drama_id=? AND c.deleted_at IS NULL ORDER BY c.id`).all(job.episode_id, job.drama_id),
    scene: require('./episodeSceneService').list(db, job.drama_id, job.episode_id),
    prop: db.prepare(`SELECT p.* FROM props p WHERE p.drama_id=? AND p.deleted_at IS NULL AND
      (p.episode_id=? OR p.id IN (SELECT sp.prop_id FROM storyboard_props sp JOIN storyboards s ON s.id=sp.storyboard_id WHERE s.episode_id=? AND s.deleted_at IS NULL)) ORDER BY p.id`).all(job.drama_id, job.episode_id, job.episode_id),
  };
}
function insertItems(db, jobId, items, prefix = '') {
  const insert = db.prepare('INSERT INTO generation_job_items(job_id,position,action,label,payload) VALUES(?,?,?,?,?)');
  items.forEach((s, index) => insert.run(jobId, prefix + String(index).padStart(5, '0'), s.action, s.label, JSON.stringify(s.payload || {})));
}
function get(db, id) {
  const row = db.prepare('SELECT id,drama_id,episode_id,kind,status,options,error,created_at,updated_at FROM generation_jobs WHERE id=?').get(id);
  if (!row) return null;
  const rawItems = db.prepare('SELECT id,action,label,payload,status,child_type,child_id,error FROM generation_job_items WHERE job_id=? ORDER BY position').all(id);
  const items = rawItems.map(i => {
    let payload = {};
    if (i.payload) {
      try { payload = JSON.parse(i.payload); } catch (_) {}
    }
    return { ...i, payload };
  });
  const runningItem = items.find(i => i.status === 'running');
  const pendingItem = items.find(i => i.status === 'pending');
  let label = runningItem?.label || pendingItem?.label || '';
  if (row.status === 'queued') label = label ? (label + ' (排队中)') : '排队中';
  return { ...row, items, total: items.length, current: items.filter(i => ['completed','skipped','failed','cancelled'].includes(i.status)).length,
    failed: items.filter(i => i.status === 'failed').length, label };
}
function list(db, dramaId) {
  return db.prepare(`SELECT id FROM generation_jobs WHERE drama_id=? AND (status IN ('running','paused','stopping','queued') OR id IN (SELECT id FROM generation_jobs WHERE drama_id=? ORDER BY created_at DESC,rowid DESC LIMIT 20)) ORDER BY created_at DESC,rowid DESC`).all(Number(dramaId),Number(dramaId)).map(r => get(db, r.id));
}
function create(db, log, dramaId, body) {
  const drama = db.prepare('SELECT id FROM dramas WHERE id=? AND deleted_at IS NULL').get(Number(dramaId));
  if (!drama) throw new Error('项目不存在');
  if (!KINDS.has(body.kind)) throw new Error('不支持的后台任务类型');
  const episodeId = body.episode_id == null ? null : Number(body.episode_id);
  if (body.kind !== 'canvas_workflow' || episodeId != null) episode(db, drama.id, episodeId);
  const options = { ...(body.options || {}) };
  if (JSON.stringify(options).length > 200000) throw new Error('任务参数过大');
  if (options.scope && !['all','character','prop','scene'].includes(options.scope)) throw new Error('无效的参考图范围');
  if(options.slots && (!Array.isArray(options.slots) || !options.slots.length || options.slots.some(s=>!['first','last','image'].includes(s)))) throw new Error('无效的分镜图片类型');
  const job = { id: randomUUID(), drama_id: drama.id, episode_id: episodeId, kind: body.kind };
  if (options.storyboard_ids != null) {
    if (!Array.isArray(options.storyboard_ids) || !options.storyboard_ids.length || options.storyboard_ids.length > 300) throw new Error('请选择1～300个分镜');
    options.storyboard_ids = [...new Set(options.storyboard_ids.map(Number))];
    if (shots(db, job, options).length !== options.storyboard_ids.length) throw new Error('分镜不属于当前项目/分集或已删除');
  }
  if (body.kind === 'canvas_workflow' && !options.storyboard_ids?.length) throw new Error('工作流缺少分镜');
  if (options.pipeline && (!Array.isArray(options.pipeline) || !options.pipeline.length || options.pipeline.length > 3 || options.pipeline.some(s => !['image','video','audio'].includes(s)))) throw new Error('无效工作流步骤');
  return db.transaction(() => {
    const existing = db.prepare(`SELECT * FROM generation_jobs WHERE drama_id=? AND status IN ('running','paused','stopping','queued')
      AND (episode_id IS NULL OR ? IS NULL OR episode_id=?) ORDER BY created_at LIMIT 1`).get(drama.id, episodeId, episodeId);
    if (existing) {
      if (existing.kind === body.kind && existing.episode_id === episodeId && existing.options === JSON.stringify(options)) return get(db, existing.id);
      if (['pipeline','repair'].includes(body.kind) || ['pipeline','repair'].includes(existing.kind)) {
        throw Object.assign(new Error('当前范围已有后台任务，请等待完成或先停止，避免重复生成'), { status: 409 });
      }
    }
    if (db.prepare("SELECT id FROM video_batches WHERE drama_id=? AND (? IS NULL OR episode_id=?) AND status IN ('running','stopping')").get(drama.id, episodeId, episodeId)) throw new Error('本集批量视频仍在运行，请完成或停止后再提交');
    const initialStatus = existing ? 'queued' : 'running';
    db.prepare('INSERT INTO generation_jobs(id,drama_id,episode_id,kind,status,options,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(job.id, drama.id, episodeId, body.kind, initialStatus, JSON.stringify(options), now(), now());
    let plan;
    if(body.kind==='extraction') plan=['character','scene','prop'].map(kind=>step('extract',`提取${{character:'角色',scene:'场景',prop:'道具'}[kind]}`,{kind}));
    else if (['pipeline','repair','text_framework'].includes(body.kind)) {
      plan = ['character','scene','prop','storyboards'].map(kind => step('extract', `提取${{character:'角色',scene:'场景',prop:'道具',storyboards:'分镜脚本'}[kind]}`, { kind }));
      plan.push(step('expand_polish', '检查全能片段润色'));
      if (body.kind !== 'text_framework') plan.push(step('wait','文本已就绪，20秒后开始参考图',{seconds:20}),step('expand_references','补齐参考图'), step('reference_barrier','检查参考素材'),step('wait','参考图已就绪，30秒后开始分镜图',{seconds:30}), step('expand_images','补齐分镜首尾帧'), step('image_barrier','检查分镜图片'),step('wait','分镜图已就绪，20秒后开始视频',{seconds:20}), step('expand_videos','生成分镜视频'), step('video_barrier','检查分镜视频'), step('merge','合成整集视频'));
    } else if (body.kind === 'storyboards') plan = [step('extract','生成分镜脚本',{kind:'storyboards',force:true}),step('expand_polish','全能片段润色')];
    else plan = [step(({storyboard_images:'expand_images',reference_images:'expand_references',omni_polish:'expand_polish',canvas_workflow:'expand_canvas',canvas_videos:'expand_videos'})[body.kind], '准备后台队列')];
    insertItems(db, job.id, plan);
    log.info('Persistent generation job created', { id:job.id, kind:job.kind, episode_id:episodeId });
    return get(db, job.id);
  })();
}
function control(db, dramaId, id, command) {
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM generation_jobs WHERE id=? AND drama_id=?').get(id, Number(dramaId));
    if (!row) throw new Error('任务不存在');
    if (!['stop','pause','resume','skip_wait','dismiss'].includes(command)) throw new Error('无效操作');
    if (command === 'dismiss') {
      const targetJob = db.prepare('SELECT * FROM generation_jobs WHERE id=? AND drama_id=?').get(id, Number(dramaId));
      if (targetJob) {
        if (!ACTIVE.includes(targetJob.status)) {
          const finished = db.prepare(`SELECT id FROM generation_jobs WHERE drama_id=? AND kind=? AND (episode_id=? OR (episode_id IS NULL AND ? IS NULL)) AND status NOT IN ('running','paused','stopping','queued')`).all(Number(dramaId), targetJob.kind, targetJob.episode_id, targetJob.episode_id);
          for (const f of finished) {
            db.prepare("DELETE FROM generation_job_items WHERE job_id=?").run(f.id);
            db.prepare("DELETE FROM generation_jobs WHERE id=?").run(f.id);
          }
        } else {
          db.prepare("DELETE FROM generation_job_items WHERE job_id=?").run(id);
          db.prepare("DELETE FROM generation_jobs WHERE id=?").run(id);
        }
      }
      return { id, dismissed: true };
    }
    if (!ACTIVE.includes(row.status)) return get(db,id);
    if(command==='skip_wait') {db.prepare("UPDATE generation_job_items SET child_id='0' WHERE job_id=? AND status='running' AND child_type='timer'").run(id);return get(db,id);}
    if (command === 'resume' && row.status !== 'paused') throw new Error('只能继续已暂停的任务');
    if (command === 'pause' && row.status === 'stopping') throw new Error('正在停止，不能暂停');
    if (command === 'stop') {
      db.prepare("UPDATE generation_job_items SET status='cancelled' WHERE job_id=? AND status='pending'").run(id);
      db.prepare('UPDATE generation_jobs SET status=?,updated_at=? WHERE id=?').run(row.status === 'queued' ? 'stopped' : 'stopping', now(), id);
      return get(db, id);
    }
    if (row.status === 'queued') throw new Error('排队中的任务无法暂停或操作，如需取消请点击停止');
    db.prepare('UPDATE generation_jobs SET status=?,updated_at=? WHERE id=?').run(command === 'pause' ? 'paused' : 'running', now(), id);
    return get(db,id);
  })();
}
function createWorker(db, log, executor) {
  let busy = false;
  const fail = (item, error) => {
    db.prepare("UPDATE generation_job_items SET status='failed',error=? WHERE id=?").run(error, item.id);
    const job = db.prepare('SELECT * FROM generation_jobs WHERE id=?').get(item.job_id);
    // Stop dependent pipeline stages; simple batches continue independent resources/shots.
    if (['pipeline','repair','text_framework','storyboards','canvas_workflow','extraction'].includes(job.kind)) {
      db.prepare("UPDATE generation_job_items SET status='cancelled' WHERE job_id=? AND status='pending'").run(job.id);
      db.prepare("UPDATE generation_jobs SET status='failed',error=?,updated_at=? WHERE id=?").run(error, now(), job.id);
    }
  };
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const running = db.prepare("SELECT * FROM generation_job_items WHERE status='running'").all();
      for (const item of running) {
        if (!item.child_id) continue; // The asynchronous action is still running in this worker.
        const state = await executor.observe(item.child_type, item.child_id);
        if (state.pending) continue;
        if (state.error) fail(item, state.error);
        else db.prepare("UPDATE generation_job_items SET status='completed' WHERE id=?").run(item.id);
      }
      for (const job of db.prepare("SELECT * FROM generation_jobs WHERE status IN ('running','paused','stopping')").all()) {
        const remaining = db.prepare("SELECT COUNT(*) n FROM generation_job_items WHERE job_id=? AND status IN ('pending','running')").get(job.id).n;
        if (!remaining) {
          const failed = db.prepare("SELECT COUNT(*) n FROM generation_job_items WHERE job_id=? AND status='failed'").get(job.id).n;
          db.prepare('UPDATE generation_jobs SET status=?,updated_at=? WHERE id=?').run(job.status === 'stopping' ? 'stopped' : failed ? 'completed_with_errors' : 'completed',now(),job.id);
        }
      }
      const activeRunning = db.prepare("SELECT id FROM generation_jobs WHERE status IN ('running','paused','stopping') LIMIT 1").get();
      if (!activeRunning) {
        const nextQueued = db.prepare("SELECT id FROM generation_jobs WHERE status='queued' ORDER BY created_at, rowid LIMIT 1").get();
        if (nextQueued) {
          db.prepare("UPDATE generation_jobs SET status='running', updated_at=? WHERE id=?").run(now(), nextQueued.id);
        }
      }
      if (db.prepare("SELECT id FROM generation_job_items WHERE status='running' LIMIT 1").get()) return;
      const item = db.prepare(`SELECT i.* FROM generation_job_items i JOIN generation_jobs j ON j.id=i.job_id
        WHERE j.status='running' AND i.status='pending' ORDER BY j.created_at,j.rowid,i.position LIMIT 1`).get();
      if (!item) return;
      const job = db.prepare('SELECT * FROM generation_jobs WHERE id=?').get(item.job_id);
      const attach = (type,id) => {
        if (!id) throw new Error('后台操作未返回任务编号');
        db.prepare('UPDATE generation_job_items SET child_type=?,child_id=? WHERE id=?').run(type, String(id), item.id);
      };
      db.prepare("UPDATE generation_job_items SET status='running' WHERE id=?").run(item.id);
      try {
        if (!db.prepare('SELECT id FROM dramas WHERE id=? AND deleted_at IS NULL').get(job.drama_id)) throw new Error('项目已删除');
        if (job.episode_id) episode(db,job.drama_id,job.episode_id);
        const result = await executor.execute(job, item, parse(job.options), parse(item.payload), attach);
        // Expanding and marking the parent complete must be atomic across process restarts.
        db.transaction(() => {
          if (result?.steps && db.prepare('SELECT status FROM generation_jobs WHERE id=?').get(job.id)?.status !== 'stopping') insertItems(db,job.id,result.steps,item.position + '.');
          if (!db.prepare('SELECT child_id FROM generation_job_items WHERE id=?').get(item.id).child_id)
            db.prepare('UPDATE generation_job_items SET status=? WHERE id=?').run(result?.skipped ? 'skipped' : 'completed',item.id);
          db.prepare('UPDATE generation_jobs SET updated_at=? WHERE id=?').run(now(),job.id);
        })();
      } catch (error) { fail(item,error.message || String(error)); log.error('Background generation step failed',{job_id:job.id,item_id:item.id,error:error.message}); }
    } finally { busy = false; }
  }
  return { tick, recover() {
    // Never resubmit a model call whose completion is uncertain after a crash.
    for (const item of db.prepare("SELECT * FROM generation_job_items WHERE status='running' AND child_id IS NULL").all()) fail(item,'服务重启时此步骤中断，未自动重复提交；请检查结果后补齐');
  } };
}
function startWorker(db,cfg,log) {
  const executor = require('./generationJobActions').createExecutor(db,cfg,log);
  const worker = createWorker(db,log,executor);
  // Async image workers cannot survive a process restart. Make their terminal state
  // agree with the task table, so an explicit later retry does not adopt a dead task.
  db.prepare(`UPDATE image_generations SET status='failed',error_msg=(SELECT COALESCE(t.error,t.message,'任务已中断') FROM async_tasks t WHERE t.id=image_generations.task_id),updated_at=?
    WHERE status IN ('pending','processing') AND task_id IN (SELECT id FROM async_tasks WHERE status='failed')`).run(now());
  worker.recover();
  const run = () => worker.tick().catch(e => log.error('Generation dispatcher failed',{error:e.message}));
  const timer = setInterval(run,1000); timer.unref(); run();
  return { stop:()=>clearInterval(timer), ...worker };
}
module.exports = { create,get,list,control,createWorker,startWorker,shots,resources,step };
