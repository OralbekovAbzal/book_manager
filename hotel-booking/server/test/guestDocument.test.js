import { describe, it, expect } from 'vitest'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'
import { createFakePrisma, d } from './helpers/fakePrisma.js'

/**
 * Документ гостя в брони: гражданство, тип и номер документа, срок действия,
 * дата рождения, пол.
 *
 * Зачем эти поля вообще есть: без них программа — доска броней, а не журнал
 * регистрации, и на вопрос «кто жил в 12-м номере 3 июля» ответить нечем.
 * Отсюда же и главные риски, в которые бьют тесты:
 *
 *   1. документ ДОЗАПОЛНЯЮТ позже — бронь заводят по телефону, паспорт приносят
 *      на стойку. Значит частичный PUT из любого другого экрана (сдвиг дат из
 *      шахматки, правка заметки) не имеет права его обнулить;
 *   2. при переезде гость остаётся тем же человеком — вторая часть брони без
 *      паспорта означала бы дыру в журнале ровно с того дня;
 *   3. в снимке восстановление идёт по БЕЛОМУ списку колонок — забытая колонка
 *      теряется молча (см. snapshot.test.js, там же и проверка);
 *   4. подстановка из прошлого визита обязана находить гостя, чей номер записан
 *      в другом формате: «+7 701…» и «8701…» — один человек.
 */

const BUSINESS_DATE = d('2026-07-10')

const PASSPORT = {
  guestCitizenship: 'Казахстан',
  guestDocType: 'id_card',
  guestDocNumber: '990514300123',
  guestDocExpiry: '2030-05-14',
  guestBirthDate: '1999-05-14',
  guestSex: 'f',
}

const DOC_FIELDS = Object.keys(PASSPORT)

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
 * Поля, которых нет в `data` при create: связи и то, что проставляет база.
 * BOOKING_SELECT их спрашивает, а фейковая Prisma честно падает на поле,
 * которого в записи нет — это и ловит забытое поле в выборке.
 */
const CREATE_DEFAULTS = {
  partnerId: null,
  partner: null,
  // Волна 5b: счёт цепочки и «продана поверх квоты». Продолжение переезда — тот же
  // гость с тем же документом, поэтому поля живут рядом с паспортными.
  // `account`/`continuations` вычисляет `fakePrisma` по `accountBookingId`.
  accountBookingId: null,
  allotmentOverride: false,
  actualCheckInAt: null,
  actualCheckOutAt: null,
  room: room(101),
  createdBy: { id: 1, name: 'Админ' },
  createdAt: d('2026-06-01'),
  updatedAt: d('2026-06-01'),
}

function bookingRow(over = {}) {
  return {
    id: 1,
    roomId: 101,
    guestName: 'Асель',
    guestPhone: '+7 701 234 56 78',
    checkIn: d('2026-07-08'),
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
    totalAmount: 70000,
    prepaidAmount: 35000,
    paidAmount: 35000,
    flags: [],
    shiftId: 1,
    adminId: 1,
    guestCitizenship: null,
    guestDocType: null,
    guestDocNumber: null,
    guestDocExpiry: null,
    guestBirthDate: null,
    guestSex: null,
    ...CREATE_DEFAULTS,
    ...over,
  }
}

/**
 * Контроллер броней на фейковой базе. «Свободен ли номер» здесь не проверяем —
 * за это отвечает bookingAvailability.test.js; подменяем утилиту целиком, чтобы
 * тесты про паспорт падали только из-за паспорта.
 */
function loadBookingCtrl({ bookings = [] } = {}) {
  const { prisma } = createFakePrisma({
    booking: bookings,
    room: [room(101), room(102)],
    bookingService: [],
    bookingCharge: [],
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
      '../utils/availability': {
        checkRoomsAvailability: async ({ roomIds }) =>
          new Map(roomIds.map(id => [parseInt(id), { available: true }])),
      },
      '../middleware/errorHandler': errorHandler,
      '../socket/socketManager': { emitBookingEvent: (event, payload) => emitted.push({ event, payload }) },
      '../utils/businessDate': {
        ensureCurrentShift: async () => ({ id: 1 }),
        getCurrentBusinessDate: async () => BUSINESS_DATE,
      },
      '../utils/charges': {
        rebuildAutoCharges: async () => {},
        // Волна 5b: переезд фиксирует прежний итог и пересобирает счёт цепочки.
        // Здесь проверяются поля документа гостя, а не деньги — обе пустые.
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

  return { ctrl, prisma, emitted }
}

/** Мини-Express: контроллер отвечает либо через res, либо через next(err). */
function run(handler, { body = {}, params = {}, query = {}, role = 'ADMIN' } = {}) {
  const res = { status: 200, body: null }
  const fakeRes = {
    status(code) { res.status = code; return fakeRes },
    json(payload) { res.body = payload; return fakeRes },
  }
  const next = (err) => {
    res.status = err.status || 500
    res.body = { error: err.message }
    if (!err.status) res.body.stack = err.stack
  }
  return handler({ body, params, query, admin: { id: 1, role } }, fakeRes, next).then(() => res)
}

const create = (ctrl, body) => run(ctrl.create, { body })
const update = (ctrl, id, body) => run(ctrl.update, { body, params: { id: String(id) } })
const move = (ctrl, id, body) => run(ctrl.move, { body, params: { id: String(id) } })

const NEW_BOOKING = {
  roomId: 101,
  guestName: 'Асель',
  guestPhone: '+7 701 234 56 78',
  checkIn: '2026-07-15',
  checkOut: '2026-07-18',
}

/** '2030-05-14' в том виде, в каком его хранит @db.Date (UTC-полночь). */
const asDate = (iso) => d(iso)

// ─── Создание ─────────────────────────────────────────────────────────────────

describe('POST /bookings — документ гостя', () => {
  it('записывается вместе с бронью и возвращается в ответе', async () => {
    const { ctrl, prisma } = loadBookingCtrl()

    const res = await create(ctrl, { ...NEW_BOOKING, ...PASSPORT })

    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({
      guestCitizenship: 'Казахстан',
      guestDocType: 'id_card',
      guestDocNumber: '990514300123',
      guestSex: 'f',
    })
    // Даты документа — @db.Date: в базу обязаны уйти Date, а не строка «2030-05-14»
    const saved = prisma.booking.rows.at(-1)
    expect(saved.guestDocExpiry).toEqual(asDate('2030-05-14'))
    expect(saved.guestBirthDate).toEqual(asDate('1999-05-14'))
  })

  it('без документа бронь заводится как раньше — поля просто пустые', async () => {
    const { ctrl, prisma } = loadBookingCtrl()

    const res = await create(ctrl, NEW_BOOKING)

    expect(res.status).toBe(201)
    const saved = prisma.booking.rows.at(-1)
    for (const f of DOC_FIELDS) expect(saved[f]).toBeNull()
  })

  it('пустые строки из формы кладутся как null, а не как «»', async () => {
    const { ctrl, prisma } = loadBookingCtrl()

    // Так выглядит очищенная форма: выбор «не указано» и пустые поля ввода
    await create(ctrl, { ...NEW_BOOKING, guestCitizenship: '  ', guestDocType: '', guestDocNumber: '' })

    const saved = prisma.booking.rows.at(-1)
    expect(saved.guestCitizenship).toBeNull()
    expect(saved.guestDocType).toBeNull()
    expect(saved.guestDocNumber).toBeNull()
  })
})

// ─── Правка ───────────────────────────────────────────────────────────────────

describe('PUT /bookings/:id — документ гостя', () => {
  it('дозаполняется при заселении: бронь завели по телефону, паспорт принесли', async () => {
    const { ctrl, prisma } = loadBookingCtrl({ bookings: [bookingRow({ id: 1 })] })

    const res = await update(ctrl, 1, PASSPORT)

    expect(res.status).toBe(200)
    expect(res.body.data.guestDocNumber).toBe('990514300123')
    expect(prisma.booking.rows[0].guestDocExpiry).toEqual(asDate('2030-05-14'))
  })

  it('ЧАСТИЧНЫЙ PUT без полей документа его НЕ обнуляет', async () => {
    // Главный сценарий потери данных: бронь сохраняют из другого экрана (сдвиг дат
    // в шахматке, правка заметки) — там полей паспорта в форме нет вовсе.
    const { ctrl, prisma } = loadBookingCtrl({
      bookings: [bookingRow({
        id: 1,
        ...PASSPORT,
        guestDocExpiry: asDate('2030-05-14'),
        guestBirthDate: asDate('1999-05-14'),
      })],
    })

    const res = await update(ctrl, 1, { notes: 'Просил поздний выезд' })

    expect(res.status).toBe(200)
    expect(prisma.booking.rows[0]).toMatchObject({
      guestCitizenship: 'Казахстан',
      guestDocType: 'id_card',
      guestDocNumber: '990514300123',
      guestSex: 'f',
    })
    expect(prisma.booking.rows[0].guestDocExpiry).toEqual(asDate('2030-05-14'))
    expect(res.body.data.guestDocNumber).toBe('990514300123')
  })

  it('явный null стирает поле — ошибку ввода надо чем-то исправлять', async () => {
    const { ctrl, prisma } = loadBookingCtrl({
      bookings: [bookingRow({ id: 1, ...PASSPORT, guestDocExpiry: asDate('2030-05-14'), guestBirthDate: asDate('1999-05-14') })],
    })

    await update(ctrl, 1, { guestDocNumber: null, guestDocExpiry: null })

    expect(prisma.booking.rows[0].guestDocNumber).toBeNull()
    expect(prisma.booking.rows[0].guestDocExpiry).toBeNull()
    // Соседние поля при этом на месте — стирали одно, а не «документ целиком»
    expect(prisma.booking.rows[0].guestCitizenship).toBe('Казахстан')
  })

  it('пустая строка стирает поле так же, как null (очищенный input)', async () => {
    const { ctrl, prisma } = loadBookingCtrl({
      bookings: [bookingRow({ id: 1, ...PASSPORT, guestDocExpiry: asDate('2030-05-14'), guestBirthDate: asDate('1999-05-14') })],
    })

    await update(ctrl, 1, { guestCitizenship: '', guestBirthDate: '' })

    expect(prisma.booking.rows[0].guestCitizenship).toBeNull()
    expect(prisma.booking.rows[0].guestBirthDate).toBeNull()
  })

  it('заполнить документ может и STAFF — это работа стойки', async () => {
    const { ctrl, prisma } = loadBookingCtrl({ bookings: [bookingRow({ id: 1 })] })

    const res = await run(ctrl.update, {
      body: PASSPORT, params: { id: '1' }, role: 'STAFF',
    })

    expect(res.status).toBe(200)
    expect(prisma.booking.rows[0].guestDocNumber).toBe('990514300123')
  })
})

// ─── Переезд ──────────────────────────────────────────────────────────────────

describe('POST /bookings/:id/move — документ едет вместе с гостем', () => {
  it('сплит: у второй части те же документы', async () => {
    const { ctrl, prisma } = loadBookingCtrl({
      bookings: [bookingRow({
        id: 1,
        status: 'CHECKED_IN',
        ...PASSPORT,
        guestDocExpiry: asDate('2030-05-14'),
        guestBirthDate: asDate('1999-05-14'),
      })],
    })

    const res = await move(ctrl, 1, { newRoomId: 102, moveDate: '2026-07-10' })

    expect(res.status).toBe(200)
    const created = prisma.booking.rows.at(-1)
    expect(created.roomId).toBe(102)
    expect(created).toMatchObject({
      guestCitizenship: 'Казахстан',
      guestDocType: 'id_card',
      guestDocNumber: '990514300123',
      guestSex: 'f',
    })
    expect(created.guestDocExpiry).toEqual(asDate('2030-05-14'))
    expect(created.guestBirthDate).toEqual(asDate('1999-05-14'))
    expect(res.body.data.created.guestDocNumber).toBe('990514300123')
  })

  it('сплит брони без документа не выдумывает пустых строк', async () => {
    const { ctrl, prisma } = loadBookingCtrl({
      bookings: [bookingRow({ id: 1, status: 'CHECKED_IN' })],
    })

    await move(ctrl, 1, { newRoomId: 102, moveDate: '2026-07-10' })

    const created = prisma.booking.rows.at(-1)
    for (const f of DOC_FIELDS) expect(created[f]).toBeNull()
  })
})

// ─── Подстановка из прошлого визита ───────────────────────────────────────────

/**
 * Гость приезжает второй раз. Стойка вводит телефон — программа предлагает
 * документ с прошлого визита, вместо того чтобы просить продиктовать паспорт
 * заново (а на слух цифры записывают с ошибками — так у одного человека
 * заводится три разных номера документа).
 */
function loadGuestCtrl(bookings) {
  const { prisma } = createFakePrisma({ booking: bookings })
  return loadCjs('src/controllers/guestController.js', {
    stubs: {
      '../utils/prisma': { prisma },
      '../utils/businessDate': { getCurrentBusinessDate: async () => BUSINESS_DATE },
    },
  })
}

/** Бронь в том виде, в каком её читают guests/lookup (свой, более узкий select). */
function visit(over = {}) {
  return {
    id: 1,
    guestName: 'Асель Каримова',
    guestPhone: '+7 701 234 56 78',
    checkIn: d('2026-03-01'),
    checkOut: d('2026-03-05'),
    status: 'CHECKED_OUT',
    source: null,
    totalAmount: 40000,
    roomId: 101,
    room: { number: '12' },
    guestCitizenship: 'Казахстан',
    guestDocType: 'id_card',
    guestDocNumber: '990514300123',
    guestDocExpiry: d('2030-05-14'),
    guestBirthDate: d('1999-05-14'),
    guestSex: 'f',
    ...over,
  }
}

const lookup = (ctrl, phone) => run(ctrl.lookup, { query: { phone } })

describe('GET /api/guests/lookup — документ из прошлого визита', () => {
  it('находит гостя, чей телефон записан в другом формате', async () => {
    const ctrl = loadGuestCtrl([visit({ guestPhone: '8 (701) 234-56-78' })])

    // Тот же абонент, записанный четырьмя способами — для базы это разные строки
    for (const phone of ['+7 701 234 56 78', '87012345678', '+77012345678', '7012345678']) {
      const res = await lookup(ctrl, phone)
      expect(res.status, phone).toBe(200)
      expect(res.body.data.found, phone).toBe(true)
      expect(res.body.data.document.guestDocNumber, phone).toBe('990514300123')
    }
  })

  it('отдаёт весь комплект: документ, даты строкой ГГГГ-ММ-ДД, имя и откуда взято', async () => {
    const ctrl = loadGuestCtrl([visit()])

    const { body } = await lookup(ctrl, '+7 701 234 56 78')

    expect(body.data).toMatchObject({ found: true, phoneKey: '77012345678', guestName: 'Асель Каримова' })
    expect(body.data.document).toMatchObject({
      guestCitizenship: 'Казахстан',
      guestDocType: 'id_card',
      guestDocNumber: '990514300123',
      guestDocExpiry: '2030-05-14',
      guestBirthDate: '1999-05-14',
      guestSex: 'f',
    })
    expect(body.data.document.from).toMatchObject({ bookingId: 1, checkIn: '2026-03-01', roomNumber: '12' })
  })

  it('берёт САМЫЙ СВЕЖИЙ документ: паспорт меняют, старый номер уехал бы неверным', async () => {
    const ctrl = loadGuestCtrl([
      visit({ id: 1, checkIn: d('2024-03-01'), checkOut: d('2024-03-05'), guestDocNumber: 'СТАРЫЙ' }),
      visit({ id: 2, checkIn: d('2026-03-01'), checkOut: d('2026-03-05'), guestDocNumber: 'НОВЫЙ', guestPhone: '87012345678' }),
    ])

    const { body } = await lookup(ctrl, '+77012345678')

    expect(body.data.document.guestDocNumber).toBe('НОВЫЙ')
    expect(body.data.document.from.bookingId).toBe(2)
  })

  it('будущая бронь без паспорта не перебивает документ прошлого визита', async () => {
    // Ровно то, ради чего ищем по НАЛИЧИЮ документа, а не «по последней брони»:
    // забронировал на август по телефону — паспорта у той брони ещё нет.
    const ctrl = loadGuestCtrl([
      visit({ id: 1 }),
      visit({
        id: 2, checkIn: d('2026-08-01'), checkOut: d('2026-08-05'),
        guestCitizenship: null, guestDocType: null, guestDocNumber: null,
        guestDocExpiry: null, guestBirthDate: null, guestSex: null,
      }),
    ])

    const { body } = await lookup(ctrl, '+7 701 234 56 78')

    expect(body.data.found).toBe(true)
    expect(body.data.document.from.bookingId).toBe(1)
  })

  it('чужой номер — честное «не нашли», а не документ соседа', async () => {
    const ctrl = loadGuestCtrl([visit()])

    const { body } = await lookup(ctrl, '+7 777 000 11 22')

    expect(body.data).toMatchObject({ found: false, phoneKey: '77770001122', document: null, guestName: null })
  })

  it('номера разных стран с одинаковым хвостом — разные люди', async () => {
    // +996 701 234 56 78 и +7 701 234 56 78 совпадают последними десятью цифрами.
    const ctrl = loadGuestCtrl([visit({ guestPhone: '+996 701 234 56 78' })])

    const { body } = await lookup(ctrl, '+7 701 234 56 78')

    expect(body.data.found).toBe(false)
  })

  it('обрывок номера — не ошибка, а «пока не нашли»: стойка ещё набирает', async () => {
    const ctrl = loadGuestCtrl([visit()])

    const { body } = await lookup(ctrl, '701')

    expect(body.data).toEqual({ found: false, phoneKey: null, guestName: null, document: null })
  })

  it('ничего не пишет в базу', async () => {
    const { prisma } = createFakePrisma({ booking: [visit()] })
    const ctrl = loadCjs('src/controllers/guestController.js', {
      stubs: {
        '../utils/prisma': { prisma },
        '../utils/businessDate': { getCurrentBusinessDate: async () => BUSINESS_DATE },
      },
    })

    const before = JSON.stringify(prisma.booking.rows)
    await lookup(ctrl, '+7 701 234 56 78')

    expect(JSON.stringify(prisma.booking.rows)).toBe(before)
  })
})

// ─── Адресная книга ───────────────────────────────────────────────────────────

describe('GET /api/guests — документ в карточке гостя', () => {
  it('карточка показывает документ из последнего визита с паспортом', async () => {
    const ctrl = loadGuestCtrl([
      visit({ id: 1, guestDocNumber: 'СТАРЫЙ', checkIn: d('2024-03-01'), checkOut: d('2024-03-05') }),
      visit({ id: 2, guestDocNumber: 'НОВЫЙ', guestPhone: '87012345678' }),
    ])

    const res = await run(ctrl.list)

    const [card] = res.body.data.guests
    expect(card.visits).toBe(2)
    expect(card.document).toMatchObject({ guestDocNumber: 'НОВЫЙ', guestBirthDate: '1999-05-14' })
  })

  it('гость без документа — document: null, а не пустой объект', async () => {
    const ctrl = loadGuestCtrl([visit({
      guestCitizenship: null, guestDocType: null, guestDocNumber: null,
      guestDocExpiry: null, guestBirthDate: null, guestSex: null,
    })])

    const res = await run(ctrl.list)

    expect(res.body.data.guests[0].document).toBeNull()
  })
})
