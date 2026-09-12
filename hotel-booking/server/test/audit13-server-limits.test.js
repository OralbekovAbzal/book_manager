/**
 * Аудит 2026-09-13, сервер: границы, которых нет.
 *
 * Все проверки — на стенде `helpers/bookingStack.js` (настоящие контроллеры,
 * фейковая Prisma с честным вычислителем `where`) либо на чистых функциях.
 * Живая база и сервер не участвуют.
 *
 * Подтверждённые ошибки помечены `it.fails`: прогон обязан оставаться зелёным,
 * чинить исходники аудит не имеет права (параллельно работают другие агенты).
 */
import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { makeStack, run, booking, room, charge, rate, d } from './helpers/bookingStack.js'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'
import { createFakePrisma } from './helpers/fakePrisma.js'

const errorHandlerStub = {
  createError: (message, status = 400) => Object.assign(new Error(message), { status }),
}

// ─────────────────────────────────────────────────────────────────────────────
// S13-001 · Срок проживания ничем не ограничен сверху
// ─────────────────────────────────────────────────────────────────────────────

describe('S13-001 · длина брони', () => {
  const body = (checkOut) => ({
    roomId: 101, guestName: 'Опечатка', checkIn: '2026-07-10', checkOut,
  })

  it('опечатка в веке принимается и записывается (текущее поведение)', async () => {
    const { ctrl, prisma } = makeStack({ rooms: [room({ id: 101 })] })
    const out = await run(ctrl.create, { body: body('2126-07-10') })
    expect(out.status).toBe(201)
    const saved = prisma.booking.rows[0]
    const nights = Math.round((saved.checkOut - saved.checkIn) / 86400000)
    expect(nights).toBe(36524)   // сто лет в сутках — столько строк начислений готов создать генератор
  })

  it.fails('бронь длиной сто лет отклоняется как опечатка', async () => {
    const { ctrl } = makeStack({ rooms: [room({ id: 101 })] })
    const out = await run(ctrl.create, { body: body('2126-07-10') })
    // У тарифов такая граница есть — `rateController.MAX_RANGE_DAYS` = 800.
    expect(out.status).toBe(400)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S13-003 · Предпросмотр отдаёт по строке на каждую ночь без цены
// ─────────────────────────────────────────────────────────────────────────────

describe('S13-003 · размер ответа POST /bookings/preview', () => {
  it('ночей без цены — столько же записей в missingPrices (текущее поведение)', async () => {
    const { ctrl } = makeStack({ rooms: [room({ id: 101 })] })
    const out = await run(ctrl.preview, {
      body: { roomId: 101, checkIn: '2026-07-10', checkOut: '2029-07-10', adultsWithMeals: 2 },
    })
    expect(out.status).toBe(200)
    expect(out.body.data.missingPrices.length).toBe(1096)
  })

  it.fails('список «цена не задана» ограничен по длине', async () => {
    const { ctrl } = makeStack({ rooms: [room({ id: 101 })] })
    const out = await run(ctrl.preview, {
      body: { roomId: 101, checkIn: '2026-07-10', checkOut: '2029-07-10', adultsWithMeals: 2 },
    })
    // Форме довольно первых нескольких дат и общего числа; сейчас ответ растёт
    // линейно от срока и на опечатке в веке превращается в десятки мегабайт JSON.
    expect(out.body.data.missingPrices.length).toBeLessThanOrEqual(100)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S13-004 · Замок версии брони проверяется до транзакции, а не в UPDATE
// ─────────────────────────────────────────────────────────────────────────────

describe('S13-004 · BOOKING_STALE и гонка двух рабочих мест', () => {
  // `services: []` — ответ 409 отдаёт бронь целиком (BOOKING_DETAIL_SELECT),
  // а фейковая Prisma честно требует поле в фикстуре.
  const existing = booking({ id: 1, services: [], updatedAt: new Date('2026-07-05T10:00:00.000Z') })

  it('устаревшая версия отклоняется 409 (замок работает, когда правки разнесены во времени)', async () => {
    const { ctrl } = makeStack({ bookings: [existing] })
    const out = await run(ctrl.update, {
      params: { id: '1' },
      body: { guestName: 'Второй', expectedUpdatedAt: '2026-07-01T10:00:00.000Z' },
    })
    expect(out.status).toBe(409)
    expect(out.body.code).toBe('BOOKING_STALE')
  })

  it.fails('версия участвует в самом UPDATE, а не только в проверке до него', async () => {
    const { ctrl, calls } = makeStack({ bookings: [existing] })
    const out = await run(ctrl.update, {
      params: { id: '1' },
      body: { guestName: 'Первый', expectedUpdatedAt: '2026-07-05T10:00:00.000Z' },
    })
    expect(out.status).toBe(200)
    const upd = calls.find((c) => c.model === 'booking' && c.op === 'update')
    // Сейчас `where` — это просто `{ id }`: между `isStale` и записью соседнее
    // рабочее место успевает сохранить своё, и обе правки проходят.
    expect(upd.args.where).toHaveProperty('updatedAt')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S13-005 · Событие о платеже собирается не тем select, что все прочие
// ─────────────────────────────────────────────────────────────────────────────

describe('S13-005 · payload booking:updated после оплаты', () => {
  it.fails('бронь в событии читается тем же BOOKING_SELECT (с номером и цепочкой)', async () => {
    const { payCtrl, calls } = makeStack({ bookings: [booking({ id: 1 })] })
    const out = await run(payCtrl.create, { body: { bookingId: 1, amount: 5000, method: 'cash' } })
    expect(out.status).toBe(201)

    const reads = calls.filter((c) => c.model === 'booking' && c.op === 'findUnique')
    const forEvent = reads.find((c) => c.args.include)
    // `notifyBookingMoneyChanged` читает бронь как `include: { partner: true }`:
    // в payload нет ни `room`, ни `account`/`continuations`, хотя все остальные
    // события уходят с `BOOKING_SELECT`.
    expect(forEvent).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S13-007 · Вход различает регистр логина, а создание — нет
// ─────────────────────────────────────────────────────────────────────────────

describe('S13-007 · регистр логина при входе', () => {
  const PASSWORD = 'Demo2026!'
  const makeAuth = () => {
    const { prisma } = createFakePrisma({
      admin: [{
        id: 1, username: 'aigerim', name: 'Айгерим', role: 'ADMIN',
        isActive: true, tokenVersion: 0, password: bcrypt.hashSync(PASSWORD, 4),
      }],
    })
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'audit13-test-secret'
    return loadCjs('src/controllers/authController.js', {
      stubs: {
        '../utils/prisma': { prisma },
        '../utils/sessions': { revokeSessions: async () => ({}) },
      },
    })
  }

  it('логин в том же регистре, что в базе, проходит', async () => {
    const auth = makeAuth()
    const out = await run(auth.login, { body: { username: 'aigerim', password: PASSWORD } })
    expect(out.status).toBe(200)
  })

  it.fails('Caps Lock на стойке не мешает войти', async () => {
    const auth = makeAuth()
    const out = await run(auth.login, { body: { username: 'Aigerim', password: PASSWORD } })
    // `userController.create` и мастер приводят логин к нижнему регистру
    // (`.toLowerCase()` в routes/users.js), а `routes/auth.js` — только `.trim()`.
    expect(out.status).toBe(200)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S13-008 / S13-009 · Лицензия: чужой объект и кэш на весь процесс
// ─────────────────────────────────────────────────────────────────────────────

const pair = crypto.generateKeyPairSync('ed25519')
const TEST_PUBLIC = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const TEST_PRIVATE = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

function loadLicense(prisma) {
  return loadCjs('src/utils/license.js', {
    stubs: { './prisma': { prisma }, './logger': silentLogger },
    append: `PUBLIC_KEY_PEM = ${JSON.stringify(TEST_PUBLIC)}`,
  })
}

describe('S13-008 · ключ не сверяется с названием объекта', () => {
  it.fails('ключ, выписанный другой базе отдыха, не включает лицензию', async () => {
    const { prisma } = createFakePrisma({
      license: [], room: [], hotelSettings: [{ id: 1, name: 'Дорожник' }],
    })
    const lib = loadLicense(prisma)
    const { key } = lib.issueLicense(TEST_PRIVATE, {
      hotel: 'Туран', rooms: 45, maintenanceUntil: '2027-09-06',
    })

    const ctrl = loadCjs('src/controllers/licenseController.js', {
      stubs: {
        '../utils/prisma': { prisma },
        '../utils/license': lib,
        '../middleware/errorHandler': errorHandlerStub,
        '../utils/trial': { getTrialState: async () => ({ expired: false, daysLeft: 14 }) },
      },
    })
    const out = await run(ctrl.activate, { body: { key }, admin: { id: 1, role: 'SUPER_ADMIN' } })
    // Шапка utils/license.js: «Ключ привязан к НАЗВАНИЮ объекта». В коде этой
    // привязки нет ни при активации, ни при проверке — совпадение имени нигде
    // не сверяется, и скопированный ключ работает молча.
    expect(out.body.state).not.toBe('ok')
  })
})

describe('S13-009 · ключ лицензии кэшируется на всю жизнь процесса', () => {
  it.fails('после восстановления копии с ключом лицензия видна без перезапуска', async () => {
    const { prisma } = createFakePrisma({ license: [], room: [] })
    const lib = loadLicense(prisma)

    expect((await lib.getLicenseState()).state).toBe('none')

    // Восстановление резервной копии заменяет строки таблиц прямо в этом же
    // процессе (`utils/backup.js` → restoreBackup) — и кладёт чужой License.
    const { key } = lib.issueLicense(TEST_PRIVATE, {
      hotel: 'Туран', rooms: 45, maintenanceUntil: '2030-01-01',
    })
    prisma.license.rows.push({ id: 1, key, hardwareId: '', isActive: true })

    expect((await lib.getLicenseState()).state).toBe('ok')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S13-010 · Обычный PUT по заселённой брони переоценивает уже прожитые ночи
// ─────────────────────────────────────────────────────────────────────────────

describe('S13-010 · прожитые ночи при правке заселённой брони', () => {
  /** Гость живёт с 8 июля, рабочая дата — 10-е. Ночи 8 и 9 уже прожиты по 40 000. */
  const stack = () => makeStack({
    bookings: [booking({
      id: 1, status: 'CHECKED_IN', checkIn: d('2026-07-08'), checkOut: d('2026-07-13'),
      actualCheckInAt: new Date('2026-07-08T14:00:00Z'),
    })],
    charges: ['2026-07-08', '2026-07-09', '2026-07-10', '2026-07-11', '2026-07-12'].map((day, i) => charge({
      id: i + 1, bookingId: 1, kind: 'stay', date: d(day),
      quantity: 1, unitPrice: 40000, amount: 40000, source: 'auto',
    })),
    // Сегодняшний календарь цен другой: 15 000 за взрослого.
    rates: ['2026-07-08', '2026-07-09', '2026-07-10', '2026-07-11', '2026-07-12'].map((day) => rate(day)),
  })

  const editGuests = (ctrl) => run(ctrl.update, {
    params: { id: '1' },
    body: { adultsWithMeals: 3 },   // подселили третьего — пересборка строк законна
  })

  it('ночи после рабочей даты пересчитываются по тарифу (так и задумано)', async () => {
    const { ctrl, prisma } = stack()
    expect((await editGuests(ctrl)).status).toBe(200)
    const future = prisma.bookingCharge.rows.find(
      (c) => c.kind === 'stay' && c.date && c.date.getTime() === d('2026-07-12').getTime(),
    )
    expect(future.amount).toBe(45000)   // 3 взрослых × 15 000
  })

  it.fails('ночь, которую гость уже прожил, сохраняет свою цену', async () => {
    const { ctrl, prisma } = stack()
    await editGuests(ctrl)
    const lived = prisma.bookingCharge.rows.find(
      (c) => c.kind === 'stay' && c.date && c.date.getTime() === d('2026-07-08').getTime(),
    )
    // Ранний выезд и переезд замораживают прожитые ночи (`frozenBefore`), а
    // обычный PUT — нет: `rebuildChainCharges` получает `frozenBefore: null`
    // у любой брони без цепочки (bookingController.js, ветка needsRebuild).
    expect(lived.amount).toBe(40000)
  })
})
