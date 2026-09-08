import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'
import { createFakePrisma, d } from './helpers/fakePrisma.js'

/**
 * Окно «Аудит»: период считается по МЕСТНЫМ суткам отеля (аудит D6-003).
 *
 * Было `new Date(now.getFullYear(), now.getMonth(), now.getDate())` — календарь
 * процесса, а сервер в упаковке стартует с `TZ=UTC`. Итог: с полуночи до пяти
 * утра по Алматы «Сегодня» показывало вчерашний день, а «Месяц», открытый первого
 * числа ночью, — весь прошлый месяц. Ночная смена видела не свои цифры.
 *
 * Вторая половина того же пункта: «Выручка» в этом окне складывалась из
 * `Booking.totalAmount` — кэша, который после волны 5а не является правдой
 * (деньги живут в строках начислений и в журнале платежей). Складывать его
 * по всем броням значит показывать сумму, которой нет ни в кассе, ни в отчётах.
 */

const ALMATY = 'Asia/Almaty'
const iso = (x) => (x === null ? null : x.toISOString())

// 20:20 UTC первого сентября = 01:20 второго сентября по Алматы
const NIGHT = new Date('2026-09-01T20:20:00Z')

const load = () => loadCjs('src/utils/auditPeriod.js', {
  stubs: { './hotelTz': loadCjs('src/utils/hotelTz.js', { stubs: { './logger': silentLogger } }) },
})

describe('auditPeriodRange — граница периода по местным суткам', () => {
  it('«Сегодня» в 01:20 по Алматы — это сегодняшние местные сутки, а не вчерашние', () => {
    const { auditPeriodRange } = load()
    expect(iso(auditPeriodRange('today', NIGHT, ALMATY).from)).toBe('2026-09-01T19:00:00.000Z')
  })

  it('«Месяц» ночью первого числа — это новый месяц, а не весь прошлый', () => {
    const { auditPeriodRange } = load()
    // 20:00 UTC 31 августа = 01:00 первого сентября по Алматы
    const from = auditPeriodRange('month', new Date('2026-08-31T20:00:00Z'), ALMATY).from
    expect(iso(from)).toBe('2026-08-31T19:00:00.000Z')
  })

  it('«Месяц» второго сентября — с полуночи первого сентября по местному', () => {
    const { auditPeriodRange } = load()
    expect(iso(auditPeriodRange('month', NIGHT, ALMATY).from)).toBe('2026-08-31T19:00:00.000Z')
  })

  it('«Неделя» — начало местных суток шесть дней назад, а не «минус 168 часов»', () => {
    const { auditPeriodRange } = load()
    expect(iso(auditPeriodRange('week', NIGHT, ALMATY).from)).toBe('2026-08-26T19:00:00.000Z')
  })

  it('неделя не зависит от часа открытия окна: утро и вечер одних суток дают одну границу', () => {
    const { auditPeriodRange } = load()
    const morning = auditPeriodRange('week', new Date('2026-09-01T20:20:00Z'), ALMATY).from
    const evening = auditPeriodRange('week', new Date('2026-09-02T14:00:00Z'), ALMATY).from
    expect(iso(morning)).toBe(iso(evening))
  })

  it('до местной полуночи «Сегодня» — ещё прошлые сутки', () => {
    const { auditPeriodRange } = load()
    const from = auditPeriodRange('today', new Date('2026-09-01T18:59:59Z'), ALMATY).from
    expect(iso(from)).toBe('2026-08-31T19:00:00.000Z')
  })

  it('в UTC тот же момент даёт другую границу — зона действительно учитывается', () => {
    const { auditPeriodRange } = load()
    expect(iso(auditPeriodRange('today', NIGHT, 'UTC').from)).toBe('2026-09-01T00:00:00.000Z')
  })

  it('неизвестный период — без нижней границы', () => {
    const { auditPeriodRange } = load()
    expect(auditPeriodRange('квартал', NIGHT, ALMATY)).toEqual({ from: null })
    expect(auditPeriodRange(undefined, NIGHT, ALMATY)).toEqual({ from: null })
  })
})

// ─── Ответ роута ─────────────────────────────────────────────────────────────

const bookingRow = (id, over = {}) => ({
  id,
  status: 'CONFIRMED',
  shiftId: 1,
  totalAmount: 100000,
  prepaidAmount: 50000,
  paidAmount: 50000,
  createdAt: new Date('2026-09-01T20:00:00Z'),
  ...over,
})

/** Роут поднимается без сервера: из Router достаём сам обработчик GET /. */
function auditRoute(rows) {
  const { prisma, calls } = createFakePrisma({ booking: rows })
  const pass = (_req, _res, next) => next()
  const router = loadCjs('src/routes/audit.js', {
    stubs: {
      '../middleware/auth': { authenticate: pass, requireRole: () => pass },
      '../utils/prisma': { prisma },
      '../utils/logger': silentLogger,
    },
  })
  const layer = router.stack.find((l) => l.route && l.route.path === '/' && l.route.methods.get)
  if (!layer) throw new Error('в routes/audit.js нет GET / — изменился контракт роута')
  const handler = layer.route.stack[layer.route.stack.length - 1].handle

  const call = (query = {}) => {
    const out = { status: 200, body: null }
    const res = {
      status(code) { out.status = code; return res },
      json(payload) { out.body = payload; return res },
    }
    const next = (err) => { out.status = err.status || 500; out.body = { error: err.message, stack: err.stack } }
    return Promise.resolve(handler({ query, params: {}, admin: { id: 1, role: 'ADMIN' } }, res, next)).then(() => out)
  }
  return { call, calls }
}

const aggregateWhere = (calls) => calls.find((c) => c.model === 'booking' && c.op === 'aggregate').args.where

describe('GET /audit — сводка окна', () => {
  let envBackup
  beforeEach(() => {
    envBackup = process.env.HOTEL_TZ
    process.env.HOTEL_TZ = ALMATY
    vi.useFakeTimers()
    vi.setSystemTime(NIGHT)
  })
  afterEach(() => {
    vi.useRealTimers()
    if (envBackup === undefined) delete process.env.HOTEL_TZ
    else process.env.HOTEL_TZ = envBackup
  })

  it('период «Сегодня» отсекает по началу МЕСТНЫХ суток', async () => {
    const { call, calls } = auditRoute([bookingRow(1)])
    await call({ period: 'today' })
    expect(iso(aggregateWhere(calls).createdAt.gte)).toBe('2026-09-01T19:00:00.000Z')
  })

  it('период «Месяц» — с первого числа местного месяца', async () => {
    const { call, calls } = auditRoute([bookingRow(1)])
    await call({ period: 'month' })
    expect(iso(aggregateWhere(calls).createdAt.gte)).toBe('2026-08-31T19:00:00.000Z')
  })

  it('бронь, заведённая в 01:20 по местному, попадает в «Сегодня»', async () => {
    const { call } = auditRoute([bookingRow(1, { createdAt: new Date('2026-09-01T20:20:00Z') })])
    const res = await call({ period: 'today' })
    expect(res.status).toBe(200)
    expect(res.body.data.bookingCount).toBe(1)
  })

  it('в ответе нет «Выручки» из кэша totalAmount — эта сумма больше не правда', async () => {
    const { call } = auditRoute([bookingRow(1)])
    const res = await call({ period: 'today' })
    expect(res.status).toBe(200)
    expect('totalAmount' in res.body.data).toBe(false)
  })

  it('денег в окне не осталось вовсе: их спрашивают у кассы и отчётов', async () => {
    const { call } = auditRoute([bookingRow(1)])
    const res = await call({ period: 'today' })
    const money = Object.keys(res.body.data).filter((k) => /amount|paid|debt|prepaid/i.test(k))
    expect(money).toEqual([])
  })

  it('отменённые брони в сводку не входят', async () => {
    const { call, calls } = auditRoute([bookingRow(1), bookingRow(2, { status: 'CANCELLED' })])
    const res = await call({ period: 'today' })
    expect(aggregateWhere(calls).status).toEqual({ not: 'CANCELLED' })
    expect(res.body.data.bookingCount).toBe(1)
  })

  it('смена важнее периода: указан shiftId — фильтра по дате нет', async () => {
    const { call, calls } = auditRoute([bookingRow(1, { shiftId: 5 })])
    await call({ period: 'today', shiftId: '5' })
    const where = aggregateWhere(calls)
    expect(where.shiftId).toBe(5)
    expect('createdAt' in where).toBe(false)
  })

  it('без периода границы нет — считается всё', async () => {
    const { call, calls } = auditRoute([bookingRow(1, { createdAt: d('2020-01-01') })])
    const res = await call({})
    expect('createdAt' in aggregateWhere(calls)).toBe(false)
    expect(res.body.data.bookingCount).toBe(1)
  })
})
