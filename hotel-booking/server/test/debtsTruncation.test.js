import { describe, it, expect } from 'vitest'
import { makeStack, booking, charge, room, d, run } from './helpers/bookingStack.js'

/**
 * Список долгов в кассе: поиск по номеру комнаты и признак «список обрезан».
 *
 * `debtsWindow.test.js` закрывает само окно по дате выезда. Здесь — две вещи,
 * которые окно не покрывает:
 *
 *  1. Поиск `q` идёт по трём полям сразу, и третье — СВЯЗЬ (`room.number`).
 *     Раньше `fakePrisma` фильтр по связи не умел, и этот путь оставался
 *     непроверенным; теперь умеет. Поиск обязан работать вместе со снятым
 *     окном: «покажи все долги и найди 12-й номер» — рабочий запрос стойки.
 *
 *  2. `take: 300` на выборке. Признак `truncated` в ответе — единственное, из
 *     чего экран узнаёт, что список неполон. Считается он по СВЁРНУТОМУ списку
 *     (цепочки переездов схлопнуты в одну строку, отменённые без денег убраны),
 *     а обрезается — исходная выборка. Это разные числа.
 */

const DEBTS_TAKE = 300

const debtor = (id, over = {}) => booking({
  id,
  guestName: `Гость ${id}`,
  checkIn: d('2026-07-01'),
  checkOut: d('2026-07-05'),
  status: 'CHECKED_OUT',
  totalAmount: 0,
  ...over,
})

const debt = (id, amount = 50000) => charge({ id, bookingId: id, amount, unitPrice: amount, date: null })

const idsOf = (res) => res.body.data.bookings.map((b) => b.id)

// ─── Поиск по номеру комнаты ────────────────────────────────────────────────

describe('поиск в кассе по номеру комнаты', () => {
  const ROOMS = [
    room({ id: 101, number: '12' }),
    room({ id: 102, number: '120' }),
    room({ id: 103, number: '7Х' }),
  ]
  const ROWS = [
    debtor(1, { roomId: 101, room: ROOMS[0] }),
    debtor(2, { roomId: 102, room: ROOMS[1] }),
    debtor(3, { roomId: 103, room: ROOMS[2], guestName: 'Асель' }),
  ]
  const CHARGES = [debt(1), debt(2), debt(3)]

  const scene = () => makeStack({ bookings: ROWS, charges: CHARGES, rooms: ROOMS })

  it('запрос по номеру уходит в базу фильтром по связи room.number', async () => {
    const st = scene()
    await run(st.payCtrl.debts, { query: { q: '12' } })
    const where = st.calls.find((c) => c.model === 'booking' && c.op === 'findMany').args.where
    expect(where.OR).toContainEqual({ room: { number: { contains: '12', mode: 'insensitive' } } })
  })

  it('«12» находит и 12-й номер, и 120-й — поиск подстрокой', async () => {
    const res = await run(scene().payCtrl.debts, { query: { q: '12' } })
    expect(idsOf(res).sort()).toEqual([1, 2])
  })

  it('номер с кириллической буквой ищется без учёта регистра', async () => {
    const res = await run(scene().payCtrl.debts, { query: { q: '7х' } })
    expect(idsOf(res)).toEqual([3])
  })

  it('поиск по номеру работает при снятом окне (days=0)', async () => {
    const st = makeStack({
      bookings: [
        debtor(1, { roomId: 101, room: ROOMS[0], checkOut: d('2025-01-10') }),  // выехал год назад
        debtor(2, { roomId: 102, room: ROOMS[1] }),
      ],
      charges: [debt(1), debt(2)],
      rooms: ROOMS,
    })
    const res = await run(st.payCtrl.debts, { query: { q: '12', days: '0' } })
    const where = st.calls.find((c) => c.model === 'booking' && c.op === 'findMany').args.where
    // Окна нет…
    expect(where.checkOut).toBeUndefined()
    // …а фильтр по статусу и поиск остались
    expect(where.status).toEqual({ in: ['CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT'] })
    expect(idsOf(res).sort()).toEqual([1, 2])
  })

  it('прошлогодний долг по номеру комнаты без снятия окна по-прежнему не находится', async () => {
    const st = makeStack({
      bookings: [debtor(1, { roomId: 101, room: ROOMS[0], checkOut: d('2025-01-10') })],
      charges: [debt(1)],
      rooms: ROOMS,
    })
    const res = await run(st.payCtrl.debts, { query: { q: '12' } })
    expect(idsOf(res)).toEqual([])
    expect(res.body.data.window.days).toBe(30)
  })

  it('поиск, которому никто не отвечает, отдаёт окно в ответе — экрану есть что показать', async () => {
    const res = await run(scene().payCtrl.debts, { query: { q: 'такого номера нет' } })
    expect(res.body.data.bookings).toEqual([])
    expect(res.body.data.window).toEqual({ days: 30, truncated: false })
  })
})

// ─── Признак «список обрезан» ────────────────────────────────────────────────

/** N должников без переездов, все с долгом. */
const many = (n, from = 1) => {
  const rooms = []
  const bookings = []
  const charges = []
  for (let i = 0; i < n; i++) {
    const id = from + i
    const r = room({ id: 1000 + id, number: String(id) })
    rooms.push(r)
    bookings.push(debtor(id, { roomId: r.id, room: r }))
    charges.push(debt(id))
  }
  return { rooms, bookings, charges }
}

describe('признак «список обрезан»', () => {
  it('короткий список — truncated false', async () => {
    const { rooms, bookings, charges } = many(5)
    const res = await run(makeStack({ bookings, charges, rooms }).payCtrl.debts, {})
    expect(res.body.data.window.truncated).toBe(false)
  })

  it('потолок выборки объявлен константой, а не числом в коде', () => {
    const { payCtrl } = makeStack({})
    expect(payCtrl.DEBTS_TAKE).toBe(DEBTS_TAKE)
  })

  it('выборка действительно упирается в потолок: из 400 должников приходит 300', async () => {
    const { rooms, bookings, charges } = many(400)
    const res = await run(makeStack({ bookings, charges, rooms }).payCtrl.debts, {})
    expect(res.body.data.bookings).toHaveLength(DEBTS_TAKE)
    expect(res.body.data.window.truncated).toBe(true)
  })

  it('ровно 300 должников — выборка полная, но признак уже поднят', async () => {
    const { rooms, bookings, charges } = many(DEBTS_TAKE)
    const res = await run(makeStack({ bookings, charges, rooms }).payCtrl.debts, {})
    expect(res.body.data.bookings).toHaveLength(DEBTS_TAKE)
    // Здесь `truncated: true` — предупреждение с запасом, а не ошибка: список
    // ровно на потолке неотличим от обрезанного, и сказать «возможно, неполон»
    // честнее, чем промолчать.
    expect(res.body.data.window.truncated).toBe(true)
  })
})

describe('признак «список обрезан» при переездах и отменах (находка)', () => {
  /**
   * 400 броней: чётные — продолжения переезда нечётных. Выборка режется на 300
   * (150 голов + 150 продолжений), в списке остаются 150 строк-цепочек.
   * Ещё 100 должников в ответ не попали вовсе.
   */
  const chained = () => {
    const rooms = []
    const bookings = []
    const charges = []
    for (let id = 1; id <= 400; id++) {
      const r = room({ id: 1000 + id, number: String(id) })
      rooms.push(r)
      const isContinuation = id % 2 === 0
      bookings.push(debtor(id, {
        roomId: r.id,
        room: r,
        accountBookingId: isContinuation ? id - 1 : null,
      }))
      if (!isContinuation) charges.push(debt(id))
    }
    return { rooms, bookings, charges }
  }

  it('список обрезан выборкой — признак обязан это показать', async () => {
    // Должников 400, до кассы доехали 150 счетов; про остальные 100 броней экран
    // не узнает ничего. `truncated` считается по СВЁРНУТОМУ списку
    // (`rows.length >= 300`), а обрезается исходная выборка — числа разные.
    const { rooms, bookings, charges } = chained()
    const res = await run(makeStack({ bookings, charges, rooms }).payCtrl.debts, {})
    expect(res.body.data.window.truncated).toBe(true)
  })

  it('ни один из двух запросов потолка не достиг — обрезки не было', async () => {
    // Живые и отменённые берутся ДВУМЯ запросами по 300 каждый, а признак
    // сравнивает с 300 их сумму: 250 + 60 = 310 → «список обрезан», хотя
    // обрезать было нечего.
    const live = many(250, 1)
    const dead = many(60, 1001)
    const res = await run(makeStack({
      bookings: [...live.bookings, ...dead.bookings.map((b) => ({ ...b, status: 'CANCELLED' }))],
      charges: [...live.charges, ...dead.charges],
      rooms: [...live.rooms, ...dead.rooms],
    }).payCtrl.debts, {})
    expect(res.body.data.window.truncated).toBe(false)
  })
})
