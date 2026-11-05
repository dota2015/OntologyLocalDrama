const aiConfigService = require('./aiConfigService');
const { instrumentClient } = require('./agentTokenUsage');
const { flattenModelIds, pickModelId, remapArkModelId } = require('./modelId');

let sdkPromise = null;

function loadSdk() {
  if (!sdkPromise) {
    sdkPromise = Promise.all([
      import('@openai/agents'),
      import('openai'),
    ]).then(([agents, openai]) => ({
      Agent: agents.Agent,
      Runner: agents.Runner,
      OpenAIChatCompletionsModel: agents.OpenAIChatCompletionsModel,
      OpenAI: openai.default,
    }));
  }
  return sdkPromise;
}

function parseSettings(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function resolveDirectorModel(db, preferredModel = null) {
  const configs = aiConfigService.listConfigs(db, 'text').filter((item) => item.is_active);
  const config = preferredModel
    ? configs.find((item) => flattenModelIds(item.model).includes(preferredModel))
    : (configs.find((item) => item.is_default) || configs[0]);
  if (!config) throw new Error('未配置文本模型，请在「AI 配置」中添加 text 类型且已启用的配置');

  const models = flattenModelIds(config.model);
  const preferred = pickModelId(preferredModel);
  const configuredDefault = pickModelId(config.default_model);
  const selected = preferred && models.includes(preferred)
    ? preferred
    : (configuredDefault && models.includes(configuredDefault) ? configuredDefault : models[0]);
  const model = remapArkModelId(config.base_url, selected || '');
  const baseURL = String(config.base_url || '').trim().replace(/\/+$/u, '');
  if (!baseURL || !model) throw new Error('文本模型的 base_url 或模型名为空');
  return { config, model, baseURL, settings: parseSettings(config.settings) };
}

function normalizeReasoningEffort(value) {
  const effort = String(value || '').trim().toLowerCase();
  return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort) ? effort : null;
}

function buildDirectorModelSettings(resolved, options = {}) {
  const { config, model, settings } = resolved;
  const modelName = String(model || '').toLowerCase();
  const thinking = options.thinking ?? settings.thinking ?? settings.deepseek_thinking;
  const effort = normalizeReasoningEffort(
    options.reasoningEffort ?? options.reasoning_effort
      ?? settings.reasoning_effort ?? settings.deepseek_reasoning_effort
  );
  const providerData = {};

  if (modelName.includes('qwen')) {
    providerData.chat_template_kwargs = {
      enable_thinking: thinking === 'enabled',
    };
  } else if (thinking === 'enabled' && (modelName.includes('deepseek') || modelName.includes('seed'))) {
    providerData.thinking = { type: 'enabled' };
  } else if (thinking === 'disabled' && (modelName.includes('deepseek') || modelName.includes('seed'))) {
    providerData.thinking = { type: 'disabled' };
  }

  const requestedMax = Number(options.maxTokens ?? options.max_tokens);
  const configuredMax = Number(settings.max_tokens);
  let maxTokens = Number.isFinite(requestedMax) && requestedMax > 0 ? Math.floor(requestedMax) : null;
  if (Number.isFinite(configuredMax) && configuredMax > 0) {
    maxTokens = maxTokens == null ? Math.floor(configuredMax) : Math.min(maxTokens, Math.floor(configuredMax));
  }

  const configuredTimeout = Number(settings.timeout_ms ?? settings.timeoutMs);
  const requestedTimeout = Number(options.timeoutMs ?? options.timeout_ms);
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? requestedTimeout
    : (Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 1_800_000);
  const modelSettings = {
    ...(Number.isFinite(Number(options.temperature)) ? { temperature: Number(options.temperature) } : {}),
    ...(maxTokens != null ? { maxTokens } : {}),
    ...(Object.keys(providerData).length ? { providerData } : {}),
    timeoutMs,
  };
  if (thinking === 'enabled' && effort) modelSettings.reasoning = { effort };
  return modelSettings;
}

function normalizeSourceAssignments(sourceAssignments, count) {
  if (!Array.isArray(sourceAssignments) || sourceAssignments.length !== count) return null;
  const normalized = sourceAssignments.map((ids) => (
    Array.isArray(ids) ? ids.map((id) => String(id || '')).filter(Boolean) : []
  ));
  return normalized.every((ids) => ids.length > 0) ? normalized : null;
}

function exactStringArraySchema(ids) {
  return {
    type: 'array',
    minItems: ids.length,
    maxItems: ids.length,
    prefixItems: ids.map((id) => ({ const: id })),
    items: false,
  };
}

function nonEmptyStringSchema() {
  return { type: 'string', minLength: 1, maxLength: 80 };
}

function stringSchema(maxLength = 500) {
  return { type: 'string', maxLength };
}

function nullableStringSchema(maxLength = 500) {
  return { anyOf: [stringSchema(maxLength), { type: 'null' }] };
}

function characterVisualSchema() {
  const fields = [
    'character_id', 'name', 'depth_layer', 'screen_position', 'environmental_anchor',
    'facing', 'expression', 'head_pose', 'gaze', 'posture', 'hands',
    'prop_interaction', 'appearance_details',
  ];
  return {
    type: 'object', additionalProperties: false, required: fields,
    properties: {
      character_id: { type: 'integer', minimum: 1 },
      name: stringSchema(80),
      depth_layer: stringSchema(80),
      screen_position: stringSchema(240),
      environmental_anchor: stringSchema(240),
      facing: stringSchema(160),
      expression: stringSchema(240),
      head_pose: stringSchema(160),
      gaze: stringSchema(240),
      posture: stringSchema(240),
      hands: stringSchema(240),
      prop_interaction: stringSchema(240),
      appearance_details: stringSchema(300),
    },
  };
}

function backgroundCharacterSchema() {
  return {
    type: 'object', additionalProperties: false,
    required: ['character_id', 'name', 'depth_layer', 'screen_position', 'activity', 'mouth_state'],
    properties: {
      character_id: { type: 'integer', minimum: 1 },
      name: stringSchema(80),
      depth_layer: stringSchema(80),
      screen_position: stringSchema(240),
      activity: stringSchema(240),
      mouth_state: stringSchema(160),
    },
  };
}

function characterTrajectorySchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'character_id', 'trajectory', 'terminal_pose', 'facial_expression', 'facing',
      'head_pose', 'gaze', 'attention_target', 'gaze_motivation', 'reaction_trigger',
      'mouth_state',
    ],
    properties: {
      character_id: { type: 'integer', minimum: 1 },
      name: { type: 'string' },
      start_anchor: { type: 'string' },
      trajectory: { ...nonEmptyStringSchema(), description: '按剧情写出本段实际动作过程及与对方的配合，包括说完后的行动；有依据的保持状态也合法，不默认安静倾听。' },
      end_anchor: { type: 'string' },
      terminal_pose: { ...nonEmptyStringSchema(), description: '上述动作或受阻结果实际到达的结束姿态，与本段 result 一致；不是默认复制初始姿态。' },
      facial_expression: nonEmptyStringSchema(),
      facing: nonEmptyStringSchema(),
      head_pose: nonEmptyStringSchema(),
      gaze: nonEmptyStringSchema(),
      attention_target: nonEmptyStringSchema(),
      gaze_motivation: nonEmptyStringSchema(),
      reaction_trigger: nonEmptyStringSchema(),
      mouth_state: nonEmptyStringSchema(),
    },
  };
}

function timelineSegmentSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'shot_number', 'timestamp', 'duration', 'camera', 'action', 'result',
      'visible_characters', 'character_trajectories', 'audio_lip_sync', 'speech_action_alignment',
    ],
    properties: {
      shot_number: { type: 'integer', minimum: 1 },
      timestamp: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      // 外层逻辑分镜为 4～30 秒，但镜内时间线每段只允许 1～2 秒，
      // 这样每个人物的动作和反应都有明确的时间窗口。
      duration: { type: 'integer', minimum: 1, maximum: 2 },
      camera: {
        type: 'object',
        additionalProperties: false,
        required: ['shot_type', 'movement', 'movement_description'],
        properties: {
          shot_type: nonEmptyStringSchema(),
          movement: nonEmptyStringSchema(),
          movement_description: nonEmptyStringSchema(),
        },
      },
      action: { type: 'string', minLength: 1, maxLength: 120 },
      result: { type: 'string', minLength: 1, maxLength: 120, description: '本段事件的实际结果，与参与人物的 terminal_pose 一致；未完成或被打断须按剧情明确结果。' },
      visible_characters: {
        type: 'array', maxItems: 3,
        description: '本段构图中实际入画的人物；特写、过肩和画外音可只列出当前可见人物，不得把未入画人物塞入轨迹。',
        items: {
          type: 'object', additionalProperties: false, required: ['character_id', 'name'],
          properties: { character_id: { type: 'integer', minimum: 1 }, name: { type: 'string', maxLength: 80 } },
        },
      },
      character_trajectories: {
        type: 'array',
        items: characterTrajectorySchema(),
      },
      audio_lip_sync: {
        type: 'object',
        additionalProperties: true,
        required: ['mode', 'speaker_name', 'speaker_in_frame', 'dialogue_content', 'lip_sync_rule'],
        properties: {
          mode: nonEmptyStringSchema(),
          speaker_name: { type: 'string' },
          speaker_in_frame: { type: 'boolean' },
          dialogue_content: { type: 'string' },
          lip_sync_rule: { type: 'string' },
        },
      },
      speech_action_alignment: {
        type: 'object', additionalProperties: false,
        required: ['mode', 'speech_window', 'speaker_action_window', 'speaker_action', 'listener_reactions', 'pause_reason'],
        properties: {
          mode: { enum: ['concurrent', 'deliberate_pause', 'none'] },
          speech_window: {
            type: 'object', additionalProperties: false, required: ['start', 'end'],
            properties: { start: { type: 'number', minimum: 0 }, end: { type: 'number', minimum: 0 } },
          },
          speaker_action_window: {
            type: 'object', additionalProperties: false, required: ['start', 'end'],
            properties: { start: { type: 'number', minimum: 0 }, end: { type: 'number', minimum: 0 } },
          },
          speaker_action: { type: 'string', maxLength: 300 },
          listener_reactions: {
            type: 'array', maxItems: 3, items: {
              type: 'object', additionalProperties: false, required: ['character_id', 'action_window', 'action'],
              properties: {
                character_id: { type: 'integer', minimum: 1 },
                action_window: {
                  type: 'object', additionalProperties: false, required: ['start', 'end'],
                  properties: { start: { type: 'number', minimum: 0 }, end: { type: 'number', minimum: 0 } },
                },
                action: { type: 'string', maxLength: 240 },
              },
            },
          },
          pause_reason: { type: 'string', maxLength: 240 },
        },
      },
    },
  };
}

function videoSlotsSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['performance_contract', 'camera', 'audio_lip_sync', 'trajectories', 'environment_vfx', 'timing', 'shots_timeline'],
    properties: {
      performance_contract: { enum: ['sync_v1', 'legacy'] },
      camera: {
        type: 'object', additionalProperties: false,
        required: ['shot_type', 'angle_h', 'angle_v', 'angle_s', 'movement', 'movement_description'],
        properties: {
          shot_type: stringSchema(80), angle_h: stringSchema(80), angle_v: stringSchema(80),
          angle_s: stringSchema(80), movement: stringSchema(80), movement_description: stringSchema(300),
        },
      },
      audio_lip_sync: {
        type: 'object', additionalProperties: false,
        required: ['mode', 'speaker_name', 'speaker_in_frame', 'delivery_medium', 'dialogue_content', 'visible_characters_lip_state', 'lip_sync_rule'],
        properties: {
          mode: stringSchema(80), speaker_name: stringSchema(80), speaker_in_frame: { type: 'boolean' },
          delivery_medium: stringSchema(80), dialogue_content: stringSchema(500),
          visible_characters_lip_state: stringSchema(160), lip_sync_rule: stringSchema(300),
        },
      },
      trajectories: { type: 'array', items: characterTrajectorySchema() },
      environment_vfx: {
        type: 'object', additionalProperties: false,
        required: ['lighting_atmosphere', 'physical_phenomena', 'terminal_event'],
        properties: {
          lighting_atmosphere: stringSchema(300), physical_phenomena: stringSchema(300), terminal_event: stringSchema(300),
        },
      },
      timing: {
        type: 'object',
        additionalProperties: true,
        required: ['duration', 'pacing'],
        properties: {
          duration: { type: 'integer', minimum: 4, maximum: 30 },
          pacing: nonEmptyStringSchema(),
        },
      },
      shots_timeline: {
        type: 'array',
        minItems: 1,
        // A 30-second Continuum shot is still one logical shot, but its
        // executable timeline can contain up to thirty one-second windows.
        maxItems: 30,
        items: timelineSegmentSchema(),
      },
    },
  };
}

function semanticSlotsSchema(assignedIds = null) {
  const required = [
    'visible_characters', 'background_characters', 'identity_visibility', 'speech_plan',
    'sound_plan', 'continuity_type', 'continuity_from_previous', 'h3_mode', 'h3_mode_reason', 'first_frame_policy',
    'first_frame_reason', 'last_frame_policy', 'last_frame_reason', 'required_references',
    'audio_lip_sync', 'shot_duration', 'execution_backend', 'continuum_plan',
  ];
  if (assignedIds) required.push('source_script_unit_ids');
  return {
    type: 'object',
    additionalProperties: false,
    required,
    properties: {
      visible_characters: {
        type: 'array', maxItems: 3,
        items: {
          type: 'object', additionalProperties: false, required: ['id', 'name'],
          properties: { id: { type: 'integer', minimum: 1 }, name: stringSchema(80) },
        },
      },
      background_characters: { type: 'array', maxItems: 3, items: backgroundCharacterSchema() },
      identity_visibility: nonEmptyStringSchema(),
      speech_plan: {
        type: 'object', additionalProperties: false,
        required: ['speaker_id', 'speaker_name', 'is_offscreen', 'is_narration', 'text', 'speed', 'emotion', 'audio_references'],
        properties: {
          speaker_id: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
          speaker_name: stringSchema(80), is_offscreen: { type: 'boolean' }, is_narration: { type: 'boolean' },
          text: stringSchema(500), speed: { type: 'number', minimum: 0.5, maximum: 2 },
          emotion: stringSchema(120), audio_references: { type: 'array', maxItems: 3 },
        },
      },
      sound_plan: {
        type: 'object', additionalProperties: false,
        required: ['sound_effects', 'bgm_prompt', 'acoustic_env', 'is_silent'],
        properties: {
          sound_effects: { type: 'array', maxItems: 8, items: stringSchema(160) },
          bgm_prompt: stringSchema(300), acoustic_env: stringSchema(240), is_silent: { type: 'boolean' },
        },
      },
      continuity_type: nonEmptyStringSchema(),
      continuity_from_previous: {
        type: 'object', additionalProperties: false,
        required: ['relationship', 'previous_end_state', 'entry_state', 'causal_link'],
        properties: {
          relationship: nonEmptyStringSchema(),
          previous_end_state: stringSchema(500),
          entry_state: stringSchema(500),
          causal_link: stringSchema(500),
          sound_bridge: stringSchema(300),
          requires_previous_tail: { type: 'boolean' },
        },
      },
      // Director planning is Ref2VA-only. FL2VA is a post-generation manual override.
      h3_mode: { const: 'ref2va' },
      h3_mode_reason: nonEmptyStringSchema(),
      first_frame_policy: nonEmptyStringSchema(),
      first_frame_reason: nonEmptyStringSchema(),
      last_frame_policy: nonEmptyStringSchema(),
      last_frame_reason: nonEmptyStringSchema(),
      required_references: {
        type: 'array', maxItems: 9,
        items: {
          type: 'object', additionalProperties: false, required: ['type', 'id', 'name'],
          properties: {
            type: { enum: ['character', 'scene', 'prop', 'audio'] },
            id: { type: 'integer', minimum: 1 }, name: stringSchema(120),
            character_id: { type: 'integer', minimum: 1 },
          },
        },
      },
      audio_lip_sync: nonEmptyStringSchema(),
      shot_duration: { type: 'integer', minimum: 4, maximum: 30 },
      execution_backend: { enum: ['h3_single', 'h3_continuum'] },
      continuum_plan: {
        anyOf: [
          { type: 'null' },
          { type: 'object', additionalProperties: true, required: ['enabled', 'total_duration', 'chunks', 'chunk_seconds'], properties: {
            enabled: { const: true }, total_duration: { type: 'integer', minimum: 9, maximum: 30 },
            chunks: { type: 'integer', minimum: 1, maximum: 8 }, chunk_seconds: { type: 'integer', minimum: 4, maximum: 30 },
          } },
        ],
      },
      ...(assignedIds ? { source_script_unit_ids: exactStringArraySchema(assignedIds) } : {}),
    },
  };
}

function storyboardItemSchema(assignedIds = null) {
  const properties = {
    shot_number: { type: 'integer', minimum: 1 },
    dialogue_framing: stringSchema(240),
    long_take_group_id: { type: 'null' },
    long_take_role: { type: 'null' },
    long_take_sequence: { type: 'null' },
    title: stringSchema(80), scene_id: { type: 'integer', minimum: 1 },
    characters: { type: 'array', maxItems: 3, items: { type: 'integer', minimum: 1 } },
    background_characters: { type: 'array', maxItems: 3, items: backgroundCharacterSchema() },
    identity_visibility: stringSchema(80),
    wardrobe_id: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
    speech_plan: { type: 'object' }, sound_plan: { type: 'object' }, continuity_type: stringSchema(80),
    h3_mode: { const: 'ref2va' }, h3_mode_reason: stringSchema(300),
    first_frame_policy: stringSchema(80), first_frame_reason: stringSchema(300),
    last_frame_policy: stringSchema(80), last_frame_reason: stringSchema(300),
    required_references: { type: 'array', maxItems: 9 }, audio_lip_sync: stringSchema(80),
    shot_duration: { type: 'integer', minimum: 4, maximum: 30 },
    execution_backend: { enum: ['h3_single', 'h3_continuum'] },
    continuum_plan: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: true }] },
    start_framing: stringSchema(500), end_framing: stringSchema(500), transition_to_next: stringSchema(400),
    props: { type: 'array', maxItems: 2, items: { type: 'integer', minimum: 1 } },
    shot_type: stringSchema(80), angle_h: stringSchema(80), angle_v: stringSchema(80), angle_s: stringSchema(80),
    movement: stringSchema(80), lighting_style: stringSchema(80), lighting_chiaroscuro: stringSchema(400),
    environment_depth: stringSchema(400), cinematic_lens: stringSchema(240), depth_of_field: stringSchema(80),
    duration: { type: 'integer', minimum: 4, maximum: 30 }, action: stringSchema(500), result: stringSchema(400),
    dialogue: stringSchema(500), narration: stringSchema(500), bgm_prompt: stringSchema(300), sound_effect: stringSchema(300),
    layout_description: stringSchema(500), emotion: stringSchema(120),
    character_visuals: { type: 'array', maxItems: 3, items: characterVisualSchema() },
    last_frame_visuals: { type: 'array', maxItems: 3, items: characterVisualSchema() },
    video_slots: videoSlotsSchema(), semantic_slots: semanticSlotsSchema(assignedIds),
    creation_mode: stringSchema(80), universal_segment_text: stringSchema(1200),
    image_prompt: stringSchema(1200), last_frame_prompt: stringSchema(1200),
  };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['shot_number', 'character_visuals', 'video_slots', 'semantic_slots'],
    properties,
  };
}

function storyboardDraftItemSchema(assignedIds = null) {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'shot_number', 'title', 'scene_id', 'characters', 'background_characters', 'props',
      'shot_type', 'angle_h', 'angle_v', 'angle_s', 'movement', 'lighting_style',
      'depth_of_field', 'duration', 'action', 'result', 'dialogue', 'narration',
      'bgm_prompt', 'sound_effect', 'layout_description', 'emotion', 'start_framing',
      'end_framing', 'transition_to_next', 'dialogue_framing', 'semantic_slots',
    ],
    properties: {
      shot_number: { type: 'integer', minimum: 1 },
      title: stringSchema(80), scene_id: { type: 'integer', minimum: 1 },
      characters: { type: 'array', maxItems: 3, items: { type: 'integer', minimum: 1 } },
      background_characters: { type: 'array', maxItems: 3, items: backgroundCharacterSchema() },
      props: { type: 'array', maxItems: 2, items: { type: 'integer', minimum: 1 } },
      shot_type: stringSchema(80), angle_h: stringSchema(80), angle_v: stringSchema(80), angle_s: stringSchema(80),
      movement: stringSchema(80), lighting_style: stringSchema(80), depth_of_field: stringSchema(80),
      duration: { type: 'integer', minimum: 4, maximum: 30 },
      action: stringSchema(500), result: stringSchema(400), dialogue: stringSchema(500), narration: stringSchema(500),
      bgm_prompt: stringSchema(300), sound_effect: stringSchema(300), layout_description: stringSchema(500), emotion: stringSchema(120),
      start_framing: stringSchema(500), end_framing: stringSchema(500), transition_to_next: stringSchema(400), dialogue_framing: stringSchema(240),
      long_take_group_id: { type: 'null' }, long_take_role: { type: 'null' },
      long_take_sequence: { type: 'null' },
      lighting_chiaroscuro: stringSchema(400), environment_depth: stringSchema(400), cinematic_lens: stringSchema(240),
      creation_mode: stringSchema(80), universal_segment_text: stringSchema(1600),
      semantic_slots: semanticSlotsSchema(assignedIds),
    },
  };
}

function directorTimelineOutputType(duration = 5) {
  const seconds = Math.max(4, Math.min(30, Number(duration) || 5));
  return {
    type: 'json_schema',
    name: 'director_shot_timeline',
    strict: false,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['shots_timeline'],
      properties: {
        shots_timeline: {
          type: 'array',
          minItems: Math.ceil(seconds / 2),
          maxItems: Math.floor(seconds),
          items: timelineSegmentSchema(),
        },
      },
    },
  };
}

function directorVideoSlotsOutputType(duration = 5) {
  const seconds = Math.max(4, Math.min(30, Number(duration) || 5));
  const schema = videoSlotsSchema();
  // 每个段最多 2 秒，因此逻辑分镜至少需要 ceil(duration / 2) 段。
  schema.properties.shots_timeline.minItems = Math.ceil(seconds / 2);
  schema.properties.shots_timeline.maxItems = Math.floor(seconds);
  return {
    type: 'json_schema',
    name: 'director_video_slots',
    strict: false,
    schema: {
      type: 'object', additionalProperties: false, required: ['video_slots'],
      properties: { video_slots: schema },
    },
  };
}

function directorCharacterVisualsOutputType() {
  return {
    type: 'json_schema',
    name: 'director_character_visuals',
    strict: false,
    schema: {
      type: 'object', additionalProperties: false,
      required: ['character_visuals', 'last_frame_visuals'],
      properties: {
        character_visuals: { type: 'array', maxItems: 3, items: characterVisualSchema() },
        last_frame_visuals: { type: 'array', maxItems: 3, items: characterVisualSchema() },
      },
    },
  };
}

function directorExecutionSlotsOutputType(duration = 5, options = {}) {
  const seconds = Math.max(4, Math.min(30, Number(duration) || 5));
  const timeline = videoSlotsSchema();
  timeline.properties.shots_timeline.minItems = Math.ceil(seconds / 2);
  timeline.properties.shots_timeline.maxItems = Math.floor(seconds);
  const allowTailVisuals = options?.allowTailVisuals ?? (options?.lastFramePolicy === 'generate_tail');
  const tailVisualsSchema = allowTailVisuals
    ? { type: 'array', maxItems: 3, items: characterVisualSchema() }
    : { type: 'array', maxItems: 0, items: characterVisualSchema() };
  return {
    type: 'json_schema',
    name: 'director_execution_slots',
    strict: false,
    schema: {
      type: 'object', additionalProperties: false,
      required: ['semantic_slots', 'character_visuals', 'last_frame_visuals', 'video_slots'],
      properties: {
        // 语义槽位由导演 Agent 明确规划；本地编译器不得根据对白或动作自行猜测。
        semantic_slots: { type: 'object', additionalProperties: true },
        character_visuals: { type: 'array', maxItems: 3, items: characterVisualSchema() },
        last_frame_visuals: tailVisualsSchema,
        video_slots: timeline,
      },
    },
  };
}

function buildContiguousSourcePartitions(sourceUnits, shotCount) {
  const ids = (Array.isArray(sourceUnits) ? sourceUnits : [])
    .map((unit) => String(unit?.id || unit || '')).filter(Boolean);
  const count = Math.max(1, Math.floor(Number(shotCount) || 1));
  if (ids.length < count) return [];
  const results = [];
  const visit = (start, remaining, groups) => {
    if (remaining === 1) {
      results.push([...groups, ids.slice(start)]);
      return;
    }
    const maxEnd = ids.length - remaining + 1;
    for (let end = start + 1; end <= maxEnd; end++) {
      visit(end, remaining - 1, [...groups, ids.slice(start, end)]);
    }
  };
  visit(0, count, []);
  return results;
}

function sourceAssignmentOutputType(shotCount, sourceUnits) {
  const count = Math.max(1, Math.floor(Number(shotCount) || 1));
  const partitions = buildContiguousSourcePartitions(sourceUnits, count);
  if (!partitions.length) throw new Error('原文单元数量不足，无法为每个分镜分配连续覆盖范围');
  const assignmentSchema = (partition) => ({
    type: 'array',
    minItems: count,
    maxItems: count,
    prefixItems: partition.map((ids, index) => ({
      type: 'object',
      additionalProperties: false,
      required: ['shot_slot', 'source_script_unit_ids'],
      properties: {
        shot_slot: { const: index + 1 },
        source_script_unit_ids: exactStringArraySchema(ids),
      },
    })),
    items: false,
  });
  return {
    type: 'json_schema',
    name: 'director_source_assignment',
    strict: false,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['assignments'],
      properties: {
        assignments: partitions.length === 1
          ? assignmentSchema(partitions[0])
          : { oneOf: partitions.map(assignmentSchema) },
      },
    },
  };
}

function storyboardBatchOutputType(shotCount, sourceUnits = [], sourceAssignments = null) {
  const count = Math.max(1, Math.floor(Number(shotCount) || 1));
  const unitIds = Array.isArray(sourceUnits)
    ? sourceUnits.map((unit) => String(unit?.id || unit || '')).filter(Boolean)
    : [];
  const assignments = normalizeSourceAssignments(sourceAssignments, count)
    || (unitIds.length === count ? unitIds.map((id) => [id]) : null);
  const positionalItems = assignments
    ? assignments.map((assignedIds) => storyboardDraftItemSchema(assignedIds))
    : null;
  return {
    type: 'json_schema',
    name: 'director_storyboard_batch',
    strict: false,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['storyboards'],
      properties: {
        storyboards: {
          type: 'array',
          minItems: count,
          maxItems: count,
          ...(positionalItems
            ? { prefixItems: positionalItems, items: false }
            : {
              items: storyboardDraftItemSchema(),
            }),
        },
      },
    },
  };
}

const directorRepairOutputType = {
  type: 'json_schema',
  name: 'director_single_shot_repair',
  strict: false,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      repairs: {
        type: 'array', maxItems: 1,
        items: {
          type: 'object', additionalProperties: false, required: ['shot_number', 'patch'],
          properties: {
            shot_number: { type: 'integer' },
            patch: { type: 'object', additionalProperties: true },
          },
        },
      },
      structural_repairs: {
        type: 'array', maxItems: 1,
        items: {
          type: 'object', additionalProperties: false, required: ['replace_shot_number', 'storyboards'],
          properties: {
            replace_shot_number: { type: 'integer' },
            storyboards: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: true } },
          },
        },
      },
    },
    anyOf: [
      { required: ['repairs'] },
      { required: ['structural_repairs'] },
    ],
  },
};

function directorPatchRepairOutputType(shotNumber, patchSchema = null) {
  return {
    type: 'json_schema',
    name: 'director_single_shot_patch',
    strict: false,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['repairs'],
      properties: {
        repairs: {
          type: 'array', minItems: 1, maxItems: 1,
          prefixItems: [{
            type: 'object', additionalProperties: false, required: ['shot_number', 'patch'],
            properties: {
              shot_number: { const: Number(shotNumber) },
              patch: patchSchema || { type: 'object', additionalProperties: true },
            },
          }],
          items: false,
        },
      },
    },
  };
}

function directorStructuralRepairOutputType(shotNumber) {
  // A split is still a complete semantic repair, but asking the model to
  // repeat every unchanged visual slot for both new shots routinely exhausts
  // the completion budget before JSON closes. Each item is therefore an
  // explicit patch over the original shot; applyDirectorRepairPlan merges it
  // onto that original and the final gate validates the materialized shots.
  const replacementSchema = {
    type: 'object', additionalProperties: false,
    required: ['duration', 'dialogue', 'narration', 'semantic_slots', 'video_slots'],
    properties: {
      shot_number: { type: 'integer', minimum: 1 },
      title: { type: 'string', maxLength: 80 },
      duration: { type: 'integer', minimum: 4, maximum: 30 },
      action: { type: 'string', maxLength: 500 },
      result: { type: 'string', maxLength: 400 },
      dialogue: { type: 'string', maxLength: 500 },
      narration: { type: 'string', maxLength: 500 },
      start_framing: { type: 'string', maxLength: 500 },
      end_framing: { type: 'string', maxLength: 500 },
      transition_to_next: { type: 'string', maxLength: 400 },
      semantic_slots: {
        type: 'object', additionalProperties: false,
        required: ['source_script_excerpt'],
        properties: {
          source_script_excerpt: { type: 'string' },
          source_script_unit_ids: { type: 'array', items: { type: 'string' } },
          speech_plan: { type: 'object', additionalProperties: true },
          audio_lip_sync: { type: 'string', maxLength: 80 },
          shot_duration: { type: 'integer', minimum: 4, maximum: 30 },
          continuity_from_previous: { type: 'object', additionalProperties: true },
        },
      },
      video_slots: {
        type: 'object', additionalProperties: false,
        properties: {
          performance_contract: { type: 'string', maxLength: 40 },
          audio_lip_sync: { type: 'object', additionalProperties: true },
          timing: { type: 'object', additionalProperties: true },
          shots_timeline: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
    },
  };
  return {
    type: 'json_schema',
    name: 'director_single_shot_structural_repair',
    strict: false,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['structural_repairs'],
      properties: {
        structural_repairs: {
          type: 'array', minItems: 1, maxItems: 1,
          prefixItems: [{
            type: 'object', additionalProperties: false, required: ['replace_shot_number', 'storyboards'],
            properties: {
              replace_shot_number: { const: Number(shotNumber) },
              storyboards: { type: 'array', minItems: 2, items: replacementSchema },
            },
          }],
          items: false,
        },
      },
    },
  };
}

const directorRefinementOutputType = {
  type: 'json_schema',
  name: 'director_storyboard_refinement',
  strict: false,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      patch: { type: 'object', additionalProperties: true },
      noop: { type: 'boolean' },
      reason: { type: 'string' },
    },
    anyOf: [
      { required: ['patch'] },
      { required: ['noop', 'reason'] },
    ],
  },
};

async function runAgent(db, log, options) {
  const {
    name = 'local-mini-drama-agent',
    instructions = '',
    input,
    outputType = 'text',
    maxTurns = 1,
    preferredModel = null,
  } = options || {};
  const resolved = resolveDirectorModel(db, preferredModel);
  const modelSettings = buildDirectorModelSettings(resolved, options || {});
  const { Agent, Runner, OpenAIChatCompletionsModel, OpenAI } = await loadSdk();
  const client = new OpenAI({
    apiKey: resolved.config.api_key || 'local',
    baseURL: resolved.baseURL,
    timeout: modelSettings.timeoutMs,
  });
  instrumentClient(client, { agent: name, model: resolved.model }, log);
  const model = new OpenAIChatCompletionsModel(client, resolved.model);
  const agent = new Agent({ name, instructions, model, modelSettings, outputType });
  const runner = new Runner({ tracingDisabled: true });
  const startedAt = Date.now();
  log?.info?.('[OpenAI Agents SDK] director run started', {
    agent: name,
    model: resolved.model,
    max_tokens: modelSettings.maxTokens ?? '(model default)',
    structured_output: outputType !== 'text',
  });
  let result;
  try {
    result = await runner.run(agent, String(input || ''), {
      maxTurns: Math.max(1, Math.floor(Number(maxTurns) || 1)),
    });
  } catch (error) {
    const responses = Array.isArray(error?.state?._modelResponses) ? error.state._modelResponses : [];
    const lastResponse = responses.length ? responses[responses.length - 1] : null;
    let serialized = '';
    try { serialized = lastResponse ? JSON.stringify(lastResponse) : ''; } catch (_) { serialized = ''; }
    log?.error?.('[OpenAI Agents SDK] director run failed', {
      agent: name,
      model: resolved.model,
      error: error?.message || String(error),
      response_count: responses.length,
      last_response_chars: serialized.length,
      last_response_tail: serialized ? serialized.slice(-1000) : '',
    });
    throw error;
  }
  if (result.finalOutput == null || result.finalOutput === '') {
    throw new Error('OpenAI Agents SDK 返回内容为空');
  }
  log?.info?.('[OpenAI Agents SDK] director run completed', {
    agent: name,
    model: resolved.model,
    elapsed_ms: Date.now() - startedAt,
  });
  return result.finalOutput;
}

module.exports = {
  runAgent,
  resolveDirectorModel,
  buildDirectorModelSettings,
  buildContiguousSourcePartitions,
  sourceAssignmentOutputType,
  storyboardBatchOutputType,
  directorTimelineOutputType,
  directorVideoSlotsOutputType,
  directorCharacterVisualsOutputType,
  directorExecutionSlotsOutputType,
  directorRepairOutputType,
  directorPatchRepairOutputType,
  directorStructuralRepairOutputType,
  directorRefinementOutputType,
};
