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
