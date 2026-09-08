import api from './client'
import type { Booking, BookingStatus, GuestDocType, GuestSex } from '../types'
// Расчёт с гостем возвращает те же деньги и те же платежи, что журнал кассы, —
// свои копии этих типов завели бы вторую правду о деньгах брони.
import type { BookingMoney, Payment, PaymentMethod } from './payments'

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
  // totalAmount / prepaidAmount / paidAmount клиент НЕ отправляет вовсе (волна 5a).
  // Итог брони — сумма строк начислений, её считает сервер тем же кодом, что и
  // предпросмотр; `paidAmount` — кэш журнала платежей. Раньше форма слала свои
  // числа, и они расходились с базой (D5-002, D2-005): в брони оставалось 60 000
  // при 65 000 по строкам. Сервер эти поля теперь игнорирует — здесь их просто нет,
  // чтобы никто не отправил их случайно.
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

// ─── Предпросмотр начислений ─────────────────────────────────────────────────
// Форма больше НЕ считает деньги сама. Раньше `utils/calculator.ts` повторял
// правила сервера (`server/src/utils/charges.js`), и копии разъезжались: на
// экране 106 000 и 99 900, в базе 94 900 (D7-009). Теперь суммы считает тот же
// код, что и сохранение, а клиент их только показывает.

/** Вид строки начисления — тот же словарь, что у `BookingCharge`. */
export type PreviewRowKind = 'stay' | 'meal' | 'extra' | 'discount'

export interface PreviewRow {
  kind: PreviewRowKind
  label: string
  quantity: number
  unitPrice: number
  amount: number
  /** Для посуточных строк — за какую ночь начислено ('YYYY-MM-DD'), иначе null */
  date: string | null
  /** 'manual' — ручная строка брони (штраф, уступка): её предпросмотр тоже учитывает */
  source: 'auto' | 'manual'
}

/** Какие части цены не заполнены в календаре на эту дату. */
export type MissingPricePart = 'adult' | 'child' | 'extraBed' | 'room'

export interface MissingPrice {
  date: string
  parts: MissingPricePart[]
}

export interface PreviewResult {
  rows: PreviewRow[]
  /** Итог со скидкой — ровно то число, что запишется в бронь */
  total: number
  /** Предоплата по проценту формы */
  prepaid: number
  nights: number
  /** Ночи с незаполненной ценой: итог неполный, и об этом надо сказать вслух */
  missingPrices: MissingPrice[]
}

/** Несохранённая ручная строка — сервер учтёт её в предпросмотре наравне с сохранёнными. */
export interface PreviewManualCharge {
  kind: PreviewRowKind
  label: string
  quantity: number
  unitPrice: number
  amount: number
}

export interface PreviewPayload {
  roomId: number
  checkIn: string
  checkOut: string
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
  services?: BookingServicePayload[]
  /** Правка существующей брони: сервер сам подтянет её ручные строки */
  bookingId?: number
  /** Ручные строки, которых ещё нет в базе */
  manualCharges?: PreviewManualCharge[]
}

/**
 * Предпросмотр начислений тем же кодом, что и сохранение.
 * Ничего не пишет — это чистый расчёт, его можно звать на каждое изменение формы
 * (в форме он под debounce, а устаревшие ответы отсекаются по номеру запроса).
 */
export async function previewBooking(payload: PreviewPayload): Promise<PreviewResult> {
  const { data } = await api.post('/bookings/preview', payload)
  return data.data
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

/**
 * Почему номер недоступен. Причины РАЗНЫЕ по смыслу, и форма ведёт себя с ними
 * по-разному: `overlap` и `buffer` — жёсткий запрет (сохранение блокируется),
 * `allotment` — предупреждение, продать можно с подтверждением
 * (`docs/decisions/bookings.md`, 2026-09-08).
 */
export type UnavailableReason = 'overlap' | 'buffer' | 'allotment' | 'range'

export async function checkAvailability(params: {
  roomId: number
  checkIn: string
  checkOut: string
  excludeBookingId?: number
}): Promise<{
  available: boolean
  conflict: Booking | null
  /** null — номер свободен */
  reason: UnavailableReason | null
  /** Текст сервера: какой партнёр, какая метка, чья бронь. Показываем его как есть. */
  message: string | null
}> {
  const { data } = await api.post('/bookings/check-availability', params)
  return data
}

export interface MoveResult {
  original: Booking
  /**
   * Вторая часть переезда — null при переезде «день в день» (без сплита).
   * Это ПРОДОЛЖЕНИЕ счёта, а не отдельная бронь: `accountBookingId` у неё
   * указывает на первую часть, деньги остаются там же (data-and-money.md).
   */
  created: Booking | null
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

// ─── Расчёт с гостем (отмена / ранний выезд / возврат переплаты) ──────────────
// Один диалог вместо трёх разных мест: то же действие над бронью, тот же
// калькулятор, что и при сохранении, плюс штраф и возврат — чтобы не уходить
// из брони в «Кассу» ради возврата переплаты.
//
// Считает и раскладывает возврат по конкретным платежам СЕРВЕР: возврат
// разрешён только по платежу и только в пределах принятого (решение волны 5a,
// `docs/decisions/data-and-money.md`). Клиент лишь показывает цифры и передаёт
// намерение администратора.

/** Что делаем с бронью: отменяем, оформляем выезд или ничего (только деньги). */
export type SettlementAction = 'cancel' | 'checkout' | 'none'

/** Платёж, по которому ещё можно вернуть деньги. `refundable` — остаток по нему. */
export interface SettlementPayment {
  id: number
  paidAt: string
  method: PaymentMethod
  amount: number
  refundable: number
}

export interface SettlementPreview {
  action: SettlementAction
  /** Статус брони, каким он станет после действия */
  status: BookingStatus
  /** Счёт ПОСЛЕ действия: при отмене — только ручные строки, при выезде — за прожитые ночи */
  charged: number
  /** Принято нетто (приём минус уже сделанные возвраты) */
  paid: number
  /** max(0, paid − charged) */
  toReturn: number
  /** max(0, charged − paid) */
  due: number
  nights: { planned: number; stayed: number; removed: number }
  /** Строки счёта после действия — тот же вид, что в предпросмотре формы */
  rows: PreviewRow[]
  payments: SettlementPayment[]
}

export interface SettlementPayload {
  action: SettlementAction
  /** Ручная строка штрафа: сумма и причина (причина попадает в название строки) */
  penalty?: { amount: number; reason: string }
  /** Сколько отдаём гостю. Сервер сам разложит эту сумму по конкретным платежам. */
  refund?: { amount: number; method?: PaymentMethod; comment?: string }
}

export interface SettlementResult {
  booking: Booking
  /** Деньги брони после операции — тем же видом, что отдаёт журнал платежей */
  summary: BookingMoney
  refunds: Payment[]
  /** Созданная строка штрафа (null — штрафа не было). Клиент её не разбирает. */
  penalty: { id: number; label: string; amount: number } | null
}

/** Ничего не пишет: чистый расчёт «что будет, если сделать это действие». */
export async function previewSettlement(
  id: number,
  action: SettlementAction,
): Promise<SettlementPreview> {
  const { data } = await api.post(`/bookings/${id}/settlement/preview`, { action })
  return data.data
}

/** Действие + штраф + возврат ОДНОЙ транзакцией на сервере. */
export async function settleBooking(
  id: number,
  payload: SettlementPayload,
): Promise<SettlementResult> {
  const { data } = await api.post(`/bookings/${id}/settlement`, payload)
  return data.data
}
