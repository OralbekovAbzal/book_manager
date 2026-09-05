import api from './client'
import type { Booking, GuestDocType, GuestSex } from '../types'

/**
 * Питание и услуги брони. Присылаются ЦЕЛИКОМ: сервер заменяет набор,
 * поэтому снятая галочка «Обед» и есть удаление строки.
 * Поле отсутствует → набор не трогаем (частичное сохранение из другого экрана).
 */
export interface BookingServicePayload {
  serviceId: number
  /** Сколько взрослых пользуется услугой (для per_person / per_person_night) */
  adults?: number
  children?: number
  /** Сколько раз (для per_night / per_booking) */
  quantity?: number
}

/**
 * Документ гостя в теле запроса.
 *
 * Три состояния поля, и они РАЗНЫЕ:
 *   - ключа нет вовсе   → сервер поле не трогает (частичный PUT из шахматки или
 *     из правки заметки не имеет права стереть паспорт);
 *   - `''` или `null`   → стереть (очищенный `<input>` присылает пустую строку);
 *   - значение          → записать.
 * Поэтому поля необязательные, а очистка идёт именно пустой строкой, а не
 * пропуском ключа.
 *
 * Даты отправляем строго 'YYYY-MM-DD' (сервер проверяет strictMode) — обратно
 * они придут полным ISO, см. комментарий у `Booking`.
 */
export interface GuestDocPayload {
  guestCitizenship?: string | null
  guestDocType?: GuestDocType | '' | null
  guestDocNumber?: string | null
  guestDocExpiry?: string | null
  guestBirthDate?: string | null
  guestSex?: GuestSex | '' | null
}

export interface BookingPayload extends GuestDocPayload {
  roomId: number
  guestName: string
  guestPhone?: string
  checkIn: string
  checkOut: string
  source?: string
  notes?: string
  status?: 'CONFIRMED' | 'CHECKED_IN'
  adultsWithMeals?: number
  childrenWithMeals?: number
  adultsNoMeals?: number
  childrenNoMeals?: number
  extraBedsWithMeals?: number
  extraBedsNoMeals?: number
  disabledAdults?: number
  disabledChildren?: number
  discountPercent?: number
  prepaymentPercent?: number
  totalAmount?: number
  prepaidAmount?: number
  paidAmount?: number
  flags?: string[]
  /**
   * Фактические заезд/выезд (ISO datetime или null). Обычно их проставляют кнопки
   * «Заезд»/«Выезд», здесь — ручная правка администратором, если кнопку нажали
   * не вовремя. Сервер принимает поля только у ADMIN/SUPER_ADMIN (иначе 403),
   * поэтому клиент их и не отправляет с ролью STAFF.
   */
  actualCheckInAt?: string | null
  actualCheckOutAt?: string | null
  services?: BookingServicePayload[]
  shiftId?: number | null
  /** Осознанная продажа номера из квоты партнёра (после 409 ALLOTMENT_CONFLICT) */
  allowAllotmentOverride?: boolean
  /** Явное «Пересчитать по тарифу»: пересобрать автоматические строки начислений */
  recalcCharges?: boolean
}

/** Полная бронь с сервера (гости, суммы, room.category) — объект из сетки может быть частичным. */
export async function fetchBooking(id: number): Promise<Booking> {
  const { data } = await api.get(`/bookings/${id}`)
  return data.data
}

export async function createBooking(payload: BookingPayload): Promise<Booking> {
  const { data } = await api.post('/bookings', payload)
  return data.data
}

export async function updateBooking(id: number, payload: Partial<BookingPayload>): Promise<Booking> {
  const { data } = await api.put(`/bookings/${id}`, payload)
  return data.data
}

export async function cancelBooking(id: number): Promise<Booking> {
  const { data } = await api.delete(`/bookings/${id}`)
  return data.data
}

export async function checkInBooking(id: number): Promise<Booking> {
  const { data } = await api.patch(`/bookings/${id}/checkin`)
  return data.data
}

export async function checkOutBooking(id: number): Promise<Booking> {
  const { data } = await api.patch(`/bookings/${id}/checkout`)
  return data.data
}

/**
 * Ручная правка фактического заезда/выезда администратором. В отличие от
 * `updateBooking`, работает и на ЗАКРЫТОЙ (CHECKED_OUT/CANCELLED) брони —
 * ровно тот случай, когда время выезда чаще всего и нужно поправить.
 */
export async function updateActualTimes(
  id: number,
  payload: { actualCheckInAt?: string | null; actualCheckOutAt?: string | null },
): Promise<Booking> {
  const { data } = await api.patch(`/bookings/${id}/actual-times`, payload)
  return data.data
}

export async function checkAvailability(params: {
  roomId: number
  checkIn: string
  checkOut: string
  excludeBookingId?: number
}): Promise<{ available: boolean; conflict: Booking | null }> {
  const { data } = await api.post('/bookings/check-availability', params)
  return data
}

export interface MoveResult {
  original: Booking
  created: Booking | null  // null если same-day move (без сплита)
}

/**
 * Переезд гостя в другой номер.
 *
 * `allowAllotmentOverride` — осознанная продажа номера из квоты партнёра, тот же
 * флаг, что и при сохранении брони. Без него сервер отвечает
 * `409 { code: 'ALLOTMENT_CONFLICT' }`, и квота блокирует переезд намертво:
 * обойти её из окна переезда было нечем.
 */
export async function moveBooking(
  id: number,
  newRoomId: number,
  moveDate: string,
  allowAllotmentOverride = false,
): Promise<MoveResult> {
  const { data } = await api.post(`/bookings/${id}/move`, {
    newRoomId,
    moveDate,
    ...(allowAllotmentOverride ? { allowAllotmentOverride: true } : {}),
  })
  return data.data
}
