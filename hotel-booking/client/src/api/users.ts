import api from './client'
import type { AdminRole, User } from '../types'

// Управление учётными записями (только SUPER_ADMIN — проверяет сервер).

export async function fetchUsers(): Promise<User[]> {
  const { data } = await api.get('/users')
  return data.data
}

export async function createUser(payload: {
  username: string
  name: string
  password: string
  role: AdminRole
}): Promise<User> {
  const { data } = await api.post('/users', payload)
  return data.data
}

// Сервер запрещает деактивировать себя и последнего главного администратора (400 с текстом).
export async function updateUser(
  id: number,
  payload: { name?: string; role?: AdminRole; isActive?: boolean },
): Promise<User> {
  const { data } = await api.put(`/users/${id}`, payload)
  return data.data
}

export async function resetUserPassword(id: number, password: string): Promise<void> {
  await api.patch(`/users/${id}/password`, { password })
}
