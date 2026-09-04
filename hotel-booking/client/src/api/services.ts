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

export async function deleteService(id: number): Promise<void> {
  await api.delete(`/services/${id}`)
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
