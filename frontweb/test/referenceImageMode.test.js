import test from 'node:test'
import assert from 'node:assert/strict'
import { referenceImageMode, usesFourViews } from '../src/utils/referenceImageMode.js'
import { referenceImageJobs, runReferenceImageBatch } from '../src/utils/referenceImageBatch.js'

test('a mixed batch uses each resource setting and leaves existing images alone', async () => {
  const scenes=[{id:1,reference_image_mode:'quad_grid'},{id:2,reference_image_mode:'single'},{id:3,local_path:'already.png',reference_image_mode:'quad_grid'}]
  const jobs=referenceImageJobs({scene:scenes})
  const generated=[]
  await runReferenceImageBatch(jobs,{
    resolve:job=>scenes.find(s=>s.id===job.id),isRunning:()=>false,shouldStop:()=>false,
    generate:async(job,resource)=>{generated.push({id:job.id,use_quad_grid:usesFourViews(resource)});return {status:'completed'}},
  })
  assert.deepEqual(generated,[{id:1,use_quad_grid:true},{id:2,use_quad_grid:false}])
  assert.equal(referenceImageMode({reference_image_recommendation:'quad_grid'}),'single','an AI recommendation must not override a user selection')
});
