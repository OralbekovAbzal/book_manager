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

export interface AuditSummary {
  totalAmount: number
  totalPrepaid: number
  totalPaid: number
  totalDebt: number
  bookingCount: number
  byStatus: Array<{ status: string; _count: { id: number }; _sum: { totalAmount: number } }>
}

export async function fetchAuditSummary(params: { period?: string; shiftId?: number }): Promise<AuditSummary> {
  const { data } = await api.get('/audit', { params })
  return data.data
}
