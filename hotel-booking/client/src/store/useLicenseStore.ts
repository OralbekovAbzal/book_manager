import { create } from 'zustand'
import { onMaintenanceBlocked, type MaintenanceBlock } from '../api/client'
import { fetchLicense, activateLicense, type LicenseInfo } from '../api/license'
import { formatApiError } from '../components/Setup/accountRules'

/**
 * Состояние лицензии — общее на всё приложение: полосу в шапке, раздел
 * «Настройки → Лицензия» и экран блокировки 402 читают отсюда, а не каждый свой
 * `useState` (иначе после ввода ключа полоса в шапке осталась бы висеть).
 *
 * Здесь же живёт блокировка гейта: интерцептор 402 не знает про React и просто
 * зовёт зарегистрированный обработчик (см. api/client.ts) — тот кладёт сведения
 * сюда, и App поднимает экран.
 */

interface LicenseStore {
  info: LicenseInfo | null
  loading: boolean
  /** Ошибка ЗАГРУЗКИ состояния (не ошибка ключа — её показывает форма ввода). */
  error: string
  /** Не null — сервер закрыт гейтом обслуживания, приложения под ним нет. */
  block: MaintenanceBlock | null
  /**
   * Момент последнего снятия блокировки. App держит его в зависимостях эффектов
   * загрузки данных: под гейтом все запросы получили 402, и после ввода ключа
   * их надо повторить — иначе шапка и шахматка останутся пустыми до перезагрузки,
   * а обещано «без перезагрузки».
   */
  unblockedAt: number
  load: () => Promise<void>
  /** Ввод ключа. Ошибку НЕ глотает — её показывает форма. */
  activate: (key: string) => Promise<LicenseInfo>
}

export const useLicenseStore = create<LicenseStore>((set, get) => ({
  info: null,
  loading: false,
  error: '',
  block: null,
  unblockedAt: 0,

  load: async () => {
    if (get().loading) return
    set({ loading: true })
    try {
      const info = await fetchLicense()
      set({ info, error: '' })
    } catch (e) {
      // 402 сюда тоже приходит (GET /api/license гейт пропускает, но до входа
      // запрос не уйдёт вовсе) — текст ошибки честнее пустого экрана.
      set({ error: formatApiError(e, 'Не удалось получить состояние лицензии') })
    } finally {
      set({ loading: false })
    }
  },

  activate: async (key) => {
    const info = await activateLicense(key)
    set((s) => ({
      info,
      // Блокировку снимаем, только если новый ключ её действительно снимает:
      // ввести можно и прежний ключ — тогда сервер по-прежнему ответит 402,
      // и «вернуть приложение» означало бы показать пустые экраны.
      block: info.state === 'expired' ? s.block : null,
      unblockedAt: info.state === 'expired' ? s.unblockedAt : Date.now(),
    }))
    return info
  },
}))

// Подписка на 402 — после create(), иначе стор ещё не существует.
onMaintenanceBlocked((block) => useLicenseStore.setState({ block }))
