import api from './client'

export type SnapshotKind = 'auto' | 'shift' | 'manual' | 'safety'

export interface Snapshot {
  id: number
  kind: SnapshotKind
  label: string
  bookingCount: number
  createdAt: string
  createdBy?: { id: number; name: string } | null
  /**
   * Версия формата снимка: 1 — только брони (откат стирает деньги), 2 — брони
   * вместе с начислениями, платежами и услугами.
   * Список отдаёт её отдельным выражением (`data->>'version'`), не читая саму
   * колонку `data` — она самая тяжёлая. Поле необязательное на случай ответа
   * сервера прежней сборки: тогда метка «старый формат» просто не показывается,
   * а не врёт.
   */
  version?: number
}

/** Счётчики по денежной таблице в сводке последствий отката. */
export interface SnapshotMoneyImpact {
  /** Сколько строк в базе сейчас */
  current: number
  /** Сколько вернёт откат */
  restored: number
  /** Сколько исчезнет безвозвратно */
  lost: number
  /** На какую сумму исчезнет */
  lostAmount: number
}

export interface SnapshotServiceImpact {
  current: number
  restored: number
  lost: number
  /** Услуги, удалённые из справочника: вернуть их некуда (только в GET /impact) */
  skipped?: number
}

/**
 * Оценка последствий отката — то, что сервер кладёт в тело отказа 409
 * (`assessRestore`). Без сведений о самом снимке и без готового текста.
 */
export interface RestoreAssessment {
  version: number
  legacyFormat: boolean
  charges: SnapshotMoneyImpact
  payments: SnapshotMoneyImpact
  services: SnapshotServiceImpact
  requiresConfirmation: boolean
}

/** Полная сводка из `GET /api/snapshots/:id/impact` (`describeRestore`). */
export interface SnapshotImpact extends RestoreAssessment {
  snapshot: { id: number; kind: SnapshotKind; label: string; createdAt: string; version: number }
  bookings: { inSnapshot: number; restored: number; skipped: number }
  /** Готовый русский текст «что исчезнет»; null, если подтверждение не требуется */
  warning: string | null
}

export interface RestoreResult {
  restored: number
  skipped: number
  charges: number
  payments: number
  services: number
  skippedServices: number
  version: number
  lostPayments: number
  lostPaymentsAmount: number
}

export async function fetchSnapshots(): Promise<Snapshot[]> {
  const { data } = await api.get('/snapshots')
  return data.data
}

export async function createSnapshot(label?: string): Promise<Snapshot> {
  const { data } = await api.post('/snapshots', { label })
  return data.data
}

/**
 * Что откат вернёт и что потеряет. Запрос ничего не меняет — его зовут ДО отката,
 * чтобы «сколько денег исчезнет» спрашивали заранее, а не узнавали постфактум.
 * Доступен только ADMIN/SUPER_ADMIN.
 */
export async function fetchSnapshotImpact(id: number): Promise<SnapshotImpact> {
  const { data } = await api.get(`/snapshots/${id}/impact`)
  return data.data
}

/**
 * Откат к снимку. `allowMoneyLoss` — осознанное согласие стереть платежи, которых
 * в снимке нет; без него такой откат сервер отклоняет с 409 и базу не трогает.
 */
export async function restoreSnapshot(
  id: number,
  options: { allowMoneyLoss?: boolean } = {},
): Promise<RestoreResult> {
  const { data } = await api.post(`/snapshots/${id}/restore`, {
    allowMoneyLoss: options.allowMoneyLoss === true,
  })
  return data.data
}

export async function deleteSnapshot(id: number): Promise<void> {
  await api.delete(`/snapshots/${id}`)
}

export interface RestoreFailure {
  /** Текст сервера — он объясняет причину отказа лучше любой нашей заглушки */
  message: string
  /** Сводка последствий, если сервер приложил её к отказу (409) */
  impact: RestoreAssessment | null
}

/**
 * Разбирает ошибку axios: сервер объясняет отказ по-русски и прикладывает сводку.
 * Собственный текст показываем только когда сервер не сказал ничего внятного
 * (сеть, 500 без тела) — иначе пользователь снова не поймёт, что произошло.
 */
export function readRestoreFailure(err: unknown, fallback: string): RestoreFailure {
  const data = (err as { response?: { data?: { error?: unknown; impact?: RestoreAssessment } } })
    ?.response?.data
  const serverText = typeof data?.error === 'string' ? data.error.trim() : ''
  return {
    message: serverText || fallback,
    impact: data?.impact ?? null,
  }
}
