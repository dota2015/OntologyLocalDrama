<template>
  <div class="slot-tree-editor" :class="{ 'slot-tree-editor--nested': depth > 0 }">
    <template v-if="isObject">
      <div v-if="entries.length === 0" class="slot-tree-empty">空对象</div>
      <div v-for="([key, value]) in entries" :key="key" class="slot-tree-row">
        <div class="slot-tree-key">
          <span>{{ fieldLabel(key) }}</span>
          <code>{{ key }}</code>
        </div>
        <SlotTreeEditor
          v-if="isContainer(value)"
          :model-value="value"
          :depth="depth + 1"
          @update:model-value="updateObjectKey(key, $event)"
        />
        <el-switch
          v-else-if="typeof value === 'boolean'"
          :model-value="value"
          @update:model-value="updateObjectKey(key, $event)"
        />
        <el-input-number
          v-else-if="typeof value === 'number' || isNullableIntKey(key)"
          :model-value="value"
          size="small"
          :min="isIdKey(key) ? 1 : undefined"
          :value-on-clear="null"
          controls-position="right"
          placeholder="null"
          @update:model-value="updateObjectKey(key, $event == null ? null : $event)"
        />
        <el-input
          v-else
          :model-value="value == null ? '' : String(value)"
          type="textarea"
          :autosize="{ minRows: 1, maxRows: 4 }"
          size="small"
          :placeholder="key === 'timestamp' ? 'null (首段无切镜时刻)' : ''"
          @update:model-value="updateObjectKey(key, normalizeStringUpdate(key, $event))"
        />
      </div>
    </template>

    <template v-else-if="isArray">
      <div v-if="modelValue.length === 0" class="slot-tree-empty">空数组 []</div>
      <div v-for="(value, index) in modelValue" :key="index" class="slot-tree-array-item">
        <div class="slot-tree-index">#{{ index + 1 }}</div>
        <SlotTreeEditor
          v-if="isContainer(value)"
          :model-value="value"
          :depth="depth + 1"
          @update:model-value="updateArrayIndex(index, $event)"
        />
        <el-input
          v-else
          :model-value="value == null ? '' : String(value)"
          size="small"
          @update:model-value="updateArrayIndex(index, $event)"
        />
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed } from 'vue'

defineOptions({ name: 'SlotTreeEditor' })

const props = defineProps({
  modelValue: { type: [Object, Array], required: true },
  depth: { type: Number, default: 0 },
})
const emit = defineEmits(['update:modelValue'])

const isArray = computed(() => Array.isArray(props.modelValue))
const isObject = computed(() => !isArray.value && props.modelValue && typeof props.modelValue === 'object')
const entries = computed(() => isObject.value ? Object.entries(props.modelValue) : [])

const NULLABLE_INT_KEYS = new Set([
  'character_id', 'facing_target_id', 'gaze_target_id', 'hands_object_id',
  'hands_target_id', 'object_id', 'target_id', 'source_id',
  'speaker_character_id', 'wardrobe_id',
])

const LABELS = {
  performance_contract: '性能执行契约',
  execution_backend: '执行引擎版本',
  continuum_plan: '长镜分片计划 (Continuum)',
  character_id: '角色 ID',
  name: '名称',
  depth_layer: '景深层级',
  screen_position: '画面位置',
  environmental_anchor: '环境锚点',
  facing: '身体朝向',
  facing_target_id: '朝向目标 ID',
  head_pose: '头部姿态',
  gaze_type: '视线类型',
  gaze_target_id: '视线目标 ID',
  gaze_target_label: '视线目标描述',
  posture: '身体姿态与重心',
  hands_state: '手部状态',
  hands_object_id: '手持道具 ID',
  hands_target_id: '手部接触角色 ID',
  expression: '基础表情',
  expression_detail: '微表情细节',
  appearance_details: '本镜造型细节',
  start_state: '起始状态',
  action_atom: '结构化动作原子',
  action: '动作类型/描述',
  action_detail: '动作细节',
  body_part: '发力部位',
  object_id: '操持道具 ID',
  target_type: '目标类型',
  target_id: '目标对象 ID',
  target_label: '目标描述',
  direction: '动作方向',
  contact: '物理接触部位',
  result_state: '结束状态',
  reaction_trigger: '反应触发事件',
  type: '触发/类型',
  source_id: '触发源 ID',
  source_label: '触发源描述',
  mouth_state: '口型状态',
  shot_number: '分镜序号',
  timestamp: '切镜时刻',
  result: '事件收束结果',
  character_visuals: '首帧角色视觉槽位',
  last_frame_visuals: '尾帧角色视觉槽位',
  character_trajectories: '角色运动轨迹列表',
  speech_action_alignment: '音画动作对齐契约',
  speech_window: '说话时间窗',
  speaker_character_id: '说话人角色 ID',
  speaker_action_window: '说话人动作窗',
  speaker_action: '说话人伴随动作',
  listener_reactions: '听者同步反应',
  action_window: '动作时间窗',
  trajectory_action: '轨迹映射动作',
  pause_reason: '停顿原因',
  start: '开始(秒)',
  end: '结束(秒)',
  shot_type: '景别',
  angle_h: '水平机位',
  angle_v: '俯仰机位',
  angle_s: '画面尺度',
  movement: '运镜方式',
  movement_description: '运镜描述',
  mode: '模式',
  speaker_name: '说话人',
  speaker_in_frame: '说话人在画内',
  delivery_medium: '声音传导方式',
  dialogue_content: '对白内容',
  visible_characters_lip_state: '画内人物口型',
  lip_sync_rule: '口型规则',
  lighting_atmosphere: '光照氛围',
  physical_phenomena: '物理环境交互',
  terminal_event: '收束事件',
  duration: '时长',
  pacing: '节奏',
  beats: '节拍规划',
  visible_characters: '画内主体角色',
  background_characters: '背景人物',
  identity_visibility: '身份可见度',
  wardrobe_id: '造型 ID',
  speech_plan: '语言计划',
  sound_plan: '声音计划',
  continuity_type: '连戏类型',
  h3_mode: 'H3 模式',
  h3_mode_reason: '模式选择依据',
  first_frame_policy: '首帧策略',
  first_frame_reason: '首帧策略依据',
  last_frame_policy: '尾帧策略',
  last_frame_reason: '尾帧策略依据',
  required_references: '必需参考素材',
  audio_lip_sync: '音频与口型契约',
  shot_duration: '分镜时长',
  continuity_snapshot: '连戏快照',
  camera: '摄影机',
  trajectories: '角色轨迹',
  environment_vfx: '环境与特效',
  timing: '时长与节奏',
  shots_timeline: '镜内剪辑时间线',
  h3_multimodal: 'H3 多模态编译数据',
}

function fieldLabel(key) {
  return LABELS[key] || key
}

function isIdKey(key) {
  return NULLABLE_INT_KEYS.has(key)
}

function isNullableIntKey(key) {
  return NULLABLE_INT_KEYS.has(key)
}

function normalizeStringUpdate(key, value) {
  if (key === 'timestamp' && String(value || '').trim() === '') return null
  return value
}

function isContainer(value) {
  return value !== null && typeof value === 'object'
}

function updateObjectKey(key, value) {
  emit('update:modelValue', { ...props.modelValue, [key]: value })
}

function updateArrayIndex(index, value) {
  const next = [...props.modelValue]
  next[index] = value
  emit('update:modelValue', next)
}
</script>

<style scoped>
.slot-tree-editor { width: 100%; display: flex; flex-direction: column; gap: 7px; }
.slot-tree-editor--nested { padding: 8px; border: 1px solid #dbe4ef; border-radius: 6px; background: #f8fafc; }
.slot-tree-row { display: grid; grid-template-columns: minmax(150px, 210px) minmax(0, 1fr); gap: 8px; align-items: start; }
.slot-tree-key { min-height: 28px; display: flex; flex-direction: column; justify-content: center; color: #334155; font-size: 12px; font-weight: 600; }
.slot-tree-key code { color: #94a3b8; font-size: 10px; font-weight: 400; word-break: break-all; }
.slot-tree-array-item { display: grid; grid-template-columns: 34px minmax(0, 1fr); gap: 7px; align-items: start; }
.slot-tree-index { padding-top: 7px; color: #64748b; font-size: 11px; font-weight: 700; }
.slot-tree-empty { padding: 8px; color: #94a3b8; font-size: 12px; border: 1px dashed #cbd5e1; border-radius: 5px; }
</style>
