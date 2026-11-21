const path = require('path');
const imageClient = require('./imageClient');
const { storyboardCharacterIds } = require('./storyboardCast');
const { isLastFrameType, rowUseFirstFrameLayoutLock } = require('./imageFramePolicy');
const { getCleanSingleCharacterRef, getCleanSingleSceneRef } = require('./imageProcessing');

async function resolveImageGenerationReferences(db, log, row, config, elapsed) {
  const imageGenId = row.id;
  const refLimits = imageClient.getStoryboardReferenceLimits(config, row.model);
  log.info('[图生] Step2 参考图上限', {
    id: imageGenId,
    total: refLimits.total,
    max_characters: refLimits.maxCharacters,
    max_objects: refLimits.maxObjects,
    elapsed: elapsed(),
  });

  // ── Step 2: 解析参考图 ───────────────────────────────────────────
  const loadConfigForStep2 = require('../config').loadConfig;
  const cfgStep2 = loadConfigForStep2();
  const storageRoot = path.isAbsolute(cfgStep2?.storage?.local_path || '')
    ? cfgStep2.storage.local_path
    : path.join(process.cwd(), cfgStep2?.storage?.local_path || './data/storage');
  let reference_image_urls = null;
  let reference_source = null;
  // 参考图映射说明：告诉图片AI每张参考图对应哪个角色/场景，防止模型模仿宫格布局
  let reference_context_note = null;
  const shotLooks=row.storyboard_id?require('./wardrobeService').getShot(db,row.storyboard_id).characters:[];
  const imagePlan = require('./storyboardImagePlan');
  const sourceShot = row.storyboard_id ? db.prepare('SELECT * FROM storyboards WHERE id=? AND deleted_at IS NULL').get(row.storyboard_id) : null;
  const directorShot = imagePlan.isStructuredShot(sourceShot);
  let plannedReferences = null;
  let hasFirstFrameLayoutLock = false;
  if (directorShot) {
    plannedReferences = imagePlan.resolveReferences(db, sourceShot, row, shotLooks, refLimits);
    reference_image_urls = plannedReferences.refs.map(r => r.source);
    reference_context_note = plannedReferences.note;
    hasFirstFrameLayoutLock = plannedReferences.lock;
    reference_source = '导演素材规划';
  } else {

    if (row.reference_images) {
      try {
        const parsed = JSON.parse(row.reference_images);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const cleaned = [];
          for (const rawRef of parsed.slice(0, refLimits.total)) {
            let cRef = await getCleanSingleCharacterRef(storageRoot, rawRef, log);
            cRef = await getCleanSingleSceneRef(storageRoot, cRef, null, db, log);
            cleaned.push(cRef);
          }
          reference_image_urls = cleaned;
          reference_context_note = reference_image_urls.map((_, i) => `Image ${i + 1}: supplied visual reference`).join('\n');
          reference_source = 'DB';
        }
      } catch (_) {}
    }

    // 尾帧始终参考首帧身份和服装；构图锁只控制是否同时保持站位、取景。
    if (row.storyboard_id) {
      const isLastFrame = isLastFrameType(row.frame_type);
      const useFirstLayoutLock = rowUseFirstFrameLayoutLock(row);
      if (isLastFrame) {
        try {
          const sbFirst = db.prepare(`
            SELECT first_frame_image_id, image_url, local_path,
                   last_frame_image_url, last_frame_local_path
            FROM storyboards WHERE id = ? AND deleted_at IS NULL
          `).get(Number(row.storyboard_id));

          let firstRef = null;
          if (sbFirst) {
            // 优先用显式绑定的 first_frame 图片
            if (sbFirst.first_frame_image_id) {
              const ig = db.prepare('SELECT local_path, image_url FROM image_generations WHERE id = ?').get(Number(sbFirst.first_frame_image_id));
              if (ig) firstRef = ig.local_path || ig.image_url;
            }
            if (!firstRef) firstRef = sbFirst.local_path || sbFirst.image_url; // 兼容旧主图即首帧
          }

          if (firstRef) {
            hasFirstFrameLayoutLock = !!useFirstLayoutLock;
            const layoutLabel = useFirstLayoutLock
              ? 'Image 1 LAYOUT_LOCK: 本镜首帧，人物身份和服装的权威参考；衣服款式、颜色、图案、层次、鞋子和配饰保持一致，并保持左右站位、相机取景与布局，仅演化姿态/表情/结果。'
              : 'Image 1 WARDROBE_LOCK: 本镜首帧，保持人物身份和实际穿着的服装、颜色、款式、配饰；允许按镜头要求改变构图。 First-frame identity and wardrobe reference; camera composition may change.';
            if (!reference_image_urls || reference_image_urls.length === 0) {
              reference_image_urls = [firstRef];
              reference_context_note = layoutLabel;
              reference_source = 'auto-first-frame-for-last (layout lock)';
            } else {
              // 已存在参考时，优先插入到最前面（最高权重）
              const oldLabels = (reference_context_note || '').split('\n');
              const staticRelative = ref => {
                try {
                  const pathname = /^https?:/i.test(ref) ? new URL(ref).pathname : ref;
                  return decodeURIComponent(pathname.replace(/^\/static\//, ''));
                } catch { return ref; }
              };
              const kept = reference_image_urls.map((ref, i) => ({ ref, label: oldLabels[i] || 'supplied visual reference' }))
                .filter(item => !imageClient.refListHasCanonical([staticRelative(firstRef)], staticRelative(item.ref))).slice(0, refLimits.total - 1);
              reference_image_urls = [firstRef, ...kept.map(item => item.ref)];
              reference_context_note = [layoutLabel, ...kept.map(item => item.label)]
                .map((label, i) => label.replace(/^Image(?:\s+\d+)?(?=:|\s)/i, `Image ${i + 1}`)).join('\n');
              reference_source = (reference_source || 'mixed') + '+first-frame-layout-lock';
            }
            log.info('[图生] 尾帧自动注入首帧作为站位锁参考', {
              id: imageGenId,
              first_ref: String(firstRef).slice(0, 80),
              total_refs: reference_image_urls.length,
              layout_lock: hasFirstFrameLayoutLock,
            });
          } else {
            log.warn('[图生] 尾帧生成但未找到可用的首帧参考图，无法强制站位锁', { id: imageGenId, storyboard_id: row.storyboard_id });
          }
        } catch (e) {
          log.warn('[图生] 尾帧首帧参考注入失败（继续）', { id: imageGenId, error: e.message });
        }
      }
    }

    // 尾帧合并参考图：
    // 【关键防重复机制】：启用首帧站位锁且首帧有效时，首帧已包含本镜全部人物站位、服装与场景透视环境。
    // 此时绝对不能追加冗余的角色单人卡/四视图或场景参考图，否则生图模型会误判为需在画面中额外画出独立人物，造成人物重复/克隆（如3人变5人）。
    // 在首帧站位锁模式下，仅允许保留独立道具参考图（如有），严禁追加人物和场景卡。
    if (row.storyboard_id) {
      const sb = sourceShot;
      if (sb) {
        const refs = [];
        const refLabels = [];
        if (sb.scene_id && !hasFirstFrameLayoutLock) {
          const scene = db.prepare('SELECT image_url, local_path, location FROM scenes WHERE id = ? AND deleted_at IS NULL').get(sb.scene_id);
          if (scene) {
            const locationName = scene.location || 'scene';
            // 优先使用 scenes 表当前主图（image_url / local_path），只有当前字段为空才降级使用历史 quad_panel_0 面板
            // 这样“重新生成场景图”后，分镜图生成能立即取到最新图片
            let sceneRef = scene.local_path || scene.image_url;
            let isPanel = false;
            if (!sceneRef) {
              const scenePanel = db.prepare(
                `SELECT local_path, image_url FROM image_generations
                 WHERE scene_id = ? AND frame_type = 'quad_panel_0' AND status = 'completed'
                 ORDER BY id DESC LIMIT 1`
              ).get(sb.scene_id);
              if (scenePanel && (scenePanel.local_path || scenePanel.image_url)) {
                sceneRef = scenePanel.local_path || scenePanel.image_url;
                isPanel = true;
              }
            }
            if (sceneRef && imageClient.canAddStoryboardObjectRef(refLabels, refLimits)) {
              const cleanSceneRef = await getCleanSingleSceneRef(storageRoot, sceneRef, sb.scene_id, db, log);
              refs.push(cleanSceneRef);
              refLabels.push(`Image ${refs.length}: scene background reference for "${locationName}"${isPanel ? ' (establishing wide shot from history panel)' : ' (establishing wide shot)'} `);
            }
          }
        } else if (hasFirstFrameLayoutLock) {
          log.info('[图生] 尾帧首帧站位锁已激活，跳过独立场景参考图，以首帧环境为准', { id: imageGenId });
        }
        const cast = storyboardCharacterIds(db, sb);
        if (!hasFirstFrameLayoutLock) {
          for (const cid of cast) {
            if (!imageClient.canAddStoryboardCharacterRef(refLabels, refLimits)) break;
            const c = db.prepare(`SELECT c.name, c.image_url, c.local_path,
              coalesce(nullif(l.four_view_image_url,''), nullif(l.local_path,''), l.image_url) AS library_image
              FROM characters c LEFT JOIN character_libraries l ON l.id=c.source_library_id AND l.deleted_at IS NULL
              WHERE c.id=? AND c.drama_id=? AND c.deleted_at IS NULL`).get(cid, row.drama_id);
            if (!c) continue;
            // 优先使用 characters 表当前主图（image_url / local_path），只有当前字段为空才降级使用历史 quad_panel_1 面板
            let charRef = shotLooks.find(look=>look.id===Number(cid))?.reference_image || c.local_path || c.image_url || c.library_image;
            if (!charRef) {
              const charPanel = db.prepare(
                `SELECT local_path, image_url FROM image_generations
                 WHERE character_id = ? AND frame_type = 'quad_panel_1' AND status = 'completed'
                 ORDER BY id DESC LIMIT 1`
              ).get(Number(cid));
              if (charPanel && (charPanel.local_path || charPanel.image_url)) {
                charRef = charPanel.local_path || charPanel.image_url;
              }
            }
            if (charRef) {
              const cleanRef = await getCleanSingleCharacterRef(storageRoot, charRef, log);
              refs.push(cleanRef);
              refLabels.push(`Image ${refs.length}: character appearance reference for "${c.name || 'character'}" (facial identity and outfit reference only; do NOT copy standing pose or placement)`);
            }
          }
        } else if (hasFirstFrameLayoutLock) {
          log.info('[图生] 尾帧首帧站位锁已激活，跳过独立角色参考图，以首帧角色形象与站位为准，防止多重克隆', { id: imageGenId });
        }
        // ── 分镜关联道具（storyboard_props）→ 参考图（前端「物品」与 DB 一致，此前未参与 Step2）──
        try {
          const propLinks = db.prepare('SELECT prop_id FROM storyboard_props WHERE storyboard_id = ?').all(row.storyboard_id);
          for (const link of propLinks) {
            if (!imageClient.canAddStoryboardObjectRef(refLabels, refLimits)) break;
            const prop = db.prepare(
              'SELECT name, image_url, local_path, ref_image, extra_images FROM props WHERE id = ? AND deleted_at IS NULL'
            ).get(Number(link.prop_id));
            if (!prop) continue;
            let propRef = prop.ref_image || prop.local_path || prop.image_url;
            if (!propRef && prop.extra_images) {
              try {
                const extras = typeof prop.extra_images === 'string' ? JSON.parse(prop.extra_images) : prop.extra_images;
                if (Array.isArray(extras) && extras[0]) propRef = extras[0];
              } catch (_) {}
            }
            if (propRef && !imageClient.refListHasCanonical(refs, propRef)) {
              refs.push(propRef);
              refLabels.push(`Image ${refs.length}: prop/object appearance reference for "${prop.name || 'prop'}"`);
            }
          }
        } catch (_) {}
        if (refs.length > 0) {
          if (!reference_image_urls || reference_image_urls.length === 0) {
            reference_image_urls = refs;
            reference_source = 'storyboard 自动解析';
            if (refLabels.length > 0) {
              reference_context_note = refLabels.slice(0, refs.length).join('\n');
            }
          } else {
            const mergedRefs = [...reference_image_urls];
            const mergedLabels = (reference_context_note || '').split('\n').filter(Boolean);
            for (let ri = 0; ri < refs.length; ri++) {
              if (mergedRefs.length >= refLimits.total) break;
              if (!imageClient.refListHasCanonical(mergedRefs, refs[ri])) {
                mergedRefs.push(refs[ri]);
                if (refLabels[ri]) mergedLabels.push(refLabels[ri]);
              }
            }
            reference_image_urls = mergedRefs.slice(0, refLimits.total);
            reference_context_note = mergedLabels
              .slice(0, reference_image_urls.length)
              .map((lbl, idx) => lbl.replace(/^Image\s+\d+/i, `Image ${idx + 1}`))
              .join('\n');
            reference_source = (reference_source || 'mixed') + '+storyboard-refs';
            log.info('[图生] 已与既有参考图（如首帧站位锁）合并分镜角色/场景参考', {
              id: imageGenId,
              total_refs: reference_image_urls.length,
            });
          }
        }
      }
    }
    // 站位锁模式下首帧已是造型与身份权威，不强制要求注入单独的 look.reference_image
    if (!hasFirstFrameLayoutLock) {
      for(const look of shotLooks){
        if(look.reference_image) {
          const cleanLookRef = await getCleanSingleCharacterRef(storageRoot, look.reference_image, log);
          if (!imageClient.refListHasCanonical(reference_image_urls || [], look.reference_image) &&
              !imageClient.refListHasCanonical(reference_image_urls || [], cleanLookRef)) {
            throw new Error(`人物「${look.name}」的造型参考图未能加入，请减少其他参考图后重试`);
          }
        }
      }
    }
  }
  log.info('[图生] Step2 参考图', {
    id: imageGenId,
    source: reference_source || '无',
    count: reference_image_urls ? reference_image_urls.length : 0,
    paths: (reference_image_urls || []).map(s => String(s).slice(0, 80)),
    elapsed: elapsed(),
  });

  // ── Step 2.5: 单张分镜图 + 有参考图时，记录参考图映射（由 callGeminiImageApi 处理 parts 结构）───
  // Gemini 正确做法：文字说明→参考图→生成指令（交替结构），在 imageClient 中组装
  // 这里只记录日志，不再污染主 prompt 文本
  if (row.storyboard_id && row.frame_type !== 'quad_grid' && row.frame_type !== 'nine_grid' && reference_image_urls && reference_image_urls.length > 0) {
    log.info('[图生] Step2.5 参考图就绪，上传前将按体积/分辨率优化', {
      id: imageGenId,
      ref_count: reference_image_urls.length,
      context_note: reference_context_note || '(无标签)',
    });
  }

  return { reference_image_urls, reference_context_note, shotLooks, directorShot, sourceShot, plannedReferences };
}

module.exports = { resolveImageGenerationReferences };
