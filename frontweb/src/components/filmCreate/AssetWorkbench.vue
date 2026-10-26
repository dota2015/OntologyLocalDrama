<template>
  <div class="asset-workbench-container">
    <!-- 角色/道具/场景上传图片用，单例放在外层避免 v-for 导致 ref 为数组 -->
    <input
      ref="resourceImageFileInput"
      type="file"
      accept="image/jpeg,image/png,image/gif,image/webp"
      style="display: none"
      @change="onResourceImageFileChange"
    />

    <!-- 隐藏的文件输入框（放在弹窗外层，避免 el-form-item 干扰） -->
    <input ref="addCharRefFileInput" type="file" accept="image/*" style="display:none" @change="onRefImageFileChange('character', $event)" />
    <input ref="addSceneRefFileInput" type="file" accept="image/*" style="display:none" @change="onRefImageFileChange('scene', $event)" />
    <input ref="addPropRefFileInput" type="file" accept="image/*" style="display:none" @change="onRefImageFileChange('prop', $event)" />
    <input ref="addPropAddRefFileInput" type="file" accept="image/*" style="display:none" @change="onRefImageFileChange2('addProp', $event)" />

    <section class="section card resource-panel">
      <div class="collapse-header" @click="resourcePanelCollapsed = !resourcePanelCollapsed">
        <h2 class="section-title">资源管理</h2>
        <el-icon class="collapse-icon"><ArrowUp v-if="!resourcePanelCollapsed" /><ArrowDown v-else /></el-icon>
      </div>
      <div v-show="!resourcePanelCollapsed" class="resource-panel-body">
        <BatchReferenceImages
          ref="referenceImageBatch"
          :drama-id="dramaId" :episode-id="currentEpisodeId"
          :episode-number="currentEpisode?.episode_number" :drama-title="store.drama?.title"
          :characters="characters" :props="props" :scenes="scenes"
          :style-prompt="getSelectedStyle ? getSelectedStyle() : ''"
          :disabled="pipelineRunning || charactersGenerating || propsExtracting || scenesExtracting || referenceSuggestionsRunning || savingReferenceModeIds.size > 0"
          :jobs="serverGenerationJobs" @submitted="generationJobsPanel?.refresh?.()" :refresh="loadDrama" @running-change="referenceBatchRunning = $event"
        />

        <!-- 智能体世界观过时资产诊断横幅 -->
        <div v-if="obsoleteAssets.length > 0" class="obsolete-assets-banner">
          <div class="oab-left">
            <el-icon class="oab-icon"><WarningFilled /></el-icon>
            <div class="oab-msg">
              <span class="oab-title">智能体世界观诊断：</span>
              检测到 <strong>{{ obsoleteAssets.length }}</strong> 项旧资产在最新剧本与分镜中已无任何提及（
              <span v-for="(oa, idx) in obsoleteAssets.slice(0, 4)" :key="oa.type + oa.id">
                {{ oa.typeLabel }}「{{ oa.name }}」{{ idx < Math.min(obsoleteAssets.length, 4) - 1 ? '、' : '' }}
              </span>
              <span v-if="obsoleteAssets.length > 4">等</span>
              ），疑似剧情修改后的残留，<strong>建议清理删除</strong>以防干扰生图一致性与运镜调度。
            </div>
          </div>
          <el-button type="danger" size="small" plain @click="onBatchCleanObsoleteAssets">
            🧹 一键清理过时资产 ({{ obsoleteAssets.length }})
          </el-button>
        </div>

        <!-- 角色生成 -->
        <div id="anchor-characters" class="resource-block card">
          <div class="collapse-header resource-block-header" @click="charactersBlockCollapsed = !charactersBlockCollapsed">
            <h3 class="resource-block-title">角色生成</h3>
            <el-icon class="collapse-icon"><ArrowUp v-if="!charactersBlockCollapsed" /><ArrowDown v-else /></el-icon>
          </div>
          <div v-show="!charactersBlockCollapsed" class="resource-block-body">
            <div class="asset-actions">
              <el-button type="primary" size="small" :loading="charactersGenerating" :disabled="!dramaId || referenceBatchRunning" @click="onGenerateCharacters">
                剧本自动提取角色
              </el-button>
              <el-button size="small" :disabled="!currentEpisodeId || referenceBatchRunning || pipelineRunning || charactersGenerating || propsExtracting || scenesExtracting || referenceSuggestionsRunning || savingReferenceModeIds.size > 0" @click="referenceImageBatch?.start('character')">批量生成参考图</el-button>
              <el-button size="small" :disabled="!dramaId" @click="openAddCharacter">添加角色</el-button>
              <el-button size="small" @click="showCharLibrary = true">本剧角色库</el-button>
            </div>
            <div class="asset-list asset-list-two">
              <div v-for="char in characters" :key="char.id" class="asset-item asset-item-left-right">
                <div class="asset-info">
                  <div class="asset-name">
                    <span style="display:inline-flex;align-items:center;gap:4px;flex:1;min-width:0;overflow:hidden">
                      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ char.name }}</span>
                      <el-tag v-if="char.role" size="small" effect="plain" :type="char.role === 'main' ? 'danger' : char.role === 'supporting' ? 'warning' : 'info'" style="flex-shrink:0;padding:0 5px;font-size:11px;height:18px;line-height:18px">{{ charRoleLabel(char.role) }}</el-tag>
                      <el-tooltip v-if="getAssetObsoleteInfo('character', char)" :content="getAssetObsoleteInfo('character', char).reason" placement="top">
                        <el-tag size="small" type="danger" effect="light" style="flex-shrink:0;padding:0 4px;font-size:10px;height:18px;line-height:18px;cursor:help;color:#f56c6c;border-color:#fde2e2;background:#fef0f0">
                          ⚠️ 建议删除
                        </el-tag>
                      </el-tooltip>
                    </span>
                    <el-button type="danger" text size="small" class="btn-delete-icon" title="删除" @click="onDeleteCharacter(char)">
                      <el-icon><Delete /></el-icon>
                    </el-button>
                  </div>
                  <div class="asset-desc-full">{{ char.appearance || char.description || '暂无描述' }}</div>
                  <div class="asset-btns">
                    <el-button size="small" @click="editCharacter(char)">编辑</el-button>
                    <el-button size="small" :loading="addingCharToLibraryId === char.id" :disabled="!hasAssetImage(char)" @click="onAddCharacterToLibrary(char)">
                      加入本剧库
                    </el-button>
                    <el-button size="small" :loading="addingCharToMaterialId === char.id" :disabled="!hasAssetImage(char)" @click="onAddCharacterToMaterialLibrary(char)">
                      加入素材库
                    </el-button><el-button
                      size="small"
                      :type="char.seedance2_asset?.status === 'active' ? 'success' : 'warning'"
                      plain
                      :loading="sd2CertifyingId === char.id"
                      :disabled="!hasAssetImage(char)"
                      @click="onSd2PrimaryAction(char)"
                    >
                      {{ sd2ActionLabel(char) }}
                    </el-button>
                  </div>

                  <!-- Seedance 2.0 音色参考（仅该模型有效，其他模型不生效） -->
                  <div class="sd2-voice-row" style="margin-top:6px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                    <template v-if="char.seedance2_voice_asset?.status === 'active'">
                      <!-- 音色参考已设置：显示试听 + 更换 -->
                      <el-button
                        size="small"
                        type="success"
                        plain
                        @click="playSd2Voice(char)"
                      >
                        <el-icon><VideoPlay /></el-icon>
                        <span style="margin-left:4px">试听</span>
                      </el-button>
                      <el-button
                        size="small"
                        type="primary"
                        plain
                        :loading="sd2VoiceUploadingId === char.id"
                        @click="onSd2VoiceReplace(char)"
                      >
                        更换
                      </el-button>
                      <span style="font-size:11px;color:#67c23a">音色已设置</span>
                    </template>
                    <template v-else>
                      <el-button
                        size="small"
                        :type="char.seedance2_voice_asset?.status === 'stale' ? 'warning' : 'info'"
                        plain
                        :loading="sd2VoiceUploadingId === char.id"
                        @click="onSd2VoicePrimaryAction(char)"
                      >
                        {{ sd2VoiceActionLabel(char) }}
                      </el-button>
                      <span v-if="char.seedance2_voice_asset?.status === 'stale'" style="font-size:11px;color:#e6a23c">需刷新</span>
                    </template>
                    <span style="font-size:10px;color:#909399">仅 Seedance 2.0 模型生效</span>
                  </div>
                  <div v-if="getCharAffectedStoryboards(char.id).length" class="asset-storyboard-link">
                    <span class="asl-label">影响的分镜：</span>
                    <span
                      v-for="sb in getCharAffectedStoryboards(char.id)"
                      :key="sb.id"
                      class="asl-chip"
                      title="点击跳转到该分镜"
                      @click="scrollToStoryboard(sb.id)"
                    >#{{ sb.storyboard_number }}</span>
                    <span v-if="regenSbImagesForAsset.has('char-' + char.id) && regenSbImagesProgress['char-' + char.id]" class="asl-progress">
                      {{ regenSbImagesProgress['char-' + char.id].current }}/{{ regenSbImagesProgress['char-' + char.id].total }}
                    </span>
                    <el-button
                      size="small"
                      class="asl-regen-btn"
                      :loading="regenSbImagesForAsset.has('char-' + char.id)"
                      @click="onRegenAffectedSbImages('char-' + char.id, getCharAffectedStoryboards(char.id))"
                    >
                      <span v-if="!regenSbImagesForAsset.has('char-' + char.id)">↻ 重新生成分镜图</span>
                    </el-button>
                  </div>
                </div>
                <div class="asset-cover-wrap">
                  <div
                    class="asset-cover"
                    :class="{ 'asset-cover--clickable': hasAssetImage(char), 'asset-cover--dragover': dragOverResourceKey === 'char-' + char.id }"
                    role="button"
                    tabindex="0"
                    @click="hasAssetImage(char) && openImagePreview(assetImageUrl(char))"
                    @dragover="onResourceDragOver($event, 'character', char.id)"
                    @dragleave="onResourceDragLeave($event, 'char-' + char.id)"
                    @drop="onResourceDrop($event, 'character', char.id)"
                  >
                    <img v-if="hasAssetImage(char)" :src="assetImageUrl(char)" class="cover-img" alt="" />
                    <div v-else-if="char.error_msg || char.errorMsg" class="cover-placeholder error" :title="char.error_msg || char.errorMsg">{{ char.error_msg || char.errorMsg }}</div>
                    <div v-else class="cover-placeholder">暂无图</div>
                    <div v-if="dragOverResourceKey === 'char-' + char.id" class="asset-cover-drop-hint">松开上传</div>
                  </div>
                  <p style="font-size:12px;color:var(--el-text-color-secondary);margin:6px 0">H3 会使用人物主图与全部补充图；可上传正面、侧面照，服装应保持一致。</p>
                  <div v-if="char.ref_image" style="display:flex;align-items:center;gap:8px;margin:6px 0;font-size:12px">
                    <img :src="localPathToUrl(char.ref_image)" alt="相貌参考照" style="width:42px;height:42px;object-fit:cover;cursor:pointer;border-radius:4px" @click="openImagePreview(localPathToUrl(char.ref_image))" />
                    <span>相貌参考照 · 下次 AI 生成使用<br />服装按角色设定，可点击「参考照片」更换</span>
                  </div>
                  <!-- 额外参考图条 -->
                  <div v-if="parseExtraImages(char).length" class="extra-images-strip">
                    <div v-for="ep in parseExtraImages(char)" :key="ep" class="extra-thumb" :title="'点击设为主图（悬停左上角可放大预览）'">
                      <img :src="localPathToUrl(ep)" alt="" @click="onSetPrimaryImage('character', char, ep)" />
                      <button class="thumb-preview-btn" title="放大预览" @click.stop="openImagePreview(localPathToUrl(ep))">
                        <el-icon :size="10"><ZoomIn /></el-icon>
                      </button>
                      <button class="extra-thumb-remove" title="移除" @click.stop="onRemoveExtraImage('character', char, ep)">×</button>
                    </div>
                  </div>
                  <div class="asset-cover-actions">
                    <el-button type="primary" size="small" :loading="generatingCharIds.has(char.id)" :disabled="referenceBatchRunning || uploadingResourceId === 'char-' + char.id" @click="onGenerateCharacterImage(char)">
                      <el-icon v-if="!generatingCharIds.has(char.id)"><MagicStick /></el-icon>
                      AI 生成
                    </el-button>
                    <el-button type="success" size="small" :loading="uploadingResourceId === 'char-' + char.id" :disabled="generatingCharIds.has(char.id) || referenceBatchRunning" @click="onUploadResourceClick('character', char.id)">
                      <el-icon v-if="uploadingResourceId !== 'char-' + char.id"><Upload /></el-icon>
                      上传角色图
                    </el-button>
                    <el-button size="small" :loading="uploadingResourceId === 'char-' + char.id" :disabled="generatingCharIds.has(char.id) || referenceBatchRunning" @click="onUploadResourceClick('character-reference', char.id)">
                      参考照片
                    </el-button>
                  </div>
                </div>
              </div>
              <div v-if="characters.length === 0" class="empty-tip">暂无角色，请先「AI 生成角色」或在上一步保存剧本后提取</div>
            </div>
          </div>
        </div>

        <!-- 道具生成 -->
        <div id="anchor-props" class="resource-block card">
          <div class="collapse-header resource-block-header" @click="propsBlockCollapsed = !propsBlockCollapsed">
            <h3 class="resource-block-title">道具生成</h3>
            <el-icon class="collapse-icon"><ArrowUp v-if="!propsBlockCollapsed" /><ArrowDown v-else /></el-icon>
          </div>
          <div v-show="!propsBlockCollapsed" class="resource-block-body">
            <div class="asset-actions">
              <el-button type="primary" size="small" :loading="propsExtracting" :disabled="!currentEpisodeId || referenceBatchRunning" @click="onExtractProps">从剧本提取道具</el-button>
              <el-button size="small" :disabled="!currentEpisodeId || referenceBatchRunning || pipelineRunning || charactersGenerating || propsExtracting || scenesExtracting || referenceSuggestionsRunning || savingReferenceModeIds.size > 0" @click="referenceImageBatch?.start('prop')">批量生成参考图</el-button>
              <el-button size="small" :disabled="!dramaId" @click="showAddProp = true">添加道具</el-button>
              <el-button size="small" @click="showPropLibrary = true">本剧道具库</el-button>
            </div>
            <div class="asset-list asset-list-two">
              <div v-for="prop in props" :key="prop.id" class="asset-item asset-item-left-right">
                <div class="asset-info">
                  <div class="asset-name">
                    <span style="display:inline-flex;align-items:center;gap:4px;flex:1;min-width:0;overflow:hidden">
                      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ prop.name }}</span>
                      <el-tooltip v-if="getAssetObsoleteInfo('prop', prop)" :content="getAssetObsoleteInfo('prop', prop).reason" placement="top">
                        <el-tag size="small" type="danger" effect="light" style="flex-shrink:0;padding:0 4px;font-size:10px;height:18px;line-height:18px;cursor:help;color:#f56c6c;border-color:#fde2e2;background:#fef0f0">
                          ⚠️ 建议删除
                        </el-tag>
                      </el-tooltip>
                    </span>
                    <el-button type="danger" text size="small" class="btn-delete-icon" title="删除" @click="onDeleteProp(prop)">
                      <el-icon><Delete /></el-icon>
                    </el-button>
                  </div>
                  <div class="asset-desc-full">{{ prop.description || prop.prompt || '暂无描述' }}</div>
                  <ReferenceImageMode :resource="prop" kind="prop" :disabled="referenceBatchRunning || referenceSuggestionsRunning || pipelineRunning || generatingPropIds.has(prop.id)" @saving-change="onReferenceModeSaving('prop', prop.id, $event)" />
                  <div class="asset-btns">
                    <el-button size="small" @click="editProp(prop)">编辑</el-button>
                    <el-button size="small" :loading="addingPropToLibraryId === prop.id" :disabled="!hasAssetImage(prop)" @click="onAddPropToLibrary(prop)">
                      加入本剧库
                    </el-button>
                    <el-button size="small" :loading="addingPropToMaterialId === prop.id" :disabled="!hasAssetImage(prop)" @click="onAddPropToMaterialLibrary(prop)">
                      加入素材库
                    </el-button></div>
                  <div v-if="getPropAffectedStoryboards(prop.id).length" class="asset-storyboard-link">
                    <span class="asl-label">影响的分镜：</span>
                    <span
                      v-for="sb in getPropAffectedStoryboards(prop.id)"
                      :key="sb.id"
                      class="asl-chip"
                      title="点击跳转到该分镜"
                      @click="scrollToStoryboard(sb.id)"
                    >#{{ sb.storyboard_number }}</span>
                    <span v-if="regenSbImagesForAsset.has('prop-' + prop.id) && regenSbImagesProgress['prop-' + prop.id]" class="asl-progress">
                      {{ regenSbImagesProgress['prop-' + prop.id].current }}/{{ regenSbImagesProgress['prop-' + prop.id].total }}
                    </span>
                    <el-button
                      size="small"
                      class="asl-regen-btn"
                      :loading="regenSbImagesForAsset.has('prop-' + prop.id)"
                      @click="onRegenAffectedSbImages('prop-' + prop.id, getPropAffectedStoryboards(prop.id))"
                    >
                      <span v-if="!regenSbImagesForAsset.has('prop-' + prop.id)">↻ 重新生成分镜图</span>
                    </el-button>
                  </div>
                </div>
                <div class="asset-cover-wrap">
                  <div
                    class="asset-cover"
                    :class="{ 'asset-cover--clickable': hasAssetImage(prop), 'asset-cover--dragover': dragOverResourceKey === 'prop-' + prop.id }"
                    role="button"
                    tabindex="0"
                    @click="hasAssetImage(prop) && openImagePreview(assetImageUrl(prop))"
                    @dragover="onResourceDragOver($event, 'prop', prop.id)"
                    @dragleave="onResourceDragLeave($event, 'prop-' + prop.id)"
                    @drop="onResourceDrop($event, 'prop', prop.id)"
                  >
                    <img v-if="hasAssetImage(prop)" :src="assetImageUrl(prop)" class="cover-img" alt="" />
                    <div v-else-if="prop.error_msg || prop.errorMsg" class="cover-placeholder error" :title="prop.error_msg || prop.errorMsg">{{ prop.error_msg || prop.errorMsg }}</div>
                    <div v-else class="cover-placeholder">暂无图</div>
                    <div v-if="dragOverResourceKey === 'prop-' + prop.id" class="asset-cover-drop-hint">松开上传</div>
                  </div>
                  <div v-if="parseExtraImages(prop).length" class="extra-images-strip">
                    <div v-for="ep in parseExtraImages(prop)" :key="ep" class="extra-thumb" title="点击设为主图（悬停左上角可放大预览）">
                      <img :src="localPathToUrl(ep)" alt="" @click="onSetPrimaryImage('prop', prop, ep)" />
                      <button class="thumb-preview-btn" title="放大预览" @click.stop="openImagePreview(localPathToUrl(ep))">
                        <el-icon :size="10"><ZoomIn /></el-icon>
                      </button>
                      <button class="extra-thumb-remove" title="移除" @click.stop="onRemoveExtraImage('prop', prop, ep)">×</button>
                    </div>
                  </div>
                  <div class="asset-cover-actions">
                    <el-tooltip :content="usesFourViews(prop) ? '四视图道具（前/侧/后/顶，纯色无缝背景）' : '单图道具（纯色无缝背景）'" placement="top">
                      <el-button type="primary" size="small" :loading="generatingPropIds.has(prop.id)" :disabled="referenceBatchRunning || referenceSuggestionsRunning || savingReferenceModeIds.has('prop:' + prop.id)" @click="onGeneratePropImage(prop)">
                        <el-icon v-if="!generatingPropIds.has(prop.id)"><MagicStick /></el-icon>
                        AI 生成
                      </el-button>
                    </el-tooltip>
                    <el-button type="success" size="small" :loading="uploadingResourceId === 'prop-' + prop.id" @click="onUploadResourceClick('prop', prop.id)">
                      <el-icon v-if="uploadingResourceId !== 'prop-' + prop.id"><Upload /></el-icon>
                      上传
                    </el-button>
                  </div>
                </div>
              </div>
              <div v-if="props.length === 0" class="empty-tip">暂无道具，可从剧本提取或添加</div>
            </div>
          </div>
        </div>

        <!-- 场景生成 -->
        <div id="anchor-scenes" class="resource-block card">
          <div class="collapse-header resource-block-header" @click="scenesBlockCollapsed = !scenesBlockCollapsed">
            <h3 class="resource-block-title">场景生成</h3>
            <el-icon class="collapse-icon"><ArrowUp v-if="!scenesBlockCollapsed" /><ArrowDown v-else /></el-icon>
          </div>
          <div v-show="!scenesBlockCollapsed" class="resource-block-body">
            <div class="asset-actions">
              <el-button type="primary" size="small" :loading="scenesExtracting" :disabled="!currentEpisodeId || referenceBatchRunning" @click="onExtractScenes">
                从剧本提取场景
              </el-button>
              <el-button size="small" :disabled="!currentEpisodeId || referenceBatchRunning || pipelineRunning || charactersGenerating || propsExtracting || scenesExtracting || referenceSuggestionsRunning || savingReferenceModeIds.size > 0" @click="referenceImageBatch?.start('scene')">批量生成参考图</el-button>
              <el-button size="small" :disabled="!dramaId" @click="openAddScene">添加场景</el-button>
              <el-button size="small" @click="showSceneLibrary = true">本剧场景库</el-button>
            </div>
            <div class="asset-list asset-list-two">
              <div v-for="scene in scenes" :key="scene.id" class="asset-item asset-item-left-right">
                <div class="asset-info">
                  <div class="asset-name">
                    <span style="display:inline-flex;align-items:center;gap:4px;flex:1;min-width:0;overflow:hidden">
                      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ scene.location }}</span>
                      <el-tooltip v-if="getAssetObsoleteInfo('scene', scene)" :content="getAssetObsoleteInfo('scene', scene).reason" placement="top">
                        <el-tag size="small" type="danger" effect="light" style="flex-shrink:0;padding:0 4px;font-size:10px;height:18px;line-height:18px;cursor:help;color:#f56c6c;border-color:#fde2e2;background:#fef0f0">
                          ⚠️ 建议删除
                        </el-tag>
                      </el-tooltip>
                    </span>
                    <el-button type="danger" text size="small" class="btn-delete-icon" title="删除" @click="onDeleteScene(scene)">
                      <el-icon><Delete /></el-icon>
                    </el-button>
                  </div>
                  <div class="asset-desc-full">{{ scene.description || scene.prompt || scene.time || '暂无描述' }}</div>
                  <ReferenceImageMode :resource="scene" kind="scene" :disabled="referenceBatchRunning || referenceSuggestionsRunning || pipelineRunning || generatingSceneIds.has(scene.id)" @saving-change="onReferenceModeSaving('scene', scene.id, $event)" />
                  <div class="asset-btns">
                    <el-button size="small" @click="editScene(scene)">编辑</el-button>
                    <el-button size="small" :loading="addingSceneToLibraryId === scene.id" :disabled="!hasAssetImage(scene)" @click="onAddSceneToLibrary(scene)">
                      加入本剧库
                    </el-button>
                    <el-button size="small" :loading="addingSceneToMaterialId === scene.id" :disabled="!hasAssetImage(scene)" @click="onAddSceneToMaterialLibrary(scene)">
                      加入素材库
                    </el-button></div>
                  <div v-if="getSceneAffectedStoryboards(scene.id).length" class="asset-storyboard-link">
                    <span class="asl-label">影响的分镜：</span>
                    <span
                      v-for="sb in getSceneAffectedStoryboards(scene.id)"
                      :key="sb.id"
                      class="asl-chip"
                      title="点击跳转到该分镜"
                      @click="scrollToStoryboard(sb.id)"
                    >#{{ sb.storyboard_number }}</span>
                    <span v-if="regenSbImagesForAsset.has('scene-' + scene.id) && regenSbImagesProgress['scene-' + scene.id]" class="asl-progress">
                      {{ regenSbImagesProgress['scene-' + scene.id].current }}/{{ regenSbImagesProgress['scene-' + scene.id].total }}
                    </span>
                    <el-button
                      size="small"
                      class="asl-regen-btn"
                      :loading="regenSbImagesForAsset.has('scene-' + scene.id)"
                      @click="onRegenAffectedSbImages('scene-' + scene.id, getSceneAffectedStoryboards(scene.id))"
                    >
                      <span v-if="!regenSbImagesForAsset.has('scene-' + scene.id)">↻ 重新生成分镜图</span>
                    </el-button>
                  </div>
                </div>
                <div class="asset-cover-wrap">
                  <div
                    class="asset-cover"
                    :class="{ 'asset-cover--clickable': hasAssetImage(scene), 'asset-cover--dragover': dragOverResourceKey === 'scene-' + scene.id }"
                    role="button"
                    tabindex="0"
                    @click="hasAssetImage(scene) && openImagePreview(assetImageUrl(scene))"
                    @dragover="onResourceDragOver($event, 'scene', scene.id)"
                    @dragleave="onResourceDragLeave($event, 'scene-' + scene.id)"
                    @drop="onResourceDrop($event, 'scene', scene.id)"
                  >
                    <img v-if="hasAssetImage(scene)" :src="assetImageUrl(scene)" class="cover-img" alt="" />
                    <div v-else-if="scene.error_msg || scene.errorMsg" class="cover-placeholder error" :title="scene.error_msg || scene.errorMsg">{{ scene.error_msg || scene.errorMsg }}</div>
                    <div v-else class="cover-placeholder">暂无图</div>
                    <div v-if="dragOverResourceKey === 'scene-' + scene.id" class="asset-cover-drop-hint">松开上传</div>
                  </div>
                  <div v-if="parseExtraImages(scene).length" class="extra-images-strip">
                    <div v-for="ep in parseExtraImages(scene)" :key="ep" class="extra-thumb" title="点击设为主图（悬停左上角可放大预览）">
                      <img :src="localPathToUrl(ep)" alt="" @click="onSetPrimaryImage('scene', scene, ep)" />
                      <button class="thumb-preview-btn" title="放大预览" @click.stop="openImagePreview(localPathToUrl(ep))">
                        <el-icon :size="10"><ZoomIn /></el-icon>
                      </button>
                      <button class="extra-thumb-remove" title="移除" @click.stop="onRemoveExtraImage('scene', scene, ep)">×</button>
                    </div>
                  </div>
                  <div class="asset-cover-actions">
                    <el-tooltip :content="usesFourViews(scene) ? '四宫格场景（正/侧/俯/仰）' : '单图场景'" placement="top">
                      <el-button type="primary" size="small" :loading="generatingSceneIds.has(scene.id)" :disabled="referenceBatchRunning || referenceSuggestionsRunning || savingReferenceModeIds.has('scene:' + scene.id)" @click="onGenerateSceneImage(scene)">
                        <el-icon v-if="!generatingSceneIds.has(scene.id)"><MagicStick /></el-icon>
                        AI 生成
                      </el-button>
                    </el-tooltip>
                    <el-button type="success" size="small" :loading="uploadingResourceId === 'scene-' + scene.id" @click="onUploadResourceClick('scene', scene.id)">
                      <el-icon v-if="uploadingResourceId !== 'scene-' + scene.id"><Upload /></el-icon>
                      上传
                    </el-button>
                  </div>
                </div>
              </div>
              <div v-if="scenes.length === 0" class="empty-tip">暂无场景，请从剧本提取</div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 添加道具简单弹窗 -->
    <el-dialog v-model="showAddProp" title="添加道具" width="600px" @close="() => { addPropForm = { name: '', type: '', description: '', prompt: '' }; addPropAddRefImage = null }">
      <el-form label-width="90px">
        <el-form-item label="参考图">
          <div class="ref-image-zone">
            <div class="ref-image-box" @click="addPropAddRefFileInput?.click()" @drop.prevent="onRefImageDrop2('addProp', $event)" @dragover.prevent>
              <img v-if="addPropAddRefImage" :src="addPropAddRefImage.dataUrl" class="ref-preview-img" />
              <div v-else class="ref-upload-hint"><span class="ref-upload-icon">🖼</span><span>点击或拖入参考图</span></div>
            </div>
            <div v-if="addPropAddRefImage" class="ref-actions">
              <el-button type="primary" size="small" :loading="extractingPropAddDesc" @click="doExtractFromRef2('addProp')">提取特征描述</el-button>
              <el-button size="small" @click="addPropAddRefImage = null">移除</el-button>
            </div>
          </div>
        </el-form-item>
        <el-form-item label="名称" required>
          <div style="display:flex;gap:8px;width:100%">
            <el-input v-model="addPropForm.name" placeholder="道具名称（如：战术护目镜、急救药剂包）" />
            <el-button type="primary" plain :loading="aiCompletingProp" :disabled="!addPropForm.name?.trim()" @click="onAiCompleteProp('add')">
              🪄 AI 结合剧本补全
            </el-button>
          </div>
        </el-form-item>
        <el-form-item label="类型">
          <el-input v-model="addPropForm.type" placeholder="如：武器、战术装备、证物、日常" />
        </el-form-item>
        <el-form-item label="物理尺寸">
          <el-input v-model="addPropForm.physical_scale" placeholder="真实物理尺度（如：长约18cm单兵佩戴护目镜，贴合面容）" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="addPropForm.description" type="textarea" :rows="3" placeholder="描述" />
        </el-form-item>
        <el-form-item label="图生提示词">
          <el-input v-model="addPropForm.prompt" type="textarea" :rows="2" placeholder="用于 AI 生成图片的提示词" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showAddProp = false">取消</el-button>
        <el-button type="primary" :loading="addPropSaving" :disabled="!addPropForm.name.trim()" @click="submitAddProp">确定</el-button>
      </template>
    </el-dialog>

    <!-- 添加/编辑角色弹窗 -->
    <el-dialog v-model="showEditCharacter" :title="editCharacterForm?.id ? '编辑角色' : '添加角色'" width="75%" top="4vh" append-to-body class="asset-edit-dialog" @close="onCloseCharDialog">
      <el-form v-if="editCharacterForm" label-width="90px">
        <!-- 参考图上传区（新增/编辑均显示） -->
        <el-form-item label="参考图">
          <div class="ref-image-zone">
            <div class="ref-image-box" @click="addCharRefFileInput?.click()" @drop.prevent="onRefImageDrop('character', $event)" @dragover.prevent>
              <!-- 优先：刚上传的新参考图 -->
              <img v-if="addCharRefImage" :src="addCharRefImage.dataUrl" class="ref-preview-img" />
              <!-- 次之：已保存的参考图 -->
              <img v-else-if="editCharacterForm.ref_image"
                :src="editCharacterForm.ref_image.startsWith('http') ? editCharacterForm.ref_image : '/static/' + editCharacterForm.ref_image"
                class="ref-preview-img" />
              <!-- 最后：主图（半透明，提示可上传参考图替代） -->
              <img v-else-if="editCharacterForm.id && (editCharacterForm.image_url || editCharacterForm.local_path)"
                :src="assetImageUrl(editCharacterForm)"
                class="ref-preview-img" style="opacity:0.5" />
              <div v-else class="ref-upload-hint"><span class="ref-upload-icon">🖼</span><span>点击或拖入参考图</span></div>
            </div>
            <div v-if="addCharRefImage" class="ref-actions">
              <el-button type="primary" size="small" :loading="extractingCharAppearance" @click="doExtractFromRef('character')">提取特征描述</el-button>
              <el-button size="small" @click="addCharRefImage = null">移除</el-button>
            </div>
            <div v-else-if="editCharacterForm.ref_image" class="ref-actions">
              <el-button type="primary" size="small" :loading="extractingCharAppearance" @click="doExtractCharFromImage">从参考图提取描述</el-button>
              <el-button size="small" @click="clearCharRefImage">移除参考图</el-button>
            </div>
            <div v-else-if="editCharacterForm.id && (editCharacterForm.image_url || editCharacterForm.local_path) && !editCharacterForm.appearance" class="ref-actions">
              <el-button size="small" :loading="extractingCharAppearance" @click="doExtractCharFromImage">从主图提取描述</el-button>
            </div>
          </div>
          <div class="section-desc" style="margin-top: 6px">上传人物照片后先保存，再点击「AI生成」；照片用于保持相貌，服装与画风按角色和项目设定生成。「提取特征描述」为可选操作。</div>
        </el-form-item>
        <el-form-item label="名称" required>
          <div style="display:flex;gap:8px;width:100%">
            <el-input v-model="editCharacterForm.name" placeholder="角色名称（如：红狼、蜂医、露娜）" />
            <el-button type="primary" plain :loading="aiCompletingCharacter" :disabled="!editCharacterForm.name?.trim()" @click="onAiCompleteCharacter">
              🪄 AI 结合剧本补全
            </el-button>
          </div>
        </el-form-item>
        <el-form-item label="身份/定位">
          <el-select v-model="editCharacterForm.role" placeholder="请选择角色类型" style="width:200px">
            <el-option value="main" label="主角" />
            <el-option value="supporting" label="配角" />
            <el-option value="minor" label="次要角色" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="editCharacterForm.id" label="配音音色">
          <CharacterVoiceSettings
            v-if="showEditCharacter"
            ref="characterVoiceEditor"
            :drama-id="dramaId"
            :character-id="editCharacterForm.id"
            @profile="onDubbingProfile"
          />
        </el-form-item>
        <el-form-item v-else label="配音音色">
          <span style="font-size:12px;color:#909399">添加人物后会自动分配音色，可在编辑人物时改选和试听。</span>
        </el-form-item>
        <el-form-item v-if="editCharacterForm.id" label="默认服装">
          <WardrobeSettings v-if="showEditCharacter" :key="'wardrobe-character-' + editCharacterForm.id" :drama-id="dramaId" :character-id="editCharacterForm.id" />
        </el-form-item>
        <el-form-item label="外貌描述">
          <el-input v-model="editCharacterForm.appearance" type="textarea" :autosize="{ minRows: 4, maxRows: 10 }" placeholder="用于 AI 生成图像的外貌描述，尽量详细" />
        </el-form-item>
        <el-form-item label="简介">
          <el-input v-model="editCharacterForm.description" type="textarea" :autosize="{ minRows: 3, maxRows: 8 }" placeholder="角色背景简介，供剧本生成参考" />
        </el-form-item>
        <el-form-item v-if="editCharacterForm.id">
          <template #label>
            <span style="font-size:12px;line-height:1.4;white-space:normal;word-break:break-all;display:inline-block;width:90px">图生提示词</span>
          </template>
          <div style="width:100%">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
              <span style="font-size:12px;color:#909399">AI 润色后的最终提示词，生成四视图图片时直接使用；可手动修改</span>
              <el-button
                size="small"
                :loading="editCharacterPromptGenerating"
                @click="doGenerateCharacterPrompt"
              >重新生成提示词</el-button>
            </div>
            <el-input
              v-model="editCharacterForm.polished_prompt"
              type="textarea"
              :autosize="{ minRows: 5, maxRows: 16 }"
              :placeholder="editCharacterPromptGenerating ? 'AI 正在生成提示词，请稍候…' : '点击「重新生成提示词」由 AI 自动生成，或直接在此输入'"
              :disabled="editCharacterPromptGenerating"
              style="font-size:12px"
            />
          </div>
        </el-form-item>
        <!-- P0-2: 视觉锚点（identity_anchors） -->
        <el-form-item v-if="editCharacterForm.id" label="视觉锚点">
          <div style="width:100%">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
              <span style="font-size:12px;color:#909399">AI 从外貌描述提炼的6层视觉特征，用于保持生成图片角色一致性</span>
              <el-button
                size="small"
                :loading="extractingAnchors"
                :disabled="!editCharacterForm.appearance"
                @click="extractIdentityAnchors"
              >提炼视觉锚点</el-button>
            </div>
            <el-input
              v-if="editCharacterForm.identity_anchors"
              :model-value="typeof editCharacterForm.identity_anchors === 'string'
                ? editCharacterForm.identity_anchors
                : JSON.stringify(editCharacterForm.identity_anchors, null, 2)"
              type="textarea"
              :rows="4"
              readonly
              style="font-size:11px;font-family:monospace"
              placeholder="点击「提炼视觉锚点」生成"
            />
            <div v-else style="font-size:12px;color:#c0c4cc;padding:4px 0">暂无锚点，点击「提炼视觉锚点」自动提炼</div>
          </div>
        </el-form-item>
        <el-form-item v-if="editCharacterForm.id" label="多阶段造型">
          <CharacterStagesEditor :key="editCharacterForm.id" v-model="editCharacterForm.stages" :drama-id="dramaId" :character-id="editCharacterForm.id" @uploading="characterStagesUploading=$event" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showEditCharacter = false">取消</el-button>
        <el-button type="primary" :loading="editCharacterSaving" :disabled="!editCharacterForm?.name?.trim() || characterStagesUploading" @click="submitEditCharacter">{{ editCharacterForm?.id ? '保存' : '添加' }}</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="showCharSd2Cert"
      title="SD2 认证详情"
      width="min(720px, 92vw)"
      destroy-on-close
      class="sd2-cert-dialog"
    >
      <template v-if="charSd2CertPayload">
        <el-descriptions :column="1" border size="small" class="sd2-cert-desc">
          <el-descriptions-item label="素材 ID">
            <span class="sd2-cert-value">{{ charSd2CertPayload.hub_asset_id || '—' }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="asset_url">
            <code class="sd2-cert-value">{{ charSd2CertPayload.asset_url || '—' }}</code>
          </el-descriptions-item>
          <el-descriptions-item label="状态">
            <span class="sd2-cert-value">{{ charSd2CertPayload.status || '—' }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="注册图片 URL">
            <span class="sd2-cert-value">{{ charSd2CertPayload.source_image_url || '—' }}</span>
          </el-descriptions-item>
          <el-descriptions-item v-if="charSd2CertPayload.sd2_provider" label="认证提供方">
            <span class="sd2-cert-value">{{ charSd2CertPayload.sd2_provider }}</span>
          </el-descriptions-item>
        </el-descriptions>
      </template>
      <template #footer>
        <el-button @click="showCharSd2Cert = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- 编辑道具弹窗 -->
    <el-dialog v-model="showEditProp" :title="editPropForm?.id ? '编辑道具' : '添加道具'" width="75%" top="4vh" append-to-body class="asset-edit-dialog" @close="onClosePropDialog">
      <el-form v-if="editPropForm" label-width="90px">
        <!-- 参考图上传区（新增/编辑均显示） -->
        <el-form-item label="参考图">
          <div class="ref-image-zone">
            <div class="ref-image-box" @click="addPropRefFileInput?.click()" @drop.prevent="onRefImageDrop('prop', $event)" @dragover.prevent>
              <img v-if="addPropRefImage" :src="addPropRefImage.dataUrl" class="ref-preview-img" />
              <img v-else-if="editPropForm.ref_image"
                :src="editPropForm.ref_image.startsWith('http') ? editPropForm.ref_image : '/static/' + editPropForm.ref_image"
                class="ref-preview-img" />
              <img v-else-if="editPropForm.id && (editPropForm.image_url || editPropForm.local_path)"
                :src="assetImageUrl(editPropForm)" class="ref-preview-img" style="opacity:0.5" />
              <div v-else class="ref-upload-hint"><span class="ref-upload-icon">🖼</span><span>点击或拖入参考图</span></div>
            </div>
            <div v-if="addPropRefImage" class="ref-actions">
              <el-button type="primary" size="small" :loading="extractingPropDesc" @click="doExtractFromRef('prop')">提取特征描述</el-button>
              <el-button size="small" @click="addPropRefImage = null">移除</el-button>
            </div>
            <div v-else-if="editPropForm.ref_image" class="ref-actions">
              <el-button type="primary" size="small" :loading="extractingPropDesc" @click="doExtractPropFromImage">从参考图提取描述</el-button>
              <el-button size="small" @click="clearPropRefImage">移除参考图</el-button>
            </div>
            <div v-else-if="editPropForm.id && (editPropForm.image_url || editPropForm.local_path) && !editPropForm.description" class="ref-actions">
              <el-button size="small" :loading="extractingPropDesc" @click="doExtractPropFromImage">从主图提取描述</el-button>
            </div>
          </div>
        </el-form-item>
        <el-form-item label="名称" required>
          <div style="display:flex;gap:8px;width:100%">
            <el-input v-model="editPropForm.name" placeholder="道具名称" />
            <el-button type="primary" plain :loading="aiCompletingProp" :disabled="!editPropForm.name?.trim()" @click="onAiCompleteProp('edit')">
              🪄 AI 结合剧本补全
            </el-button>
          </div>
        </el-form-item>
        <el-form-item label="类型">
          <el-input v-model="editPropForm.type" placeholder="如：物品、建筑" />
        </el-form-item>
        <el-form-item label="物理尺寸">
          <el-input v-model="editPropForm.physical_scale" placeholder="真实物理尺度（如：长约18cm单兵佩戴护目镜，贴合面容）" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="editPropForm.description" type="textarea" :autosize="{ minRows: 3, maxRows: 8 }" placeholder="道具描述" />
        </el-form-item>
        <el-form-item label="图生提示词">
          <div style="width:100%">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
              <span style="font-size:12px;color:#909399">AI 润色后的图片提示词，生成图片时直接使用；可手动修改</span>
              <el-button size="small" :loading="editPropPromptGenerating" @click="doGeneratePropPrompt">重新生成提示词</el-button>
            </div>
            <el-input
              v-model="editPropForm.prompt"
              type="textarea"
              :autosize="{ minRows: 5, maxRows: 16 }"
              :placeholder="editPropPromptGenerating ? 'AI 正在生成提示词，请稍候…' : '点击「重新生成提示词」由 AI 自动生成，或直接在此输入'"
              :disabled="editPropPromptGenerating"
            />
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showEditProp = false">取消</el-button>
        <el-button type="primary" :loading="editPropSaving" :disabled="!editPropForm?.name?.trim()" @click="submitEditProp">保存</el-button>
      </template>
    </el-dialog>

    <!-- 添加/编辑场景弹窗 -->
    <el-dialog v-model="showEditScene" :title="editSceneForm?.id ? '编辑场景' : '添加场景'" width="75%" top="4vh" append-to-body class="asset-edit-dialog" @close="onCloseSceneDialog">
      <el-form v-if="editSceneForm" label-width="90px">
        <!-- 参考图上传区（新增/编辑均显示） -->
        <el-form-item label="参考图">
          <div class="ref-image-zone">
            <div class="ref-image-box" @click="addSceneRefFileInput?.click()" @drop.prevent="onRefImageDrop('scene', $event)" @dragover.prevent>
              <img v-if="addSceneRefImage" :src="addSceneRefImage.dataUrl" class="ref-preview-img" />
              <img v-else-if="editSceneForm.ref_image"
                :src="editSceneForm.ref_image.startsWith('http') ? editSceneForm.ref_image : '/static/' + editSceneForm.ref_image"
                class="ref-preview-img" />
              <img v-else-if="editSceneForm.id && (editSceneForm.image_url || editSceneForm.local_path)"
                :src="assetImageUrl(editSceneForm)" class="ref-preview-img" style="opacity:0.5" />
              <div v-else class="ref-upload-hint"><span class="ref-upload-icon">🖼</span><span>点击或拖入参考图</span></div>
            </div>
            <div v-if="addSceneRefImage" class="ref-actions">
              <el-button type="primary" size="small" :loading="extractingSceneDesc" @click="doExtractFromRef('scene')">提取特征描述</el-button>
              <el-button size="small" @click="addSceneRefImage = null">移除</el-button>
            </div>
            <div v-else-if="editSceneForm.ref_image" class="ref-actions">
              <el-button type="primary" size="small" :loading="extractingSceneDesc" @click="doExtractSceneFromImage">从参考图提取描述</el-button>
              <el-button size="small" @click="clearSceneRefImage">移除参考图</el-button>
            </div>
            <div v-else-if="editSceneForm.id && (editSceneForm.image_url || editSceneForm.local_path) && !editSceneForm.prompt" class="ref-actions">
              <el-button size="small" :loading="extractingSceneDesc" @click="doExtractSceneFromImage">从主图提取描述</el-button>
            </div>
          </div>
        </el-form-item>
        <el-form-item label="地点" required>
          <div style="display:flex;gap:8px;width:100%">
            <el-input v-model="editSceneForm.location" placeholder="如：废弃工厂、家庭书房" />
            <el-button type="primary" plain :loading="aiCompletingScene" :disabled="!editSceneForm.location?.trim()" @click="onAiCompleteScene">
              🪄 AI 结合剧本补全
            </el-button>
          </div>
        </el-form-item>
        <el-form-item label="时间">
          <el-input v-model="editSceneForm.time" placeholder="如：白天、傍晚" />
        </el-form-item>
        <el-form-item label="场景描述">
          <el-input v-model="editSceneForm.prompt" type="textarea" :autosize="{ minRows: 3, maxRows: 8 }" placeholder="场景的简要描述，供 AI 生成四视图时参考" />
        </el-form-item>
        <el-form-item v-if="editSceneForm.id">
          <template #label>
            <span style="font-size:12px;line-height:1.4;white-space:normal;word-break:break-all;display:inline-block;width:90px">单图提示词</span>
          </template>
          <div style="width:100%">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
              <span style="font-size:12px;color:#909399">单图场景的完整图片提示词（不含四宫格布局），生图时直接使用；可手动修改</span>
              <el-button size="small" :loading="editScenePromptGenerating" @click="doGenerateSceneSinglePrompt">重新生成提示词</el-button>
            </div>
            <el-input
              v-model="editSceneForm.polished_prompt_single"
              type="textarea"
              :autosize="{ minRows: 5, maxRows: 16 }"
              placeholder="单图场景提示词，点击场景列表的「AI 生成」按钮（不勾选四宫格）后会自动生成"
              style="font-size:12px"
            />
          </div>
        </el-form-item>
        <el-form-item v-if="editSceneForm.id">
          <template #label>
            <span style="font-size:12px;line-height:1.4;white-space:normal;word-break:break-all;display:inline-block;width:90px">四视图提示词</span>
          </template>
          <div style="width:100%">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
              <span style="font-size:12px;color:#909399">AI 生成的完整四视图图片提示词，生图时直接使用；可手动修改</span>
              <el-button size="small" :loading="editScenePromptGenerating" @click="doGenerateScenePrompt">重新生成提示词</el-button>
            </div>
            <el-input
              v-model="editSceneForm.polished_prompt"
              type="textarea"
              :autosize="{ minRows: 5, maxRows: 16 }"
              :placeholder="editScenePromptGenerating ? 'AI 正在生成四视图提示词，请稍候…' : '点击「重新生成提示词」由 AI 自动生成，或直接在此输入'"
              :disabled="editScenePromptGenerating"
              style="font-size:12px"
            />
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showEditScene = false">取消</el-button>
        <el-button type="primary" :loading="editSceneSaving" :disabled="!editSceneForm?.location?.trim()" @click="submitEditScene">{{ editSceneForm?.id ? '保存' : '添加' }}</el-button>
      </template>
    </el-dialog>

    <!-- 角色资源库 -->
    <el-dialog v-model="showCharLibrary" title="角色资源库" width="720px" destroy-on-close class="library-dialog" @open="onCharLibraryDialogOpen">
      <el-tabs v-model="charLibraryTab" class="char-library-tabs" @tab-change="onCharLibraryTabChange">
        <el-tab-pane label="本剧角色库" name="library">
          <div class="library-toolbar">
            <el-input v-model="charLibraryKeyword" placeholder="搜索名称或描述" clearable style="width: 200px" @input="debouncedLoadCharLibrary()" />
          </div>
          <div v-loading="charLibraryLoading" class="library-list">
            <div v-for="item in charLibraryList" :key="'lib-' + item.id" class="library-item">
              <div class="library-item-cover" @click="openImagePreview(assetImageUrl(item))">
                <img v-if="item.image_url || item.local_path" :src="assetImageUrl(item)" alt="" />
                <span v-else class="library-item-placeholder">暂无图</span>
              </div>
              <div class="library-item-info">
                <div class="library-item-name">{{ item.name || '未命名' }}</div>
                <div class="library-item-desc">{{ (item.description || '').slice(0, 60) }}{{ (item.description || '').length > 60 ? '…' : '' }}</div>
                <div class="library-item-actions">
                  <el-button size="small" type="primary" :loading="isCharAddToEpisodeLoading('library', item.id)" :disabled="!currentEpisodeId" @click="onAddCharFromLibrary(item)">加入本集</el-button>
                  <el-button size="small" @click="openEditCharLibrary(item)">编辑</el-button>
                  <el-button size="small" type="danger" plain @click="onDeleteCharLibrary(item)">删除</el-button>
                </div>
              </div>
            </div>
            <div v-if="!charLibraryLoading && charLibraryList.length === 0" class="library-empty">暂无本剧角色库记录，可将本剧角色「加入本剧库」后在此查看</div>
          </div>
          <div class="library-pagination">
            <el-pagination
              v-model:current-page="charLibraryPage"
              v-model:page-size="charLibraryPageSize"
              :total="charLibraryTotal"
              :page-sizes="[10, 20, 50]"
              layout="total, sizes, prev, pager, next"
              @current-change="loadCharLibraryList"
              @size-change="loadCharLibraryList"
            />
          </div>
        </el-tab-pane>

        <el-tab-pane label="本剧所有角色" name="drama">
          <div class="library-toolbar">
            <el-input v-model="dramaAllCharKeyword" placeholder="搜索名称或描述" clearable style="width: 200px" @input="debouncedLoadDramaAllCharList()" />
          </div>
          <div v-loading="dramaAllCharLoading" class="library-list">
            <div v-for="item in dramaAllCharList" :key="'drama-' + item.id" class="library-item">
              <div class="library-item-cover" @click="openImagePreview(assetImageUrl(item))">
                <img v-if="item.image_url || item.local_path" :src="assetImageUrl(item)" alt="" />
                <span v-else class="library-item-placeholder">暂无图</span>
              </div>
              <div class="library-item-info">
                <div class="library-item-name">
                  {{ item.name || '未命名' }}
                  <el-tag v-if="item.role" size="small" type="info" style="margin-left: 6px">{{ charRoleLabel(item.role) }}</el-tag>
                </div>
                <div class="library-item-desc">{{ (item.description || item.appearance || '').slice(0, 60) }}{{ (item.description || item.appearance || '').length > 60 ? '…' : '' }}</div>
                <div class="library-item-actions">
                  <el-button size="small" type="primary" :loading="isCharAddToEpisodeLoading('drama', item.id)" :disabled="!currentEpisodeId" @click="onAddDramaCharToEpisode(item)">加入本集</el-button>
                </div>
              </div>
            </div>
            <div v-if="!dramaAllCharLoading && dramaAllCharList.length === 0" class="library-empty">本剧暂无制作角色，请先在角色面板创建</div>
          </div>
          <div class="library-pagination">
            <el-pagination
              v-model:current-page="dramaAllCharPage"
              v-model:page-size="dramaAllCharPageSize"
              :total="dramaAllCharTotal"
              :page-sizes="[10, 20, 50]"
              layout="total, sizes, prev, pager, next"
              @current-change="loadDramaAllCharList"
              @size-change="loadDramaAllCharList"
            />
          </div>
        </el-tab-pane>
      </el-tabs>
      <template #footer>
        <el-button @click="showCharLibrary = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- 编辑公共角色 -->
    <el-dialog v-model="showEditCharLibrary" title="编辑公共角色" width="440px" @close="editCharLibraryForm = null">
      <el-form v-if="editCharLibraryForm" label-width="80px">
        <el-form-item label="名称">
          <el-input v-model="editCharLibraryForm.name" placeholder="角色名称" />
        </el-form-item>
        <el-form-item label="分类">
          <el-input v-model="editCharLibraryForm.category" placeholder="可选" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="editCharLibraryForm.description" type="textarea" :rows="3" placeholder="可选" />
        </el-form-item>
        <el-form-item label="标签">
          <el-input v-model="editCharLibraryForm.tags" placeholder="可选，逗号分隔" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showEditCharLibrary = false">取消</el-button>
        <el-button type="primary" :loading="editCharLibrarySaving" @click="submitEditCharLibrary">保存</el-button>
      </template>
    </el-dialog>

    <!-- 道具资源库 -->
    <el-dialog v-model="showPropLibrary" title="道具资源库" width="720px" destroy-on-close class="library-dialog" @open="onPropLibraryDialogOpen">
      <el-tabs v-model="propLibraryTab" class="char-library-tabs" @tab-change="onPropLibraryTabChange">
        <el-tab-pane label="本剧道具库" name="library">
          <div class="library-toolbar">
            <el-input v-model="propLibraryKeyword" placeholder="搜索名称或描述" clearable style="width: 200px" @input="debouncedLoadPropLibrary()" />
          </div>
          <div v-loading="propLibraryLoading" class="library-list">
            <div v-for="item in propLibraryList" :key="'plib-' + item.id" class="library-item">
              <div class="library-item-cover" @click="openImagePreview(assetImageUrl(item))">
                <img v-if="item.image_url || item.local_path" :src="assetImageUrl(item)" alt="" />
                <span v-else class="library-item-placeholder">暂无图</span>
              </div>
              <div class="library-item-info">
                <div class="library-item-name">{{ item.name || '未命名' }}</div>
                <div class="library-item-desc">{{ (item.description || item.prompt || '').slice(0, 60) }}{{ (item.description || item.prompt || '').length > 60 ? '…' : '' }}</div>
                <div class="library-item-actions">
                  <el-button size="small" type="primary" :loading="isPropAddToEpisodeLoading('library', item.id)" :disabled="!currentEpisodeId" @click="onAddPropFromLibrary(item)">加入本集</el-button>
                  <el-button size="small" @click="openEditPropLibrary(item)">编辑</el-button>
                  <el-button size="small" type="danger" plain @click="onDeletePropLibrary(item)">删除</el-button>
                </div>
              </div>
            </div>
            <div v-if="!propLibraryLoading && propLibraryList.length === 0" class="library-empty">暂无本剧道具库记录，可将本剧道具「加入本剧库」后在此查看</div>
          </div>
          <div class="library-pagination">
            <el-pagination v-model:current-page="propLibraryPage" v-model:page-size="propLibraryPageSize" :total="propLibraryTotal" :page-sizes="[10, 20, 50]" layout="total, sizes, prev, pager, next" @current-change="loadPropLibraryList" @size-change="loadPropLibraryList" />
          </div>
        </el-tab-pane>
        <el-tab-pane label="本剧所有道具" name="drama">
          <div class="library-toolbar">
            <el-input v-model="dramaAllPropKeyword" placeholder="搜索名称或描述" clearable style="width: 200px" @input="debouncedLoadDramaAllPropList()" />
          </div>
          <div v-loading="dramaAllPropLoading" class="library-list">
            <div v-for="item in dramaAllPropList" :key="'pdr-' + item.id" class="library-item">
              <div class="library-item-cover" @click="openImagePreview(assetImageUrl(item))">
                <img v-if="item.image_url || item.local_path" :src="assetImageUrl(item)" alt="" />
                <span v-else class="library-item-placeholder">暂无图</span>
              </div>
              <div class="library-item-info">
                <div class="library-item-name">{{ item.name || '未命名' }}</div>
                <div class="library-item-desc">{{ (item.description || item.prompt || '').slice(0, 60) }}{{ (item.description || item.prompt || '').length > 60 ? '…' : '' }}</div>
                <div class="library-item-actions">
                  <el-button size="small" type="primary" :loading="isPropAddToEpisodeLoading('drama', item.id)" :disabled="!currentEpisodeId" @click="onAddDramaPropToEpisode(item)">加入本集</el-button>
                </div>
              </div>
            </div>
            <div v-if="!dramaAllPropLoading && dramaAllPropList.length === 0" class="library-empty">本剧暂无制作道具，请先在道具面板创建</div>
          </div>
          <div class="library-pagination">
            <el-pagination v-model:current-page="dramaAllPropPage" v-model:page-size="dramaAllPropPageSize" :total="dramaAllPropTotal" :page-sizes="[10, 20, 50]" layout="total, sizes, prev, pager, next" @current-change="loadDramaAllPropList" @size-change="loadDramaAllPropList" />
          </div>
        </el-tab-pane>
      </el-tabs>
      <template #footer>
        <el-button @click="showPropLibrary = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- 编辑公共道具 -->
    <el-dialog v-model="showEditPropLibrary" title="编辑公共道具" width="440px" @close="editPropLibraryForm = null">
      <el-form v-if="editPropLibraryForm" label-width="80px">
        <el-form-item label="名称">
          <el-input v-model="editPropLibraryForm.name" placeholder="道具名称" />
        </el-form-item>
        <el-form-item label="分类">
          <el-input v-model="editPropLibraryForm.category" placeholder="可选" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="editPropLibraryForm.description" type="textarea" :rows="3" placeholder="可选" />
        </el-form-item>
        <el-form-item label="标签">
          <el-input v-model="editPropLibraryForm.tags" placeholder="可选，逗号分隔" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showEditPropLibrary = false">取消</el-button>
        <el-button type="primary" :loading="editPropLibrarySaving" @click="submitEditPropLibrary">保存</el-button>
      </template>
    </el-dialog>

    <!-- 场景资源库 -->
    <el-dialog v-model="showSceneLibrary" title="场景资源库" width="720px" destroy-on-close class="library-dialog" @open="onSceneLibraryDialogOpen">
      <el-tabs v-model="sceneLibraryTab" class="char-library-tabs" @tab-change="onSceneLibraryTabChange">
        <el-tab-pane label="本剧场景库" name="library">
          <div class="library-toolbar">
            <el-input v-model="sceneLibraryKeyword" placeholder="搜索地点或描述" clearable style="width: 200px" @input="debouncedLoadSceneLibrary()" />
          </div>
          <div v-loading="sceneLibraryLoading" class="library-list">
            <div v-for="item in sceneLibraryList" :key="'slib-' + item.id" class="library-item">
              <div class="library-item-cover" @click="openImagePreview(assetImageUrl(item))">
                <img v-if="item.image_url || item.local_path" :src="assetImageUrl(item)" alt="" />
                <span v-else class="library-item-placeholder">暂无图</span>
              </div>
              <div class="library-item-info">
                <div class="library-item-name">{{ item.location || item.time || '未命名' }}</div>
                <div class="library-item-desc">{{ (item.description || item.prompt || '').slice(0, 60) }}{{ (item.description || item.prompt || '').length > 60 ? '…' : '' }}</div>
                <div class="library-item-actions">
                  <el-button size="small" type="primary" :loading="isSceneAddToEpisodeLoading('library', item.id)" :disabled="!currentEpisodeId" @click="onAddSceneFromLibrary(item)">加入本集</el-button>
                  <el-button size="small" @click="openEditSceneLibrary(item)">编辑</el-button>
                  <el-button size="small" type="danger" plain @click="onDeleteSceneLibrary(item)">删除</el-button>
                </div>
              </div>
            </div>
            <div v-if="!sceneLibraryLoading && sceneLibraryList.length === 0" class="library-empty">暂无本剧场景库记录，可将本剧场景「加入本剧库」后在此查看</div>
          </div>
          <div class="library-pagination">
            <el-pagination v-model:current-page="sceneLibraryPage" v-model:page-size="sceneLibraryPageSize" :total="sceneLibraryTotal" :page-sizes="[10, 20, 50]" layout="total, sizes, prev, pager, next" @current-change="loadSceneLibraryList" @size-change="loadSceneLibraryList" />
          </div>
        </el-tab-pane>
        <el-tab-pane label="本剧所有场景" name="drama">
          <div class="library-toolbar">
            <el-input v-model="dramaAllSceneKeyword" placeholder="搜索地点或描述" clearable style="width: 200px" @input="debouncedLoadDramaAllSceneList()" />
          </div>
          <div v-loading="dramaAllSceneLoading" class="library-list">
            <div v-for="item in dramaAllSceneList" :key="'sdr-' + item.id" class="library-item">
              <div class="library-item-cover" @click="openImagePreview(assetImageUrl(item))">
                <img v-if="item.image_url || item.local_path" :src="assetImageUrl(item)" alt="" />
                <span v-else class="library-item-placeholder">暂无图</span>
              </div>
              <div class="library-item-info">
                <div class="library-item-name">{{ item.location || '未命名' }}<span v-if="item.time" class="library-item-sub"> · {{ item.time }}</span></div>
                <div class="library-item-desc">{{ (item.description || item.prompt || '').slice(0, 60) }}{{ (item.description || item.prompt || '').length > 60 ? '…' : '' }}</div>
                <div class="library-item-actions">
                  <el-button size="small" type="primary" :loading="isSceneAddToEpisodeLoading('drama', item.id)" :disabled="!currentEpisodeId" @click="onAddDramaSceneToEpisode(item)">加入本集</el-button>
                </div>
              </div>
            </div>
            <div v-if="!dramaAllSceneLoading && dramaAllSceneList.length === 0" class="library-empty">本剧暂无制作场景，请先在场景面板创建</div>
          </div>
          <div class="library-pagination">
            <el-pagination v-model:current-page="dramaAllScenePage" v-model:page-size="dramaAllScenePageSize" :total="dramaAllSceneTotal" :page-sizes="[10, 20, 50]" layout="total, sizes, prev, pager, next" @current-change="loadDramaAllSceneList" @size-change="loadDramaAllSceneList" />
          </div>
        </el-tab-pane>
      </el-tabs>
      <template #footer>
        <el-button @click="showSceneLibrary = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- 编辑公共场景 -->
    <el-dialog v-model="showEditSceneLibrary" title="编辑公共场景" width="440px" @close="editSceneLibraryForm = null">
      <el-form v-if="editSceneLibraryForm" label-width="80px">
        <el-form-item label="地点">
          <el-input v-model="editSceneLibraryForm.location" placeholder="场景地点" />
        </el-form-item>
        <el-form-item label="时间">
          <el-input v-model="editSceneLibraryForm.time" placeholder="如：浅色/夜晚" />
        </el-form-item>
        <el-form-item label="分类">
          <el-input v-model="editSceneLibraryForm.category" placeholder="可选" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="editSceneLibraryForm.description" type="textarea" :rows="3" placeholder="可选" />
        </el-form-item>
        <el-form-item label="标签">
          <el-input v-model="editSceneLibraryForm.tags" placeholder="可选，逗号分隔" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showEditSceneLibrary = false">取消</el-button>
        <el-button type="primary" :loading="editSceneLibrarySaving" @click="submitEditSceneLibrary">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, reactive, inject } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  ArrowUp,
  ArrowDown,
  WarningFilled,
  Delete,
  VideoPlay,
  ZoomIn,
  MagicStick,
  Upload,
} from '@element-plus/icons-vue'
import BatchReferenceImages from '@/components/BatchReferenceImages.vue'
import ReferenceImageMode from '@/components/ReferenceImageMode.vue'
import CharacterVoiceSettings from '@/components/CharacterVoiceSettings.vue'
import CharacterStagesEditor from '@/components/CharacterStagesEditor.vue'
import WardrobeSettings from '@/components/WardrobeSettings.vue'
import { usesFourViews } from '@/utils/referenceImageMode'
import { isAssetRecentlyCreated, isAssetMentionedInText } from '@/utils/assetMatcher'
import { characterAPI } from '@/api/characters'
import { propAPI } from '@/api/props'
import { sceneAPI } from '@/api/scenes'
import { uploadAPI } from '@/api/upload'
import { ontologyAPI } from '@/api/ontology'
import { dramaAPI } from '@/api/drama'
import { useFilmStore } from '@/stores/film'
import { useCharacters } from '@/composables/filmCreate/useCharacters'
import { useProps as usePropsComposable } from '@/composables/filmCreate/useProps'
import { useScenes } from '@/composables/filmCreate/useScenes'

const ctx = inject('filmCreateContext', {})

// 基础项目与集上下文
const store = ctx.store || useFilmStore()
const dramaId = ctx.dramaId
const currentEpisodeId = ctx.currentEpisodeId
const currentEpisode = computed(() => store?.currentEpisode)
const characters = ctx.characters || computed(() => store?.characters || [])
const props = ctx.props || computed(() => store?.props || [])
const scenes = ctx.scenes || computed(() => store?.scenes || [])
const storyboards = ctx.storyboards || computed(() => store?.storyboards || [])
const pipelineRunning = ctx.pipelineRunning
const serverGenerationJobs = ctx.serverGenerationJobs
const generationJobsPanel = ctx.generationJobsPanel
const loadDrama = ctx.loadDrama || (() => {})
const getSelectedStyle = ctx.getSelectedStyle || (() => '')
const submitGenerationJob = ctx.submitGenerationJob
const hasAssetImage = ctx.hasAssetImage
const assetImageUrl = ctx.assetImageUrl
const openImagePreview = ctx.openImagePreview
const onDubbingProfile = ctx.onDubbingProfile || (() => {})

const characterVoiceEditor = ref(null)
const characterStagesUploading = ref(false)

async function pollUntilResourceHasImage(checker, maxAttempts = 20, intervalMs = 3000) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, intervalMs))
    await loadDrama()
    if (checker()) return
  }
}

// ── Composable: Characters ────────────────────────────
const {
  charactersGenerating, generatingCharIds, sd2CertifyingId, showCharSd2Cert, charSd2CertPayload,
  sd2VoiceUploadingId, showCharLibrary, charLibraryList, charLibraryLoading, charLibraryPage,
  charLibraryPageSize, charLibraryTotal, charLibraryKeyword, charLibraryTab, dramaAllCharList,
  dramaAllCharLoading, dramaAllCharPage, dramaAllCharPageSize, dramaAllCharTotal, dramaAllCharKeyword,
  showEditCharLibrary, editCharLibraryForm, editCharacterSaving, editCharacterPromptGenerating,
  extractingCharAppearance, extractingAnchors, addCharRefImage, addCharRefFileInput,
  aiCompletingCharacter, onAiCompleteCharacter,
  showEditCharacter, editCharacterForm,
  editCharLibrarySaving, addingCharToLibraryId, addingCharToMaterialId, addingCharFromLibraryId,
  charRoleLabel, onGenerateCharacters: onGenerateCharactersRaw, openAddCharacter, stopCharacterPromptPoll, editCharacter,
  saveCharRefImageIfAny, submitEditCharacter, doGenerateCharacterPrompt, doExtractCharFromImage,
  extractIdentityAnchors, clearCharRefImage, onCloseCharDialog, onDeleteCharacter, onGenerateCharacterImage, onSd2CertifyCharacter, onSd2CertifyRefresh, sd2ActionLabel, onSd2PrimaryAction, openCharSd2CertDialog,
  onSd2VoicePrimaryAction, onSd2VoiceReplace, sd2VoiceActionLabel, playSd2Voice,
  loadCharLibraryList, debouncedLoadCharLibrary, loadDramaAllCharList, debouncedLoadDramaAllCharList,
  onCharLibraryDialogOpen, onCharLibraryTabChange, isCharAddToEpisodeLoading,
  openEditCharLibrary, submitEditCharLibrary,
  onDeleteCharLibrary, onAddCharacterToLibrary, onAddCharacterToMaterialLibrary,
  onAddCharFromLibrary, onAddDramaCharToEpisode,
} = useCharacters({
  store,
  dramaId,
  currentEpisodeId,
  getSelectedStyle,
  loadDrama,
  pollTask: ctx.pollTask,
  pollUntilResourceHasImage,
  hasAssetImage,
  beforeSaveCharacter: () => characterVoiceEditor.value?.save()
})

async function onGenerateCharacters() {
  await onGenerateCharactersRaw()
}

// ── Composable: Props ──────────────────────────────────
const {
  showAddProp, addPropSaving, addPropForm,
  showEditProp, editPropForm, editPropSaving, editPropPromptGenerating,
  extractingPropDesc, addPropRefImage, addPropRefFileInput,
  aiCompletingProp, onAiCompleteProp,
  addPropAddRefImage, addPropAddRefFileInput, extractingPropAddDesc,
  propsExtracting, generatingPropIds,
  showPropLibrary, propLibraryList, propLibraryLoading, propLibraryPage, propLibraryPageSize,
  propLibraryTotal, propLibraryKeyword, propLibraryTab,
  dramaAllPropList, dramaAllPropLoading, dramaAllPropPage, dramaAllPropPageSize, dramaAllPropTotal, dramaAllPropKeyword,
  showEditPropLibrary, editPropLibraryForm,
  editPropLibrarySaving, addingPropToLibraryId, addingPropToMaterialId, addingPropFromLibraryId,
  onExtractProps: onExtractPropsRaw, stopPropPromptPoll, editProp, doGeneratePropPrompt, savePropRefImageIfAny,
  clearPropRefImage, doExtractPropFromImage, submitEditProp, submitAddProp,
  onClosePropDialog, onDeleteProp, onGeneratePropImage,
  loadPropLibraryList, debouncedLoadPropLibrary, loadDramaAllPropList, debouncedLoadDramaAllPropList,
  onPropLibraryDialogOpen, onPropLibraryTabChange, isPropAddToEpisodeLoading,
  openEditPropLibrary, submitEditPropLibrary,
  onDeletePropLibrary, onAddPropToLibrary, onAddPropToMaterialLibrary,
  onAddPropFromLibrary, onAddDramaPropToEpisode,
  doExtractFromRef2,
} = usePropsComposable({
  store,
  dramaId,
  currentEpisodeId,
  getSelectedStyle,
  loadDrama,
  pollTask: ctx.pollTask,
  pollUntilResourceHasImage,
  hasAssetImage
})

async function onExtractProps() {
  await onExtractPropsRaw()
}

// ── Composable: Scenes ─────────────────────────────────
const {
  showEditScene, editSceneForm, editSceneSaving, editScenePromptGenerating,
  extractingSceneDesc, addSceneRefImage, addSceneRefFileInput,
  aiCompletingScene, onAiCompleteScene,
  scenesExtracting, generatingSceneIds,
  showSceneLibrary, sceneLibraryList, sceneLibraryLoading, sceneLibraryPage, sceneLibraryPageSize,
  sceneLibraryTotal, sceneLibraryKeyword, sceneLibraryTab,
  dramaAllSceneList, dramaAllSceneLoading, dramaAllScenePage, dramaAllScenePageSize, dramaAllSceneTotal, dramaAllSceneKeyword,
  showEditSceneLibrary, editSceneLibraryForm,
  editSceneLibrarySaving, addingSceneToLibraryId, addingSceneToMaterialId, addingSceneFromLibraryId,
  onExtractScenes: onExtractScenesRaw, openAddScene, stopScenePromptPoll, editScene, doGenerateScenePrompt, doGenerateSceneSinglePrompt,
  saveSceneRefImageIfAny, clearSceneRefImage, doExtractSceneFromImage, submitEditScene,
  onCloseSceneDialog, onDeleteScene, onGenerateSceneImage,
  loadSceneLibraryList, debouncedLoadSceneLibrary, loadDramaAllSceneList, debouncedLoadDramaAllSceneList,
  onSceneLibraryDialogOpen, onSceneLibraryTabChange, isSceneAddToEpisodeLoading,
  openEditSceneLibrary, submitEditSceneLibrary,
  onDeleteSceneLibrary, onAddSceneToLibrary, onAddSceneToMaterialLibrary,
  onAddSceneFromLibrary, onAddDramaSceneToEpisode,
} = useScenes({
  store,
  dramaId,
  currentEpisodeId,
  getSelectedStyle,
  scriptLanguage: ctx.scriptLanguage || ref('zh'),
  loadDrama,
  pollTask: ctx.pollTask,
  pollUntilResourceHasImage,
  hasAssetImage,
  dramaAPI
})

async function onExtractScenes() {
  await onExtractScenesRaw()
}

// 面板折叠状态
const resourcePanelCollapsed = ref(false)
const charactersBlockCollapsed = ref(false)
const propsBlockCollapsed = ref(false)
const scenesBlockCollapsed = ref(false)

// 批量参考图与参考模式
const referenceImageBatch = ref(null)
const referenceBatchRunning = ctx.referenceBatchRunning || ref(false)
const referenceSuggestionsRunning = ctx.referenceSuggestionsRunning || ref(false)
const savingReferenceModeIds = ctx.savingReferenceModeIds || reactive(new Set())
const onReferenceModeSaving = ctx.onReferenceModeSaving || function(kind, id, saving) {
  const key = `${kind}:${id}`
  if (saving) savingReferenceModeIds.add(key)
  else savingReferenceModeIds.delete(key)
}

// 资源上传与拖拽
const resourceImageFileInput = ref(null)
const resourceUploadType = ref(null)
const resourceUploadId = ref(null)
const uploadingResourceId = ref(null)
const dragOverResourceKey = ref(null)

function getFirstImageFile(dataTransfer) {
  if (!dataTransfer?.files?.length) return null
  const file = Array.from(dataTransfer.files).find((f) => f.type.startsWith('image/'))
  return file || null
}

function readFileAsRefImage(file) {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = (ev) => resolve({ dataUrl: ev.target.result, filename: file.name })
    reader.readAsDataURL(file)
  })
}

async function onRefImageFileChange(type, event) {
  const file = event.target?.files?.[0]
  if (!file) return
  const result = await readFileAsRefImage(file)
  if (type === 'character' && addCharRefImage) addCharRefImage.value = result
  else if (type === 'prop' && addPropRefImage) addPropRefImage.value = result
  else if (type === 'scene' && addSceneRefImage) addSceneRefImage.value = result
  event.target.value = ''
}

async function onRefImageDrop(type, event) {
  const file = getFirstImageFile(event.dataTransfer)
  if (!file) return
  const result = await readFileAsRefImage(file)
  if (type === 'character' && addCharRefImage) addCharRefImage.value = result
  else if (type === 'prop' && addPropRefImage) addPropRefImage.value = result
  else if (type === 'scene' && addSceneRefImage) addSceneRefImage.value = result
}

async function onRefImageFileChange2(type, event) {
  const file = event.target?.files?.[0]
  if (!file) return
  const result = await readFileAsRefImage(file)
  if (type === 'addProp' && addPropAddRefImage) addPropAddRefImage.value = result
  event.target.value = ''
}

async function onRefImageDrop2(type, event) {
  const file = getFirstImageFile(event.dataTransfer)
  if (!file) return
  const result = await readFileAsRefImage(file)
  if (type === 'addProp' && addPropAddRefImage) addPropAddRefImage.value = result
}

async function doExtractFromRef(type) {
  if (type === 'character') {
    const refImage = addCharRefImage?.value
    if (!refImage) return
    if (extractingCharAppearance) extractingCharAppearance.value = true
    try {
      const name = editCharacterForm?.value?.name || ''
      const res = await uploadAPI.extractDescriptionFromImage('character', refImage.dataUrl, name)
      if (res?.description && editCharacterForm?.value) {
        editCharacterForm.value.appearance = res.description
        ElMessage.success('已从参考图提取外貌描述')
      }
    } catch (e) {
      ElMessage.error(e.message || '提取失败，请检查 AI 配置中是否有支持视觉的模型')
    } finally {
      if (extractingCharAppearance) extractingCharAppearance.value = false
    }
  } else if (type === 'prop') {
    const refImage = addPropRefImage?.value
    if (!refImage) return
    if (extractingPropDesc) extractingPropDesc.value = true
    try {
      const name = editPropForm?.value?.name || ''
      const res = await uploadAPI.extractDescriptionFromImage('prop', refImage.dataUrl, name)
      if (res?.description && editPropForm?.value) {
        editPropForm.value.description = res.description
        ElMessage.success('已从参考图提取特征描述')
      }
    } catch (e) {
      ElMessage.error(e.message || '提取失败，请检查 AI 配置中是否有支持视觉的模型')
    } finally {
      if (extractingPropDesc) extractingPropDesc.value = false
    }
  } else if (type === 'scene') {
    const refImage = addSceneRefImage?.value
    if (!refImage) return
    if (extractingSceneDesc) extractingSceneDesc.value = true
    try {
      const name = editSceneForm?.value?.name || ''
      const res = await uploadAPI.extractDescriptionFromImage('scene', refImage.dataUrl, name)
      if (res?.description && editSceneForm?.value) {
        editSceneForm.value.description = res.description
        ElMessage.success('已从参考图提取场景描述')
      }
    } catch (e) {
      ElMessage.error(e.message || '提取失败，请检查 AI 配置中是否有支持视觉的模型')
    } finally {
      if (extractingSceneDesc) extractingSceneDesc.value = false
    }
  }
}

function onResourceDragOver(e, type, id) {
  e.preventDefault()
  e.stopPropagation()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  const key = type === 'character' ? 'char-' : type === 'prop' ? 'prop-' : 'scene-'
  dragOverResourceKey.value = key + id
}

function onResourceDragLeave(e, key) {
  e.preventDefault()
  if (e.relatedTarget && e.currentTarget.contains(e.relatedTarget)) return
  if (key && dragOverResourceKey.value !== key) return
  dragOverResourceKey.value = null
}

function onResourceDrop(e, type, id) {
  e.preventDefault()
  e.stopPropagation()
  dragOverResourceKey.value = null
  const file = getFirstImageFile(e.dataTransfer)
  if (file) doUploadResourceImage(type, id, file)
}

function onUploadResourceClick(type, id) {
  resourceUploadType.value = type
  resourceUploadId.value = id
  resourceImageFileInput.value?.click()
}

function parseExtraImages(item) {
  if (!item?.extra_images) return []
  try {
    const arr = typeof item.extra_images === 'string' ? JSON.parse(item.extra_images) : item.extra_images
    return Array.isArray(arr) ? arr.filter(Boolean) : []
  } catch { return [] }
}

function localPathToUrl(p) {
  if (!p) return ''
  if (p.startsWith('http')) return p
  return '/static/' + p.replace(/^\//, '')
}

function findResource(type, id) {
  const list = type === 'character' ? (store?.characters ?? [])
    : type === 'prop' ? (store?.props ?? [])
    : (store?.scenes ?? [])
  return list.find((x) => Number(x.id) === Number(id)) || null
}

async function doUploadResourceImage(type, id, file) {
  if (!file || !type || id == null) return
  const isFacePhoto = type === 'character-reference'
  const key = (type === 'character' || isFacePhoto) ? 'char-' : type === 'prop' ? 'prop-' : 'scene-'
  uploadingResourceId.value = key + id
  try {
    const res = await uploadAPI.uploadImage(file, { dramaId: dramaId?.value })
    const data = res?.data ?? res
    const uploadedLocalPath = data?.local_path || data?.path || null
    const url = data?.url || uploadedLocalPath
    if (!url) { ElMessage.error('上传未返回地址'); return }

    if (isFacePhoto) {
      await characterAPI.putRefImage(id, uploadedLocalPath || url)
      await loadDrama?.()
      ElMessage.success('相貌参考照已保存，下次 AI 生成将使用这张照片')
      return
    }
    const current = findResource(type, id)
    const hasPrimary = !!(current?.local_path || current?.image_url)

    if (hasPrimary) {
      const extras = parseExtraImages(current)
      const newPath = uploadedLocalPath || url
      if (!extras.includes(newPath)) extras.push(newPath)
      const extraJson = JSON.stringify(extras)
      if (type === 'character') {
        await characterAPI.putImage(id, { extra_images: extraJson, ...(!current?.ref_image ? { ref_image: newPath } : {}) })
      } else if (type === 'prop') {
        await propAPI.update(id, { extra_images: extraJson })
      } else if (type === 'scene') {
        await sceneAPI.update(id, { extra_images: extraJson })
      }
    } else {
      if (type === 'character') {
        await characterAPI.putImage(id, { image_url: url, local_path: uploadedLocalPath ?? null, ...(!current?.ref_image ? { ref_image: uploadedLocalPath || url } : {}) })
      } else if (type === 'prop') {
        await propAPI.update(id, { image_url: url, local_path: uploadedLocalPath ?? null })
      } else if (type === 'scene') {
        await sceneAPI.update(id, { image_url: url, local_path: uploadedLocalPath ?? null })
      }
    }
    await loadDrama?.()
    ElMessage.success(type === 'character' && !current?.ref_image ? '上传成功，已同时设为 AI 生图的相貌参考照' : '上传成功')
  } catch (e) {
    ElMessage.error(e.message || '上传失败')
  } finally {
    uploadingResourceId.value = null
  }
}

async function onSetPrimaryImage(type, item, extraPath) {
  const extras = parseExtraImages(item)
  const oldPrimary = item.local_path || ''
  const newExtras = extras.filter((p) => p !== extraPath)
  if (oldPrimary) newExtras.unshift(oldPrimary)
  const extraJson = JSON.stringify(newExtras)
  try {
    if (type === 'character') {
      await characterAPI.putImage(item.id, { local_path: extraPath, image_url: '', extra_images: extraJson })
    } else if (type === 'prop') {
      await propAPI.update(item.id, { local_path: extraPath, image_url: '', extra_images: extraJson })
    } else if (type === 'scene') {
      await sceneAPI.update(item.id, { local_path: extraPath, image_url: '', extra_images: extraJson })
    }
    await loadDrama?.()
  } catch (e) {
    ElMessage.error(e.message || '操作失败')
  }
}

async function onRemoveExtraImage(type, item, extraPath) {
  const extras = parseExtraImages(item).filter((p) => p !== extraPath)
  const extraJson = extras.length ? JSON.stringify(extras) : null
  try {
    if (type === 'character') {
      await characterAPI.putImage(item.id, { extra_images: extraJson })
    } else if (type === 'prop') {
      await propAPI.update(item.id, { extra_images: extraJson })
    } else if (type === 'scene') {
      await sceneAPI.update(item.id, { extra_images: extraJson })
    }
    await loadDrama?.()
  } catch (e) {
    ElMessage.error(e.message || '删除失败')
  }
}

function onResourceImageFileChange(ev) {
  const file = ev.target?.files?.[0]
  const type = resourceUploadType.value
  const id = resourceUploadId.value
  if (!file || !type || id == null) {
    if (ev.target) ev.target.value = ''
    return
  }
  doUploadResourceImage(type, id, file)
  if (ev.target) ev.target.value = ''
}

// 关联分镜查询与重生成
const regenSbImagesForAsset = reactive(new Set())
const regenSbImagesProgress = ref({})

function dedupeStoryboardsForAssetLink(list) {
  const byNum = new Map()
  const extras = []
  for (const sb of list || []) {
    const n = Number(sb?.storyboard_number)
    if (Number.isFinite(n) && n > 0) {
      const prev = byNum.get(n)
      if (!prev || Number(sb.id) > Number(prev.id)) byNum.set(n, sb)
    } else {
      extras.push(sb)
    }
  }
  return [...byNum.values(), ...extras].sort(
    (a, b) => (Number(a.storyboard_number) || 0) - (Number(b.storyboard_number) || 0)
  )
}

function getCharAffectedStoryboards(charId) {
  const matched = (storyboards.value || []).filter((sb) => {
    if (!sb.characters) return false
    const chars = Array.isArray(sb.characters) ? sb.characters : []
    return chars.some((c) => Number(typeof c === 'object' && c != null ? c.id : c) === Number(charId))
  })
  return dedupeStoryboardsForAssetLink(matched)
}

function getSceneAffectedStoryboards(sceneId) {
  const matched = (storyboards.value || []).filter(
    (sb) => sb.scene_id != null && Number(sb.scene_id) === Number(sceneId)
  )
  return dedupeStoryboardsForAssetLink(matched)
}

function getPropAffectedStoryboards(propId) {
  const matched = (storyboards.value || []).filter((sb) => {
    if (!sb.prop_ids) return false
    const pids = Array.isArray(sb.prop_ids) ? sb.prop_ids : []
    return pids.some((pid) => Number(pid) === Number(propId))
  })
  return dedupeStoryboardsForAssetLink(matched)
}

function scrollToStoryboard(sbId) {
  const el = document.getElementById('sb-' + sbId)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

async function onRegenAffectedSbImages(assetKey, affectedBoards) {
  if (!affectedBoards.length || regenSbImagesForAsset.has(assetKey)) return
  try {
    await ElMessageBox.confirm(`将重新生成 ${affectedBoards.length} 个关联分镜的图片，是否继续？`, '重新生成关联分镜图', {type:'warning',confirmButtonText:'确认生成',cancelButtonText:'取消'})
  } catch (_) { return }
  regenSbImagesForAsset.add(assetKey)
  try { await submitGenerationJob?.('storyboard_images', {storyboard_ids:affectedBoards.map(s=>s.id), force:true}) }
  catch(e){ElMessage.error(e.message)}
  finally {regenSbImagesForAsset.delete(assetKey)}
}

// 世界观诊断逻辑
function getFullDramaScript() {
  const scripts = []
  const curr = (store?.currentEpisode?.script_content || '').trim()
  if (curr) scripts.push(curr)
  for (const ep of store?.drama?.episodes || []) {
    const s = (ep.script_content || '').trim()
    if (s && !scripts.includes(s)) scripts.push(s)
  }
  const desc = (store?.drama?.description || '').trim()
  if (desc && !scripts.includes(desc)) scripts.push(desc)
  return scripts.join('\n\n')
}

function getAllDramaStoryboards() {
  const map = new Map()
  for (const sb of storyboards.value || []) {
    if (sb && sb.id != null) map.set(Number(sb.id), sb)
  }
  for (const ep of store?.drama?.episodes || []) {
    if (Array.isArray(ep.storyboards)) {
      for (const sb of ep.storyboards) {
        if (sb && sb.id != null && !map.has(Number(sb.id))) {
          map.set(Number(sb.id), sb)
        }
      }
    }
  }
  return [...map.values()]
}

function getAssetObsoleteInfo(type, item) {
  if (!item) return null
  if (isAssetRecentlyCreated(item, 20)) {
    return null
  }
  const dramaScript = getFullDramaScript()
  if (!dramaScript) return null
  const inScript = isAssetMentionedInText(type, item, dramaScript)
  if (inScript) return null
  const allShots = getAllDramaStoryboards()
  if (allShots.length === 0) return null

  let affectedCount = 0
  if (type === 'character') {
    affectedCount = allShots.filter((sb) => {
      const chars = Array.isArray(sb.characters) ? sb.characters : []
      return chars.some((c) => Number(typeof c === 'object' && c != null ? c.id : c) === Number(item.id))
    }).length
  } else if (type === 'prop') {
    affectedCount = allShots.filter((sb) => {
      const pids = Array.isArray(sb.prop_ids) ? sb.prop_ids : []
      return pids.some((pid) => Number(pid) === Number(item.id))
    }).length
  } else if (type === 'scene') {
    affectedCount = allShots.filter((sb) => sb.scene_id != null && Number(sb.scene_id) === Number(item.id)).length
  }

  if (affectedCount > 0) return null

  if (type === 'character') {
    const name = (item.name || '').trim()
    return {
      isObsolete: true,
      reason: `【智能体世界观诊断】：全剧剧本与分镜中均未发现角色「${name}」的出场或台词记录，疑似修改剧情后的过时残留，建议删除以精简世界观。`,
    }
  } else if (type === 'prop') {
    const name = (item.name || '').trim()
    return {
      isObsolete: true,
      reason: `【智能体世界观诊断】：全剧剧本与分镜中未见道具「${name}」的使用记录，建议删除以避免干扰镜头调度。`,
    }
  } else if (type === 'scene') {
    const loc = (item.location || '').trim()
    return {
      isObsolete: true,
      reason: `【智能体世界观诊断】：全剧最新剧本与分镜中未涉及场地「${loc}」，建议删除。`,
    }
  }
  return null
}

const obsoleteAssets = computed(() => {
  const script = getFullDramaScript()
  if (!script) return []
  const list = []
  for (const c of characters.value || []) {
    const info = getAssetObsoleteInfo('character', c)
    if (info) list.push({ type: 'character', id: c.id, name: c.name, typeLabel: '角色', item: c })
  }
  for (const p of props.value || []) {
    const info = getAssetObsoleteInfo('prop', p)
    if (info) list.push({ type: 'prop', id: p.id, name: p.name, typeLabel: '道具', item: p })
  }
  for (const s of scenes.value || []) {
    const info = getAssetObsoleteInfo('scene', s)
    if (info) list.push({ type: 'scene', id: s.id, name: s.location, typeLabel: '场地', item: s })
  }
  return list
})

async function onBatchCleanObsoleteAssets() {
  const items = obsoleteAssets.value
  if (!items.length) return
  const names = items.map((i) => `【${i.typeLabel}】${i.name}`).join('、')
  try {
    await ElMessageBox.confirm(
      `确定要一键清理以下 ${items.length} 项在当前剧本中无提及的过时资产吗？\n\n${names}\n\n清理后将避免干扰后续分镜推演与生图一致性。`,
      '智能体世界观诊断 · 清理过时资产',
      {
        confirmButtonText: '立即清理',
        cancelButtonText: '取消',
        type: 'warning',
      }
    )
  } catch {
    return
  }

  for (const item of items) {
    try {
      if (item.type === 'character') {
        await characterAPI.delete(item.id)
      } else if (item.type === 'prop') {
        await propAPI.delete(item.id)
      } else if (item.type === 'scene') {
        await sceneAPI.delete(item.id)
      }
    } catch (_) {}
  }
  if (dramaId?.value) {
    try { await ontologyAPI.reconcileDramaAssets(dramaId.value) } catch (_) {}
  }
  await loadDrama?.()
  ElMessage.success(`已成功清理 ${items.length} 项过时资产`)
}

defineExpose({
  charactersGenerating,
  generatingCharIds,
  propsExtracting,
  generatingPropIds,
  scenesExtracting,
  generatingSceneIds,
})
</script>

<style scoped>
.obsolete-assets-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  background: rgba(250, 173, 20, 0.12);
  border: 1px solid rgba(250, 173, 20, 0.35);
  border-radius: 8px;
  padding: 10px 16px;
  margin-bottom: 14px;
}
.oab-left {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: #e6a23c;
  line-height: 1.5;
}
:global(html.light) .oab-left {
  color: #ad4e00;
}
.oab-icon {
  font-size: 20px;
  flex-shrink: 0;
  color: #faad14;
}
.oab-title {
  font-weight: 600;
}

.resource-panel {
  padding: 20px 24px;
  margin-bottom: 24px;
}
.resource-panel .collapse-header {
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.resource-panel .collapse-header .section-title {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
}
.resource-panel-body {
  margin-top: 16px;
}
.resource-block {
  margin-bottom: 20px;
  padding: 16px;
  border-radius: 8px;
}
.resource-block:last-child {
  margin-bottom: 0;
}
.resource-block-header {
  margin-bottom: 0;
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.resource-block-header .collapse-icon {
  font-size: 18px;
  color: #71717a;
  transition: transform 0.2s ease;
}
.resource-block-title {
  font-size: 1.1rem;
  font-weight: 600;
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-bright, #fafafa);
}
:global(html.light .resource-block-title) {
  color: #1e1b4b !important;
}
.resource-block-body {
  margin-top: 12px;
}
.resource-block-body .asset-actions {
  margin-bottom: 12px;
}
.resource-block-body .asset-list-two {
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
}
.asset-actions { margin-bottom: 12px; }
.asset-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
}
.asset-list-two {
  grid-template-columns: repeat(2, 1fr);
}
.asset-item {
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  flex-direction: column;
}
.asset-item-left-right {
  flex-direction: row;
  align-items: stretch;
}
.asset-item-left-right .asset-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 14px;
}
.asset-item-left-right .asset-name {
  margin-bottom: 6px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.asset-item-left-right .asset-desc-full {
  flex: 1;
  font-size: 0.85rem;
  color: #7a7a88;
  line-height: 1.5;
  margin-bottom: 8px;
  white-space: pre-wrap;
  word-break: break-word;
}
.asset-item-left-right .asset-cover-wrap {
  width: 180px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  padding: 12px;
  border-left: 1px solid rgba(255, 255, 255, 0.06);
}
:global(html.light) .asset-item-left-right .asset-cover-wrap {
  border-left-color: rgba(99, 102, 241, 0.08);
}
.asset-item-left-right .asset-cover {
  width: 100%;
  aspect-ratio: 16/9;
  border-radius: 6px;
  overflow: hidden;
  position: relative;
}
.asset-item-left-right .asset-cover.asset-cover--clickable {
  cursor: pointer;
}
.asset-cover {
  width: 100%;
  aspect-ratio: 16/9;
  border-radius: 6px;
  overflow: hidden;
  background: rgba(0, 0, 0, 0.2);
  display: flex;
  align-items: center;
  justify-content: center;
}
.asset-item-left-right .asset-cover .cover-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.asset-cover--dragover {
  border: 2px dashed #6366f1 !important;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.25);
}
.asset-cover-drop-hint {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(99, 102, 241, 0.85);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  pointer-events: none;
}
.asset-info { padding: 10px; }
.asset-name { font-weight: 600; margin-bottom: 4px; color: var(--text-bright, #fafafa); }
:global(html.light .asset-name) { color: #1e1b4b !important; }
.asset-desc-full {
  font-size: 0.85rem;
  color: var(--text-muted, #7a7a88);
  margin-bottom: 8px;
}
:global(html.light .asset-desc-full) { color: #4b5563 !important; }
.asset-btns { display: flex; gap: 6px; flex-wrap: wrap; margin-top: auto; }
.asset-item-left-right .asset-name span { flex: 1; min-width: 0; }
.asset-cover-actions {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}
.asset-cover-actions .el-button { flex: 1; justify-content: center; }

.cover-placeholder {
  font-size: 12px;
  color: #71717a;
}
.cover-placeholder.error {
  color: #f56c6c;
  padding: 4px;
  font-size: 11px;
}
.btn-delete-icon {
  padding: 2px 4px;
}

.asset-storyboard-link {
  margin-top: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 12px;
}
.asl-label {
  color: #71717a;
}
.asl-chip {
  background: rgba(99, 102, 241, 0.15);
  color: #818cf8;
  padding: 2px 6px;
  border-radius: 4px;
  cursor: pointer;
  font-weight: 500;
  transition: background 0.15s;
}
.asl-chip:hover {
  background: rgba(99, 102, 241, 0.3);
}
.asl-progress {
  font-size: 11px;
  color: #909399;
}
.asl-regen-btn {
  margin-left: 4px;
  padding: 0 6px;
  height: 22px;
  font-size: 11px;
}

.extra-images-strip {
  display: flex;
  gap: 6px;
  margin-top: 6px;
  overflow-x: auto;
}
.extra-thumb {
  width: 36px;
  height: 36px;
  border-radius: 4px;
  overflow: hidden;
  position: relative;
  flex-shrink: 0;
  border: 1px solid rgba(255, 255, 255, 0.1);
  cursor: pointer;
}
.extra-thumb:hover { border-color: #a78bfa; }
.extra-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.extra-thumb-remove {
  position: absolute;
  top: 1px;
  right: 1px;
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
  border: none;
  border-radius: 50%;
  width: 14px;
  height: 14px;
  font-size: 10px;
  line-height: 14px;
  padding: 0;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s;
}
.thumb-preview-btn {
  position: absolute;
  top: 1px;
  left: 1px;
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
  border: none;
  border-radius: 50%;
  width: 14px;
  height: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s;
}
.extra-thumb:hover .extra-thumb-remove,
.extra-thumb:hover .thumb-preview-btn { opacity: 1; }

.ref-image-zone {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.ref-image-box {
  width: 120px;
  height: 120px;
  border: 1px dashed rgba(255, 255, 255, 0.2);
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  overflow: hidden;
  position: relative;
  transition: border-color 0.2s;
}
:global(html.light) .ref-image-box {
  border-color: rgba(99, 102, 241, 0.25);
}
.ref-image-box:hover {
  border-color: #6366f1;
}
.ref-preview-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.ref-upload-hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: #71717a;
}
.ref-upload-icon {
  font-size: 24px;
}
.ref-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.library-dialog :deep(.el-dialog__body) { padding-top: 8px; }
.sd2-cert-dialog :deep(.el-dialog__body) { padding-top: 10px; }
.sd2-cert-desc :deep(.el-descriptions__cell) {
  padding: 8px 12px;
}
.sd2-cert-value {
  font-size: 12px;
  word-break: break-all;
}
.library-toolbar { margin-bottom: 12px; display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.library-team-hint { font-size: 12px; color: var(--el-text-color-secondary); }
.library-team-hint--warn { color: var(--el-color-warning); }
.library-item-sub { font-size: 12px; color: var(--el-text-color-secondary); font-weight: normal; }
.library-list {
  min-height: 160px;
  max-height: 480px;
  overflow-y: auto;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px;
}
.library-item {
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
:global(html.light) .library-item {
  border-color: rgba(99, 102, 241, 0.12);
}
.library-item-cover {
  width: 100%;
  aspect-ratio: 16/9;
  background: rgba(0, 0, 0, 0.2);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  overflow: hidden;
}
.library-item-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.library-item-placeholder {
  font-size: 12px;
  color: #71717a;
}
.library-item-info {
  padding: 10px;
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.library-item-name { font-weight: 500; margin-bottom: 4px; font-size: 13px; }
.library-item-desc { font-size: 0.82rem; color: #7a7a88; margin-bottom: 8px; flex: 1; }
:global(html.light) .library-item-desc { color: #64748b; }
.library-item-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: auto; }
.library-empty {
  grid-column: 1 / -1;
  text-align: center;
  color: #71717a;
  padding: 32px 0;
  font-size: 13px;
}
.library-pagination {
  margin-top: 14px;
  display: flex;
  justify-content: flex-end;
}
.empty-tip {
  grid-column: 1 / -1;
  text-align: center;
  color: #71717a;
  padding: 24px;
  font-size: 13px;
}

:global(.asset-edit-dialog) {
  max-height: 92vh;
  display: flex;
  flex-direction: column;
}
:global(.asset-edit-dialog .el-dialog__header) {
  flex-shrink: 0;
  margin-right: 0;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color, #27272a);
}
:global(.asset-edit-dialog .el-dialog__body) {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
}
:global(.asset-edit-dialog .el-dialog__footer) {
  flex-shrink: 0;
  padding: 12px 20px;
  border-top: 1px solid var(--border-color, #27272a);
}
</style>
