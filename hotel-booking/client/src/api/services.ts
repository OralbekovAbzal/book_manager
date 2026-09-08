import api from './client'
import type { MealPlan, Service, ServiceKind } from '../types'

export async function fetchServices(kind?: ServiceKind): Promise<Service[]> {
  const { data } = await api.get('/services', { params: kind ? { kind } : {} })
  return data.data
}

export async function createService(payload: Partial<Service>): Promise<Service> {
  const { data } = await api.post('/services', payload)
  return data.data
}

export async function updateService(id: number, payload: Partial<Service>): Promise<Service> {
  const { data } = await api.put(`/services/${id}`, payload)
  return data.data
}

/**
 * Удаление услуги каскадом уносит её строки из ВСЕХ броней вместе с историей
 * (`BookingService … onDelete: Cascade`, D6-005). Поэтому сервер отказывает
 * (409 `SERVICE_IN_USE`), пока услуга где-то используется, а `force` — это
 * осознанное «да, вместе с историей», подтверждённое в диалоге.
 */
export async function deleteService(id: number, opts: { force?: boolean } = {}): Promise<void> {
  await api.delete(`/services/${id}`, { params: opts.force ? { force: 1 } : {} })
}

export async function fetchMealPlans(): Promise<MealPlan[]> {
  const { data } = await api.get('/services/meal-plans')
  return data.data
}

export async function createMealPlan(payload: Partial<MealPlan>): Promise<MealPlan> {
  const { data } = await api.post('/services/meal-plans', payload)
  return data.data
}

export async function updateMealPlan(id: number, payload: Partial<MealPlan>): Promise<MealPlan> {
  const { data } = await api.put(`/services/meal-plans/${id}`, payload)
  return data.data
}

export async function deleteMealPlan(id: number): Promise<void> {
  await api.delete(`/services/meal-plans/${id}`)
}

/** Создать стандартный набор питания и пресеты пансиона. Повторный вызов безопасен. */
export async function createServiceDefaults(): Promise<void> {
  await api.post('/services/defaults')
}
