import api from './client'
import type { Admin, SetupStatus } from '../types'

// Первичная настройка (мастер при пустой базе). Оба запроса — без токена.

/** Тело POST /api/setup/complete. */
export interface SetupCompletePayload {
  hotel: { name: string; city?: string }
  mainAdmin: { username: string; name: string; password: string }
  /** Роль только ADMIN: STAFF сервер больше не создаёт (400), см. interface.md */
  users?: Array<{ username: string; name: string; password: string; role: 'ADMIN' }>
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

/**
 * Завершение мастера. Два разных отказа, и путать их нельзя:
 * - **403** — стоит отметка `setupCompletedAt`, мастер вообще не должен был открыться;
 * - **409** `{ code: 'SETUP_DONE' }` — отметки нет, но в базе уже есть настоящие
 *   учётные записи (двое прошли мастер одновременно, отметка восстановилась из
 *   копии). Создавать вторую «главную» учётку поверх чужих — нельзя, надо войти.
 */
export const SETUP_DONE_CODE = 'SETUP_DONE'

export async function completeSetup(payload: SetupCompletePayload): Promise<SetupCompleteResult> {
  const { data } = await api.post('/setup/complete', payload)
  return data
}
