const { AUDIO_LIP_SYNC_MODES: modes } = require('./schema');

const voiceModes = new Set([modes.IN_FRAME_DIALOGUE, modes.OFFSCREEN_VOICEOVER, modes.NARRATION]);
const rule = 'INVARIANT_TIMELINE_SPEECH_COVERAGE';

function sourceGuide(text) {
  const chars = Array.from(text);
  const groups = [];
  let start = 0;
  for (let i = 0; i < chars.length; i++) {
    if (i + 1 === chars.length || i - start === 7 || /[，。！？；、,.!?;]/u.test(chars[i])) {
      groups.push(`${start + 1}–${i + 1}「${chars.slice(start, i + 1).join('')}」`);
      start = i + 1;
    }
  }
  return groups.join(' ');
}

// Compare an explicitly supplied fragment against the source; only quote
// typography can be restored without changing the chosen words or boundary.
const quoteGlyphs = s => s.replace(/[‘’]/gu, "'").replace(/[“”]/gu, '"');

function resolveTimelineSpeech(segments, text) {
  const chars = Array.from(text);
  const lastVoice = segments.findLastIndex(s => voiceModes.has(s?.audio_lip_sync?.mode));
  const resolved = [];
  let start = 0;
  function invalid(index, detail, field = 'speech_end') {
    return { segments, error: { rule, conflict_slots: [`video_slots.shots_timeline[${index}].audio_lip_sync.${field}`],
      message: `时间轴第 ${index + 1} 段：${detail}` } };
  }
  if (text && lastVoice < 0) return invalid(0, '有原文但没有发声段，请指定发声段的模式和同步表演。', 'mode');
  for (const [i, segment] of segments.entries()) {
    const audio = segment?.audio_lip_sync;
    if (!audio) return invalid(i, '缺少声音模式。', 'mode');
    const voiced = voiceModes.has(audio.mode);
    const { speech_end: selected, dialogue_content: supplied, ...plan } = audio;
    let end = start;
    if (voiced) {
      if (!text) return invalid(i, '本镜原文无台词，请选择无语言音轨。', 'mode');
      end = selected ?? (i === lastVoice ? chars.length : (typeof supplied === 'string' ? start + Array.from(supplied).length : null));
      if (!Number.isInteger(end) || end <= start || end > chars.length || (i === lastVoice && end !== chars.length)) {
        return invalid(i, `speech_end=${JSON.stringify(selected ?? null)}；本段从第 ${start + 1} 字开始，${i === lastVoice ? '最后一个发声段应读到第 ' + chars.length + ' 字' : '请选择本段最后一个字的位置'}。`);
      }
    } else if (supplied) {
      return invalid(i, '无语言段含有台词，请确认该段声音模式。', 'mode');
    } else if (selected != null) {
      return invalid(i, '无语言段请把 speech_end 留空。');
    }
    const fragment = chars.slice(start, end).join('');
    if (supplied != null && (typeof supplied !== 'string' || quoteGlyphs(supplied) !== quoteGlyphs(fragment))) {
      return invalid(i, `原文第 ${start + 1} 字起预期 ${JSON.stringify(fragment)}，实际 ${JSON.stringify(supplied)}。`);
    }
    resolved.push({ ...segment, audio_lip_sync: { ...plan, dialogue_content: fragment } });
    start = end;
  }
  return { segments: resolved };
}

module.exports = { resolveTimelineSpeech, sourceGuide, rule, voiceModes };
