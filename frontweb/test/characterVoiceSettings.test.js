import test from 'node:test'
import assert from 'node:assert/strict'
import { withCharacterVoice } from '../src/utils/dubbingVoices.js'

test('editing a character voice keeps stable identity and every linked alias in sync', () => {
  const original = {
    config_id: 8, speed: 1.1, narrator_voice: 'narrator', default_voice: 'default',
    character_voices: { 5: 'old', 6: 'other' },
    voices: { 王奕宸: 'old', 王奕辰: 'old', 林教官: 'other', 广播: 'independent' },
    speaker_characters: { 王奕宸: 5, 王奕辰: '5', 林教官: 6, 广播: 0 },
  }
  const changed = withCharacterVoice(original, { id: 5, name: '王奕宸' }, 'new')
  assert.equal(changed.character_voices[5], 'new')
  assert.equal(changed.voices.王奕宸, 'new')
  assert.equal(changed.voices.王奕辰, 'new')
  assert.equal(changed.character_voices[6], 'other')
  assert.equal(changed.voices.广播, 'independent')
  assert.equal(changed.narrator_voice, 'narrator')
  assert.equal(changed.speed, 1.1)
  assert.equal(changed.config_id, 8)
  assert.equal(original.character_voices[5], 'old')
  assert.equal(original.voices.王奕辰, 'old')
  const renamed = withCharacterVoice(changed, { id: 5, name: '新名字' }, 'newer')
  assert.equal(renamed.character_voices[5], 'newer')
  assert.equal(renamed.voices.新名字, 'newer')
  assert.equal(renamed.voices.王奕宸, 'newer')
})

test('character voice selection rejects the narrator voice and blank IDs', () => {
  const character = { id: 5, name: '王奕宸' }
  assert.throws(() => withCharacterVoice({ narrator_voice: 'narrator' }, character, ' narrator '), /不能与旁白相同/)
  assert.throws(() => withCharacterVoice({}, character, '  '), /请选择人物音色/)
})

import { shotSpeechStatus, automaticVideoModel } from '../src/utils/shotSpeech.js'
test('shot speech indicators distinguish absent content and pending universal extraction', () => {
  assert.deepEqual(shotSpeechStatus({dialogue:'无对白',narration:'无旁白'}),{dialogue:false,narration:false,pending:false})
  const pending=shotSpeechStatus({universal_segment_text:'旁白：他们走远。'})
  assert.equal(pending.pending,true)
  const known={dialogue:false,narration:true,pending:false,sourceDialogue:'',sourceNarration:'',sourceUniversal:'旁白：他们走远。'}
  assert.equal(shotSpeechStatus({universal_segment_text:known.sourceUniversal},known).narration,true)
  assert.equal(shotSpeechStatus({dialogue:'小明：你好'},known).dialogue,true)
})
test('automatic model choice defaults to minimax_h3 and falls back when unavailable', () => {
  const configs=[{is_active:true,is_default:true,provider:'comfyui_wan22',model:['Wan2.2']},{is_active:true,provider:'openai',default_model:'minimax_h3',model:['minimax_h3']}]
  assert.equal(automaticVideoModel(configs,{dialogue:true}),'minimax_h3')
  assert.equal(automaticVideoModel(configs,{narration:true}),'minimax_h3')
  assert.equal(automaticVideoModel(configs,{}),'minimax_h3')
  assert.equal(automaticVideoModel([configs[0]],{}),'Wan2.2')
})
