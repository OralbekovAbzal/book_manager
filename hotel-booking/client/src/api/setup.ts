import api from './client'
import type { Admin, SetupStatus } from '../types'

// Первичная настройка (мастер при пустой базе). Оба запроса — без токена.

/** Тело POST /api/setup/complete. */
export interface SetupCompletePayload {
  hotel: { name: string; city?: string }
  mainAdmin: { username: string; name: string; password: string }
  users?: Array<{ username: string; name: string; password: string; role: 'ADMIN' | 'STAFF' }>
}

/** Ответ POST /api/setup/complete — те же поля, что у /auth/login (авто-вход). */
export interface SetupCompleteResult {
  token: string
  admin: Admin
}

// Вызывается при старте приложения: решает, показывать мастер или экран входа.
export async function fetchSetupStatus(): Promise<SetupStatus> {
  const { data } = await api.get('/setup/status')
  return data
}

// Сервер отвечает 403, если настройка уже выполнена.
export async function completeSetup(payload: SetupCompletePayload): Promise<SetupCompleteResult> {
  const { data } = await api.post('/setup/complete', payload)
  return data
}
