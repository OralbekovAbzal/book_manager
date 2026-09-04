export type BookingStatus = 'CONFIRMED' | 'CHECKED_IN' | 'CHECKED_OUT' | 'CANCELLED' | 'NO_SHOW'
export type AdminRole = 'SUPER_ADMIN' | 'ADMIN' | 'STAFF'
export type BookingSource = 'телефон' | 'стойка' | 'онлайн' | 'Каспи'

export interface Category {
  id: number
  name: string
  color: string
  description?: string
}

export interface Room {
  id: number
  number: string
  building: string
  floor: number
  features: string[]
  capacity?: string
  isActive: boolean
  category: Category
}

export interface Booking {
  id: number
  roomId: number
  guestName: string
  guestPhone?: string
  checkIn: string   // YYYY-MM-DD
  checkOut: string  // YYYY-MM-DD
  status: BookingStatus
  source?: string
  notes?: string
  adultsWithMeals?: number
  childrenWithMeals?: number
  adultsNoMeals?: number
  childrenNoMeals?: number
  extraBedsWithMeals?: number
  extraBedsNoMeals?: number
  disabledAdults?: number
  disabledChildren?: number
  discountPercent?: number
  prepaymentPercent?: number
  totalAmount?: number
  prepaidAmount?: number
  paidAmount?: number
  flags?: string[]
  partnerId?: number | null
  partner?: PartnerLite
  shiftId?: number | null
  room?: Room
  createdBy?: { id: number; name: string }
  createdAt?: string
  updatedAt?: string
}

// Grid API types
export interface GridBooking {
  id: number
  roomId: number
  guestName: string
  guestPhone?: string
  checkIn: string
  checkOut: string
  status: BookingStatus
  source?: string
  notes?: string
  adultsWithMeals?: number
  childrenWithMeals?: number
  adultsNoMeals?: number
  childrenNoMeals?: number
  extraBedsWithMeals?: number
  extraBedsNoMeals?: number
  disabledAdults?: number
  disabledChildren?: number
  discountPercent?: number
  prepaymentPercent?: number
  totalAmount?: number
  prepaidAmount?: number
  paidAmount?: number
  flags?: string[]
  partnerId?: number | null
  partner?: PartnerLite
  shiftId?: number | null
}

export interface PartnerLite {
  id: number
  name: string
  color: string
}

export interface Partner extends PartnerLite {
  defaultCheckInDay: number | null  // 0=вс ... 6=сб
  defaultNights: number
  commissionPercent: number | null
  contactPerson?: string | null
  contactPhone?: string | null
  notes?: string | null
  isActive: boolean
  _count?: { allotments: number; bookings: number }
}

export interface AllotmentRelease {
  id: number
  dateFrom: string
  dateTo: string
  reason?: string | null
}

export interface GridAllotment {
  id: number
  roomId: number
  dateFrom: string
  dateTo: string
  partner: PartnerLite
  releases: AllotmentRelease[]
}

export interface Allotment {
  id: number
  partnerId: number
  roomId: number
  dateFrom: string
  dateTo: string
  notes?: string | null
  partner: PartnerLite
  room: { id: number; number: string; building: string; floor: number }
  releases: AllotmentRelease[]
}

export interface GridRoom {
  id: number
  number: string
  building: string
  floor: number
  features: string[]
  bookings: GridBooking[]
  allotments?: GridAllotment[]
}

export interface GridCategory {
  id: number
  name: string
  color: string
  rooms: GridRoom[]
}

export interface GridData {
  dateFrom: string
  dateTo: string
  today: string
  totalRooms: number
  categories: GridCategory[]
}

export interface TodayStats {
  date: string
  totalRooms: number
  occupied: number
  free: number
  occupancyRate: number
  checkIns: number
  checkOuts: number
}

export interface TodayEvents {
  date: string
  arrivals: Booking[]
  departures: Booking[]
  pendingCheckins: Booking[]
  pendingCheckouts: Booking[]
  counts: {
    arrivals: number
    departures: number
    pendingCheckins: number
    pendingCheckouts: number
  }
}

export interface Admin {
  id: number
  username: string
  name: string
  role: AdminRole
}

// Flat row types for grid virtualization
export type FlatRow =
  | { type: 'room'; room: GridRoom; categoryColor: string; categoryName: string }
  | { type: 'category'; id: number; name: string; color: string; total: number; occupied: number }

// Modal state
export interface ModalState {
  open: boolean
  mode: 'create' | 'edit' | 'view' | 'maintenance' | 'move'
  booking?: GridBooking
  prefillRoomId?: number
  prefillCheckIn?: string
  prefillCheckOut?: string
  prefillImmediateCheckIn?: boolean
  // Для режима 'move': целевой номер и предложенная дата переезда
  moveTargetRoomId?: number
  moveDate?: string
}

export interface GridFilters {
  building: string
  categoryId: string
  floor: string
  capacity: string
  features: string
}

// Справочник контактов (сотрудники, службы, подрядчики, экстренные номера)
export interface Contact {
  id: number
  name: string
  role: string | null
  group: string
  phones: string[]
  email: string | null
  notes: string | null
  isPinned: boolean
  order: number
  isActive: boolean
  createdAt: string
  updatedAt: string
}

// ─── Ценообразование ──────────────────────────────────────────────────────────

export type PricingBase = 'room' | 'person'

export interface HotelSettings {
  id: number
  name: string
  city: string | null
  currency: string
  pricingBase: PricingBase
  lateArrivalHour: number | null
  updatedAt: string
}

/** Цена на конкретную дату для категории. Какие поля значимы — зависит от pricingBase. */
export interface RatePrice {
  id: number
  categoryId: number
  date: string
  roomPrice: number | null
  adultPrice: number | null
  childPrice: number | null
  extraBedPrice: number | null
  updatedAt: string
}

export type PriceField = 'roomPrice' | 'adultPrice' | 'childPrice' | 'extraBedPrice'

// ─── Первичная настройка и пользователи ───────────────────────────────────────

/** GET /api/setup/status: нужна ли первичная настройка и название отеля (если уже задано). */
export interface SetupStatus {
  needsSetup: boolean
  hotelName: string | null
}

/** Учётная запись сотрудника (Настройки → Пользователи). */
export interface User {
  id: number
  username: string
  name: string
  role: AdminRole
  isActive: boolean
  createdAt: string
}

/** Ошибка валидации сервера по полю: { error: 'Ошибка валидации', details: ApiFieldError[] }. */
export interface ApiFieldError {
  field: string
  message: string
}

// ─── Журнал действий и резервные копии ────────────────────────────────────────

/** Запись журнала действий (GET /api/audit/log). action — 'POST /bookings/12/move' и т.п. */
export interface AuditLogEntry {
  id: number
  adminId: number | null
  adminName: string
  action: string
  entity: string
  entityId: number | null
  details: unknown
  ip: string | null
  createdAt: string
}

/** Строка журнала копий (модель BackupLog): удалась ли последняя копия. */
export interface BackupLogEntry {
  id: number
  path: string
  size: number
  success: boolean
  error: string | null
  createdAt: string
}

export interface BackupFile {
  name: string
  size: number
  createdAt: string
}

/** GET /api/system/backups */
export interface BackupsInfo {
  last: BackupLogEntry | null
  files: BackupFile[]
}

/** POST /api/system/backup */
export interface BackupResult {
  filename: string
  path: string
  size: number
  createdAt: string
}

/** POST /api/system/backup/restore — сколько строк восстановлено по таблицам. */
export interface RestoreResult {
  restored: Record<string, number>
  safetyBackup: string
}

/** Как начисляется услуга. */
export type ServiceUnit = 'per_person_night' | 'per_night' | 'per_person' | 'per_booking'
export type ServiceKind = 'meal' | 'extra'

export interface Service {
  id: number
  code: string
  name: string
  price: number
  /** null — считать по взрослой цене */
  childPrice: number | null
  unit: ServiceUnit
  kind: ServiceKind
  /** Добавлять в новую бронь автоматически */
  includedByDefault: boolean
  isActive: boolean
  order: number
}

/** Пресет пансиона: кнопка, включающая набор услуг питания. */
export interface MealPlan {
  id: number
  code: string
  name: string
  serviceCodes: string[]
  order: number
}
