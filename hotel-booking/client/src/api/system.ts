import api from './client'
import type { BackupsInfo, BackupResult, RestoreResult } from '../types'

// Резервные копии базы (JSON-дамп всех таблиц). Сервер: routes/system.js.
// Смотреть и создавать — SUPER_ADMIN и ADMIN, восстанавливать — только SUPER_ADMIN.

// ── Константы и типы объявлены ДО функций: объявленная ниже константа падает при
// горячей перезагрузке с «is not defined» (временная мёртвая зона). Ловили дважды.

/**
 * Чем плоха ситуация с копиями. Считает сервер, а не клиент: правило «старше двух
 * суток» должно быть одно на баннер, раздел и будущие подсказки.
 * `never` — копий не было вовсе; `stale` — последняя удачная слишком старая;
 * `fallback` — копия легла в запасную папку на этом же компьютере (флешки нет).
 */
export type BackupWarning = 'none' | 'stale' | 'fallback' | 'never'

/** Блок `status` из `GET /api/system/backups` (ADMIN+): с путями, для раздела настроек. */
export interface BackupStatus {
  lastOkAt: string | null
  lastOkPath: string | null
  /** Текст последней ошибки; у fallback-копии он объясняет, почему писали не туда */
  lastError: string | null
  /** Куда копии должны писаться (BACKUP_PATH — флешка) */
  targetPath: string
  targetAvailable: boolean
  /** true — последняя копия ушла не в `targetPath`, а в запасную папку */
  fallbackUsed: boolean
  fallbackPath: string | null
}

/** Блок `backup` из `GET /api/system/status` (любой вошедший, без путей) — для баннера. */
export interface BackupHealth {
  lastOkAt: string | null
  ageHours: number | null
  warning: BackupWarning
}

export interface SystemStatus {
  server: string
  db: string
  timestamp: string
  backup: BackupHealth
}

/** Список копий вместе со статусом папки; `status` = null на сервере старой сборки. */
export interface BackupsInfoFull extends BackupsInfo {
  status: BackupStatus | null
}

export async function fetchBackups(): Promise<BackupsInfoFull> {
  const { data } = await api.get('/system/backups')
  const body = data.data as BackupsInfoFull
  // Старый сервер статуса не отдаёт. Молчаливое `undefined` в интерфейсе выглядит
  // как «всё хорошо», поэтому явный null — раздел покажет прежний вид без статуса.
  return { ...body, status: body.status ?? null }
}

/**
 * Состояние сервера + здоровье копий. Роут под `authenticate`, но без роли:
 * баннер о копиях должен видеть любой вошедший, а пути к папкам — не должен.
 */
export async function fetchSystemStatus(): Promise<SystemStatus> {
  const { data } = await api.get('/system/status')
  return {
    server: data.server,
    db: data.db,
    timestamp: data.timestamp,
    // Сервер старой сборки блока не пришлёт — тогда предупреждать не о чем
    backup: data.backup ?? { lastOkAt: null, ageHours: null, warning: 'none' as const },
  }
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

// ─── Копия с другого компьютера ────────────────────────────────────────────────
// Перенос на новый ноутбук: файл `backup_*.json` с флешки заливается на сервер,
// тот кладёт его в свою папку копий и отвечает сводкой последствий. Дальше —
// обычное восстановление по имени файла (`restoreBackup`).

/** Что вернул `POST /api/system/backup/upload`. */
export interface BackupUploadResult {
  /** Имя, под которым сервер сохранил файл в своей папке копий */
  fileName: string
  impact: RestoreAssessment
}

/** Выбранный файл копии: `path` есть только в Electron (нативный диалог). */
export interface PickedBackupFile {
  name: string
  content: string
  path?: string
}

/**
 * Заголовок `X-File-Name` едет в HTTP как ISO-8859-1: кириллица в имени файла
 * роняет сам запрос (браузер отказывается ставить такой заголовок). Имя нужно
 * серверу только для узнаваемого имени копии, поэтому небезопасные символы
 * выкидываем, а совсем пустой результат просто не отправляем — сервер придумает
 * имя сам.
 */
function asciiFileName(name: string): string {
  // Оставляем только печатные ASCII без кавычек и слешей — заголовку хватит
  return name.replace(/[^A-Za-z0-9 ._()+-]/g, '').trim().slice(0, 120)
}

/**
 * Заливает содержимое файла копии как есть (`Content-Type: application/json`).
 * Строку axios не пересериализует — тело уходит байт в байт, и сервер разбирает
 * тот же JSON, что лежал на флешке. Мусор → 400 с текстом сервера.
 */
export async function uploadBackup(content: string, fileName: string): Promise<BackupUploadResult> {
  const safeName = asciiFileName(fileName)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (safeName) headers['X-File-Name'] = safeName
  const { data } = await api.post('/system/backup/upload', content, { headers })
  return data.data
}

/**
 * Выбор файла копии. В Electron — нативный диалог главного процесса: окно живёт
 * на file://, и путь к флешке через обычный `<input type=file>` оттуда не виден.
 * В браузере (dev, режим клиента) — тот же `<input>` + FileReader.
 *
 * `null` — пользователь закрыл диалог. Отмену в вебе ловим двумя способами:
 * событием `cancel` (Chromium 113+, наш Electron новее) и возвратом фокуса окну —
 * без второго обещание могло бы не разрешиться никогда и кнопка навсегда
 * осталась бы в состоянии «Загрузка…».
 */
export function pickBackupFile(): Promise<PickedBackupFile | null> {
  const bridge = typeof window !== 'undefined' ? window.appConfig?.pickBackupFile : undefined
  if (bridge) return bridge()

  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/json,.json'
    input.style.display = 'none'
    document.body.appendChild(input)

    let settled = false
    const finish = (value: PickedBackupFile | null) => {
      if (settled) return
      settled = true
      window.removeEventListener('focus', onFocus)
      input.remove()
      resolve(value)
    }
    const onFocus = () => {
      // Диалог закрылся: фокус вернулся окну. Событие `change` приходит после
      // фокуса, поэтому даём ему фору, прежде чем считать выбор отменённым.
      window.setTimeout(() => { if (!input.files?.length) finish(null) }, 500)
    }

    input.addEventListener('cancel', () => finish(null))
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) return finish(null)
      const reader = new FileReader()
      reader.onload = () => finish({ name: file.name, content: String(reader.result ?? '') })
      reader.onerror = () => finish(null)
      reader.readAsText(file)
    })

    window.addEventListener('focus', onFocus)
    input.click()
  })
}
