import api from './client'
import type { Contact } from '../types'

export async function fetchContacts(): Promise<Contact[]> {
  const { data } = await api.get('/contacts')
  return data.data
}

export async function createContact(payload: Partial<Contact>): Promise<Contact> {
  const { data } = await api.post('/contacts', payload)
  return data.data
}

export async function updateContact(id: number, payload: Partial<Contact>): Promise<Contact> {
  const { data } = await api.put(`/contacts/${id}`, payload)
  return data.data
}

export async function deleteContact(id: number): Promise<void> {
  await api.delete(`/contacts/${id}`)
}

/** Сколько записей набор создал, вернул из удалённых и пропустил как уже существующие. */
export interface ContactDefaultsResult {
  created: number
  restored: number
  skipped: number
}

/**
 * Стандартный набор экстренных служб (103/101/102/104) одной кнопкой.
 * Идемпотентно: уже существующее не трогает — тот же приём, что
 * у `POST /api/services/defaults` для питания.
 */
export async function createDefaultContacts(): Promise<ContactDefaultsResult> {
  const { data } = await api.post('/contacts/defaults')
  return data.data
}
