import api from './client'
import type { Partner } from '../types'

export async function fetchPartners(): Promise<Partner[]> {
  const { data } = await api.get('/partners')
  return data.data
}

export async function createPartner(payload: Partial<Partner>): Promise<Partner> {
  const { data } = await api.post('/partners', payload)
  return data.data
}

export async function updatePartner(id: number, payload: Partial<Partner>): Promise<Partner> {
  const { data } = await api.put(`/partners/${id}`, payload)
  return data.data
}

export async function deletePartner(id: number): Promise<void> {
  await api.delete(`/partners/${id}`)
}
