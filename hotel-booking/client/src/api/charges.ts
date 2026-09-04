import api from './client'
import type { Booking } from '../types'

/**
 * Начисления брони. Итог брони = СУММА ЭТИХ СТРОК, а не результат формулы
 * (см. NOTES, «Ценообразование»). Тариф порождает строки `source='auto'`,
 * администратор правит их или добавляет свои — `source='manual'` с причиной.
 */

export type ChargeKind = 'stay' | 'meal' | 'extra' | 'discount'
export type ChargeSource = 'auto' | 'manual'

export interface BookingCharge {
  id: number
  bookingId: number
  kind: ChargeKind
  label: string
  quantity: number
  unitPrice: number
  amount: number
  /** Для посуточных строк — за какую ночь начислено */
  date: string | null
  source: ChargeSource
  reason: string | null
  createdById: number | null
  createdBy?: { id: number; name: string } | null
  createdAt: string
  updatedAt: string
}

export interface ChargesResponse {
  data: BookingCharge[]
  total: number
  booking: Booking | null
}

/** Ручная строка: причина обязательна — без неё сервер отвечает 400. */
export interface ChargePayload {
  kind: ChargeKind
  label: string
  quantity: number
  unitPrice: number
  date?: string | null
  reason: string
}

export async function fetchCharges(bookingId: number): Promise<ChargesResponse> {
  const { data } = await api.get(`/bookings/${bookingId}/charges`)
  return data
}

export async function addCharge(bookingId: number, payload: ChargePayload): Promise<ChargesResponse> {
  const { data } = await api.post(`/bookings/${bookingId}/charges`, payload)
  return data
}

export async function updateCharge(
  bookingId: number, chargeId: number, payload: Partial<ChargePayload> & { reason: string },
): Promise<ChargesResponse> {
  const { data } = await api.put(`/bookings/${bookingId}/charges/${chargeId}`, payload)
  return data
}

export async function deleteCharge(bookingId: number, chargeId: number): Promise<ChargesResponse> {
  const { data } = await api.delete(`/bookings/${bookingId}/charges/${chargeId}`)
  return data
}

/** Пересобрать автоматические строки по тарифу. Ручные остаются нетронутыми. */
export async function rebuildCharges(bookingId: number): Promise<ChargesResponse> {
  const { data } = await api.post(`/bookings/${bookingId}/charges/rebuild`)
  return data
}

export const CHARGE_KIND_LABELS: Record<ChargeKind, string> = {
  stay: 'Проживание',
  meal: 'Питание',
  extra: 'Услуги',
  discount: 'Скидки',
}
