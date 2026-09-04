import api from './client'
import type { RatePrice, PriceField } from '../types'

export async function fetchRates(
  dateFrom: string,
  dateTo: string,
  categoryId?: number,
): Promise<RatePrice[]> {
  const params: Record<string, string> = { dateFrom, dateTo }
  if (categoryId) params.categoryId = String(categoryId)
  const { data } = await api.get('/rates', { params })
  return data.data
}

export interface ApplyRatesPayload {
  categoryIds: number[]
  dateFrom: string
  dateTo: string
  /** 0=вс … 6=сб. Пусто — все дни. */
  weekdays?: number[]
  prices: Partial<Record<PriceField, number | string>>
}

export async function applyRates(payload: ApplyRatesPayload): Promise<{ updated: number; days: number }> {
  const { data } = await api.put('/rates', payload)
  return data.data
}

export async function clearRates(
  categoryIds: number[], dateFrom: string, dateTo: string,
): Promise<{ deleted: number }> {
  const { data } = await api.delete('/rates', { data: { categoryIds, dateFrom, dateTo } })
  return data.data
}

/** Ячейка календаря: конкретная категория на конкретную дату. */
export interface RateCell { categoryId: number; date: string }

/** Цена для произвольного выделения — форма выделения не укладывается в диапазон. */
export async function applyRateCells(
  cells: RateCell[],
  prices: Partial<Record<PriceField, number | string>>,
): Promise<{ updated: number }> {
  const { data } = await api.post('/rates/cells', { cells, prices })
  return data.data
}

export async function clearRateCells(cells: RateCell[]): Promise<{ deleted: number }> {
  const { data } = await api.delete('/rates/cells', { data: { cells } })
  return data.data
}
