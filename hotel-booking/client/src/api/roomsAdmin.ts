import api from './client'
import type { Room } from '../types'

export async function fetchAllRooms(params?: { categoryId?: number; building?: string; isActive?: boolean }): Promise<Room[]> {
  const { data } = await api.get('/rooms', { params })
  return data.data
}

export async function createRoom(payload: {
  number: string; categoryId: number; building: string; floor: number; features?: string[]; capacity?: string
}): Promise<Room> {
  const { data } = await api.post('/rooms', payload)
  return data.data
}

export async function updateRoom(id: number, payload: Partial<{
  number: string; categoryId: number; building: string; floor: number; features: string[]; capacity: string; isActive: boolean
}>): Promise<Room> {
  const { data } = await api.put(`/rooms/${id}`, payload)
  return data.data
}

export async function deactivateRoom(id: number): Promise<Room> {
  const { data } = await api.delete(`/rooms/${id}`)
  return data.data
}
