import api from './client'
import type { Allotment } from '../types'

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

// Релизы (частичное освобождение квоты) из поставки убраны решением владельца
// (docs/decisions/bookings.md, 2026-09-08): интерфейса у них не было, роутов на
// сервере больше нет. Модель `Release` осталась на вырост, и существующие записи
// проверка квоты по-прежнему учитывает — поэтому поле `releases` в `Allotment`
// сохранено, а функции `createRelease`/`deleteRelease` удалены: они звали
// несуществующие эндпоинты.
