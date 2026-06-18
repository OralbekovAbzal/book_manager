import api from './client'
import type { BookingFlagItem, FlagEffects } from '../store/useSettingsStore'

// DB-строка метки. `code` — стабильный идентификатор (хранится в Booking.flags).
interface FlagRow {
  id: number
  code: string
  label: string
  color?: string | null
  effects?: FlagEffects | null
  order: number
}

// В клиентскую форму: id = code (так все существующие потребители работают без изменений)
function toItem(r: FlagRow): BookingFlagItem {
  return { id: r.code, label: r.label, effects: r.effects ?? undefined }
}

export async function fetchBookingFlags(): Promise<BookingFlagItem[]> {
  const { data } = await api.get('/booking-flags')
  return (data.data as FlagRow[]).map(toItem)
}

export async function createBookingFlag(payload: { label: string; effects?: FlagEffects; order?: number }): Promise<BookingFlagItem> {
  const { data } = await api.post('/booking-flags', payload)
  return toItem(data.data)
}

export async function updateBookingFlag(code: string, payload: { label?: string; effects?: FlagEffects | null; order?: number }): Promise<BookingFlagItem> {
  const { data } = await api.put(`/booking-flags/${code}`, payload)
  return toItem(data.data)
}

export async function deleteBookingFlag(code: string): Promise<void> {
  await api.delete(`/booking-flags/${code}`)
}
