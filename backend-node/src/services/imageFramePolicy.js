const LAST_FRAME_TYPES = new Set(['last', 'storyboard_last', 'tail', 'last_frame']);

function isLastFrameType(frameType) {
  if (frameType == null || frameType === '') return false;
  return LAST_FRAME_TYPES.has(String(frameType).toLowerCase());
}

/** 创建记录时：仅尾帧写入 use_first_frame_layout_lock；默认 1（注入首帧站位参考） */
function resolveUseFirstFrameLayoutLock(req, frameType) {
  if (!isLastFrameType(frameType)) return null;
  const v = req?.use_first_frame_layout_lock;
  if (v === false || v === 0 || v === '0') return 0;
  if (v === true || v === 1 || v === '1') return 1;
  return 1;
}

/** 处理任务时：尾帧且未显式关闭则启用首帧站位锁 */
function rowUseFirstFrameLayoutLock(row) {
  if (!row || !isLastFrameType(row.frame_type)) return false;
  const v = row.use_first_frame_layout_lock;
  if (v === 0 || v === false) return false;
  return true;
}

module.exports = { isLastFrameType, rowUseFirstFrameLayoutLock, resolveUseFirstFrameLayoutLock };
