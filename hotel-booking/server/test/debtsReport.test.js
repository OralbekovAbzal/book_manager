import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { loadCjs, SERVER_ROOT } from './helpers/loadCjs.js'
import { d } from './helpers/fakePrisma.js'

/**
 * Отчёт «Долги» после волны 5a: отменённые брони входят В СПИСОК ПО УМОЛЧАНИЮ
 * (`src/reports/definitions/debts.json`, параметр `statuses`).
 *
 * Смысл правки: отмена обнуляет автоматический счёт, но деньги по брони остаются —
 * невозвращённая предоплата (переплата) или удержание ручной строкой (долг).
 * Раньше такая бронь пропадала из отчёта совсем (аудит D2-006).
 *
 * Определение берётся настоящее из `definitions/`, движок и датасет — настоящие,
 * подменена только база: тест проверяет саму поставляемую конфигурацию отчёта.
 */

const definition = (name) =>
  JSON.parse(fs.readFileSync(path.join(SERVER_ROOT, 'src/reports/definitions', name), 'utf8'))

const DEF = definition('debts.json')
const PERIOD = { period: { from: '2026-07-01', to: '2026-07-31' } }
const TODAY = d('2026-07-20')

const bookingRow = (id, over = {}) => ({
  id,
  guestName: `Гость ${id}`, guestPhone: '', checkIn: d('2026-07-10'), checkOut: d('2026-07-13'),
  status: 'CHECKED_OUT', source: 'стойка', notes: '', flags: [],
  adultsWithMeals: 2, childrenWithMeals: 0, adultsNoMeals: 0, childrenNoMeals: 0,
  extraBedsWithMeals: 0, extraBedsNoMeals: 0, disabledAdults: 0, disabledChildren: 0,
  discountPercent: 0, totalAmount: 0, prepaidAmount: 0, paidAmount: 0,
  createdAt: d('2026-07-01'),
  room: { number: String(100 + id), building: 'A', floor: 1, capacity: '2х', features: [], category: { name: 'Комфорт' } },
  partner: null, createdBy: { name: 'Админ' },
  ...over,
})

/**
 * 1 — живой должник (выехал, не доплатил 40 000);
 * 2 — ОТМЕНЁННАЯ с удержанием 15 000 по ручной строке → долг;
 * 3 — ОТМЕНЁННАЯ с невозвращённой предоплатой 20 000 → переплата.
 */
const ROWS = [
  bookingRow(1, { totalAmount: 100000, paidAmount: 60000 }),
  bookingRow(2, { status: 'CANCELLED', totalAmount: 15000, paidAmount: 0 }),
  bookingRow(3, { status: 'CANCELLED', totalAmount: 0, paidAmount: 20000 }),
]
const CHARGES = [
  { bookingId: 1, amount: 100000 },
  { bookingId: 2, amount: 15000 },   // ручное удержание за отмену
]
const PAYMENTS = [
  { bookingId: 1, kind: 'payment', amount: 60000, voidedAt: null },
  { bookingId: 3, kind: 'payment', amount: 20000, voidedAt: null },
]

function dataset() {
  const has = (id, where) => where.bookingId.in.includes(id)
  const prisma = {
    booking: { async findMany() { return ROWS } },
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
  return (params) => engine.runReport(DEF, params, { today: TODAY })
}

describe('отчёт «Долги» и отменённые брони', () => {
  it('удержание по отменённой брони попадает в список без всяких настроек', async () => {
    const rows = (await dataset()(PERIOD)).rows
    expect(rows.map((x) => x.id)).toEqual([1, 2])
    expect(rows.find((x) => x.id === 2)).toMatchObject({ statusLabel: 'Отменена', debt: 15000 })
  })

  it('снятая галочка «Отменена» убирает их обратно — поведение до волны 5a', async () => {
    const rows = (await dataset()({ ...PERIOD, statuses: ['CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT'] })).rows
    expect(rows.map((x) => x.id)).toEqual([1])
  })

  it('невозвращённая предоплата отменённой брони видна как переплата, а не как долг', async () => {
    const debts = (await dataset()(PERIOD)).rows
    expect(debts.map((x) => x.id)).not.toContain(3)

    const over = (await dataset()({ ...PERIOD, show: 'over' })).rows
    expect(over.map((x) => x.id)).toEqual([3])
    expect(over[0].debt).toBe(-20000)
  })

  it('в самом определении отменённый статус включён по умолчанию', () => {
    const statuses = DEF.params.find((p) => p.key === 'statuses')
    expect(statuses.default).toContain('CANCELLED')
  })
})
