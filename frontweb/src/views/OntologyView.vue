<template>
  <div class="ontology-view">
    <!-- 顶部导航 -->
    <header class="header">
      <div class="header-inner">
        <h1 class="logo" @click="goHome">
          <span class="logo-main">本地短剧助手</span>
          <span class="logo-sub">LocalMiniDrama</span>
        </h1>
        <span class="breadcrumb-sep">›</span>
        <span class="page-title">影视视听本体架构与配置 (Audiovisual Drama Ontology)</span>
        <div class="header-actions">
          <el-button class="btn-theme" :title="isDark ? '切换到浅色模式' : '切换到暗色模式'" @click="toggleTheme">
            <el-icon><Sunny v-if="isDark" /><Moon v-else /></el-icon>
            {{ isDark ? '浅色' : '暗色' }}
          </el-button>
          <el-button v-if="backRoute" class="btn-back" @click="goBack">
            <el-icon><ArrowLeft /></el-icon>
            {{ backLabel }}
          </el-button>
        </div>
      </div>
    </header>

    <main class="main-container">
      <!-- 顶部全景 Hero 介绍 -->
      <section class="hero-banner">
        <div class="hero-header">
          <div class="hero-titles">
            <div class="hero-tag">
              <el-icon><Connection /></el-icon>
              <span>AUDIOTISUAL DRAMA ONTOLOGY SYSTEM</span>
            </div>
            <h2 class="hero-main-title">影视视听本体与导演智能体工程</h2>
            <p class="hero-desc">
              基于工业级视听三层编译架构（智能体推演 ➔ 本体门禁质检 ➔ 确定性执行编译），以纯结构化实体（ID、枚举、槽位关系）彻底杜绝自由文本猜测、人物偷渡、克隆人与时空穿帮。
            </p>
          </div>
          <div class="hero-stats-grid">
            <div class="stat-card">
              <div class="stat-num">{{ stats.rules_count || 12 }}</div>
              <div class="stat-label">项核心质量门禁</div>
            </div>
            <div class="stat-card">
              <div class="stat-num">3</div>
              <div class="stat-label">层确定性编译管线</div>
            </div>
            <div class="stat-card">
              <div class="stat-num">{{ atomsSummary.actions_count || 24 }}+</div>
              <div class="stat-label">个结构化动作原子</div>
            </div>
            <div class="stat-card">
              <div class="stat-num">100%</div>
              <div class="stat-label">资产白名单校验</div>
            </div>
          </div>
        </div>

        <!-- 三大铁律横幅 -->
        <div class="principles-strip">
          <div v-for="(p, idx) in overview.principles || defaultPrinciples" :key="idx" class="principle-item">
            <div class="principle-badge">铁律 0{{ idx + 1 }}</div>
            <div class="principle-content">
              <div class="principle-title">{{ p.title }}</div>
              <div class="principle-desc">{{ p.description }}</div>
            </div>
          </div>
        </div>
      </section>

      <!-- 主体选项卡 -->
      <el-tabs v-model="activeTab" class="ontology-tabs">
        <!-- Tab 1: 三层架构与导演工作流 -->
        <el-tab-pane label="三层架构与导演工作流" name="architecture">
          <div class="tab-panel">
            <div class="panel-section-title">
              <el-icon><Operation /></el-icon>
              <span>从剧本到 MiniMax H3 视频的确定性编译链路</span>
            </div>
            <p class="panel-subtitle">
              短剧生成不是盲目调用单一大模型生成文本提示词，而是通过多阶段专业智能体推演、本体门禁强校验与确定性编译合成，确保视频与声音的高品质交付。
            </p>

            <div class="pipeline-flow-cards">
              <div v-for="(step, sIdx) in (overview.pipeline || defaultPipeline)" :key="sIdx" class="pipeline-step-card">
                <div class="step-num-badge">STAGE {{ sIdx + 1 }}</div>
                <div class="step-title">{{ step.stage }}</div>
                <div class="step-agent-pill">
                  <el-icon><Cpu /></el-icon>
                  <span>{{ step.agent }}</span>
                </div>
                <div class="step-goal">
                  <strong>核心职责：</strong>{{ step.goal }}
                </div>
                <div class="step-output">
                  <span class="output-label">产出槽位：</span>
                  <code>{{ step.output }}</code>
                </div>
              </div>
            </div>

            <!-- 分镜权威槽位蓝图结构 -->
            <div class="blueprint-section">
              <h3 class="section-title">影视视听分镜核心结构化槽位蓝图 (Audiovisual Slots Blueprint)</h3>
              <div class="blueprint-grid">
                <div class="blueprint-card semantic">
                  <div class="bp-header">
                    <span class="bp-icon">🧠</span>
                    <div>
                      <div class="bp-title">semantic_slots 权威语义槽位</div>
                      <div class="bp-sub">叙事意图、台词口型契约与参考图白名单</div>
                    </div>
                  </div>
                  <ul class="bp-list">
                    <li><code>visible_characters</code>：精确画内出场人物 ID 数组（单镜 ≤ 2 主角）</li>
                    <li><code>offscreen_characters</code>：画外参与角色（显式声明 present_offscreen / remote_voice）</li>
                    <li><code>speech_plan</code>：台词/旁白说话人、TTS 速率、情感与时长预算</li>
                    <li><code>sound_plan</code>：环境音、动作音效、BGM 提示词与静音互斥规则</li>
                    <li><code>required_references</code>：H3 参考图有序合同（场景 ➔ 角色 ➔ 道具）</li>
                    <li><code>continuity_from_previous</code>：上一镜收束与本镜接入的因果视听桥接</li>
                  </ul>
                </div>

                <div class="blueprint-card visual">
                  <div class="bp-header">
                    <span class="bp-icon">👁️</span>
                    <div>
                      <div class="bp-title">character_visuals 3D 角色定格视觉</div>
                      <div class="bp-sub">生图首帧构图、空间轴线与微表情微姿态</div>
                    </div>
                  </div>
                  <ul class="bp-list">
                    <li><code>depth_layer</code>：景深层级（foreground / midground / background / extreme_bg）</li>
                    <li><code>screen_position</code>：屏幕九宫格站位坐标，严禁多角色重叠坐标</li>
                    <li><code>facing</code>：朝向轴线（toward_camera / toward_target / profile / back）</li>
                    <li><code>gaze_type</code>：视线锚点（camera / target_character / object / offscreen）</li>
                    <li><code>posture</code> & <code>hands_state</code>：角色躯干姿态与双手交互道具状态</li>
                    <li><code>expression</code>：结合剧情情绪的微表情与口唇状态</li>
                  </ul>
                </div>

                <div class="blueprint-card video">
                  <div class="bp-header">
                    <span class="bp-icon">🎬</span>
                    <div>
                      <div class="bp-title">video_slots 动态轨迹与因果节拍</div>
                      <div class="bp-sub">Structured Sync 物理动作原子与时间轴切镜</div>
                    </div>
                  </div>
                  <ul class="bp-list">
                    <li><code>performance_contract</code>：固定为 structured_sync，统一结构化动作标准</li>
                    <li><code>trajectories</code>：画内各角色物理动作轨迹与事件触发反应</li>
                    <li><code>action_atom</code>：动作原子三元组（动作类型 + 身体部位 + 目标实体）</li>
                    <li><code>audio_lip_sync</code>：口型同步模式（speaker_synced / offscreen_voiceover 等）</li>
                    <li><code>shots_timeline</code>：动作因果节拍与时间轴细分（每段时长累加严格等于总时长）</li>
                    <li><code>environment_vfx</code>：物理现象（风沙、光照变幻、终端收束事件）</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </el-tab-pane>

        <!-- Tab 2: 12 项本体质量门禁 -->
        <el-tab-pane label="12 项视听本体门禁规则" name="rules">
          <div class="tab-panel">
            <div class="rules-toolbar">
              <div class="rules-filter-group">
                <span class="filter-label">门禁分类：</span>
                <el-radio-group v-model="selectedRuleCategory" size="small">
                  <el-radio-button label="全部" />
                  <el-radio-button label="资产与物理规律" />
                  <el-radio-button label="视听合同与语义" />
                  <el-radio-button label="画面构图与视觉定格" />
                  <el-radio-button label="动态轨迹与动作原子" />
                  <el-radio-button label="模型容量与防克隆人" />
                  <el-radio-button label="时空连续性" />
                </el-radio-group>
              </div>
              <div class="rules-search">
                <el-input v-model="ruleKeyword" placeholder="搜索规则名称、ID或字段..." clearable size="small" style="width: 240px">
                  <template #prefix><el-icon><Search /></el-icon></template>
                </el-input>
              </div>
            </div>

            <div class="rules-grid">
              <div
                v-for="rule in filteredRules"
                :key="rule.id"
                class="rule-card"
                :class="rule.severity === 'warning' ? 'rule-warning' : 'rule-error'"
              >
                <div class="rule-card-header">
                  <div class="rule-id-line">
                    <span class="rule-id-text">{{ rule.id }}</span>
                    <el-tag :type="rule.severity === 'warning' ? 'warning' : 'danger'" size="small" effect="dark">
                      {{ rule.severity === 'warning' ? 'WARNING 警告' : 'ERROR 阻断拦截' }}
                    </el-tag>
                  </div>
                  <h4 class="rule-name">{{ rule.name }}</h4>
                  <el-tag type="info" size="small" class="category-tag">{{ rule.category }}</el-tag>
                </div>

                <div class="rule-body">
                  <p class="rule-desc">{{ rule.description }}</p>
                  <div class="rule-prevention">
                    <span class="prevention-label">拦截防范：</span>
                    <span class="prevention-text">{{ rule.prevention }}</span>
                  </div>
                </div>

                <div class="rule-footer">
                  <span class="fields-label">受检字段：</span>
                  <div class="fields-tags">
                    <el-tag v-for="f in (rule.target_fields || [])" :key="f" size="small" class="field-tag">
                      {{ f }}
                    </el-tag>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </el-tab-pane>

        <!-- Tab 3: 视听数据字典与动作原子 -->
        <el-tab-pane label="视听数据字典与动作原子" name="dictionary">
          <div class="tab-panel">
            <div class="dictionary-grid">
              <!-- 动作原子规范 -->
              <div class="dict-card">
                <div class="dict-header">
                  <span class="dict-title">动作原子 (Structured Action Atoms)</span>
                  <el-tag size="small" type="primary">structured_sync</el-tag>
                </div>
                <p class="dict-desc">将自由动作文本转化为可拍摄的物理原子组合，支持因果动作链条与时间轴对齐。</p>
                <div class="dict-content">
                  <div class="dict-block">
                    <span class="block-title">动作类型 (actions 库示例)：</span>
                    <div class="atom-chips">
                      <span v-for="a in (atomsSummary.actions_sample || defaultActions)" :key="a" class="atom-chip">{{ a }}</span>
                    </div>
                  </div>
                  <div class="dict-block">
                    <span class="block-title">核心维度枚举：</span>
                    <div class="meta-pills">
                      <el-tag size="small">身体部位: {{ atomsSummary.body_parts_count || 12 }} 种</el-tag>
                      <el-tag size="small">目标类型: {{ atomsSummary.target_types_count || 6 }} 种</el-tag>
                      <el-tag size="small">朝向方位: {{ atomsSummary.directions_count || 8 }} 种</el-tag>
                      <el-tag size="small">接触面: {{ atomsSummary.contacts_count || 6 }} 种</el-tag>
                    </div>
                  </div>
                </div>
              </div>

              <!-- 景别与机位运镜 -->
              <div class="dict-card">
                <div class="dict-header">
                  <span class="dict-title">机位运镜与 3D 空间</span>
                  <el-tag size="small" type="success">11 种运镜 / 8 方位</el-tag>
                </div>
                <p class="dict-desc">镜头类型与运动规范，动态镜头优先，保证叙事呼吸感与空间纵深感。</p>
                <div class="dict-content">
                  <div class="dict-block">
                    <span class="block-title">常用运镜枚举：</span>
                    <div class="atom-chips">
                      <span class="atom-chip">push (推镜)</span>
                      <span class="atom-chip">pull (拉镜)</span>
                      <span class="atom-chip">pan (横摇)</span>
                      <span class="atom-chip">tilt (纵摇)</span>
                      <span class="atom-chip">tracking (跟镜)</span>
                      <span class="atom-chip">handheld (手持呼吸)</span>
                      <span class="atom-chip">crane_up (升镜)</span>
                      <span class="atom-chip">static (固定)</span>
                    </div>
                  </div>
                  <div class="dict-block">
                    <span class="block-title">景别层级：</span>
                    <div class="meta-pills">
                      <el-tag size="small">大远景</el-tag>
                      <el-tag size="small">远景</el-tag>
                      <el-tag size="small">全景</el-tag>
                      <el-tag size="small">中景</el-tag>
                      <el-tag size="small">近景</el-tag>
                      <el-tag size="small">特写</el-tag>
                    </div>
                  </div>
                </div>
              </div>

              <!-- 构图与视觉姿态 -->
              <div class="dict-card">
                <div class="dict-header">
                  <span class="dict-title">3D 视觉定格与视线</span>
                  <el-tag size="small" type="warning">防克隆人与防重叠</el-tag>
                </div>
                <p class="dict-desc">用于精准控制生图首帧的角色三维坐标与面部视线，避免多人站位重叠穿帮。</p>
                <div class="dict-content">
                  <div class="dict-block">
                    <span class="block-title">景深层级 (depth_layer)：</span>
                    <div class="meta-pills">
                      <el-tag size="small">foreground 前景</el-tag>
                      <el-tag size="small">midground 中景核心区</el-tag>
                      <el-tag size="small">background 背景环境</el-tag>
                    </div>
                  </div>
                  <div class="dict-block">
                    <span class="block-title">视线模式 (gaze_type)：</span>
                    <div class="atom-chips">
                      <span class="atom-chip">camera 直视镜头</span>
                      <span class="atom-chip">target_character 注目戏中角色</span>
                      <span class="atom-chip">object 凝视交互道具</span>
                      <span class="atom-chip">offscreen 看向画外方位</span>
                    </div>
                  </div>
                </div>
              </div>

              <!-- 声音方案与口型契约 -->
              <div class="dict-card">
                <div class="dict-header">
                  <span class="dict-title">口型同步与声音合同</span>
                  <el-tag size="small" type="danger">声音方案互斥</el-tag>
                </div>
                <p class="dict-desc">明确区分画内说话人与画外配音，防止画外音导致画内非发言演员口型张合。</p>
                <div class="dict-content">
                  <div class="dict-block">
                    <span class="block-title">口型模式 (audio_lip_sync)：</span>
                    <div class="atom-chips">
                      <span class="atom-chip">speaker_synced (画内发言同步)</span>
                      <span class="atom-chip">offscreen_voiceover (画外音画内闭口)</span>
                      <span class="atom-chip">narrator (旁白配音)</span>
                      <span class="atom-chip">silent (纯动作静音)</span>
                    </div>
                  </div>
                  <div class="dict-block">
                    <span class="block-title">画外参与方式：</span>
                    <div class="meta-pills">
                      <el-tag size="small">present_offscreen (身在现场但不入画)</el-tag>
                      <el-tag size="small">remote_voice (远端无线电/电话对讲)</el-tag>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </el-tab-pane>

        <!-- Tab 4: 剧目实时透视与门禁体检 -->
        <el-tab-pane label="剧目实时透视与门禁体检" name="inspector">
          <div class="tab-panel">
            <!-- 剧目与集数选择栏 -->
            <div class="inspector-select-bar">
              <div class="select-field">
                <span class="label">选择剧目：</span>
                <el-select v-model="inspectDramaId" placeholder="选择剧目" filterable style="width: 240px" @change="onDramaChange">
                  <el-option v-for="d in dramaList" :key="d.id" :label="d.title || ('剧目 ID ' + d.id)" :value="d.id" />
                </el-select>
              </div>

              <div class="select-field">
                <span class="label">选择单集：</span>
                <el-select v-model="inspectEpisodeId" placeholder="选择单集" filterable style="width: 200px" @change="loadSemanticPackage">
                  <el-option v-for="ep in episodeList" :key="ep.id" :label="ep.title || ('第 ' + ep.episode_number + ' 集')" :value="ep.id" />
                </el-select>
              </div>

              <el-button type="primary" :loading="validating" :disabled="!inspectEpisodeId" @click="runEpisodeValidation">
                <el-icon><CircleCheckFilled /></el-icon>
                一键运行视听本体门禁体检
              </el-button>

              <el-button plain :loading="pkgLoading" :disabled="!inspectEpisodeId" @click="loadSemanticPackage">
                <el-icon><Refresh /></el-icon>
                刷新语义包
              </el-button>
            </div>

            <!-- 语义包摘要卡片 -->
            <div v-if="semanticPackage" class="semantic-package-card">
              <div class="pkg-header">
                <div class="pkg-title-area">
                  <span class="pkg-badge">DramaSemanticPackage 不可变语义包</span>
                  <span class="pkg-rev">{{ semanticPackage.semantic_revision }}</span>
                </div>
                <div class="pkg-era-pill">
                  时代判定：<strong>{{ eraLabels[semanticPackage.drama?.era] || semanticPackage.drama?.era || '写实现代' }}</strong>
                </div>
              </div>

              <div class="pkg-catalogs-grid">
                <div class="pkg-cat-card">
                  <div class="cat-header">
                    <span>角色资产 ({{ semanticPackage.catalogs?.characters?.length || 0 }})</span>
                  </div>
                  <div class="cat-content">
                    <span v-for="c in (semanticPackage.catalogs?.characters || [])" :key="c.id" class="cat-pill">
                      {{ c.name }} <small>(ID:{{ c.id }})</small>
                    </span>
                    <span v-if="!(semanticPackage.catalogs?.characters || []).length" class="empty-hint">暂无角色</span>
                  </div>
                </div>

                <div class="pkg-cat-card">
                  <div class="cat-header">
                    <span>场景空间 ({{ semanticPackage.catalogs?.scenes?.length || 0 }})</span>
                  </div>
                  <div class="cat-content">
                    <span v-for="s in (semanticPackage.catalogs?.scenes || [])" :key="s.id" class="cat-pill">
                      {{ s.location || s.name }} <small>(ID:{{ s.id }})</small>
                    </span>
                    <span v-if="!(semanticPackage.catalogs?.scenes || []).length" class="empty-hint">暂无场景</span>
                  </div>
                </div>

                <div class="pkg-cat-card">
                  <div class="cat-header">
                    <span>物理道具 ({{ semanticPackage.catalogs?.props?.length || 0 }})</span>
                  </div>
                  <div class="cat-content">
                    <span v-for="p in (semanticPackage.catalogs?.props || [])" :key="p.id" class="cat-pill">
                      {{ p.name }} <small>(ID:{{ p.id }})</small>
                    </span>
                    <span v-if="!(semanticPackage.catalogs?.props || []).length" class="empty-hint">暂无道具</span>
                  </div>
                </div>
              </div>
            </div>

            <!-- 门禁体检结果展示 -->
            <div v-if="auditResult" class="audit-result-panel">
              <div class="audit-summary-box" :class="auditResult.valid ? 'audit-pass' : 'audit-fail'">
                <div class="audit-icon">
                  <el-icon v-if="auditResult.valid"><CircleCheckFilled /></el-icon>
                  <el-icon v-else><WarningFilled /></el-icon>
                </div>
                <div class="audit-info">
                  <h3 class="audit-headline">
                    {{ auditResult.valid ? '视听本体质量门禁全量通过（100% 合规）' : '检测到视听本体门禁不变量违规' }}
                  </h3>
                  <p class="audit-stats-line">
                    总分镜数：<strong>{{ auditResult.total_shots }}</strong> |
                    违规违约项：<strong>{{ (auditResult.violations || []).length }}</strong> |
                    门禁判定依据：纯结构化字段（ID/枚举/槽位）
                  </p>
                </div>
              </div>

              <!-- 违规详情列表 -->
              <div v-if="(auditResult.violations || []).length" class="violations-list">
                <h4 class="v-list-title">门禁拦截详情（需 Agent 局部自纠）：</h4>
                <div v-for="(v, vIdx) in auditResult.violations" :key="vIdx" class="violation-item">
                  <div class="v-badge">
                    <span class="shot-tag">分镜 {{ v.shot_number || '全局' }}</span>
                    <el-tag :type="v.severity === 'warning' ? 'warning' : 'danger'" size="small">
                      {{ v.rule || 'INVARIANT_RULE' }}
                    </el-tag>
                  </div>
                  <div class="v-message">{{ v.message }}</div>
                  <div v-if="v.conflict_slots?.length" class="v-conflicts">
                    <span class="v-conflict-label">冲突槽位：</span>
                    <el-tag v-for="cs in v.conflict_slots" :key="cs" size="small" type="info">{{ cs }}</el-tag>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </el-tab-pane>
      </el-tabs>
    </main>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  ArrowLeft,
  Sunny,
  Moon,
  Connection,
  Operation,
  Cpu,
  Search,
  CircleCheckFilled,
  WarningFilled,
  Refresh,
} from '@element-plus/icons-vue'
import { useTheme } from '@/composables/useTheme'
import { ontologyAPI } from '@/api/ontology'
import { dramaAPI } from '@/api/drama'

const route = useRoute()
const router = useRouter()
const { isDark, toggleTheme } = useTheme()

const activeTab = ref('architecture')
const selectedRuleCategory = ref('全部')
const ruleKeyword = ref('')

const overview = ref({})
const rulesList = ref([])
const stats = ref({})
const atomsSummary = ref({})

// 剧目透视数据
const dramaList = ref([])
const inspectDramaId = ref(null)
const episodeList = ref([])
const inspectEpisodeId = ref(null)
const semanticPackage = ref(null)
const pkgLoading = ref(false)
const validating = ref(false)
const auditResult = ref(null)

const eraLabels = {
  modern: '写实现代',
  ancient: '古装古典',
  republic_china: '民国时期',
  sci_fi: '科幻未来',
}

const defaultPrinciples = [
  {
    title: '门禁只认结构化语义',
    description: '本体门禁与不变量判定依据必须是结构化字段（ID、枚举、槽位关系），坚决禁止文本正则推断事实；语义事实由 Agent 显式声明，门禁只校验一致性。',
  },
  {
    title: '平台代码零内容',
    description: '通用短剧平台坚决禁止在代码与规则规范中硬编码任何剧目的剧情、角色名、道具名与题材设定；一切内容完全来源于剧目语义包与目录数据。',
  },
  {
    title: '三层视听编译管线',
    description: '严格遵循「智能体推演层 ➔ 本体门禁质检层 ➔ 执行确定性编译层」三层架构，不合规数据在门禁层立即被打回自修，绝不污染下游渲染。',
  },
]

const defaultPipeline = [
  {
    stage: 'Stage 1: 基础剧情分镜划分',
    agent: '短剧基础导演 Agent',
    goal: '确保剧本台词与情节逐字覆盖，单说话人单轮对白拆分，物理动作拍摄规划，TTS 速率时长预算。',
    output: 'shot_number, title, scene_id, characters, props, duration, dialogue, narration, action',
  },
  {
    stage: 'Stage 2: 视听槽位扩充与闭环审校',
    agent: '导演执行合同 Agent',
    goal: '推导 3D 视觉定格、因果动作原子、口型同步模式、声音方案、转场桥接与 H3 参考图合约。',
    output: 'semantic_slots, character_visuals, video_slots, last_frame_visuals',
  },
  {
    stage: 'Stage 3: 视听本体质量门禁硬拦截',
    agent: 'SHACL Invariant Rule Engine',
    goal: '运行 12 大不可变规则校验，发现违规立即触发 Agent 局部反射自纠，确保进入渲染层的数据百分之百合规。',
    output: 'Audited & Validated Contract (Zero Violations)',
  },
  {
    stage: 'Stage 4: 确定性执行编译与渲染',
    agent: 'H3 Compiler & Multi-Modal Engine',
    goal: '依据结构化槽位与资产参考图，确定性编译为 H3 提示词（Ref2VA / FL2VA）、IndexTTS 语音流与视频剪辑工程。',
    output: 'MiniMax H3 Video / TTS Audio / Subtitles',
  },
]

const defaultActions = [
  'raise_tablet_and_present',
  'turn_around',
  'take_step',
  'point_at',
  'nod',
  'shake_head',
  'wave_hand',
  'grasp_object',
]

const backRoute = computed(() => {
  if (route.query.dramaId) {
    return `/film/${route.query.dramaId}`
  }
  return '/'
})

const backLabel = computed(() => {
  if (route.query.dramaId) return '返回短剧创作'
  return '返回项目列表'
})

const filteredRules = computed(() => {
  let list = rulesList.value || []
  if (selectedRuleCategory.value && selectedRuleCategory.value !== '全部') {
    list = list.filter((r) => r.category === selectedRuleCategory.value)
  }
  if (ruleKeyword.value && ruleKeyword.value.trim()) {
    const kw = ruleKeyword.value.trim().toLowerCase()
    list = list.filter((r) => {
      return (
        (r.id || '').toLowerCase().includes(kw) ||
        (r.name || '').toLowerCase().includes(kw) ||
        (r.description || '').toLowerCase().includes(kw) ||
        (r.prevention || '').toLowerCase().includes(kw) ||
        (r.target_fields || []).some((f) => f.toLowerCase().includes(kw))
      )
    })
  }
  return list
})

function goHome() {
  router.push('/')
}

function goBack() {
  if (backRoute.value) {
    router.push(backRoute.value)
  } else {
    router.push('/')
  }
}

async function loadOverview() {
  try {
    const res = await ontologyAPI.getOverview()
    if (res?.data) {
      overview.value = res.data
      stats.value = res.data.stats || {}
      atomsSummary.value = res.data.action_atoms || {}
    }
  } catch (e) {
    console.warn('[ontology] loadOverview failed', e)
  }
}

async function loadRules() {
  try {
    const res = await ontologyAPI.getRules()
    if (Array.isArray(res?.data)) {
      rulesList.value = res.data
    }
  } catch (e) {
    console.warn('[ontology] loadRules failed', e)
  }
}

async function loadDramas() {
  try {
    const res = await dramaAPI.list()
    if (Array.isArray(res?.data)) {
      dramaList.value = res.data
      if (route.query.dramaId) {
        inspectDramaId.value = Number(route.query.dramaId)
        await onDramaChange(inspectDramaId.value)
      } else if (dramaList.value.length > 0) {
        inspectDramaId.value = dramaList.value[0].id
        await onDramaChange(inspectDramaId.value)
      }
    }
  } catch (e) {
    console.warn('[ontology] loadDramas failed', e)
  }
}

async function onDramaChange(dramaId) {
  episodeList.value = []
  inspectEpisodeId.value = null
  semanticPackage.value = null
  auditResult.value = null
  if (!dramaId) return
  try {
    const res = await dramaAPI.get(dramaId)
    const episodes = res?.data?.episodes || []
    episodeList.value = episodes
    if (route.query.episodeId) {
      const match = episodes.find((e) => Number(e.id) === Number(route.query.episodeId))
      if (match) inspectEpisodeId.value = match.id
    }
    if (!inspectEpisodeId.value && episodes.length > 0) {
      inspectEpisodeId.value = episodes[0].id
    }
    if (inspectEpisodeId.value) {
      await loadSemanticPackage()
    }
  } catch (e) {
    console.warn('[ontology] onDramaChange failed', e)
  }
}

async function loadSemanticPackage() {
  if (!inspectEpisodeId.value) return
  pkgLoading.value = true
  try {
    const res = await ontologyAPI.getSemanticPackage(inspectEpisodeId.value)
    semanticPackage.value = res?.data || null
  } catch (e) {
    ElMessage.error('获取语义包失败：' + (e.message || '未知错误'))
  } finally {
    pkgLoading.value = false
  }
}

async function runEpisodeValidation() {
  if (!inspectEpisodeId.value) return
  validating.value = true
  auditResult.value = null
  try {
    const res = await ontologyAPI.validateInvariants(inspectEpisodeId.value)
    const payload = res?.data || {}
    const audit = payload.audit || payload
    auditResult.value = {
      ...audit,
      total_shots: payload.total_shots ?? audit.total_shots ?? 0,
      semantic_revision: payload.semantic_revision
    }
    if (auditResult.value.valid) {
      ElMessage.success('全集视听本体质量门禁检测通过，合规率 100%！')
    } else {
      ElMessage.warning(`检测到 ${(auditResult.value.violations || []).length} 项不变量违规`)
    }
  } catch (e) {
    ElMessage.error('门禁体检失败：' + (e.message || '未知错误'))
  } finally {
    validating.value = false
  }
}

onMounted(() => {
  loadOverview()
  loadRules()
  loadDramas()
})
</script>

<style scoped>
.ontology-view {
  min-height: 100vh;
  background: #121319;
  background-image:
    radial-gradient(ellipse 80% 50% at 50% -10%, rgba(99, 102, 241, 0.16) 0%, transparent 60%),
    radial-gradient(ellipse 60% 40% at 90% 40%, rgba(139, 92, 246, 0.08) 0%, transparent 50%),
    linear-gradient(180deg, #121319 0%, #161722 50%, #1a1c2a 100%);
  color: #e4e4e7;
}
html.light .ontology-view {
  background: #f8f9fc;
  background-image:
    radial-gradient(ellipse 80% 50% at 50% -10%, rgba(99, 102, 241, 0.08) 0%, transparent 60%),
    linear-gradient(180deg, #f8f9fc 0%, #f1f3f9 100%);
  color: #1e1b4b;
}

.header {
  background: rgba(18, 19, 25, 0.85);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  padding: 12px 32px;
  position: sticky;
  top: 0;
  z-index: 100;
}
html.light .header {
  background: rgba(255, 255, 255, 0.88);
  border-bottom-color: rgba(99, 102, 241, 0.12);
}
.header-inner {
  display: flex;
  align-items: center;
  gap: 16px;
  max-width: 1400px;
  margin: 0 auto;
}
.logo {
  cursor: pointer;
  display: flex;
  flex-direction: column;
  line-height: 1;
}
.logo-main {
  font-size: 1.1rem;
  font-weight: 700;
  background: linear-gradient(135deg, #a5b4fc, #818cf8);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}
.logo-sub {
  font-size: 0.65rem;
  color: #71717a;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.breadcrumb-sep {
  color: #52525b;
}
.page-title {
  font-size: 0.95rem;
  font-weight: 600;
  color: #cbd5e1;
}
html.light .page-title {
  color: #334155;
}
.header-actions {
  margin-left: auto;
  display: flex;
  gap: 10px;
}
.btn-back {
  --el-button-bg-color: rgba(99, 102, 241, 0.12);
  --el-button-border-color: rgba(99, 102, 241, 0.35);
  --el-button-text-color: #a5b4fc;
}

.main-container {
  max-width: 1400px;
  margin: 0 auto;
  padding: 24px 32px 64px;
}

/* Hero Banner */
.hero-banner {
  background: rgba(25, 27, 38, 0.65);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 14px;
  padding: 28px 32px;
  margin-bottom: 24px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
}
html.light .hero-banner {
  background: #ffffff;
  border-color: rgba(99, 102, 241, 0.15);
  box-shadow: 0 4px 20px rgba(99, 102, 241, 0.06);
}
.hero-header {
  display: flex;
  gap: 32px;
  align-items: flex-start;
  margin-bottom: 24px;
}
.hero-titles {
  flex: 1;
}
.hero-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.75rem;
  font-weight: 600;
  color: #818cf8;
  background: rgba(99, 102, 241, 0.12);
  border: 1px solid rgba(99, 102, 241, 0.25);
  border-radius: 20px;
  padding: 3px 10px;
  margin-bottom: 10px;
}
.hero-main-title {
  font-size: 1.6rem;
  font-weight: 700;
  margin: 0 0 10px;
  color: #f1f5f9;
}
html.light .hero-main-title {
  color: #0f172a;
}
.hero-desc {
  font-size: 0.92rem;
  line-height: 1.6;
  color: #94a3b8;
  margin: 0;
}
.hero-stats-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
  min-width: 280px;
}
.stat-card {
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 10px;
  padding: 12px 16px;
  text-align: center;
}
html.light .stat-card {
  background: #f8fafc;
  border-color: #e2e8f0;
}
.stat-num {
  font-size: 1.5rem;
  font-weight: 700;
  color: #a5b4fc;
}
html.light .stat-num {
  color: #4f46e5;
}
.stat-label {
  font-size: 0.75rem;
  color: #94a3b8;
  margin-top: 2px;
}

/* 铁律横幅 */
.principles-strip {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  padding-top: 20px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}
html.light .principles-strip {
  border-top-color: #f1f5f9;
}
.principle-item {
  display: flex;
  gap: 12px;
}
.principle-badge {
  flex-shrink: 0;
  font-size: 0.7rem;
  font-weight: 700;
  background: rgba(99, 102, 241, 0.15);
  color: #a5b4fc;
  border-radius: 6px;
  padding: 3px 8px;
  height: fit-content;
}
.principle-title {
  font-size: 0.9rem;
  font-weight: 600;
  color: #e2e8f0;
  margin-bottom: 4px;
}
html.light .principle-title {
  color: #1e293b;
}
.principle-desc {
  font-size: 0.8rem;
  line-height: 1.5;
  color: #94a3b8;
}

/* Tabs */
.ontology-tabs {
  background: transparent;
}
:deep(.el-tabs__nav-wrap::after) {
  background-color: rgba(255, 255, 255, 0.08);
}
html.light :deep(.el-tabs__nav-wrap::after) {
  background-color: #e2e8f0;
}
:deep(.el-tabs__item) {
  font-size: 0.98rem;
  font-weight: 600;
  color: #94a3b8;
}
:deep(.el-tabs__item.is-active) {
  color: #818cf8;
}

.tab-panel {
  padding: 16px 0;
}
.panel-section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 1.15rem;
  font-weight: 700;
  color: #f8fafc;
  margin-bottom: 6px;
}
html.light .panel-section-title {
  color: #0f172a;
}
.panel-subtitle {
  font-size: 0.88rem;
  color: #94a3b8;
  margin: 0 0 20px;
}

/* Pipeline Cards */
.pipeline-flow-cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  margin-bottom: 32px;
}
.pipeline-step-card {
  background: rgba(30, 32, 45, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  position: relative;
}
html.light .pipeline-step-card {
  background: #ffffff;
  border-color: #e2e8f0;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.03);
}
.step-num-badge {
  font-size: 0.7rem;
  font-weight: 700;
  color: #818cf8;
  letter-spacing: 0.06em;
}
.step-title {
  font-size: 1.02rem;
  font-weight: 700;
  color: #f1f5f9;
}
html.light .step-title {
  color: #0f172a;
}
.step-agent-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: rgba(99, 102, 241, 0.1);
  color: #c7d2fe;
  font-size: 0.78rem;
  padding: 3px 8px;
  border-radius: 6px;
  width: fit-content;
}
html.light .step-agent-pill {
  color: #4338ca;
}
.step-goal {
  font-size: 0.82rem;
  line-height: 1.5;
  color: #cbd5e1;
  flex: 1;
}
html.light .step-goal {
  color: #475569;
}
.step-output {
  border-top: 1px dashed rgba(255, 255, 255, 0.08);
  padding-top: 10px;
  font-size: 0.78rem;
}
html.light .step-output {
  border-top-color: #f1f5f9;
}
.output-label {
  color: #94a3b8;
  margin-right: 4px;
}
.step-output code {
  color: #a5b4fc;
  font-family: monospace;
  word-break: break-all;
}
html.light .step-output code {
  color: #4f46e5;
}

/* Blueprint Section */
.blueprint-section {
  margin-top: 32px;
}
.section-title {
  font-size: 1.1rem;
  font-weight: 700;
  margin: 0 0 16px;
  color: #e2e8f0;
}
html.light .section-title {
  color: #1e293b;
}
.blueprint-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 20px;
}
.blueprint-card {
  background: rgba(28, 30, 42, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  padding: 20px;
}
html.light .blueprint-card {
  background: #ffffff;
  border-color: #e2e8f0;
}
.bp-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
html.light .bp-header {
  border-bottom-color: #f1f5f9;
}
.bp-icon {
  font-size: 1.6rem;
}
.bp-title {
  font-size: 0.95rem;
  font-weight: 700;
  color: #f1f5f9;
}
html.light .bp-title {
  color: #0f172a;
}
.bp-sub {
  font-size: 0.78rem;
  color: #94a3b8;
}
.bp-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 0.82rem;
  color: #cbd5e1;
  line-height: 1.5;
}
html.light .bp-list {
  color: #334155;
}
.bp-list code {
  color: #818cf8;
  font-weight: 600;
  background: rgba(99, 102, 241, 0.1);
  padding: 1px 4px;
  border-radius: 4px;
}

/* Rules Grid */
.rules-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
  flex-wrap: wrap;
  gap: 12px;
}
.rules-filter-group {
  display: flex;
  align-items: center;
  gap: 8px;
}
.filter-label {
  font-size: 0.82rem;
  color: #94a3b8;
}
.rules-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 18px;
}
.rule-card {
  background: rgba(28, 30, 42, 0.65);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  transition: transform 0.2s, box-shadow 0.2s;
}
html.light .rule-card {
  background: #ffffff;
  border-color: #e2e8f0;
}
.rule-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
}
.rule-error {
  border-left: 4px solid #ef4444;
}
.rule-warning {
  border-left: 4px solid #f59e0b;
}
.rule-card-header {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.rule-id-line {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.rule-id-text {
  font-size: 0.72rem;
  font-family: monospace;
  color: #818cf8;
}
.rule-name {
  font-size: 1.05rem;
  font-weight: 700;
  color: #f1f5f9;
  margin: 2px 0 0;
}
html.light .rule-name {
  color: #0f172a;
}
.category-tag {
  width: fit-content;
}
.rule-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.rule-desc {
  font-size: 0.84rem;
  line-height: 1.5;
  color: #cbd5e1;
  margin: 0;
}
html.light .rule-desc {
  color: #475569;
}
.rule-prevention {
  background: rgba(255, 255, 255, 0.03);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 0.8rem;
  line-height: 1.4;
}
html.light .rule-prevention {
  background: #f8fafc;
}
.prevention-label {
  font-weight: 600;
  color: #f87171;
}
.prevention-text {
  color: #94a3b8;
}
.rule-footer {
  border-top: 1px dashed rgba(255, 255, 255, 0.08);
  padding-top: 10px;
}
html.light .rule-footer {
  border-top-color: #f1f5f9;
}
.fields-label {
  font-size: 0.72rem;
  color: #71717a;
  display: block;
  margin-bottom: 4px;
}
.fields-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.field-tag {
  font-size: 0.7rem;
  background: rgba(255, 255, 255, 0.05);
  border-color: rgba(255, 255, 255, 0.08);
  color: #cbd5e1;
}
html.light .field-tag {
  background: #f1f5f9;
  border-color: #e2e8f0;
  color: #475569;
}

/* Dictionary Grid */
.dictionary-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 20px;
}
.dict-card {
  background: rgba(28, 30, 42, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  padding: 22px;
}
html.light .dict-card {
  background: #ffffff;
  border-color: #e2e8f0;
}
.dict-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}
.dict-title {
  font-size: 1.05rem;
  font-weight: 700;
  color: #f1f5f9;
}
html.light .dict-title {
  color: #0f172a;
}
.dict-desc {
  font-size: 0.84rem;
  color: #94a3b8;
  margin: 0 0 16px;
}
.dict-content {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.dict-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.block-title {
  font-size: 0.78rem;
  font-weight: 600;
  color: #a5b4fc;
}
.atom-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.atom-chip {
  font-size: 0.75rem;
  font-family: monospace;
  background: rgba(99, 102, 241, 0.1);
  border: 1px solid rgba(99, 102, 241, 0.2);
  color: #cbd5e1;
  padding: 2px 8px;
  border-radius: 6px;
}
html.light .atom-chip {
  background: #f1f5f9;
  border-color: #e2e8f0;
  color: #334155;
}
.meta-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* Inspector */
.inspector-select-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  background: rgba(28, 30, 42, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  padding: 14px 20px;
  margin-bottom: 24px;
  flex-wrap: wrap;
}
html.light .inspector-select-bar {
  background: #ffffff;
  border-color: #e2e8f0;
}
.select-field {
  display: flex;
  align-items: center;
  gap: 8px;
}
.select-field .label {
  font-size: 0.86rem;
  color: #94a3b8;
  white-space: nowrap;
}

.semantic-package-card {
  background: rgba(28, 30, 42, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 24px;
}
html.light .semantic-package-card {
  background: #ffffff;
  border-color: #e2e8f0;
}
.pkg-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
html.light .pkg-header {
  border-bottom-color: #f1f5f9;
}
.pkg-badge {
  font-size: 0.95rem;
  font-weight: 700;
  color: #f1f5f9;
  margin-right: 12px;
}
html.light .pkg-badge {
  color: #0f172a;
}
.pkg-rev {
  font-size: 0.8rem;
  font-family: monospace;
  color: #818cf8;
  background: rgba(99, 102, 241, 0.1);
  padding: 2px 8px;
  border-radius: 4px;
}
.pkg-era-pill {
  font-size: 0.85rem;
  color: #cbd5e1;
}
.pkg-catalogs-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}
.pkg-cat-card {
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: 8px;
  padding: 12px;
}
html.light .pkg-cat-card {
  background: #f8fafc;
  border-color: #e2e8f0;
}
.cat-header {
  font-size: 0.82rem;
  font-weight: 600;
  color: #94a3b8;
  margin-bottom: 8px;
}
.cat-content {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.cat-pill {
  font-size: 0.78rem;
  background: rgba(99, 102, 241, 0.1);
  color: #e2e8f0;
  border-radius: 4px;
  padding: 2px 6px;
}
html.light .cat-pill {
  background: #ede9fe;
  color: #4338ca;
}
.cat-pill small {
  color: #818cf8;
}
.empty-hint {
  font-size: 0.78rem;
  color: #71717a;
}

/* Audit Result */
.audit-result-panel {
  margin-top: 16px;
}
.audit-summary-box {
  display: flex;
  align-items: center;
  gap: 16px;
  border-radius: 12px;
  padding: 20px 24px;
  margin-bottom: 20px;
}
.audit-pass {
  background: rgba(34, 197, 94, 0.1);
  border: 1px solid rgba(34, 197, 94, 0.3);
}
.audit-fail {
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
}
.audit-icon {
  font-size: 2.4rem;
}
.audit-pass .audit-icon {
  color: #22c55e;
}
.audit-fail .audit-icon {
  color: #ef4444;
}
.audit-headline {
  font-size: 1.15rem;
  font-weight: 700;
  margin: 0 0 6px;
  color: #f1f5f9;
}
html.light .audit-headline {
  color: #0f172a;
}
.audit-stats-line {
  font-size: 0.88rem;
  color: #94a3b8;
  margin: 0;
}
.v-list-title {
  font-size: 0.95rem;
  font-weight: 700;
  color: #f87171;
  margin: 0 0 12px;
}
.violations-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.violation-item {
  background: rgba(239, 68, 68, 0.05);
  border: 1px solid rgba(239, 68, 68, 0.2);
  border-radius: 8px;
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.v-badge {
  display: flex;
  align-items: center;
  gap: 8px;
}
.shot-tag {
  font-size: 0.78rem;
  font-weight: 700;
  color: #fca5a5;
  background: rgba(239, 68, 68, 0.2);
  padding: 1px 6px;
  border-radius: 4px;
}
.v-message {
  font-size: 0.85rem;
  color: #fecaca;
  line-height: 1.5;
}
html.light .v-message {
  color: #991b1b;
}
.v-conflicts {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.78rem;
}
.v-conflict-label {
  color: #94a3b8;
}

@media (max-width: 1024px) {
  .hero-header {
    flex-direction: column;
  }
  .pipeline-flow-cards,
  .blueprint-grid,
  .rules-grid,
  .principles-strip,
  .dictionary-grid {
    grid-template-columns: 1fr;
  }
}
</style>
