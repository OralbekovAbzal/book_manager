import api from './client'
import type { BookingStatus } from '../types'

/**
 * Платежи — журнал ПРИНЯТЫХ денег.
 *
 *   начисления (BookingCharge) → сколько гость должен
 *   платежи    (Payment)       → сколько с него принято
 *   долг = начислено − принято
 *
 * Типы держим здесь, а не в types/index.ts: раздел самостоятельный, и его
 * не нужно тянуть в общий модуль ради трёх интерфейсов.
 */

export type PaymentKind = 'payment' | 'refund'
export type PaymentMethod = 'cash' | 'card' | 'transfer'

export const METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Наличные',
  card: 'Карта',
  transfer: 'Перевод',
}

export interface Payment {
  id: number
  bookingId: number
  kind: PaymentKind
  amount: number
  method: PaymentMethod
  adminId: number | null
  adminName: string
  shiftId: number | null
  businessDate: string | null
  paidAt: string
  comment: string | null
  refundOfId: number | null
  /** Отменённая запись: в суммы не входит, но остаётся видна вместе с причиной */
  voidedAt: string | null
  voidReason: string | null
  voidedBy?: { id: number; name: string } | null
  admin?: { id: number; name: string; username: string } | null
  booking?: { id: number; guestName: string; room?: { id: number; number: string } | null }
}

export interface BookingMoney {
  bookingId: number
  /** Сколько должен: сумма строк начислений; без строк — сохранённый итог брони */
  charged: number
  chargesTotal: number
  /** false — начислений ещё нет, «начислено» взято из Booking.totalAmount */
  chargesFromRows: boolean
  totalAmount: number
  prepaidAmount: number
  paid: number
  /** Отрицательный долг — переплата */
  due: number
}

export interface DebtRow {
  id: number
  guestName: string
  guestPhone: string | null
  checkIn: string
  checkOut: string
  /**
   * Статус брони. С волны 5a в списке долгов есть и ОТМЕНЁННЫЕ брони с
   * незакрытыми деньгами: отмена снимает начисления, и принятая предоплата
   * становится отрицательным долгом — «к возврату». Без статуса такая строка
   * выглядела бы обычной бронью с переплатой.
   */
  status: BookingStatus
  totalAmount: number
  prepaidAmount: number
  paidAmount: number
  room: { id: number; number: string; building: string } | null
  /**
   * Номера всей цепочки строкой: «12 → 15» у гостя, который переезжал.
   * Продолжения отдельными строками в долгах не приходят — счёт один, и в кассе
   * он одна строка (data-and-money.md). Для брони без переездов равен номеру
   * из `room`; поле необязательное — старый сервер его не отдаёт.
   */
  rooms?: string | null
  charged: number
  chargesFromRows: boolean
  paid: number
  due: number
}

export interface MethodTotals {
  method: PaymentMethod
  label: string
  received: number
  refunded: number
  net: number
  count: number
}

export interface AdminTotals {
  adminId: number | null
  adminName: string
  received: number
  refunded: number
  net: number
  count: number
}

export interface ShiftSummary {
  shift: { id: number; date: string; createdBy?: { id: number; name: string } }
  totals: {
    received: number
    refunded: number
    net: number
    count: number
    voidedCount: number
    voidedAmount: number
  }
  byMethod: MethodTotals[]
  byAdmin: AdminTotals[]
  payments: Payment[]
}

export async function fetchBookingPayments(
  bookingId: number,
): Promise<{ payments: Payment[]; summary: BookingMoney }> {
  const { data } = await api.get(`/payments/booking/${bookingId}`)
  return data.data
}

/**
 * Окно списка долгов, каким его применил сервер.
 * `days: null` — окна нет, показаны все долги; `truncated` — упёрлись в предел
 * выдачи (300 строк), и в списке видно НЕ всё.
 * Поле необязательное: старый сервер его не отдаёт (D6-002).
 */
export interface DebtsWindow {
  days: number | null
  truncated: boolean
}

/**
 * «Кто сколько должен» — рабочий список для приёма оплаты.
 * `days = 0` — снять окно и показать все долги (турфирма платит за прошлый
 * месяц, а по умолчанию сервер отдаёт выезды не старше 30 дней).
 */
export async function fetchDebts(
  q?: string,
  days?: number,
): Promise<{ businessDate: string; bookings: DebtRow[]; window?: DebtsWindow }> {
  const params: Record<string, string> = {}
  if (q) params.q = q
  if (days != null) params.days = String(days)
  const { data } = await api.get('/payments/debts', { params })
  return data.data
}

/** Касса текущей смены. Смену определяет сервер — рабочий день не берётся с устройства. */
export async function fetchCurrentShiftSummary(): Promise<ShiftSummary> {
  const { data } = await api.get('/payments/shift/current/summary')
  return data.data
}

// Касса произвольной смены (`GET /payments/shift/:id/summary`) с клиента не
// запрашивается — экран кассы показывает только текущую смену (D9-013).

export interface CreatePaymentPayload {
  bookingId: number
  amount: number
  kind?: PaymentKind
  method?: PaymentMethod
  comment?: string
}

/** Смену и рабочую дату проставляет сервер — с клиента они не приходят. */
export async function createPayment(
  payload: CreatePaymentPayload,
): Promise<{ payment: Payment; summary: BookingMoney }> {
  const { data } = await api.post('/payments', payload)
  return data.data
}

/** Возврат по конкретному платежу. Без суммы — возвращается всё, что по нему принято. */
export async function refundPayment(
  paymentId: number,
  body: { amount?: number; method?: PaymentMethod; comment?: string } = {},
): Promise<{ payment: Payment; summary: BookingMoney }> {
  const { data } = await api.post(`/payments/${paymentId}/refund`, body)
  return data.data
}

/** Отмена ОШИБОЧНОЙ записи (не возврат денег). Причина обязательна. */
export async function voidPayment(
  paymentId: number,
  reason: string,
): Promise<{ payment: Payment; summary: BookingMoney }> {
  const { data } = await api.post(`/payments/${paymentId}/void`, { reason })
  return data.data
}
