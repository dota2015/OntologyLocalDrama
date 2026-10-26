import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useAgentContext = defineStore('agentContext', () => {
  const episodeId = ref(null)
  const episodes = ref([])
  const focusedTarget = ref(null) // { type: 'storyboard', id, number, title }

  function setEpisodeId(id) {
    episodeId.value = id == null || id === '' ? null : Number(id)
  }

  function setEpisodes(list) {
    episodes.value = Array.isArray(list) ? list : []
  }

  function setFocusedTarget(target) {
    focusedTarget.value = target || null
  }

  function clearFocusedTarget() {
    focusedTarget.value = null
  }

  function clear() {
    episodeId.value = null
    episodes.value = []
    focusedTarget.value = null
  }

  return { episodeId, episodes, focusedTarget, setEpisodeId, setEpisodes, setFocusedTarget, clearFocusedTarget, clear }
})
