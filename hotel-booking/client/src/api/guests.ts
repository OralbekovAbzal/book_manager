import api from './client'
import type { GuestBook, GuestLookup } from '../types'

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

/**
 * Документ гостя из его прошлого визита — по телефону, который сейчас набирают
 * в форме брони. Запрос ничего не пишет и не меняет.
 *
 * Зачем: постоянный гость не должен диктовать паспорт заново каждый приезд.
 * Диктовка не только медленная, но и врёт — цифры на слух записывают с
 * ошибками, и у одного человека в базе заводится три разных номера документа.
 *
 * Обрывок номера («701») — не ошибка, а обычное состояние поля, пока его
 * набирают: сервер отвечает `found: false, phoneKey: null` со статусом 200.
 */
export async function lookupGuest(phone: string): Promise<GuestLookup> {
  const { data } = await api.get('/guests/lookup', { params: { phone } })
  return data.data
}
