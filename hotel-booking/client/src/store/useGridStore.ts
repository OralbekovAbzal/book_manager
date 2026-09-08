import { create } from 'zustand'
import { addDays, format, parseISO } from 'date-fns'
import { fetchGrid, fetchToday } from '../api/occupancy'
import { fetchCurrentShift } from '../api/shifts'
import type { GridData, GridBooking, GridFilters, ModalState, TodayEvents, BookingStatus } from '../types'
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

// Таймер короткого сообщения над сеткой (переезд удался / сервер отказал).
// Живёт в модуле, а не в состоянии: перезапуск таймера не должен перерисовывать грид.
let noticeTimer: number | undefined
const NOTICE_MS = { info: 3000, error: 6000 }

/** Короткое сообщение над сеткой. `error` — красная рамка и держится дольше. */
export interface GridNotice {
  text: string
  kind: 'info' | 'error'
}

// ─── Цепочка переезда: кто чей сосед ──────────────────────────────────────────
// Полоска брони должна знать, есть ли у неё продолжение (рисуем рваный край
// вместо мыса) и в каком номере оно живёт (подсказка «Переселён в №B с 1 июля»).
// Грид отдаёт только `accountBookingId`, поэтому соседей ищем сами — но ОДИН раз
// на загруженные данные, а не в каждом блоке: блоков на экране сотни.

/** Соседний отрезок цепочки. `roomNumber === null` — он вне видимой выборки. */
export interface ChainNeighbor {
  id: number
  roomNumber: string | null
  /** Дата разлома: заезд более позднего из двух отрезков */
  date: string
}

export interface ChainEdges {
  /** Отрезок ДО этого (гость приехал из него) */
  prev?: ChainNeighbor
  /** Отрезок ПОСЛЕ этого (гость переехал в него) */
  next?: ChainNeighbor
  /**
   * Статус ПОСЛЕДНЕГО отрезка цепочки. Голова после переезда закрыта
   * (`CHECKED_OUT`), но гость никуда не выезжал — он живёт дальше в другом
   * номере. Красить первую часть в серый «выехал» рядом с зелёной второй значит
   * показывать двух разных гостей вместо одного, поэтому вся цепочка берёт цвет
   * своего последнего отрезка.
   */
  chainStatus?: BookingStatus
}

export type ChainIndex = Record<number, ChainEdges>

const EMPTY_CHAIN_INDEX: ChainIndex = {}

function buildChainIndex(data: GridData): ChainIndex {
  const index: ChainIndex = {}
  const roomNumberOf = new Map<number, string>()
  const chains = new Map<number, GridBooking[]>()
  let anyChain = false

  for (const cat of data.categories) {
    for (const room of cat.rooms) {
      roomNumberOf.set(room.id, room.number)
      for (const b of room.bookings) {
        if (b.accountBookingId != null) anyChain = true
        // Цепочка плоская: все продолжения ссылаются на голову (см. currentSegment)
        const headId = b.accountBookingId ?? b.id
        const list = chains.get(headId)
        if (list) list.push(b)
        else chains.set(headId, [b])
      }
    }
  }
  // Переезды — редкость: в обычной выборке ни одной цепочки нет, и дальше идти незачем
  if (!anyChain) return index

  for (const list of chains.values()) {
    if (list.length < 2 && list[0]?.accountBookingId == null) continue
    const segs = [...list].sort((a, b) => {
      const ai = a.checkIn.slice(0, 10)
      const bi = b.checkIn.slice(0, 10)
      return ai === bi ? a.id - b.id : ai < bi ? -1 : 1
    })
    const lastStatus = segs[segs.length - 1]?.status
    segs.forEach((b, i) => {
      const prevSeg = segs[i - 1]
      const nextSeg = segs[i + 1]
      const edges: ChainEdges = { chainStatus: lastStatus }
      if (prevSeg) {
        edges.prev = {
          id: prevSeg.accountBookingId ?? prevSeg.id,
          roomNumber: roomNumberOf.get(prevSeg.roomId) ?? null,
          date: b.checkIn.slice(0, 10),
        }
      } else if (b.accountBookingId != null) {
        // Голова вне видимого окна (другой период или скрытая категория) — про
        // разлом мы всё равно знаем, просто не знаем номер, из которого приехали.
        edges.prev = { id: b.accountBookingId, roomNumber: null, date: b.checkIn.slice(0, 10) }
      }
      if (nextSeg) {
        edges.next = {
          id: nextSeg.id,
          roomNumber: roomNumberOf.get(nextSeg.roomId) ?? null,
          date: nextSeg.checkIn.slice(0, 10),
        }
      }
      if (edges.prev || edges.next) index[b.id] = edges
    })
  }
  return index
}

// Кэш по объекту данных: `data` заменяется целиком на каждый ответ сервера и на
// каждое socket-событие, поэтому WeakMap хватает — пересчёт ровно один на выборку,
// а ссылка на индекс стабильна, и блоки не перерисовываются впустую.
const chainIndexCache = new WeakMap<GridData, ChainIndex>()

/** Индекс цепочек переезда по текущим данным сетки. Селектор: `selectChainIndex(data)`. */
export function selectChainIndex(data: GridData | null): ChainIndex {
  if (!data) return EMPTY_CHAIN_INDEX
  const cached = chainIndexCache.get(data)
  if (cached) return cached
  const built = buildChainIndex(data)
  chainIndexCache.set(data, built)
  return built
}

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
  notice: GridNotice | null             // короткое сообщение над сеткой (переезд, отказ сервера)

  /** Показать сообщение над сеткой и погасить его по таймеру. */
  flashNotice: (text: string, kind?: GridNotice['kind']) => void
  clearNotice: () => void

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
  /** Бронь из уже загруженной сетки по id (null — её нет в текущем окне дат). */
  findBooking: (id: number) => GridBooking | null
  /**
   * Текущий (последний) отрезок цепочки переезда.
   *
   * После переезда голова закрыта (`CHECKED_OUT`) и сервер её править не даёт:
   * «Редактировать» на ней должно открывать ту часть, в которой гость живёт
   * сейчас. Ищем по сетке (`accountBookingId` есть у каждой полоски) — лишнего
   * запроса не нужно. Если продолжение вне видимого окна дат, возвращаем саму
   * бронь: сервер откажет с внятным текстом, и это честнее, чем угадывать.
   */
  currentSegment: (booking: GridBooking) => GridBooking
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
  notice: null,

  flashNotice: (text, kind = 'info') => {
    window.clearTimeout(noticeTimer)
    set({ notice: { text, kind } })
    noticeTimer = window.setTimeout(() => set({ notice: null }), NOTICE_MS[kind])
  },

  clearNotice: () => {
    window.clearTimeout(noticeTimer)
    set({ notice: null })
  },

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

  findBooking: (id) => {
    const data = get().data
    if (!data) return null
    for (const cat of data.categories) {
      for (const room of cat.rooms) {
        const hit = room.bookings.find(b => b.id === id)
        if (hit) return hit
      }
    }
    return null
  },

  currentSegment: (booking) => {
    const data = get().data
    // У продолжения своих продолжений не бывает: цепочка плоская, все части
    // ссылаются на голову. Значит искать надо только для головы.
    if (!data || booking.accountBookingId != null) return booking
    let last = booking
    for (const cat of data.categories) {
      for (const room of cat.rooms) {
        for (const b of room.bookings) {
          if (b.accountBookingId === booking.id && b.checkOut > last.checkOut) last = b
        }
      }
    }
    return last
  },

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
