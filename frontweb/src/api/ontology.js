import request from '@/utils/request'

export const ontologyAPI = {
  // 获取当前剧集的不可变本体语义包
  getSemanticPackage(episodeId) {
    return request.get(`/episodes/${episodeId}/ontology/semantic-package`)
  },

  // 运行视听本体质量门禁（SHACL Invariants Check）
  validateInvariants(episodeId) {
    return request.post(`/episodes/${episodeId}/ontology/validate`, {})
  },

  // 统一抽取剧目全量本体资产（角色、道具、场景空间地标）
  extractEntities(episodeId) {
    return request.post(`/episodes/${episodeId}/ontology/extract-entities`, {})
  },

  // 启动影视导演视听智能体（规划 -> 推演 -> 自省审校 -> 入库）
  directorGenerate(episodeId, data = {}) {
    return request.post(`/episodes/${episodeId}/ontology/director-generate`, data)
  },

  // 启动全生命周期全剧导演智能体（故事梗概 ➔ 多集剧本 ➔ 角色/道具尺寸/场景地标抽取 ➔ 逐集动态分镜 ➔ 门禁自纠）
  directorFullPipeline(dramaId, data = {}) {
    return request.post(`/dramas/${dramaId}/ontology/director-full-pipeline`, data)
  },

  // 针对单个分镜的导演定向原子微调（微观流程：针对特定元素直指微调）
  directorRefineShot(storyboardId, instruction) {
    return request.post(`/storyboards/${storyboardId}/ontology/director-refine`, { instruction })
  },

  // 智能对齐与清理剧目陈旧过时资产
  reconcileDramaAssets(dramaId) {
    return request.post(`/dramas/${dramaId}/ontology/reconcile-assets`, {})
  },

  // 人机协同：输入名称或线索，AI 结合剧本上下文智能分析提取实体全量属性
  autocompleteEntity(dramaId, data) {
    return request.post(`/dramas/${dramaId}/ontology/autocomplete-entity`, data)
  },
}

export default ontologyAPI
