import { create } from 'zustand'
import { fetchSystemStatus, type BackupWarning } from '../api/system'

/**
 * Здоровье резервных копий — общее состояние на всё приложение: полосу под
 * шапкой и раздел «Настройки → Резервная копия» читают отсюда, а не каждый свой
 * `useState`. Иначе после ручной копии или восстановления полоса в шапке
 * осталась бы висеть до перезагрузки.
 *
 * Решение «плохо или нет» принимает СЕРВЕР (`GET /system/status` → `backup.warning`):
 * правило «старше двух суток» должно быть одно, а не размножаться по экранам.
 */

interface BackupStatusStore {
  warning: BackupWarning
  /** Когда прошла последняя УДАЧНАЯ копия; null — копий ещё не было */
  lastOkAt: string | null
  ageHours: number | null
  loaded: boolean
  loading: boolean
  /**
   * Полоса скрыта крестиком — до следующего входа. Живёт в сторе, а не в
   * sessionStorage: «до следующего входа» и означает «пока не сменилась сессия»,
   * а стор пересоздаётся вместе с окном программы.
   */
  dismissed: boolean
  /** Загрузка после входа: возвращает полосу, даже если её скрывали прошлой сессией. */
  load: () => Promise<void>
  /** Перечитать после операций с копиями; скрытую крестиком полосу не возвращает. */
  reload: () => Promise<void>
  dismiss: () => void
}

export const useBackupStatusStore = create<BackupStatusStore>((set, get) => ({
  warning: 'none',
  lastOkAt: null,
  ageHours: null,
  loaded: false,
  loading: false,
  dismissed: false,

  load: async () => {
    set({ dismissed: false })
    await get().reload()
  },

  reload: async () => {
    if (get().loading) return
    set({ loading: true })
    try {
      const { backup } = await fetchSystemStatus()
      set({
        warning: backup.warning,
        lastOkAt: backup.lastOkAt,
        ageHours: backup.ageHours,
        loaded: true,
      })
    } catch {
      // Молчим намеренно: сервер недоступен — об этом уже кричат другие экраны,
      // а вторая полоса «не удалось узнать про копии» только мешала бы.
      set({ loaded: true })
    } finally {
      set({ loading: false })
    }
  },

  dismiss: () => set({ dismissed: true }),
}))
