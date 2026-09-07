import { create } from 'zustand'
import api from '../api/client'
import type { Admin } from '../types'

/** Почему сервер завершил сессию — payload события `auth:revoked` (socketManager.js). */
export type SessionEndReason = 'account_disabled' | 'session_revoked' | 'password_changed'

const SESSION_END_NOTICE: Record<SessionEndReason, string> = {
  account_disabled: 'Учётная запись отключена администратором',
  session_revoked: 'Сессия завершена: выполнен выход на другом устройстве',
  password_changed: 'Пароль изменён — войдите заново с новым паролем',
}

interface AuthStore {
  admin: Admin | null
  token: string | null
  /** Название отеля для шапки: из /api/setup/status до входа, из /api/hotel после. */
  hotelName: string | null
  /** Пояснение на экране входа, почему сессия закончилась (после auth:revoked). */
  notice: string | null
  login: (username: string, password: string) => Promise<void>
  /**
   * Без причины — выход по кнопке: сервер отзывает ВСЕ сессии учётной записи
   * (authController.logout). С причиной — сессию уже отозвал сервер,
   * остаётся только стереть токен и объяснить почему.
   */
  logout: (reason?: SessionEndReason) => void
  restore: () => Promise<void>
  /** Установить сессию, полученную не через /auth/login (авто-вход после мастера настройки). */
  setSession: (token: string, admin: Admin) => void
  setHotelName: (name: string | null) => void
}

export const useAuthStore = create<AuthStore>((set) => ({
  admin: null,
  token: localStorage.getItem('token'),
  hotelName: null,
  notice: null,

  login: async (username, password) => {
    const { data } = await api.post('/auth/login', { username, password })
    localStorage.setItem('token', data.token)
    set({ admin: data.admin, token: data.token, notice: null })
  },

  logout: (reason) => {
    const token = localStorage.getItem('token')
    localStorage.removeItem('token')
    set({
      admin: null,
      token: null,
      notice: reason ? (SESSION_END_NOTICE[reason] ?? SESSION_END_NOTICE.session_revoked) : null,
    })
    if (reason || !token) return
    // Токен из localStorage уже стёрт (интерцептор его не подставит) — передаём
    // явно. Ответ не важен: 401 значит, что сессию уже отозвали с другой стороны.
    api.post('/auth/logout', null, { headers: { Authorization: `Bearer ${token}` } }).catch(() => {})
  },

  restore: async () => {
    const token = localStorage.getItem('token')
    if (!token) return
    try {
      const { data } = await api.get('/auth/me')
      set({ admin: data.admin, token })
    } catch (e) {
      // Токен стираем только если сервер его отверг (401/403). Сеть или 5xx — сервер
      // временно недоступен: токен оставляем, admin не трогаем (покажется экран входа
      // с баннером), после восстановления сервера сессия ещё жива.
      const status = (e as { response?: { status?: number } } | undefined)?.response?.status
      if (status === 401 || status === 403) {
        localStorage.removeItem('token')
        set({ admin: null, token: null })
      }
    }
  },

  // Токен кладём в localStorage так же, как login — его читает axios-интерцептор.
  setSession: (token, admin) => {
    localStorage.setItem('token', token)
    set({ admin, token, notice: null })
  },

  setHotelName: (name) => set({ hotelName: name }),
}))
