import { create } from 'zustand'
import api, { onUnauthorized } from '../api/client'
import type { Admin } from '../types'

/**
 * Почему сессия закончилась. Первые четыре — payload события `auth:revoked`
 * (socketManager.js); `restored` приходит не от сервера, а из мастера первого
 * запуска: после восстановления копии учётные записи в базе — те, что с прошлого
 * компьютера, и только что созданной среди них нет.
 *
 * `token_expired` — сервер сам рвёт сокет по истечении JWT: раньше сокет жил
 * дольше токена и продолжал слать обновления давно «просроченному» рабочему месту.
 */
export type SessionEndReason =
  | 'account_disabled'
  | 'session_revoked'
  | 'password_changed'
  | 'token_expired'
  | 'restored'

const SESSION_END_NOTICE: Record<SessionEndReason, string> = {
  account_disabled: 'Учётная запись отключена администратором',
  session_revoked: 'Сессия завершена: выполнен выход на другом устройстве',
  password_changed: 'Пароль изменён — войдите заново с новым паролем',
  token_expired: 'Сессия истекла — войдите заново',
  restored: 'Данные восстановлены из копии — войдите учётной записью с прошлого компьютера',
}

/**
 * Текст по причине. Аргумент — ЛЮБАЯ строка намеренно: причину присылает сервер,
 * и он может оказаться новее клиента. Индексация `Record<SessionEndReason, …>`
 * незнакомым значением дала бы `undefined` и пустой баннер на экране входа —
 * рабочее место осталось бы без объяснения, почему его выкинуло.
 */
function sessionEndNotice(reason: string): string {
  return (SESSION_END_NOTICE as Record<string, string>)[reason] ?? SESSION_END_NOTICE.session_revoked
}

/**
 * Повторный вход ПОВЕРХ работающего приложения.
 *
 * Раньше 401 посреди формы стирал токен и перезагружал страницу — вместе с
 * заполненной бронью (аудит D7-002). Теперь приложение не размонтируется: над
 * ним поднимается оверлей с полем пароля, а логин известен — он у `admin`,
 * которого мы намеренно не обнуляем.
 */
export interface ReauthState {
  username: string
  /** Почему потребовался вход — для текста в оверлее. */
  reason: string
}

interface AuthStore {
  admin: Admin | null
  token: string | null
  /** Название отеля для шапки: из /api/setup/status до входа, из /api/hotel после. */
  hotelName: string | null
  /** Пояснение на экране входа, почему сессия закончилась (после auth:revoked). */
  notice: string | null
  /** Не null — над приложением висит оверлей повторного входа. */
  reauth: ReauthState | null
  /**
   * Сессия перестала действовать, но приложение с открытыми формами оставляем.
   * Токен из localStorage НЕ стираем: случайный F5 до ввода пароля не должен
   * рвать сессию раньше, чем это сделает сервер.
   */
  requireReauth: (reason: string) => void
  /** Вход из оверлея тем же логином. Ошибку бросает наружу — её показывает форма. */
  reauthLogin: (password: string) => Promise<void>
  login: (username: string, password: string) => Promise<void>
  /**
   * Без причины — выход по кнопке: сервер отзывает ВСЕ сессии учётной записи
   * (authController.logout). С причиной — сессию уже отозвал сервер,
   * остаётся только стереть токен и объяснить почему.
   */
  logout: (reason?: SessionEndReason) => void
  restore: () => Promise<void>
  /** Установить сессию, полученную не через /auth/login (авто-вход после мастера настройки). */
  setSession: (token: string, admin: Admin) => void
  setHotelName: (name: string | null) => void
}

export const useAuthStore = create<AuthStore>((set, get) => ({
  admin: null,
  token: localStorage.getItem('token'),
  hotelName: null,
  notice: null,
  reauth: null,

  requireReauth: (reason) => {
    const { admin, reauth } = get()
    // До входа оверлей не нужен: `restore()` на 401 сам чистит токен и показывает
    // обычный экран входа — иначе старт с просроченным токеном упирался бы в
    // оверлей поверх пустого приложения, из которого нечего спасать.
    if (!admin) return
    // Пока оверлей уже висит, второй и третий 401 (в форме летит несколько
    // запросов подряд) ничего не меняют — иначе поле пароля пересоздавалось бы
    // под руками и теряло ввод.
    if (reauth) return
    set({ reauth: { username: admin.username, reason } })
  },

  reauthLogin: async (password) => {
    const { reauth } = get()
    if (!reauth) return
    const { data } = await api.post('/auth/login', { username: reauth.username, password })
    // Токен в localStorage — его читает интерцептор запросов; в сторе он же
    // перезапускает сокет (`useSocket` завязан на token).
    localStorage.setItem('token', data.token)
    set({ admin: data.admin, token: data.token, notice: null, reauth: null })
  },

  login: async (username, password) => {
    const { data } = await api.post('/auth/login', { username, password })
    localStorage.setItem('token', data.token)
    set({ admin: data.admin, token: data.token, notice: null, reauth: null })
  },

  logout: (reason) => {
    const token = localStorage.getItem('token')
    localStorage.removeItem('token')
    set({
      admin: null,
      token: null,
      notice: reason ? sessionEndNotice(reason) : null,
      // Сброс обязателен: оверлей рисуется только внутри вошедшего приложения,
      // но незакрытый `reauth` всплыл бы поверх шахматки сразу после
      // следующего входа.
      reauth: null,
    })
    if (reason || !token) return
    // Токен из localStorage уже стёрт (интерцептор его не подставит) — передаём
    // явно. Ответ не важен: 401 значит, что сессию уже отозвали с другой стороны.
    api.post('/auth/logout', null, { headers: { Authorization: `Bearer ${token}` } }).catch(() => {})
  },

  restore: async () => {
    const token = localStorage.getItem('token')
    if (!token) return
    try {
      const { data } = await api.get('/auth/me')
      set({ admin: data.admin, token })
    } catch (e) {
      // Токен стираем только если сервер его отверг (401/403). Сеть или 5xx — сервер
      // временно недоступен: токен оставляем, admin не трогаем (покажется экран входа
      // с баннером), после восстановления сервера сессия ещё жива.
      const status = (e as { response?: { status?: number } } | undefined)?.response?.status
      if (status === 401 || status === 403) {
        localStorage.removeItem('token')
        set({ admin: null, token: null })
      }
    }
  },

  // Токен кладём в localStorage так же, как login — его читает axios-интерцептор.
  setSession: (token, admin) => {
    localStorage.setItem('token', token)
    set({ admin, token, notice: null, reauth: null })
  },

  setHotelName: (name) => set({ hotelName: name }),
}))

/**
 * 401 из любого запроса поднимает оверлей повторного входа.
 *
 * Регистрацией, а не импортом стора внутрь `api/client.ts`: прямой импорт
 * замкнул бы цикл client → useAuthStore → client, а на горячей перезагрузке
 * это ровно тот случай, когда модуль ловит «is not defined» из временной
 * мёртвой зоны (тем же приёмом там разведён обработчик 402). Зависимость
 * остаётся односторонней, а сам стор берём через `getState()` — на момент
 * вызова он уже создан.
 */
onUnauthorized(() => {
  useAuthStore.getState().requireReauth('token_expired')
})
