import api from './client'

/**
 * Лицензия Roomline PMS — клиентская половина.
 *
 * Ключ офлайновый (`ROOMLINE-…`, подпись Ed25519), сеть для проверки не нужна:
 * ключи прежнего образца `QONAQ-…` сервер принимает наравне с новыми.
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
 *  none    — ключа нет. Идёт пробный период (14 дней с первого запуска, см.
 *            `trial`); пока он не вышел, программа работает полностью, лимита
 *            номеров нет. После — сервер отвечает 402 `TRIAL_EXPIRED` на всё,
 *            кроме входа и лицензии.
 *  ok      — ключ в порядке.
 *  invalid — ключ есть, но не проходит проверку. Считается как «ключа нет»:
 *            пробный период идёт, но состояние показать надо — молча «как будто
 *            ключа нет» — вранье.
 *  expired — обслуживание кончилось РАНЬШЕ даты выпуска этой сборки. Сервер
 *            отвечает 402 `MAINTENANCE_EXPIRED` (гейт обслуживания).
 */
export type LicenseState = 'none' | 'ok' | 'expired' | 'invalid'

/** Пробный период (server/src/utils/trial.js). Приходит только при `none`/`invalid`. */
export interface TrialInfo {
  /** Моменты ISO; null — сервер ещё не проставил начало (срок не идёт). */
  startedAt: string | null
  endsAt: string | null
  /** Последний рабочий день по времени отеля, 'ГГГГ-ММ-ДД'. */
  lastDay: string | null
  /** Целых дней до конца (округление вверх); 0 — вышел. */
  daysLeft: number | null
  expired: boolean
  /** Длина срока в днях (14). */
  days: number
}

export interface LicenseInfo {
  state: LicenseState
  trial: TrialInfo | null
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
  /**
   * Ключ принят, но с оговоркой — человеческий текст от сервера («Ключ выписан
   * на «X», а объект называется «Y»»). Поле необязательное: сервер прежней
   * сборки его не присылает, и это нормально — плашки просто не будет (S13-008).
   */
  warning?: string
  /** Название объекта в ключе не совпало с названием отеля в настройках. */
  hotelMismatch?: boolean
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
