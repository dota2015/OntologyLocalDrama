const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const os=require('os');
const {spawnSync}=require('child_process');
const Database=require('better-sqlite3');
const merge=require('../src/services/videoMergeService');
const post=require('../src/services/mergedEpisodePostProcess');
const log={info(){},warn(){},error(){}};
function run(cmd,args){const r=spawnSync(cmd,args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout;}
test('mixing silent Wan and musical H3 shots preserves H3 audio before and after TTS composition',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'lmd-mixed-audio-'));
  const db=new Database(':memory:');
  t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
  db.exec(`CREATE TABLE dramas(id INTEGER,metadata TEXT,deleted_at TEXT);CREATE TABLE episodes(id INTEGER,drama_id INTEGER,deleted_at TEXT);
    CREATE TABLE storyboards(id INTEGER,episode_id INTEGER,dialogue TEXT,narration TEXT,audio_local_path TEXT,narration_audio_local_path TEXT,deleted_at TEXT);
    INSERT INTO dramas VALUES(1,'{}',NULL);INSERT INTO episodes VALUES(1,1,NULL);
    INSERT INTO storyboards VALUES(1,1,'甲：你好','', 'speech.mp3',NULL,NULL),(2,1,'无对白','无旁白',NULL,NULL,NULL);`);
  const wan=path.join(root,'wan.mp4'),h3=path.join(root,'h3.mp4'),combined=path.join(root,'input.mp4');
  run('ffmpeg',['-y','-f','lavfi','-i','color=black:s=64x64:r=16:d=1','-c:v','libx264','-pix_fmt','yuv420p',wan]);
  run('ffmpeg',['-y','-f','lavfi','-i','color=black:s=64x64:r=24:d=1','-f','lavfi','-i','sine=frequency=880:duration=1','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',h3]);
  run('ffmpeg',['-y','-f','lavfi','-i','sine=frequency=440:duration=0.7',path.join(root,'speech.mp3')]);
  assert.equal(merge.runFfmpegConcat([wan,h3],combined,log),true);
  const duration=Number(run('ffprobe',['-v','error','-show_entries','format=duration','-of','csv=p=0',combined]).trim());
  assert.ok(duration>1.9 && duration<2.3, String(duration));
  function rms(file,start){
    const r=spawnSync('ffmpeg',['-v','error','-ss',String(start),'-i',file,'-t','0.2','-map','0:a:0','-f','f32le','-ac','1','-ar','8000','-'],{maxBuffer:1024*1024});
    assert.equal(r.status,0,String(r.stderr));let sum=0;const n=r.stdout.length/4;for(let i=0;i<n;i++)sum+=r.stdout.readFloatLE(i*4)**2;return Math.sqrt(sum/n);
  }
  assert.ok(rms(combined,1.3)>0.01,'H3 background music survives concat after a silent first clip');
  const output=await post.runMergedEpisodePostProcess(db,log,{mergedAbsPath:combined,storageRoot:root,sceneSourcePaths:[wan,h3],scenes:[{scene_id:1,duration:1},{scene_id:2,duration:1}],episodeId:1,mergeOpts:{burn_dialogue_audio:true}});
  assert.equal(output.ok,true,output.error);
  const final=path.join(root,output.relativePath);
  assert.ok(rms(final,0.2)>0.01,'Wan shot receives TTS');
  assert.ok(rms(final,1.3)>0.01,'H3 shot retains background music after TTS composition');
});
