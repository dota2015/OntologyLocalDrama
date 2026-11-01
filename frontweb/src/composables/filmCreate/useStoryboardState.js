import { ref, reactive, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { imagesAPI } from '@/api/images'
import { videosAPI } from '@/api/videos'
import { storyboardsAPI } from '@/api/storyboards'
import { GEN_RESOURCE } from '@/stores/generationTaskStore'
import { missingStoryboardImageSlots } from '@/utils/storyboardImageBatch'
import { resolveStoryboardCharacters } from '@/utils/storyboardCharacters'

const EMPTY_ARR = []

/**
 * Storyboard state management composable
 * Encapsulates storyboard fields, media cache, selections, estimations, and entity mappings
 */
export function useStoryboardState({
  store,
  dramaId,
  currentEpisodeId,
  genStore,
  scriptContent,
  shotDurationMin,
  shotDurationMax,
  videoClipDuration,
  serverVideoBatch,
  saveProjectSettings,
}) {
  // ── Storyboard Metadata & Field Maps (key: storyboardId) ───────────
  const sbCharacterIds = ref({})  // sbId -> number[] 多选角色
  const sbPropIds = ref({})       // sbId -> number[] 多选物品
  const sbSceneId = ref({})
  const sbDialogue = ref({})
  const sbNarration = ref({})
  const sbBgmPrompt = ref({})   // 背景音乐/配乐描述（无对白镜头专供 H3 等模型生成）
  const sbShotType = ref({})
  const sbTitle = ref({})
  const sbLocation = ref({})
  const sbTime = ref({})
  const sbDuration = ref({})
  const sbAction = ref({})
  const sbResult = ref({})
  const sbAtmosphere = ref({})
  const sbAngle = ref({})
  const sbAngleH = ref({})   // 结构化视角：水平方向
  const sbAngleV = ref({})   // 结构化视角：俯仰角度
  const sbAngleS = ref({})   // 结构化视角：景别
  const sbMovement = ref({})
  const sbLighting = ref({})   // 灯光风格
  const sbDof = ref({})        // 景深
  const sbLayoutDescription = ref({})  // 空间布局与人物站位描述（生成分镜时 AI 输出的最高优先级合同，用于首尾帧强制一致）
  const regeneratingLayoutSbIds = reactive(new Set())  // 正在 AI 重新生成布局描述的分镜 id 集合
  const sbCreationMode = ref({})
  const sbUniversalSegmentText = ref({})

  // ── Media Collections & Selections ──────────────────────────────────
  const sbImages = ref({})
  const sbVideos = ref({})
  const sbVideoErrors = ref({})
  const sbSelectedImgId = ref({})   // sbId → 选中的首帧/主图 image_generation.id
  const sbSelectedLastImgId = ref({}) // sbId → 选中的尾帧 image_generation.id
  const sbSelectedVideoId = ref({}) // sbId → 选中的 video_generation.id

  // ── Active Generation / Processing Sets ─────────────────────────────
  const generatingSbImageIds = reactive(new Set())
  const generatingSbFirstImageIds = reactive(new Set())
  const generatingSbLastImageIds = reactive(new Set())
  const generatingSbVideoIds = reactive(new Set())
  const generatingUniversalSegmentIds = reactive(new Set())
  const upscalingSbIds = reactive(new Set())
  const ttsSbIds = reactive(new Set())
  const ttsSbNarrationIds = reactive(new Set())
  const linkingTailFrameIds = reactive(new Set())
  const linkingFirstFrameIds = reactive(new Set())
  const usingPrevTailAsFirstIds = reactive(new Set())

  // ── Audio Paths & Upload Slots ──────────────────────────────────────
  const sbDialogueAudioPaths = ref({})
  const sbNarrationAudioPaths = ref({})
  const sbImageUploadSlotById = ref({})

  // ── Project Configuration & Storyboard Controls ───────────────────
  const storyboardCount = ref(null)
  const videoDuration = ref(null)
  const storyboardIncludeNarration = ref(false)
  // H3 全能分镜是系统默认规划；用户只在单个分镜配置中手动切换 FL2VA。
  const storyboardUniversalOmni = ref(true)
  const storyboardUseFirstLastFrame = ref(false)
  const exportingStoryboardSheet = ref(false)
  const lastFrameUseFirstLayoutLock = ref(true)
  const gridMode = ref('single') // single / quad_grid / nine_grid

  // ── Media & Preview URLs ────────────────────────────────────────────
  const baseUrl = ref('')
  const previewImageUrl = ref(null)

  function imageUrl(url) {
    if (!url) return ''
    if (/^(https?:|blob:|data:)/i.test(url)) return url
    const base = (baseUrl.value || '').replace(/\/$/, '')
    if (base) return base + '/' + url.replace(/^\//, '')
    const trimmed = url.replace(/^\/+/, '')
    if (trimmed.startsWith('static/')) return '/' + trimmed
    return '/static/' + trimmed
  }

  function assetImageUrl(item) {
    if (!item) return ''
    if (typeof item === 'string') return imageUrl(item)
    const localPath = item.local_path && String(item.local_path).trim()
    if (localPath) {
      const p = localPath.replace(/^\//, '')
      return '/static/' + p
    }
    if (item.image_url) return imageUrl(item.image_url)
    return ''
  }

  function hasAssetImage(item) {
    if (!item) return false
    return !!(item.image_url || item.local_path)
  }

  function openImagePreview(url) {
    previewImageUrl.value = url
  }

  function closeImagePreview() {
    previewImageUrl.value = null
  }

  function assetVideoUrl(item) {
    if (!item) return ''
    const localPath = item.local_path && String(item.local_path).trim()
    if (localPath) return '/static/' + localPath.replace(/^\//, '')
    if (item.video_url) return imageUrl(item.video_url)
    return ''
  }

  function isHttpVideoUrl(url) {
    if (!url || typeof url !== 'string') return false
    const t = url.trim()
    return t.startsWith('http://') || t.startsWith('https://')
  }

  function recordHasPlayableVideoUrl(i) {
    if (!i) return false
    const lp = i.local_path && String(i.local_path).trim()
    if (lp) return true
    return isHttpVideoUrl(i.video_url)
  }

  function sbMainVideoPlayerKey(sbId) {
    const v = getSbVideo(sbId)
    if (!v) return ''
    const src = assetVideoUrl(v)
    return `${v.id}:${v.updated_at || ''}:${src.slice(0, 160)}`
  }

  // ── Estimation Helpers ──────────────────────────────────────────────
  function clipSecondsForStoryboardEstimate() {
    const c = (Number(shotDurationMin.value) + Number(shotDurationMax.value)) / 2
    return Math.max(2, Math.min(60, Number.isFinite(c) && c > 0 ? c : 5))
  }

  function shotCountEstimateFromDurationSec(sec) {
    const s = Math.max(10, Math.min(600, Math.round(Number(sec) || 0)))
    const clip = clipSecondsForStoryboardEstimate()
    const ideal = s / clip
    const locked = Math.max(1, Math.min(200, Math.round(ideal)))
    const minR = Math.max(1, locked - 1)
    const maxR = Math.min(200, locked + 1)
    const range = minR >= maxR ? { min: locked, max: locked } : { min: minR, max: maxR }
    return { locked, range, clip }
  }

  function estimateVideoDurationSecFromCharLen(charLen) {
    const len = Math.max(0, Math.floor(Number(charLen) || 0))
    if (len < 1) return null
    const raw = Math.round(10 + (len / 600) * 60)
    return Math.min(600, Math.max(10, raw))
  }

  const scriptStoryboardEstimate = computed(() => {
    const script = (scriptContent.value || '').toString().trim()
    const len = script.length
    if (!len) return null
    const sec = estimateVideoDurationSecFromCharLen(len)
    if (sec == null) return null
    const { locked, range, clip } = shotCountEstimateFromDurationSec(sec)
    return { sec, locked, range, clip, len }
  })

  const scriptEstimateVideoDurationHint = computed(() => {
    const e = scriptStoryboardEstimate.value
    if (!e) return ''
    return `（公式粗估约 ${e.sec}s，仅供参考）`
  })

  const scriptEstimateVideoDurationTitle = computed(() => {
    const e = scriptStoryboardEstimate.value
    if (!e) return ''
    return `按当前剧本文本约 ${e.len} 个字符（含标点；常见汉字在浏览器里一字一算，并非按 UTF-8 字节翻倍）、短剧公式 round(10+(字符/600)×60) 粗估总时长约 ${e.sec} 秒；仅供参考，不会作为生成约束；留空由导演按剧情、对白和动作规划`
  })

  const scriptEstimateStoryboardHint = computed(() => {
    const e = scriptStoryboardEstimate.value
    if (!e) return ''
    if (e.range && e.range.min !== e.range.max) {
      return `（公式粗估约 ${e.locked} 镜，仅供参考）`
    }
    return `（约 ${e.locked} 镜）`
  })

  const scriptEstimateStoryboardTitle = computed(() => {
    const e = scriptStoryboardEstimate.value
    if (!e) return ''
    return `按估算时长 ${e.sec}s ÷ 时长范围中值 ${e.clip} 秒四舍五入粗估约 ${e.locked} 镜；这是公式粗估，不参与生成约束。留空由导演按剧情、对白和动作决定数量；手动填写时会检查能否完整表达。`
  })

  function scriptTextTrimmedForEstimate() {
    return (scriptContent.value || '').toString().trim()
  }

  function userFilledStoryboardCount() {
    const v = storyboardCount.value
    return v != null && Number.isFinite(Number(v)) && Number(v) >= 1
  }

  function userFilledVideoDuration() {
    const v = videoDuration.value
    return v != null && Number.isFinite(Number(v)) && Number(v) >= 10
  }

  function getVideoDurationForApi() {
    return userFilledVideoDuration() ? Number(videoDuration.value) : undefined
  }

  function getStoryboardCountForApi() {
    return userFilledStoryboardCount() ? Number(storyboardCount.value) : undefined
  }

  // ── Mode & Slot Helpers ─────────────────────────────────────────────
  function isSbUniversalMode(sbId) {
    const m = sbCreationMode.value[sbId]
    if (m === 'universal') return true
    if (m === 'classic') return false
    const row = (store.storyboards || []).find((b) => b.id === sbId)
    return row?.creation_mode === 'universal'
  }

  function uploadingSbImageSlot(sbId) {
    return sbImageUploadSlotById.value[sbId] || null
  }

  function frameTypeForSlot(slot) {
    return slot === 'last' ? 'storyboard_last' : 'storyboard_first'
  }

  function resolveSbImageById(storyboardId, imageId) {
    if (imageId == null) return null
    const images = getSbAllImages(storyboardId)
    return images.find((i) => i.id === imageId) || null
  }

  function getSbAllImages(storyboardId) {
    const list = sbImages.value[storyboardId]
    if (!Array.isArray(list)) return []
    return list.filter((i) => i.status === 'completed' && i.frame_type !== 'quad_grid' && i.frame_type !== 'nine_grid' && (i.image_url || i.local_path))
  }

  function getSbFirstImage(storyboardId) {
    const images = getSbAllImages(storyboardId)
    const sb = (store.storyboards || []).find((b) => b.id === storyboardId)

    if (sb?.first_frame_image_id != null) {
      const bound = resolveSbImageById(storyboardId, sb.first_frame_image_id)
      if (bound) return bound
    }

    const sel = sbSelectedImgId.value[storyboardId]
    if (sel != null) {
      const found = images.find((i) => i.id === sel)
      if (found) return found
    }

    const typed = images.find((i) => i.frame_type === 'storyboard_first')
    if (typed) return typed
    return null
  }

  function getSbLastImage(storyboardId) {
    const images = getSbAllImages(storyboardId)
    const sb = (store.storyboards || []).find((b) => b.id === storyboardId)

    if (sb?.last_frame_image_id != null) {
      const bound = resolveSbImageById(storyboardId, sb.last_frame_image_id)
      if (bound) return bound
    }

    const sel = sbSelectedLastImgId.value[storyboardId]
    if (sel != null) {
      const found = images.find((i) => i.id === sel)
      if (found) return found
    }

    const typed = images.find((i) => i.frame_type === 'storyboard_last')
    if (typed) return typed

    if (sb?.last_frame_image_url || sb?.last_frame_local_path) {
      return {
        id: sb.last_frame_image_id,
        image_url: sb.last_frame_image_url,
        local_path: sb.last_frame_local_path,
        frame_type: 'storyboard_last',
      }
    }
    return null
  }

  function getSbImage(storyboardId) {
    if (storyboardUseFirstLastFrame.value) return getSbFirstImage(storyboardId)
    const images = getSbAllImages(storyboardId)
    if (!images.length) return null
    const selectedId = sbSelectedImgId.value[storyboardId]
    if (selectedId != null) {
      const found = images.find((i) => i.id === selectedId)
      if (found) return found
    }
    return images[0]
  }

  function hasSbImage(sb) {
    if (storyboardUseFirstLastFrame.value && !isSbUniversalMode(sb.id)) {
      return !!(getSbFirstImage(sb.id) || (sb && (sb.composed_image || sb.image_url)))
    }
    return !!(getSbImage(sb.id) || (sb && (sb.composed_image || sb.image_url)))
  }

  function hasSbFirstLastPair(sb) {
    return !!(getSbFirstImage(sb.id) && getSbLastImage(sb.id))
  }

  function missingSbImageSlots(sb, useFirstLast = storyboardUseFirstLastFrame.value && !isSbUniversalMode(sb.id)) {
    return missingStoryboardImageSlots({
      useFirstLast,
      hasFirst: !!(getSbFirstImage(sb.id) || sb.composed_image || sb.image_url),
      hasLast: !!getSbLastImage(sb.id),
      hasImage: hasSbImage(sb),
    })
  }

  function getQuadGridImage(storyboardId) {
    const list = sbImages.value[storyboardId]
    if (!Array.isArray(list)) return null
    return list.find((i) => i.status === 'completed' && (i.frame_type === 'quad_grid' || i.frame_type === 'nine_grid') && (i.image_url || i.local_path)) || null
  }

  // ── Video Query & Actions ───────────────────────────────────────────
  function getSbAllVideos(storyboardId) {
    const list = sbVideos.value[storyboardId]
    if (!Array.isArray(list)) return []
    return list.filter((i) => i.status === 'completed' && recordHasPlayableVideoUrl(i))
  }

  function getSbVideo(storyboardId) {
    const all = getSbAllVideos(storyboardId)
    if (all.length === 0) return null
    const selectedId = sbSelectedVideoId.value[storyboardId]
    if (selectedId != null) {
      const found = all.find((v) => v.id === selectedId)
      if (found) return found
    }
    const boards = store.storyboards || []
    const sb = boards.find((b) => b.id === storyboardId)
    if (sb?.selected_video_id != null) {
      const found = all.find((v) => v.id === sb.selected_video_id)
      if (found) return found
    }
    if (sb?.video_url) {
      const found = all.find((v) => v.video_url === sb.video_url || v.local_path === sb.video_url)
      if (found) return found
    }
    return all[0]
  }

  function getNextStoryboard(storyboardId) {
    const list = store.storyboards || []
    const idx = list.findIndex((s) => s.id === storyboardId)
    if (idx === -1 || idx === list.length - 1) return null
    return list[idx + 1]
  }

  function getPrevStoryboard(storyboardId) {
    const list = store.storyboards || []
    const idx = list.findIndex((s) => s.id === storyboardId)
    if (idx === -1 || idx === 0) return null
    return list[idx - 1]
  }

  function canUsePrevTailAsFirst(sb) {
    const p = getPrevStoryboard(sb?.id)
    return !!(p && getSbLastImage(p.id))
  }

  function getVideoStripItems(storyboardId) {
    const all = getSbAllVideos(storyboardId)
    if (!all.length) return []
    const current = getSbVideo(storyboardId)
    const sorted = [...all].sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0))
    return sorted.map((v, idx) => {
      const isActive = !!(current && v.id === current.id)
      return {
        key: `vid-${v.id}`,
        video: v,
        src: assetVideoUrl(v),
        isActive,
        label: isActive ? `版${idx + 1}(当前)` : `第${idx + 1}版`,
      }
    })
  }

  function onSelectSbMainVideo(sb, video) {
    const vUrl = video.video_url || ''
    sbSelectedVideoId.value = { ...sbSelectedVideoId.value, [sb.id]: video.id }
    const row = (store.storyboards || []).find((b) => b.id === sb.id)
    if (row) {
      row.selected_video_id = video.id
      row.video_url = vUrl
    }
    storyboardsAPI.update(sb.id, {
      selected_video_id: video.id,
      video_url: vUrl || null,
    }).catch(e => console.warn('[主视频] 保存后端失败', e))
  }

  function getSbVideoError(storyboardId) {
    if (sbVideoErrors.value[storyboardId]) return sbVideoErrors.value[storyboardId]
    const list = sbVideos.value[storyboardId]
    if (!Array.isArray(list) || list.length === 0) return ''
    if (list[0] && (list[0].status === 'processing' || (list[0].status === 'completed' && recordHasPlayableVideoUrl(list[0])))) return ''
    const hasCompleted = list.some((i) => i.status === 'completed' && recordHasPlayableVideoUrl(i))
    if (hasCompleted) return ''
    const bogusCompleted = list.find(
      (i) => i.status === 'completed' && i.video_url && !recordHasPlayableVideoUrl(i)
    )
    if (bogusCompleted) {
      const u = String(bogusCompleted.video_url || '').trim()
      if (u) return u
      if (bogusCompleted.error_msg) return bogusCompleted.error_msg
    }
    const failed = list.filter((i) => i.status === 'failed' && i.error_msg)
    if (failed.length === 0) return ''
    return failed[0].error_msg
  }

  function getSbResumableFailedVideo(storyboardId) {
    const list = sbVideos.value[storyboardId]
    if (!Array.isArray(list) || list.length === 0) return null
    return list.find((i) => i.status === 'failed' && i.can_resume_poll) || null
  }

  function isSbVideoGenerating(sbId) {
    if (serverVideoBatch.value?.items?.some(i => Number(i.storyboard_id) === Number(sbId) && ['pending', 'running'].includes(i.status))) return true
    if (generatingSbVideoIds.has(sbId)) return true
    const list = sbVideos.value[sbId]
    if (Array.isArray(list) && list.some((i) => i.status === 'processing')) {
      const hasCompleted = list.some((i) => i.status === 'completed' && recordHasPlayableVideoUrl(i))
      if (!hasCompleted) return true
    }
    if (sbId == null || dramaId.value == null || currentEpisodeId.value == null) return false
    return genStore.isRunning({
      dramaId: dramaId.value,
      episodeId: currentEpisodeId.value,
      resourceType: GEN_RESOURCE.SB_VIDEO,
      resourceId: sbId,
    })
  }

  function buildSbGenMeta(sb, resourceType, labelPrefix) {
    const num = sb?.storyboard_number ?? sb?.id
    const epNum = store.currentEpisode?.episode_number
    const dramaTitle = store.drama?.title || ''
    const epLabel = dramaTitle ? `${dramaTitle} · 第${epNum ?? ''}集` : `第${epNum ?? ''}集`
    return {
      dramaId: dramaId.value,
      episodeId: currentEpisodeId.value,
      dramaTitle,
      episodeNumber: epNum,
      resourceType,
      resourceId: sb.id,
      label: `${epLabel} ${labelPrefix} #${num}`,
    }
  }

  // ── Entity / Relation Bindings ──────────────────────────────────────
  function getSbCharacterIds(sbId) {
    const arr = sbCharacterIds.value[sbId]
    return Array.isArray(arr) && arr.length > 0 ? arr : EMPTY_ARR
  }

  function setSbCharacterIds(sbId, v) {
    const next = Array.isArray(v) ? v : []
    sbCharacterIds.value = { ...sbCharacterIds.value, [sbId]: next }
    onStoryboardCharacterChange(sbId)
  }

  async function onStoryboardCharacterChange(sbId) {
    const ids = sbCharacterIds.value[sbId] || []
    try {
      await storyboardsAPI.update(sbId, { character_ids: ids })
    } catch (e) {
      console.warn('[分镜] 保存角色失败', e)
    }
  }

  function charactersAvailableToAddToSb(sbId) {
    const all = store.characters ?? []
    const cur = new Set((getSbCharacterIds(sbId) || []).map((x) => Number(x)))
    return all.filter((c) => c && !cur.has(Number(c.id)))
  }

  function onSbAddCharacterCommand(sbId, charId) {
    const id = Number(charId)
    if (!Number.isFinite(id)) return
    const cur = [...(getSbCharacterIds(sbId) || [])]
    if (cur.some((x) => Number(x) === id)) return
    cur.push(id)
    setSbCharacterIds(sbId, cur)
  }

  function getSbPropIds(sbId) {
    const arr = sbPropIds.value[sbId]
    return Array.isArray(arr) && arr.length > 0 ? arr : EMPTY_ARR
  }

  function setSbPropIds(sbId, v) {
    sbPropIds.value = { ...sbPropIds.value, [sbId]: Array.isArray(v) ? v : [] }
    onStoryboardPropChange(sbId)
  }

  function onStoryboardPropChange(sbId) {
    const ids = sbPropIds.value[sbId] || []
    storyboardsAPI.update(sbId, { prop_ids: ids }).catch(() => {})
  }

  function onStoryboardSceneChange(sbId) {
    const sceneId = sbSceneId.value[sbId] ?? null
    storyboardsAPI.update(sbId, { scene_id: sceneId }).catch(() => {})
  }

  function getSbSelectedScene(sbId) {
    const sceneId = sbSceneId.value[sbId]
    if (sceneId == null) return null
    const list = store.scenes ?? []
    return list.find((s) => Number(s.id) === Number(sceneId)) || null
  }

  function getSbSelectedCharacters(sbId) {
    const ids = getSbCharacterIds(sbId)
    if (!ids.length) return []
    return resolveStoryboardCharacters(ids, store.characters ?? [], store.drama?.characters ?? [])
  }

  function getSbSelectedProps(sbId) {
    const ids = getSbPropIds(sbId)
    if (!ids.length) return []
    const list = store.props ?? []
    return ids.map((id) => list.find((p) => Number(p.id) === Number(id))).filter(Boolean)
  }

  function getMovementLabel(m) {
    if (!m) return ''
    const map = {
      static: '固定',
      push: '推镜',
      pull: '拉镜',
      pan: '横摇',
      tilt: '纵摇',
      tracking: '跟镜',
      crane_up: '升镜',
      crane_dn: '降镜',
      orbit: '环绕',
      handheld: '手持',
      zoom: '变焦',
      roll: '旋转',
      whip_pan: '甩镜',
      spiral: '螺旋',
      hitchcock_zoom: '希区柯克',
      bullet_time: '子弹时间',
      dutch_angle_move: '荷兰角',
      dolly_track: '推轨',
      slowmo_orbit: '升格环绕'
    }
    return map[m] || m
  }

  function onStoryboardUseFirstLastFrameChange() {
    if (storyboardUseFirstLastFrame.value && gridMode.value !== 'single') {
      gridMode.value = 'single'
      ElMessage.info('首尾帧模式已开启，序列图已切换为单张')
    }
    saveProjectSettings?.(false)
  }

  function onLastFrameLayoutLockChange() {
    saveProjectSettings?.(false)
  }

  // ── Data Sync Methods ───────────────────────────────────────────────
  function restoreSelectionsFromBackend() {
    const boards = store.storyboards || []
    for (const sb of boards) {
      const images = getSbAllImages(sb.id)
      if (sbSelectedImgId.value[sb.id] == null) {
        if (sb.first_frame_image_id != null) {
          sbSelectedImgId.value = { ...sbSelectedImgId.value, [sb.id]: sb.first_frame_image_id }
        } else {
          const sbPath = (sb.local_path || '').trim()
          const sbUrl = (sb.image_url || '').trim()
          if (sbPath || sbUrl) {
            const matched = images.find(
              (img) =>
                (sbPath && img.local_path && img.local_path === sbPath) ||
                (sbUrl && img.image_url && img.image_url === sbUrl)
            )
            if (matched) {
              sbSelectedImgId.value = { ...sbSelectedImgId.value, [sb.id]: matched.id }
            }
          }
        }
      }
      if (sbSelectedLastImgId.value[sb.id] == null && sb.last_frame_image_id != null) {
        sbSelectedLastImgId.value = { ...sbSelectedLastImgId.value, [sb.id]: sb.last_frame_image_id }
      }
      if (sbSelectedVideoId.value[sb.id] == null) {
        const vids = getSbAllVideos(sb.id)
        if (sb.selected_video_id != null) {
          const found = vids.find((v) => v.id === sb.selected_video_id)
          if (found) {
            sbSelectedVideoId.value = { ...sbSelectedVideoId.value, [sb.id]: sb.selected_video_id }
          }
        } else if (sb.video_url) {
          const matched = vids.find(
            (v) => (v.video_url && v.video_url === sb.video_url) || (v.local_path && v.local_path === sb.video_url)
          )
          if (matched) {
            sbSelectedVideoId.value = { ...sbSelectedVideoId.value, [sb.id]: matched.id }
          }
        }
      }
    }
  }

  async function loadStoryboardMedia() {
    const boards = store.storyboards || []
    if (boards.length === 0) {
      sbImages.value = {}
      sbVideos.value = {}
      return
    }
    const nextImages = { ...sbImages.value }
    const nextVideos = { ...sbVideos.value }
    await Promise.all(
      boards.map(async (sb) => {
        try {
          const [imgRes, vidRes] = await Promise.all([
            imagesAPI.list({ storyboard_id: sb.id, page: 1, page_size: 100 }),
            videosAPI.list({ storyboard_id: sb.id, page: 1, page_size: 50 })
          ])
          nextImages[sb.id] = (imgRes && imgRes.items) ? imgRes.items : []
          nextVideos[sb.id] = (vidRes && vidRes.items) ? vidRes.items : []
        } catch (_) {
          nextImages[sb.id] = []
          nextVideos[sb.id] = []
        }
      })
    )
    sbImages.value = nextImages
    sbVideos.value = nextVideos
    restoreSelectionsFromBackend()
  }

  async function loadSingleStoryboardMedia(sbId) {
    if (!sbId) return
    try {
      const [imgRes, vidRes] = await Promise.all([
        imagesAPI.list({ storyboard_id: sbId, page: 1, page_size: 100 }),
        videosAPI.list({ storyboard_id: sbId, page: 1, page_size: 50 })
      ])
      sbImages.value = {
        ...sbImages.value,
        [sbId]: (imgRes && imgRes.items) ? imgRes.items : []
      }
      sbVideos.value = {
        ...sbVideos.value,
        [sbId]: (vidRes && vidRes.items) ? vidRes.items : []
      }
      restoreSelectionsFromBackend()
    } catch (_) {
      // 静默忽略，不影响其他分镜的显示
    }
  }

  function syncStoryboardStateFromEpisode(ep) {
    const boards = ep?.storyboards || []
    const nextCharIds = {}
    const nextPropIds = {}
    const nextScene = {}
    const nextDialogue = {}
    const nextNarration = {}
    const nextBgmPrompt = {}
    const nextShot = {}
    const nextTitle = {}
    const nextLocation = {}
    const nextTime = {}
    const nextDuration = {}
    const nextAction = {}
    const nextResult = {}
    const nextAtmosphere = {}
    const nextAngle = {}
    const nextAngleH = {}
    const nextAngleV = {}
    const nextAngleS = {}
    const nextMovement = {}
    const nextLighting = {}
    const nextDof = {}
    const nextLayoutDescription = {}
    const nextCreationMode = {}
    const nextUniversalSegment = {}
    for (const sb of boards) {
      nextScene[sb.id] = sb.scene_id ?? null
      nextDialogue[sb.id] = sb.dialogue ?? ''
      nextNarration[sb.id] = sb.narration ?? ''
      nextBgmPrompt[sb.id] = (sb.bgm_prompt ?? '').toString()
      nextShot[sb.id] = (sb.shot_type ?? '').toString() || ''
      nextTitle[sb.id] = (sb.title ?? '').toString()
      nextLocation[sb.id] = (sb.location ?? '').toString()
      nextTime[sb.id] = (sb.time ?? '').toString()
      nextDuration[sb.id] = sb.duration != null ? Number(sb.duration) : 5
      nextAction[sb.id] = (sb.action ?? '').toString()
      nextResult[sb.id] = (sb.result ?? '').toString()
      nextAtmosphere[sb.id] = (sb.atmosphere ?? '').toString()
      nextAngle[sb.id] = (sb.angle ?? '').toString()
      nextAngleH[sb.id] = sb.angle_h || ''
      nextAngleV[sb.id] = sb.angle_v || ''
      nextAngleS[sb.id] = sb.angle_s || ''
      nextMovement[sb.id] = (sb.movement ?? '').toString()
      nextLighting[sb.id] = sb.lighting_style || ''
      nextDof[sb.id] = sb.depth_of_field || ''
      nextLayoutDescription[sb.id] = (sb.layout_description ?? '').toString()
      const charList = Array.isArray(sb.characters) ? sb.characters : (sb.characters != null ? [sb.characters] : [])
      nextCharIds[sb.id] = charList.map((c) => (typeof c === 'object' && c != null ? Number(c.id) : Number(c))).filter((n) => Number.isFinite(n))
      nextPropIds[sb.id] = Array.isArray(sb.prop_ids) ? sb.prop_ids : []
      nextCreationMode[sb.id] = sb.creation_mode === 'universal' ? 'universal' : 'classic'
      nextUniversalSegment[sb.id] = (sb.universal_segment_text ?? '').toString()
    }
    sbCharacterIds.value = nextCharIds
    sbPropIds.value = nextPropIds
    sbSceneId.value = nextScene
    sbDialogue.value = nextDialogue
    sbNarration.value = nextNarration
    sbBgmPrompt.value = nextBgmPrompt
    sbShotType.value = nextShot
    sbTitle.value = nextTitle
    sbLocation.value = nextLocation
    sbTime.value = nextTime
    sbDuration.value = nextDuration
    sbAction.value = nextAction
    sbResult.value = nextResult
    sbAtmosphere.value = nextAtmosphere
    sbAngle.value = nextAngle
    sbAngleH.value = nextAngleH
    sbAngleV.value = nextAngleV
    sbAngleS.value = nextAngleS
    sbMovement.value = nextMovement
    sbLighting.value = nextLighting
    sbDof.value = nextDof
    sbLayoutDescription.value = nextLayoutDescription
    sbCreationMode.value = nextCreationMode
    sbUniversalSegmentText.value = nextUniversalSegment
  }

  return {
    // 字段映射
    sbCharacterIds,
    sbPropIds,
    sbSceneId,
    sbDialogue,
    sbNarration,
    sbBgmPrompt,
    sbShotType,
    sbTitle,
    sbLocation,
    sbTime,
    sbDuration,
    sbAction,
    sbResult,
    sbAtmosphere,
    sbAngle,
    sbAngleH,
    sbAngleV,
    sbAngleS,
    sbMovement,
    sbLighting,
    sbDof,
    sbLayoutDescription,
    regeneratingLayoutSbIds,
    sbCreationMode,
    sbUniversalSegmentText,

    // 媒体与选择
    sbImages,
    sbVideos,
    sbVideoErrors,
    sbSelectedImgId,
    sbSelectedLastImgId,
    sbSelectedVideoId,

    // 运行/加载集合
    generatingSbImageIds,
    generatingSbFirstImageIds,
    generatingSbLastImageIds,
    generatingSbVideoIds,
    generatingUniversalSegmentIds,
    upscalingSbIds,
    ttsSbIds,
    ttsSbNarrationIds,
    linkingTailFrameIds,
    linkingFirstFrameIds,
    usingPrevTailAsFirstIds,

    // 音频与上传
    sbDialogueAudioPaths,
    sbNarrationAudioPaths,
    sbImageUploadSlotById,

    // 项目与分镜设置
    storyboardCount,
    videoDuration,
    storyboardIncludeNarration,
    storyboardUniversalOmni,
    storyboardUseFirstLastFrame,
    exportingStoryboardSheet,
    lastFrameUseFirstLayoutLock,
    gridMode,

    // 媒体 URL 与预览
    baseUrl,
    previewImageUrl,
    imageUrl,
    assetImageUrl,
    hasAssetImage,
    openImagePreview,
    closeImagePreview,
    assetVideoUrl,
    isHttpVideoUrl,
    recordHasPlayableVideoUrl,
    sbMainVideoPlayerKey,

    // 估算
    clipSecondsForStoryboardEstimate,
    shotCountEstimateFromDurationSec,
    estimateVideoDurationSecFromCharLen,
    scriptStoryboardEstimate,
    scriptEstimateVideoDurationHint,
    scriptEstimateVideoDurationTitle,
    scriptEstimateStoryboardHint,
    scriptEstimateStoryboardTitle,
    scriptTextTrimmedForEstimate,
    userFilledStoryboardCount,
    userFilledVideoDuration,
    getVideoDurationForApi,
    getStoryboardCountForApi,

    // 分镜与图片查询
    isSbUniversalMode,
    uploadingSbImageSlot,
    frameTypeForSlot,
    resolveSbImageById,
    getSbFirstImage,
    getSbLastImage,
    hasSbImage,
    hasSbFirstLastPair,
    missingSbImageSlots,
    getSbAllImages,
    getSbImage,
    getQuadGridImage,

    // 视频查询与操作
    getSbAllVideos,
    getSbVideo,
    getNextStoryboard,
    getPrevStoryboard,
    canUsePrevTailAsFirst,
    getVideoStripItems,
    onSelectSbMainVideo,
    getSbVideoError,
    getSbResumableFailedVideo,
    isSbVideoGenerating,
    buildSbGenMeta,

    // 关联与操作绑定
    getSbCharacterIds,
    setSbCharacterIds,
    onStoryboardCharacterChange,
    charactersAvailableToAddToSb,
    onSbAddCharacterCommand,
    getSbPropIds,
    setSbPropIds,
    onStoryboardPropChange,
    onStoryboardSceneChange,
    getSbSelectedScene,
    getSbSelectedCharacters,
    getSbSelectedProps,
    getMovementLabel,
    onStoryboardUseFirstLastFrameChange,
    onLastFrameLayoutLockChange,

    // 同步方法
    restoreSelectionsFromBackend,
    loadStoryboardMedia,
    loadSingleStoryboardMedia,
    syncStoryboardStateFromEpisode,
  }
}
