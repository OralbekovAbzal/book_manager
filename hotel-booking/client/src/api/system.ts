import api from './client'
import type { BackupsInfo, BackupResult, RestoreResult } from '../types'

// Резервные копии базы (JSON-дамп всех таблиц). Сервер: routes/system.js.
// Смотреть и создавать — SUPER_ADMIN и ADMIN, восстанавливать — только SUPER_ADMIN.

export async function fetchBackups(): Promise<BackupsInfo> {
  const { data } = await api.get('/system/backups')
  return data.data
}

export async function createBackup(): Promise<BackupResult> {
  const { data } = await api.post('/system/backup')
  return data
}

/** Счётчики по одной таблице в сводке последствий. */
export interface BackupTableImpact {
  /** Сколько строк в базе сейчас */
  current: number
  /** Сколько вернёт восстановление */
  restored: number
  /** Сколько исчезнет безвозвратно */
  lost: number
  /** На какую сумму исчезнет (для неденежных таблиц — 0) */
  lostAmount: number
}

/** Таблица, которой в файле нет вовсе: восстановление очистит её целиком. */
export interface EmptiedTable {
  table: string
  /** Сколько строк в ней сейчас — столько и пропадёт */
  rows: number
}

/**
 * Оценка последствий — ровно то, что сервер кладёт в тело отказа 409
 * (`assessRestore` в server/src/utils/backup.js). Без сведений о самом файле
 * и без готового текста.
 *
 * `payments` / `charges` / `services` могут быть `null`: сервер считает их
 * только по тем моделям, что реально есть в схеме.
 */
export interface RestoreAssessment {
  /** Версия формата файла: 1 — состав таблиц вёлся руками (без кассы и услуг), 2 — из схемы */
  version: number
  legacyFormat: boolean
  payments: BackupTableImpact | null
  charges: BackupTableImpact | null
  services: BackupTableImpact | null
  /** Чего в файле нет вовсе — эти таблицы восстановление очистит */
  emptiedTables: EmptiedTable[]
  /** Есть в файле, но нет в нынешней схеме: файл от более новой версии программы */
  unknownTables: string[]
  requiresConfirmation: boolean
}

/** Полная сводка из `GET /api/system/backups/:fileName/impact` (`describeRestore`). */
export interface BackupImpact extends RestoreAssessment {
  file: string
  /** Когда снята копия; null — файл старого формата без метки */
  createdAt: string | null
  /** Сколько строк вернётся по каждой таблице схемы */
  rows: Record<string, number>
  /** Таблицы файла без обязательных колонок — восстановление откажется с 400 */
  incomplete: { table: string; fields: string[] }[]
  /** Готовый русский текст «что исчезнет»; null, если подтверждение не требуется */
  warning: string | null
}

/**
 * Ответ `POST /api/system/backup/restore`. К строкам по таблицам сервер
 * добавляет то, что снесли осознанно, — это надо показать в итоге, а не
 * промолчать.
 */
export interface BackupRestoreResult extends RestoreResult {
  version: number
  lostPayments: number
  lostPaymentsAmount: number
  emptiedTables: string[]
}

/**
 * Что восстановление вернёт и что сотрёт. Запрос ничего не меняет — его зовут ДО
 * восстановления, чтобы «сколько денег исчезнет» спрашивали заранее, а не
 * узнавали постфактум. Доступен ADMIN и SUPER_ADMIN (само восстановление —
 * только SUPER_ADMIN).
 */
export async function fetchBackupImpact(fileName: string): Promise<BackupImpact> {
  const { data } = await api.get(`/system/backups/${encodeURIComponent(fileName)}/impact`)
  return data.data
}

/**
 * Заменяет ВСЕ данные содержимым файла; перед этим сервер сам делает копию
 * текущего состояния. `allowDataLoss` — осознанное согласие потерять то, чего
 * в файле нет (платежи, целые таблицы); без него такое восстановление сервер
 * отклоняет с 409 и не трогает ни базу, ни папку копий.
 */
export async function restoreBackup(
  fileName: string,
  options: { allowDataLoss?: boolean } = {},
): Promise<BackupRestoreResult> {
  const { data } = await api.post('/system/backup/restore', {
    fileName,
    allowDataLoss: options.allowDataLoss === true,
  })
  return data
}

export interface RestoreFailure {
  /** Текст сервера — он объясняет причину отказа лучше любой нашей заглушки */
  message: string
  /** Сводка последствий, если сервер приложил её к отказу (409) */
  impact: RestoreAssessment | null
}

/**
 * Разбирает ошибку axios: сервер объясняет отказ по-русски и прикладывает сводку.
 * Собственный текст показываем только когда сервер не сказал ничего внятного —
 * иначе пользователь снова не поймёт, что произошло.
 *
 * Отдельно отсекаем HTML: Express на несуществующем маршруте отвечает страницей
 * «Cannot GET …», и она попадала бы в интерфейс целиком. Так выглядит сервер
 * старой сборки, где ещё нет `/impact`.
 */
export function readRestoreFailure(err: unknown, fallback: string): RestoreFailure {
  const response = (err as { response?: { data?: unknown } } | undefined)?.response
  // Ответа нет вовсе — сеть или сервер не запущен; про это надо сказать прямо
  if (!response) return { message: 'Сервер недоступен', impact: null }

  const body = response.data
  const raw =
    typeof body === 'string' ? body
    : body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : ''
  const text = raw.trim()
  const serverText = text && !/<\/?[a-z!]/i.test(text) ? text : ''
  const impact =
    body && typeof body === 'object'
      ? (body as { impact?: RestoreAssessment }).impact ?? null
      : null

  return { message: serverText || fallback, impact }
}
