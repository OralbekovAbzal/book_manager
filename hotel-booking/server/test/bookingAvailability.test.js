import { describe, it, expect } from 'vitest'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'
import { createFakePrisma, d } from './helpers/fakePrisma.js'

/**
 * Главное свойство после волны 3: «свободен ли номер» считается ОДИН раз.
 *
 * Подбор (`utils/availability.js`) и сохранение (`bookingController`) обязаны
 * отвечать одинаково. Раньше это были две копии одного правила: подбор красил
 * номер зелёным, а create отвечал 409 про буфер метки или квоту партнёра.
 * Поэтому тесты здесь всегда парные: спрашиваем утилиту и тут же — контроллер.
 *
 * Словарь меток повторяет живой (`BookingFlag` в базе на 2026-09-04):
 *   late_checkout  «выезд после 17:00» — зазор нужен всегда;
 *   early_checkout «выезд до 17:00»    — зазор снимается меткой late_checkin у соседа;
 *   late_checkin   «заезд после 17:00» — сама буфера не даёт, служит исключением.
 */

const BUSINESS_DATE = d('2026-07-10')

const FLAG_DICT = [
  { code: 'late_checkout', effects: { bufferAfter: 1 } },
  { code: 'early_checkout', effects: { bufferAfter: 1, bufferAfterExceptFlag: 'late_checkin' } },
  { code: 'late_checkin', effects: null },
]

const PARTNER = { id: 7, name: 'Тур-Оператор' }

function room(id) {
  return {
    id,
    number: String(id),
    building: 'A',
    floor: 1,
    isActive: true,
    category: { id: 1, name: 'Стандарт', color: '#ccc' },
  }
}

/**
 * Поля, которых нет в data при create (связи и то, что проставляет сама база):
 * BOOKING_SELECT их спрашивает, а фейковая Prisma честно падает на поле, которого
 * в записи нет. Связи здесь — заглушки: фейк их не разрешает, тесты по ним не судят.
 */
const CREATE_DEFAULTS = {
  partnerId: null,
  partner: null,
  room: room(101),
  createdBy: { id: 1, name: 'Админ' },
  createdAt: d('2026-06-01'),
  updatedAt: d('2026-06-01'),
}

function bookingRow(over = {}) {
  return {
    id: 1,
    roomId: 101,
    guestName: 'Иванов',
    guestPhone: null,
    checkIn: d('2026-07-10'),
    checkOut: d('2026-07-15'),
    status: 'CONFIRMED',
    source: null,
    notes: null,
    adultsWithMeals: 2,
    childrenWithMeals: 0,
    adultsNoMeals: 0,
    childrenNoMeals: 0,
    extraBedsWithMeals: 0,
    extraBedsNoMeals: 0,
    disabledAdults: 0,
    disabledChildren: 0,
    discountPercent: 0,
    prepaymentPercent: 50,
    totalAmount: 0,
    prepaidAmount: 0,
    paidAmount: 0,
    flags: [],
    partnerId: null,
    shiftId: 1,
    ...CREATE_DEFAULTS,
    ...over,
  }
}

function allotmentRow(over = {}) {
  return {
    id: 1,
    roomId: 102,
    partnerId: 7,
    dateFrom: d('2026-07-01'),
    dateTo: d('2026-07-31'),
    partner: PARTNER,
    releases: [],
    ...over,
  }
}

/**
 * Собирает связку «утилита + контроллер» на одной и той же фейковой базе.
 * Утилита загружается своим экземпляром с подменённым prisma, и ЭТОТ ЖЕ экземпляр
 * отдаётся контроллеру — иначе контроллер утянул бы настоящий Prisma-клиент.
 */
function loadStack({ bookings = [], allotments = [], rooms } = {}) {
  const { prisma, calls } = createFakePrisma({
    booking: bookings,
    allotment: allotments,
    room: rooms ?? [room(101), room(102), room(103), room(104)],
    bookingFlag: FLAG_DICT,
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
  // Транзакция отдаёт callback'у тот же клиент: проверяем, что проверка доступности
  // попала ВНУТРЬ неё, а не то, как Postgres откатывает.
  ctrlPrisma.$transaction = async (fn) => {
    calls.push({ model: '$transaction', op: 'callback' })
    return fn(ctrlPrisma)
  }

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

  return { ctrl, availability, prisma, calls, emitted }
}

/** Мини-Express: контроллер отвечает либо через res, либо через next(err). */
function run(handler, { body = {}, params = {} } = {}) {
  const res = { status: 200, body: null }
  const fakeRes = {
    status(code) { res.status = code; return fakeRes },
    json(payload) { res.body = payload; return fakeRes },
  }
  const next = (err) => {
    res.status = err.status || 500
    res.body = { error: err.message }
    // 500 в этих тестах — всегда поломка самого теста (фикстуры), а не поведение
    // контроллера: показываем причину, иначе видно только «expected 201, got 500».
    if (!err.status) res.body.stack = err.stack
  }
  return handler({ body, params, admin: { id: 1 } }, fakeRes, next).then(() => res)
}

const create = (ctrl, body) => run(ctrl.create, { body })
const update = (ctrl, id, body) => run(ctrl.update, { body, params: { id: String(id) } })
const move = (ctrl, id, body) => run(ctrl.move, { body, params: { id: String(id) } })
const check = (ctrl, body) => run(ctrl.checkAvailability, { body })

/** Что утилита думает про один номер. */
async function ask(availability, params) {
  const map = await availability.checkRoomsAvailability({ roomIds: [params.roomId], ...params })
  return map.get(params.roomId)
}

const NEW_BOOKING = {
  guestName: 'Петров',
  checkIn: '2026-07-15',
  checkOut: '2026-07-18',
}

// ─────────────────────────────────────────────────────────────────────────────

describe('подбор и сохранение отвечают одинаково', () => {
  /**
   * Одна и та же расстановка для всех трёх причин:
   *   101 — сосед с «выезд после 17:00» до 15 июля → нужен зазор (буфер);
   *   102 — квота партнёра на весь июль;
   *   103 — пересечение;
   *   104 — свободен.
   */
  function scene() {
    return loadStack({
      bookings: [
        bookingRow({ id: 1, roomId: 101, flags: ['late_checkout'] }),
        bookingRow({ id: 2, roomId: 103, guestName: 'Сидоров', checkIn: d('2026-07-14'), checkOut: d('2026-07-20') }),
      ],
      allotments: [allotmentRow({ roomId: 102 })],
    })
  }

  it('буфер метки: утилита говорит «занято», create отвечает 409 — и текст тот же', async () => {
    const { ctrl, availability } = scene()

    const hit = await ask(availability, { roomId: 101, ...NEW_BOOKING })
    expect(hit.available).toBe(false)
    expect(hit.reason).toBe('buffer')

    const res = await create(ctrl, { roomId: 101, ...NEW_BOOKING })
    expect(res.status).toBe(409)
    // Контроллер добавляет к причине только совет «что делать»
    expect(res.body.error).toBe(`${hit.message}. Выберите другие даты или номер.`)
    expect(res.body.error).toContain('Нужен зазор минимум 1 дн.')
  })

  it('квота партнёра: утилита говорит «занято», create отвечает 409 с кодом квоты', async () => {
    const { ctrl, availability } = scene()

    const hit = await ask(availability, { roomId: 102, ...NEW_BOOKING })
    expect(hit.reason).toBe('allotment')

    const res = await create(ctrl, { roomId: 102, ...NEW_BOOKING })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('ALLOTMENT_CONFLICT')
    expect(res.body.error).toBe(hit.message)
  })

  it('пересечение: 409 с объектом conflict в прежней форме', async () => {
    const { ctrl, availability } = scene()

    const hit = await ask(availability, { roomId: 103, ...NEW_BOOKING })
    expect(hit.reason).toBe('overlap')

    const res = await create(ctrl, { roomId: 103, ...NEW_BOOKING })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('Номер занят на выбранные даты')
    expect(res.body.conflict).toEqual({
      bookingId: 2,
      guestName: 'Сидоров',
      checkIn: d('2026-07-14'),
      checkOut: d('2026-07-20'),
    })
  })

  it('и наоборот: номер, который утилита считает свободным, сохраняется', async () => {
    const { ctrl, availability, prisma } = scene()

    const hit = await ask(availability, { roomId: 104, ...NEW_BOOKING })
    expect(hit.available).toBe(true)

    const res = await create(ctrl, { roomId: 104, ...NEW_BOOKING })
    expect(res.status).toBe(201)
    expect(res.body.data.guestName).toBe('Петров')
    expect(prisma.booking.rows.some((b) => b.roomId === 104 && b.guestName === 'Петров')).toBe(true)
  })

  it('исключение метки работает одинаково у утилиты и у create', async () => {
    // Сосед «выезд до 17:00» — его зазор снимается меткой «заезд после 17:00»
    const { ctrl, availability } = loadStack({
      bookings: [bookingRow({ id: 1, roomId: 101, flags: ['early_checkout'] })],
    })
    const params = { roomId: 101, ...NEW_BOOKING }

    expect((await ask(availability, params)).reason).toBe('buffer')
    expect((await create(ctrl, params)).status).toBe(409)

    const withFlag = { ...params, flags: ['late_checkin'] }
    expect((await ask(availability, withFlag)).available).toBe(true)
    expect((await create(ctrl, withFlag)).status).toBe(201)
  })
})

describe('allowAllotmentOverride снимает только квоту', () => {
  it('квоту — снимает, бронь сохраняется', async () => {
    const { ctrl } = loadStack({ allotments: [allotmentRow({ roomId: 102 })] })
    const res = await create(ctrl, { roomId: 102, ...NEW_BOOKING, allowAllotmentOverride: true })
    expect(res.status).toBe(201)
  })

  it('бронь партнёра в СВОЮ квоту конфликтом не считается и без подтверждения', async () => {
    const { ctrl } = loadStack({ allotments: [allotmentRow({ roomId: 102 })] })
    const res = await create(ctrl, { roomId: 102, ...NEW_BOOKING, partnerId: 7 })
    expect(res.status).toBe(201)
  })

  it('пересечение подтверждением НЕ снимается', async () => {
    const { ctrl } = loadStack({
      bookings: [bookingRow({ id: 2, roomId: 103, checkIn: d('2026-07-14'), checkOut: d('2026-07-20') })],
    })
    const res = await create(ctrl, { roomId: 103, ...NEW_BOOKING, allowAllotmentOverride: true })
    expect(res.status).toBe(409)
    expect(res.body.code).toBeUndefined()
  })

  it('буфер подтверждением НЕ снимается', async () => {
    const { ctrl } = loadStack({ bookings: [bookingRow({ id: 1, roomId: 101, flags: ['late_checkout'] })] })
    const res = await create(ctrl, { roomId: 101, ...NEW_BOOKING, allowAllotmentOverride: true })
    expect(res.status).toBe(409)
    expect(res.body.error).toContain('зазор')
  })
})

describe('PUT /bookings/:id — те же правила', () => {
  it('сама бронь себе не мешает: сохранение без изменения дат проходит', async () => {
    const { ctrl } = loadStack({ bookings: [bookingRow({ id: 1, roomId: 101 })] })
    const res = await update(ctrl, 1, { guestName: 'Иванов И.' })
    expect(res.status).toBe(200)
    expect(res.body.data.guestName).toBe('Иванов И.')
  })

  it('перенос в номер с буфером соседа — 409, как при создании', async () => {
    const { ctrl, availability } = loadStack({
      bookings: [
        bookingRow({ id: 1, roomId: 104, checkIn: d('2026-07-15'), checkOut: d('2026-07-18') }),
        bookingRow({ id: 2, roomId: 101, guestName: 'Сосед', flags: ['late_checkout'] }),
      ],
    })
    const hit = await ask(availability, {
      roomId: 101, checkIn: '2026-07-15', checkOut: '2026-07-18', excludeBookingId: 1,
    })
    expect(hit.reason).toBe('buffer')

    const res = await update(ctrl, 1, { roomId: 101 })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe(`${hit.message}. Выберите другие даты или номер.`)
  })

  it('перенос в номер под квотой — 409 с кодом, подтверждение его снимает', async () => {
    const scene = () => loadStack({
      bookings: [bookingRow({ id: 1, roomId: 104, checkIn: d('2026-07-15'), checkOut: d('2026-07-18') })],
      allotments: [allotmentRow({ roomId: 102 })],
    })
    expect((await update(scene().ctrl, 1, { roomId: 102 })).body.code).toBe('ALLOTMENT_CONFLICT')
    expect((await update(scene().ctrl, 1, { roomId: 102, allowAllotmentOverride: true })).status).toBe(200)
  })
})

describe('POST /bookings/check-availability — отвечает то же, что сохранение', () => {
  it('буфер: available=false с причиной и текстом (раньше отвечал «свободно»)', async () => {
    const { ctrl } = loadStack({ bookings: [bookingRow({ id: 1, roomId: 101, flags: ['late_checkout'] })] })
    const res = await check(ctrl, { roomId: 101, checkIn: '2026-07-15', checkOut: '2026-07-18' })
    expect(res.body.available).toBe(false)
    expect(res.body.reason).toBe('buffer')
    expect(res.body.message).toContain('Нужен зазор')
    // conflict у буфера пустой: непустой заблокировал бы кнопку «Сохранить» в форме,
    // а без меток будущей брони буфер может сработать ложно
    expect(res.body.conflict).toBeNull()
  })

  it('квота: available=false, но conflict пустой — продажу поверх квоты подтверждают при сохранении', async () => {
    const { ctrl } = loadStack({ allotments: [allotmentRow({ roomId: 102 })] })
    const res = await check(ctrl, { roomId: 102, checkIn: '2026-07-15', checkOut: '2026-07-18' })
    expect(res.body.available).toBe(false)
    expect(res.body.reason).toBe('allotment')
    expect(res.body.conflict).toBeNull()
  })

  it('пересечение: форма ответа прежняя — conflict с id, именем и датами', async () => {
    const { ctrl } = loadStack({
      bookings: [bookingRow({ id: 2, roomId: 103, guestName: 'Сидоров', checkIn: d('2026-07-14'), checkOut: d('2026-07-20') })],
    })
    const res = await check(ctrl, { roomId: 103, checkIn: '2026-07-15', checkOut: '2026-07-18' })
    expect(res.body.available).toBe(false)
    expect(res.body.reason).toBe('overlap')
    expect(res.body.conflict.id).toBe(2)
    expect(res.body.conflict.guestName).toBe('Сидоров')
  })

  it('свободный номер: available=true, причины нет', async () => {
    const { ctrl } = loadStack()
    const res = await check(ctrl, { roomId: 104, checkIn: '2026-07-15', checkOut: '2026-07-18' })
    expect(res.body).toEqual({ available: true, conflict: null, reason: null, message: null })
  })

  it('метки будущей брони учитываются — исключение снимает буфер соседа', async () => {
    const { ctrl } = loadStack({ bookings: [bookingRow({ id: 1, roomId: 101, flags: ['early_checkout'] })] })
    const base = { roomId: 101, checkIn: '2026-07-15', checkOut: '2026-07-18' }
    expect((await check(ctrl, base)).body.available).toBe(false)
    expect((await check(ctrl, { ...base, flags: ['late_checkin'] })).body.available).toBe(true)
  })

  it('выезд не позже заезда — отвечает 200 с причиной, а не падает', async () => {
    const { ctrl } = loadStack()
    const res = await check(ctrl, { roomId: 104, checkIn: '2026-07-15', checkOut: '2026-07-15' })
    expect(res.status).toBe(200)
    expect(res.body.available).toBe(false)
    expect(res.body.reason).toBe('range')
  })
})

describe('POST /bookings/:id/move — те же правила в обеих ветках', () => {
  /** Заехавший гость в 101, переезд «день-в-день» 10 июля. */
  const guest = () => bookingRow({
    id: 1, roomId: 101, guestName: 'Гость', status: 'CHECKED_IN',
    checkIn: d('2026-07-10'), checkOut: d('2026-07-14'),
  })

  /**
   * Тот же гость, но заехал раньше рабочего дня: переезд 10 июля выпадает на
   * середину срока и идёт сплитом. «Завтрашним» числом переезд не оформить —
   * гость переезжает не позже текущей смены.
   */
  const guestMidStay = () => bookingRow({
    id: 1, roomId: 101, guestName: 'Гость', status: 'CHECKED_IN',
    checkIn: d('2026-07-08'), checkOut: d('2026-07-14'),
  })

  it('день-в-день: свободный номер — переезд проходит', async () => {
    const { ctrl, prisma } = loadStack({ bookings: [guest()] })
    const res = await move(ctrl, 1, { newRoomId: 104, moveDate: '2026-07-10' })
    expect(res.status).toBe(200)
    expect(res.body.data.created).toBeNull()
    expect(prisma.booking.rows.find((b) => b.id === 1).roomId).toBe(104)
  })

  it('день-в-день: пересечение — прежний текст «Целевой номер занят (имя)»', async () => {
    const { ctrl } = loadStack({
      bookings: [guest(), bookingRow({ id: 2, roomId: 104, guestName: 'Сидоров', checkIn: d('2026-07-12'), checkOut: d('2026-07-20') })],
    })
    const res = await move(ctrl, 1, { newRoomId: 104, moveDate: '2026-07-10' })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('Целевой номер занят (Сидоров)')
  })

  it('день-в-день: УЖЕСТОЧЕНИЕ — теперь ловится и буфер метки соседа', async () => {
    const { ctrl } = loadStack({
      bookings: [
        guest(),
        bookingRow({ id: 2, roomId: 104, guestName: 'Сосед', checkIn: d('2026-07-05'), checkOut: d('2026-07-10'), flags: ['late_checkout'] }),
      ],
    })
    const res = await move(ctrl, 1, { newRoomId: 104, moveDate: '2026-07-10' })
    expect(res.status).toBe(409)
    expect(res.body.error).toContain('Нужен зазор')
  })

  it('день-в-день: УЖЕСТОЧЕНИЕ — теперь ловится и квота партнёра', async () => {
    const { ctrl } = loadStack({
      bookings: [guest()],
      allotments: [allotmentRow({ roomId: 104 })],
    })
    const res = await move(ctrl, 1, { newRoomId: 104, moveDate: '2026-07-10' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('ALLOTMENT_CONFLICT')
  })

  it('день-в-день: проверка идёт ВНУТРИ транзакции, до записи', async () => {
    const { ctrl, calls } = loadStack({ bookings: [guest()] })
    await move(ctrl, 1, { newRoomId: 104, moveDate: '2026-07-10' })

    const tx = calls.findIndex((c) => c.model === '$transaction')
    const read = calls.findIndex((c, i) => i > tx && c.model === 'booking' && c.op === 'findMany')
    const write = calls.findIndex((c) => c.model === 'booking' && c.op === 'update')
    expect(tx).toBeGreaterThanOrEqual(0)
    expect(read).toBeGreaterThan(tx)
    expect(write).toBeGreaterThan(read)
  })

  it('сплит: буфер целевого номера тоже проверяется, запись не начинается', async () => {
    const { ctrl, prisma } = loadStack({
      bookings: [
        guestMidStay(),
        bookingRow({ id: 2, roomId: 104, guestName: 'Сосед', checkIn: d('2026-07-05'), checkOut: d('2026-07-10'), flags: ['late_checkout'] }),
      ],
    })
    const res = await move(ctrl, 1, { newRoomId: 104, moveDate: '2026-07-10' })
    expect(res.status).toBe(409)
    expect(res.body.error).toContain('Нужен зазор')
    // Исходная бронь осталась нетронутой: отказ вернулся до записи
    const original = prisma.booking.rows.find((b) => b.id === 1)
    expect(original.status).toBe('CHECKED_IN')
    expect(original.checkOut).toEqual(d('2026-07-14'))
  })

  it('сплит: свободный номер — бронь делится, вторая часть создаётся', async () => {
    const { ctrl, prisma } = loadStack({ bookings: [guestMidStay()] })
    const res = await move(ctrl, 1, { newRoomId: 104, moveDate: '2026-07-10' })
    expect(res.status).toBe(200)
    expect(res.body.data.created.roomId).toBe(104)
    expect(prisma.booking.rows.find((b) => b.id === 1).checkOut).toEqual(d('2026-07-10'))
  })

  it('сплит: проверка идёт ВНУТРИ транзакции, до записи', async () => {
    const { ctrl, calls } = loadStack({ bookings: [guestMidStay()] })
    await move(ctrl, 1, { newRoomId: 104, moveDate: '2026-07-10' })

    const tx = calls.findIndex((c) => c.model === '$transaction')
    const read = calls.findIndex((c, i) => i > tx && c.model === 'booking' && c.op === 'findMany')
    const write = calls.findIndex((c) => c.model === 'booking' && c.op === 'update')
    expect(read).toBeGreaterThan(tx)
    expect(write).toBeGreaterThan(read)
  })
})
