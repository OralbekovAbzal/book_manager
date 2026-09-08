import { create } from 'zustand'

/**
 * Есть ли связь с сервером — по состоянию socket.io, а не по REST.
 *
 * Зачем отдельный стор: об обрыве узнаёт ровно одно место (`hooks/useSocket`),
 * а показать его надо в шапке приложения (полоса «Нет связи»). Через локальный
 * `useState` это не передать — полоса живёт в `App`, а хук соединения ничего не
 * рисует. Логика «сколько уже нет связи» тоже нужна снаружи: полосу показываем
 * не сразу, иначе она мигала бы на каждом коротком переподключении.
 *
 * Про «сервер лежит» и «токен протух» этот стор ничего не знает намеренно:
 * протухший токен ведёт к оверлею входа (`useAuthStore.reauth`), а не к полосе.
 */

interface ConnectionStore {
  /** true — сокет подключён. Стартуем с `true`: до первого соединения пугать нечем. */
  online: boolean
  /** Когда началось ТЕКУЩЕЕ состояние (ms). Полоса по нему считает свои 5 секунд. */
  since: number | null
  setOnline: () => void
  setOffline: () => void
}

export const useConnectionStore = create<ConnectionStore>((set, get) => ({
  online: true,
  since: null,

  setOnline: () => {
    if (get().online) return
    set({ online: true, since: Date.now() })
  },

  // Идемпотентно: `connect_error` при неудачном переподключении прилетает раз в
  // секунду, и если каждый раз обновлять `since`, отсчёт до полосы не закончится
  // никогда — а связи как не было, так и нет.
  setOffline: () => {
    if (!get().online) return
    set({ online: false, since: Date.now() })
  },
}))
