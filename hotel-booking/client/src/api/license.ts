import api from './client'

/**
 * Лицензия Qonaq — клиентская половина.
 *
 * Ключ офлайновый (`QONAQ-…`, подпись Ed25519), сеть для проверки не нужна:
 * сервер разбирает его сам (`server/src/utils/license.js`). Клиенту остаётся
 * показать состояние и один раз принять строку ключа.
 *
 *   GET  /api/license          — любой вошедший
 *   POST /api/license { key }  — только SUPER_ADMIN
 *
 * Оба отдают одну и ту же сводку — поэтому после активации перезапрашивать
 * состояние не нужно, ответ POST уже актуален.
 */

/**
 *  none    — ключа нет. Программа работает полностью (демо), лимита номеров нет.
 *  ok      — ключ в порядке.
 *  invalid — ключ есть, но не проходит проверку. Ничего не ограничивается,
 *            но состояние показать надо: молча «как будто ключа нет» — вранье.
 *  expired — обслуживание кончилось РАНЬШЕ даты выпуска этой сборки. Сервер
 *            отвечает 402 на всё, кроме входа и лицензии (гейт обслуживания).
 */
export type LicenseState = 'none' | 'ok' | 'expired' | 'invalid'

export interface LicenseInfo {
  state: LicenseState
  /** Название объекта из ключа — к нему привязана лицензия, а не к железу. */
  hotel: string | null
  /** Номеров разрешено ключом; null — ограничения нет. */
  rooms: number | null
  /** Активных номеров сейчас. Больше `rooms` — нормально: старые не трогаются. */
  roomsUsed: number
  /** Даты приходят строками 'ГГГГ-ММ-ДД' — календарные дни, не моменты времени. */
  issuedAt: string | null
  maintenanceUntil: string | null
  buildDate: string | null
  /**
   * Кончилось ли обслуживание по СЕГОДНЯШНЕМУ числу. Это не то же самое, что
   * `state`: `maintenanceActive: false` при `state: 'ok'` — мягкое «пора
   * продлевать», программа при этом работает; `expired` — жёсткая блокировка.
   */
  maintenanceActive: boolean | null
  /** Почему ключ не читается («Подпись не сходится» и т.п.), иначе null. */
  message: string | null
}

/** Состояние лицензии. Контроллер отдаёт сводку плоским объектом, без обёртки `data`. */
export async function fetchLicense(): Promise<LicenseInfo> {
  const { data } = await api.get('/license')
  return data
}

/**
 * Ввод ключа. Плохой ключ — 400 с текстом в `error` («Ключ повреждён»,
 * «Подпись не сходится», «Неизвестная версия ключа…»); показываем его как есть.
 */
export async function activateLicense(key: string): Promise<LicenseInfo> {
  const { data } = await api.post('/license', { key })
  return data
}
