import { describe, it, expect } from 'vitest'
import { loadCjs } from './helpers/loadCjs.js'
import { d } from './helpers/fakePrisma.js'

/**
 * Волна 5b: как цепочка после переезда выглядит в отчётах.
 *
 * Решение (`docs/decisions/data-and-money.md`, 2026-09-08): продолжение ОСТАЁТСЯ
 * строкой реестра — гость действительно жил в этом номере эти ночи, и «Реестр
 * броней» без него врал бы про загрузку номера. Но деньги у него нулевые: они
 * физически на голове счёта, и `loadBookingMoney` отдаёт их КАЖДОМУ отрезку
 * (это верно для формы брони — «сколько должен гость»). Сложить их в отчёте
 * значило бы посчитать один и тот же счёт по разу на каждый переезд.
 *
 * Отсюда два правила, которые здесь и сторожатся:
 *   1. деньги в датасете — только у головы, у продолжения нули и метка `accountOf`;
 *   2. счётчики броней (`count`, средний чек, доля отмен) считаются по головам —
 *      иначе один переезд задирает число броней и вдвое занижает средний чек.
 *
 * Ночи, гости и загрузка при этом считаются по ВСЕМ отрезкам: это разные вопросы
 * к одним данным, и смешивать их нельзя.
 */

const definitionOf = (columns, filters = []) => ({
  id: 'test', version: 1, title: 'Проверка', dataset: 'bookings',
  params: [{ key: 'period', type: 'dateRange', label: 'Период', required: true }],
  filters,
  groupBy: [],
  columns,
})

const PERIOD = { period: { from: '2026-07-01', to: '2026-07-31' } }
const TODAY = d('2026-07-20')

const bookingRow = (id, over = {}) => ({
  id,
  guestName: `Гость ${id}`, guestPhone: '', checkIn: d('2026-07-10'), checkOut: d('2026-07-14'),
  status: 'CHECKED_OUT', source: 'стойка', notes: '', flags: [],
  adultsWithMeals: 2, childrenWithMeals: 0, adultsNoMeals: 0, childrenNoMeals: 0,
  extraBedsWithMeals: 0, extraBedsNoMeals: 0, disabledAdults: 0, disabledChildren: 0,
  discountPercent: 0, totalAmount: 0, prepaidAmount: 0, paidAmount: 0,
  accountBookingId: null,
  createdAt: d('2026-07-01'),
  room: { number: String(100 + id), building: 'A', floor: 1, capacity: '2х', features: [], category: { name: 'Стандарт' } },
  partner: null, createdBy: { name: 'Админ' },
  ...over,
})

/**
 * Цепочка после переезда (сценарий D7-013):
 *   №1 — голова, «Стандарт» 10 → 12 июля, весь счёт 115 200, принято 40 000;
 *   №2 — продолжение, «Комфорт» 12 → 14 июля, своих денег нет;
 *   №3 — обычная одиночная бронь на 60 000, оплачена целиком.
 */
const ROWS = [
  bookingRow(1, {
    checkIn: d('2026-07-10'), checkOut: d('2026-07-12'), totalAmount: 115200, paidAmount: 40000,
  }),
  bookingRow(2, {
    accountBookingId: 1, checkIn: d('2026-07-12'), checkOut: d('2026-07-14'), status: 'CHECKED_IN',
    room: { number: '201', building: 'A', floor: 1, capacity: '2х', features: [], category: { name: 'Комфорт' } },
  }),
  bookingRow(3, { totalAmount: 60000, paidAmount: 60000, status: 'CHECKED_OUT' }),
]

/** Строки и платежи лежат ТОЛЬКО на голове — так же, как в базе после переезда. */
const CHARGES = [{ bookingId: 1, amount: 115200 }, { bookingId: 3, amount: 60000 }]
const PAYMENTS = [
  { bookingId: 1, kind: 'payment', amount: 40000, voidedAt: null },
  { bookingId: 3, kind: 'payment', amount: 60000, voidedAt: null },
]

function reporter(rows = ROWS) {
  const seen = {}
  const has = (id, where) => where.bookingId.in.includes(id)
  const prisma = {
    booking: {
      async findMany(args) { seen.select = args.select; return rows },
    },
    bookingCharge: {
      async groupBy({ where }) {
        const byId = new Map()
        for (const c of CHARGES.filter((x) => has(x.bookingId, where))) {
          const cur = byId.get(c.bookingId) || { bookingId: c.bookingId, _sum: { amount: 0 }, _count: { _all: 0 } }
          cur._sum.amount += c.amount
          cur._count._all += 1
          byId.set(c.bookingId, cur)
        }
        return [...byId.values()]
      },
    },
    payment: { async findMany({ where }) { return PAYMENTS.filter((p) => has(p.bookingId, where)) } },
  }
  const money = loadCjs('src/utils/bookingMoney.js', { stubs: { './prisma': { prisma } } })
  const ds = loadCjs('src/reports/datasets/bookings.js', {
    stubs: { '../../utils/prisma': { prisma }, '../../utils/bookingMoney': money },
  })
  const engine = loadCjs('src/reports/engine.js', {
    stubs: { './datasets': { getDataset: (id) => (id === ds.id ? ds : null) } },
  })
  return {
    dataset: ds,
    seen,
    run: (def, params = PERIOD) => engine.runReport(def, params, { today: TODAY }),
    load: () => ds.load({ params: { period: PERIOD.period, periodMode: 'overlap' } }),
  }
}

// ─── Поля строки ─────────────────────────────────────────────────────────────

describe('датасет броней помечает продолжения и обнуляет им деньги', () => {
  it('продолжение помечено, голова и одиночная бронь — нет', async () => {
    const rows = await reporter().load()
    expect(rows.map((r) => [r.id, r.isContinuation])).toEqual([[1, false], [2, true], [3, false]])
  })

  it('у продолжения написано, чей это счёт', async () => {
    const rows = await reporter().load()
    expect(rows.find((r) => r.id === 2).accountOf).toBe('№1')
    expect(rows.find((r) => r.id === 1).accountOf).toBe('')
  })

  it('деньги цепочки лежат на голове, у продолжения нули', async () => {
    // Иначе `sum(charged)` в отчёте посчитал бы 115 200 дважды.
    const rows = await reporter().load()
    const head = rows.find((r) => r.id === 1)
    const cont = rows.find((r) => r.id === 2)

    expect(head).toMatchObject({ charged: 115200, paidNet: 40000, debtAmount: 75200 })
    expect(cont).toMatchObject({ charged: 0, paidNet: 0, debtAmount: 0, totalAmount: 0 })
  })

  it('ночи и гости у продолжения свои — оно осталось строкой реестра', async () => {
    // Обнулять их значило бы потерять две ночи проживания в «Комфорте»:
    // загрузка номера считается по отрезкам, а не по счёту.
    const rows = await reporter().load()
    const cont = rows.find((r) => r.id === 2)

    expect(cont).toMatchObject({ nights: 2, guests: 2, roomNumber: '201', categoryName: 'Комфорт' })
  })

  it('датасет спрашивает у базы голову счёта — без неё пометить нечем', async () => {
    const r = reporter()
    await r.load()
    expect(r.seen.select.accountBookingId).toBe(true)
  })

  it('поля объявлены в контракте датасета: конструктор отчётов их покажет', async () => {
    // `fields` здесь не документация, а контракт: колонки и группировки строятся
    // из него, и поле «есть в строке, но нет в контракте» до пользователя не доедет.
    const { dataset } = reporter()
    expect(dataset.fields.isContinuation).toMatchObject({ type: 'bool', groupable: true })
    expect(dataset.fields.accountOf).toMatchObject({ type: 'text' })
  })
})

// ─── Показатели ──────────────────────────────────────────────────────────────

describe('счётчики броней считаются по головам', () => {
  const DEF = definitionOf([
    { key: 'count', metric: 'count' },
    { key: 'avgCheck', metric: 'avgCheck' },
    { key: 'revenue', metric: 'revenue' },
    { key: 'charged', metric: 'charged' },
    { key: 'nights', metric: 'nights' },
  ])

  it('«Броней» — две, а не три: продолжение это часть первой', async () => {
    const res = await reporter().run(DEF)
    expect(res.rows[0].count).toBe(2)
  })

  it('средний чек делится на головы, а не на отрезки', async () => {
    // (115 200 + 60 000) / 2 = 87 600. По трём строкам вышло бы 58 400 —
    // переезд «удешевил» бы отель на треть.
    const res = await reporter().run(DEF)
    expect(res.rows[0].avgCheck).toBe(87600)
  })

  it('выручка и начисленное не удваиваются на цепочке', async () => {
    const res = await reporter().run(DEF)
    expect(res.rows[0].revenue).toBe(175200)
    expect(res.rows[0].charged).toBe(175200)
  })

  it('ночи считаются по ВСЕМ отрезкам — это другой вопрос к тем же данным', async () => {
    // 2 (голова) + 2 (продолжение) + 4 (одиночная) = 8
    const res = await reporter().run(DEF)
    expect(res.rows[0].nights).toBe(8)
  })

  it('доля отмен не размывается продолжениями', async () => {
    // Отменена одна бронь из двух настоящих — 50 %, а не 33 % «из трёх строк».
    const rows = [
      { ...ROWS[0], status: 'CANCELLED' },
      ROWS[1],
      ROWS[2],
    ]
    const def = definitionOf([
      { key: 'cancelled', metric: 'cancelled' },
      { key: 'cancelRate', metric: 'cancelRate' },
    ])

    const res = await reporter(rows).run(def)

    expect(res.rows[0].cancelled).toBe(1)
    expect(res.rows[0].cancelRate).toBe(50)
  })

  it('без цепочки счётчик считает всё: правило не режет обычные брони', async () => {
    // Контроль: `count` не превратился в «считаем только выехавших» или что-то
    // ещё — на одиночных бронях он обязан остаться прежним.
    const singles = [ROWS[0], ROWS[2]].map((r) => ({ ...r, accountBookingId: null }))
    const res = await reporter(singles).run(DEF)

    expect(res.rows[0].count).toBe(2)
    expect(res.rows[0].avgCheck).toBe(87600)
  })

  it('по «продолжение счёта» можно отфильтровать реестр', async () => {
    // Практический смысл поля: бухгалтеру нужен список без вторых частей.
    const def = definitionOf(
      [{ key: 'id', field: 'id' }, { key: 'accountOf', field: 'accountOf' }],
      [{ field: 'isContinuation', op: 'isFalse' }],
    )

    const res = await reporter().run(def)

    expect(res.rows.map((r) => r.id)).toEqual([1, 3])
  })
})
