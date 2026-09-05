import axios from 'axios'
import { API_BASE } from '../config'

const api = axios.create({ baseURL: API_BASE })

/** Сведения из ответа 402 — гейт обслуживания (server/src/middleware/license.js). */
export interface MaintenanceBlock {
  /** Готовый текст сервера: «Обслуживание закончилось …, а эта версия выпущена позже.» */
  message: string
  maintenanceUntil: string | null
  buildDate: string | null
}

/**
 * Обработчик 402 регистрируется, а не импортируется.
 *
 * Прямой импорт стора замкнул бы цикл: client → useLicenseStore → api/license →
 * client. Формально ESM такой цикл переживает, но на горячей перезагрузке это
 * ровно тот случай, когда модуль ловит «is not defined» из временной мёртвой
 * зоны. Регистрация оставляет зависимость односторонней.
 */
let maintenanceListener: ((block: MaintenanceBlock) => void) | null = null

export function onMaintenanceBlocked(fn: (block: MaintenanceBlock) => void): void {
  maintenanceListener = fn
}

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

api.interceptors.response.use(
  (r) => r,
  (err) => {
    const status: number | undefined = err.response?.status

    // 402 — это НЕ 401, и складывать их нельзя. Под гейтом обслуживания закрыты
    // и /auth/me, и /auth/logout: если обработать 402 как «сессия кончилась»,
    // токен сотрётся, страница перезагрузится — и так по кругу, а ввести
    // продлённый ключ станет негде. Вход и /api/license гейт пропускает, поэтому
    // просто поднимаем экран блокировки и отдаём ошибку вызывающему.
    if (status === 402 && err.response?.data?.code === 'MAINTENANCE_EXPIRED') {
      const d = err.response.data
      maintenanceListener?.({
        message: d.message || d.error || 'Обслуживание закончилось.',
        maintenanceUntil: d.maintenanceUntil ?? null,
        buildDate: d.buildDate ?? null,
      })
      return Promise.reject(err)
    }

    // Вход и мастер настройки показывают ошибку сами — неверный пароль не должен
    // перезагружать страницу. 5xx и сетевые ошибки токен не трогают: сервер вернётся,
    // а сессия ещё жива.
    const url: string = err.config?.url ?? ''
    const isAuthFlow = url.includes('/auth/login') || url.includes('/setup/')
    if (status === 401 && !isAuthFlow) {
      localStorage.removeItem('token')
      window.location.reload()
    }
    return Promise.reject(err)
  }
)

export default api
