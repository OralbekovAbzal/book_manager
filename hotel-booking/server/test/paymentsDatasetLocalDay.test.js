import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'
import { d } from './helpers/fakePrisma.js'

/**
 * Датасет «Платежи»: сутки приёма считаются по времени отеля (D4-004 / D6-003).
 *
 * У платежа есть ДВЕ даты, и путать их нельзя:
 *  • `businessDate` — рабочая дата смены, поле `@db.Date`. По ней закрывается
 *    касса, и именно она попадает в колонку «Дата кассы»;
 *  • `paidAt` — момент приёма. У платежей из старых выгрузок смены нет вовсе,
 *    и тогда отбор идёт по нему.
 *
 * Сервер живёт в UTC, отель — в UTC+5: приём в 01:20 ночи по местному времени
 * это 20:20 предыдущего дня по UTC. Пока отбор шёл по UTC-суткам, ночной платёж
 * уезжал в предыдущий день. Здесь проверяются края этого перевода — и то, что
 * ОТБОР и ПОДПИСЬ строки говорят об одном и том же дне.
 */

const ALMATY = 'Asia/Almaty'

let envBackup
beforeEach(() => {
  envBackup = { HOTEL_TZ: process.env.HOTEL_TZ, BACKUP_TZ: process.env.BACKUP_TZ }
  process.env.HOTEL_TZ = ALMATY
  delete process.env.BACKUP_TZ
})
afterEach(() => {
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

const bookingOf = () => ({
  guestName: 'Гость', guestPhone: '', checkIn: d('2026-09-01'), checkOut: d('2026-09-03'),
  status: 'CHECKED_OUT',
  room: { number: '12', building: 'A', category: { name: 'Комфорт' } },
  partner: null,
})

const paymentRow = (id, over = {}) => ({
  id, bookingId: 1, kind: 'payment', amount: 10000, method: 'cash',
  adminName: 'Админ', shiftId: 1, businessDate: d('2026-09-01'),
  paidAt: new Date('2026-09-01T06:00:00Z'),
  comment: null, refundOfId: null, voidedAt: null, voidReason: null,
  voidedBy: null, booking: bookingOf(), ...over,
})

/** Датасет с подменённой базой: `where` запоминается, отбор считается честно. */
function dataset(rows) {
  const seen = {}
  const hotelTz = loadCjs('src/utils/hotelTz.js', { stubs: { './logger': silentLogger } })
  const prisma = {
    payment: {
      async findMany(args) {
        seen.where = args.where
        const [byShift, byMoment] = args.where.OR
        return rows.filter((r) => {
          if (r.businessDate) {
            return r.businessDate >= byShift.businessDate.gte && r.businessDate < byShift.businessDate.lt
          }
          const c = byMoment.paidAt
          return (!c.gte || r.paidAt >= c.gte) && (!c.lt || r.paidAt < c.lt)
        })
      },
    },
  }
  const ds = loadCjs('src/reports/datasets/payments.js', {
    stubs: { '../../utils/prisma': { prisma }, '../../utils/hotelTz': hotelTz },
  })
  return { ds, seen }
}

// Сентябрь 2026 в том виде, в каком период отдаёт движок: [01.09, 01.10)
const PERIOD = { from: d('2026-09-01'), to: d('2026-10-01') }
const loadRows = (rows, period = PERIOD) => {
  const { ds, seen } = dataset(rows)
  return ds.load({ params: { period } }).then((out) => ({ out, seen }))
}

describe('отбор платежей без смены — по местным суткам', () => {
  it('нижняя граница по paidAt — местная полночь первого дня периода', async () => {
    const { seen } = await loadRows([])
    expect(seen.where.OR[1].paidAt.gte.toISOString()).toBe('2026-08-31T19:00:00.000Z')
  })

  it('верхняя граница включает последний день целиком', async () => {
    const { seen } = await loadRows([])
    expect(seen.where.OR[1].paidAt.lt.toISOString()).toBe('2026-09-30T19:00:00.000Z')
  })

  it('отбор по рабочей дате остался UTC-полуночами: это поле @db.Date', async () => {
    const { seen } = await loadRows([])
    expect(seen.where.OR[0].businessDate).toEqual({ gte: PERIOD.from, lt: PERIOD.to })
  })

  it('приём в 01:20 первого сентября по местному попадает в сентябрь', async () => {
    const { out } = await loadRows([
      paymentRow(1, { businessDate: null, shiftId: null, paidAt: new Date('2026-08-31T20:20:00Z') }),
    ])
    expect(out.map((r) => r.id)).toEqual([1])
  })

  it('приём в 23:40 тридцать первого августа по местному в сентябрь не попадает', async () => {
    const { out } = await loadRows([
      paymentRow(1, { businessDate: null, shiftId: null, paidAt: new Date('2026-08-31T18:40:00Z') }),
    ])
    expect(out).toEqual([])
  })

  it('приём в 00:10 первого октября по местному в сентябрь не попадает', async () => {
    const { out } = await loadRows([
      paymentRow(1, { businessDate: null, shiftId: null, paidAt: new Date('2026-09-30T19:10:00Z') }),
    ])
    expect(out).toEqual([])
  })

  it('приём в 23:50 тридцатого сентября по местному ещё в сентябре', async () => {
    const { out } = await loadRows([
      paymentRow(1, { businessDate: null, shiftId: null, paidAt: new Date('2026-09-30T18:50:00Z') }),
    ])
    expect(out.map((r) => r.id)).toEqual([1])
  })
})

describe('колонка «Календарная дата приёма» — тоже по местным суткам', () => {
  it('ночной приём подписан наступившим днём, а не вчерашним', async () => {
    const { out } = await loadRows([
      paymentRow(1, { paidAt: new Date('2026-08-31T20:20:00Z') }),
    ])
    expect(out[0].paidDate).toBe('2026-09-01')
  })

  it('дневной приём подписан своим днём', async () => {
    const { out } = await loadRows([paymentRow(1, { paidAt: new Date('2026-09-01T06:00:00Z') })])
    expect(out[0].paidDate).toBe('2026-09-01')
  })

  it('дата кассы у платежа со сменой берётся из смены, а не из часов', async () => {
    const { out } = await loadRows([
      paymentRow(1, { businessDate: d('2026-09-01'), paidAt: new Date('2026-09-01T20:20:00Z') }),
    ])
    // Ночной приём в конце смены — это всё ещё её день
    expect(out[0].businessDate).toBe('2026-09-01')
    expect(out[0].paidDate).toBe('2026-09-02')
  })
})

describe('платёж без смены: отбор и подпись строки должны говорить об одном дне', () => {
  const nightPayment = () => [
    paymentRow(1, {
      businessDate: null, shiftId: null,
      // 01:20 первого сентября по Алматы
      paidAt: new Date('2026-08-31T20:20:00Z'),
    }),
  ]

  it('дата кассы платежа без смены должна считаться так же, как отбор', async () => {
    // Иначе отчёт «Касса за сентябрь» покажет строку с датой 31 августа, а
    // группировка по месяцу выделит для неё отдельную августовскую группу
    // внутри сентябрьского отчёта.
    const { out } = await loadRows(nightPayment())
    expect(out[0].businessDate).toBe('2026-09-01')
  })

  it('месяц кассы у такого платежа тоже должен быть местным', async () => {
    const { out } = await loadRows(nightPayment())
    expect(out[0].businessMonth).toBe('2026-09')
  })

  it('у платежа СО сменой такого расхождения нет — там дата берётся из поля', async () => {
    const { out } = await loadRows([
      paymentRow(1, { businessDate: d('2026-09-01'), paidAt: new Date('2026-08-31T20:20:00Z') }),
    ])
    expect(out[0].businessDate).toBe('2026-09-01')
    expect(out[0].businessMonth).toBe('2026-09')
  })
})
