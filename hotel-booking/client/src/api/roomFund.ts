import api from './client'

/**
 * Справочники номерного фонда: корпуса, особенности, вместимости.
 *
 * Раньше все три жили в localStorage и на двух рабочих местах молча разъезжались
 * (у четырёх номеров вместимость так и осталась голым числом `1781675520618` —
 * её название знал только один ноутбук). Теперь источник истины — сервер.
 *
 * Как справочник связан с номерами — от этого зависят формы:
 *   Room.building = НАЗВАНИЕ корпуса      (не id и не code)
 *   Room.features = массив НАЗВАНИЙ
 *   Room.capacity = КОД вместимости       (именно code, не id и не label)
 * Поэтому выпадающие списки подставляют `name` / `name[]` / `code`, а не `id`.
 *
 * Роли: читают все вошедшие, пишут ADMIN и SUPER_ADMIN (STAFF получит 403).
 */

// ─── Формы записей ────────────────────────────────────────────────────────────
// `usedByRooms` приходит только в GET — сколько номеров реально держат запись.
// По нему интерфейс решает, предлагать «удалить насовсем» или только «скрыть».

export interface BuildingRow {
  id: number
  code: string
  name: string
  description: string | null
  order: number
  isActive: boolean
  usedByRooms?: number
}

export interface FeatureRow {
  id: number
  code: string
  name: string
  emoji: string | null
  order: number
  isActive: boolean
  usedByRooms?: number
}

export interface CapacityRow {
  id: number
  code: string
  label: string
  value: number
  order: number
  isActive: boolean
  usedByRooms?: number
}

export interface RoomFundData {
  buildings: BuildingRow[]
  features: FeatureRow[]
  capacities: CapacityRow[]
}

/** Ответ DELETE: по умолчанию запись не удаляется, а скрывается. */
export interface RemoveResult {
  deleted: boolean
  hidden?: boolean
  purged?: boolean
  usedByRooms: number
}

// ─── Чтение ───────────────────────────────────────────────────────────────────

/**
 * Все три справочника одним запросом — интерфейсу они нужны всегда вместе.
 * `includeHidden` тянет и скрытые: без них раздел настроек не покажет, что
 * скрывал пользователь, а форма номера не расшифрует вместимость номера,
 * чью запись уже скрыли.
 */
export async function fetchRoomFund(includeHidden = false): Promise<RoomFundData> {
  const { data } = await api.get('/room-fund', {
    params: includeHidden ? { includeHidden: 'true' } : undefined,
  })
  return data.data
}

// ─── Корпуса ──────────────────────────────────────────────────────────────────

/** Переименование корпуса/особенности переписывает и сами номера — сервер
 *  возвращает, сколько задето, чтобы интерфейс мог об этом сказать. */
export interface RenameResult<T> {
  item: T
  renamedRooms: number
}

export async function createBuilding(payload: {
  name: string; description?: string; order?: number
}): Promise<BuildingRow> {
  const { data } = await api.post('/room-fund/buildings', payload)
  return data.data
}

export async function updateBuilding(id: number, payload: {
  name?: string; description?: string; order?: number; isActive?: boolean
}): Promise<RenameResult<BuildingRow>> {
  const { data } = await api.put(`/room-fund/buildings/${id}`, payload)
  return { item: data.data, renamedRooms: data.renamedRooms ?? 0 }
}

export async function removeBuilding(id: number, purge = false): Promise<RemoveResult> {
  const { data } = await api.delete(`/room-fund/buildings/${id}`, {
    params: purge ? { purge: 'true' } : undefined,
  })
  return data.data
}

// ─── Особенности ──────────────────────────────────────────────────────────────

export async function createFeature(payload: {
  name: string; emoji?: string; order?: number
}): Promise<FeatureRow> {
  const { data } = await api.post('/room-fund/features', payload)
  return data.data
}

export async function updateFeature(id: number, payload: {
  name?: string; emoji?: string; order?: number; isActive?: boolean
}): Promise<RenameResult<FeatureRow>> {
  const { data } = await api.put(`/room-fund/features/${id}`, payload)
  return { item: data.data, renamedRooms: data.renamedRooms ?? 0 }
}

export async function removeFeature(id: number, purge = false): Promise<RemoveResult> {
  const { data } = await api.delete(`/room-fund/features/${id}`, {
    params: purge ? { purge: 'true' } : undefined,
  })
  return data.data
}

// ─── Вместимости ──────────────────────────────────────────────────────────────

export async function createCapacity(payload: {
  label: string; value: number; order?: number
}): Promise<CapacityRow> {
  const { data } = await api.post('/room-fund/capacities', payload)
  return data.data
}

/** У вместимости `renamedRooms` не бывает: номера ссылаются на код, а не на подпись. */
export async function updateCapacity(id: number, payload: {
  label?: string; value?: number; order?: number; isActive?: boolean
}): Promise<CapacityRow> {
  const { data } = await api.put(`/room-fund/capacities/${id}`, payload)
  return data.data
}

export async function removeCapacity(id: number, purge = false): Promise<RemoveResult> {
  const { data } = await api.delete(`/room-fund/capacities/${id}`, {
    params: purge ? { purge: 'true' } : undefined,
  })
  return data.data
}

// ─── Разовый перенос того, что осталось в localStorage ────────────────────────

/**
 * Форма ровно та, в какой справочник лежал в localStorage (`roomFund`):
 * `id` там — это будущий `code`, поэтому вместимость с id `1781675520618`
 * находит свою запись в базе и приносит ей название.
 */
export interface RoomFundImportPayload {
  buildings?: { id?: string; name?: string; description?: string }[]
  features?: { id?: string; name?: string; emoji?: string }[]
  capacities?: { id?: string; label?: string; value?: number }[]
}

export interface ImportStat { created: number; updated: number; skipped: number }

export interface RoomFundImportResult {
  buildings: ImportStat
  features: ImportStat
  capacities: ImportStat
}

/**
 * Импорт идемпотентный и ТОЛЬКО ДОБАВЛЯЮЩИЙ: ничего не удаляет и не
 * перезаписывает непустые значения. Поэтому его безопасно звать с каждой
 * машины и после каждой переустановки. Пишет в общий справочник → ADMIN.
 */
export async function importRoomFund(payload: RoomFundImportPayload): Promise<RoomFundImportResult> {
  const { data } = await api.post('/room-fund/import', payload)
  return data.data
}
