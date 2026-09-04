import { create } from 'zustand'
import {
  fetchRoomFund, importRoomFund,
  type BuildingRow, type FeatureRow, type CapacityRow, type RoomFundImportPayload,
} from '../api/roomFund'
import { useSettingsStore } from './useSettingsStore'
import { formatApiError } from '../components/Setup/accountRules'

/**
 * Справочники номерного фонда (корпуса, особенности, вместимости) — общее
 * состояние, загружаемое с сервера. В localStorage их больше нет: там они
 * молча разъезжались между рабочими местами.
 *
 * Держим ВСЕ записи, включая скрытые (`includeHidden=true`), и фильтруем на
 * экранах. Причина: выпадающим спискам нужны только активные, а разделу
 * настроек — все; при этом номер может ссылаться на уже скрытую запись, и
 * расшифровать её название нечем, если скрытых в сторе нет.
 */

// ─── Разовый перенос localStorage → БД ────────────────────────────────────────

/** Ключ persist-стора настроек: в нём справочник жил до перехода на сервер. */
const SETTINGS_KEY = 'hotel_visual_settings'
/** Отметка «перенос сделан». Ставится ТОЛЬКО после успешного импорта. */
const MIGRATED_KEY = 'room_fund_migrated_to_db'

/**
 * Достаём старый справочник ПРЯМО из localStorage, а не из стора настроек.
 * Так снимок не зависит от того, что стор с новым типом `RoomFundConfig`
 * (в нём остались только метки) сделает с незнакомыми ему полями.
 */
function readLegacyRoomFund(): RoomFundImportPayload | null {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { state?: { roomFund?: Record<string, unknown> } }
    const fund = parsed?.state?.roomFund
    if (!fund) return null

    const pick = <T,>(key: string): T[] => (Array.isArray(fund[key]) ? (fund[key] as T[]) : [])
    const payload: RoomFundImportPayload = {
      buildings: pick<{ id?: string; name?: string; description?: string }>('buildings'),
      features: pick<{ id?: string; name?: string; emoji?: string }>('features'),
      capacities: pick<{ id?: string; label?: string; value?: number }>('capacities'),
    }
    const total =
      (payload.buildings?.length ?? 0) +
      (payload.features?.length ?? 0) +
      (payload.capacities?.length ?? 0)
    return total > 0 ? payload : null
  } catch {
    // Повреждённый JSON — переносить всё равно нечего.
    return null
  }
}

/**
 * Снимок снимаем СРАЗУ при загрузке модуля, до первого рендера.
 * zustand-persist перезаписывает свой ключ при любом изменении состояния, и
 * старые справочники исчезли бы из localStorage раньше, чем доехали до базы.
 */
const LEGACY_ROOM_FUND = readLegacyRoomFund()

/**
 * Отправляет остатки localStorage на сервер один раз.
 *
 * Молча ничего не делает при любой ошибке — и это главное свойство: при 403
 * (вошёл STAFF, а импорт может только администратор) флаг «перенесено» НЕ
 * ставится и localStorage НЕ чистится. Иначе на ноутбуке, где работает только
 * стойка, локальный справочник пропал бы, не доехав до базы. Повторим, когда
 * войдёт администратор.
 */
async function migrateLegacyOnce(): Promise<void> {
  if (localStorage.getItem(MIGRATED_KEY) === '1') return

  // Переносить нечего (свежая установка или уже почистили) — отмечаем и уходим.
  if (!LEGACY_ROOM_FUND) {
    localStorage.setItem(MIGRATED_KEY, '1')
    return
  }

  try {
    await importRoomFund(LEGACY_ROOM_FUND)
  } catch {
    return
  }

  localStorage.setItem(MIGRATED_KEY, '1')
  // Чистим только после успеха: справочник теперь в базе, локальная копия
  // будет только сбивать с толку.
  useSettingsStore.getState().forgetLegacyRoomFund()
}

// ─── Стор ─────────────────────────────────────────────────────────────────────

interface RoomFundStore {
  buildings: BuildingRow[]
  features: FeatureRow[]
  capacities: CapacityRow[]
  loading: boolean
  /** true после первой удачной загрузки — по нему экраны отличают «пусто» от «ещё не пришло». */
  loaded: boolean
  error: string
  /** Перечитать справочник с сервера. Зовётся после каждой правки. */
  load: () => Promise<void>
  /** Загрузить, если ещё не загружали (и не грузим прямо сейчас). */
  ensureLoaded: () => void
}

/** Один общий запрос на всех: экранов, зовущих ensureLoaded, может быть несколько. */
let inflight: Promise<void> | null = null

export const useRoomFundStore = create<RoomFundStore>((set, get) => ({
  buildings: [],
  features: [],
  capacities: [],
  loading: false,
  loaded: false,
  error: '',

  load: () => {
    if (inflight) return inflight
    const run = (async () => {
      set({ loading: true })
      try {
        await migrateLegacyOnce()
        const data = await fetchRoomFund(true)
        set({ ...data, loaded: true, error: '' })
      } catch (e) {
        set({ error: formatApiError(e, 'Не удалось загрузить справочник номерного фонда') })
      } finally {
        set({ loading: false })
        inflight = null
      }
    })()
    inflight = run
    return run
  },

  ensureLoaded: () => {
    if (get().loaded || inflight) return
    void get().load()
  },
}))
