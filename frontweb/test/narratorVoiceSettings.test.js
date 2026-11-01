import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { parse, compileScript } from '@vue/compiler-sfc'

const { descriptor } = parse(fs.readFileSync(new URL('../src/components/NarratorVoiceSettings.vue', import.meta.url), 'utf8'))
const compiled = compileScript(descriptor, { id: 'narrator-settings' })
const node = compiled.scriptSetupAst.find(n => n.type === 'FunctionDeclaration' && n.id.name === 'save')
const source = descriptor.scriptSetup.content.slice(node.start, node.end)

test('saving narrator settings preserves the latest character bindings and does not read storyboard speech', async () => {
  const calls = []
  const current = { config_id: 1, voices: { 小明: 'new-character-voice' }, character_voices: { 2: 'new-character-voice' }, speaker_characters: { 小明: 2 } }
  const bindings = {
    endpoint: () => '/audio/dubbing/1',
    profile: { value: { config_id: 1, default_voice: 'default', narrator_voice: 'narrator', character_voices: { 2: 'stale-voice' } } },
    saving: { value: false }, error: { value: '' }, emit() {}, ElMessage: { success() {} },
    api: async (url, body, method) => {
      calls.push({ url, body, method })
      return body || { profile: current }
    },
  }
  const save = new Function(...Object.keys(bindings), source + ';return save')(...Object.values(bindings))
  await save()
  assert.equal(calls[0].url, '/audio/dubbing/1/profile')
  assert.equal(calls[1].method, 'PUT')
  assert.equal(calls[1].body.narrator_voice, 'narrator')
  assert.deepEqual(calls[1].body.character_voices, current.character_voices)
  assert.deepEqual(calls[1].body.speaker_characters, current.speaker_characters)
  assert.equal(bindings.error.value, '')
})
