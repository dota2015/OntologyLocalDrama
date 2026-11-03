/**
 * 影视视听本体门禁：跨槽位一致性与执行契约硬门禁 (Cross-Slot Invariants Hard Gate)
 * 严格执行 12 项跨槽位硬校验，禁止后端静默截断、改写或补造。
 * 存在任何歧义与冲突均输出结构化违规项 (Violations)，退回 ReAct Agent 修正。
 */

const BaseInvariantRule = require('./baseRule');
const { dialogueSegments } = require('../../services/dialogueDubbingService');

function parseJsonValue(value) {
  if (typeof value !== 'string' || !value.trim()) return value;
  try { return JSON.parse(value); } catch (_) { return value; }
}

function asArray(value) {
  const parsed = parseJsonValue(value);
  return Array.isArray(parsed) ? parsed : [];
}

function asObject(value) {
  const parsed = parseJsonValue(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

function parseId(val) {
  if (val == null) return null;
  if (typeof val === 'object') {
    return val.character_id != null ? Number(val.character_id) : (val.id != null ? Number(val.id) : null);
  }
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function parseIds(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(parseId).filter(id => id != null);
}

function uniqueSortedIds(arr) {
  return [...new Set(parseIds(arr))].sort((a, b) => a - b);
}

function sameIds(a, b) {
  const left = uniqueSortedIds(a);
  const right = uniqueSortedIds(b);
  return left.length === right.length && left.every((id, idx) => id === right[idx]);
}

function meaningfulSpeech(value) {
  const text = String(value || '').trim();
  return !!text && !/^(?:无|无对白|无对话|无台词|无旁白|none|null|n\/a|silent)[。.!！\s]*$/iu.test(text);
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

// Database dialogue commonly stores a display label ("露娜：台词"), while
// semantic/video slots store only the spoken text. The label is formatting,
// not spoken content, so normalize it only when it matches a known speaker.
function comparableSpeech(value, speakerHints = []) {
  let text = String(value || '').trim();
  for (const hint of speakerHints) {
    const speaker = String(hint || '').trim();
    if (!speaker) continue;
    const prefix = new RegExp(`^${escapeRegExp(speaker)}\\s*[：:]\\s*`, 'u');
    if (prefix.test(text)) {
      text = text.replace(prefix, '');
      break;
    }
  }
  return text
    .replace(/^[“”"「」『』']+|[“”"「」『』']+$/gu, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase();
}

function mouthIsSealed(value) {
  return /(?:双唇紧闭|双唇自然闭合|闭唇|闭口|安静闭合|closed(?:_non_speaking| lips)?|strictly_sealed)/iu.test(String(value || ''));
}

function videoTrajectories(videoSlots) {
  const top = Array.isArray(videoSlots?.trajectories) ? videoSlots.trajectories : [];
  const timed = Array.isArray(videoSlots?.shots_timeline)
    ? videoSlots.shots_timeline.flatMap((segment) => Array.isArray(segment?.character_trajectories) ? segment.character_trajectories : [])
    : [];
  return [...top, ...timed];
}

class CrossSlotInvariantsRule extends BaseInvariantRule {
  constructor() {
    super({
      id: 'RULE_CROSS_SLOT_INVARIANTS',
      name: '跨槽位视听语义硬门禁',
      category: 'cross_slot',
      defaultSeverity: 'error',
      description: '审查画外音口型、旁白角色、静音冲突、双重角色、构图人数、正脸剪影、服装冲突、尾帧复用、造型切换、参考图容量、Picture标签与FL2VA纯净度',
    });
  }

  evaluate(context) {
    const shots = context.shots;
    const violations = [];
    if (!Array.isArray(shots) || shots.length === 0) return violations;

    shots.forEach((shot, idx) => {
      const shotNum = shot.shot_number || (idx + 1);
      const prevShot = idx > 0 ? shots[idx - 1] : null;

      // 提取语义槽位
      const persistedSemantic = asObject(shot.semantic_slots);
      const slots = persistedSemantic || shot;
      const visibleChars = slots.visible_characters != null ? asArray(slots.visible_characters) : asArray(shot.characters);
      const bgChars = slots.background_characters != null ? asArray(slots.background_characters) : asArray(shot.background_characters);
      const characterVisuals = asArray(shot.character_visuals);
      const speechPlan = slots.speech_plan || {};
      const soundPlan = slots.sound_plan || {};
      const requiredRefs = Array.isArray(slots.required_references) ? slots.required_references : [];
      const lipSyncMode = slots.audio_lip_sync || shot.audio_lip_sync || '';
      const videoSlots = asObject(shot.video_slots) || {};
      const videoSpeech = asObject(videoSlots.audio_lip_sync) || {};

      // Agent 同时输出执行槽位和持久化字段时，两套表示必须严格同义。
      // 后端只做门禁，不从任意一侧猜测、覆盖或静默修正另一侧。
      if (persistedSemantic) {
        const topVisible = shot.characters != null
          ? asArray(shot.characters)
          : asArray(shot.character_ids);
        const topBackground = asArray(shot.background_characters);
        if (!sameIds(topVisible, slots.visible_characters)) {
          violations.push({
            rule: 'INVARIANT_CHARACTER_SLOT_DIVERGENCE',
            shot_number: shotNum,
            severity: this.defaultSeverity,
            message: `分镜 #${shotNum} 顶层 characters 与 semantic_slots.visible_characters 不一致，禁止用两套人物清单分别驱动落库和 H3。`,
            conflict_slots: ['characters', 'semantic_slots.visible_characters'],
          });
        }
        if (!sameIds(topBackground, slots.background_characters)) {
          violations.push({
            rule: 'INVARIANT_CHARACTER_SLOT_DIVERGENCE',
            shot_number: shotNum,
            severity: this.defaultSeverity,
            message: `分镜 #${shotNum} 顶层 background_characters 与 semantic_slots.background_characters 不一致。`,
            conflict_slots: ['background_characters', 'semantic_slots.background_characters'],
          });
        }
        if (shot.character_visuals != null && shot.character_visuals !== '') {
          const expectedVisualIds = [...topVisible, ...topBackground];
          if (!sameIds(characterVisuals, expectedVisualIds)) {
            violations.push({
              rule: 'INVARIANT_CHARACTER_VISUAL_SLOT_DIVERGENCE',
              shot_number: shotNum,
              severity: this.defaultSeverity,
              message: `分镜 #${shotNum} character_visuals 人物集合必须与主角及背景人物并集完全一致。`,
              conflict_slots: ['character_visuals', 'characters', 'background_characters'],
            });
          }
        }

        // 台词是跨层权威数据：数据库对白/旁白、semantic speech_plan 与
        // video audio_lip_sync 必须逐字一致。后端只报告冲突，绝不选择
        // 其中一层覆盖另外两层。一个外层分镜只允许一个发言段；多人
        // 轮流说话必须由 Director Agent 拆镜。
        const semanticText = meaningfulSpeech(speechPlan.text) ? String(speechPlan.text).trim() : '';
        const videoText = meaningfulSpeech(videoSpeech.dialogue_content)
          ? String(videoSpeech.dialogue_content).trim()
          : '';
        const isSemanticNarration = speechPlan.is_narration === true;
        const dialogueParts = dialogueSegments(shot.dialogue || '').map((line) => ({
          kind: /^(?:旁白|解说|解说旁白|画外音|narrator|narration|voice[- ]?over)$/iu.test(line.speaker || '')
            ? 'narration'
            : 'dialogue',
          speaker: String(line.speaker || '').trim(),
          text: String(line.text || '').trim(),
        })).filter((line) => meaningfulSpeech(line.text));
        if (meaningfulSpeech(shot.narration)) {
          dialogueParts.push({ kind: 'narration', speaker: '', text: String(shot.narration).trim() });
        }
        if (dialogueParts.length > 1) {
          violations.push({
            rule: 'INVARIANT_MULTI_SPEAKER_SHOT',
            shot_number: shotNum,
            severity: this.defaultSeverity,
            message: `分镜 #${shotNum} 包含 ${dialogueParts.length} 个发言段；单镜 speech_plan 只能绑定一个说话人，必须由导演 Agent 按原顺序拆镜并逐字保留全部台词。`,
            conflict_slots: ['dialogue', 'narration', 'semantic_slots.speech_plan', 'video_slots.audio_lip_sync'],
          });
        }
        const authoritativeParts = dialogueParts.filter((line) => line.kind === (isSemanticNarration ? 'narration' : 'dialogue'));
        const dbPart = authoritativeParts.length === 1 ? authoritativeParts[0] : null;
        const speechHints = [speechPlan.speaker_name, videoSpeech.speaker_name, dbPart?.speaker];
        const textsAgree = semanticText
          && videoText
          && dbPart
          && comparableSpeech(semanticText, speechHints) === comparableSpeech(videoText, speechHints)
          && comparableSpeech(semanticText, speechHints) === comparableSpeech(dbPart.text, speechHints);
        if ((semanticText || videoText || dialogueParts.length) && !textsAgree) {
          violations.push({
            rule: 'INVARIANT_SPEECH_SLOT_DIVERGENCE',
            shot_number: shotNum,
            severity: this.defaultSeverity,
            message: `分镜 #${shotNum} 的数据库对白/旁白、semantic_slots.speech_plan.text 与 video_slots.audio_lip_sync.dialogue_content 必须逐字一致且各自存在。`,
            conflict_slots: ['dialogue', 'narration', 'semantic_slots.speech_plan.text', 'video_slots.audio_lip_sync.dialogue_content'],
          });
        }
        if (dbPart && !isSemanticNarration) {
          const semanticSpeaker = String(speechPlan.speaker_name || '').trim();
          const videoSpeaker = String(videoSpeech.speaker_name || '').trim();
          if (!semanticSpeaker || !videoSpeaker || (dbPart.speaker && (dbPart.speaker !== semanticSpeaker || dbPart.speaker !== videoSpeaker))) {
            violations.push({
              rule: 'INVARIANT_SPEAKER_SLOT_DIVERGENCE',
              shot_number: shotNum,
              severity: this.defaultSeverity,
              message: `分镜 #${shotNum} 的数据库人物标签、semantic speech_plan.speaker_name 与 video audio_lip_sync.speaker_name 必须一致。`,
              conflict_slots: ['dialogue', 'semantic_slots.speech_plan.speaker_name', 'video_slots.audio_lip_sync.speaker_name'],
            });
          }
        }
      }

      // 1. 画外说话人与可见口型冲突
      const isOffscreen = speechPlan.is_offscreen === true || lipSyncMode === 'offscreen_voiceover' || shot.dialogue_delivery === 'voiceover';
      if (isOffscreen) {
        if (lipSyncMode === 'in_frame_dialogue') {
          violations.push({
            rule: 'INVARIANT_OFFSCREEN_SPEECH_LIP_SYNC_CONFLICT',
            shot_number: shotNum,
            severity: this.defaultSeverity,
            message: `分镜 #${shotNum} 标记为画外音/画外说话，但口型模式配置为画内说话 (in_frame_dialogue)，画外说话严禁画内动嘴！`,
            conflict_slots: ['speech_plan.is_offscreen', 'audio_lip_sync'],
          });
        }
        // 检查画内角色是否有开口/说话动作
        const speakingLipRegex = /(?:说话|张嘴|张口|大喊|呐喊|高呼|冷笑开口|启齿|低语|诉说|念叨|口型同步|动唇|唇齿微动)/i;
        for (const vc of visibleChars) {
          const charDesc = typeof vc === 'string' ? vc : `${vc.name || ''} ${vc.expression || ''} ${vc.action || ''} ${vc.mouth_state || ''}`;
          if (speakingLipRegex.test(charDesc)) {
            violations.push({
              rule: 'INVARIANT_OFFSCREEN_SPEECH_LIP_SYNC_CONFLICT',
              shot_number: shotNum,
              severity: this.defaultSeverity,
              message: `分镜 #${shotNum} 标记为画外音/画外说话，但画内角色描写出现开口动嘴（「${charDesc.trim()}」），必须声明画内全员双唇闭合！`,
              conflict_slots: ['speech_plan.is_offscreen', 'visible_characters.mouth_state'],
            });
            break;
          }
        }
      }

      // 2. 旁白被标成画内说话人
      const isNarration = speechPlan.is_narration === true || lipSyncMode === 'narration' || (shot.narration && !shot.dialogue);
      if (isNarration) {
        if (lipSyncMode === 'in_frame_dialogue' || speechPlan.speaker_in_frame === true || speechPlan.speaker_id != null) {
          violations.push({
            rule: 'INVARIANT_NARRATION_SPEAKER_CONFLICT',
            shot_number: shotNum,
            severity: this.defaultSeverity,
            message: `分镜 #${shotNum} 台词为旁白解说 (narration)，但被配置为画内说话人或赋予了特定角色 ID (${speechPlan.speaker_id})，旁白属于客观无源声音，严禁绑定画内角色张嘴！`,
            conflict_slots: ['speech_plan.is_narration', 'audio_lip_sync'],
          });
        }
      }

      // 3. 无语言、纯配乐与完全静音是三个不同合同。silent_ambient
      // 允许环境声/动作音，bgm_only 只允许纯器乐，is_silent 才表示绝对静音。
      const isCompleteSilence = soundPlan.is_silent === true || shot.is_silent === true;
      const isAmbientOnly = lipSyncMode === 'silent_ambient';
      const isBgmOnly = lipSyncMode === 'bgm_only';
      const isNoSpeech = isCompleteSilence || isAmbientOnly || isBgmOnly;
      const hasDialogue = meaningfulSpeech(shot.dialogue);
      const hasNarration = meaningfulSpeech(shot.narration);
      const hasSpeechText = meaningfulSpeech(speechPlan.text) || meaningfulSpeech(videoSpeech.dialogue_content);
      const bgmText = soundPlan.bgm_prompt || shot.bgm_prompt;
      const hasBgm = !!(bgmText && String(bgmText).trim() && !/^(?:无|无BGM|禁BGM|none|n\/a)[。.!！\s]*$/iu.test(String(bgmText).trim()));
      const hasSfx = (Array.isArray(soundPlan.sound_effects) && soundPlan.sound_effects.some(Boolean))
        || meaningfulSpeech(shot.sound_effect);
      if (isNoSpeech && (hasDialogue || hasNarration || hasSpeechText)) {
        violations.push({
          rule: 'INVARIANT_NONVERBAL_SHOT_SPEECH_CONFLICT',
          shot_number: shotNum,
          severity: this.defaultSeverity,
          message: `分镜 #${shotNum} 规划为无语言声音模式，但仍包含对白、旁白或口型台词；请由导演 Agent 明确选择语言模式并保持三层台词槽位一致。`,
          conflict_slots: ['semantic_slots.audio_lip_sync', 'dialogue', 'narration', 'semantic_slots.speech_plan.text', 'video_slots.audio_lip_sync.dialogue_content'],
        });
      }
      if (isNoSpeech) {
        const unsealed = videoTrajectories(videoSlots).find((trajectory) => !mouthIsSealed(trajectory?.mouth_state));
        if (unsealed) {
          violations.push({
            rule: 'INVARIANT_NONVERBAL_MOUTH_NOT_SEALED',
            shot_number: shotNum,
            severity: this.defaultSeverity,
            message: `分镜 #${shotNum} 规划为无语言声音模式，但角色「${unsealed.name || unsealed.character_id || '未命名'}」未明确保持闭口非说话状态。`,
            conflict_slots: ['semantic_slots.audio_lip_sync', 'video_slots.trajectories.mouth_state', 'video_slots.shots_timeline.character_trajectories.mouth_state'],
          });
        }
      }
      if (isCompleteSilence) {
        if (hasBgm || hasSfx) {
          violations.push({
            rule: 'INVARIANT_SILENT_SHOT_AUDIO_CONFLICT',
            shot_number: shotNum,
            severity: this.defaultSeverity,
            message: `分镜 #${shotNum} 声明为完全静音，但仍包含配乐、环境音或动作音效。`,
            conflict_slots: ['sound_plan.is_silent', 'sound_plan.sound_effects', 'bgm_prompt'],
          });
        }
      }
      if (isAmbientOnly && hasBgm) {
        violations.push({
          rule: 'INVARIANT_AMBIENT_ONLY_BGM_CONFLICT',
          shot_number: shotNum,
          severity: this.defaultSeverity,
          message: `分镜 #${shotNum} 选择纯环境音效模式，但同时规划了 BGM；需要配乐时请改用 bgm_only 或明确的无语言混音方案。`,
          conflict_slots: ['semantic_slots.audio_lip_sync', 'sound_plan.bgm_prompt', 'bgm_prompt'],
        });
      }
      if (isBgmOnly && hasSfx) {
        violations.push({
          rule: 'INVARIANT_BGM_ONLY_SFX_CONFLICT',
          shot_number: shotNum,
          severity: this.defaultSeverity,
          message: `分镜 #${shotNum} 选择纯配乐模式，但同时规划了环境音或动作音效。`,
          conflict_slots: ['semantic_slots.audio_lip_sync', 'sound_plan.sound_effects', 'sound_effect'],
        });
      }

      // 4. 同一角色同时属于主角和背景人物
      const visibleIds = parseIds(visibleChars);
      const bgIds = parseIds(bgChars);
      const dualRoles = visibleIds.filter(id => bgIds.includes(id));
      if (dualRoles.length > 0) {
        violations.push({
          rule: 'INVARIANT_CHARACTER_DUAL_ROLE_CONFLICT',
          shot_number: shotNum,
          severity: this.defaultSeverity,
          message: `分镜 #${shotNum} 角色 ID [${dualRoles.join(', ')}] 同时出现在可见主角与背景人物中，角色定位不可兼并！`,
          conflict_slots: ['visible_characters', 'background_characters'],
        });
      }

      // 5. 单人/双人构图与实际人数不一致
      const framing = slots.dialogue_framing || shot.dialogue_framing || '';
      const shotType = shot.shot_type || '';
      const visibleCount = visibleIds.length > 0 ? visibleIds.length : visibleChars.length;
      if (framing === 'solo_action' && visibleCount > 1) {
        violations.push({
          rule: 'INVARIANT_FRAMING_CHARACTER_COUNT_MISMATCH',
          shot_number: shotNum,
          severity: this.defaultSeverity,
          message: `分镜 #${shotNum} 构图选择为单人专注动作 (solo_action)，但可见角色数为 ${visibleCount} 人，构图与人数冲突！`,
          conflict_slots: ['dialogue_framing', 'visible_characters'],
        });
      }
      const twoShotFramings = ['two_shot_face_to_face', 'over_the_shoulder', 'joint_observation'];
      if (twoShotFramings.includes(framing) && visibleCount !== 2 && visibleCount > 0) {
        violations.push({
          rule: 'INVARIANT_FRAMING_CHARACTER_COUNT_MISMATCH',
          shot_number: shotNum,
          severity: this.defaultSeverity,
          message: `分镜 #${shotNum} 构图选择为双人对话构图 (${framing})，但可见角色数为 ${visibleCount} 人（应严格为 2 人）！`,
          conflict_slots: ['dialogue_framing', 'visible_characters'],
        });
      }

      // Close/over-the-shoulder dialogue is a two-person identity contract.
      // A third character declared as background is still promoted to a H3
      // Subject by the Ref2VA compiler, where it can cause face fusion or a
      // duplicate person in a tight composition. Keep background presence for
      // wide establishing/joint-observation shots only; the Director must
      // choose a wide three-person composition or remove the background role.
      const framingText = String(framing || '');
      const isOverShoulderDialogue = /(?:over_the_shoulder|ots_reverse|two_shot_face_to_face|过肩|正反打|反打|双人对话)/iu.test(framingText);
      const isWideComposition = /(?:全景|远景|大远景|wide|long\s*shot|establishing)/iu.test(`${shotType} ${framingText}`);
      if (isOverShoulderDialogue && bgIds.length > 0 && !isWideComposition && visibleCount > 0 && visibleCount <= 2) {
        violations.push({
          rule: 'INVARIANT_CLOSE_DIALOGUE_BACKGROUND_CONFLICT',
          shot_number: shotNum,
          severity: this.defaultSeverity,
          message: `分镜 #${shotNum} 是近景/过肩双人对话构图，却声明了 ${bgIds.length} 个背景人物。紧凑构图中背景人物也会成为 H3 Subject，容易造成脸部融合或克隆人；请由导演选择宽景三人构图，或将背景人物和对应参考图移出本镜。`,
          conflict_slots: ['dialogue_framing', 'background_characters', 'semantic_slots.background_characters', 'semantic_slots.required_references', 'universal_segment_text'],
        });
      }

      // 6. 清晰正脸与背影、剪影冲突
      const identityVis = slots.identity_visibility || shot.identity_visibility || '';
      if (identityVis === 'clear_frontal') {
        const backRegex = /(?:背影|背向|背对镜头|剪影|黑影|后脑勺|背身)/i;
        const allChars = [...visibleChars, ...characterVisuals];
        for (const vc of allChars) {
          const facing = typeof vc === 'object' ? (vc.facing || '') : '';
          const headPose = typeof vc === 'object' ? (vc.head_pose || '') : '';
          const textDesc = typeof vc === 'object' ? `${vc.posture || ''} ${vc.action || ''}` : String(vc);
          if (facing === 'away_from_camera' || headPose === 'head_look_back' || backRegex.test(textDesc)) {
            violations.push({
              rule: 'INVARIANT_IDENTITY_VISIBILITY_FACING_CONFLICT',
              shot_number: shotNum,
              severity: this.defaultSeverity,
              message: `分镜 #${shotNum} 声明面部清晰正脸识别 (clear_frontal)，但角色描写为背向机位/剪影/后脑勺，导致人脸锁定失效！`,
              conflict_slots: ['identity_visibility', 'facing', 'posture'],
            });
            break;
          }
        }
      }

      // 7. 同一分镜出现同一角色多套服装
      const charWardrobeMap = new Map();
      const charVisuals = characterVisuals.length > 0 ? characterVisuals : visibleChars;
      for (const cv of charVisuals) {
        if (typeof cv === 'object' && cv.character_id != null && cv.wardrobe_id != null) {
          const cid = Number(cv.character_id);
          const wid = String(cv.wardrobe_id);
          if (charWardrobeMap.has(cid) && charWardrobeMap.get(cid) !== wid) {
            violations.push({
              rule: 'INVARIANT_SAME_SHOT_MULTIPLE_WARDROBES',
              shot_number: shotNum,
              severity: this.defaultSeverity,
              message: `分镜 #${shotNum} 同一角色 ID:${cid} 在单镜中被赋予了多套不同服装（${charWardrobeMap.get(cid)} vs ${wid}），单镜服装必须统一！`,
              conflict_slots: ['wardrobe_id'],
            });
          } else {
            charWardrobeMap.set(cid, wid);
          }
        }
      }
      const costumes = requiredRefs.filter(r => r.type === 'costume' || r.type === 'wardrobe');
      const costumeCharMap = new Map();
      for (const cost of costumes) {
        const cid = cost.id || cost.character_id;
        if (cid != null) {
          if (costumeCharMap.has(cid)) {
            violations.push({
              rule: 'INVARIANT_SAME_SHOT_MULTIPLE_WARDROBES',
              shot_number: shotNum,
              severity: this.defaultSeverity,
              message: `分镜 #${shotNum} 同一角色 ID:${cid} 在必要参考中配置了多套服装卡（${costumeCharMap.get(cid)} vs ${cost.name || cost.id}），单镜服装必须保持唯一！`,
              conflict_slots: ['required_references'],
            });
            break;
          }
          costumeCharMap.set(cid, cost.name || cost.id);
        }
      }

      // 8. 连续尾帧跨场景、时间或服装复用
      const firstFramePolicy = slots.first_frame_policy || shot.first_frame_policy || '';
      const isContinuation = firstFramePolicy === 'inherit_tail' || shot.long_take_role === 'continuation' || shot.long_take_role === 'tail';
      if (isContinuation && prevShot) {
        if (shot.scene_id != null && prevShot.scene_id != null && Number(shot.scene_id) !== Number(prevShot.scene_id)) {
          violations.push({
            rule: 'INVARIANT_CONTINUOUS_TAIL_MISMATCH',
            shot_number: shotNum,
            severity: this.defaultSeverity,
            message: `分镜 #${shotNum} 采用继承上一镜尾帧连戏，但与分镜 #${prevShot.shot_number || idx} 不在同一场景（Scene:${shot.scene_id} vs Scene:${prevShot.scene_id}），换场景严禁直接承接尾帧！`,
            conflict_slots: ['first_frame_policy', 'scene_id'],
          });
        }
        if (shot.time && prevShot.time && String(shot.time).trim() !== String(prevShot.time).trim()) {
          violations.push({
            rule: 'INVARIANT_CONTINUOUS_TAIL_MISMATCH',
            shot_number: shotNum,
            severity: this.defaultSeverity,
            message: `分镜 #${shotNum} 继承上一镜尾帧连戏，但时间跨度发生跳跃（${prevShot.time} -> ${shot.time}），时间线中断不可直接续接尾帧！`,
            conflict_slots: ['first_frame_policy', 'time'],
          });
        }
        if ((!shot.scene_id || !prevShot.scene_id)
          && shot.location && prevShot.location
          && String(shot.location).trim() !== String(prevShot.location).trim()) {
          violations.push({
            rule: 'INVARIANT_CONTINUOUS_TAIL_MISMATCH',
            shot_number: shotNum,
            severity: this.defaultSeverity,
            message: `分镜 #${shotNum} 继承上一镜尾帧，但地点发生变化（${shot.location} -> ${prevShot.location}），换场景必须改为 Ref2VA 重新起镜！`,
            conflict_slots: ['first_frame_policy', 'location'],
          });
        }
      }

      // 9. 单镜包含造型切换
      const mutationRegex = /(?:换上|换装|变身|脱去|脱下|脱掉|撕下面具|穿上|披上).{0,6}(?:衣|装|服|袍|甲|衫|裙|披风|斗篷)?/i;
      const shotAction = `${shot.action || ''} ${shot.result || ''} ${shot.video_prompt || ''}`;
      if (mutationRegex.test(shotAction)) {
        violations.push({
          rule: 'INVARIANT_MID_SHOT_WARDROBE_MUTATION',
          shot_number: shotNum,
          severity: this.defaultSeverity,
          message: `分镜 #${shotNum} 镜头动作包含单镜换装/变身/造型改变描写（「${shotAction.slice(0, 40)}...」），单镜头生成无法维持造型突变，请拆分为换装前后两个分镜！`,
          conflict_slots: ['action', 'wardrobe_id'],
        });
      }

      // 10. 声音或参考素材超过 H3 上限 (严禁静默 slice)
      if (requiredRefs.length > 9) {
        violations.push({
          rule: 'INVARIANT_REFERENCE_CAPACITY_EXCEEDED',
          shot_number: shotNum,
          severity: this.defaultSeverity,
          message: `分镜 #${shotNum} 规划了 ${requiredRefs.length} 张必要参考素材，超出 MiniMax-H3 单镜 9 张物理上限！后端禁止静默截断，请 Agent 拆镜或精简次要参考！`,
          conflict_slots: ['required_references'],
        });
      }
      const audioRefs = speechPlan.audio_references || shot.h3_audio_references || [];
      if (Array.isArray(audioRefs) && audioRefs.length > 3) {
        violations.push({
          rule: 'INVARIANT_REFERENCE_CAPACITY_EXCEEDED',
          shot_number: shotNum,
          severity: this.defaultSeverity,
          message: `分镜 #${shotNum} 关联了 ${audioRefs.length} 个音色参考，超出 H3 单镜最多 3 个声音上限，必须拆镜！`,
          conflict_slots: ['speech_plan.audio_references'],
        });
      }
      if (visibleCount > 3) {
        violations.push({
          rule: 'INVARIANT_REFERENCE_CAPACITY_EXCEEDED',
          shot_number: shotNum,
          severity: this.defaultSeverity,
          message: `分镜 #${shotNum} 画内主角超过 3 人（当前 ${visibleCount} 人），超出 H3 视频生成人脸保持上限，必须拆镜为正反打或特写！`,
          conflict_slots: ['visible_characters'],
        });
      }

      // 11. <Picture N> 没有对应输入
      const promptText = `${shot.image_prompt || ''} ${shot.video_prompt || ''} ${shot.prompt || ''}`;
      const picTagRegex = /<Picture\s*(\d+)>/gi;
      let match;
      const refCount = requiredRefs.length > 0 ? requiredRefs.length : (Array.isArray(shot.reference_urls) ? shot.reference_urls.length : 0);
      while ((match = picTagRegex.exec(promptText)) !== null) {
        const picIndex = parseInt(match[1], 10);
        // 如果参考图数组总长度小于 picIndex，说明标签悬空
        if (refCount > 0 && picIndex > refCount) {
          violations.push({
            rule: 'INVARIANT_PICTURE_TAG_DANGLING',
            shot_number: shotNum,
            severity: this.defaultSeverity,
            message: `分镜 #${shotNum} 提示词引用了 <Picture ${picIndex}>，但可用参考输入仅有 ${refCount} 项，输入悬空缺失！`,
            conflict_slots: ['required_references', 'video_prompt'],
          });
        }
      }

      // 12. FL2VA 请求混入 Ref2VA 专属参考输入
      const h3Mode = slots.h3_mode || shot.h3_mode || '';
      const longTakeRole = String(shot.long_take_role || '').toLowerCase();
      const longTakeSequence = Number(shot.long_take_sequence);
      const longTakeContinuation = ['continuation', 'tail'].includes(longTakeRole)
        || (Number.isInteger(longTakeSequence) && longTakeSequence > 1);
      if (longTakeContinuation) {
        const previousSequence = Number(prevShot?.long_take_sequence);
        const sameGroup = !!shot.long_take_group_id
          && prevShot?.long_take_group_id === shot.long_take_group_id
          && Number.isInteger(previousSequence)
          && previousSequence === longTakeSequence - 1;
        if (!sameGroup) {
          const expectedPredecessor = Number.isInteger(longTakeSequence) && longTakeSequence > 1
            ? `同组的第 ${longTakeSequence - 1} 段`
            : '带有效顺序号的同组前序镜头';
          violations.push({
            rule: 'INVARIANT_LONG_TAKE_PREDECESSOR_MISSING',
            shot_number: shotNum,
            severity: this.defaultSeverity,
            message: `分镜 #${shotNum} 是连续接力镜，但上一镜不是${expectedPredecessor}；无法确定要等待并提取哪一条真实视频尾帧。`,
            conflict_slots: ['long_take_group_id', 'long_take_role', 'long_take_sequence'],
          });
        }
        if (h3Mode !== 'fl2va' || firstFramePolicy !== 'inherit_tail' || slots.continuity_type !== 'long_take_continuation') {
          violations.push({
            rule: 'INVARIANT_LONG_TAKE_CONTINUATION_EXECUTION_CONFLICT',
            shot_number: shotNum,
            severity: this.defaultSeverity,
            message: `分镜 #${shotNum} 是连续接力镜，必须由 Agent 同时规划 h3_mode=fl2va、first_frame_policy=inherit_tail、continuity_type=long_take_continuation；执行器才能等待上一段完成并使用其真实尾帧。`,
            conflict_slots: ['semantic_slots.h3_mode', 'semantic_slots.first_frame_policy', 'semantic_slots.continuity_type'],
          });
        }
      }
      if (h3Mode === 'fl2va') {
        if (requiredRefs.length > 0 || (Array.isArray(audioRefs) && audioRefs.length > 0)) {
          violations.push({
            rule: 'INVARIANT_FL2VA_REF_CONTAMINATION',
            shot_number: shotNum,
            severity: this.defaultSeverity,
            message: `分镜 #${shotNum} 设定为纯血首帧绑定模式 (FL2VA)，但混入了图片或音频参考；请由 Agent 改用 Ref2VA，或明确由首帧独立承载全部视觉信息！`,
            conflict_slots: ['h3_mode', 'required_references', 'speech_plan.audio_references'],
          });
        }
        if (!['generate_new', 'inherit_tail', 'layout_lock'].includes(firstFramePolicy)) {
          violations.push({
            rule: 'INVARIANT_FL2VA_FIRST_FRAME_REQUIRED',
            shot_number: shotNum,
            severity: this.defaultSeverity,
            message: `分镜 #${shotNum} 规划为 FL2VA，但未规划有效首帧；FL2VA 必须使用 generate_new、inherit_tail 或 layout_lock！`,
            conflict_slots: ['h3_mode', 'first_frame_policy'],
          });
        }
      } else if (h3Mode === 'ref2va') {
        if (firstFramePolicy !== 'none') {
          violations.push({
            rule: 'INVARIANT_REF2VA_FIRST_FRAME_FORBIDDEN',
            shot_number: shotNum,
            severity: this.defaultSeverity,
            message: `分镜 #${shotNum} 规划为 Ref2VA，本项目为节省资源不使用 AddGuide 首帧，first_frame_policy 必须为 none！`,
            conflict_slots: ['h3_mode', 'first_frame_policy'],
          });
        }
        if ((slots.last_frame_policy || shot.last_frame_policy || '') !== 'none') {
          violations.push({
            rule: 'INVARIANT_REF2VA_LAST_FRAME_FORBIDDEN',
            shot_number: shotNum,
            severity: this.defaultSeverity,
            message: `分镜 #${shotNum} 规划为 Ref2VA，首尾参考帧都应省略；需要精确结尾状态时请由 Agent 将整套方案改为 FL2VA！`,
            conflict_slots: ['h3_mode', 'last_frame_policy'],
          });
        }
      } else {
        violations.push({
          rule: 'INVARIANT_H3_MODE_PLAN_MISSING',
          shot_number: shotNum,
          severity: this.defaultSeverity,
          message: `分镜 #${shotNum} 缺少 Agent 明确规划的 semantic_slots.h3_mode=ref2va，后端禁止代替 Agent 猜测模式！`,
          conflict_slots: ['semantic_slots.h3_mode'],
        });
      }

      // 用户把“全能分镜”作为导演规划模式时，后端只负责门禁：要求 Agent
      // 给出完整 Ref2VA 多参考合同。长镜续段/FL2VA 不再是 Agent 合法例外；
      // 只有生成后用户在单镜执行设置中的人工覆盖才可以使用 FL2VA。
      const planningMode = context.options?.directorPlanningMode;
      const enforceUniversal = planningMode === 'universal'
        || (planningMode === 'persisted' && shot.creation_mode === 'universal');
      if (enforceUniversal) {
        if (shot.creation_mode !== 'universal') {
          violations.push({
            rule: 'INVARIANT_UNIVERSAL_CREATION_MODE_REQUIRED',
            shot_number: shotNum,
            severity: this.defaultSeverity,
            message: `分镜 #${shotNum} 必须显式输出 creation_mode=universal，导演 Agent 不得忽略用户勾选的全能分镜模式。`,
            conflict_slots: ['creation_mode'],
          });
        }
        if (!String(shot.universal_segment_text || '').trim()) {
          violations.push({
            rule: 'INVARIANT_UNIVERSAL_SEGMENT_REQUIRED',
            shot_number: shotNum,
            severity: this.defaultSeverity,
            message: `分镜 #${shotNum} 缺少导演 Agent 规划的 universal_segment_text。`,
            conflict_slots: ['universal_segment_text'],
          });
        }
        {
          if (h3Mode !== 'ref2va') {
            violations.push({
              rule: 'INVARIANT_UNIVERSAL_REF2VA_REQUIRED',
              shot_number: shotNum,
              severity: this.defaultSeverity,
              message: `分镜 #${shotNum} 已选择全能分镜，必须由导演 Agent 按 Ref2VA 多参考模式规划，不得混用 FL2VA 首帧方案。`,
              conflict_slots: ['creation_mode', 'semantic_slots.h3_mode'],
            });
          }
          const firstRef = requiredRefs[0] || null;
          const firstRefType = String(firstRef?.type || firstRef?.asset_type || '').toLowerCase();
          const firstRefId = Number(firstRef?.id ?? firstRef?.scene_id);
          if (!firstRef || firstRefType !== 'scene' || !Number.isFinite(firstRefId) || firstRefId !== Number(shot.scene_id)) {
            violations.push({
              rule: 'INVARIANT_UNIVERSAL_SCENE_REFERENCE_REQUIRED',
              shot_number: shotNum,
              severity: this.defaultSeverity,
              message: `分镜 #${shotNum} 的全能多参考清单第 1 项必须是当前场景 scene_id=${shot.scene_id}，对应 universal_segment_text 中的 @图片1。`,
              conflict_slots: ['scene_id', 'semantic_slots.required_references', 'universal_segment_text'],
            });
          }
          const referencedCharacterIds = new Set(requiredRefs
            .filter((ref) => String(ref?.type || ref?.asset_type || '').toLowerCase() === 'character')
            .map((ref) => Number(ref?.id ?? ref?.character_id))
            .filter(Number.isFinite));
          const missingCharacterIds = [...new Set([...parseIds(visibleChars), ...parseIds(bgChars)])]
            .filter((id) => !referencedCharacterIds.has(id));
          if (missingCharacterIds.length) {
            violations.push({
              rule: 'INVARIANT_UNIVERSAL_CHARACTER_REFERENCE_MISSING',
              shot_number: shotNum,
              severity: this.defaultSeverity,
              message: `分镜 #${shotNum} 的全能多参考清单缺少画内角色参考：${missingCharacterIds.join('、')}。`,
              conflict_slots: ['semantic_slots.visible_characters', 'semantic_slots.background_characters', 'semantic_slots.required_references'],
            });
          }
          const imageTags = [...String(shot.universal_segment_text || '').matchAll(/@图片\s*(\d+)/gu)]
            .map((match) => Number(match[1]));
          const maxImageTag = imageTags.length ? Math.max(...imageTags) : 0;
          if (maxImageTag > requiredRefs.length) {
            violations.push({
              rule: 'INVARIANT_UNIVERSAL_IMAGE_TAG_DANGLING',
              shot_number: shotNum,
              severity: this.defaultSeverity,
              message: `分镜 #${shotNum} 的 universal_segment_text 引用了 @图片${maxImageTag}，但 required_references 只有 ${requiredRefs.length} 项。`,
              conflict_slots: ['universal_segment_text', 'semantic_slots.required_references'],
            });
          }
        }
      }
    });

    return violations;
  }
}

module.exports = {
  CrossSlotInvariantsRule,
  checkCrossSlotInvariants: (shots) => new CrossSlotInvariantsRule().evaluate({ shots }),
};
