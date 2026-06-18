import api from './client'
import type { Allotment, AllotmentRelease } from '../types'

export interface AllotmentFilters {
  partnerId?: number
  roomId?: number
  from?: string
  to?: string
}

export async function fetchAllotments(filters: AllotmentFilters = {}): Promise<Allotment[]> {
  const params: Record<string, string> = {}
  if (filters.partnerId) params.partnerId = String(filters.partnerId)
  if (filters.roomId)    params.roomId    = String(filters.roomId)
  if (filters.from)      params.from      = filters.from
  if (filters.to)        params.to        = filters.to
  const { data } = await api.get('/allotments', { params })
  return data.data
}

export interface CreateAllotmentPayload {
  partnerId: number
  roomId: number
  dateFrom: string
  dateTo: string
  notes?: string
}

export async function createAllotment(payload: CreateAllotmentPayload): Promise<Allotment> {
  const { data } = await api.post('/allotments', payload)
  return data.data
}

export async function updateAllotment(id: number, payload: Partial<CreateAllotmentPayload>): Promise<Allotment> {
  const { data } = await api.put(`/allotments/${id}`, payload)
  return data.data
}

export async function deleteAllotment(id: number): Promise<void> {
  await api.delete(`/allotments/${id}`)
}

export interface CreateReleasePayload {
  dateFrom: string
  dateTo: string
  reason?: string
}

export async function createRelease(allotmentId: number, payload: CreateReleasePayload): Promise<AllotmentRelease> {
  const { data } = await api.post(`/allotments/${allotmentId}/releases`, payload)
  return data.data
}

export async function deleteRelease(id: number): Promise<void> {
  await api.delete(`/allotments/releases/${id}`)
}
