<template>
  <div class="storyboard-card-wrapper">
    <!-- 段落分隔标头：segment_title 存在且是新段落的第一个镜头时显示 -->
    <div
      v-if="sb.segment_title && (index === 0 || sb.segment_index !== storyboards[index - 1]?.segment_index)"
      class="segment-header"
    >
      <div class="segment-header-inner">
        <span class="segment-index-badge">第 {{ (sb.segment_index ?? 0) + 1 }} 幕</span>
        <span class="segment-title-text">{{ sb.segment_title }}</span>
        <span class="segment-shot-range">
          镜头 {{ index + 1 }}–{{ shotRangeEnd }}
        </span>
      </div>
    </div>

    <!-- 分镜控制栏（卡片外，缩进表示属于当前幕） -->
    <div class="sb-ctrl-bar">
      <span class="sb-ctrl-num">{{ index + 1 }}</span>
      <span class="sb-ctrl-title">{{ sb.title || '未命名分镜' }}</span>
      <el-tag v-if="sb.movement" size="small" effect="plain" type="info" class="sb-movement-tag">{{ ctx.getMovementLabel(sb.movement) }}</el-tag>
      <el-button size="small" plain class="sb-ctrl-btn sb-ctrl-config-btn" @click="ctx.onOpenVideoParamsDialog(sb)">⚙ 分镜配置</el-button>
      <el-button
        size="small"
        plain
        class="sb-ctrl-btn sb-ctrl-mode-btn"
        :title="ctx.isSbUniversalMode(sb.id) ? '切换为经典分镜（中间显示参考图）' : '切换为全能模式（中间为片段描述，经典字段保留）'"
        @click="ctx.onToggleSbUniversalMode(sb)"
      >
        {{ ctx.isSbUniversalMode(sb.id) ? '经典分镜' : '全能模式' }}
      </el-button>
      <el-button
        size="small"
        type="primary"
        plain
        class="sb-ctrl-btn"
        title="输入导演意图，定向微调本镜头动作、运镜、光影与配乐"
        @click="ctx.onDirectorRefineSingleShot(sb)"
      >
        🎬 导演微调
      </el-button>
      <el-button size="small" plain class="sb-ctrl-btn" title="在本镜头前增加一个分镜" @click="ctx.onInsertStoryboardBefore(sb)">＋ 新增</el-button>
      <el-button size="small" plain class="sb-ctrl-btn" title="将当前复杂分镜一键 AI 拆分为多个镜头" @click="ctx.onOpenSplitDialog(sb)">✂ 拆分</el-button>
      <el-button
        class="sb-ctrl-delete"
        type="danger"
        text
        size="small"
        :title="`删除分镜${index + 1}`"
        @click="ctx.onDeleteSingleStoryboard(sb.id)"
      >
        <el-icon><Delete /></el-icon>
      </el-button>
    </div>

    <!-- 卡片主体（三栏布局） -->
    <div :id="'sb-' + sb.id" class="storyboard-row" @click="agentContext.setFocusedTarget({ type: 'storyboard', id: sb.id, number: sb.storyboard_number, title: sb.title || ('第' + sb.storyboard_number + '镜') })">
      <!-- 左：分镜脚本 -->
      <div class="sb-panel sb-script">
        <div class="sb-script-row sb-script-selects">
          <el-select
            :model-value="ctx.getSbCharacterIds(sb.id)"
            placeholder="选择角色"
            multiple
            collapse-tags
            collapse-tags-tooltip
            size="small"
            class="sb-select"
            @update:model-value="(v) => ctx.setSbCharacterIds(sb.id, v)"
          >
            <el-option
              v-for="c in (ctx.characters?.value || ctx.characters || [])"
              :key="String(c.id)"
              :label="c.name || '未命名'"
              :value="c.id"
            />
            <template v-if="!(ctx.characters?.value || ctx.characters || []).length" #empty>
              <span class="sb-select-empty">请先在「角色生成」中添加角色</span>
            </template>
          </el-select>
          <el-select
            v-model="ctx.sbSceneId[sb.id]"
            placeholder="选择场景"
            clearable
            size="small"
            class="sb-select"
            @change="() => ctx.onStoryboardSceneChange(sb.id)"
          >
            <el-option
              v-for="s in (ctx.scenes?.value || ctx.scenes || [])"
              :key="s.id"
              :label="s.location"
              :value="s.id"
            />
          </el-select>
          <el-select
            :model-value="ctx.getSbPropIds(sb.id)"
            placeholder="选择物品"
            multiple
            collapse-tags
            collapse-tags-tooltip
            size="small"
            class="sb-select"
            @update:model-value="(v) => ctx.setSbPropIds(sb.id, v)"
          >
            <el-option
              v-for="p in (ctx.props?.value || ctx.props || [])"
              :key="String(p.id)"
              :label="p.name || '未命名'"
              :value="p.id"
            />
            <template v-if="!(ctx.props?.value || ctx.props || []).length" #empty>
              <span class="sb-select-empty">请先在「道具生成」中添加物品</span>
            </template>
          </el-select>
        </div>

        <!-- 当前选中：场景 / 角色 / 物品缩略图 -->
        <div v-if="ctx.getSbSelectedScene(sb.id) || ctx.getSbSelectedCharacters(sb.id).length || ctx.getSbSelectedProps(sb.id).length || (ctx.characters?.value || ctx.characters || []).length" class="sb-selected-thumbs">
          <div v-if="ctx.getSbSelectedScene(sb.id)" class="sb-thumb-row">
            <span class="sb-thumb-label">场景</span>
            <div class="sb-thumb-list">
              <div
                v-for="s in [ctx.getSbSelectedScene(sb.id)]"
                :key="s.id"
                class="sb-thumb-item sb-thumb-scene"
                :class="{ 'sb-thumb-clickable': ctx.hasAssetImage(s) }"
                :title="s.location"
                role="button"
                @click="ctx.hasAssetImage(s) && ctx.openImagePreview(ctx.assetImageUrl(s))"
              >
                <img v-if="ctx.hasAssetImage(s)" :src="ctx.assetImageUrl(s)" alt="" />
                <span v-else class="sb-thumb-placeholder">{{ (s.location || '')[0] }}</span>
              </div>
            </div>
          </div>
          <div v-if="(ctx.characters?.value || ctx.characters || []).length" class="sb-thumb-row">
            <span class="sb-thumb-label">角色</span>
            <div class="sb-thumb-list">
              <div
                v-for="c in ctx.getSbSelectedCharacters(sb.id)"
                :key="c.id"
                class="sb-thumb-item sb-thumb-avatar"
                :class="{ 'sb-thumb-clickable': ctx.hasAssetImage(c) }"
                :title="c.name"
                role="button"
                @click="ctx.hasAssetImage(c) && ctx.openImagePreview(ctx.assetImageUrl(c))"
              >
                <img v-if="ctx.hasAssetImage(c)" :src="ctx.assetImageUrl(c)" alt="" />
                <span v-else class="sb-thumb-placeholder">{{ (c.name || '')[0] }}</span>
              </div>
              <el-dropdown trigger="click" @command="(cmd) => ctx.onSbAddCharacterCommand(sb.id, cmd)">
                <div
                  class="sb-thumb-item sb-thumb-avatar sb-thumb-add-char"
                  title="添加角色"
                  role="button"
                  @click.stop
                >
                  <el-icon><Plus /></el-icon>
                </div>
                <template #dropdown>
                  <el-dropdown-menu class="sb-char-add-dropdown">
                    <el-dropdown-item
                      v-for="c in ctx.charactersAvailableToAddToSb(sb.id)"
                      :key="c.id"
                      :command="c.id"
                    >
                      {{ c.name || '未命名' }}
                    </el-dropdown-item>
                    <el-dropdown-item v-if="!ctx.charactersAvailableToAddToSb(sb.id).length" disabled>
                      已全部添加或无角色
                    </el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </div>
          </div>
          <div v-if="ctx.getSbSelectedProps(sb.id).length" class="sb-thumb-row">
            <span class="sb-thumb-label">物品</span>
            <div class="sb-thumb-list">
              <div
                v-for="p in ctx.getSbSelectedProps(sb.id)"
                :key="p.id"
                class="sb-thumb-item sb-thumb-prop"
                :class="{ 'sb-thumb-clickable': ctx.hasAssetImage(p) }"
                :title="p.name"
                role="button"
                @click="ctx.hasAssetImage(p) && ctx.openImagePreview(ctx.assetImageUrl(p))"
              >
                <img v-if="ctx.hasAssetImage(p)" :src="ctx.assetImageUrl(p)" alt="" />
                <span v-else class="sb-thumb-placeholder">{{ (p.name || '')[0] }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 首尾帧模式下隐藏“图片提示词”入口，统一收敛到首/尾帧槽位的“查看提示词” -->
        <div v-if="!ctx.storyboardUseFirstLastFrame?.value && !ctx.storyboardUseFirstLastFrame" class="sb-prompt-label">
          <span class="sb-dot"></span>
          <span>图片提示词</span>
        </div>
        <div v-if="!ctx.storyboardUseFirstLastFrame?.value && !ctx.storyboardUseFirstLastFrame" class="sb-prompt-row">
          <span class="sb-prompt-text">{{ sb.image_prompt || '暂无图片提示词' }}</span>
          <el-button size="small" link type="primary" @click="ctx.onOpenSbPromptDialog(sb, 'image')">编辑</el-button>
        </div>

        <template v-if="(ctx.storyboardIncludeNarration?.value ?? ctx.storyboardIncludeNarration) || (ctx.sbNarration[sb.id] || '').trim() || (sb.narration || '').trim()">
          <div class="sb-prompt-label">
            <span class="sb-dot"></span>
            <span>解说旁白</span>
          </div>
          <el-input
            v-model="ctx.sbNarration[sb.id]"
            type="textarea"
            :rows="2"
            placeholder="本镜解说文案（画外音 / 纪录片式旁白，供 TTS 或导出 SRT）"
            class="sb-narration-input"
            @blur="() => ctx.onSaveSbNarrationField(sb)"
          />
          <div v-if="(ctx.sbNarration[sb.id] || sb.narration || '').toString().trim()" class="sb-narration-actions">
            <el-tooltip content="解说旁白配音（TTS）" placement="top">
              <el-button size="small" :loading="ctx.ttsSbNarrationIds.has(sb.id)" @click="ctx.onTtsSbNarration(sb)">
                解说配音
              </el-button>
            </el-tooltip>
            <el-tooltip v-if="ctx.sbNarrationAudioRelPath(sb)" content="播放解说旁白配音" placement="top">
              <el-button size="small" @click="ctx.playSbNarrationTts(sb)">
                <el-icon><VideoPlay /></el-icon>
              </el-button>
            </el-tooltip>
          </div>
        </template>

        <!-- 镜头指令与剧情动作快照（填补空白，提升导演可读性） -->
        <div v-if="sb.shot_type || sb.angle || sb.action || sb.atmosphere" class="sb-shot-meta-footer">
          <div v-if="sb.shot_type || sb.angle || sb.atmosphere" class="sb-meta-tags">
            <span v-if="sb.shot_type" class="sb-meta-tag">{{ sb.shot_type }}</span>
            <span v-if="sb.angle" class="sb-meta-tag">{{ sb.angle }}</span>
            <span v-if="sb.atmosphere" class="sb-meta-tag">{{ sb.atmosphere }}</span>
          </div>
          <div v-if="sb.action" class="sb-meta-action" :title="sb.action">
            <span class="sb-meta-label">动作：</span>{{ sb.action }}
          </div>
        </div>
      </div>

      <!-- 中：经典模式=分镜参考图；全能模式=片段描述（独立字段，与参考图并存） -->
      <div class="sb-panel sb-image" :class="{ 'sb-image--universal': ctx.isSbUniversalMode(sb.id) }">
        <template v-if="ctx.isSbUniversalMode(sb.id)">
          <div class="sb-prompt-label sb-universal-label-row">
            <div class="sb-universal-label-left">
              <span class="sb-dot"></span>
              <span>片段描述</span>
              <el-tooltip placement="top" :show-after="280" :show-arrow="false" popper-class="sb-universal-tooltip-popper">
                <template #content>
                  <div class="sb-universal-tooltip">
                    全能生视频链路：此处为提交主提示词；只要本框有内容，生视频时<strong>只</strong>发送这段，不会拼接下方「视频提示词」里的动作/对话/旁白。请用 <strong>@图片1</strong>、<strong>@图片2</strong>… 对应参考图。
                  </div>
                </template>
                <el-icon class="sb-universal-hint-icon" tabindex="0" role="img" aria-label="片段说明">
                  <QuestionFilled />
                </el-icon>
              </el-tooltip>
            </div>
            <el-dropdown
              trigger="click"
              class="sb-universal-prompt-dd"
              @command="(cmd) => ctx.onUniversalSegmentPromptMenu(sb, cmd)"
            >
              <el-button
                type="primary"
                link
                size="small"
                class="sb-universal-gen-btn"
                :loading="ctx.generatingUniversalSegmentIds.has(sb.id)"
              >
                全能提示词
                <el-icon class="sb-universal-dd-caret"><ArrowDown /></el-icon>
              </el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="generate">生成全能提示词</el-dropdown-item>
                  <el-dropdown-item command="generate-force">不查图片强制生成</el-dropdown-item>
                  <el-dropdown-item command="polish" :disabled="!ctx.sbUniversalSegmentTrimmed(sb)">
                    润色全能提示词
                  </el-dropdown-item>
                  <el-dropdown-item command="polish-force" :disabled="!ctx.sbUniversalSegmentTrimmed(sb)">
                    不查图片强制润色
                  </el-dropdown-item>
                  <el-dropdown-item
                    command="to-grok-video-tags"
                    divided
                    :disabled="!ctx.sbUniversalSegmentTrimmed(sb)"
                  >
                    改为 grok视频格式
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
          <UniversalSegmentOmniAtEditor
            v-if="!ctx.generatingUniversalSegmentIds.has(sb.id)"
            v-model="ctx.sbUniversalSegmentText[sb.id]"
            :slots="ctx.getSbUniversalOmniRefSlots(sb)"
            class="sb-universal-textarea"
            @blur="() => ctx.onSaveUniversalSegmentField(sb)"
          />
          <el-input
            v-else
            v-model="ctx.sbUniversalSegmentText[sb.id]"
            type="textarea"
            :rows="10"
            :autosize="{ minRows: 10, maxRows: 22 }"
            placeholder="例如：@图片1 为夜景街道，@图片2 从餐厅冲出停在光斑里，低头操作手机…"
            class="sb-universal-textarea"
            @blur="() => ctx.onSaveUniversalSegmentField(sb)"
          />
        </template>

        <template v-else>
          <div
            class="sb-image-area"
            :class="{
              'sb-image-area--dragover': ctx.dragOverSbId?.value === sb.id || ctx.dragOverSbId === sb.id,
              'sb-image-area--has-quad': !(ctx.storyboardUseFirstLastFrame?.value ?? ctx.storyboardUseFirstLastFrame) && ctx.getStripItems(sb.id).length > 0,
              'sb-image-area--first-last': (ctx.storyboardUseFirstLastFrame?.value ?? ctx.storyboardUseFirstLastFrame),
            }"
            @dragover="ctx.onSbImageDragOver($event, sb.id)"
            @dragleave="ctx.onSbImageDragLeave($event, sb.id)"
            @drop="ctx.onSbImageDrop($event, sb)"
          >
            <!-- 首尾帧双槽 -->
            <template v-if="ctx.storyboardUseFirstLastFrame?.value ?? ctx.storyboardUseFirstLastFrame">
              <div class="sb-fl-dual">
                <div class="sb-fl-slot">
                  <div class="sb-fl-slot-label">首帧</div>
                  <div class="sb-fl-slot-body">
                    <template v-if="ctx.getSbFirstImage(sb.id)">
                      <img
                        :src="ctx.assetImageUrl(ctx.getSbFirstImage(sb.id))"
                        class="sb-generated-img"
                        alt=""
                        @click="ctx.openImagePreview(ctx.assetImageUrl(ctx.getSbFirstImage(sb.id)))"
                      />
                    </template>
                    <template v-else-if="sb.image_url || sb.composed_image">
                      <img
                        :src="ctx.imageUrl(sb.composed_image || sb.image_url)"
                        class="sb-generated-img"
                        alt=""
                        @click="ctx.openImagePreview(ctx.imageUrl(sb.composed_image || sb.image_url))"
                      />
                    </template>
                    <template v-else>
                      <span class="sb-fl-empty">动作前静止</span>
                    </template>
                  </div>
                  <div v-if="ctx.getSbFirstImage(sb.id)?.prompt" class="sb-fl-slot-prompt" :title="ctx.getSbFirstImage(sb.id).prompt">
                    {{ ctx.getSbFirstImage(sb.id).prompt }}
                  </div>
                  <div class="sb-fl-slot-actions">
                    <el-button type="primary" size="small" :loading="ctx.generatingSbFirstImageIds.has(sb.id)" @click="ctx.onGenerateSbFrameImage(sb, 'first')">生成</el-button>
                    <el-tooltip v-if="ctx.canUsePrevTailAsFirst(sb)" content="直接使用上一分镜的尾帧图片（高清原图）替换本首帧，画面更清晰" placement="top">
                      <el-button size="small" :loading="ctx.usingPrevTailAsFirstIds.has(sb.id)" @click="ctx.onUsePrevTailAsFirst(sb)">上镜尾帧</el-button>
                    </el-tooltip>
                    <el-button size="small" :loading="ctx.uploadingSbImageSlot(sb.id) === 'first'" @click="ctx.onUploadSbImageClick(sb, 'first')">上传</el-button>
                    <el-button type="primary" link size="small" @click="ctx.showSbFramePromptPreview(sb, 'first')">查看提示词</el-button>
                  </div>
                </div>
                <div class="sb-fl-arrow" aria-hidden="true">→</div>
                <div class="sb-fl-slot">
                  <div class="sb-fl-slot-label">尾帧</div>
                  <div class="sb-fl-slot-body">
                    <template v-if="ctx.getSbLastImage(sb.id)">
                      <img
                        :src="ctx.assetImageUrl(ctx.getSbLastImage(sb.id))"
                        class="sb-generated-img"
                        alt=""
                        :title="ctx.getSbLastImage(sb.id).prompt || ''"
                        @click="ctx.openImagePreview(ctx.assetImageUrl(ctx.getSbLastImage(sb.id)))"
                      />
                    </template>
                    <template v-else>
                      <span class="sb-fl-empty">动作后结果</span>
                    </template>
                  </div>
                  <div v-if="ctx.getSbLastImage(sb.id)?.prompt" class="sb-fl-slot-prompt" :title="ctx.getSbLastImage(sb.id).prompt">
                    {{ ctx.getSbLastImage(sb.id).prompt }}
                  </div>
                  <div class="sb-fl-slot-actions">
                    <el-button type="primary" size="small" :loading="ctx.generatingSbLastImageIds.has(sb.id)" @click="ctx.onGenerateSbFrameImage(sb, 'last')">生成</el-button>
                    <el-checkbox
                      v-model="ctx.lastFrameUseFirstLayoutLock.value"
                      class="sb-fl-first-lock-opt"
                      title="勾选时尾帧生成会附带首帧图作构图与左右站位参考；取消后仅使用场景/角色/道具参考，便于调整出场人物"
                      @change="ctx.onLastFrameLayoutLockChange"
                    >
                      首帧站位
                    </el-checkbox>
                    <el-button size="small" :loading="ctx.uploadingSbImageSlot(sb.id) === 'last'" @click="ctx.onUploadSbImageClick(sb, 'last')">上传</el-button>
                    <el-button type="primary" link size="small" @click="ctx.showSbFramePromptPreview(sb, 'last')">查看提示词</el-button>
                  </div>
                </div>
              </div>
              <div v-if="ctx.getStripItems(sb.id).length" class="sb-imgs-strip">
                <el-tooltip content="历史图：按时间顺序从左往右排列，点击设为首帧或尾帧" placement="top" :show-arrow="false">
                  <el-icon class="sb-strip-hint-icon"><InfoFilled /></el-icon>
                </el-tooltip>
                <div
                  v-for="item in ctx.getStripItems(sb.id)"
                  :key="item.key"
                  class="sb-img-thumb"
                  :class="{ 'sb-img-thumb--active': item.isActive }"
                  :title="ctx.stripItemTitle(sb.id, item)"
                  @click="ctx.onStripItemClick(sb, item)"
                >
                  <img :src="item.src" alt="" />
                  <span v-if="item.frameBadge" class="sb-img-thumb-label" :class="{ 'sb-badge--active': item.isActive }">{{ item.frameBadge }}</span>
                  <span v-else-if="item.label" class="sb-img-thumb-label">{{ item.label }}</span>
                  <button class="thumb-preview-btn" title="放大预览" @click.stop="ctx.openImagePreview(item.src)">
                    <el-icon :size="10"><ZoomIn /></el-icon>
                  </button>
                  <button v-if="item.img?.id" class="extra-thumb-remove" title="删除历史图" @click.stop="ctx.onRemoveSbHistoryImage(sb.id, item.img.id)">×</button>
                </div>
              </div>
            </template>

            <!-- 单主图（未勾选首尾帧） -->
            <template v-else>
              <div class="sb-main-image-wrap">
                <template v-if="ctx.getSbImage(sb.id)">
                  <img
                    :src="ctx.assetImageUrl(ctx.getSbImage(sb.id))"
                    class="sb-generated-img"
                    alt=""
                    :title="ctx.getSbImage(sb.id).prompt || ''"
                    @click="ctx.openImagePreview(ctx.assetImageUrl(ctx.getSbImage(sb.id)))"
                  />
                  <div v-if="ctx.getSbImage(sb.id).prompt" class="sb-main-img-prompt">{{ ctx.getSbImage(sb.id).prompt }}</div>
                </template>
                <template v-else-if="sb.composed_image || sb.image_url">
                  <img
                    :src="ctx.imageUrl(sb.composed_image || sb.image_url)"
                    class="sb-generated-img"
                    alt=""
                    @click="ctx.openImagePreview(ctx.imageUrl(sb.composed_image || sb.image_url))"
                  />
                </template>
                <template v-else-if="sb.error_msg || sb.errorMsg">
                  <div class="sb-image-error" :title="sb.error_msg || sb.errorMsg">{{ sb.error_msg || sb.errorMsg }}</div>
                  <el-button type="primary" size="small" class="sb-gen-btn" :loading="ctx.generatingSbImageIds.has(sb.id)" @click="ctx.onGenerateSbImage(sb)">
                    <el-icon><Refresh /></el-icon>
                    重试
                  </el-button>
                  <el-button size="small" :loading="ctx.uploadingSbImageId === sb.id" @click="ctx.onUploadSbImageClick(sb)">上传</el-button>
                </template>
                <template v-else>
                  <el-button type="primary" size="small" class="sb-gen-btn" :loading="ctx.generatingSbImageIds.has(sb.id)" @click="ctx.onGenerateSbImage(sb)">
                    <el-icon><MagicStick /></el-icon>
                    生成分镜参考图
                  </el-button>
                  <el-button size="small" :loading="ctx.uploadingSbImageId === sb.id" @click="ctx.onUploadSbImageClick(sb)">上传</el-button>
                </template>
              </div>
              <div v-if="ctx.getStripItems(sb.id).length" class="sb-imgs-strip">
                <el-tooltip content="历史图：按时间顺序从左往右排列，点击设为主图" placement="top" :show-arrow="false">
                  <el-icon class="sb-strip-hint-icon"><InfoFilled /></el-icon>
                </el-tooltip>
                <div
                  v-for="item in ctx.getStripItems(sb.id)"
                  :key="item.key"
                  class="sb-img-thumb"
                  :class="{ 'sb-img-thumb--active': item.isActive }"
                  :title="ctx.stripItemTitle(sb.id, item)"
                  @click="ctx.onSelectStripItem(sb, item)"
                >
                  <img :src="item.src" alt="" />
                  <span v-if="item.frameBadge" class="sb-img-thumb-label" :class="{ 'sb-badge--active': item.isActive }">{{ item.frameBadge }}</span>
                  <span v-else-if="item.label" class="sb-img-thumb-label">{{ item.label }}</span>
                  <button class="thumb-preview-btn" title="放大预览" @click.stop="ctx.openImagePreview(item.src)">
                    <el-icon :size="10"><ZoomIn /></el-icon>
                  </button>
                  <button v-if="item.img?.id" class="extra-thumb-remove" title="删除历史图" @click.stop="ctx.onRemoveSbHistoryImage(sb.id, item.img.id)">×</button>
                </div>
              </div>
            </template>
            <div v-if="ctx.dragOverSbId?.value === sb.id || ctx.dragOverSbId === sb.id" class="sb-image-area-drop-hint">松开上传到首帧</div>
          </div>

          <div v-if="ctx.hasSbImage(sb) || (ctx.storyboardUseFirstLastFrame?.value ?? ctx.storyboardUseFirstLastFrame)" class="sb-image-actions">
            <template v-if="ctx.storyboardUseFirstLastFrame?.value ?? ctx.storyboardUseFirstLastFrame">
              <el-button size="small" :loading="ctx.generatingSbFirstImageIds.has(sb.id) || ctx.generatingSbLastImageIds.has(sb.id)" @click="ctx.onGenerateSbFramePair(sb)">{{ ctx.hasSbFirstLastPair(sb) ? '重新生成首尾帧' : '一键生成首尾帧' }}</el-button>
              <el-tooltip content="高清放大仅作用于首帧" placement="top">
                <el-button size="small" :loading="ctx.upscalingSbIds.has(sb.id)" :disabled="!ctx.getSbLocalImage(sb)" @click="ctx.onUpscaleSbImage(sb)">
                  <el-icon><ZoomIn /></el-icon>超分(首帧)
                </el-button>
              </el-tooltip>
            </template>
            <template v-else>
              <el-button size="small" :loading="ctx.generatingSbImageIds.has(sb.id)" @click="ctx.onGenerateSbImage(sb)">重新生成</el-button>
              <el-button size="small" :loading="ctx.uploadingSbImageId === sb.id" @click="ctx.onUploadSbImageClick(sb)">上传</el-button>
              <el-tooltip content="高清放大（2x超分辨率）" placement="top">
                <el-button
                  size="small"
                  :loading="ctx.upscalingSbIds.has(sb.id)"
                  :disabled="!ctx.getSbLocalImage(sb)"
                  @click="ctx.onUpscaleSbImage(sb)"
                >
                  <el-icon><ZoomIn /></el-icon>超分
                </el-button>
              </el-tooltip>
            </template>
          </div>
        </template>
      </div>

      <!-- 右：分镜视频 -->
      <div class="sb-panel sb-video">
        <div v-if="ctx.getSbVideo(sb.id)" class="sb-video-area">
          <video
            v-if="ctx.assetVideoUrl(ctx.getSbVideo(sb.id))"
            :key="ctx.sbMainVideoPlayerKey(sb.id)"
            :src="ctx.assetVideoUrl(ctx.getSbVideo(sb.id))"
            controls
            class="sb-video-player"
            preload="metadata"
          />
          <div
            v-else
            class="sb-video-error"
            :title="ctx.getSbVideoError(sb.id) || '视频地址无效'"
          >
            <span>{{ ctx.getSbVideoError(sb.id) || '视频地址无效，请重新生成' }}</span>
            <el-button
              v-if="ctx.getSbResumableFailedVideo(sb.id)"
              type="warning"
              link
              size="small"
              class="sb-resume-poll-btn"
              :loading="ctx.isSbVideoGenerating(sb.id)"
              @click="ctx.onResumeSbVideoPoll(sb)"
            >
              继续查询
            </el-button>
          </div>
          <span v-if="ctx.isSbVideoGenerating(sb.id)" class="sb-video-regenerating-overlay">
            <el-icon class="is-loading"><Loading /></el-icon>
            正在重新生成...
          </span>
        </div>
        <div v-else class="sb-video-area sb-video-placeholder">
          <span v-if="ctx.isSbVideoGenerating(sb.id)" class="sb-video-generating-text">
            <el-icon class="is-loading"><Loading /></el-icon>
            正在生成视频...
          </span>
          <template v-else>
            <div v-if="ctx.getSbVideoError(sb.id)" class="sb-video-error">
              <span>{{ ctx.getSbVideoError(sb.id) }}</span>
              <el-button
                v-if="ctx.getSbResumableFailedVideo(sb.id)"
                type="warning"
                link
                size="small"
                class="sb-resume-poll-btn"
                :loading="ctx.isSbVideoGenerating(sb.id)"
                @click="ctx.onResumeSbVideoPoll(sb)"
              >
                继续查询
              </el-button>
            </div>
            <el-button
              type="primary"
              size="small"
              class="sb-generate-video-btn"
              :loading="ctx.isSbVideoGenerating(sb.id)"
              :disabled="!ctx.sbCanSubmitVideo(sb) || ctx.isSbVideoGenerating(sb.id)"
              @click="ctx.onGenerateSbVideo(sb)"
            >
              生成分镜视频
            </el-button>
          </template>
        </div>

        <!-- 视频历史条 -->
        <div v-if="ctx.getVideoStripItems(sb.id).length" class="sb-videos-strip">
          <el-tooltip content="历史视频：按时间顺序从左往右排列，点击设为当前视频" placement="top" :show-arrow="false">
            <el-icon class="sb-strip-hint-icon"><InfoFilled /></el-icon>
          </el-tooltip>
          <div
            v-for="item in ctx.getVideoStripItems(sb.id)"
            :key="item.key"
            class="sb-video-thumb"
            :class="{ 'sb-video-thumb--active': item.isActive }"
            :title="`${item.label}${item.isActive ? '（当前主视频）' : '（点击设为当前视频）'}`"
            @click="ctx.onSelectSbMainVideo(sb, item.video)"
          >
            <video :src="item.src" preload="metadata" class="sb-video-thumb-player" />
            <span class="sb-video-thumb-label">{{ item.label }}</span>
            <button
              v-if="item.video?.id"
              type="button"
              class="extra-thumb-remove"
              title="删除历史视频"
              @click.stop="ctx.onRemoveSbHistoryVideo(sb.id, item.video.id)"
            >×</button>
          </div>
        </div>

        <!-- 视频操作栏：双向衔接 -->
        <div v-if="ctx.getSbVideo(sb.id)" class="sb-video-actions">
          <el-button size="small" :loading="ctx.isSbVideoGenerating(sb.id)" :disabled="!ctx.sbCanSubmitVideo(sb) || ctx.isSbVideoGenerating(sb.id)" @click="ctx.onGenerateSbVideo(sb)">重新生成</el-button>
          <el-tooltip v-if="ctx.getPrevStoryboard(sb.id)" content="提取本视频首帧，设为上一个分镜的尾帧" placement="top">
            <el-button size="small" :loading="ctx.linkingFirstFrameIds.has(sb.id)" @click="ctx.onLinkFirstFrameToPrev(sb)">首帧衔接</el-button>
          </el-tooltip>
          <el-tooltip v-if="ctx.getNextStoryboard(sb.id)" content="提取本视频尾帧，设为下一个分镜的首帧" placement="top">
            <el-button size="small" :loading="ctx.linkingTailFrameIds.has(sb.id)" @click="ctx.onLinkTailFrameToNext(sb)">尾帧衔接</el-button>
          </el-tooltip>
          <el-button size="small" text type="danger" @click="ctx.onRemoveSbHistoryVideo(sb.id, ctx.getSbVideo(sb.id).id)">删除视频</el-button>
        </div>

        <!-- 对白与旁白 -->
        <div class="sb-speech-toolbar">
          <div class="sb-tags-group">
            <el-tag :type="ctx.speechStatus(sb).pending ? 'warning' : (ctx.speechStatus(sb).dialogue ? 'success' : 'info')" size="small">对白：{{ ctx.speechStatus(sb).pending ? '待提取' : (ctx.speechStatus(sb).dialogue ? '有' : '无') }}</el-tag>
            <el-tag :type="ctx.speechStatus(sb).pending ? 'warning' : (ctx.speechStatus(sb).narration ? 'success' : 'info')" size="small">旁白：{{ ctx.speechStatus(sb).pending ? '待提取' : (ctx.speechStatus(sb).narration ? '有' : '无') }}</el-tag>
          </div>
          <el-button size="small" @click="ctx.speechEditor?.value?.open(sb, true)">生成对话</el-button>
          <el-button size="small" link type="primary" @click="ctx.speechEditor?.value?.open(sb)">编辑文本</el-button>
          <el-button size="small" :loading="ctx.ttsSbIds.has(sb.id)" :disabled="!ctx.speechStatus(sb).dialogue" @click="ctx.onTtsSbDialogue(sb)">对白配音</el-button>
          <el-button v-if="ctx.sbDialogueAudioRelPath(sb)" size="small" @click="ctx.playSbDialogueTts(sb)">试听对白</el-button>
          <el-button size="small" :loading="ctx.ttsSbNarrationIds.has(sb.id)" :disabled="!ctx.speechStatus(sb).narration" @click="ctx.onTtsSbNarration(sb)">旁白配音</el-button>
          <el-button v-if="ctx.sbNarrationAudioRelPath(sb)" size="small" @click="ctx.playSbNarrationTts(sb)">试听旁白</el-button>
        </div>

        <!-- 视频模型与镜头高级配置（合并单行，消除冗余解释文案） -->
        <div class="sb-model-config-row">
          <div class="sb-model-select-wrap">
            <span class="sb-config-label">模型</span>
            <el-select
              :model-value="sb.video_model || ''"
              :empty-values="[null, undefined]"
              size="small"
              class="sb-model-select"
              :disabled="ctx.savingVideoModelIds.has(sb.id) || ctx.isSbVideoGenerating(sb.id)"
              @visible-change="$event && ctx.loadVideoModelChoices()"
              @change="ctx.setShotVideoModel(sb, $event)"
            >
              <el-option :value="''" :label="'默认（' + (ctx.videoModelLabel(ctx.defaultShotModel(sb)) || 'H3') + '）'" />
              <el-option v-for="option in (ctx.videoModelChoices?.value || ctx.videoModelChoices || [])" :key="option.model" :value="option.model" :label="option.label" />
            </el-select>
          </div>
          <WardrobeSettings :key="'wardrobe-shot-' + sb.id" :drama-id="ctx.dramaId?.value || ctx.dramaId" :storyboard-id="sb.id" :disabled="ctx.isSbVideoGenerating(sb.id)" />
          <H3ShotSettings v-if="isH3VideoModel(ctx.selectedShotModel(sb))" :key="'h3-' + sb.id" :drama-id="ctx.dramaId?.value || ctx.dramaId" :storyboard-id="sb.id" :aspect-ratio="ctx.projectAspectRatio?.value || ctx.projectAspectRatio" :disabled="ctx.isSbVideoGenerating(sb.id)" />
          <ShotSpeechDelivery :shot="sb" :narrative-style="ctx.narrativeStyle?.value || ctx.narrativeStyle" />
        </div>

        <!-- 视频提示词（紧凑行合并） -->
        <div class="sb-video-prompt-compact">
          <span class="sb-dot"></span>
          <span class="sb-prompt-name">视频词</span>
          <span class="sb-video-prompt-text sb-video-prompt-text--preview" :title="sb.video_prompt">{{ sb.video_prompt || '暂无视频提示词（在「分镜配置」保存后自动生成）' }}</span>
          <el-button size="small" link type="primary" class="sb-prompt-edit-btn" @click="ctx.onOpenSbPromptDialog(sb, 'video')">编辑</el-button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, inject } from 'vue'
import {
  Delete,
  Plus,
  VideoPlay,
  QuestionFilled,
  ArrowDown,
  Refresh,
  MagicStick,
  ZoomIn,
  InfoFilled,
  Loading,
} from '@element-plus/icons-vue'
import { isH3VideoModel } from '@/utils/h3VideoBatch'
import { useAgentContext } from '@/stores/agentContext'
import UniversalSegmentOmniAtEditor from '@/components/UniversalSegmentOmniAtEditor.vue'
import ShotSpeechDelivery from '@/components/ShotSpeechDelivery.vue'
import WardrobeSettings from '@/components/WardrobeSettings.vue'
import H3ShotSettings from '@/components/H3ShotSettings.vue'

const props = defineProps({
  sb: { type: Object, required: true },
  index: { type: Number, required: true },
  storyboards: { type: Array, default: () => [] },
})

const ctx = inject('filmCreateContext', {})
const agentContext = useAgentContext()

const shotRangeEnd = computed(() => {
  const list = props.storyboards || []
  let end = props.index
  while (end + 1 < list.length && list[end + 1]?.segment_index === props.sb?.segment_index) {
    end++
  }
  return end + 1
})
</script>

<style scoped>
.storyboard-card-wrapper {
  margin-bottom: 20px;
}
.storyboard-card-wrapper:first-of-type {
  margin-top: 18px;
}
.segment-header {
  margin: 24px 0 14px;
  position: relative;
}
.segment-header:first-child { margin-top: 0; }
.segment-header-inner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 18px;
  background: linear-gradient(90deg, rgba(139,92,246,0.12) 0%, transparent 80%);
  border-left: 3px solid rgba(139,92,246,0.6);
  border-radius: 0 10px 10px 0;
}
.segment-index-badge {
  font-size: 11px;
  font-weight: 600;
  color: #a78bfa;
  background: rgba(139,92,246,0.15);
  padding: 2px 8px;
  border-radius: 20px;
  letter-spacing: 0.3px;
  white-space: nowrap;
}
.segment-title-text {
  font-size: 14px;
  font-weight: 600;
  color: #d4d4d8;
  flex: 1;
  letter-spacing: -0.01em;
}
.segment-shot-range {
  font-size: 11px;
  color: #52525b;
  white-space: nowrap;
}
:global(html.light) .segment-header-inner {
  background: linear-gradient(90deg, rgba(139,92,246,0.07) 0%, transparent 80%);
  border-left-color: rgba(124,58,237,0.5);
}
:global(html.light) .segment-title-text { color: #1e1b4b; }
:global(html.light) .segment-index-badge { color: #7c3aed; background: rgba(124,58,237,0.08); }
:global(html.light) .segment-shot-range { color: #9ca3af; }

/* 分镜控制栏 */
.sb-ctrl-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: 32px;
  margin-bottom: 4px;
  height: 26px;
}
.sb-ctrl-num {
  background: var(--el-color-primary);
  color: #fff;
  border-radius: 5px;
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  flex-shrink: 0;
}
.sb-ctrl-title {
  font-size: 0.95rem;
  font-weight: 700;
  color: #0f172a !important;
  max-width: 18em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
:global(html.dark .sb-ctrl-title) {
  color: #f4f4f5 !important;
}
.sb-movement-tag.el-tag {
  height: 18px;
  line-height: 18px;
  padding: 0 6px;
  font-size: 11px;
  margin-left: 6px;
  flex-shrink: 0;
}
.sb-ctrl-btn.el-button {
  height: 22px;
  padding: 0 8px;
  font-size: 11px;
}
.sb-ctrl-config-btn.el-button {
  border-color: rgba(139,92,246,0.45);
  color: #a78bfa;
  background: rgba(139,92,246,0.08);
}
.sb-ctrl-config-btn.el-button:hover {
  border-color: #8b5cf6;
  color: #fff;
  background: rgba(139,92,246,0.6);
}
:global(html.light .sb-ctrl-config-btn.el-button) {
  border-color: rgba(124,58,237,0.35);
  color: #7c3aed;
  background: rgba(124,58,237,0.06);
}
:global(html.light .sb-ctrl-config-btn.el-button:hover) {
  border-color: #7c3aed;
  color: #fff;
  background: #7c3aed;
}
.sb-ctrl-delete {
  margin-left: auto;
  opacity: 0.4;
  transition: opacity 0.2s;
  height: 22px;
  padding: 0 4px;
}
.sb-ctrl-bar:hover .sb-ctrl-delete { opacity: 1; }

@keyframes sb-fade-in {
  from { opacity: 0; transform: translateY(12px); }
  to   { opacity: 1; transform: translateY(0); }
}

.storyboard-row {
  display: flex;
  align-items: stretch;
  gap: 0;
  background: #1e1f28;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  overflow: hidden;
  position: relative;
  transition: border-color 0.25s ease, box-shadow 0.25s ease, transform 0.25s ease;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.15);
  animation: sb-fade-in 0.35s ease both;
}
.storyboard-row:hover {
  border-color: rgba(255, 255, 255, 0.1);
  box-shadow: 0 6px 28px rgba(0, 0, 0, 0.25);
  transform: translateY(-1px);
}
.storyboard-row.sb-highlight-pulse {
  border-color: #a855f7 !important;
  box-shadow: 0 0 24px rgba(168, 85, 247, 0.55) !important;
  transform: translateY(-2px);
}
:global(html.light .storyboard-row) {
  background: rgba(255, 255, 255, 0.95);
  border-color: rgba(139, 92, 246, 0.12);
  box-shadow: 0 1px 0 rgba(255,255,255,0.7) inset, 0 2px 12px rgba(99, 102, 241, 0.05);
}
:global(html.light .storyboard-row:hover) {
  border-color: rgba(139, 92, 246, 0.28);
  box-shadow: 0 1px 0 rgba(255,255,255,0.7) inset, 0 6px 24px rgba(99, 102, 241, 0.08);
  transform: translateY(-1px);
}

.sb-panel {
  min-width: 0;
  padding: 12px 14px;
  border-right: 1px solid rgba(255,255,255,0.05);
  display: flex;
  flex-direction: column;
}
:global(html.light .sb-panel) { border-right-color: rgba(139,92,246,0.08); }
.sb-panel:last-child { border-right: none; }

.sb-script {
  flex: 0 0 250px;
  max-width: 270px;
  padding-top: 10px;
}
.sb-image {
  flex: 1 1 360px;
  min-width: 280px;
}
.sb-video {
  flex: 1.1 1 400px;
  min-width: 320px;
}
.sb-script-row {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}
.sb-select { flex: 1; min-width: 0; }
.sb-select-empty { font-size: 0.8rem; color: #71717a; padding: 8px; }
.sb-selected-thumbs {
  margin: 10px 0;
  padding: 8px 0;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}
.sb-thumb-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.sb-thumb-row:last-child { margin-bottom: 0; }
.sb-thumb-label {
  font-size: 0.8rem;
  color: #71717a;
  flex-shrink: 0;
  width: 36px;
}
.sb-thumb-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.sb-thumb-item {
  flex-shrink: 0;
  border-radius: 6px;
  overflow: hidden;
  background: #22232d;
}
.sb-thumb-item.sb-thumb-clickable { cursor: pointer; }
.sb-thumb-avatar { width: 32px; height: 32px; border-radius: 50%; }
.sb-thumb-add-char {
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  border: 1.5px dashed #52525b;
  background: transparent;
  color: #a1a1aa;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.sb-thumb-add-char:hover {
  color: #e4e4e7;
  border-color: #71717a;
  background: rgba(63, 63, 70, 0.5);
}
:global(html.light) .sb-thumb-add-char { border-color: #d4d4d8; color: #71717a; }
:global(html.light) .sb-thumb-add-char:hover { color: #18181b; border-color: #a1a1aa; background: #f4f4f5; }
.sb-thumb-prop,
.sb-thumb-scene { width: 36px; height: 36px; }
.sb-script-row.sb-script-selects { gap: 6px; }
.sb-script-row.sb-script-selects .sb-select { min-width: 0; }
.sb-script-row.sb-script-selects .el-select { flex: 1; min-width: 0; }
.sb-thumb-item img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.sb-thumb-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.75rem;
  color: #7a7a88;
  background: #2a2b36;
}

.sb-prompt-label { display: flex; align-items: center; gap: 8px; margin: 10px 0 6px; }
.sb-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #a855f7;
  flex-shrink: 0;
}
.sb-prompt-label > span:not(.sb-dot) { font-size: 0.85rem; color: #e4e4e7; }
.sb-prompt-row { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 6px; }
.sb-prompt-text { flex: 1; min-width: 0; font-size: 0.85rem; color: #a1a1aa; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

.sb-image-area {
  flex: 1;
  min-height: 180px;
  max-height: 280px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: space-between;
  gap: 0;
  overflow: hidden;
  position: relative;
  transition: border-color 0.2s, background 0.2s;
}
.sb-image-area:hover { border-color: rgba(124, 58, 237, 0.35); }
:global(html.dark .sb-image-area) {
  background: linear-gradient(145deg, #1a1b24 0%, #1e1f28 60%, #1c1d26 100%);
  border: 1px dashed rgba(255, 255, 255, 0.08);
}
:global(html.dark .sb-image-area:hover) { border-color: rgba(255, 255, 255, 0.15); }
.sb-image-area--dragover {
  outline: 2px dashed var(--el-color-primary);
  outline-offset: -2px;
  background: rgba(64, 158, 255, 0.1);
}
.sb-image-area-drop-hint {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  font-size: 0.9rem;
  border-radius: 8px;
  pointer-events: none;
}
.sb-generated-img {
  max-width: 100%;
  max-height: 100%;
  width: auto;
  height: auto;
  object-fit: contain;
  border-radius: 8px;
  cursor: pointer;
}
.sb-panel.sb-image.sb-image--universal {
  min-height: 280px;
  justify-content: flex-start;
}
.sb-universal-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  width: 100%;
}
.sb-universal-label-left {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.sb-universal-hint-icon {
  cursor: help;
  color: #9ca3af;
  font-size: 16px;
  flex-shrink: 0;
}
.sb-universal-hint-icon:hover { color: #a78bfa; }
.sb-universal-gen-btn { flex-shrink: 0; }
.sb-universal-prompt-dd { flex-shrink: 0; }
.sb-universal-dd-caret { margin-left: 2px; font-size: 12px; vertical-align: middle; }
.sb-universal-tooltip {
  max-width: 360px;
  font-size: 12px;
  line-height: 1.55;
  padding: 10px 12px;
  border-radius: 8px;
  color: #f1f5f9;
  background: #0f172a;
  border: 1px solid rgba(248, 250, 252, 0.22);
}
:global(html.light .sb-universal-tooltip) {
  color: #0f172a;
  background: #ffffff;
  border-color: #cbd5e1;
}
.sb-universal-textarea { flex: 1; min-height: 0; }
.sb-universal-textarea :deep(.el-textarea__inner) {
  min-height: 200px !important;
  font-size: 13px;
  line-height: 1.55;
}

.sb-image-area--first-last {
  min-height: 200px;
  max-height: none;
  padding: 8px;
  align-items: stretch;
  justify-content: flex-start;
}
.sb-fl-dual {
  display: flex;
  align-items: stretch;
  gap: 8px;
  width: 100%;
  flex: 1;
  min-height: 160px;
}
.sb-fl-slot {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.sb-fl-slot-label {
  font-size: 0.72rem;
  font-weight: 600;
  color: #a78bfa;
  text-align: center;
}
.sb-fl-slot-body {
  flex: 1;
  min-height: 110px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.04);
  border-radius: 8px;
  overflow: hidden;
}
:global(html.dark .sb-fl-slot-body) {
  background: rgba(0, 0, 0, 0.2);
}
.sb-fl-slot-body .sb-generated-img { max-height: 160px; }
.sb-fl-empty { font-size: 0.75rem; color: #71717a; }
.sb-fl-arrow {
  flex-shrink: 0;
  align-self: center;
  font-size: 1.25rem;
  color: #a78bfa;
  opacity: 0.85;
}
.sb-fl-slot-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: center;
  align-items: center;
}
.sb-fl-first-lock-opt { margin: 0 2px; height: auto; }
.sb-fl-first-lock-opt :deep(.el-checkbox__label) { font-size: 12px; padding-left: 4px; }
.sb-fl-slot-prompt {
  font-size: 0.68rem;
  line-height: 1.35;
  color: #9ca3af;
  max-height: 2.7em;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  padding: 0 4px;
  word-break: break-all;
}

.sb-imgs-strip {
  display: flex;
  flex-direction: row;
  flex-wrap: nowrap;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 6px 8px 4px;
  overflow-x: auto;
  background: #f8fafc;
  border-top: 1px solid #e2e8f0;
  flex-shrink: 0;
}
:global(html.dark .sb-imgs-strip) {
  background: #181920;
  border-top-color: rgba(255, 255, 255, 0.08);
}
.sb-strip-hint-icon {
  font-size: 12px;
  color: var(--el-text-color-placeholder);
  cursor: default;
  transition: color 0.15s;
}
.sb-strip-hint-icon:hover { color: var(--el-color-primary); }
.sb-img-thumb {
  position: relative;
  cursor: pointer;
  border-radius: 4px;
  overflow: hidden;
  border: 2px solid transparent;
  transition: border-color 0.2s;
  flex-shrink: 0;
  width: 48px;
  height: 48px;
}
.sb-img-thumb:hover { border-color: var(--el-color-primary); }
.sb-img-thumb--active {
  border-color: var(--el-color-primary) !important;
  box-shadow: 0 0 0 1.5px var(--el-color-primary);
}
.sb-img-thumb--active .sb-img-thumb-label,
.sb-img-thumb-label.sb-badge--active {
  background: var(--el-color-primary) !important;
  font-weight: 600;
}
.sb-img-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.sb-img-thumb-label {
  position: absolute;
  bottom: 1px;
  left: 0;
  right: 0;
  text-align: center;
  font-size: 10px;
  color: #fff;
  background: rgba(0,0,0,0.5);
  pointer-events: none;
}
.thumb-preview-btn {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  background: rgba(0,0,0,0.6);
  color: #fff;
  border-radius: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s;
}
.sb-img-thumb:hover .thumb-preview-btn { opacity: 1; }
.extra-thumb-remove {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  background: rgba(239, 68, 68, 0.85);
  color: #fff;
  border-radius: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s;
}
.sb-img-thumb:hover .extra-thumb-remove,
.sb-video-thumb:hover .extra-thumb-remove { opacity: 1; }

.sb-main-image-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  flex: 1;
  min-height: 80px;
  overflow: hidden;
}
.sb-main-image-wrap .sb-generated-img {
  max-height: 185px;
  width: auto;
  max-width: 100%;
  object-fit: contain;
}
.sb-main-img-prompt {
  width: 100%;
  font-size: 10px;
  color: var(--el-text-color-secondary);
  background: rgba(0, 0, 0, 0.02);
  border-top: 1px solid var(--el-border-color-lighter);
  padding: 3px 6px;
  line-height: 1.35;
  max-height: 32px;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  word-break: break-all;
  cursor: default;
}
:global(html.dark .sb-main-img-prompt) {
  background: rgba(255, 255, 255, 0.03);
}

.sb-shot-meta-footer {
  margin-top: auto;
  padding: 8px 10px;
  background: rgba(0, 0, 0, 0.02);
  border: 1px solid rgba(0, 0, 0, 0.04);
  border-radius: 8px;
}
:global(html.dark .sb-shot-meta-footer) {
  background: rgba(255, 255, 255, 0.03);
  border-color: rgba(255, 255, 255, 0.06);
}
.sb-meta-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 4px;
}
.sb-meta-tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(139, 92, 246, 0.08);
  color: #7c3aed;
  font-weight: 500;
}
:global(html.dark .sb-meta-tag) {
  background: rgba(139, 92, 246, 0.15);
  color: #c4b5fd;
}
.sb-meta-action {
  font-size: 11px;
  line-height: 1.45;
  color: var(--el-text-color-regular);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-all;
}
.sb-meta-label {
  font-weight: 600;
  color: var(--el-text-color-secondary);
}
.sb-image-actions {
  display: flex;
  gap: 8px;
  margin-top: 6px;
  flex-shrink: 0;
  padding-top: 4px;
}
.sb-image-error {
  color: #f56c6c;
  font-size: 0.75rem;
  line-height: 1.4;
  word-break: break-word;
  padding: 4px 8px;
}

/* 视频栏 */
.sb-video-area {
  flex: 1;
  min-height: 180px;
  max-height: 250px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: border-color 0.2s;
}
:global(html.dark .sb-video-area) {
  background: linear-gradient(145deg, #1a1b24 0%, #1e1f28 60%, #1c1d26 100%);
  border: 1px dashed rgba(255, 255, 255, 0.08);
}
.sb-video-placeholder {
  color: #71717a;
  font-size: 0.85rem;
  flex-direction: column;
  gap: 8px;
  text-align: center;
  padding: 12px;
}
:global(html.light .sb-video-placeholder) { color: #7c3aed; }
.sb-video-generating-text {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #409eff;
  font-size: 0.85rem;
}
.sb-video-error {
  color: #f56c6c;
  font-size: 0.75rem;
  line-height: 1.4;
  word-break: break-word;
  max-height: 80px;
  overflow-y: auto;
  padding: 4px 8px;
  background: rgba(245, 108, 108, 0.08);
  border-radius: 4px;
  text-align: left;
  width: 100%;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
}
.sb-resume-poll-btn { flex-shrink: 0; }
.sb-video-player {
  width: 100%;
  max-height: 240px;
  border-radius: 8px;
}
.sb-video-actions {
  display: flex;
  gap: 8px;
  margin-top: 6px;
  flex-shrink: 0;
  padding-top: 4px;
}
.sb-video-regenerating-overlay {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin-top: 6px;
  font-size: 0.82rem;
  color: #a78bfa;
}
.sb-videos-strip {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  flex-wrap: wrap;
}
.sb-video-thumb {
  position: relative;
  width: 68px;
  height: 44px;
  border-radius: 5px;
  overflow: hidden;
  cursor: pointer;
  border: 1.5px solid transparent;
  flex-shrink: 0;
  transition: border-color 0.15s;
}
.sb-video-thumb:hover { border-color: #a855f7; }
.sb-video-thumb--active {
  border-color: #a855f7 !important;
  box-shadow: 0 0 0 1.5px #a855f7;
}
.sb-video-thumb--active .sb-video-thumb-label {
  background: rgba(168, 85, 247, 0.9) !important;
  font-weight: 600;
}
.sb-video-thumb-player {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  pointer-events: none;
}
.sb-video-thumb-label {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  background: rgba(0,0,0,0.55);
  color: #e4e4e7;
  font-size: 0.65rem;
  text-align: center;
  padding: 1px 0;
  pointer-events: none;
}
.sb-generate-video-btn { margin-top: 4px; }

/* 紧凑对白工具栏 */
.sb-speech-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 6px;
  padding-top: 4px;
}
.sb-tags-group {
  display: inline-flex;
  gap: 4px;
}

/* 紧凑模型与配置栏 */
.sb-model-config-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 6px;
  padding: 4px 0;
  border-top: 1px solid rgba(0, 0, 0, 0.04);
}
:global(html.dark .sb-model-config-row) {
  border-top-color: rgba(255, 255, 255, 0.05);
}
.sb-model-select-wrap {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.sb-config-label {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  font-weight: 500;
  flex-shrink: 0;
}
.sb-model-select {
  width: 160px !important;
}

/* 紧凑视频提示词栏 */
.sb-video-prompt-compact {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  padding: 4px 8px;
  background: rgba(0, 0, 0, 0.02);
  border-radius: 6px;
  border: 1px solid rgba(0, 0, 0, 0.04);
}
:global(html.dark .sb-video-prompt-compact) {
  background: rgba(255, 255, 255, 0.03);
  border-color: rgba(255, 255, 255, 0.06);
}
.sb-prompt-name {
  font-size: 11px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
  flex-shrink: 0;
}
.sb-prompt-edit-btn {
  font-size: 11px;
  padding: 0 4px;
  flex-shrink: 0;
}
.sb-video-prompt-text--preview {
  flex: 1;
  font-size: 11px;
  line-height: 1.4;
  color: #64748b;
  max-height: 2.8em;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-all;
}
:global(html.dark .sb-video-prompt-text--preview) {
  color: #94a3b8;
}
</style>
