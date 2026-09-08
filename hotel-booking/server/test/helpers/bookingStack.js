/**
 * Стенд волны 5a «Деньги»: настоящие контроллеры броней и платежей на фейковой базе.
 *
 * Почему так, а не через HTTP: живой сервер и Postgres в тестах не участвуют
 * (порт 3001 и база общие с работающей программой). Зато `helpers/fakePrisma.js`
 * честно вычисляет `where`, поэтому проверяется не «что вернул мок», а ЗАПРОС,
 * который строит контроллер: потерянный `source: 'auto'` в удалении или
 * перепутанная граница ночей здесь падают.
 *
 * Из настоящего кода берутся: `utils/charges.js`, `utils/bookingMoney.js`,
 * `middleware/errorHandler.js`. Подменяются только сокет, смена и проверка
 * занятости номера — у них своя область и свои тесты.
 */
import { loadCjs, silentLogger } from './loadCjs.js'
import { createFakePrisma, d } from './fakePrisma.js'

export { d }

/** Рабочая дата стенда: 10 июля 2026. Все фикстуры ниже отсчитываются от неё. */
export const BUSINESS_DATE = d('2026-07-10')

export function room(over = {}) {
  const id = over.id ?? 101
  return {
    id,
    number: String(id),
    building: 'A',
    floor: 1,
    isActive: true,
    categoryId: 1,
    category: { id: 1, name: 'Комфорт', color: '#ccc' },
    ...over,
  }
}

/** Строка календаря цен. `null` в поле — «цена не задана», а не ноль. */
export function rate(date, over = {}) {
  return {
    id: undefined,
    categoryId: 1,
    date: d(date),
    roomPrice: null,
    adultPrice: 15000,
    childPrice: 7000,
    extraBedPrice: 5000,
    ...over,
  }
}

export function service(over = {}) {
  return {
    id: 1,
    code: 'breakfast',
    name: 'Завтрак',
    price: 3500,
    childPrice: null,
    unit: 'per_person_night',
    kind: 'meal',
    isActive: true,
    includedByDefault: false,
    order: 1,
    ...over,
  }
}

export function bookingServiceRow(over = {}) {
  return {
    id: 1, bookingId: 1, serviceId: 1, adults: 2, children: 0, quantity: 1, service: null, ...over,
  }
}

export function charge(over = {}) {
  return {
    id: 1,
    bookingId: 1,
    kind: 'stay',
    label: 'Проживание · 2 взр.',
    quantity: 1,
    unitPrice: 30000,
    amount: 30000,
    date: null,
    source: 'auto',
    reason: null,
    createdById: 1,
    createdBy: null,
    createdAt: d('2026-07-01'),
    updatedAt: d('2026-07-01'),
    ...over,
  }
}

export function payment(over = {}) {
  const id = over.id ?? 1
  return {
    id,
    bookingId: 1,
    kind: 'payment',
    amount: 10000,
    method: 'cash',
    adminId: 1,
    adminName: 'Админ',
    shiftId: 1,
    businessDate: BUSINESS_DATE,
    paidAt: new Date('2026-07-10T08:00:00Z'),
    comment: null,
    refundOfId: null,
    voidedAt: null,
    voidedById: null,
    voidReason: null,
    admin: { id: 1, name: 'Админ', username: 'admin' },
    voidedBy: null,
    booking: null,
    ...over,
  }
}

/** Поля, которых нет в `data` при create, но которые спрашивает BOOKING_SELECT. */
const BOOKING_DEFAULTS = {
  guestPhone: null,
  guestCitizenship: null,
  guestDocType: null,
  guestDocNumber: null,
  guestDocExpiry: null,
  guestBirthDate: null,
  guestSex: null,
  actualCheckInAt: null,
  actualCheckOutAt: null,
  source: null,
  notes: null,
  disabledAdults: 0,
  disabledChildren: 0,
  discountPercent: 0,
  prepaymentPercent: 50,
  totalAmount: 0,
  prepaidAmount: 0,
  paidAmount: 0,
  flags: [],
  partnerId: null,
  partner: null,
  shiftId: 1,
  adminId: 1,
  createdBy: { id: 1, name: 'Админ' },
  createdAt: d('2026-07-01'),
  updatedAt: d('2026-07-01'),
}

export function booking(over = {}) {
  return {
    id: 1,
    roomId: 101,
    guestName: 'Иванов',
    checkIn: d('2026-07-10'),
    checkOut: d('2026-07-13'),
    status: 'CONFIRMED',
    adultsWithMeals: 2,
    childrenWithMeals: 0,
    adultsNoMeals: 0,
    childrenNoMeals: 0,
    extraBedsWithMeals: 0,
    extraBedsNoMeals: 0,
    ...BOOKING_DEFAULTS,
    room: room({ id: over.roomId ?? 101 }),
    ...over,
  }
}

/**
 * Собирает фейковую базу и оба контроллера на ней.
 *
 * Связи (`room`, `service`, `createdBy`) фейк не разрешает сам — их дописывают
 * обёртки над `create`/`createMany`: иначе `select`/`include` контроллера падал бы
 * на отсутствующем поле фикстуры, а это поломка стенда, а не поведения.
 */
export function makeStack({
  bookings = [],
  charges = [],
  services = [],
  bookingServices = [],
  rates = [],
  payments = [],
  rooms = [room({ id: 101 }), room({ id: 102 })],
  pricingBase = 'person',
  businessDate = BUSINESS_DATE,
} = {}) {
  const rateRows = rates.map((r, i) => ({ ...r, id: r.id ?? 1000 + i }))
  const { prisma, calls } = createFakePrisma({
    booking: bookings,
    bookingCharge: charges,
    bookingService: bookingServices.map((bs) => ({
      ...bs,
      service: bs.service ?? services.find((s) => s.id === bs.serviceId) ?? null,
    })),
    service: services,
    ratePrice: rateRows,
    room: rooms,
    hotelSettings: [{ id: 1, pricingBase }],
    payment: payments.map((p) => ({
      ...p,
      booking: p.booking ?? null,
    })),
    shift: [{ id: 1, date: businessDate, createdBy: { id: 1, name: 'Админ' } }],
  })

  // ── Обёртки: дописать связи, которых у только что созданной записи нет ──
  const createBooking = prisma.booking.create.bind(prisma.booking)
  prisma.booking.create = (args) => {
    const r = rooms.find((x) => x.id === args.data.roomId) || null
    return createBooking({ ...args, data: { ...BOOKING_DEFAULTS, ...args.data, room: r } })
  }

  const chargeDefaults = { reason: null, createdBy: null, createdAt: new Date(), updatedAt: new Date(), date: null }
  const createCharge = prisma.bookingCharge.create.bind(prisma.bookingCharge)
  prisma.bookingCharge.create = (args) =>
    createCharge({ ...args, data: { ...chargeDefaults, ...args.data } })
  const createCharges = prisma.bookingCharge.createMany.bind(prisma.bookingCharge)
  prisma.bookingCharge.createMany = (args) => createCharges({
    ...args,
    data: (Array.isArray(args.data) ? args.data : [args.data]).map((x) => ({ ...chargeDefaults, ...x })),
  })

  const createLinks = prisma.bookingService.createMany.bind(prisma.bookingService)
  prisma.bookingService.createMany = (args) => createLinks({
    ...args,
    data: (Array.isArray(args.data) ? args.data : [args.data]).map((x) => ({
      ...x, service: services.find((s) => s.id === x.serviceId) ?? null,
    })),
  })

  const createPayment = prisma.payment.create.bind(prisma.payment)
  prisma.payment.create = (args) => {
    const b = prisma.booking.rows.find((x) => x.id === args.data.bookingId)
    return createPayment({
      ...args,
      data: {
        paidAt: new Date(), comment: null, refundOfId: null,
        voidedAt: null, voidedById: null, voidReason: null,
        admin: { id: args.data.adminId, name: args.data.adminName, username: 'admin' },
        voidedBy: null,
        booking: b ? { id: b.id, guestName: b.guestName, room: { id: b.roomId, number: String(b.roomId) } } : null,
        ...args.data,
      },
    })
  }

  const errorHandler = loadCjs('src/middleware/errorHandler.js', {
    stubs: { '../utils/logger': silentLogger },
  })
  const chargesUtil = loadCjs('src/utils/charges.js', { stubs: { './prisma': { prisma } } })
  const bookingMoney = loadCjs('src/utils/bookingMoney.js', { stubs: { './prisma': { prisma } } })

  const emitted = []
  const businessStub = {
    getCurrentBusinessDate: async () => businessDate,
    getCurrentShift: async () => ({ id: 1, date: businessDate }),
    ensureCurrentShift: async () => ({ id: 1, date: businessDate }),
  }

  const ctrl = loadCjs('src/controllers/bookingController.js', {
    stubs: {
      '../utils/prisma': { prisma },
      '../utils/charges': chargesUtil,
      '../middleware/errorHandler': errorHandler,
      '../socket/socketManager': { emitBookingEvent: (event, payload) => emitted.push({ event, payload }) },
      // Занятость номера — своя область со своими тестами (bookingAvailability):
      // здесь номер всегда свободен, иначе каждый денежный тест зависел бы от неё.
      '../utils/availability': { checkRoomsAvailability: async () => new Map() },
      '../utils/businessDate': businessStub,
    },
  })

  const payCtrl = loadCjs('src/controllers/paymentController.js', {
    stubs: {
      '../utils/prisma': { prisma },
      '../utils/bookingMoney': bookingMoney,
      '../middleware/errorHandler': errorHandler,
      '../socket/socketManager': { emitBookingEvent: (event, payload) => emitted.push({ event, payload }) },
      '../utils/logger': silentLogger,
      '../utils/businessDate': businessStub,
    },
  })

  return { ctrl, payCtrl, prisma, calls, emitted, charges: chargesUtil }
}

/** Мини-Express: контроллер отвечает либо через res, либо через next(err). */
export function run(handler, { body = {}, params = {}, query = {}, admin = { id: 1, name: 'Админ', role: 'ADMIN' } } = {}) {
  const out = { status: 200, body: null }
  const res = {
    status(code) { out.status = code; return res },
    json(payload) { out.body = payload; return res },
  }
  const next = (err) => {
    out.status = err.status || 500
    out.body = { error: err.message }
    // 500 здесь — всегда поломка фикстуры, а не поведение контроллера:
    // без стека видно только «expected 400, got 500».
    if (!err.status) out.body.stack = err.stack
  }
  return Promise.resolve(handler({ body, params, query, admin }, res, next)).then(() => out)
}

/** Строки начислений брони из фейковой базы, в порядке дата → id. */
export function chargesOf(prisma, bookingId) {
  return prisma.bookingCharge.rows
    .filter((c) => c.bookingId === bookingId)
    .sort((a, b) => {
      const ad = a.date ? a.date.getTime() : Infinity
      const bd = b.date ? b.date.getTime() : Infinity
      return ad === bd ? a.id - b.id : ad - bd
    })
}

export function totalOf(prisma, bookingId) {
  return chargesOf(prisma, bookingId).reduce((s, c) => s + c.amount, 0)
}
