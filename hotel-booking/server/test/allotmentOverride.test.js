import { describe, it, expect } from 'vitest'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'
import { createFakePrisma, d } from './helpers/fakePrisma.js'

/**
 * Волна 5b, пункт 6: квота партнёра — ПРЕДУПРЕЖДЕНИЕ при продаже, а не запрет.
 *
 * Решение (`docs/decisions/bookings.md`, 2026-09-08). До неё бронь в квотном
 * номере получала 409 при КАЖДОМ сохранении: продать поверх квоты один раз можно
 * было (`allowAllotmentOverride` в теле), но ответ администратора нигде не
 * хранился — и правка телефона у такой брони становилась невозможной, а сама
 * бронь нередактируемой (аудит D3-003, D7-005).
 *
 * Теперь ответ запоминается флагом `Booking.allotmentOverride`. Главная граница
 * здесь — К ЧЕМУ этот флаг относится: подтверждали продажу ЭТОГО номера на ЭТИ
 * даты, а не право игнорировать любые квоты. Сменился номер или даты — вопрос
 * задаётся заново. Ошибка в обе стороны одинаково плоха: слишком широкий флаг
 * тихо продаёт партнёрскую квоту, слишком узкий возвращает нередактируемую бронь.
 *
 * Проверка занятости берётся НАСТОЯЩАЯ (`utils/availability.js` + `utils/allotment.js`) —
 * иначе тест проверял бы заглушку вместо правила.
 */

const BUSINESS_DATE = d('2026-07-10')
const PARTNER = { id: 7, name: 'Тур-Оператор' }

const room = (id) => ({
  id, number: String(id), building: 'A', floor: 1, isActive: true,
  category: { id: 1, name: 'Стандарт', color: '#ccc' },
})

/** Поля, которых нет в `data` при create, но которые спрашивает BOOKING_SELECT. */
const CREATE_DEFAULTS = {
  partnerId: null, partner: null,
  accountBookingId: null, allotmentOverride: false,
  actualCheckInAt: null, actualCheckOutAt: null,
  guestCitizenship: null, guestDocType: null, guestDocNumber: null,
  guestDocExpiry: null, guestBirthDate: null, guestSex: null,
  room: room(101), createdBy: { id: 1, name: 'Админ' },
  createdAt: d('2026-06-01'), updatedAt: d('2026-06-01'),
}

function bookingRow(over = {}) {
  return {
    id: 1, roomId: 101, guestName: 'Иванов', guestPhone: null,
    checkIn: d('2026-07-08'), checkOut: d('2026-07-15'),
    status: 'CONFIRMED', source: null, notes: null,
    adultsWithMeals: 2, childrenWithMeals: 0, adultsNoMeals: 0, childrenNoMeals: 0,
    extraBedsWithMeals: 0, extraBedsNoMeals: 0, disabledAdults: 0, disabledChildren: 0,
    discountPercent: 0, prepaymentPercent: 50,
    totalAmount: 0, prepaidAmount: 0, paidAmount: 0,
    flags: [], shiftId: 1,
    ...CREATE_DEFAULTS,
    ...over,
  }
}

/** Квота партнёра на номер 102 весь июль. */
const QUOTA = {
  id: 1, roomId: 102, partnerId: 7,
  dateFrom: d('2026-07-01'), dateTo: d('2026-07-31'),
  partner: PARTNER, releases: [],
}

/**
 * Контроллер броней на настоящей проверке занятости. Деньги подменены пустышками:
 * их поведение проверяют денежные тесты, а здесь речь про «спросить один раз».
 */
function loadStack({ bookings = [], allotments = [QUOTA] } = {}) {
  const { prisma, calls } = createFakePrisma({
    booking: bookings,
    allotment: allotments,
    room: [room(101), room(102), room(103)],
    bookingFlag: [],
    bookingService: [],
    bookingCharge: [],
  })
  const prismaStub = { prisma }

  const flagEffects = loadCjs('src/utils/flagEffects.js', { stubs: { './prisma': prismaStub } })
  const allotment = loadCjs('src/utils/allotment.js', { stubs: { './prisma': prismaStub } })
  const availability = loadCjs('src/utils/availability.js', {
    stubs: { './prisma': prismaStub, './flagEffects': flagEffects, './allotment': allotment },
  })
  const errorHandler = loadCjs('src/middleware/errorHandler.js', {
    stubs: { '../utils/logger': silentLogger },
  })

  const ctrlPrisma = {
    ...prisma,
    booking: {
      ...prisma.booking,
      create: (args) => prisma.booking.create({ ...args, data: { ...CREATE_DEFAULTS, ...args.data } }),
    },
  }
  ctrlPrisma.$transaction = async (fn) => fn(ctrlPrisma)

  const emitted = []
  const ctrl = loadCjs('src/controllers/bookingController.js', {
    stubs: {
      '../utils/prisma': { prisma: ctrlPrisma },
      '../utils/availability': availability,
      '../middleware/errorHandler': errorHandler,
      '../socket/socketManager': { emitBookingEvent: (event, payload) => emitted.push({ event, payload }) },
      '../utils/businessDate': {
        ensureCurrentShift: async () => ({ id: 1 }),
        getCurrentBusinessDate: async () => BUSINESS_DATE,
      },
      '../utils/charges': {
        rebuildAutoCharges: async () => {},
        pinLegacyTotal: async () => null,
        rebuildChainCharges: async () => ({ created: 0, total: null }),
        recalcBookingTotals: async () => {},
        chargeInputsChanged: () => false,
        toUTCDate: (v) => v,
        replaceBookingServices: async () => {},
        defaultServiceLinks: async () => [],
        serviceLinksChanged: () => false,
        normalizeServiceLinks: (s) => s || [],
      },
    },
  })

  return { ctrl, prisma, calls, emitted }
}

function run(handler, { body = {}, params = {} } = {}) {
  const out = { status: 200, body: null }
  const res = {
    status(code) { out.status = code; return res },
    json(payload) { out.body = payload; return res },
  }
  const next = (err) => {
    out.status = err.status || 500
    out.body = { error: err.message }
    if (!err.status) out.body.stack = err.stack
  }
  return Promise.resolve(handler({ body, params, admin: { id: 1, name: 'Админ', role: 'ADMIN' } }, res, next)).then(() => out)
}

const create = (ctrl, body) => run(ctrl.create, { body })
const update = (ctrl, id, body) => run(ctrl.update, { body, params: { id: String(id) } })
const move = (ctrl, id, body) => run(ctrl.move, { body, params: { id: String(id) } })

const NEW_BOOKING = { guestName: 'Петров', checkIn: '2026-07-15', checkOut: '2026-07-18' }
const saved = (prisma, id) => prisma.booking.rows.find((b) => b.id === id)

// ─── Продажа поверх квоты ────────────────────────────────────────────────────

describe('продажа поверх квоты запоминается флагом', () => {
  it('без подтверждения — 409 с кодом, по которому форма покажет вопрос', async () => {
    const { ctrl } = loadStack()

    const res = await create(ctrl, { roomId: 102, ...NEW_BOOKING })

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('ALLOTMENT_CONFLICT')
    expect(res.body.error).toContain('Тур-Оператор')
  })

  it('с подтверждением бронь создаётся и флаг записан', async () => {
    const { ctrl, prisma } = loadStack()

    const res = await create(ctrl, { roomId: 102, ...NEW_BOOKING, allowAllotmentOverride: true })

    expect(res.status).toBe(201)
    expect(res.body.data.allotmentOverride).toBe(true)
    expect(saved(prisma, res.body.data.id).allotmentOverride).toBe(true)
  })

  it('обычная бронь флага не получает — вопрос ей не задавали', async () => {
    const { ctrl, prisma } = loadStack()

    const res = await create(ctrl, { roomId: 103, ...NEW_BOOKING })

    expect(res.status).toBe(201)
    expect(saved(prisma, res.body.data.id).allotmentOverride).toBe(false)
  })
})

// ─── Второй раз не спрашиваем ────────────────────────────────────────────────

describe('у брони с флагом вопрос заново не задаётся', () => {
  /** Бронь уже продана поверх квоты: номер 102, 8 → 15 июля. */
  const sold = () => loadStack({
    bookings: [bookingRow({ id: 1, roomId: 102, room: room(102), allotmentOverride: true })],
  })

  it('правка телефона проходит без 409', async () => {
    // Именно этого не было до волны 5b: бронь в квотном номере становилась
    // нередактируемой — любое сохранение упиралось в квоту.
    const { ctrl, prisma } = sold()

    const res = await update(ctrl, 1, { guestPhone: '+77010000000' })

    expect(res.status).toBe(200)
    expect(saved(prisma, 1).guestPhone).toBe('+77010000000')
    expect(saved(prisma, 1).allotmentOverride).toBe(true)
  })

  it('сохранение без изменений флаг не гасит', async () => {
    const { ctrl, prisma } = sold()

    await update(ctrl, 1, { guestName: 'Иванов И.' })

    expect(saved(prisma, 1).allotmentOverride).toBe(true)
  })

  it('смена ДАТ спрашивает заново: подтверждали эти даты, а не любые', async () => {
    // Границa флага. Продлить бронь на неделю вглубь партнёрской квоты «заодно»
    // с прежним подтверждением нельзя — это уже другая продажа.
    const { ctrl, prisma } = sold()

    const res = await update(ctrl, 1, { checkIn: '2026-07-08', checkOut: '2026-07-25' })

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('ALLOTMENT_CONFLICT')
    // Отказ ничего не переписал: старые даты на месте
    expect(saved(prisma, 1).checkOut.toISOString().slice(0, 10)).toBe('2026-07-15')
  })

  it('смена дат с новым подтверждением проходит, флаг остаётся', async () => {
    const { ctrl, prisma } = sold()

    const res = await update(ctrl, 1, {
      checkIn: '2026-07-08', checkOut: '2026-07-25', allowAllotmentOverride: true,
    })

    expect(res.status).toBe(200)
    expect(saved(prisma, 1).allotmentOverride).toBe(true)
  })

  it('переезд в свободный номер ГАСИТ флаг: он относился к квотному номеру', async () => {
    // Иначе бронь унесла бы с собой право въезжать в любую квоту навсегда.
    const { ctrl, prisma } = sold()

    const res = await update(ctrl, 1, { roomId: 103 })

    expect(res.status).toBe(200)
    expect(saved(prisma, 1).allotmentOverride).toBe(false)
  })

  it('без флага бронь в квотном номере по-прежнему получает 409 на каждой правке', async () => {
    // Контроль: 200 выше приходит от ФЛАГА, а не оттого, что квота перестала
    // проверяться при `update` вовсе.
    const { ctrl } = loadStack({
      bookings: [bookingRow({ id: 1, roomId: 102, room: room(102), allotmentOverride: false })],
    })

    const res = await update(ctrl, 1, { guestPhone: '+77010000000' })

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('ALLOTMENT_CONFLICT')
  })
})

// ─── Переезд поверх квоты ────────────────────────────────────────────────────

describe('переезд в квотный номер', () => {
  /** Заселённый гость, 8 → 15 июля в 101; рабочая дата 10-е — переезд сегодня. */
  const livingGuest = () => loadStack({
    bookings: [bookingRow({ id: 1, roomId: 101, room: room(101), status: 'CHECKED_IN' })],
  })

  it('без подтверждения переезд отклоняется', async () => {
    const { ctrl } = livingGuest()

    const res = await move(ctrl, 1, { newRoomId: 102, moveDate: '2026-07-10' })

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('ALLOTMENT_CONFLICT')
    expect(res.body.error).toContain('Тур-Оператор')
  })

  it('с подтверждением создаётся продолжение, и флаг стоит НА НЁМ', async () => {
    // Подтверждение относится к новому номеру: у головы оно ни при чём, она
    // осталась в своей комнате.
    const { ctrl, prisma } = livingGuest()

    const res = await move(ctrl, 1, {
      newRoomId: 102, moveDate: '2026-07-10', allowAllotmentOverride: true,
    })

    expect(res.status).toBe(200)
    const cont = res.body.data.created
    expect(cont).toMatchObject({ roomId: 102, accountBookingId: 1, allotmentOverride: true })
    expect(saved(prisma, 1).allotmentOverride).toBe(false)
  })

  it('переезд «день в день» без сплита тоже запоминает подтверждение', async () => {
    // Здесь второй записи не появляется — флаг обязан лечь на саму бронь,
    // иначе следующая же правка снова упрётся в квоту.
    const { ctrl, prisma } = loadStack({
      bookings: [bookingRow({ id: 1, roomId: 101, room: room(101), status: 'CHECKED_IN', checkIn: d('2026-07-10') })],
    })

    const res = await move(ctrl, 1, {
      newRoomId: 102, moveDate: '2026-07-10', allowAllotmentOverride: true,
    })

    expect(res.status).toBe(200)
    expect(res.body.data.created).toBeNull()
    expect(saved(prisma, 1)).toMatchObject({ roomId: 102, allotmentOverride: true })
  })

  it('переезд в свободный номер флага не ставит', async () => {
    const { ctrl } = livingGuest()

    const res = await move(ctrl, 1, { newRoomId: 103, moveDate: '2026-07-10' })

    expect(res.status).toBe(200)
    expect(res.body.data.created.allotmentOverride).toBe(false)
  })
})
