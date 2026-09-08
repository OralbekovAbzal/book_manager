export type BookingStatus = 'CONFIRMED' | 'CHECKED_IN' | 'CHECKED_OUT' | 'CANCELLED' | 'NO_SHOW'
// Ролей две. STAFF убран решением владельца (docs/decisions/interface.md,
// 2026-09-08): по факту он мог почти всё, и половина проверок в интерфейсе
// сводилась к «а что можно сотруднику». Сервер создание STAFF отклоняет (400),
// существующие учётки миграцией переведены в ADMIN.
export type AdminRole = 'SUPER_ADMIN' | 'ADMIN'
export type BookingSource = 'телефон' | 'стойка' | 'онлайн' | 'Каспи'

// ─── Документ гостя ───────────────────────────────────────────────────────────
// Значения перечислений — КОНТРАКТ с сервером (routes/bookings.js отвечает 400
// на любое другое): 'passport' | 'id_card' | 'other' и 'm' | 'f'. Держим их
// союзами, а не строками, чтобы опечатка ловилась здесь, а не 400-й на стойке.
export type GuestDocType = 'passport' | 'id_card' | 'other'
export type GuestSex = 'm' | 'f'

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

// ─── Цепочка брони (переезд = один счёт) ──────────────────────────────────────
// Переезд со сплитом делает ДВЕ записи в шахматке, но счёт у гостя один:
// начисления и платежи физически лежат на первой брони («голове»), а вторая
// («продолжение») ссылается на неё через `accountBookingId`. Решение —
// `docs/decisions/data-and-money.md` (2026-09-08). Раньше `move()` делил
// `paidAmount` пропорцией, а платежи оставались на первой части (D3-001/002, D7-013).

/** Голова счёта у продолжения: id и номер, чтобы показать «Счёт брони №N». */
export interface BookingAccountRef {
  id: number
  room?: { number: string } | null
}

/** Отрезок цепочки. Приходит у ГОЛОВЫ — по одному на каждый переезд. */
export interface BookingContinuation {
  id: number
  roomId: number
  room?: { number: string } | null
  checkIn: string
  checkOut: string
  status: BookingStatus
}

export interface Booking {
  id: number
  /**
   * Непусто — деньги этой брони лежат на счёте головы (`accountBookingId`),
   * а свои `totalAmount/prepaidAmount/paidAmount` у неё нулевые. Все денежные
   * экраны считают по `accountIdOf()` из `utils/bookingAccount.ts`.
   */
  accountBookingId?: number | null
  /** Продана поверх квоты партнёра — вопрос больше не задаётся */
  allotmentOverride?: boolean
  /** Заполнено только у продолжения */
  account?: BookingAccountRef | null
  /** Заполнено только у головы; пустой массив — обычная бронь без переездов */
  continuations?: BookingContinuation[]
  roomId: number
  guestName: string
  guestPhone?: string
  /**
   * Документ гостя — необязателен: бронь по телефону заводят за недели, паспорт
   * появляется на стойке при заселении.
   * ⚠️ `guestDocExpiry` и `guestBirthDate` — это `@db.Date`, и сервер отдаёт их
   * ПОЛНЫМ ISO ('2031-04-02T00:00:00.000Z'), в отличие от `checkIn`/`checkOut`
   * из тех же ответов. В форму и на экран — только через `.slice(0, 10)`:
   * разбор в местную зону сдвинул бы дату на день назад.
   */
  guestCitizenship?: string | null
  guestDocType?: GuestDocType | null
  guestDocNumber?: string | null
  guestDocExpiry?: string | null
  guestBirthDate?: string | null
  guestSex?: GuestSex | null
  checkIn: string   // YYYY-MM-DD
  checkOut: string  // YYYY-MM-DD
  status: BookingStatus
  /**
   * Фактические заезд и выезд — НАСТОЯЩИЕ моменты времени (ISO datetime), а не
   * `@db.Date`, как плановые checkIn/checkOut. Показывать их надо в МЕСТНОМ времени,
   * без `timeZone:'UTC'`: иначе стойка увидит заезд «в 09:00» вместо 14:00.
   * null — гость ещё не заехал / не выехал.
   */
  actualCheckInAt?: string | null
  actualCheckOutAt?: string | null
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
  /** Питание и услуги брони. Приходят только из GET /bookings/:id — в сетке их нет. */
  services?: BookingServiceLink[]
  createdBy?: { id: number; name: string }
  createdAt?: string
  updatedAt?: string
}

// Grid API types

/**
 * Полоска в шахматке — то же, что приходит в событиях сокета `booking:created`
 * / `booking:updated` / `booking:checkin` / `booking:checkout`.
 *
 * ⚠️ Документа гостя здесь НЕТ и быть не должно: гражданство, тип и номер
 * документа, дата рождения и пол — персональные данные, и рассылать их всем
 * подключённым рабочим местам ради рисования полоски незачем (сервер убрал их
 * из сокет-событий, аудит D1-007). Документ читается ТОЛЬКО точечно, через
 * `GET /bookings/:id` (`fetchBooking`), и только на тех экранах, где он нужен:
 * форма брони, карточка просмотра, печать. Не добавляй эти поля сюда.
 */
export interface GridBooking {
  id: number
  /**
   * Продолжение чужого счёта: деньги этой полоски лежат на брони №N.
   * Грид отдаёт только id счёта — без него полоска не может показать значок
   * цепочки, а её собственные суммы (нулевые) выглядели бы как «не оплачено».
   */
  accountBookingId?: number | null
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

// ─── Гости (справочник) ───────────────────────────────────────────────────────
// Собираются из существующих броней, своей таблицы у них нет: гость — это
// свёртка броней по одному телефону (см. server/src/controllers/guestController.js).

/** Бронь в карточке гостя — ровно столько, сколько нужно строке списка и переходу. */
export interface GuestBooking {
  id: number
  guestName: string
  roomId: number
  roomNumber: string
  /** YYYY-MM-DD, уже без времени — сдвиг на день здесь не поймать */
  checkIn: string
  checkOut: string
  nights: number
  status: BookingStatus
  source: string | null
  totalAmount: number
}

/**
 * Документ гостя, каким его отдаёт `guestController.pickDocument`: из самого
 * СВЕЖЕГО визита, где документ вообще заполнен (паспорт меняют, и старый номер
 * ушёл бы в уведомление МВД неверным).
 *
 * Имена полей совпадают с полями брони намеренно: подстановка в форму — это
 * буквально копирование объекта в тело PUT /bookings/:id, и переименование по
 * дороге завело бы третье место, где список полей надо не забыть поправить.
 * Даты здесь УЖЕ обрезаны сервером до YYYY-MM-DD (в отличие от `Booking`).
 */
export interface GuestDocument {
  guestCitizenship: string | null
  guestDocType: GuestDocType | null
  guestDocNumber: string | null
  guestDocExpiry: string | null
  guestBirthDate: string | null
  guestSex: GuestSex | null
  /** Из какой брони взят — единственное поле, которое НЕ идёт в форму */
  from: {
    bookingId: number
    checkIn: string
    checkOut: string
    roomNumber: string | null
  }
}

/** Ответ `GET /api/guests/lookup?phone=…`. Ничего не меняет — только читает. */
export interface GuestLookup {
  found: boolean
  /** Номер не опознан (обрывок) — null, и это не ошибка */
  phoneKey: string | null
  /** Имя из ТОЙ ЖЕ брони, что и документ. Набранное в форме им не затираем. */
  guestName: string | null
  document: GuestDocument | null
}

export interface Guest {
  /** Нормализованные цифры номера — ключ группировки */
  phoneKey: string
  /** Как показывать номер */
  phone: string
  /** Разные написания одного номера в бронях; >1 — доказательство склейки */
  phoneVariants: string[]
  /** Самый полный вариант имени */
  name: string
  /** Все написания имени, от полного к короткому */
  nameVariants: string[]
  /** Сколько раз жил (без отменённых и неявок) */
  visits: number
  nights: number
  cancelled: number
  /** Броней на будущее */
  upcoming: number
  firstVisit: string | null
  lastVisit: string | null
  /** Ближайший заезд впереди — ради него книгу и открывают */
  nextVisit: string | null
  /**
   * Документ гостя. Есть только у карточек, склеенных по ТЕЛЕФОНУ: в группах
   * `unnamed` (совпало одно имя) его нет намеренно — приписать паспорт одного
   * человека другому хуже, чем не показать документ вовсе.
   */
  document: GuestDocument | null
  bookings: GuestBooking[]
}

/**
 * Брони без опознанного телефона. Это НЕ карточка гостя: без номера одинаковое
 * имя не доказывает, что человек один. Группа по точному совпадению имени —
 * и подписана в интерфейсе именно так.
 */
export interface UnnamedGuestGroup {
  key: string
  name: string
  /** Номер был, но не распознан (обрывок) — показываем, чтобы можно было починить */
  phoneRaw: string | null
  visits: number
  nights: number
  cancelled: number
  bookings: GuestBooking[]
}

export interface GuestBook {
  guests: Guest[]
  unnamed: UnnamedGuestGroup[]
  meta: {
    bookingsTotal: number
    bookingsWithPhone: number
    bookingsWithoutPhone: number
  }
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
  /**
   * В скольких бронях услуга уже стоит. Считает сервер (`GET /services`).
   * Нужно, чтобы «Удалить» честно сказало, сколько истории исчезнет вместе с
   * услугой: удаление каскадное (D6-005). Поле необязательное — старый сервер
   * его не отдаёт, тогда предупреждаем в общих словах, а не молчим.
   */
  usedInBookings?: number
}

/** Услуга, подключённая к конкретной брони: что, скольким и сколько раз. */
export interface BookingServiceLink {
  id: number
  serviceId: number
  /** Сколько взрослых пользуется услугой. «Завтрак на 2 из 3 гостей» — это здесь. */
  adults: number
  children: number
  /** Для услуг, не зависящих от числа людей (per_night, per_booking) */
  quantity: number
  service: Pick<Service, 'id' | 'code' | 'name' | 'price' | 'childPrice' | 'unit' | 'kind' | 'isActive'>
}

/** Пресет пансиона: кнопка, включающая набор услуг питания. */
export interface MealPlan {
  id: number
  code: string
  name: string
  serviceCodes: string[]
  order: number
}
