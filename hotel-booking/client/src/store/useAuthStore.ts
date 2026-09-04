import { create } from 'zustand'
import api from '../api/client'
import type { Admin } from '../types'

interface AuthStore {
  admin: Admin | null
  token: string | null
  /** Название отеля для шапки: из /api/setup/status до входа, из /api/hotel после. */
  hotelName: string | null
  login: (username: string, password: string) => Promise<void>
  logout: () => void
  restore: () => Promise<void>
  /** Установить сессию, полученную не через /auth/login (авто-вход после мастера настройки). */
  setSession: (token: string, admin: Admin) => void
  setHotelName: (name: string | null) => void
}

export const useAuthStore = create<AuthStore>((set) => ({
  admin: null,
  token: localStorage.getItem('token'),
  hotelName: null,

  login: async (username, password) => {
    const { data } = await api.post('/auth/login', { username, password })
    localStorage.setItem('token', data.token)
    set({ admin: data.admin, token: data.token })
  },

  logout: () => {
    localStorage.removeItem('token')
    set({ admin: null, token: null })
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
    set({ admin, token })
  },

  setHotelName: (name) => set({ hotelName: name }),
}))
