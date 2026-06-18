import { create } from 'zustand'
import api from '../api/client'
import type { Admin } from '../types'

interface AuthStore {
  admin: Admin | null
  token: string | null
  login: (username: string, password: string) => Promise<void>
  logout: () => void
  restore: () => Promise<void>
}

export const useAuthStore = create<AuthStore>((set) => ({
  admin: null,
  token: localStorage.getItem('token'),

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
    } catch {
      localStorage.removeItem('token')
      set({ admin: null, token: null })
    }
  },
}))
