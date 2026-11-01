const test = require('node:test');
const assert = require('node:assert/strict');
const pacing = require('../src/ontology/directorPacing');
const runtime = require('../src/services/agentsRuntime');
const range = { shot_duration_range: { min: 4, max: 8 } };
const plan = (durations, feasible = true) => ({ feasible, reason: '完整对白与扶起动作需要时间', shots: durations.map(duration => ({ duration, purpose: '对白并完成剧情动作' })) });

test('empty fields stay automatic; arithmetic conflicts give an actionable range', () => {
  assert.deepEqual(pacing.constraints({}, range), { count: null, duration: null, range: { min: 4, max: 8 } });
  assert.throws(() => pacing.constraints({ storyboard_count: 10, video_duration: 131 }, range), /17–32 镜/);
  assert.throws(() => pacing.constraints({ storyboard_count: 1.5 }, range), /整数/);
  assert.throws(() => pacing.constraints({ video_duration: 10 }, { shot_duration_range: { min: 8, max: 8 } }), /无法同时满足/);
  assert.equal(pacing.constraints({ video_duration: 131 }, range).count, null);
});

test('automatic count comes from SDK Director planning, not text length or old duration', async t => {
  const calls=[];
  t.mock.method(runtime,'runAgent',async(_db,_log,o)=>{calls.push(o);return plan([4,8,6]);});
  const progress=[];
  const result=await pacing.planEpisodePacing(null,{},'一段很短但有三个剧情事件的剧本',pacing.constraints({},range),{maxAttempts:2,onProgress:(_p,m)=>progress.push(m)});
  assert.equal(result.total_shots,3); assert.equal(result.total_duration,18);
  assert.match(calls[0].input,/一段很短但有三个剧情事件的剧本/);
  assert.match(progress.at(-1),/3 镜、共 18 秒/);
});

test('manual short count returns Director advice without silently accepting the larger plan', async t=>{
  t.mock.method(runtime,'runAgent',async()=>plan([8,8,4],false));
  await assert.rejects(pacing.planEpisodePacing(null,{},'完整原台词',pacing.constraints({storyboard_count:1},range),{maxAttempts:2}),error=>{
    assert.match(error.message,/建议 3 镜、共 20 秒/);
    assert.match(error.message,/原分镜未覆盖/);
    assert.equal(error.planning_advice.requested.count,1);
    return true;
  });
});

test('invalid planning goes back to the Agent with feedback; no duration normalization',async t=>{
  const calls=[];
  t.mock.method(runtime,'runAgent',async(_db,_log,o)=>{calls.push(o);return calls.length===1 ? plan([9,4]) : plan([8,4]);});
  const result=await pacing.planEpisodePacing(null,{},'原文',pacing.constraints({storyboard_count:2,video_duration:12},range),{maxAttempts:2});
  assert.equal(result.total_duration,12);assert.match(calls[1].input,/上轮门禁反馈.*4–8/);
});

test('manual requests are enforced before persistence even after structural repairs',()=>{
  const requested=pacing.constraints({storyboard_count:2,video_duration:12},range);
  assert.throws(()=>pacing.assertManualTargets([{duration:8},{duration:8}],requested),/手动要求/);
  pacing.assertManualTargets([{duration:8},{duration:4}],requested);
  assert.throws(()=>pacing.validatePlan(plan([8,8]),requested),/未满足用户/);
});
