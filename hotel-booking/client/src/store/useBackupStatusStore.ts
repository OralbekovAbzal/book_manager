import { create } from 'zustand'
import { fetchSystemStatus, minFreeMb, type BackupWarning } from '../api/system'

/**
 * Здоровье резервных копий и свободного места — общее состояние на всё приложение:
 * полосу под шапкой и раздел «Настройки → Резервная копия» читают отсюда, а не
 * каждый свой `useState`. Иначе после ручной копии или восстановления полоса в
 * шапке осталась бы висеть до перезагрузки.
 *
 * Решение «плохо или нет» принимает СЕРВЕР (`GET /system/status` → `backup.warning`
 * и `disk.warning`): правила «старше двух суток» и «мало места» должны быть по
 * одному, а не размножаться по экранам.
 */

// ── Константы и функции объявлены ДО `create`: объявленная ниже падает при
// горячей перезагрузке с «is not defined» (временная мёртвая зона). Ловили дважды.

/**
 * Что показывает полоса. Беда бывает не одна (диск кончился И копий нет), но
 * полоса одна — иначе шахматка уезжает вниз на две-три строки.
 *
 * Приоритет: `disk` → `never` → `stale` → `fallback`. Место на диске первое,
 * потому что это единственная беда, которая останавливает работу СЕГОДНЯ:
 * без места Postgres перестаёт писать. Остальные три — про завтрашнюю беду,
 * и среди них хуже та, при которой копий больше (или дольше) нет.
 */
export type BannerWarning = 'none' | 'disk' | 'never' | 'stale' | 'fallback'

export function pickBannerWarning(state: {
  diskWarning: boolean
  warning: BackupWarning
}): BannerWarning {
  if (state.diskWarning) return 'disk'
  return state.warning
}

interface BackupStatusStore {
  warning: BackupWarning
  /** Когда прошла последняя УДАЧНАЯ копия; null — копий ещё не было */
  lastOkAt: string | null
  ageHours: number | null
  /** Сервер сказал, что места мало (порог считает он же) */
  diskWarning: boolean
  /** Свободно на самом тесном из проверенных путей, МБ; null — узнать не удалось */
  diskFreeMb: number | null
  /**
   * Сервер вообще прислал блок `disk`. Отдельно от `diskFreeMb`, потому что null
   * там значит «не смогли измерить», а здесь — «старая сборка сервера, вопрос не
   * задавали». Раздел настроек по этому флагу решает, рисовать ли строку.
   */
  diskKnown: boolean
  loaded: boolean
  loading: boolean
  /**
   * Какую именно беду скрыли крестиком — до следующего входа. Не просто `true`:
   * скрытая полоса про копии не должна прятать потом полосу про кончившийся
   * диск — это разные сообщения и разной срочности. Живёт в сторе, а не в
   * sessionStorage: «до следующего входа» и означает «пока не сменилась сессия»,
   * а стор пересоздаётся вместе с окном программы.
   */
  dismissedKind: BannerWarning | null
  /** Загрузка после входа: возвращает полосу, даже если её скрывали прошлой сессией. */
  load: () => Promise<void>
  /** Перечитать после операций с копиями; скрытую крестиком полосу не возвращает. */
  reload: () => Promise<void>
  dismiss: (kind: BannerWarning) => void
}

export const useBackupStatusStore = create<BackupStatusStore>((set, get) => ({
  warning: 'none',
  lastOkAt: null,
  ageHours: null,
  diskWarning: false,
  diskFreeMb: null,
  diskKnown: false,
  loaded: false,
  loading: false,
  dismissedKind: null,

  load: async () => {
    set({ dismissedKind: null })
    await get().reload()
  },

  reload: async () => {
    if (get().loading) return
    set({ loading: true })
    try {
      const { backup, disk } = await fetchSystemStatus()
      set({
        warning: backup.warning,
        lastOkAt: backup.lastOkAt,
        ageHours: backup.ageHours,
        // Старый сервер блока не отдаёт — тогда молчим о месте, а не пугаем нулём
        diskWarning: disk?.warning === true,
        diskFreeMb: disk ? minFreeMb(disk) : null,
        diskKnown: disk !== null,
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

  dismiss: (kind) => set({ dismissedKind: kind }),
}))
