import { create } from 'zustand'
import { addDays, format, parseISO } from 'date-fns'
import { fetchGrid, fetchToday } from '../api/occupancy'
import { fetchCurrentShift } from '../api/shifts'
import type { GridData, GridBooking, GridFilters, ModalState, TodayEvents } from '../types'
import { useSettingsStore } from './useSettingsStore'

export type RoomStatusFilter =
  | 'all'         // все номера
  | 'living'      // проживают (CHECKED_IN, ещё не выезжают сегодня)
  | 'departing'   // выезжают сегодня (CHECKED_IN, checkOut == shiftDate)
  | 'departed'    // выехали сегодня (CHECKED_OUT, checkOut == shiftDate)
  | 'arriving'    // заезжают сегодня (CONFIRMED, checkIn == shiftDate)
  | 'arrived'     // заехали сегодня (CHECKED_IN, checkIn == shiftDate)
  | 'free'        // свободные на сегодняшнюю дату

const getVisibleDays = () => useSettingsStore.getState().visual.visibleDays ?? 30
// Сколько дней показывать слева ДО даты смены (настраивается во «Внешнем виде»)
const getDaysBefore = () => useSettingsStore.getState().visual.daysBeforeShift ?? 3

// Use UTC midnight so dateFrom/dateTo strings match the UTC-based dates
// returned by the server. Local setHours(0,0,0,0) in UTC+5 would be
// 2026-05-19T19:00:00Z which format() shows as "2026-05-19" — one day behind.
const _todayNow = new Date()
const today = new Date(Date.UTC(_todayNow.getUTCFullYear(), _todayNow.getUTCMonth(), _todayNow.getUTCDate()))

const LS_FILTERS = 'grid_filters'

// Порядковый номер запроса сетки. При быстром листании ответы приходят не по порядку —
// применяем только ответ на самый последний запрос (см. fetchGrid).
let gridReqSeq = 0

function loadFilters(): GridFilters {
  const defaults: GridFilters = { building: '', categoryId: '', floor: '', capacity: '', features: '' }
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(LS_FILTERS) || '{}') }
  } catch {
    return defaults
  }
}

interface GridStore {
  data: GridData | null
  todayEvents: TodayEvents | null
  loading: boolean
  error: string | null
  dateFrom: string
  dateTo: string
  filters: GridFilters
  guestSearch: string                   // клиентский фильтр по имени гостя
  modal: ModalState
  contextMenu: { booking: GridBooking; x: number; y: number } | null
  deleteTarget: GridBooking | null
  shiftDate: string | null              // YYYY-MM-DD текущей открытой смены
  roomStatusFilter: RoomStatusFilter
  hiddenCategoryIds: number[]           // клиентский фильтр категорий (чекбоксы в панели)

  fetchGrid: () => Promise<void>
  fetchToday: () => Promise<void>
  fetchShiftDate: () => Promise<void>
  setRoomStatusFilter: (f: RoomStatusFilter) => void
  toggleCategoryVisible: (id: number) => void
  navigate: (days: number) => void
  syncDateRange: () => void
  setFilter: (key: keyof GridFilters, value: string) => void   // обновляет state БЕЗ fetch
  setGuestSearch: (s: string) => void
  applyFilters: () => void                                     // фиксирует фильтры + fetch
  jumpToDate: (date: string) => void                           // прыжок на конкретную дату
  openCreateModal: (roomId?: number, checkIn?: string, checkOut?: string, immediateCheckIn?: boolean) => void
  openMaintenanceModal: (roomId: number, checkIn: string, checkOut: string) => void
  openEditModal: (booking: GridBooking) => void
  openViewModal: (booking: GridBooking) => void
  openMoveModal: (booking: GridBooking, newRoomId: number, moveDate: string) => void
  closeModal: () => void
  openContextMenu: (booking: GridBooking, x: number, y: number) => void
  closeContextMenu: () => void
  openDeleteConfirm: (booking: GridBooking) => void
  closeDeleteConfirm: () => void

  // WebSocket handlers
  onBookingCreated: (booking: GridBooking) => void
  onBookingUpdated: (booking: GridBooking) => void
  onBookingCancelled: (bookingId: number) => void
}

export const useGridStore = create<GridStore>((set, get) => ({
  data: null,
  todayEvents: null,
  loading: false,
  error: null,
  // dateTo всегда = dateFrom + visibleDays, чтобы дни точно вмещались в окно
  dateFrom: format(addDays(today, -getDaysBefore()), 'yyyy-MM-dd'),
  dateTo:   format(addDays(today, -getDaysBefore() + getVisibleDays()), 'yyyy-MM-dd'),
  filters: loadFilters(),
  guestSearch: '',
  modal: { open: false, mode: 'create' },
  contextMenu: null,
  deleteTarget: null,
  shiftDate: null,
  roomStatusFilter: 'all',
  hiddenCategoryIds: [],

  fetchGrid: async () => {
    const { dateFrom, dateTo, filters, guestSearch } = get()
    const seq = ++gridReqSeq
    set({ loading: true, error: null })
    try {
      const data = await fetchGrid(dateFrom, dateTo, filters, guestSearch)
      // Пока ждали — ушёл более новый запрос: этот ответ устарел, ничего не трогаем
      // (loading снимет актуальный запрос).
      if (seq !== gridReqSeq) return
      set({ data, loading: false })
    } catch (err: unknown) {
      // Ошибку устаревшего запроса тоже игнорируем — она не про текущий период
      if (seq !== gridReqSeq) return
      const msg = err instanceof Error ? err.message : 'Ошибка загрузки данных'
      set({ error: msg, loading: false })
    }
  },

  fetchToday: async () => {
    try {
      const todayEvents = await fetchToday()
      set({ todayEvents })
    } catch {
      // non-critical
    }
  },

  fetchShiftDate: async () => {
    try {
      const shift = await fetchCurrentShift()
      const shiftDate = shift.date.slice(0, 10)
      // Центрируем сетку на рабочем дне (смене): daysBeforeShift дней слева + visibleDays вперёд.
      const newFrom = format(addDays(parseISO(shiftDate), -getDaysBefore()), 'yyyy-MM-dd')
      const newTo = format(addDays(parseISO(newFrom), getVisibleDays()), 'yyyy-MM-dd')
      set({ shiftDate, dateFrom: newFrom, dateTo: newTo })
      get().fetchGrid()
    } catch {
      // non-critical — фильтр будет использовать data.today как fallback
    }
  },

  setRoomStatusFilter: (f) => set({ roomStatusFilter: f }),

  toggleCategoryVisible: (id) => set((s) => ({
    hiddenCategoryIds: s.hiddenCategoryIds.includes(id)
      ? s.hiddenCategoryIds.filter((x) => x !== id)
      : [...s.hiddenCategoryIds, id],
  })),

  navigate: (days) => {
    const { dateFrom } = get()
    const newFrom = format(addDays(parseISO(dateFrom), days), 'yyyy-MM-dd')
    const newTo = format(addDays(parseISO(newFrom), getVisibleDays()), 'yyyy-MM-dd')
    set({ dateFrom: newFrom, dateTo: newTo })
    get().fetchGrid()
  },

  syncDateRange: () => {
    const { dateFrom } = get()
    const dateTo = format(addDays(parseISO(dateFrom), getVisibleDays()), 'yyyy-MM-dd')
    set({ dateTo })
    get().fetchGrid()
  },

  setFilter: (key, value) => {
    const filters = { ...get().filters, [key]: value }
    set({ filters })
    // НЕ сохраняем в localStorage сразу и НЕ фетчим — это делает applyFilters
  },

  setGuestSearch: (s) => set({ guestSearch: s }),

  applyFilters: () => {
    const { filters } = get()
    localStorage.setItem(LS_FILTERS, JSON.stringify(filters))
    get().fetchGrid()
  },

  jumpToDate: (date) => {
    if (!date) return
    const dateTo = format(addDays(parseISO(date), getVisibleDays()), 'yyyy-MM-dd')
    set({ dateFrom: date, dateTo })
    get().fetchGrid()
  },

  openCreateModal: (roomId, checkIn, checkOut, immediateCheckIn) =>
    set({ modal: { open: true, mode: 'create', prefillRoomId: roomId, prefillCheckIn: checkIn, prefillCheckOut: checkOut, prefillImmediateCheckIn: immediateCheckIn } }),

  openMaintenanceModal: (roomId, checkIn, checkOut) =>
    set({ modal: { open: true, mode: 'maintenance', prefillRoomId: roomId, prefillCheckIn: checkIn, prefillCheckOut: checkOut } }),

  openEditModal: (booking) =>
    set({ modal: { open: true, mode: 'edit', booking }, contextMenu: null }),

  openViewModal: (booking) =>
    set({ modal: { open: true, mode: 'view', booking }, contextMenu: null }),

  openMoveModal: (booking, newRoomId, moveDate) =>
    set({ modal: { open: true, mode: 'move', booking, moveTargetRoomId: newRoomId, moveDate } }),

  closeModal: () =>
    set({ modal: { open: false, mode: 'create' } }),

  openContextMenu: (booking, x, y) =>
    set({ contextMenu: { booking, x, y } }),

  closeContextMenu: () =>
    set({ contextMenu: null }),

  openDeleteConfirm: (booking) =>
    set({ deleteTarget: booking, contextMenu: null }),

  closeDeleteConfirm: () =>
    set({ deleteTarget: null }),

  // — WebSocket handlers —

  onBookingCreated: (booking) => {
    set((state) => {
      if (!state.data) return {}
      return { data: insertBooking(state.data, booking) }
    })
  },

  onBookingUpdated: (booking) => {
    set((state) => {
      if (!state.data) return {}
      return { data: replaceBooking(state.data, booking) }
    })
  },

  onBookingCancelled: (bookingId) => {
    set((state) => {
      if (!state.data) return {}
      return { data: removeBooking(state.data, bookingId) }
    })
  },
}))

// — Immutable helpers —

// Вставка в строку номера booking.roomId. Бронь с таким id сначала убираем отовсюду —
// повторное событие (переезд шлёт updated+created) не должно плодить дубли.
function insertBooking(data: GridData, booking: GridBooking): GridData {
  const cleaned = removeBooking(data, booking.id)
  return {
    ...cleaned,
    categories: cleaned.categories.map((cat) => ({
      ...cat,
      rooms: cat.rooms.map((room) =>
        room.id === booking.roomId
          ? { ...room, bookings: [...room.bookings, normalizeBooking(booking)] }
          : room
      ),
    })),
  }
}

// Замена = удалить старую версию из всех номеров + вставить в номер booking.roomId.
// Бронь могла сменить номер (переезд, оптимизатор) — замена «на месте» оставляла её
// в старой строке. Если номера нет в текущей выборке (фильтр) — бронь просто исчезает.
function replaceBooking(data: GridData, booking: GridBooking): GridData {
  return insertBooking(data, booking)
}

function removeBooking(data: GridData, bookingId: number): GridData {
  return {
    ...data,
    categories: data.categories.map((cat) => ({
      ...cat,
      rooms: cat.rooms.map((room) => ({
        ...room,
        bookings: room.bookings.filter((b) => b.id !== bookingId),
      })),
    })),
  }
}

function normalizeBooking(b: GridBooking): GridBooking {
  return {
    ...b,
    checkIn: b.checkIn.slice(0, 10),
    checkOut: b.checkOut.slice(0, 10),
  }
}
