import api from './client'
import type { Room } from '../types'

export async function fetchRooms(params?: {
  categoryId?: number
  building?: string
  floor?: number
  isActive?: boolean
}): Promise<Room[]> {
  const { data } = await api.get('/rooms', { params })
  return data.data
}

export async function fetchCategories() {
  const { data } = await api.get('/categories')
  return data.data
}
