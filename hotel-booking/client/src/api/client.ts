import axios from 'axios'
import { API_BASE } from '../config'

const api = axios.create({ baseURL: API_BASE })

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

api.interceptors.response.use(
  (r) => r,
  (err) => {
    // Вход и мастер настройки показывают ошибку сами — неверный пароль не должен
    // перезагружать страницу. 5xx и сетевые ошибки токен не трогают: сервер вернётся,
    // а сессия ещё жива.
    const url: string = err.config?.url ?? ''
    const isAuthFlow = url.includes('/auth/login') || url.includes('/setup/')
    if (err.response?.status === 401 && !isAuthFlow) {
      localStorage.removeItem('token')
      window.location.reload()
    }
    return Promise.reject(err)
  }
)

export default api
