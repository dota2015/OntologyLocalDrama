import request from '@/utils/request'

export const videosAPI = {
  createBatch(episodeId, body) {
    return request.post(`/videos/episode/${episodeId}/batch`, body)
  },
  getBatch(episodeId) {
    return request.get(`/videos/episode/${episodeId}/batch`)
  },
  stopBatch(episodeId, batchId) {
    return request.post(`/videos/episode/${episodeId}/batch/stop`, { batch_id: batchId })
  },
  clearBatch(episodeId, batchId) {
    return request.post(`/videos/episode/${episodeId}/batch/clear`, { batch_id: batchId })
  },
  h3Inputs(dramaId, storyboardId) {
    return request.get(`/videos/h3-inputs/${storyboardId}`, { params: { drama_id: dramaId } })
  },
  saveH3Inputs(dramaId, storyboardId, body) {
    return request.put(`/videos/h3-inputs/${storyboardId}`, { ...body, drama_id: dramaId })
  },
  list(params) {
    return request.get('/videos', { params: params || {} })
  },
  /** 创建单条分镜视频生成任务，body: { drama_id, storyboard_id, prompt, image_url?, model?, ... } */
  create(body) {
    return request.post('/videos', body)
  },
  /** 失败后复用已存上游 task 继续轮询，返回 video_generations 记录（含 task_id） */
  resumePoll(id) {
    return request.post(`/videos/${id}/resume-poll`)
  },
  /** 删除某条分镜视频记录 */
  delete(id) {
    return request.delete(`/videos/${id}`)
  },
}
