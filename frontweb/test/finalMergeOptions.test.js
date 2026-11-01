import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { parse, compileScript } from '@vue/compiler-sfc'

const { descriptor } = parse(fs.readFileSync(new URL('../src/components/filmCreate/FinalMergeWorkbench.vue', import.meta.url), 'utf8'))
const compiled = compileScript(descriptor, { id: 'merge-options' })
function setup() {
  const ref = value => ({ value })
  const bindings = {
    videoSubtitle: ref(false), videoBurnDialogue: ref(false), videoBurnNarration: ref(false),
    videoWatermark: ref(false), videoWatermarkText: ref(''), videoTailBlack: ref(true),
  }
  const names = ['getFinalizeMergeOptions']
  const code = names.map(name => {
    const node = compiled.scriptSetupAst.find(n => n.type === 'FunctionDeclaration' && n.id.name === name)
    return descriptor.scriptSetup.content.slice(node.start, node.end)
  }).join('\n')
  const result = new Function(...Object.keys(bindings), code + ';return {getFinalizeMergeOptions}')(...Object.values(bindings))
  return { ...result, ...bindings }
}

test('subtitle switch sends only subtitles, never enables TTS replacement', () => {
  const view = setup()
  view.videoSubtitle.value = true
  assert.deepEqual(view.getFinalizeMergeOptions(), {
    burn_subtitles: true, burn_dialogue_audio: false, burn_narration_audio: false,
    watermark_text: '', tail_black_seconds: 1,
  })
})

test('subtitle and optional audio replacement settings stay independent', () => {
  const view = setup()
  view.videoBurnNarration.value = true
  assert.equal(view.getFinalizeMergeOptions().burn_subtitles, false)
  assert.equal(view.getFinalizeMergeOptions().burn_narration_audio, true)
  view.videoSubtitle.value = true
  view.videoBurnNarration.value = false
  view.videoBurnDialogue.value = true
  assert.equal(view.getFinalizeMergeOptions().burn_subtitles, true)
  assert.equal(view.getFinalizeMergeOptions().burn_dialogue_audio, true)
  assert.equal(view.getFinalizeMergeOptions().burn_narration_audio, false)
})
