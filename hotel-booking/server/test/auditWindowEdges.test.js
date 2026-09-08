import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'
import { createFakePrisma } from './helpers/fakePrisma.js'

/**
 * Окно «Аудит» — края периода и разбор параметров (второй заход волны).
 *
 * `auditPeriod.test.js` проверяет главное: границы считаются по местным суткам.
 * Здесь — то, что вокруг них:
 *
 *  • «Неделя», перешагивающая границу месяца и года: неделя строится через
 *    `Date.UTC(y, m - 1, d - 6)`, то есть арифметикой по компонентам даты, а
 *    не вычитанием миллисекунд. Такая арифметика верна только потому, что
 *    `Date.UTC` донормализует отрицательный день месяца — это стоит закрепить
 *    тестом, иначе «неделя» первого января молча уедет в 0 января;
 *  • високосный год;
 *  • `shiftId` вместе с `period` — кто кого перебивает;
 *  • `shiftId` мусором: в `where` уходит `NaN`.
 */

const ALMATY = 'Asia/Almaty'
const iso = (x) => (x === null ? null : x.toISOString())

const load = () => loadCjs('src/utils/auditPeriod.js', {
  stubs: { './hotelTz': loadCjs('src/utils/hotelTz.js', { stubs: { './logger': silentLogger } }) },
})

describe('«Неделя» через границы месяца и года', () => {
  it('второго января неделя начинается в прошлом году', () => {
    const { auditPeriodRange } = load()
    // 2027-01-02 05:00 по Алматы = 2027-01-01 23:00 UTC
    const from = auditPeriodRange('week', new Date('2027-01-01T23:00:00Z'), ALMATY).from
    // Шесть суток назад — 27 декабря; его местная полночь = 26.12 19:00 UTC
    expect(iso(from)).toBe('2026-12-26T19:00:00.000Z')
  })

  it('первого января неделя начинается 26 декабря, а не «нулевого января»', () => {
    const { auditPeriodRange } = load()
    const from = auditPeriodRange('week', new Date('2027-01-01T05:00:00Z'), ALMATY).from
    expect(iso(from)).toBe('2026-12-25T19:00:00.000Z')
  })

  it('третьего марта високосного года неделя дотягивается до 26 февраля', () => {
    const { auditPeriodRange } = load()
    const from = auditPeriodRange('week', new Date('2028-03-03T05:00:00Z'), ALMATY).from
    // 2028 високосный: 3 марта − 6 суток = 26 февраля
    expect(iso(from)).toBe('2028-02-25T19:00:00.000Z')
  })

  it('третьего марта обычного года неделя дотягивается до 25 февраля', () => {
    const { auditPeriodRange } = load()
    const from = auditPeriodRange('week', new Date('2026-03-03T05:00:00Z'), ALMATY).from
    expect(iso(from)).toBe('2026-02-24T19:00:00.000Z')
  })

  it('первого числа «Месяц» и «Сегодня» совпадают — это один и тот же день', () => {
    const { auditPeriodRange } = load()
    const now = new Date('2026-09-01T05:00:00Z')
    expect(iso(auditPeriodRange('month', now, ALMATY).from))
      .toBe(iso(auditPeriodRange('today', now, ALMATY).from))
  })

  it('«Неделя» всегда захватывает ровно семь местных суток вместе с текущими', () => {
    const { auditPeriodRange } = load()
    const now = new Date('2026-09-09T05:00:00Z')
    const week = auditPeriodRange('week', now, ALMATY).from
    const today = auditPeriodRange('today', now, ALMATY).from
    expect((today - week) / 86400000).toBe(6)
  })

  it('в зоне с переводом часов неделя всё равно семь суток, а не 168 часов', () => {
    const { auditPeriodRange } = load()
    // Берлин, 29 марта 2026 переход вперёд. Считаем от 1 апреля.
    const week = auditPeriodRange('week', new Date('2026-04-01T10:00:00Z'), 'Europe/Berlin').from
    const today = auditPeriodRange('today', new Date('2026-04-01T10:00:00Z'), 'Europe/Berlin').from
    // Шесть суток, одни из которых были 23-часовыми → 143 часа, а не 144
    expect((today - week) / 3600000).toBe(143)
  })

  it('пустая строка вместо периода — без границы, как и незнакомое слово', () => {
    const { auditPeriodRange } = load()
    expect(auditPeriodRange('', new Date(), ALMATY)).toEqual({ from: null })
    expect(auditPeriodRange('shift', new Date(), ALMATY)).toEqual({ from: null })
  })
})

// ─── Роут ────────────────────────────────────────────────────────────────────

const bookingRow = (id, over = {}) => ({
  id,
  status: 'CONFIRMED',
  shiftId: 1,
  createdAt: new Date('2026-09-09T05:00:00Z'),
  ...over,
})

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
  const handler = layer.route.stack[layer.route.stack.length - 1].handle

  const call = (query = {}) => {
    const out = { status: 200, body: null }
    const res = {
      status(code) { out.status = code; return res },
      json(payload) { out.body = payload; return res },
    }
    const next = (err) => { out.status = err.status || 500; out.body = { error: err.message } }
    return Promise.resolve(handler({ query, params: {}, admin: { id: 1, role: 'ADMIN' } }, res, next)).then(() => out)
  }
  return { call, calls }
}

const aggregateWhere = (calls) => calls.find((c) => c.model === 'booking' && c.op === 'aggregate').args.where

describe('GET /audit — смена и период вместе', () => {
  let envBackup
  beforeEach(() => {
    envBackup = process.env.HOTEL_TZ
    process.env.HOTEL_TZ = ALMATY
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-09T05:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
    if (envBackup === undefined) delete process.env.HOTEL_TZ
    else process.env.HOTEL_TZ = envBackup
  })

  it('указаны и смена, и период — побеждает смена, границы по дате нет', async () => {
    const { call, calls } = auditRoute([bookingRow(1), bookingRow(2, { shiftId: 2 })])
    const res = await call({ period: 'today', shiftId: '2' })
    const where = aggregateWhere(calls)
    expect(where.shiftId).toBe(2)
    expect(where.createdAt).toBeUndefined()
    expect(res.body.data.bookingCount).toBe(1)
  })

  it('граница периода должна быть пустой, раз период не применялся', async () => {
    const { call } = auditRoute([bookingRow(1)])
    const res = await call({ period: 'month', shiftId: '1' })
    // `period` в ответе заведён ради подписи «за какой отрезок эти числа».
    // Отдавая границу, которая в запросе не участвовала, сервер подписывает
    // цифры смены месяцем.
    expect(res.body.data.period.from).toBe(null)
  })

  it('период возвращается вместе с зоной — экрану есть чем подписать цифры', async () => {
    const { call } = auditRoute([bookingRow(1)])
    const res = await call({ period: 'today' })
    expect(res.body.data.period.tz).toBe(ALMATY)
    expect(res.body.data.period.from).toBe('2026-09-08T19:00:00.000Z')
    expect(res.body.data.period.to).toBe(null)
  })

  it('незнакомый период считает всё и границы не ставит — как было до правки', async () => {
    const { call, calls } = auditRoute([
      bookingRow(1, { createdAt: new Date('2020-01-01T00:00:00Z') }),
      bookingRow(2),
    ])
    const res = await call({ period: 'квартал' })
    expect(aggregateWhere(calls).createdAt).toBeUndefined()
    expect(res.body.data.bookingCount).toBe(2)
  })

  it('отменённые не считаются ни при каком периоде', async () => {
    const { call } = auditRoute([bookingRow(1), bookingRow(2, { status: 'CANCELLED' })])
    const res = await call({ period: 'today' })
    expect(res.body.data.bookingCount).toBe(1)
  })

  it('shiftId=abc должен отвергаться параметром, а не уходить в запрос', async () => {
    const { call } = auditRoute([bookingRow(1)])
    const res = await call({ shiftId: 'abc' })
    expect(res.status).toBe(400)
  })

  it('shiftId=0 — это смена номер ноль, а не «смены нет»', async () => {
    const { call, calls } = auditRoute([bookingRow(1, { shiftId: 0 })])
    await call({ period: 'today', shiftId: '0' })
    // `if (shiftId)` на строке '0' истинно — и это правильно: '0' непустая строка
    expect(aggregateWhere(calls).shiftId).toBe(0)
    expect(aggregateWhere(calls).createdAt).toBeUndefined()
  })
})
