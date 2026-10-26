import request from '@/utils/request'
export const creativeSettingsAPI = {
  speechDelivery: id => request.get(`/storyboards/${id}/speech-delivery`),
  presets: () => request.get('/settings/narrative-styles'),
  getWardrobe: path => request.get(path),
  saveWardrobe: (path, body) => request.put(path, body),
}
