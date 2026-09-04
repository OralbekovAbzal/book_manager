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

// Заменяет ВСЕ данные содержимым файла; перед этим сервер сам делает копию текущего состояния.
export async function restoreBackup(fileName: string): Promise<RestoreResult> {
  const { data } = await api.post('/system/backup/restore', { fileName })
  return data
}
