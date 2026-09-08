import api from './client'
import type { GridData, TodayEvents, GridFilters } from '../types'
import type { UnavailableReason } from './bookings'

export async function fetchGrid(
  dateFrom: string,
  dateTo: string,
  filters: GridFilters,
  guestSearch?: string,
): Promise<GridData> {
  const params: Record<string, string> = { dateFrom, dateTo }
  if (filters.building)   params.building   = filters.building
  if (filters.categoryId) params.categoryId = filters.categoryId
  if (filters.floor)      params.floor      = filters.floor
  if (filters.capacity)   params.capacity   = filters.capacity
  if (filters.features)   params.features   = filters.features
  if (guestSearch)        params.guestSearch = guestSearch
  const { data } = await api.get('/occupancy/grid', { params })
  return data
}

export async function fetchToday(): Promise<TodayEvents> {
  const { data } = await api.get('/occupancy/today')
  return data
}

/** Почему номер недоступен: причина + готовый текст сервера. */
export interface RoomBlockReason {
  reason: UnavailableReason
  text: string
}

export interface RoomAvailability {
  availability: Record<number, 'free' | 'occupied'>
  /** Только по занятым номерам. Квота и буфер объясняются по-разному — и в форме тоже. */
  reasons: Record<number, RoomBlockReason>
}

/**
 * Свободные номера на даты + ПРИЧИНА занятости по каждому занятому.
 *
 * Причину сервер отдавал и раньше, но клиент её выбрасывал — из-за этого квота
 * партнёра выглядела как «номер занят», и продать номер из формы новой брони
 * было нельзя вовсе (аудит D5-001, D7-005).
 */
export async function fetchRoomAvailability(
  checkIn: string,
  checkOut: string,
  excludeBookingId?: number,
): Promise<RoomAvailability> {
  if (!checkIn || !checkOut || checkOut <= checkIn) return { availability: {}, reasons: {} }
  const params: Record<string, string> = { checkIn, checkOut }
  if (excludeBookingId) params.excludeBookingId = String(excludeBookingId)
  const { data } = await api.get('/occupancy/availability', { params })
  return { availability: data.availability ?? {}, reasons: data.reasons ?? {} }
}

// ─── Optimization ─────────────────────────────────────────────────────────────

export interface OptimizeMove {
  bookingId: number
  guestName: string
  checkIn: string
  checkOut: string
  from: { roomId: number; roomNumber: string; building: string; floor: number }
  to:   { roomId: number; roomNumber: string; building: string; floor: number }
  categoryName: string
  /** Сколько окон закрывает именно этот ход (маржинально, при остальных применённых). null — если в связке. */
  gapsClosed?: number | null
  /** Сколько коротких (≤2 н.) окон убирает этот ход. */
  shortGapsClosed?: number | null
  /** Сколько пустых ночей закрывает этот ход. */
  nightsClosed?: number | null
  /** Ход — часть парного обмена/цепочки, по отдельности эффект не выделить. */
  partOfChain?: boolean
}

export interface OptimizeResult {
  before:  { totalGaps: number; shortGaps: number; lostNights: number }
  after:   { totalGaps: number; shortGaps: number; lostNights: number }
  improvement: { gapsReduced: number; shortGapsReduced: number; nightsReclaimed: number }
  moves: OptimizeMove[]
  totalMoves: number
}

export async function runOptimization(settings?: unknown, flagEffects?: unknown): Promise<OptimizeResult> {
  const { data } = await api.post('/occupancy/optimize', { settings, flagEffects })
  return data
}

export async function applyOptimization(
  moves: { bookingId: number; toRoomId: number }[],
): Promise<{ applied: number }> {
  const { data } = await api.post('/occupancy/optimize/apply', { moves })
  return data
}
