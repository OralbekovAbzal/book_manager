import api from './client'
import type { HotelSettings } from '../types'

/**
 * Реквизиты объекта для печатных документов (счёт, подтверждение брони).
 *
 * Все поля необязательные и приходят с сервера именно как `null`, а не
 * отсутствующим ключом: печать должна отличать «реквизит не заполнен»
 * (строку не выводим) от пустой строки в шапке, а форме не приходится
 * гадать, есть ключ в ответе или нет.
 */
export interface HotelRequisites {
  legalName: string | null
  bin: string | null
  address: string | null
  phone: string | null
  email: string | null
  bankName: string | null
  iban: string | null
  signerName: string | null
  signerTitle: string | null
}

/** Ключ реквизита — им же сервер помечает поле в `details` ошибки 400. */
export type RequisiteField = keyof HotelRequisites

/**
 * Порядок = порядок строк в шапке документа и в форме настроек. Список, а не
 * только тип: по нему форма собирает значения и раскладывает ошибки по полям,
 * чтобы новый реквизит не пришлось вписывать в трёх местах.
 */
export const REQUISITE_FIELDS: readonly RequisiteField[] = [
  'legalName', 'bin', 'address', 'phone', 'email',
  'bankName', 'iban', 'signerName', 'signerTitle',
]

/**
 * Ответ `GET /api/hotel` — настройки объекта и реквизиты одной строкой (id = 1).
 * Расширяем `HotelSettings` из общих типов, а не правим его: тип настроек
 * используют экраны, которым до реквизитов дела нет.
 */
export interface Hotel extends HotelSettings, HotelRequisites {
  /** Момент прохождения мастера первого запуска; `null` — мастер не проходили. */
  setupCompletedAt: string | null
}

export async function fetchHotel(): Promise<Hotel> {
  const { data } = await api.get('/hotel')
  return data.data
}

/**
 * `PUT` здесь ЧАСТИЧНЫЙ: чего нет в payload — сервер не трогает. Поэтому экран
 * тарифов может слать один `pricingBase`, не затирая реквизиты.
 * Пустая строка и `null` — наоборот, стирают значение: опечатку в реквизите
 * надо чем-то исправлять.
 */
export async function updateHotel(payload: Partial<Hotel>): Promise<Hotel> {
  const { data } = await api.put('/hotel', payload)
  return data.data
}
