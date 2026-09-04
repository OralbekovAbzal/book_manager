import api from './client'
import type { GuestBook } from '../types'

/**
 * Адресная книга постояльцев. Своей таблицы у гостей нет — сервер сворачивает
 * существующие брони по нормализованному телефону (guestController.js).
 * Книга приходит целиком: поиск идёт локально и должен срабатывать мгновенно,
 * пока администратор держит трубку.
 */
export async function fetchGuests(): Promise<GuestBook> {
  const { data } = await api.get('/guests')
  return data.data
}
