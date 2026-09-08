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

// Создание, правка и удаление меток с клиента не вызываются: в интерфейсе метки
// только выбираются из справочника. Роуты `POST/PUT/DELETE /booking-flags` на
// сервере остались — обёртки убраны как мёртвые (D9-013).
