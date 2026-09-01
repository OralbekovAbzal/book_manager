// Адрес backend-сервера.
//
// • В упакованном Electron preload-скрипт кладёт сюда абсолютный URL хоста
//   (например http://192.168.1.50:3001) — окно загружается из file://, поэтому
//   относительные пути /api там не резолвятся.
// • В dev-браузере (и в Electron-dev, который грузит Vite на :5173) значение
//   пустое → используются относительные пути и прокси Vite.

declare global {
  interface Window {
    appConfig?: {
      serverUrl?: string
      openSettings?: () => void
    }
  }
}

export const SERVER_URL: string =
  (typeof window !== 'undefined' && window.appConfig?.serverUrl) || ''

// Базовый путь REST API. '' + '/api' = '/api' (относительный, dev).
export const API_BASE = `${SERVER_URL}/api`

// Адрес для socket.io. Пустой → текущий origin ('/').
export const SOCKET_URL = SERVER_URL || '/'

export {}
