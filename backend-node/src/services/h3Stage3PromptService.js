'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { compileActionAtom } = require('../ontology/videoSlots');
const agentsRuntime = require('./agentsRuntime');
const { referenceCharacterId, groupSubjects, resolveRequiredReference } = require('./h3ReferenceBindings');
const angleService = require('./angleService');
const wardrobeService = require('./wardrobeService');
const { resolveH3Mode, resolveH3SubmissionPlan, deriveManualRef2vaReferences } = require('./h3ModeResolver');
const { resolvedStreamStyleFromDrama } = require('../utils/dramaStyleMerge');

const SKILL_DIR = path.resolve(__dirname, '../skills/h3-prompt-writing');
const REF2VA_HEADERS = [
  'subject_definitions',
  'summary',
  'retention_analysis',
  'detailed_description',
  'overall_soundscape',
  'non_diegetic_music',
];
const BASE_HEADERS = [
  'integrated_multimodal_description',
  'overall_soundscape',
  'non_diegetic_music',
];

function parseJson(value, fallback = null) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function stableStringify(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableStringify(value)).digest('hex');
}

function loadOfficialH3Skill(mode = 'ref2va') {
  const skillPath = path.join(SKILL_DIR, 'SKILL.md');
  const guideFile = mode === 'fl2va' ? 'references/base-en.txt' : 'references/ref-en.txt';
  const guidePath = path.join(SKILL_DIR, guideFile);
  return {
    skill: fs.readFileSync(skillPath, 'utf8'),
    guide: fs.readFileSync(guidePath, 'utf8'),
    guideFile,
  };
}

function normalizeAudioRoleList(shot, semantic, speech) {
  if (speech && Array.isArray(speech.references)) {
    const lines = Array.isArray(speech.lines) ? speech.lines : [];
    const references = speech.references
      .filter((ref) => ref && ref.kind !== 'soundtrack')
      .map((ref) => ({
        key: String(ref.key || ''),
        kind: ref.kind === 'narration' ? 'narration' : 'dialogue',
        speaker: String(ref.speaker || '').trim(),
      }));
    const normalizedLines = lines.map((line) => ({
      key: String(line.key || ''),
      kind: line.kind === 'narration' ? 'narration' : 'dialogue',
      speaker: String(line.speaker || '').trim(),
      text: String(line.text || '').trim(),
      language: /\p{Script=Han}/u.test(String(line.text || '')) ? 'Chinese' : 'English',
      start_seconds: Number.isFinite(Number(line.start_seconds ?? line.start)) ? Number(line.start_seconds ?? line.start) : null,
      end_seconds: Number.isFinite(Number(line.end_seconds ?? line.end)) ? Number(line.end_seconds ?? line.end) : null,
    })).filter((line) => line.text);
    return { references, lines: normalizedLines };
  }

  const sp = semantic?.speech_plan && typeof semantic.speech_plan === 'object' ? semantic.speech_plan : {};
  const text = String(sp.text || shot?.dialogue || shot?.narration || '').trim();
  if (!text) return { references: [], lines: [] };
  const isNarration = Boolean(sp.is_narration || (!shot?.dialogue && shot?.narration));
  const speakerId = Number(sp.speaker_id);
  const speakerName = String(sp.speaker_name || (isNarration ? '旁白' : '')).trim();
  const key = isNarration
    ? 'narrator'
    : (Number.isFinite(speakerId) && speakerId > 0 ? `character:${speakerId}` : `speaker:${speakerName || '未标注人物'}`);
  return {
    references: [{ key, kind: isNarration ? 'narration' : 'dialogue', speaker: isNarration ? '旁白' : speakerName }],
    lines: [{
      key,
      kind: isNarration ? 'narration' : 'dialogue',
      speaker: isNarration ? '旁白' : speakerName,
      text,
      language: /\p{Script=Han}/u.test(text) ? 'Chinese' : 'English',
      start_seconds: null,
      end_seconds: null,
    }],
  };
}

function buildPictureBindings({ mode, refs = [], firstFramePresent = false, lastFramePresent = false, duration = 5, clothing = {}, db, dramaId }) {
  const charAppearanceById = new Map();
  if (db && dramaId) {
    try {
      const rows = db.prepare('SELECT id, name, appearance, description FROM characters WHERE drama_id=? AND deleted_at IS NULL').all(Number(dramaId));
      for (const r of rows) {
        charAppearanceById.set(Number(r.id), { name: r.name, appearance: r.appearance || '', description: r.description || '' });
      }
    } catch (_) {}
  }
  const wardrobeByCharId = new Map(
    (Array.isArray(clothing?.characters) ? clothing.characters : [])
      .map((item) => [Number(item.character_id ?? item.id), item])
      .filter(([id]) => Number.isFinite(id) && id > 0)
  );

  if (mode === 'fl2va') {
    const out = [];
    if (firstFramePresent) {
      out.push({ tag: '<Picture 1>', role: 'first_frame', timestamp_seconds: 0, description: 'Opening first frame anchor at 0.00s' });
    }
    if (lastFramePresent) {
      const idx = out.length + 1;
      out.push({ tag: `<Picture ${idx}>`, role: 'last_frame', timestamp_seconds: Number(duration || 5), description: `Ending last frame anchor at ${Number(duration || 5).toFixed(2)}s` });
    }
    return out;
  }

  return (Array.isArray(refs) ? refs : []).map((ref, idx) => {
    const type = String(ref?.type || ref?.kind || 'context').toLowerCase();
    const charId = referenceCharacterId(ref);
    const catalogChar = Number.isFinite(charId) && charId > 0 ? charAppearanceById.get(charId) : null;
    const wardrobeChar = Number.isFinite(charId) && charId > 0 ? wardrobeByCharId.get(charId) : null;
    return {
      tag: `<Picture ${idx + 1}>`,
      type: charId ? 'character' : type,
      role: ref?.kind || type,
      id: ref?.id != null ? Number(ref.id) : (Number.isFinite(charId) ? charId : null),
      character_id: Number.isFinite(charId) && charId > 0 ? charId : null,
      name: String(catalogChar?.name || ref?.name || '').trim(),
      reference_label: String(ref?.name || '').trim(),
      appearance: String(wardrobeChar?.description || wardrobeChar?.appearance || ref?.appearance || ref?.description || catalogChar?.appearance || '').trim(),
    };
  });
}

function buildStage3PromptSpec(db, shot, context = {}) {
  const semantic = parseJson(shot?.semantic_slots, {}) || {};
  const videoSlots = parseJson(shot?.video_slots, {}) || {};
  const characterVisuals = parseJson(shot?.character_visuals, []) || [];
  const lastFrameVisuals = parseJson(shot?.last_frame_visuals, []) || [];
  const episodeRow = context.episode || (db && shot?.episode_id ? db.prepare('SELECT id, drama_id FROM episodes WHERE id=?').get(Number(shot.episode_id)) : null);
  const dramaId = Number(context.dramaId || episodeRow?.drama_id || 0);
  const dramaRow = context.project || (() => {
    try { return (db && dramaId) ? db.prepare('SELECT * FROM dramas WHERE id=? AND deleted_at IS NULL').get(dramaId) : {}; } catch (_) { return {}; }
  })() || {};
  const sceneRow = context.scene || (() => {
    try { return (db && shot?.scene_id) ? db.prepare('SELECT * FROM scenes WHERE id=?').get(Number(shot.scene_id)) : null; } catch (_) { return null; }
  })();
  const clothing = context.clothing || (db && shot?.id ? wardrobeService.getShot(db, shot.id) : { characters: [] });

  const plan = context.executionPlan || (db && dramaId ? resolveH3SubmissionPlan(db, dramaId, shot) : resolveH3Mode(shot, context.manualPlan || {}));
  const mode = plan?.mode === 'fl2va' ? 'fl2va' : 'ref2va';
  const duration = Math.max(4, Math.min(30, Math.round(Number(context.duration || semantic.shot_duration || shot?.duration || videoSlots?.timing?.duration || 5))));
  const executionBackend = String(semantic.execution_backend || videoSlots.execution_backend || (duration >= 9 ? 'h3_continuum' : 'h3_single'));
  const lightingStyle = String(shot?.lighting_style || videoSlots?.lighting_style || '').trim();
  const lightingDesc = context.lightingDesc || (lightingStyle ? angleService.lightingToPrompt(lightingStyle) : '');
  const style = String(context.style || resolvedStreamStyleFromDrama('', dramaRow) || dramaRow.style || '').trim();
  const aspectRatio = String(context.aspect_ratio || context.aspectRatio || parseJson(dramaRow.metadata, {})?.aspect_ratio || '16:9').trim();

  const rawRefs = context.refs
    || (mode === 'ref2va'
      ? (Array.isArray(plan?.references) && plan.references.length
        ? plan.references
        : (db && dramaId ? deriveManualRef2vaReferences(db, dramaId, shot) : []))
      : []);
  const firstFramePresent = mode === 'fl2va'
    ? Boolean(context.firstFramePresent ?? (context.anchors?.first || plan?.first_frame_policy === 'inherit_tail' || shot?.first_frame_image_id || shot?.local_path || shot?.image_url))
    : false;
  const lastFramePresent = mode === 'fl2va'
    ? Boolean(context.lastFramePresent ?? (context.anchors?.last || (plan?.last_frame_policy === 'generate_tail' && (shot?.last_frame_image_id || shot?.last_frame_local_path || shot?.last_frame_image_url))))
    : false;

  const pictureBindings = buildPictureBindings({
    mode,
    refs: rawRefs,
    firstFramePresent,
    lastFramePresent,
    duration,
    clothing,
    db,
    dramaId,
  });

  const audio = normalizeAudioRoleList(shot, semantic, context.speech);
  const audioBindings = mode === 'fl2va'
    ? []
    : audio.references.map((ref, idx) => ({
      tag: `<Audio ${idx + 1}>`,
      key: ref.key,
      kind: ref.kind,
      speaker_name: ref.speaker,
    }));

  // Deliberately project Stage 2's structured timeline and visuals without Stage 1's
  // concatenated shot.description string so stale 【运镜】 labels cannot contradict video_slots.
  const timeline = Array.isArray(videoSlots.shots_timeline) ? videoSlots.shots_timeline : [];
  // Expose the script once. Segments retain the timing and voice source.
  const fragments = timeline.map(segment => segment.audio_lip_sync?.dialogue_content || '');
  const hasExactSpans = fragments.join('') === audio.lines.map(line => line.text).join('');
  let speechOffset = 0;
  const executionTimeline = timeline.map((segment, index) => {
    const { dialogue_content, ...audioTiming } = segment.audio_lip_sync || {};
    const start = speechOffset;
    speechOffset += Array.from(fragments[index]).length;
    const speechRange = hasExactSpans && speechOffset > start ? [start, speechOffset] : null;
    return { ...segment, audio_lip_sync: { ...audioTiming, has_speech: Boolean(dialogue_content?.trim()), speech_range: speechRange } };
  });
  const { text: speechText, ...speechPlan } = semantic.speech_plan || {};
  const { dialogue_content: projectedText, ...voicePlan } = videoSlots.audio_lip_sync || {};
  const authoritativeContract = {
    expected_visible_end_state: String(shot?.result || '').trim(),
    scene: sceneRow ? {
      id: Number(sceneRow.id),
      location: String(sceneRow.location || sceneRow.name || shot?.location || '').trim(),
      time: String(sceneRow.time || shot?.time || '').trim(),
      atmosphere: String(sceneRow.atmosphere || shot?.atmosphere || '').trim(),
      description: String(sceneRow.description || '').trim(),
    } : {
      id: shot?.scene_id ? Number(shot.scene_id) : null,
      location: String(shot?.location || '').trim(),
      time: String(shot?.time || '').trim(),
      atmosphere: String(shot?.atmosphere || '').trim(),
    },
    lighting: {
      style: lightingStyle,
      prompt: lightingDesc,
      atmosphere: String(shot?.atmosphere || '').trim(),
    },
    semantic_slots: {
      visible_characters: semantic.visible_characters || [],
      background_characters: semantic.background_characters || [],
      offscreen_characters: semantic.offscreen_characters || [],
      audio_lip_sync: semantic.audio_lip_sync,
      identity_visibility: semantic.identity_visibility || '',
      dialogue_framing: shot?.dialogue_framing || semantic.dialogue_framing || '',
      speech_plan: speechPlan,
      sound_plan: semantic.sound_plan || {},
      continuity_from_previous: semantic.continuity_from_previous || null,
      execution_backend: executionBackend,
      continuum_plan: semantic.continuum_plan || null,
    },
    wardrobe: Array.isArray(clothing?.characters) ? clothing.characters : [],
    character_visuals: characterVisuals,
    ...(mode === 'fl2va' && lastFrameVisuals.length ? { last_frame_visuals: lastFrameVisuals } : {}),
    video_slots: {
      audio_lip_sync: voicePlan,
      camera: videoSlots.camera || null,
      timing: videoSlots.timing || { duration },
      environment_vfx: videoSlots.environment_vfx || null,
      h3_multimodal: videoSlots.h3_multimodal || null,
      shots_timeline: timeline.length ? executionTimeline : [{
        shot_number: 1,
        timestamp: null,
        duration,
        camera: {
          shot_type: shot?.shot_type || '',
          movement: shot?.movement || 'static',
        },
        action: shot?.action || '',
        result: shot?.result || '',
      }],
    },
  };

  return {
    version: 'h3_stage3_v3',
    storyboard_id: Number(shot?.id || 0) || null,
    shot_number: Number(shot?.storyboard_number || shot?.shot_number || 1),
    mode,
    execution_backend: executionBackend,
    duration_seconds: duration,
    aspect_ratio: aspectRatio,
    visual_style: style,
    firstFramePresent,
    lastFramePresent,
    picture_bindings: pictureBindings,
    audio_bindings: audioBindings,
    spoken_lines: audio.lines,
    authoritative_contract: authoritativeContract,
  };
}

function buildDeterministicStage3Skeleton(spec) {
  if (!spec || typeof spec !== 'object') return '';

  const picBindings = Array.isArray(spec.picture_bindings) ? spec.picture_bindings : [];
  const audioBindings = Array.isArray(spec.audio_bindings) ? spec.audio_bindings : [];
  const contract = spec.authoritative_contract || {};
  const semantic = contract.semantic_slots || {};
  const videoSlots = contract.video_slots || {};
  const timeline = Array.isArray(videoSlots.shots_timeline) && videoSlots.shots_timeline.length > 0
    ? videoSlots.shots_timeline
    : [{
      shot_number: 1,
      timestamp: null,
      duration: spec.duration_seconds || 5,
      camera: videoSlots.camera || {},
      action: '',
      character_trajectories: [],
    }];

  const subjectLines = [];
  if (spec.mode === 'fl2va') {
    for (const pb of picBindings) {
      subjectLines.push(`- ${pb.tag}: ${pb.role} (${pb.description || ''})`);
    }
  } else {
    for (const subject of groupSubjects(picBindings)) {
      const first = subject.pictures[0];
      const sources = subject.pictures.map(p => `${p.tag} (${[p.reference_label, p.role, p.appearance].filter(Boolean).join(', ')})`);
      subjectLines.push(`- ${subject.tag}: ${first.type} ${first.name || ''} referenced from ${sources.join(' and ')}`);
    }
  }

  const audioLines = audioBindings.map((ab) => `- ${ab.tag}: Audio reference for ${ab.speaker_name || ab.key || 'voice'} (${ab.kind})`);

  const nonSpeakingModes = new Set(['offscreen_voiceover', 'narration', 'silent_ambient', 'bgm_only']);


  const actorTags = new Map(groupSubjects(picBindings).filter(s => s.characterId).map(s => [s.characterId, s.tag]));
  let cameraShot = 0;
  const shotTimelineLines = timeline.map((seg, idx) => {
    const newAngle = idx === 0 || seg.camera?.shot_change === true;
    if (newAngle) cameraShot++;
    const cutHeader = newAngle ? `[Shot ${cameraShot}]` : 'Continue same take';
    const timeLabel = seg.timestamp ? ` at ${seg.timestamp}` : '';
    const durStr = Number.isFinite(Number(seg.duration)) ? ` (duration: ${Number(seg.duration)}s)` : '';
    const cam = seg.camera || {};
    const camDesc = `Camera: ${cam.shot_type || 'medium_shot'}, movement: ${cam.movement || 'static'}, horizontal angle: ${cam.angle_h || 'eye_level'}, vertical angle: ${cam.angle_v || 'level'}`;

    const voiceMode = seg.audio_lip_sync?.mode || semantic.audio_lip_sync;
    const inFrameSpeech = !nonSpeakingModes.has(voiceMode) && seg.audio_lip_sync?.speaker_in_frame === true && seg.audio_lip_sync?.has_speech && !semantic.sound_plan?.is_silent;
    const charLines = [];
    const trajectories = Array.isArray(seg.character_trajectories) ? seg.character_trajectories : [];
    if (trajectories.length > 0) {
      for (const traj of trajectories) {
        const charName = actorTags.get(Number(traj.character_id)) || traj.character_name || traj.name || (traj.character_id ? `Character ID ${traj.character_id}` : 'Character');
        const pos = traj.screen_position || 'center';
        const depth = traj.depth_layer || 'midground';
        const facing = traj.facing || 'front';
        const gaze = [traj.gaze_type || traj.gaze?.gaze_type, traj.gaze_target_label || traj.gaze?.gaze_target_label].filter(Boolean).join(' towards ');
        const actAtom = [...new Set([compileActionAtom(traj.action_atom, { actorName: charName }), traj.action_atom?.action_detail].filter(Boolean))].join(' — ');
        const resState = traj.result_state ? `ending in ${traj.result_state}` : '';
        const actionPart = [actAtom, resState].filter(Boolean).join(' -> ');

        let lipConstraint = '';
        const mouthState = traj.mouth_state;
        if (inFrameSpeech && mouthState === 'speaker_synced') {
          lipConstraint = 'Mouth: sync to the scheduled speech during this segment';
        } else {
          lipConstraint = 'Mouth: keeps lips strictly closed without speaking';
        }

        charLines.push(`  * ${charName}: position at ${pos} (${depth}), facing ${facing}, gaze ${gaze}. ${actionPart}. ${lipConstraint}`);
      }
    } else {
      for (const vc of seg.visible_characters || []) {
        charLines.push(`  * ${vc.name || vc.character_id}: in frame`);
      }
    }

    return `${cutHeader}${timeLabel}${durStr}\n  ${camDesc}\n  Action: ${seg.action || ''}; outcome: ${seg.result || ''}\n${charLines.length ? charLines.join('\n') : '  (Environment/Subject observation)'}`;
  });

  return `=== DETERMINISTIC STAGE 3 SKELETON (AUTHORITATIVE ANCHORS) ===
[Spoken lines in order; render each exactly once, across segments if needed]
${(spec.spoken_lines || []).map(line => `${line.speaker || line.kind}: <d>[${line.language || 'Chinese'}] ${line.text}</d>`).join('\n') || 'None'}
[Media & Subject Bindings]
${subjectLines.join('\n') || '- None'}
${audioLines.join('\n')}

[Shot Timeline & Strict Performance Constraints]
${shotTimelineLines.join('\n\n')}
==============================================================`;
}

function computeH3PromptFingerprint(spec) {
  return sha256({
    version: spec.version,
    mode: spec.mode,
    execution_backend: spec.execution_backend,
    duration_seconds: spec.duration_seconds,
    aspect_ratio: spec.aspect_ratio,
    visual_style: spec.visual_style,
    firstFramePresent: spec.firstFramePresent,
    lastFramePresent: spec.lastFramePresent,
    picture_bindings: spec.picture_bindings,
    audio_bindings: spec.audio_bindings,
    spoken_lines: spec.spoken_lines,
    authoritative_contract: spec.authoritative_contract,
  });
}

function unwrapPromptText(raw) {
  let text = typeof raw === 'string' ? raw : (raw && typeof raw.prompt === 'string' ? raw.prompt : '');
  text = text.replace(/\r\n/g, '\n').trim();
  const fence = /^```(?:text|markdown|md|prompt)?\s*\n([\s\S]*?)\n```\s*$/i.exec(text);
  if (fence) text = fence[1].trim();
  return text;
}

function parseSectionHeaders(promptText, expectedHeaders) {
  const lines = promptText.split('\n');
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^([a-z_]+):(?:\s*(.*))?$/i.exec(lines[i].trim());
    if (match && expectedHeaders.includes(match[1])) {
      found.push({ name: match[1], lineIndex: i, inlineContent: (match[2] || '').trim() });
    }
  }
  return found;
}

function extractSectionMap(promptText, headers) {
  const lines = promptText.split('\n');
  const markers = parseSectionHeaders(promptText, headers);
  const sections = {};
  for (let i = 0; i < markers.length; i++) {
    const curr = markers[i];
    const nextLine = i + 1 < markers.length ? markers[i + 1].lineIndex : lines.length;
    const bodyLines = [];
    if (curr.inlineContent) bodyLines.push(curr.inlineContent);
    for (let l = curr.lineIndex + 1; l < nextLine; l++) bodyLines.push(lines[l]);
    sections[curr.name] = bodyLines.join('\n').trim();
  }
  return { markers, sections };
}

function normalizeDialoguePunctuation(text) {
  return String(text || '')
    .replace(/[\u2018\u2019\u201A\u201B\u02BB\u02BC\u2032']/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u00AB\u00BB\u2033"]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[，,]/g, ',')
    .replace(/[。.]/g, '.')
    .replace(/！/g, '!')
    .replace(/？/g, '?')
    .replace(/[：:]/g, ':')
    .replace(/[；;]/g, ';')
    .replace(/\s+/g, ' ')
    .trim();
}

function validateOfficialH3Prompt(rawPrompt, spec) {
  const prompt = unwrapPromptText(rawPrompt);
  const errors = [];
  if (!prompt || prompt.length < 40) {
    return { valid: false, errors: ['三阶输出的 H3 提示词为空或过短'], prompt };
  }
  if (prompt.length > 24000) {
    errors.push('三阶输出的 H3 提示词超过 24000 字符上限');
  }

  const expectedHeaders = spec.mode === 'fl2va' ? BASE_HEADERS : REF2VA_HEADERS;
  const { markers, sections } = extractSectionMap(prompt, expectedHeaders);
  const actualNames = markers.map((m) => m.name);
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedHeaders)) {
    errors.push(`官方分段结构不匹配（${spec.mode} 必须严格包含且按序排列: ${expectedHeaders.join(' -> ')}，实际为: ${actualNames.join(' -> ') || '无'}）`);
  }
  for (const header of expectedHeaders) {
    if (Object.hasOwn(sections, header) && !String(sections[header] || '').trim()) {
      errors.push(`分段 ${header}: 不能为空`);
    }
  }

  const mainSectionName = spec.mode === 'fl2va' ? 'integrated_multimodal_description' : 'detailed_description';
  const mainBody = sections[mainSectionName] || '';
  if (mainBody && !/\[Shot 1\]/.test(mainBody)) {
    errors.push(`${mainSectionName} 必须使用 [Shot 1] 标记镜头起始`);
  }

  const timeline = spec.authoritative_contract?.video_slots?.shots_timeline || [];
  if (timeline.length && mainBody) {
    const expectedCuts = 1 + timeline.slice(1).filter(seg => seg.camera?.shot_change === true).length;
    const markers = Array.from(mainBody.matchAll(/\[Shot (\d+)\]/g), match => Number(match[1]));
    if (markers.length !== expectedCuts || markers.some((number, idx) => number !== idx + 1)) {
      errors.push(`主描述需要按顺序标记 ${expectedCuts} 个机位。连续动作段共用机位，仅在 camera.shot_change 为 true 时切镜。`);
    }
  }

  // Official SKILL: rewrite sections must be in English; preserve original language only inside <d>...</d> and double-quoted visible text.
  const openDCount = (prompt.match(/<d>/g) || []).length;
  const closeDCount = (prompt.match(/<\/d>/g) || []).length;
  if (openDCount !== closeDCount) {
    errors.push('<d>...</d> 对白标签未闭合');
  }
  const proseWithoutOriginalLang = prompt
    .replace(/<d>[\s\S]*?<\/d>/g, '')
    .replace(/"[^"\n]{1,300}"/g, '');
  if (/\p{Script=Han}/u.test(proseWithoutOriginalLang)) {
    errors.push('按官方 H3 SKILL 要求，除 <d>...</d> 台词与双引号内画面可见文字外，正文必须全部为英文（检测到残留汉字）');
  }

  // Spoken lines must appear verbatim inside <d>...</d> in the visual timeline and not leak into audio sections.
  const dContents = [...mainBody.matchAll(/<d>(?:\[[A-Za-z]+\]\s*)?([\s\S]*?)<\/d>/g)].map((m) => m[1].trim());
  const expectedLines = (spec.spoken_lines || []).map(line => String(line.text || '').trim()).filter(Boolean);
  const actualText = normalizeDialoguePunctuation(dContents.join(''));
  const expectedText = normalizeDialoguePunctuation(expectedLines.join(''));
  if (actualText !== expectedText || openDCount !== dContents.length) {
    errors.push(`${mainSectionName} 的逐字台词与原文不一致，请检查顺序、遗漏、增词或重复。所有 <d> 标签须位于该段。`);
  }

  // Reference tag bounds check: no dangling <Picture N> or <Audio N>.
  const picIndices = [...prompt.matchAll(/<Picture\s+(\d+)>/gi)].map((m) => Number(m[1]));
  const maxPics = (spec.picture_bindings || []).length;
  const invalidPics = picIndices.filter((n) => n < 1 || n > maxPics);
  if (invalidPics.length) {
    errors.push(`存在越界图片引用 <Picture ${invalidPics.join(', ')}>，当前有效范围 1..${maxPics}`);
  }
  const audioIndices = [...prompt.matchAll(/<Audio\s+(\d+)>/gi)].map((m) => Number(m[1]));
  const maxAudios = (spec.audio_bindings || []).length;
  const invalidAudios = audioIndices.filter((n) => n < 1 || n > maxAudios);
  if (invalidAudios.length) {
    errors.push(`存在越界音频引用 <Audio ${invalidAudios.join(', ')}>，当前有效范围 1..${maxAudios}`);
  }

  if (spec.mode === 'ref2va' && maxPics > 0) {
    const subjDefs = sections.subject_definitions || '';
    for (let k = 1; k <= maxPics; k++) {
      if (!new RegExp(`<Picture\\s+${k}>`, 'i').test(subjDefs)) {
        errors.push(`Ref2VA subject_definitions 缺少参考图定义 <Picture ${k}>`);
      }
    }
    for (let k = 1; k <= maxAudios; k++) {
      if (!new RegExp(`<Audio\\s+${k}>`, 'i').test(subjDefs)) {
        errors.push(`Ref2VA subject_definitions 缺少参考音频定义 <Audio ${k}>`);
      }
    }
    if (mainBody && !/<(?:Subject|Picture)\s+1>/i.test(mainBody)) {
      errors.push('Ref2VA detailed_description 未引用任何已定义的 <Subject N> 或 <Picture N>（参考素材悬空）');
    }

    const subjects = groupSubjects(spec.picture_bindings);
    // Parse the official subject declaration tags only. Audio references can mention subjects separately.
    const definitions = [...subjDefs.matchAll(/^\s*(?:[-*]\s*)?(<Subject \d+>)([^\n]*)/gim)];
    const tags = new Set(subjects.map(s => s.tag));
    if ([...prompt.matchAll(/<Subject \d+>/g)].some(m => !tags.has(m[0]))) errors.push('存在未绑定参考图的 Subject 编号');
    for (const subject of subjects) {
      const declarations = definitions.filter(match => match[1] === subject.tag);
      const actual = new Set(declarations.flatMap(match => match[2].match(/<Picture \d+>/g) || []));
      if (declarations.length !== 1 || actual.size !== subject.pictures.length || subject.pictures.some(p => !actual.has(p.tag))) {
        errors.push(`${subject.tag} 需要单独一行定义并绑定 ${subject.pictures.map(p => p.tag).join('、')}`);
      }
    }
    for (const subject of subjects) {
      if (subject.characterId && !mainBody.includes(subject.tag)) errors.push(`主描述缺少角色 ${subject.tag}`);
    }
    const shots = mainBody.split(/\[Shot \d+\]/g).slice(1);
    let cameraIndex = -1;
    for (const [index, segment] of timeline.entries()) {
      if (!index || segment.camera?.shot_change === true) cameraIndex++;
      for (const actor of segment.visible_characters || []) {
        const id = Number(actor?.character_id ?? actor?.id ?? actor);
        const subject = subjects.find(s => s.characterId === id);
        if (subject && !shots[cameraIndex]?.includes(subject.tag)) errors.push(`[Shot ${cameraIndex + 1}] 需要引用入画角色 ${id} 的 ${subject.tag}`);
      }
    }
  } else if (spec.mode === 'fl2va' && spec.firstFramePresent && !/<Picture\s+1>/i.test(prompt)) {
    errors.push('FL2VA 首帧模式必须明确说明 <Picture 1> 与 0.00s 帧锚点的衔接');
  }

  return { valid: errors.length === 0, errors, prompt };
}

async function compileShotH3Prompt(db, log, shot, context = {}) {
  const spec = buildStage3PromptSpec(db, shot, context);
  const fingerprint = computeH3PromptFingerprint(spec);
  const { skill, guide, guideFile } = loadOfficialH3Skill(spec.mode);
  const maxAttempts = Math.max(1, Math.min(4, Number(context.maxAttempts || 3)));
  const skeleton = buildDeterministicStage3Skeleton(spec);

  const systemInstructions = `You are Stage 3 of the LocalMiniDrama director pipeline: the official MiniMax H3 Prompt Compiler.
Your ONLY job is to translate a single Stage-2 validated storyboard contract into a production-ready MiniMax H3 prompt strictly following the official MiniMax-H3 h3-prompt-writing SKILL and guide (${guideFile}).

Official SKILL.md:
${skill}

Official ${guideFile}:
${guide}

Strict Compiler Constraints:
1. Follow the exact section headers and order from ${guideFile}:
${spec.mode === 'fl2va'
    ? '   - Optional frame alignment sentence referencing <Picture 1> (and <Picture 2> if supplied), followed by integrated_multimodal_description:, overall_soundscape:, non_diegetic_music:'
    : '   - subject_definitions:, summary:, retention_analysis:, detailed_description:, overall_soundscape:, non_diegetic_music:'}
2. Write every section in natural, concrete, filmable English prose describing composition, subjects, environment, lighting, camera movement, and audio timing. Never copy raw Chinese JSON keys, field labels, state enums (e.g. away_from_camera, closed, neutral, center_background), or engineering/TTS instructions into the prompt.
3. Preserve original language ONLY inside <d>[Chinese] ...</d> (or <d>[English] ...</d>) for spoken lines and double quotes "..." for visibly rendered scene lettering. speech_range indexes the concatenated spoken_lines in Unicode characters [start,end). Every line in spoken_lines MUST appear verbatim inside <d>...</d> in the main visual description, and NEVER be repeated inside overall_soundscape or non_diegetic_music.
4. Bind ONLY the exact tags given in picture_bindings (<Picture 1..N>) and audio_bindings (<Audio 1..K>). Follow ref-en.txt §2.1 & §2.2: in Ref2VA mode, define scene/environment, character, and prop image references as <Subject N> in subject_definitions citing their <Picture N>, track them consistently through summary, retention_analysis, and detailed_description (never leave the scene <Picture 1> unused inside detailed_description).
Use exactly one definition line starting with each assigned <Subject N> and cite all and only its assigned pictures there. A costume or multiview sheet of the same actor is the same subject. Cite each visible actor by their subject tag in each camera shot.
End on the expected_visible_end_state when provided.
5. Use a new shot marker only for an explicit camera cut. Preserve exact continuity, camera framing/movement and scheduled cuts ([Shot 1], [Shot 2] At MM:SS.mmm, ...), duration (${spec.duration_seconds}s), and aspect ratio (${spec.aspect_ratio}) from authoritative_contract without inventing unapproved characters, extra shots, or contradicting camera movements.
6. Output ONLY the final formatted H3 prompt text itself—no markdown code fences, no preamble, no explanations.`;

  let feedback = '';
  let lastErrors = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const userInput = feedback
      ? `The previous prompt draft failed official MiniMax H3 SKILL validation. Fix ALL errors below and output ONLY the corrected prompt text strictly adhering to the deterministic skeleton.\nValidation errors:\n- ${feedback}\n\n${skeleton}\n\nAuthoritative Stage-2 Contract & Media Bindings:\n${JSON.stringify(spec, null, 2)}`
      : `Compile this Stage-2 validated storyboard contract and media bindings into the official MiniMax H3 prompt adhering strictly to the deterministic skeleton:\n\n${skeleton}\n\nFull Stage-2 Contract:\n${JSON.stringify(spec, null, 2)}`;

    const raw = await agentsRuntime.runAgent(db, log, {
      name: 'h3-official-prompt-writer',
      instructions: systemInstructions,
      input: userInput,
      outputType: 'text',
      thinking: 'disabled',
      reasoningEffort: 'none',
      maxTokens: 8192,
      temperature: 0.2,
    });

    const checked = validateOfficialH3Prompt(raw, spec);
    if (checked.valid) {
      return {
        prompt: checked.prompt,
        fingerprint,
        mode: spec.mode,
        attempts: attempt,
      };
    }
    lastErrors = checked.errors;
    feedback = checked.errors.join('\n- ');
    log?.warn?.('[Stage3] Official H3 prompt validation failed, retrying', {
      storyboard_id: spec.storyboard_id,
      shot_number: spec.shot_number,
      attempt,
      errors: checked.errors,
    });
  }

  throw new Error(`分镜 #${spec.shot_number} 三阶官方 H3 提示词编译未通过校验：${lastErrors.join('；')}`);
}

function persistCompiledPrompt(db, shotId, prompt, fingerprint, manual = false) {
  if (!db || !shotId) return;
  {
    const cols = new Set(db.prepare('PRAGMA table_info(storyboards)').all().map((c) => c.name));
    const sets = [];
    const params = [];
    if (cols.has('h3_prompt_snapshot')) { sets.push('h3_prompt_snapshot = ?'); params.push(prompt); }
    if (cols.has('h3_prompt_fingerprint')) { sets.push('h3_prompt_fingerprint = ?'); params.push(fingerprint); }
    if (cols.has('h3_prompt_manual')) { sets.push('h3_prompt_manual = ?'); params.push(manual ? 1 : 0); }
    if (cols.has('h3_contract_status')) { sets.push('h3_contract_status = ?'); params.push('prepared'); }
    if (!sets.length) return;
    sets.push('updated_at = ?');
    params.push(new Date().toISOString(), Number(shotId));
    db.prepare(`UPDATE storyboards SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }
}

// Store component digests so a manual draft can identify which input needs review.
function manualPromptVersion(db, shot, spec = buildStage3PromptSpec(db, shot)) {
  const dramaId = db && shot.episode_id ? db.prepare('SELECT drama_id FROM episodes WHERE id=?').get(shot.episode_id)?.drama_id : null;
  const references = dramaId && spec.mode === 'ref2va' ? resolveH3SubmissionPlan(db, dramaId, shot).references : [];
  const media = references.map(ref => {
    try { return resolveRequiredReference(db, dramaId, shot, ref); }
    catch { return null; } // A later asset assignment must invalidate this draft.
  });
  const fields = {
    '画面规格': [spec.mode, spec.duration_seconds, spec.aspect_ratio, spec.firstFramePresent, spec.lastFramePresent],
    '执行槽位': spec.authoritative_contract,
    '台词': spec.spoken_lines.map(l => [l.kind, l.text]),
    '画风': spec.visual_style,
    '参考素材': [spec.picture_bindings.map(p => [p.tag, p.type, p.character_id, p.id, p.name, p.appearance]),
      references, media, ...(spec.mode === 'fl2va' ? [shot.first_frame_image_id, shot.last_frame_image_id,
        shot.local_path, shot.image_url, shot.last_frame_local_path, shot.last_frame_image_url] : [])],
  };
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, sha256(value)]));
}

async function ensureShotH3PromptCompiled(db, log, shot, context = {}) {
  const spec = buildStage3PromptSpec(db, shot, context);
  const fingerprint = computeH3PromptFingerprint(spec);
  const existingPrompt = unwrapPromptText(shot?.h3_prompt_snapshot || '');
  const manualLocked = Boolean(shot?.h3_prompt_manual);

  if (!context.forceRecompile && manualLocked && existingPrompt) {
    const baseline = parseJson(shot.h3_prompt_fingerprint, {});
    const current = manualPromptVersion(db, shot, spec);
    const changed = Object.keys(current).filter(key => current[key] !== baseline?.[key]);
    if (changed.length) throw new Error(`手工 H3 提示词需要复核（${changed.join('、')}）。请打开「编辑视频提示词」，勾选「已按当前分镜复核手工提示词」后保存，或点击重新编译。`);
    const checked = validateOfficialH3Prompt(existingPrompt, spec);
    if (!checked.valid) throw new Error(`手工 H3 提示词与当前合同不符：${checked.errors.join('；')}。请编辑后保存或重新编译。`);
    return {
      prompt: existingPrompt,
      fingerprint: sha256([fingerprint, existingPrompt]),
      mode: spec.mode,
      source: 'manual_locked',
      manual: true,
    };
  }

  if (!context.forceRecompile && existingPrompt && shot?.h3_prompt_fingerprint === fingerprint) {
    const checked = validateOfficialH3Prompt(existingPrompt, spec);
    if (checked.valid) {
      return {
        prompt: checked.prompt,
        fingerprint,
        mode: spec.mode,
        source: 'cache_hit',
        manual: false,
      };
    }
  }

  const compiled = await compileShotH3Prompt(db, log, shot, context);
  if (db && shot?.id) db.transaction(() => {
    const current = db.prepare('SELECT * FROM storyboards WHERE id=?').get(shot.id);
    if (!current || current.deleted_at || current.updated_at !== shot.updated_at ||
        current.h3_prompt_snapshot !== shot.h3_prompt_snapshot ||
        computeH3PromptFingerprint(buildStage3PromptSpec(db, current, context)) !== fingerprint) {
      throw new Error('编译期间分镜已更新，请在当前镜头重新编译 H3 提示词。');
    }
    persistCompiledPrompt(db, shot.id, compiled.prompt, compiled.fingerprint, false);
  })();
  return {
    ...compiled,
    source: 'stage3_compiled',
    manual: false,
  };
}

module.exports = {
  manualPromptVersion,
  loadOfficialH3Skill,
  buildStage3PromptSpec,
  buildDeterministicStage3Skeleton,
  computeH3PromptFingerprint,
  validateOfficialH3Prompt,
  compileShotH3Prompt,
  ensureShotH3PromptCompiled,
  persistCompiledPrompt,
};
