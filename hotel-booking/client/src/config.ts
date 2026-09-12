// Адрес backend-сервера.
//
// • В упакованном Electron preload-скрипт кладёт сюда абсолютный URL хоста
//   (например http://192.168.1.50:3001) — окно загружается из file://, поэтому
//   относительные пути /api там не резолвятся.
// • В dev-браузере (и в Electron-dev, который грузит Vite на :5173) значение
//   пустое → используются относительные пути и прокси Vite.

/** Состояние проверки обновлений (событие 'update:status' из main-процесса Electron). */
export type UpdateState =
  | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error' | 'unavailable'

export interface UpdateStatus {
  state: UpdateState
  version?: string
  percent?: number
  error?: string
}

declare global {
  interface Window {
    /**
     * Мост из Electron preload (contextBridge). В обычном браузере отсутствует.
     * openSystemSettings — открыть окно системных настроек (хост/клиент, порт,
     * папки данных); пароль сисадмина проверяет main-процесс Electron.
     * checkForUpdates / downloadUpdate / installUpdate / onUpdateStatus — обновления
     * (electron-updater; адрес сервера обновлений задаёт сисадмин в настройках системы).
     */
    appConfig?: {
      serverUrl: string
      isElectron: true
      /** Версия приложения из package.json Electron (аргумент --app-version). */
      appVersion?: string
      openSystemSettings: (password: string) => Promise<{ ok: boolean; error?: string }>
      /**
       * Отчёты. PDF печатается из этого же окна (те же @media print стили, что
       * и бумага), готовый файл сохраняется диалогом main-процесса: окно
       * упакованного приложения живёт на file://, где обычная загрузка по
       * ссылке молча ничего не делает.
       */
      saveReportPdf?: (options: { fileName?: string; landscape?: boolean }) =>
        Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>
      saveReportFile?: (payload: { fileName: string; base64: string }) =>
        Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>
      /**
       * Выбор файла резервной копии (`.json`) нативным диалогом — для мастера
       * первого запуска и раздела «Резервная копия». Содержимое возвращается
       * строкой: окно упакованной программы живёт на file://, а <input type=file>
       * там открывает диалог без доступа к путям на флешке.
       * `null` — пользователь закрыл диалог.
       */
      pickBackupFile?: () => Promise<{ path: string; name: string; content: string } | null>
      checkForUpdates?: () => Promise<{ ok: boolean; state?: UpdateState; version?: string; error?: string }>
      downloadUpdate?: () => Promise<{ ok: boolean; error?: string }>
      installUpdate?: () => Promise<{ ok: boolean; error?: string }>
      /** Подписка на статусы; возвращает функцию отписки. */
      onUpdateStatus?: (cb: (status: UpdateStatus) => void) => () => void
    }
  }
}

export const SERVER_URL: string =
  (typeof window !== 'undefined' && window.appConfig?.serverUrl) || ''

/** true — приложение запущено внутри Electron (есть preload-мост). */
export const IS_ELECTRON: boolean =
  typeof window !== 'undefined' && window.appConfig?.isElectron === true

/** Версия приложения (только в Electron; в браузере пусто). */
export const APP_VERSION: string =
  (typeof window !== 'undefined' && window.appConfig?.appVersion) || ''

// Базовый путь REST API. '' + '/api' = '/api' (относительный, dev).
export const API_BASE = `${SERVER_URL}/api`

// Адрес для socket.io. Пустой → текущий origin ('/').
export const SOCKET_URL = SERVER_URL || '/'

/**
 * Что из готового не входит в эту версию (решение владельца 2026-09-12):
 * оптимизатор размещения и откат к снимкам до доработки клиентам не показываем.
 * Кнопки и раздел настроек скрыты; сервер закрывает те же роуты 404 независимо
 * от клиента (`server/src/utils/features.js`). Для разработки:
 * `VITE_FEATURE_PREVIEW=1` у клиента и `FEATURE_PREVIEW=1` у сервера.
 */
const PREVIEW = import.meta.env.VITE_FEATURE_PREVIEW === '1'
export const FEATURES = Object.freeze({
  optimizer: PREVIEW,
  snapshotRestore: PREVIEW,
})

export {}
