import request from '@/utils/request'

export const h3InstancesAPI = {
  get() {
    return request.get('/settings/h3-instances')
  },
  update(body) {
    return request.put('/settings/h3-instances', body)
  },
  test(url) {
    return request.post('/settings/h3-instances/test', { url })
  },
}
