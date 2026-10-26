import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { parse, compileScript } from '@vue/compiler-sfc'

const fileUrl = new URL('../src/components/filmCreate/AssetWorkbench.vue', import.meta.url)
const { descriptor } = parse(fs.readFileSync(fileUrl, 'utf8'))
const compiled = compileScript(descriptor, { id: 'character-upload-behavior' })
const functions = compiled.scriptSetupAst.filter(n => n.type === 'FunctionDeclaration' &&
  ['parseExtraImages','findResource','doUploadResourceImage'].includes(n.id.name))
assert.equal(functions.length, 3)
const source = functions.map(n => descriptor.scriptSetup.content.slice(n.start,n.end)).join('\n')

function setup(character = {}, fail = false) {
  const current = { id: 15, ...character }, calls = [], messages = []
  const bindings = {
    uploadingResourceId: { value: null }, dramaId: { value: 5 },
    store: { characters: [current], props: [{id:20}], scenes: [{id:30}] },
    uploadAPI: { uploadImage: async () => ({local_path:'uploads/face.jpg',url:'/static/uploads/face.jpg'}) },
    characterAPI: {
      putImage: async (id, body) => { calls.push({kind:'image',id,body}); if(fail) throw new Error('save failed') },
      putRefImage: async (id, path) => { calls.push({kind:'reference',id,path}); if(fail) throw new Error('save failed') },
    },
    propAPI: { update: async (id, body) => calls.push({kind:'prop',id,body}) },
    sceneAPI: { update: async (id, body) => calls.push({kind:'scene',id,body}) },
    loadDrama: async () => calls.push({kind:'reload'}),
    ElMessage: { success: text => messages.push({success:text}), error: text => messages.push({error:text}) },
  }
  const upload = new Function(...Object.keys(bindings), source+'\nreturn doUploadResourceImage')(...Object.values(bindings))
  return {upload,calls,messages,bindings}
}

test('first card upload saves the same photo as both its displayed image and its generation reference',async()=>{
  const {upload,calls}=setup()
  await upload('character',15,{})
  assert.deepEqual(calls[0],{kind:'image',id:15,body:{image_url:'/static/uploads/face.jpg',local_path:'uploads/face.jpg',ref_image:'uploads/face.jpg'}})
})

test('upload over an existing generated card keeps the card and associates the uploaded photo with generation',async()=>{
  const {upload,calls}=setup({local_path:'generated.png',extra_images:'["older.png"]'})
  await upload('character',15,{})
  assert.deepEqual(calls[0],{kind:'image',id:15,body:{extra_images:'["older.png","uploads/face.jpg"]',ref_image:'uploads/face.jpg'}})
  assert.equal('local_path' in calls[0].body,false)
})

test('additional card uploads keep an explicitly chosen identity photo',async()=>{
  const {upload,calls}=setup({local_path:'generated.png',ref_image:'chosen-face.jpg'})
  await upload('character',15,{})
  assert.equal('ref_image' in calls[0].body,false)
})

test('the dedicated reference-photo upload changes the identity source without filling or replacing a generated card',async()=>{
  for(const character of [{},{local_path:'generated.png',ref_image:'old-face.jpg'}]){
    const {upload,calls,bindings}=setup(character)
    await upload('character-reference',15,{})
    assert.deepEqual(calls,[{kind:'reference',id:15,path:'uploads/face.jpg'},{kind:'reload'}])
    assert.equal(bindings.uploadingResourceId.value,null)
  }
})

test('a failed photo association is shown as an error and never reports success',async()=>{
  const {upload,calls,messages,bindings}=setup({},true)
  await upload('character-reference',15,{})
  assert.deepEqual(messages,[{error:'save failed'}])
  assert.equal(calls.some(c=>c.kind==='reload'),false)
  assert.equal(bindings.uploadingResourceId.value,null)
})

test('prop and scene uploads do not become character references',async()=>{
  for(const [type,id] of [['prop',20],['scene',30]]){
    const {upload,calls}=setup()
    await upload(type,id,{})
    assert.equal(calls[0].kind,type)
    assert.equal('ref_image' in calls[0].body,false)
  }
})
