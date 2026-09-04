import api from './client'
import type { HotelSettings } from '../types'

export async function fetchHotel(): Promise<HotelSettings> {
  const { data } = await api.get('/hotel')
  return data.data
}

export async function updateHotel(payload: Partial<HotelSettings>): Promise<HotelSettings> {
  const { data } = await api.put('/hotel', payload)
  return data.data
}
