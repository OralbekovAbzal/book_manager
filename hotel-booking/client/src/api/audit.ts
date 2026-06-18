import api from './client'

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
