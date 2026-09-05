import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { loadCjs, SERVER_ROOT } from './helpers/loadCjs.js'
import { d } from './helpers/fakePrisma.js'

/**
 * Три встроенных финансовых отчёта — целиком, от датасета до строк результата:
 * ОПРЕДЕЛЕНИЯ берутся настоящие (`definitions/*.json`), движок настоящий,
 * подменена только база.
 *
 * Что тут сторожится:
 *  • разложение начислений по видам (проживание / питание / услуги / скидки)
 *    и то, что скидка вычитается, а не прибавляется;
 *  • правило периода для начислений без даты: услуги и скидки считаются
 *    по дате ЗАЕЗДА брони, иначе они не попали бы ни в один месяц;
 *  • касса: отменённые записи в суммы не входят, возврат уменьшает нетто,
 *    день берётся по СМЕНЕ, а не по часам приёма;
 *  • долг: начислено − принято, с запасным `totalAmount` у броней без строк;
 *  • ИТОГИ — сумма по всем строкам, а не среднее по группам (грабли из
 *    `docs/decisions/reports.md`: средняя загрузка считалась средним процентов).
 */

const DEFS = path.join(SERVER_ROOT, 'src/reports/definitions')
const definition = (name) => JSON.parse(fs.readFileSync(path.join(DEFS, name), 'utf8'))

const TODAY = d('2026-08-15')

/** Движок с подменённым реестром датасетов: определение настоящее, база — нет. */
function engineWith(dataset) {
  return loadCjs('src/reports/engine.js', {
    stubs: { './datasets': { getDataset: (id) => (id === dataset.id ? dataset : null) } },
  })
}

/** Строки результата в виде «ключ колонки → значение». */
const run = async (engine, def, params) => engine.runReport(def, params, { today: TODAY })

const inRange = (value, cond) => {
  if (!value) return false
  const t = value.getTime()
  return t >= cond.gte.getTime() && t < cond.lt.getTime()
}

// ─── Начисления / «Выручка за период» ────────────────────────────────────────

const room = (over = {}) => ({
  number: '101', building: 'A', floor: 1, capacity: '2х',
  category: { name: 'Комфорт' }, ...over,
})

/** Бронь в том виде, в каком её отдаёт select датасета начислений. */
const chargeBooking = (over = {}) => ({
  guestName: 'Гость', guestPhone: '', checkIn: d('2026-06-29'), checkOut: d('2026-07-02'),
  status: 'CHECKED_OUT', source: 'стойка', room: room(), partner: null, ...over,
})

const charge = (id, kind, amount, date, over = {}) => ({
  id, bookingId: over.bookingId ?? 1, kind, label: over.label || kind,
  quantity: 1, unitPrice: amount, amount, date,
  source: over.chargeSource || 'auto', reason: null, createdAt: d('2026-06-01'),
  createdBy: { name: 'Админ' },
  booking: over.booking || chargeBooking(),
})

/**
 * Бронь 29.06 → 02.07: три ночи проживания с датами, завтрак и скидка без даты.
 * Ровно тот случай, ради которого заведено правило «без даты — по заезду».
 */
const CHARGES = [
  charge(1, 'stay', 30000, d('2026-06-29')),
  charge(2, 'stay', 30000, d('2026-06-30')),
  charge(3, 'stay', 30000, d('2026-07-01')),
  charge(4, 'meal', 21000, null, { label: 'Завтрак' }),
  charge(5, 'discount', -9000, null, { label: 'Скидка 10%' }),
  // Вторая бронь, отменённая: в выручку по умолчанию идти не должна
  charge(6, 'stay', 50000, d('2026-06-15'), {
    bookingId: 2,
    booking: chargeBooking({ status: 'CANCELLED', checkIn: d('2026-06-15'), checkOut: d('2026-06-16') }),
  }),
]

function chargesDataset(rows = CHARGES) {
  const seen = {}
  const prisma = {
    bookingCharge: {
      async findMany(args) {
        seen.where = args.where
        const [byDate, byBooking] = args.where.OR
        return rows.filter((r) => (r.date
          ? inRange(r.date, byDate.date)
          : inRange(r.booking.checkIn, byBooking.booking.checkIn)))
      },
    },
  }
  const ds = loadCjs('src/reports/datasets/charges.js', { stubs: { '../../utils/prisma': { prisma } } })
  return { ds, seen }
}

describe('Выручка за период', () => {
  const def = definition('revenue.json')

  it('раскладывает счёт по видам, скидку вычитает, отменённую бронь не берёт', async () => {
    const { ds } = chargesDataset()
    const r = await run(engineWith(ds), def, { period: { from: '2026-06-01', to: '2026-07-31' } })

    expect(r.rows).toHaveLength(2)
    const june = r.rows.find((x) => x.group === '2026-06')
    const july = r.rows.find((x) => x.group === '2026-07')

    // Июнь: две ночи + завтрак и скидка (у них нет даты → идут по заезду 29.06)
    expect(june.stay).toBe(60000)
    expect(june.meal).toBe(21000)
    expect(june.discount).toBe(-9000)
    expect(june.total).toBe(72000)
    // Июль: одна ночь
    expect(july.stay).toBe(30000)
    expect(july.total).toBe(30000)

    // Отменённая бронь (50 000 в июне) в выручку не попала
    expect(r.totals.total).toBe(102000)
    expect(r.meta.sourceRowCount).toBe(5)
  })

  it('итог равен сумме видов — скидка не потерялась и не прибавилась', async () => {
    const { ds } = chargesDataset()
    const r = await run(engineWith(ds), def, { period: { from: '2026-06-01', to: '2026-07-31' } })
    const t = r.totals
    expect(t.stay + t.meal + t.extra + t.discount).toBe(t.total)
  })

  it('отменённые видно, если их явно попросили', async () => {
    const { ds } = chargesDataset()
    const r = await run(engineWith(ds), def, {
      period: { from: '2026-06-01', to: '2026-07-31' },
      statuses: ['CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'CANCELLED', 'NO_SHOW'],
    })
    expect(r.totals.total).toBe(152000)
  })

  it('период по дате строки, а начисления без даты — по заезду брони', async () => {
    const { ds, seen } = chargesDataset()
    // Только июль: ночь 01.07 попадает, завтрак и скидка — нет (заезд 29.06)
    const r = await run(engineWith(ds), def, { period: { from: '2026-07-01', to: '2026-07-31' } })
    expect(r.totals.stay).toBe(30000)
    expect(r.totals.meal).toBe(0)
    expect(r.totals.discount).toBe(0)

    // Запрос к базе обязан спрашивать обе ветки, иначе услуги пропадут насовсем
    expect(seen.where.OR).toHaveLength(2)
    expect(seen.where.OR[1].date).toBeNull()
    expect(seen.where.OR[1].booking.checkIn).toBeTruthy()
  })

  it('перегруппировка по категории и корпусу даёт тот же итог', async () => {
    const { ds } = chargesDataset()
    for (const groupBy of ['categoryName', 'building', 'periodDate', 'label']) {
      const r = await run(engineWith(ds), def, { period: { from: '2026-06-01', to: '2026-07-31' }, groupBy })
      expect(r.groupBy).toEqual([groupBy])
      expect(r.totals.total).toBe(102000)
    }
  })

  it('ИТОГО считается по всем строкам, а не как среднее по группам', async () => {
    // «В среднем на бронь» = 102 000 / 1 бронь. Среднее по двум группам
    // (июнь 72 000 и июль 30 000) дало бы 51 000 — ровно та ошибка,
    // из-за которой средняя загрузка когда-то показывала 5,8 % вместо 9,7 %.
    const { ds } = chargesDataset()
    const custom = Object.assign({}, def, {
      columns: [
        { key: 'group', field: '$group', titleFrom: '$group', total: false },
        { key: 'avg', title: 'В среднем на бронь', metric: 'avgPerBooking' },
      ],
      sort: [{ key: 'group', dir: 'asc' }],
      chart: undefined,
    })
    const r = await run(engineWith(ds), custom, { period: { from: '2026-06-01', to: '2026-07-31' } })
    expect(r.rows.map((x) => x.avg)).toEqual([72000, 30000])
    expect(r.totals.avg).toBe(102000)
  })
})

// ─── Платежи / «Касса за период» ─────────────────────────────────────────────

const payBooking = (over = {}) => ({
  guestName: 'Гость', guestPhone: '', checkIn: d('2026-08-10'), checkOut: d('2026-08-12'),
  status: 'CHECKED_OUT', room: room(), partner: null, ...over,
})

const payment = (id, over = {}) => ({
  id, bookingId: over.bookingId ?? 1, kind: 'payment', amount: 0, method: 'cash',
  adminName: 'Кассир', shiftId: 1, businessDate: d('2026-08-10'),
  paidAt: new Date('2026-08-10T12:00:00Z'), comment: null, refundOfId: null,
  voidedAt: null, voidReason: null, voidedBy: null,
  booking: payBooking(),
  ...over,
})

const PAYMENTS = [
  payment(1, { amount: 100000, method: 'cash' }),
  payment(2, { amount: 300000, method: 'card' }),
  payment(3, { amount: 50000, method: 'card', kind: 'refund', refundOfId: 2 }),
  // Ошибка кассира: запись отменена — в деньги не идёт, но видна отдельно
  payment(4, { amount: 999000, method: 'transfer', voidedAt: new Date('2026-08-10T13:00:00Z'), voidReason: 'не та бронь' }),
  // Принято ночью 11.08 по часам, но смена ещё 10.08 — касса считает по смене
  payment(5, {
    amount: 40000, method: 'transfer',
    businessDate: d('2026-08-10'), paidAt: new Date('2026-08-11T02:30:00Z'),
  }),
]

function paymentsDataset(rows = PAYMENTS) {
  const seen = {}
  const prisma = {
    payment: {
      async findMany(args) {
        seen.where = args.where
        const [byShift, byClock] = args.where.OR
        return rows.filter((r) => (r.businessDate
          ? inRange(r.businessDate, byShift.businessDate)
          : inRange(r.paidAt, byClock.paidAt)))
      },
    },
  }
  const money = loadCjs('src/utils/bookingMoney.js', { stubs: { './prisma': { prisma: {} } } })
  const ds = loadCjs('src/reports/datasets/payments.js', {
    stubs: { '../../utils/prisma': { prisma }, '../../utils/bookingMoney': money },
  })
  return { ds, seen }
}

describe('Касса за период', () => {
  const def = definition('cash-register.json')
  const august = { period: { from: '2026-08-01', to: '2026-08-31' } }

  it('отменённая запись не в деньгах, но видна колонкой «Отменено»', async () => {
    const { ds } = paymentsDataset()
    const r = await run(engineWith(ds), def, august)
    expect(r.rows).toHaveLength(1)
    const day = r.rows[0]
    expect(day.received).toBe(440000)      // 100 000 + 300 000 + 40 000
    expect(day.refunded).toBe(50000)
    expect(day.net).toBe(390000)
    expect(day.voidedAmount).toBe(999000)  // отменённый перевод — отдельно
    expect(day.operations).toBe(4)         // отменённая запись операцией не считается
  })

  it('разбивка по способам сходится с нетто', async () => {
    const { ds } = paymentsDataset()
    const r = await run(engineWith(ds), def, august)
    const t = r.totals
    expect(t.cash).toBe(100000)
    expect(t.card).toBe(250000)      // 300 000 принято − 50 000 возврат
    expect(t.transfer).toBe(40000)   // отменённые 999 000 сюда не попали
    expect(t.cash + t.card + t.transfer).toBe(t.net)
  })

  it('день берётся по смене, а не по часам приёма', async () => {
    const { ds } = paymentsDataset()
    const r = await run(engineWith(ds), def, august)
    // Платёж, принятый 11.08 в 02:30, лежит в смене 10.08 — строка ровно одна
    expect(r.rows.map((x) => x.group)).toEqual(['2026-08-10'])

    const byClock = await run(engineWith(ds), Object.assign({}, def, {
      columns: [
        { key: 'group', field: 'paidDate', title: 'Дата приёма', total: false },
        { key: 'net', title: 'Нетто', metric: 'net' },
      ],
      groupBy: ['paidDate'],
      sort: [{ key: 'group', dir: 'asc' }],
      chart: undefined,
    }), august)
    // По календарю тот же платёж уехал бы на другой день — так кассу не сводят
    expect(byClock.rows.map((x) => x.group)).toEqual(['2026-08-10', '2026-08-11'])
  })

  it('«не показывать» и «только отменённые» не меняют денег', async () => {
    const { ds } = paymentsDataset()
    const hidden = await run(engineWith(ds), def, { ...august, voided: 'exclude' })
    expect(hidden.totals.net).toBe(390000)
    expect(hidden.totals.voidedAmount).toBe(0)

    const only = await run(engineWith(ds), def, { ...august, voided: 'only' })
    expect(only.totals.net).toBe(0)
    expect(only.totals.voidedAmount).toBe(999000)
  })

  it('фильтр по способу оплаты и по сотруднику', async () => {
    const { ds } = paymentsDataset()
    const cash = await run(engineWith(ds), def, { ...august, method: 'cash' })
    expect(cash.totals.net).toBe(100000)
    const nobody = await run(engineWith(ds), def, { ...august, adminName: 'Кто-то другой' })
    expect(nobody.meta.sourceRowCount).toBe(0)
  })

  it('деньги округляются до тенге', async () => {
    // Три платежа по 33 333,33 дают 99 999,99 — в кассе это 100 000 ₸,
    // а не «99999.99000000001»
    const { ds } = paymentsDataset([
      payment(1, { amount: 33333.33 }), payment(2, { amount: 33333.33 }), payment(3, { amount: 33333.33 }),
    ])
    const r = await run(engineWith(ds), def, august)
    expect(r.totals.received).toBe(100000)
    expect(r.rows[0].net).toBe(100000)
  })

  it('период спрашивает рабочую дату, а часы — только у платежей без смены', async () => {
    const { ds, seen } = paymentsDataset()
    await run(engineWith(ds), def, august)
    expect(seen.where.OR[0].businessDate).toBeTruthy()
    expect(seen.where.OR[1].businessDate).toBeNull()
    expect(seen.where.OR[1].paidAt).toBeTruthy()
  })
})

// ─── Брони / «Долги» ─────────────────────────────────────────────────────────

const booking = (id, over = {}) => ({
  id,
  guestName: `Гость ${id}`, guestPhone: '', checkIn: d('2026-08-10'), checkOut: d('2026-08-13'),
  status: 'CHECKED_OUT', source: 'стойка', notes: '', flags: [],
  adultsWithMeals: 2, childrenWithMeals: 0, adultsNoMeals: 0, childrenNoMeals: 0,
  extraBedsWithMeals: 0, extraBedsNoMeals: 0, disabledAdults: 0, disabledChildren: 0,
  discountPercent: 0, totalAmount: 0, prepaidAmount: 0, paidAmount: 0,
  createdAt: d('2026-08-01'),
  room: { number: String(100 + id), building: 'A', floor: 1, capacity: '2х', features: [], category: { name: 'Комфорт' } },
  partner: null, createdBy: { name: 'Админ' },
  ...over,
})

/**
 * 1 — начисления строками, оплачено частично → долг 60 000
 * 2 — строк нет, сумма из брони, не платил   → долг 100 000 (те самые 107 старых)
 * 3 — переплата                              → долг −20 000
 * 4 — рассчитался                            → долга нет
 * 5 — ремонтный блок                         → в отчёт о долгах не входит
 */
const BOOKINGS = [
  booking(1, { totalAmount: 999 }),
  booking(2, { totalAmount: 100000 }),
  booking(3, { totalAmount: 0 }),
  booking(4, { totalAmount: 50000 }),
  booking(5, { totalAmount: 0, source: 'ремонт', guestName: 'Ремонт' }),
]
const BOOKING_CHARGES = [
  { bookingId: 1, amount: 90000 }, { bookingId: 1, amount: 30000 },
  { bookingId: 4, amount: 50000 },
]
const BOOKING_PAYMENTS = [
  { bookingId: 1, kind: 'payment', amount: 60000, voidedAt: null },
  { bookingId: 1, kind: 'payment', amount: 500000, voidedAt: new Date() }, // отменена
  { bookingId: 3, kind: 'payment', amount: 20000, voidedAt: null },
  { bookingId: 4, kind: 'payment', amount: 70000, voidedAt: null },
  { bookingId: 4, kind: 'refund', amount: 20000, voidedAt: null },
]

function bookingsDataset() {
  const seen = {}
  const has = (id, where) => where.bookingId.in.includes(id)
  const prisma = {
    booking: {
      async findMany(args) { seen.where = args.where; return BOOKINGS },
    },
    bookingCharge: {
      async groupBy({ where }) {
        const byId = new Map()
        for (const c of BOOKING_CHARGES.filter((c) => has(c.bookingId, where))) {
          const cur = byId.get(c.bookingId) || { bookingId: c.bookingId, _sum: { amount: 0 }, _count: { _all: 0 } }
          cur._sum.amount += c.amount
          cur._count._all += 1
          byId.set(c.bookingId, cur)
        }
        return [...byId.values()]
      },
    },
    payment: {
      async findMany({ where }) { return BOOKING_PAYMENTS.filter((p) => has(p.bookingId, where)) },
    },
  }
  const money = loadCjs('src/utils/bookingMoney.js', { stubs: { './prisma': { prisma } } })
  const ds = loadCjs('src/reports/datasets/bookings.js', {
    stubs: { '../../utils/prisma': { prisma }, '../../utils/bookingMoney': money },
  })
  return { ds, seen }
}

describe('Долги', () => {
  const def = definition('debts.json')
  const period = { period: { from: '2026-08-01', to: '2026-08-31' } }

  it('показывает только должников, крупный долг сверху', async () => {
    const { ds } = bookingsDataset()
    const r = await run(engineWith(ds), def, period)
    expect(r.rows.map((x) => x.id)).toEqual([2, 1])
    expect(r.rows[0].charged).toBe(100000)   // строк нет — сумма из брони
    expect(r.rows[0].debt).toBe(100000)
    expect(r.rows[1].charged).toBe(120000)   // строки перевесили totalAmount = 999
    expect(r.rows[1].paidNet).toBe(60000)    // отменённый платёж не считается
    expect(r.rows[1].debt).toBe(60000)
    expect(r.totals.debt).toBe(160000)
  })

  it('рассчитавшийся гость и ремонт в списке не нужны', async () => {
    const { ds } = bookingsDataset()
    const r = await run(engineWith(ds), def, period)
    const ids = r.rows.map((x) => x.id)
    expect(ids).not.toContain(4)  // 50 000 начислено, 70 000 − 20 000 возврат = 50 000
    expect(ids).not.toContain(5)  // ремонтный блок
  })

  it('переплату видно отдельным режимом, а не как «долг 0»', async () => {
    const { ds } = bookingsDataset()
    const over = await run(engineWith(ds), def, { ...period, show: 'over' })
    expect(over.rows.map((x) => x.id)).toEqual([3])
    expect(over.rows[0].debt).toBe(-20000)
  })

  it('«все брони» показывает и нулевые, но без ремонта', async () => {
    const { ds } = bookingsDataset()
    const all = await run(engineWith(ds), def, { ...period, show: 'all' })
    expect(all.rows.map((x) => x.id).sort()).toEqual([1, 2, 3, 4])
    // Итог по всем = 100 000 + 60 000 − 20 000
    expect(all.totals.debt).toBe(140000)
  })

  it('номер брони в итогах не суммируется', async () => {
    const { ds } = bookingsDataset()
    const r = await run(engineWith(ds), def, period)
    expect(r.totals.id).toBeUndefined()
  })

  it('период по умолчанию считается по проживанию', async () => {
    const { ds, seen } = bookingsDataset()
    await run(engineWith(ds), def, period)
    expect(Object.keys(seen.where).sort()).toEqual(['checkIn', 'checkOut'])
    expect(seen.where.checkIn.lt).toBeTruthy()
    expect(seen.where.checkOut.gt).toBeTruthy()
  })
})
