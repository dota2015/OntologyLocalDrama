/**
 * Resolve the browser-side input gate from the H3 plan compiled by the server.
 * The server remains authoritative and performs the final asset validation.
 */
export function h3ShotInputPolicy(h3Data, { hasFirstFrame = false } = {}) {
  const plan = h3Data?.h3_generation_plan || {}
  const mode = h3Data?.resolved_mode || plan.mode || null
  const firstFramePolicy = plan.first_frame_policy || null

  if (mode === 'ref2va') {
    return {
      mode,
      firstFramePolicy,
      allowed: true,
      useStoryboardFrames: false,
      reason: '',
    }
  }

  if (mode === 'fl2va') {
    if (firstFramePolicy === 'inherit_tail') {
      const previousVideoReady = !!h3Data?.previous_storyboard?.video_ready
      return {
        mode,
        firstFramePolicy,
        allowed: previousVideoReady,
        useStoryboardFrames: false,
        reason: previousVideoReady
          ? ''
          : '本镜规划为 FL2VA 并继承上一镜尾帧，但上一镜尚无已完成视频。请先生成上一镜视频。',
      }
    }
    return {
      mode,
      firstFramePolicy,
      allowed: !!hasFirstFrame,
      useStoryboardFrames: true,
      reason: hasFirstFrame
        ? ''
        : '本镜规划为 FL2VA，需要首帧作为视频起始锚点。请先生成或上传首帧。',
    }
  }

  return {
    mode,
    firstFramePolicy,
    allowed: false,
    useStoryboardFrames: false,
    reason: '本镜缺少有效的 H3 执行方案，请重新运行导演生成分镜脚本，或在镜头配置中明确选择 FL2VA / Ref2VA。',
  }
}
