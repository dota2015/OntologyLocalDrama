const test = require('node:test');
const assert = require('node:assert/strict');
const {
  autoSplitMultiSpeakerShot,
  partitionExcerptBySegments,
  autoPatchShotViolations,
  auditDirectorDraft,
} = require('../src/ontology/directorAgent');
const { isGazeOnlyHold } = require('../src/ontology/videoSlots');
const { dialogueSegments } = require('../src/services/dialogueDubbingService');

test('isGazeOnlyHold recognizes domestic/subtle physical actions and speech', () => {
  // Action with lowering head, hands on desk, shoulders dropping
  const values = [
    '继续低声承认，肩膀微微下沉',
    '坐姿，双手搭在桌沿，肩膀下沉，嘴唇开合',
    '被点破后的沉默与承认',
    '丽霞的注视',
  ];
  assert.equal(isGazeOnlyHold(values), false, 'Should recognize physical actions like 下沉/低头/开合/搭在');

  // Pure gaze without physical event should still be true
  const gazeValues = [
    '两人互相看着，保持不动',
    '坐着等待，眼神对视',
  ];
  assert.equal(isGazeOnlyHold(gazeValues), true, 'Pure gaze without physical action should be true');
});

test('partitionExcerptBySegments correctly partitions multi-line dialogue excerpt', () => {
  const excerpt = '蜂医：“上一次的教训已经够大了。红狼，别急着出发。”\n红狼：“上次是我反应慢了。这次只要我打得快，敌人就没机会包围我们。”\n露娜：“反应快不能代替准备。你连任务目标都没听完。”\n红狼：“边走边看也一样，出发！”';
  const segs = dialogueSegments(excerpt);
  assert.equal(segs.length, 4);

  const parts = partitionExcerptBySegments(excerpt, segs);
  assert.equal(parts.length, 4);
  assert.equal(parts.join('\n'), excerpt);
});

test('autoSplitMultiSpeakerShot splits multi-speaker shot into individual valid shots', () => {
  const excerpt = '蜂医：“上一次的教训已经够大了。红狼，别急着出发。”\n红狼：“上次是我反应慢了。这次只要我打得快，敌人就没机会包围我们。”';
  const dramaChars = [
    { id: 25, name: '红狼' },
    { id: 26, name: '蜂医' },
  ];
  const targetShot = {
    shot_number: 5,
    title: '对峙',
    duration: 8,
    dialogue: '蜂医: "上一次的教训已经够大了。红狼，别急着出发。"\n红狼: "上次是我反应慢了。这次只要我打得快，敌人就没机会包围我们。"',
    narration: '',
    action: '蜂医劝阻红狼，红狼反驳',
    result: '两人对峙',
    characters: [26, 25],
    semantic_slots: {
      source_script_excerpt: excerpt,
      shot_duration: 8,
      visible_characters: [{ id: 26, name: '蜂医' }, { id: 25, name: '红狼' }],
      background_characters: [],
      speech_plan: {
        speaker_id: 26,
        speaker_name: '蜂医',
        text: '上一次的教训已经够大了。红狼，别急着出发。',
        speed: 1.25,
      },
    },
    video_slots: {
      timing: { duration: 8 },
      audio_lip_sync: {
        mode: 'in_frame_dialogue',
        speaker_name: '蜂医',
        speaker_in_frame: true,
        dialogue_content: '上一次的教训已经够大了。红狼，别急着出发。',
      },
    },
  };

  const split = autoSplitMultiSpeakerShot(targetShot, dramaChars);
  assert.ok(Array.isArray(split));
  assert.equal(split.length, 2);
  assert.equal(split[0].semantic_slots.speech_plan.speaker_name, '蜂医');
  assert.equal(split[1].semantic_slots.speech_plan.speaker_name, '红狼');
  assert.equal(split[0].duration, 6);
  assert.equal(split[1].duration, 6);
});
