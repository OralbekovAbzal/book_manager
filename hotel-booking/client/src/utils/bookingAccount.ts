import type { Booking, BookingContinuation, GridBooking } from '../types'

/**
 * Цепочка брони — один счёт на гостя.
 *
 * Переезд со сплитом оставляет в шахматке две полоски, но деньги у гостя общие:
 * начисления и платежи лежат на ПЕРВОЙ брони цепочки («голове»), а каждая
 * следующая часть («продолжение») ссылается на неё через `accountBookingId`.
 * Решение — `docs/decisions/data-and-money.md` (2026-09-08).
 *
 * Сервер умеет сводить к счёту сам: деньги можно спрашивать по id любого
 * отрезка. Но панели, печать и расчёт мы ведём явно по голове — тогда на экране
 * видно, ЧЕЙ это счёт, и не приходится гадать, что показывает конкретный запрос.
 *
 * Функции нарочно принимают и `Booking`, и `GridBooking`: одна и та же полоска
 * приезжает то из сетки, то из `GET /bookings/:id`.
 */

/** id счёта: у обычной брони и у головы — она сама, у продолжения — голова. */
export function accountIdOf(booking: Pick<GridBooking, 'id' | 'accountBookingId'>): number {
  return booking.accountBookingId ?? booking.id
}

/** Эта бронь — продолжение чужого счёта (деньги не её). */
export function isContinuation(booking: Pick<GridBooking, 'accountBookingId'>): boolean {
  return booking.accountBookingId != null
}

/** У головы есть продолжения: гость переезжал, счёт общий. */
export function hasContinuations(booking: Pick<Booking, 'continuations'>): boolean {
  return (booking.continuations?.length ?? 0) > 0
}

/**
 * Текущий (последний) отрезок цепочки. Голова после переезда закрыта и не
 * редактируется — править нужно именно его. Порядок продолжений задаёт сервер
 * (по id), но на всякий случай берём максимальный `checkOut`: цепочка из трёх
 * отрезков не должна зависеть от того, как её отсортировали.
 */
export function lastSegment(booking: Booking): BookingContinuation | null {
  const list = booking.continuations ?? []
  if (list.length === 0) return null
  return list.reduce((best, c) => (c.checkOut > best.checkOut ? c : best), list[0])
}

/** «12 → 15» для головы с продолжениями; для обычной брони — просто её номер. */
export function chainRoomsLabel(booking: Booking): string {
  const own = booking.room?.number ?? ''
  const rest = (booking.continuations ?? []).map(c => c.room?.number ?? '?')
  return [own, ...rest].filter(Boolean).join(' → ')
}

/**
 * Дата выезда всей цепочки: у головы с продолжениями это выезд последнего
 * отрезка, а не её собственный (тот совпадает с датой переезда).
 */
export function chainCheckOut(booking: Booking): string {
  const last = lastSegment(booking)
  return last ? last.checkOut : booking.checkOut
}
