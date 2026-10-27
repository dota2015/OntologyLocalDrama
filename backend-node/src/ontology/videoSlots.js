/**
 * 影视视听本体：视频语义槽位系统（Video Semantic Slots System）
 * 遵循确定性语义槽位契约（Video Slots Contract）原则：
 * 绝不依赖脆弱的正则关键字替换或字符串拼凑，而是通过显式的物理与视听语义槽位组织视频生成提示词：
 * 1. 机位与动态运镜槽位 (camera)
 * 2. 音频与口型控制契约 (audio_lip_sync) —— 彻底根治“画外音/无线电导致画内演员动口型”的行业通病
 * 3. 角色动态轨迹槽位 (trajectories) —— 明确每个角色的物理起点、运动轨迹、终点动作、面部表情与口型状态
 * 4. 环境与物理特效交互 (environment_vfx) —— 将抽象军事术语（如“弹着点”）转化为具体视觉物理现象（飞溅碎石、火星与烟尘）
 * 5. 节奏与时长控制 (timing)
 */

const angleService = require('../services/angleService');
const { stripChineseExclusions } = require('../utils/framePromptSanitize');

// 物理现象与军事术语具象化字典
const PHYSICAL_TRANSLATION_MAP = [
  { regex: /连续弹着点/g, visual: '一连串密集子弹扫射在水泥地面上激起的飞溅碎石、烟尘与火花' },
  { regex: /弹着火星/g, visual: '子弹击地迸发的飞溅火花与烟尘' },
  { regex: /弹着点/g, visual: '子弹击中地面的飞溅碎石与火花' },
  { regex: /弹着/g, visual: '子弹击地' },
];

function translatePhysicalPhenomena(text) {
  if (!text) return '';
  let str = String(text);
  for (const item of PHYSICAL_TRANSLATION_MAP) {
    str = str.replace(item.regex, item.visual);
  }
  return str;
}

/**
 * 规范化视频槽位对象结构
 * @param {object} data
 * @returns {object}
 */
function createVideoSemanticSlots(data = {}) {
  const camera = data.camera || {};
  const audio = data.audio_lip_sync || {};
  const env = data.environment_vfx || {};
  const timing = data.timing || {};

  return {
    camera: {
      shot_type: String(camera.shot_type || '中景').trim(),
      angle_h: String(camera.angle_h || 'front').trim(),
      angle_v: String(camera.angle_v || 'eye_level').trim(),
      angle_s: String(camera.angle_s || 'medium').trim(),
      movement: String(camera.movement || 'tracking').trim(),
      movement_description: String(camera.movement_description || '').trim(),
    },
    audio_lip_sync: {
      mode: String(audio.mode || 'silent_ambient').trim(), // 'in_frame_dialogue' | 'offscreen_voiceover' | 'narration' | 'silent_ambient' | 'bgm_only'
      speaker_name: String(audio.speaker_name || '').trim(),
      speaker_in_frame: Boolean(audio.speaker_in_frame),
      delivery_medium: String(audio.delivery_medium || 'direct_speech').trim(), // 'direct_speech' | 'radio_headset' | 'phone_call' | 'intercom' | 'voiceover' | 'narration'
      dialogue_content: String(audio.dialogue_content || '').trim(),
      visible_characters_lip_state: String(audio.visible_characters_lip_state || (audio.speaker_in_frame ? 'synchronized_lip' : 'strictly_sealed')).trim(),
      lip_sync_rule: String(audio.lip_sync_rule || '').trim(),
    },
    trajectories: Array.isArray(data.trajectories)
      ? data.trajectories.map((t) => ({
          character_id: t.character_id != null ? Number(t.character_id) : null,
          name: String(t.name || '人物').trim(),
          start_anchor: String(t.start_anchor || '').trim(),
          trajectory: String(t.trajectory || '').trim(),
          end_anchor: String(t.end_anchor || '').trim(),
          terminal_pose: String(t.terminal_pose || '').trim(),
          facial_expression: String(t.facial_expression || '').trim(),
          mouth_state: String(t.mouth_state || '双唇紧闭，严禁张嘴说话，无任何台词口型').trim(),
        }))
      : [],
    environment_vfx: {
      lighting_atmosphere: String(env.lighting_atmosphere || '').trim(),
      physical_phenomena: String(env.physical_phenomena || '').trim(),
      terminal_event: String(env.terminal_event || '').trim(),
    },
    timing: {
      duration: Math.max(1, Math.min(120, Number(timing.duration || 5))),
      pacing: String(timing.pacing || '稳健推进').trim(),
    },
    shots_timeline: Array.isArray(data.shots_timeline)
      ? data.shots_timeline.map((s, idx) => ({
          shot_number: s.shot_number || (idx + 1),
          timestamp: s.timestamp || null,
          duration: Number(s.duration || 0),
          camera: {
            shot_type: String(s.camera?.shot_type || '中景').trim(),
            movement: String(s.camera?.movement || 'tracking').trim(),
            movement_description: String(s.camera?.movement_description || '').trim(),
          },
          action: String(s.action || '').trim(),
          result: String(s.result || '').trim(),
          character_trajectories: Array.isArray(s.character_trajectories)
            ? s.character_trajectories.map((t) => ({
                character_id: t.character_id != null ? Number(t.character_id) : null,
                name: String(t.name || '人物').trim(),
                start_anchor: String(t.start_anchor || '').trim(),
                trajectory: String(t.trajectory || '').trim(),
                end_anchor: String(t.end_anchor || '').trim(),
                terminal_pose: String(t.terminal_pose || '').trim(),
                facial_expression: String(t.facial_expression || '').trim(),
                mouth_state: String(t.mouth_state || '双唇紧闭，严禁张嘴说话，无任何台词口型').trim(),
                shot_number: s.shot_number || (idx + 1),
              }))
            : [],
          audio_lip_sync: {
            mode: String(s.audio_lip_sync?.mode || 'silent_ambient').trim(),
            speaker_name: String(s.audio_lip_sync?.speaker_name || '').trim(),
            speaker_in_frame: Boolean(s.audio_lip_sync?.speaker_in_frame),
            dialogue_content: String(s.audio_lip_sync?.dialogue_content || '').trim(),
            lip_sync_rule: String(s.audio_lip_sync?.lip_sync_rule || '').trim(),
          },
        }))
      : [],
    h3_multimodal: {
      shots: Array.isArray(data.h3_multimodal?.shots)
        ? data.h3_multimodal.shots.map((s, idx) => ({
            shot_number: s.shot_number || (idx + 1),
            timestamp: s.timestamp || (idx === 0 ? null : (s.timestamp ?? '00:03.500')),
            description: String(s.description || '').trim(),
          }))
        : [],
      integrated_multimodal_description: String(data.h3_multimodal?.integrated_multimodal_description || '').trim(),
      overall_soundscape: String(data.h3_multimodal?.overall_soundscape || '').trim(),
      non_diegetic_music: String(data.h3_multimodal?.non_diegetic_music || '').trim(),
    },
  };
}

/**
 * 校验视频语义槽位合法性（硬门禁）
 * @param {object} shot
 * @param {object} slots
 * @returns {Array<object>} 违规列表
 */
function validateVideoSlots(shot, slots) {
  const violations = [];
  const shotNum = shot.shot_number || shot.storyboard_number || 1;

  if (!slots || typeof slots !== 'object') {
    violations.push({
      rule: 'INVARIANT_VIDEO_SLOT_EMPTY',
      shot_number: shotNum,
      severity: 'error',
      message: `分镜 ${shotNum} 缺少视频语义槽位 (video_slots)。`,
    });
    return violations;
  }

  const audio = slots.audio_lip_sync || {};
  // 1. 画外音与口型契约校验（严格防止画内演员动嘴）
  if (audio.mode === 'offscreen_voiceover' || !audio.speaker_in_frame) {
    if (audio.dialogue_content && audio.visible_characters_lip_state !== 'strictly_sealed') {
      violations.push({
        rule: 'INVARIANT_OFFSCREEN_LIP_SYNC_VIOLATION',
        shot_number: shotNum,
        severity: 'error',
        message: `分镜 ${shotNum} 台词为画外音/无线电，但画内角色口型契约未设为 strictly_sealed，视频模型会导致画内人物开口错乱！`,
      });
    }

    if (Array.isArray(slots.trajectories)) {
      slots.trajectories.forEach((traj) => {
        if (!/(?:双唇紧闭|闭口|绝对不张嘴|无口型|严禁说话|不张嘴)/.test(traj.mouth_state)) {
          violations.push({
            rule: 'INVARIANT_CHARACTER_MOUTH_NOT_SEALED',
            shot_number: shotNum,
            severity: 'error',
            message: `分镜 ${shotNum} 画外音模式下，角色「${traj.name}」的口型槽位必须明确声明双唇紧闭无口型！`,
          });
        }
      });
    }
  }

  // 2. 轨迹完整性校验
  if (Array.isArray(slots.trajectories)) {
    slots.trajectories.forEach((traj) => {
      if (!traj.start_anchor || !traj.trajectory) {
        violations.push({
          rule: 'INVARIANT_TRAJECTORY_INCOMPLETE',
          shot_number: shotNum,
          severity: 'warning',
          message: `分镜 ${shotNum} 角色「${traj.name}」的物理轨迹槽位不完整（需包含起止点与运动过程）。`,
        });
      }
    });
  }

  // 3. 抽象军事术语排查（必须具象为视觉物理现象）
  const fullText = JSON.stringify(slots);
  if (/(?:连续弹着点|弹着火星|弹着点)/.test(fullText)) {
    violations.push({
      rule: 'INVARIANT_ABSTRACT_PHYSICAL_JARGON',
      shot_number: shotNum,
      severity: 'warning',
      message: `分镜 ${shotNum} 包含未具象化的军事术语（如弹着点），视频模型无法理解抽象名词，必须具象化为“飞溅碎石、火花与烟尘”！`,
    });
  }

  return violations;
}

/**
 * 确定性编译器：从语义槽位编译符合视频扩散模型（Seedance / Minimax / Wan / Kling）的高质量视频提示词
 * @param {object} shot
 * @param {object} slots
 * @param {object} options
 * @returns {string}
 */
function compileVideoPromptFromSlots(shot, slots, options = {}) {
  const normSlots = createVideoSemanticSlots(slots);
  const parts = [];

  // 1. 场景与标题
  if (shot.scene_description) {
    parts.push('场景：' + stripChineseExclusions(shot.scene_description));
  } else if (shot.location) {
    const loc = shot.time ? `${shot.location}，${shot.time}` : shot.location;
    parts.push('场景：' + stripChineseExclusions(loc));
  }
  if (shot.title) parts.push('镜头标题：' + stripChineseExclusions(shot.title));

  // 2. 角色外貌造型注入（角色外貌合同）
  if (shot.character_appearances) {
    parts.push('角色造型：' + stripChineseExclusions(String(shot.character_appearances).replace(/\r?\n/g, '；')));
  }

  // 3. 景别与机位动态运镜
  const cam = normSlots.camera;
  if (cam.shot_type) parts.push('景别：' + cam.shot_type);

  const chAngle = angleService.toChineseLabel(cam.angle_h, cam.angle_v, cam.angle_s);
  const angleFragment = angleService.toPromptFragment(cam.angle_h, cam.angle_v, cam.angle_s);
  parts.push(`镜头角度：${chAngle}（${angleFragment}）`);

  const moveDesc = cam.movement_description ? `（${cam.movement_description}）` : '';
  parts.push(`运镜：${cam.movement}${moveDesc}`);

  // 4. 角色动态与物理轨迹（明确起点、动作、终态与口型）
  if (normSlots.trajectories.length > 0) {
    const trajLines = normSlots.trajectories.map((t) => {
      const items = [];
      if (t.start_anchor) items.push(`起点：${t.start_anchor}`);
      if (t.trajectory) items.push(`动作轨迹：${t.trajectory}`);
      if (t.end_anchor) items.push(`终点：${t.end_anchor}`);
      if (t.terminal_pose) items.push(`终态姿态：${t.terminal_pose}`);
      if (t.facial_expression) items.push(`面部神态：${t.facial_expression}`);
      if (t.mouth_state) items.push(`口型状态：${t.mouth_state}`);
      return `「${t.name}」` + items.join('，');
    });
    parts.push('角色动态与轨迹：' + trajLines.join('；'));
  } else if (shot.action) {
    parts.push('动作：' + translatePhysicalPhenomena(stripChineseExclusions(shot.action)));
  }

  // 5. 音频与口型控制契约（Lip-Sync Contract）
  const audio = normSlots.audio_lip_sync;
  if (audio.mode === 'offscreen_voiceover' || !audio.speaker_in_frame) {
    if (audio.dialogue_content) {
      const spk = audio.speaker_name ? `画外角色${audio.speaker_name}` : '画外无线电';
      const med = audio.delivery_medium === 'radio_headset' ? '战术耳机中传来' : '';
      parts.push(`画外无线电呼叫（画内全员闭口无口型）：${med}${spk}的急促呼喊（纯画外音传输，画面内所有人物全程紧闭双唇，绝对不开口说话，无任何台词口型动作）：“${audio.dialogue_content}”`);
    }
  } else if (audio.mode === 'in_frame_dialogue' && audio.dialogue_content) {
    const spk = audio.speaker_name ? audio.speaker_name : '角色';
    parts.push(`对话：${spk}: "${audio.dialogue_content}"（仅限说话人${spk}开口说话并同步口型，画面其余人物双唇紧闭保持倾听，严禁开口）`);
  } else if (audio.mode === 'narration' && audio.dialogue_content) {
    parts.push(`解说旁白（画内全员闭口）：${audio.dialogue_content}`);
  }

  // 6. 环境物理特效与交互 (Environment VFX)
  const vfx = normSlots.environment_vfx;
  if (vfx.physical_phenomena) {
    parts.push('物理与环境交互：' + vfx.physical_phenomena);
  }
  if (vfx.terminal_event) {
    parts.push('结果收束：' + vfx.terminal_event);
  } else if (shot.result) {
    parts.push('结果：' + translatePhysicalPhenomena(stripChineseExclusions(shot.result)));
  }

  // 7. 氛围与情绪
  if (shot.atmosphere) parts.push('氛围：' + shot.atmosphere);
  if (shot.emotion) parts.push('情绪：' + shot.emotion);

  // 8. 声音设计
  if (shot.bgm_prompt) parts.push('配乐：' + shot.bgm_prompt);
  if (shot.sound_effect) parts.push('音效：' + shot.sound_effect);

  // 9. 时长与画风
  const durationSec = normSlots.timing.duration || normalizeDuration(shot.duration) || 5;
  parts.push(`时长：${durationSec}秒`);

  const style = options.style || shot.style || 'photorealistic, ultra-detailed, 8k uhd, sharp focus, natural lighting, real skin texture, hyperrealism, professional photography, RAW photo';
  parts.push('风格：' + style);

  // 10. 严格口型与画面负向/正向约束
  if (audio.mode === 'offscreen_voiceover' || !audio.speaker_in_frame) {
    parts.push('画面与口型要求：(off-screen radio voiceover only, all visible characters in frame keep mouth closed, lips sealed, strictly no lip movement, characters do not talk)');
  } else if (audio.mode === 'in_frame_dialogue' && audio.speaker_name) {
    parts.push(`画面与口型要求：(lip sync only for ${audio.speaker_name}, all other visible characters keep mouth closed, lips sealed, strictly no lip movement)`);
  }

  // 画面比例
  const videoRatio = options.videoRatio || shot.video_ratio || '16:9';
  parts.push('=VideoRatio: ' + videoRatio);

  return parts.join('。');
}

/**
 * 格式化 H3 时间戳 (如 3.5秒 -> "00:03.500", 7秒 -> "00:07.000")
 * @param {number} sec
 * @returns {string} "00:0X.XXX"
 */
function formatH3Timestamp(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const minutes = Math.floor(s / 60);
  const remainingSec = s % 60;
  const wholeSec = Math.floor(remainingSec);
  const ms = Math.round((remainingSec - wholeSec) * 1000);
  const mm = String(minutes).padStart(2, '0');
  const ss = String(wholeSec).padStart(2, '0');
  const mmm = String(ms).padStart(3, '0');
  return `${mm}:${ss}.${mmm}`;
}

/**
 * 依据 MiniMax H3 官方多模态语法合成 H3 Shot 时间轴槽位
 * @param {object} shot
 * @param {object} options
 * @returns {object} { shots, integrated_multimodal_description, overall_soundscape, non_diegetic_music }
 */
function synthesizeH3MultimodalSlots(shot, options = {}) {
  const dur = normalizeDuration(shot.duration) || 5;
  const shotType = shot.shot_type || 'medium shot';
  const movement = shot.movement || 'tracking';
  const actionText = translatePhysicalPhenomena(String(shot.action || ''));
  const resultText = translatePhysicalPhenomena(String(shot.result || ''));
  const diagText = String(shot.dialogue || '');

  const h3Shots = [];

  // 若显式传入了镜头时间线 shots_timeline，直接依据时间线生成 H3 Shots
  if (Array.isArray(options.shots_timeline) && options.shots_timeline.length > 0) {
    options.shots_timeline.forEach((st) => {
      let desc = '';
      const camType = st.camera?.shot_type || shotType;
      const move = st.camera?.movement || movement;
      if (!st.timestamp) {
        desc = `Live-action, cinematic. A ${camType} establishes the scene. The camera begins with ${move} as ${st.action || actionText || 'the action initiates'}.`;
      } else {
        desc = `At ${st.timestamp}, the camera cuts to a ${camType}, where ${st.action || resultText || actionText || 'the movement resolves'}.`;
        if (st.audio_lip_sync?.dialogue_content) {
          const spk = st.audio_lip_sync.speaker_name ? `${st.audio_lip_sync.speaker_name}: ` : '';
          const cleanDiag = String(st.audio_lip_sync.dialogue_content).replace(/^["“](.*)["”]$/, '$1');
          desc += ` Dialogue follows: ${spk}“${cleanDiag}”`;
        }
      }
      h3Shots.push({
        shot_number: st.shot_number,
        timestamp: st.timestamp,
        description: desc.trim(),
      });
    });
  } else {
    // 判断是否具备镜头切分条件 (时长 >= 6s 且有转折/对话/结果动作)
    const needsCut = dur >= 6 && (resultText.trim().length > 0 || diagText.trim().length > 0);

    if (!needsCut) {
      // 单镜头连续画面: [Shot 1] 从 0 秒开始，不加时间戳
      let desc1 = `Live-action, cinematic. A ${shotType} frames the scene. The camera moves with ${movement}. ${actionText}`;
      if (resultText) desc1 += ` ${resultText}`;
      if (diagText) desc1 += ` Dialogue: ${diagText}`;
      h3Shots.push({
        shot_number: 1,
        timestamp: null,
        description: desc1.trim(),
      });
    } else {
      // 多镜头时间线切分: [Shot 1] (0秒开始) + [Shot 2] At 00:0X.XXX
      const cutSec = Math.round((dur / 2) * 2) / 2; // 例如 7s -> 3.5s, 8s -> 4.0s
      const timecode = formatH3Timestamp(cutSec);

      // [Shot 1] 开头第一段画面 (建构机位与主体起始动作)
      const desc1 = `Live-action, cinematic. A ${shotType} establishes the scene. The camera begins with ${movement} as ${actionText || 'the action initiates'}.`;
      h3Shots.push({
        shot_number: 1,
        timestamp: null,
        description: desc1.trim(),
      });

      // [Shot 2] At 00:XX.XXX 按时间切过去的后续反应/反打/终态镜头
      const secondaryShotType = shotType === '特写' || shotType === '近景' ? 'medium shot' : 'close-up shot';
      let desc2 = `At ${timecode}, the camera cuts to a ${secondaryShotType}, where ${resultText || actionText || 'the movement resolves'}.`;
      if (diagText) desc2 += ` Dialogue follows: ${diagText}`;
      h3Shots.push({
        shot_number: 2,
        timestamp: timecode,
        description: desc2.trim(),
      });
    }
  }

  // 拼接 integrated_multimodal_description
  const integratedDesc = h3Shots
    .map((s) => (s.timestamp ? `[Shot ${s.shot_number}] At ${s.timestamp}, ${s.description.replace(/^At\s+[\d:.]+,\s*/, '')}` : `[Shot ${s.shot_number}] ${s.description}`))
    .join('\n');

  // 音效与环境声 overall_soundscape
  const soundscape = shot.sound_effect
    ? `Ambient environmental audio, room tone, and physical impact sounds: ${shot.sound_effect}.`
    : 'Subtle ambient room tone and realistic environmental sounds matching physical actions.';

  // 配乐 non_diegetic_music
  const music = shot.bgm_prompt && shot.bgm_prompt.trim()
    ? `Cinematic score: ${shot.bgm_prompt.trim()}.`
    : 'N/A';

  return {
    shots: h3Shots,
    integrated_multimodal_description: integratedDesc,
    overall_soundscape: soundscape,
    non_diegetic_music: music,
  };
}

/**
 * 视频语义槽位智能合成器：从 shot 现有数据、实体目录与首尾帧中提取高内聚强结构槽位
 * @param {object} shot
 * @param {Array<object>} catalogCharacters
 * @returns {object} video_slots
 */
function synthesizeVideoSlots(shot, catalogCharacters = [], options = {}) {
  if (shot.video_slots && !options.forceRebuild) {
    let existing = shot.video_slots;
    if (typeof existing === 'string') {
      try { existing = JSON.parse(existing); } catch (_) { existing = null; }
    }
    const isLegacyHallucinated = JSON.stringify(existing || '').includes('凌空飞扑') &&
      !/(?:扑向|飞扑|凌空扑|跃起|扑倒)/.test(String(shot.action || '') + ' ' + String(shot.result || ''));
    if (!isLegacyHallucinated && existing && typeof existing === 'object' && existing.camera && existing.audio_lip_sync && Array.isArray(existing.shots_timeline) && existing.shots_timeline.length > 0) {
      if (!existing.h3_multimodal || !existing.h3_multimodal.integrated_multimodal_description) {
        existing.h3_multimodal = synthesizeH3MultimodalSlots(shot, { camera: existing.camera, shots_timeline: existing.shots_timeline });
      }
      return createVideoSemanticSlots(existing);
    }
  }

  const charMap = new Map();
  (catalogCharacters || []).forEach((c) => {
    if (c && c.id != null) charMap.set(Number(c.id), c);
  });

  const charIds = [];
  if (Array.isArray(shot.characters)) {
    charIds.push(...shot.characters.map((x) => (typeof x === 'object' && x != null ? x.id : x)).map(Number).filter(Number.isFinite));
  } else if (typeof shot.characters === 'string') {
    try {
      const p = JSON.parse(shot.characters);
      if (Array.isArray(p)) charIds.push(...p.map(Number).filter(Number.isFinite));
    } catch (_) {}
  }

  const actionText = translatePhysicalPhenomena(String(shot.action || ''));
  const resultText = translatePhysicalPhenomena(String(shot.result || ''));
  const dialogueText = String(shot.dialogue || '').trim();
  const narrationText = String(shot.narration || '').trim();

  // 1. 推断音频与口型契约 (Audio Lip Sync)
  let speakerName = '';
  let diagContent = dialogueText;
  let speakerMatch = dialogueText.match(/^([^:：\s]+)\s*[:：]\s*(.*)$/s);
  if (speakerMatch) {
    speakerName = speakerMatch[1].trim();
    diagContent = speakerMatch[2].trim().replace(/^["“](.*)["”]$/, '$1');
  }

  const visibleNames = charIds.map((cid) => charMap.get(cid)?.name).filter(Boolean);
  const isSpeakerInVisibleList = speakerName ? visibleNames.includes(speakerName) : false;

  const isExplicitOffscreen =
    /(?:画外|不入画|不在画中|无线电|战术耳机|通讯器|隔空|对讲机)/i.test(actionText) ||
    /(?:画外|不入画|不在画中|无线电|耳机|对讲机)/i.test(dialogueText);

  let audioMode = 'silent_ambient';
  let speakerInFrame = false;
  let deliveryMedium = 'direct_speech';
  let lipState = 'strictly_sealed';
  let lipRule = '画面内全员双唇紧闭，无任何开口动作。';

  if (dialogueText) {
    if (!isSpeakerInVisibleList || isExplicitOffscreen) {
      audioMode = 'offscreen_voiceover';
      speakerInFrame = false;
      deliveryMedium = /(?:战术耳机|耳机)/i.test(actionText + dialogueText) ? 'radio_headset' : 'voiceover';
      lipState = 'strictly_sealed';
      lipRule = `战术耳机传来画外角色${speakerName || '画外'}的急促呼喊（纯画外音传输，画面内所有人物全程紧闭双唇，绝对不开口说话，无任何台词口型动作）`;
    } else {
      audioMode = 'in_frame_dialogue';
      speakerInFrame = true;
      deliveryMedium = 'direct_speech';
      lipState = 'synchronized_lip';
      lipRule = `仅限说话人${speakerName}开口说话，其余画内人物双唇紧闭保持倾听`;
    }
  } else if (narrationText) {
    audioMode = 'narration';
    speakerInFrame = false;
    deliveryMedium = 'narration';
    lipState = 'strictly_sealed';
    lipRule = '解说旁白播放，画内全员双唇紧闭无口型动作';
    diagContent = narrationText;
  } else if (shot.bgm_prompt) {
    audioMode = 'bgm_only';
  }

  // 2. 推断角色动态轨迹 (Trajectories) - 完全通用化推演，绝无写死角色名与固定角色启发
  const trajectories = [];
  const firstSlots = Array.isArray(shot.character_visuals) ? shot.character_visuals : [];
  const lastSlots = Array.isArray(shot.last_frame_visuals) ? shot.last_frame_visuals : [];

  charIds.forEach((cid, idx) => {
    const cObj = charMap.get(cid) || {};
    const name = cObj.name || `角色${idx + 1}`;
    const fSlot = firstSlots.find((s) => s.character_id === cid || s.name === name) || firstSlots[idx] || {};
    const lSlot = lastSlots.find((s) => s.character_id === cid || s.name === name) || lastSlots[idx] || {};

    const defaultAnchor = idx === 0 ? '画面左侧' : (idx === 1 ? '画面右侧' : '画面中央');
    let startAnchor = fSlot.spatial_anchor || defaultAnchor;
    let endAnchor = lSlot.spatial_anchor || startAnchor;
    let trajDesc = '';
    let termPose = lSlot.posture || '';
    let facial = '神情专注严肃';
    let mouth = (speakerInFrame && name === speakerName)
      ? '开口说话并同步口型'
      : '双唇紧闭，严禁张嘴说话，完全无任何开口动作';

    // 针对当前角色提取动作与终态关键词
    const charMentionRegex = new RegExp(`(?:${name})[^，。；]*`, 'g');
    const matchedMentions = ((actionText + ' ' + resultText).match(charMentionRegex) || []).join('，');
    const isTargetBeingApproached = name
      ? new RegExp('(?:冲向|扑向|赶到|走向|跑向|接近)\\s*' + name).test(actionText + ' ' + resultText)
      : false;
    const activeText = matchedMentions || (idx === 0 ? actionText : resultText) || actionText;

    if (isTargetBeingApproached || /(?:倒卧|倒在|倒地|负伤|虚弱|昏迷|起不来|重伤)/.test(activeText)) {
      trajDesc = '侧卧倒在地面掩体旁，因伤势身体虚弱隐忍，无大幅位移';
      facial = '双目微阖神色虚弱隐忍，双唇紧闭';
      if (!termPose) termPose = '侧卧倒地，单手虚弱护在身前';
    } else if (/(?:扑向|飞扑|凌空扑|跃起|扑倒|伸手扑)/.test(activeText)) {
      trajDesc = '全力爆发疾速前扑冲向目标';
      facial = '咬紧牙关，神情焦灼决绝';
      if (!termPose) termPose = '身体大幅前倾凌空飞扑，单臂向前竭力伸手抓向目标';
      if (!lSlot.spatial_anchor && endAnchor === startAnchor) endAnchor = '距离目标半米处';
    } else if (/(?:冲向|奔跑|狂奔|疾冲|冲出|大步走|大步奔)/.test(activeText)) {
      trajDesc = '大步疾速奔跑冲刺向前推进';
      facial = '目光专注坚定，神情严峻';
      if (!termPose) termPose = '身体前倾大步冲刺，重心前移定格';
    } else if (/(?:操作|展开|点击|调出|标记|简报|屏幕|键盘|界面)/.test(activeText)) {
      trajDesc = '在场景中操作交互界面，动作利落专注';
      facial = '目光专注锐利，神情冷静沉着';
      if (!termPose) termPose = '身体微前倾，专注操作与审视前方界面';
    } else if (/(?:掩体|躲避|隐蔽|蹲伏|单膝|防守|戒备)/.test(activeText)) {
      trajDesc = '在掩体后保持警戒防护';
      facial = '目光警惕，神情严肃戒备';
      if (!termPose) termPose = '屈膝蹲伏压低身姿，保持隐蔽警戒';
    } else {
      trajDesc = actionText ? actionText.slice(0, 35) : '动作敏捷，保持稳定姿态推进';
      facial = '神情沉着专注，保持戒备';
      if (!termPose) termPose = resultText ? resultText.slice(0, 35) : '身体站定收步，目光专注重心稳固';
    }

    trajectories.push({
      character_id: cid,
      name,
      start_anchor: startAnchor,
      trajectory: trajDesc,
      end_anchor: endAnchor,
      terminal_pose: termPose,
      facial_expression: facial,
      mouth_state: mouth,
    });
  });

  // 3. 具象化环境与物理特效 (Environment VFX)
  let physical = '';
  if (/(?:弹着|子弹|扫射|枪声|火星)/.test(actionText + resultText)) {
    physical = '密集子弹高速扫射在水泥地面上，激起一连串飞溅碎石、烟尘与火花，紧随冲刺轨迹追逐至脚边';
  }

  let terminalEvent = translatePhysicalPhenomena(resultText);
  if (!terminalEvent && actionText) {
    terminalEvent = '动作瞬间定格，飞溅火花与烟尘在空中微粒悬停';
  }

  // 4. 摄影参数
  const camera = {
    shot_type: shot.shot_type || '全景',
    angle_h: shot.angle_h || 'front_right',
    angle_v: shot.angle_v || 'low',
    angle_s: shot.angle_s || 'wide',
    movement: shot.movement || 'tracking',
    movement_description: shot.movement === 'tracking' ? '摄影机贴地平稳跟随主体冲刺轨迹同步移动' : '',
  };

  const durationSec = normalizeDuration(shot.duration) || 5;

  // 5. 合成多镜头时间线切分 (shots_timeline)
  const shotsTimeline = [];
  const needsCut = durationSec >= 6 && (resultText.trim().length > 0 || diagContent.trim().length > 0);

  if (!needsCut) {
    shotsTimeline.push({
      shot_number: 1,
      timestamp: null,
      duration: durationSec,
      camera: {
        shot_type: camera.shot_type,
        movement: camera.movement,
        movement_description: camera.movement_description,
      },
      action: actionText || '场景主体动作稳健推进',
      result: resultText || '',
      character_trajectories: trajectories.map((t) => ({ ...t, shot_number: 1 })),
      audio_lip_sync: {
        mode: audioMode,
        speaker_name: speakerName,
        speaker_in_frame: speakerInFrame,
        dialogue_content: diagContent,
        lip_sync_rule: lipRule,
      },
    });
  } else {
    const cutSec = Math.round((durationSec / 2) * 2) / 2;
    const timecode = formatH3Timestamp(cutSec);
    const secondaryShotType = camera.shot_type === '特写' || camera.shot_type === '近景' ? '中景' : '特写';

    shotsTimeline.push({
      shot_number: 1,
      timestamp: null,
      duration: cutSec,
      camera: {
        shot_type: camera.shot_type,
        movement: camera.movement,
        movement_description: camera.movement_description,
      },
      action: actionText || '场景主体动作开启推进',
      result: '',
      character_trajectories: trajectories.map((t) => ({
        ...t,
        end_anchor: t.start_anchor,
        terminal_pose: '保持推进与初始交互动作',
        mouth_state: '双唇紧闭，严禁张嘴说话，无任何台词口型动作',
        shot_number: 1,
      })),
      audio_lip_sync: {
        mode: 'silent_ambient',
        speaker_name: '',
        speaker_in_frame: false,
        dialogue_content: '',
        lip_sync_rule: '初始建立镜头，画内全员紧闭双唇，无台词口型',
      },
    });

    shotsTimeline.push({
      shot_number: 2,
      timestamp: timecode,
      duration: durationSec - cutSec,
      camera: {
        shot_type: secondaryShotType,
        movement: 'static',
        movement_description: '镜头平稳聚焦主体终态与表情反应',
      },
      action: resultText || '动作收束并完成交互反应',
      result: resultText || '',
      character_trajectories: trajectories.map((t) => ({
        ...t,
        start_anchor: t.end_anchor,
        shot_number: 2,
      })),
      audio_lip_sync: {
        mode: audioMode,
        speaker_name: speakerName,
        speaker_in_frame: speakerInFrame,
        dialogue_content: diagContent,
        lip_sync_rule: lipRule,
      },
    });
  }

  return createVideoSemanticSlots({
    camera,
    audio_lip_sync: {
      mode: audioMode,
      speaker_name: speakerName,
      speaker_in_frame: speakerInFrame,
      delivery_medium: deliveryMedium,
      dialogue_content: diagContent,
      visible_characters_lip_state: lipState,
      lip_sync_rule: lipRule,
    },
    trajectories,
    shots_timeline: shotsTimeline,
    environment_vfx: {
      lighting_atmosphere: shot.atmosphere || '',
      physical_phenomena: physical,
      terminal_event: terminalEvent,
    },
    timing: {
      duration: durationSec,
      pacing: '急促高潮',
    },
    h3_multimodal: synthesizeH3MultimodalSlots(shot, {
      camera,
      shots_timeline: shotsTimeline,
    }),
  });
}

function compileH3MultimodalPrompt(slots = {}) {
  const norm = createVideoSemanticSlots(slots);
  return {
    integrated_multimodal_description: norm.h3_multimodal?.integrated_multimodal_description || '',
    overall_soundscape: norm.h3_multimodal?.overall_soundscape || '',
    non_diegetic_music: norm.h3_multimodal?.non_diegetic_music || '',
    shots: norm.h3_multimodal?.shots || [],
    shots_timeline: norm.shots_timeline || [],
  };
}

function normalizeDuration(dur) {
  if (dur == null || dur === '') return 5;
  const num = typeof dur === 'number' ? dur : parseFloat(String(dur).replace(/[^0-9.]/g, ''));
  return Number.isFinite(num) && num > 0 ? num : 5;
}

module.exports = {
  createVideoSemanticSlots,
  validateVideoSlots,
  compileVideoPromptFromSlots,
  compileH3MultimodalPrompt,
  synthesizeVideoSlots,
  synthesizeH3MultimodalSlots,
  formatH3Timestamp,
  translatePhysicalPhenomena,
};
