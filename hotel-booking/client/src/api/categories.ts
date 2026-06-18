import api from './client'
import type { Category } from '../types'

export interface CategoryWithCount extends Category {
  _count?: { rooms: number }
}

export async function fetchCategories(): Promise<CategoryWithCount[]> {
  const { data } = await api.get('/categories')
  return data.data
}

export async function createCategory(payload: { name: string; color: string; description?: string }): Promise<Category> {
  const { data } = await api.post('/categories', payload)
  return data.data
}

export async function updateCategory(id: number, payload: { name?: string; color?: string; description?: string }): Promise<Category> {
  const { data } = await api.put(`/categories/${id}`, payload)
  return data.data
}

export async function deleteCategory(id: number): Promise<void> {
  await api.delete(`/categories/${id}`)
}
