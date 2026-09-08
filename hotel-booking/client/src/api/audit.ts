import api from './client'
import type { AuditLogEntry } from '../types'

export interface AuditLogParams {
  limit?: number
  adminId?: number
  /** ISO-момент или 'YYYY-MM-DD' (тогда день целиком, UTC) */
  dateFrom?: string
  dateTo?: string
}

// Журнал действий (кто, когда, что изменил). SUPER_ADMIN и ADMIN — иначе 403.
export async function fetchAuditLog(params: AuditLogParams = {}): Promise<AuditLogEntry[]> {
  const { data } = await api.get('/audit/log', { params })
  return data.data
}

/**
 * Сводка окна «Аудит» — СЧЁТЧИКИ БРОНЕЙ, без денег.
 *
 * Денег здесь больше нет по решению владельца (D6-003): «Выручка / Оплачено /
 * Задолженность» на этом экране считались как сумма `Booking.totalAmount` всех
 * броней, СОЗДАННЫХ в период по календарю UTC, и не сходились ни с кассой, ни с
 * финансовыми отчётами — ни по составу, ни по границам периода. Деньги живут в
 * «Кассе» и в отчётах, где у них одна правда; «Аудит» отвечает на вопрос
 * «сколько броней завели и кто что делал».
 */
export interface AuditSummary {
  bookingCount: number
  byStatus: Array<{ status: string; _count: { id: number } }>
  /**
   * Границы периода, посчитанные сервером по времени отеля (не по UTC и не по
   * часам устройства). Поле необязательное — старый сервер его не отдаёт.
   * `from`/`to` бывают `null`: у выборки по смене нижней границы нет вовсе,
   * верхняя — «до сих пор». Экран показывает только заполненные концы.
   */
  period?: { from: string | null; to: string | null; tz: string }
}

export async function fetchAuditSummary(params: { period?: string; shiftId?: number }): Promise<AuditSummary> {
  const { data } = await api.get('/audit', { params })
  return data.data
}
