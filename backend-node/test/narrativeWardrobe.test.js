const test=require('node:test');
const assert=require('node:assert/strict');
const Database=require('better-sqlite3');
const migrate=require('../src/db/migrate');
const narrative=require('../src/services/narrativeStyleService');
const wardrobe=require('../src/services/wardrobeService');
const dramas=require('../src/services/dramaService');
const dubbing=require('../src/services/dialogueDubbingService');
const aiConfig=require('../src/services/aiConfigService');
const ai=require('../src/services/aiClient');
const scripts=require('../src/services/episodeScriptService');
const stories=require('../src/services/storyGenerationService');
const storyboard=require('../src/services/episodeStoryboardService');
const imageService=require('../src/services/imageService');
const imageClient=require('../src/services/imageClient');
const native=require('../src/services/h3NativeService');
const log={info(){},warn(){},error(){}};
function setup(t){
 const db=new Database(':memory:');t.after(()=>db.close());
 t.mock.method(console,'log',()=>{});t.mock.method(console,'warn',()=>{});
 migrate.runMigrationsAndEnsure(db);
 db.exec(`INSERT INTO dramas(id,title,style,metadata) VALUES(1,'测试','sci-fi','{"keep":"preserve","style_prompt_en":"existing visual style","tts_dubbing":{"speed":1,"character_voices":{"5":"zh-CN-YunxiaNeural"},"narrator_voice":"zh-CN-YunyangNeural"}}'),(2,'外剧','realistic','{}');
 INSERT INTO episodes(id,drama_id,episode_number,script_content) VALUES(10,1,1,'少年踏入梦境，换上银色训练服。'),(11,1,2,'少年返回现实，恢复原来的便装。'),(20,2,1,'外剧');
 INSERT INTO characters(id,drama_id,name,appearance,local_path) VALUES(5,1,'王奕宸','黑发少年，身穿灰色卫衣','card.png'),(6,1,'教官','成年男子','coach.png'),(9,2,'外人','','foreign.png');
 INSERT INTO storyboards(id,episode_id,storyboard_number,characters,duration,location,video_prompt,dialogue) VALUES
 (80,10,1,'[5,6]',8,'家中','A boy talks.','王奕宸："先写一道题。"'),(81,10,2,'[5]',8,'基地','A boy walks.',''),(82,11,1,'[5]',8,'操场','A boy speaks.',''),(83,11,2,'[5]',8,'家中','A boy sits.',''),(90,20,1,'[9]',8,'外剧','','');`);
 t.mock.method(aiConfig,'listConfigs',(_db,type)=>type==='tts'?[{id:4,is_active:true,is_default:true,provider:'edge-tts',model:[]}]:[]);
 return db;
}
test('narrative settings preserve visual style, wardrobe and voices while normalizing legacy speed fields',t=>{
 const db=setup(t);
 db.prepare("UPDATE dramas SET tags='[\"现有标签\"]' WHERE id=1").run();
 wardrobe.saveCharacter(db,1,5,{description:'灰色卫衣、深蓝长裤、白鞋'});
 dramas.saveOutline(db,log,1,{metadata:{narrative_style:{preset:'dialogue_fast',speech_rate:1.5}}});
 let metadata=JSON.parse(db.prepare('SELECT metadata FROM dramas WHERE id=1').get().metadata);
 assert.equal(metadata.style_prompt_en,'existing visual style');assert.equal(metadata.keep,'preserve');
 assert.equal(db.prepare('SELECT tags FROM dramas WHERE id=1').get().tags,'["现有标签"]');
 assert.equal(metadata.wardrobe.characters[5].description,'灰色卫衣、深蓝长裤、白鞋');
 assert.equal(metadata.tts_dubbing.character_voices[5],'zh-CN-YunxiaNeural');assert.equal(metadata.tts_dubbing.speed,1);
 assert.equal(dubbing.getProfile(db,1).speed,1);
 const profile=dubbing.normalizedProfile(db,1,dubbing.getProfile(db,1));
 dubbing.saveProfile(db,1,{...profile,speed:1.3});
 metadata=JSON.parse(db.prepare('SELECT metadata FROM dramas WHERE id=1').get().metadata);
 assert.equal(metadata.narrative_style.speech_rate,1);
 assert.equal(metadata.narrative_style.speech_mode,'fixed');
 const before=JSON.stringify(metadata);
 for(const value of [{preset:'unknown'},null,[]])assert.throws(()=>dramas.saveOutline(db,log,1,{metadata:{narrative_style:value}}));
 assert.equal(db.prepare('SELECT metadata FROM dramas WHERE id=1').get().metadata,before);
 const created=dramas.createDrama(db,log,{title:'新项目'});
 assert.deepEqual(narrative.fromMetadata(created.metadata),{preset:'balanced',speech_rate:1,speech_mode:'fixed'});
 assert.equal(narrative.fromMetadata({}).preset,'balanced');
});
test('wardrobe persists across scenes and episodes; explicit dream changes inherit until a deliberate return and do not rewrite assets',t=>{
 const db=setup(t),before=db.prepare('SELECT id,image_url,first_frame_image_id,last_frame_image_id,video_url FROM storyboards ORDER BY id').all();
 wardrobe.saveCharacter(db,1,5,{description:'灰色卫衣、深蓝长裤、白鞋'});
 assert.equal(wardrobe.getShot(db,82).characters[0].description,'灰色卫衣、深蓝长裤、白鞋');
 wardrobe.saveShot(db,81,{change:{reason:'进入梦境，换训练服',characters:[{character_id:5,description:'银色训练服、黑色靴子'}]}});
 assert.equal(wardrobe.getShot(db,80).characters[0].description,'灰色卫衣、深蓝长裤、白鞋');
 assert.equal(wardrobe.getShot(db,82).characters[0].description,'银色训练服、黑色靴子');
 wardrobe.saveShot(db,83,{change:{reason:'返回现实恢复便装',characters:[{character_id:5,description:'灰色卫衣、深蓝长裤、白鞋'}]}});
 assert.equal(wardrobe.getShot(db,83).characters[0].source_storyboard_id,83);
 assert.match(wardrobe.promptContext(db,83,'last'),/尾帧服装以本镜首帧的实际穿着为权威/);
 wardrobe.saveShot(db,81,{change:null});
 assert.equal(wardrobe.getShot(db,82).characters[0].source_storyboard_id,null);
 assert.deepEqual(db.prepare('SELECT id,image_url,first_frame_image_id,last_frame_image_id,video_url FROM storyboards ORDER BY id').all(),before);
 assert.throws(()=>wardrobe.saveCharacter(db,1,9,{description:'bad'}),/不属于/);
 assert.throws(()=>wardrobe.saveShot(db,81,{change:{reason:'',characters:[{character_id:5,description:'白衣'}]}}));
 assert.throws(()=>wardrobe.saveShot(db,81,{change:{reason:'换装',characters:[{character_id:9,description:'白衣'}]}}));
});
test('model wardrobe suggestions need verbatim source evidence and cannot overwrite a user-confirmed change',t=>{
 const db=setup(t);
 const proposed={wardrobe_change:{reason:'梦境',evidence:'少年踏入梦境，换上银色训练服。',characters:[{character_id:5,description:'银色训练服'}]}};
 wardrobe.recordAiChange(db,10,81,{wardrobe_change:{...proposed.wardrobe_change,evidence:'模型编造的换装'}});
 assert.equal(wardrobe.getShot(db,81).change,null);
 wardrobe.recordAiChange(db,10,81,proposed);
 assert.equal(wardrobe.getShot(db,81).change.source,'ai');
 wardrobe.saveShot(db,81,{change:{reason:'用户确认的梦境服装',characters:[{character_id:5,description:'蓝色训练服'}]}});
 wardrobe.recordAiChange(db,10,81,proposed);
 assert.equal(wardrobe.getShot(db,81).characters[0].description,'蓝色训练服');
 wardrobe.recordAiChange(db,10,81,{wardrobe_change:{evidence:[]}});
 assert.equal(wardrobe.getShot(db,81).change.source,'manual');
});
test('script expansion and current-episode rewrite receive selected narrative rules without changing existing scripts',async t=>{
 const db=setup(t);
 dramas.saveOutline(db,log,1,{metadata:{narrative_style:{preset:'dialogue_fast',speech_rate:1.5}}});
 const before=db.prepare('SELECT * FROM episodes ORDER BY id').all(),calls=[];
 t.mock.method(ai,'generateText',async(_db,_log,_type,user,system)=>{calls.push({user,system});return JSON.stringify([{episode:1,title:'草稿',content:'王奕宸："先做一道题。"'}]);});
 await stories.generateStory(db,log,{drama_id:1,premise:'少年学会自律',episode_count:1});
 await scripts.generateEpisodeDraft(db,log,10);
 for(const call of calls){assert.match(call.system,/UNIVERSAL DIRECTING PRINCIPLES/);assert.match(call.system,/通用剧本组织/);assert.match(call.system,/连续动作链/);assert.match(call.system,/多个配角轮流总结/);assert.match(call.system,/人物与游戏身份映射/);assert.match(call.system,/实际 TTS 配置计算/);assert.doesNotMatch(call.system,/speech_rate.*1.5x/);assert.match(call.system,/服装连续性/);assert.match(call.system,/TTS-aware speech budget/);assert.match(call.system,/不要求每句简短/);assert.doesNotMatch(call.system,/台词要短|台词用短句|Keep spoken lines short/);}
 assert.deepEqual(db.prepare('SELECT * FROM episodes ORDER BY id').all(),before);
});
test('Stage 3 H3 spec preserves literal dialogue and base frame alignment cleanly',()=>{
 const { buildStage3PromptSpec, validateOfficialH3Prompt } = require('../src/services/h3Stage3PromptService');
 const shot = {
   id: 80, storyboard_number: 1, duration: 5,
   semantic_slots: { h3_mode: 'fl2va', first_frame_policy: 'generate_new', last_frame_policy: 'generate_tail', required_references: [] },
 };
 const spec = buildStage3PromptSpec(null, shot, {
   executionPlan: { mode: 'fl2va', last_frame_policy: 'generate_tail' },
   anchors: { first: 'start', last: 'end' },
   firstFramePresent: true, lastFramePresent: true,
   speech: { narrative_style: { preset: 'dialogue_fast', speech_rate: 1.5 }, references: [{ key: 'character:5', kind: 'dialogue' }], lines: [{ key: 'character:5', kind: 'dialogue', text: '先做一道题。' }] },
 });
 assert.deepEqual(spec.picture_bindings.map(p => p.role), ['first_frame', 'last_frame']);
 assert.equal(spec.spoken_lines[0].text, '先做一道题。');
 const prompt = `How the reference pictures align with the target video — <Picture 1> aligns with the 0.00-second mark and <Picture 2> aligns with the 5.00-second mark.\n\nintegrated_multimodal_description: [Shot 1] Starting from <Picture 1> and ending at <Picture 2>, the boy (S1) speaks at a desk: <d>[Chinese] 先做一道题。</d>\n\noverall_soundscape:\nSoft indoor room tone.\n\nnon_diegetic_music:\nN/A`;
 assert.equal(validateOfficialH3Prompt(prompt, spec).valid, true);
});
test('image generation passes first-frame wardrobe reference even when camera-layout locking is disabled',async t=>{
 const db=setup(t);
 wardrobe.saveCharacter(db,1,5,{description:'灰色卫衣、蓝色长裤'});
 db.prepare("INSERT INTO image_generations(id,storyboard_id,drama_id,prompt,frame_type,status,local_path) VALUES(150,80,1,'first','storyboard_first','completed','first.png')").run();
 db.prepare('UPDATE storyboards SET first_frame_image_id=150 WHERE id=80').run();
 db.prepare("INSERT INTO image_generations(id,storyboard_id,drama_id,prompt,frame_type,status,use_first_frame_layout_lock,reference_images) VALUES(151,80,1,'ending still','storyboard_last','pending',0,'[\"http://host/static/first.png\"]')").run();
 t.mock.method(imageClient,'getDefaultImageConfig',()=>({model:['test-image'],default_model:'test-image',provider:'test'}));
 let received;
 t.mock.method(imageClient,'callImageApi',async(_db,_log,body)=>{received=body;return {error:'test ends before GPU call'};});
 await imageService.processImageGeneration(db,log,151);
 assert.ok(received,'image generation reached its transport');
 assert.match(received.prompt,/灰色卫衣、蓝色长裤/);assert.match(received.prompt,/尾帧服装以本镜首帧/);
 assert.equal(received.reference_image_urls[0],'first.png');
 assert.match(received.system_prompt,/WARDROBE_LOCK/);
 assert.equal(received.reference_image_urls.filter(s=>/first\.png/.test(s)).length,1);
});
test('image generation uses the selected stage image and outfit rather than the default card',async t=>{
 const db=setup(t);
 db.prepare('UPDATE characters SET stages=? WHERE id=5').run(JSON.stringify([{id:'training',name:'训练装',appearance:'白色训练服、黑色腰带',reference_image:'training.png'}]));
 wardrobe.saveShot(db,80,{change:{reason:'进入基地',characters:[{character_id:5,stage_id:'training'}]}});
 db.prepare("INSERT INTO image_generations(id,storyboard_id,drama_id,prompt,frame_type,status) VALUES(155,80,1,'少年站在基地','storyboard_first','pending')").run();
 t.mock.method(imageClient,'getDefaultImageConfig',()=>({model:['test-image'],default_model:'test-image',provider:'test'}));
 let received;
 t.mock.method(imageClient,'callImageApi',async(_db,_log,body)=>{received=body;return {error:'ends before GPU'};});
 await imageService.processImageGeneration(db,log,155);
 assert.ok(received);
 assert.ok(received.reference_image_urls.includes('training.png'));
 assert.ok(!received.reference_image_urls.includes('card.png'));
 assert.match(received.prompt,/白色训练服、黑色腰带/);
 assert.match(received.prompt,/本镜开始前已完成换装/);
});

async function completedTask(db,id){
 for(let i=0;i<100;i++){
  const task=db.prepare('SELECT * FROM async_tasks WHERE id=?').get(id);
  if(['completed','failed'].includes(task.status)){assert.equal(task.status,'completed',task.error || task.message);return JSON.parse(task.result)}
  await new Promise(resolve=>setTimeout(resolve,5));
 }
 assert.fail('local mocked task did not complete');
}
test('actual storyboard planner receives the preset and saves evidence-backed outfit transitions',async t=>{
 const db=setup(t);
 db.prepare('UPDATE characters SET stages=? WHERE id=5').run(JSON.stringify([{id:'silver',name:'梦境训练装',appearance:'银色训练服'}]));
 dramas.saveOutline(db,log,1,{metadata:{narrative_style:{preset:'dialogue_fast',speech_rate:1.25,speech_mode:'auto'}}});
 wardrobe.saveCharacter(db,1,5,{description:'灰色卫衣、深蓝长裤'});
 let systemPrompt='';
 t.mock.method(ai,'generateText',async(_db,_log,_type,user,system)=>{
  systemPrompt=system;
  return JSON.stringify({storyboards:[{shot_number:1,title:'入梦',characters:[5],duration:8,action:'少年站在梦境入口',dialogue:'王奕宸："出发。"',narration:'',emotion:'急促争吵',speech_rate:1.4,speech_rate_reason:'急促短句',wardrobe_change:{boundary:'before_shot',reason:'梦中换装',evidence:'少年踏入梦境，换上银色训练服。',characters:[{character_id:5,stage_id:'silver'}]}}]});
 });
 const started=storyboard.generateStoryboard(db,log,10,null,null,1,8,'16:9',true,false,{min:4,max:8});
 const id=typeof started==='string'?started:started.task_id;
 await completedTask(db,id);
 assert.match(systemPrompt,/UNIVERSAL DIRECTING PRINCIPLES/);assert.match(systemPrompt,/wardrobe_change/);assert.match(systemPrompt,/灰色卫衣、深蓝长裤/);
 const shot=db.prepare('SELECT id FROM storyboards WHERE episode_id=10 AND deleted_at IS NULL').get();
 assert.equal(wardrobe.getShot(db,shot.id).characters[0].description,'银色训练服');
 assert.equal(wardrobe.getShot(db,shot.id).change.source,'ai');
 assert.equal(wardrobe.getShot(db,shot.id).characters[0].stage_id,'silver');
 assert.match(systemPrompt,/"id":"silver"/);
 assert.equal(require('../src/services/speechDeliveryService').getShot(db,shot.id).speech_rate,1);
 assert.match(systemPrompt,/实际 TTS 速度与台词预算/);
 assert.match(systemPrompt,/实际 TTS 速度/);
 assert.match(systemPrompt,/不要求每句简短/);
 assert.doesNotMatch(systemPrompt,/台词要短|台词用短句|Keep spoken lines short/);
});
test('the full storyboard pipeline repairs an in-shot change before saving stages and dialogue',async t=>{
 const db=setup(t);
 db.prepare('UPDATE characters SET stages=? WHERE id=5').run(JSON.stringify([{id:'silver',name:'梦境训练装',appearance:'银色训练服'}]));
 let calls=0;
 const change={reason:'进入梦境',evidence:'少年踏入梦境，换上银色训练服。',characters:[{character_id:5,stage_id:'silver'}]};
 t.mock.method(ai,'generateText',async()=>{
  calls++;
  if(calls===1)return JSON.stringify({storyboards:[{shot_number:1,characters:[5],duration:8,action:'少年换上银色训练服。',dialogue:'王奕宸："出发。开始训练。"',narration:'',wardrobe_change:{...change,boundary:'during_shot'}}]});
  return JSON.stringify([
   {characters:[5],duration:4,action:'少年走向梦境入口。',dialogue:'王奕宸："出发。"',narration:''},
   {characters:[5],duration:5,action:'少年站在训练台前。',dialogue:'王奕宸："开始训练。"',narration:'',wardrobe_change:{...change,boundary:'before_shot'}},
  ]);
 });
 const started=storyboard.generateStoryboard(db,log,10,null,null,1,8,'16:9',true,false,{min:4,max:8});
 await completedTask(db,typeof started==='string'?started:started.task_id);
 const shots=db.prepare('SELECT * FROM storyboards WHERE episode_id=10 AND deleted_at IS NULL ORDER BY storyboard_number').all();
 assert.equal(shots.length,2);assert.equal(calls,2);
 assert.equal(wardrobe.getShot(db,shots[0].id).change,null);
 assert.equal(wardrobe.getShot(db,shots[1].id).characters[0].stage_id,'silver');
 assert.deepEqual(shots.map(s=>s.dialogue),['王奕宸："出发。"','王奕宸："开始训练。"']);
});
test('frame prompt task keeps its saved text without appending execution-time wardrobe contracts',async t=>{
 const db=setup(t),frames=require('../src/services/framePromptService');
 wardrobe.saveCharacter(db,1,5,{description:'灰色卫衣、深蓝长裤'});
 const calls=[];
 t.mock.method(ai,'generateText',async(_db,_log,_type,user,system)=>{
  calls.push({user,system});return JSON.stringify({prompt:'王奕宸坐在书桌前，中景。',description:'静止画面'});
 });
 for(const kind of ['first','last']){
  const result=await completedTask(db,frames.generateFramePrompt(db,log,80,kind));
  const saved=frames.getFramePrompts(db,80).find(p=>p.frame_type===kind);
  assert.equal(result.response.single_frame.prompt,saved.prompt);
  assert.equal(saved.prompt,'王奕宸坐在书桌前，中景。');
 }
 assert.ok(calls.every(call=>call.user.includes('灰色卫衣、深蓝长裤')));
});

// Exercise the public prompt builders, including user overrides: these rules
// belong to script composition, not to rewriting approved storyboard dialogue.
test('general composition reaches every narrative style, both languages and custom script prompts',()=>{
 const prompts=require('../src/services/promptI18n');
 const rules=require('../src/services/storytellingPrompts');
 const cfg={app:{language:'zh'},narrative_style:{preset:'dialogue_fast',speech_rate:1.25,speech_mode:'auto'}};
 const zh=prompts.getStoryExpansionSystemPrompt(cfg,3);
 assert.match(zh,/通用剧本组织/);
 assert.match(zh,/包含 3 个对象/);
 assert.match(zh,/不要求每句简短/);
 assert.match(zh,/不能仅因选择“奇幻”就擅自添加肉身进入游戏/);
 const en=prompts.getStoryExpansionSystemPrompt({...cfg,app:{language:'en'}},3);
 assert.match(en,/GENERAL SCRIPT COMPOSITION/);
 assert.match(en,/character-to-avatar mappings/);
 assert.match(en,/3 object/);
 prompts.setOverrideInMemory('story_expansion_system','自定义剧本要求');
 try{
  const custom=prompts.getStoryExpansionSystemPrompt(cfg,3);
  assert.match(custom,/自定义剧本要求/);
  assert.match(custom,/通用剧本组织/);
 }finally{prompts.clearOverrideInMemory('story_expansion_system')}
 for(const preset of ['balanced','narration','atmosphere']){
  assert.match(prompts.getStoryExpansionSystemPrompt({...cfg,narrative_style:{preset}},1),/通用剧本组织/);
 }
 const breakdown=rules.storyboardRules(cfg,true);
 assert.doesNotMatch(breakdown,/通用剧本组织/);
 assert.match(breakdown,/逐字保留/);
});

test('public frame task loads Director slots and never invokes a second text model', async t => {
 const db=setup(t),frames=require('../src/services/framePromptService');
 const visual={character_id:5,name:'王奕宸',depth_layer:'midground',screen_position:'left_midground',environmental_anchor:'书桌前',facing:'three_quarter_right',facing_target_id:null,head_pose:'lowered',gaze_type:'prop',gaze_target_id:null,gaze_target_label:'桌上课本',posture:'sitting',hands_state:'holding_object',hands_object_id:null,hands_target_id:null,expression:'focused',expression_detail:'专注翻页',appearance_details:'日常居家服'};
 db.prepare('UPDATE storyboards SET semantic_slots=?, character_visuals=?, last_frame_visuals=? WHERE id=80').run(JSON.stringify({visible_characters:[{id:5}]}),JSON.stringify([visual]),JSON.stringify([{...visual,gaze_type:'character',gaze_target_label:'妈妈双眼'}]));
 let calls=0;
 t.mock.method(ai,'generateText',async()=>{calls++;throw new Error('Unexpected text rewrite');});
 for(const kind of ['first','last']){
  const result=await completedTask(db,frames.generateFramePrompt(db,log,80,kind));
  const saved=frames.getFramePrompts(db,80).find(p=>p.frame_type===kind);
  assert.equal(result.response.single_frame.prompt,saved.prompt);
  assert.ok(saved.prompt.includes(kind==='first'?'桌上课本':'妈妈双眼'));
 }
 assert.equal(calls,0);
});
