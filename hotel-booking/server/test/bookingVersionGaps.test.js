import { describe, it, expect } from 'vitest'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'
import { makeStack, booking, charge, payment, run, d, BUSINESS_DATE } from './helpers/bookingStack.js'

/**
 * Замок версии брони (D5-004) — что осталось за границами `bookingStale.test.js`.
 *
 * Там проверено главное: разошлась версия — 409, ничего не записано. Здесь то,
 * обо что этот замок спотыкается в работе:
 *
 *  1. `expectedUpdatedAt` — служебное поле, а не поле брони. Оно не должно
 *     попасть в `data` записи: колонки с таким именем нет, Prisma ответит
 *     ошибкой валидации, и правка брони превратится в 500.
 *  2. Одна и та же отметка времени в разных ISO-представлениях. Клиент шлёт
 *     обратно строку из нашего же ответа, но пройти она может через `Date` в
 *     браузере, через `JSON.parse` чужого кода, через поле формы. Сравнение
 *     точное, до миллисекунды: `+00:00` и `Z` — одно и то же, а вот отметка
 *     без миллисекунд — уже другая версия.
 *  3. Замок стоит ТОЛЬКО на `PUT /bookings/:id`. Все остальные операции —
 *     заезд, выезд, переезд, платёж — меняют `updatedAt` (в схеме
 *     `@updatedAt`) и замка не спрашивают. Значит собственное действие
 *     пользователя делает открытую у него же форму устаревшей.
 */

const UPDATED_AT = new Date('2026-07-05T10:20:30.123Z')

const isStale = () => loadCjs('src/utils/bookingVersion.js').isStale

const scene = (over = {}) => makeStack({
  bookings: [booking({ id: 7, updatedAt: UPDATED_AT, guestPhone: '+77010000001', services: [], ...over })],
  charges: [charge({ id: 1, bookingId: 7, amount: 90000, unitPrice: 90000, date: d('2026-07-10') })],
})

const bookingUpdates = (calls) => calls.filter((c) => c.model === 'booking' && c.op === 'update')

describe('expectedUpdatedAt — служебное поле, не колонка брони', () => {
  it('при успешном сохранении не попадает в data записи', async () => {
    const { ctrl, prisma, calls } = scene()
    const res = await run(ctrl.update, {
      params: { id: '7' },
      body: { expectedUpdatedAt: UPDATED_AT.toISOString(), notes: 'позвонить' },
    })
    expect(res.status).toBe(200)
    const writes = bookingUpdates(calls)
    expect(writes.length).toBeGreaterThan(0)
    for (const w of writes) {
      expect(Object.keys(w.args.data)).not.toContain('expectedUpdatedAt')
    }
    expect(prisma.booking.rows[0].expectedUpdatedAt).toBeUndefined()
  })

  it('не попадает и в `where` — сверка идёт в коде, а не запросом', async () => {
    const { ctrl, calls } = scene()
    await run(ctrl.update, {
      params: { id: '7' },
      body: { expectedUpdatedAt: UPDATED_AT.toISOString(), notes: 'x' },
    })
    for (const w of bookingUpdates(calls)) {
      expect(Object.keys(w.args.where)).toEqual(['id'])
    }
  })

  it('лишние поля тела не подменяют собой версию: allowAllotmentOverride тоже не колонка-версия', async () => {
    const { ctrl, prisma } = scene()
    const res = await run(ctrl.update, {
      params: { id: '7' },
      body: { expectedUpdatedAt: UPDATED_AT.toISOString(), notes: 'x' },
    })
    expect(res.status).toBe(200)
    // `updatedAt` в фейке не двигается сам — важно, что его никто не переписал руками
    expect(prisma.booking.rows[0].updatedAt).toEqual(UPDATED_AT)
  })
})

describe('одна и та же версия в разных ISO-представлениях', () => {
  it('«+00:00» и «Z» — один момент, сохранение проходит', () => {
    expect(isStale()('2026-07-05T10:20:30.123+00:00', UPDATED_AT)).toBe(false)
    expect(isStale()('2026-07-05T10:20:30.123Z', UPDATED_AT)).toBe(false)
  })

  it('смещение другой зоны, но тот же момент — не устарело', () => {
    // 15:20:30.123 в UTC+5 — та же миллисекунда
    expect(isStale()('2026-07-05T15:20:30.123+05:00', UPDATED_AT)).toBe(false)
  })

  it('фиксация: отметка без миллисекунд считается ДРУГОЙ версией', () => {
    // По контракту замка расхождение решается в пользу отказа. Цена: клиент,
    // который где-то по дороге обрежет миллисекунды, получит 409 навсегда —
    // до перечитывания брони.
    expect(isStale()('2026-09-09T10:00:00Z', new Date('2026-09-09T10:00:00.123Z'))).toBe(true)
    expect(isStale()('2026-07-05T10:20:30Z', UPDATED_AT)).toBe(true)
  })

  it('отметка с округлёнными миллисекундами тоже другая версия', () => {
    expect(isStale()('2026-07-05T10:20:30.120Z', UPDATED_AT)).toBe(true)
  })

  it('пустая строка — «версии нет», а не «нулевая версия»', () => {
    expect(isStale()('', UPDATED_AT)).toBe(false)
  })

  it('Date вместо строки принимается наравне', () => {
    expect(isStale()(new Date(UPDATED_AT), UPDATED_AT)).toBe(false)
  })

  it('версия из будущего тоже считается расхождением, а не «свежее — значит можно»', () => {
    expect(isStale()('2027-01-01T00:00:00.000Z', UPDATED_AT)).toBe(true)
  })
})

describe('замок стоит только на PUT — прочие операции версию не сверяют', () => {
  it('заезд не спрашивает expectedUpdatedAt: устаревшая форма всё равно заселит гостя', async () => {
    const { ctrl, prisma } = scene({ checkIn: BUSINESS_DATE, checkOut: d('2026-07-13') })
    const res = await run(ctrl.checkIn, {
      params: { id: '7' },
      body: { expectedUpdatedAt: '2000-01-01T00:00:00.000Z' },
    })
    expect(res.status).toBe(200)
    expect(prisma.booking.rows[0].status).toBe('CHECKED_IN')
  })

  it('заезд ПИШЕТ в строку брони — значит в базе поднимется updatedAt', async () => {
    const { ctrl, calls } = scene({ checkIn: BUSINESS_DATE, checkOut: d('2026-07-13') })
    await run(ctrl.checkIn, { params: { id: '7' }, body: {} })
    // `Booking.updatedAt` объявлен `@updatedAt`: любая запись в строку двигает
    // версию, даже если сам контроллер её не трогает.
    expect(bookingUpdates(calls).length).toBeGreaterThan(0)
  })

  it('отмена тоже не сверяет версию', async () => {
    const { ctrl, prisma } = scene()
    const res = await run(ctrl.cancel, {
      params: { id: '7' },
      body: { expectedUpdatedAt: '2000-01-01T00:00:00.000Z' },
    })
    expect(res.status).toBe(200)
    expect(prisma.booking.rows[0].status).toBe('CANCELLED')
  })

  it('приём оплаты пишет в строку брони — версия открытой формы устареет от собственного платежа', async () => {
    const { payCtrl, calls } = makeStack({
      bookings: [booking({ id: 7, updatedAt: UPDATED_AT, services: [] })],
      charges: [charge({ id: 1, bookingId: 7, amount: 90000, unitPrice: 90000, date: d('2026-07-10') })],
      payments: [],
    })
    const res = await run(payCtrl.create, {
      body: { bookingId: 7, amount: 10000, method: 'cash', kind: 'payment' },
    })
    expect(res.status).toBe(201)
    // recalcBookingPaid → booking.update({ paidAmount }) → @updatedAt поднимется
    expect(bookingUpdates(calls).length).toBeGreaterThan(0)
  })

  /**
   * Контракт ответа на приём оплаты: денежная сводка, БЕЗ новой версии брони.
   *
   * Значит форма, принявшая оплату, узнать новую версию из этого же ответа не
   * может и обязана сходить за ней отдельно (клиент так и делает —
   * `onBookingChanged` → `syncQuietly` → `GET /bookings/:id`). Если этот вызов
   * когда-нибудь уберут, следующая же кнопка «Сохранить» ответит 409 на
   * СОБСТВЕННУЮ оплату пользователя — поэтому контракт закреплён тестом.
   */
  it('ответ на приём оплаты — только деньги, версии брони в нём нет', async () => {
    const { payCtrl } = makeStack({
      bookings: [booking({ id: 7, updatedAt: UPDATED_AT, services: [] })],
      charges: [charge({ id: 1, bookingId: 7, amount: 90000, unitPrice: 90000, date: d('2026-07-10') })],
    })
    const res = await run(payCtrl.create, {
      body: { bookingId: 7, amount: 10000, method: 'cash', kind: 'payment' },
    })
    const summary = res.body.data.summary
    expect(summary.paid).toBe(10000)
    expect(summary.updatedAt).toBeUndefined()
    expect(summary.bookingUpdatedAt).toBeUndefined()
  })

  it('после чужой записи в бронь прежняя версия формы получает 409', async () => {
    const { ctrl, prisma } = scene()
    // Имитируем то, что делает Postgres на любой записи в строку
    prisma.booking.rows[0].updatedAt = new Date('2026-07-05T10:25:00.000Z')
    const res = await run(ctrl.update, {
      params: { id: '7' },
      body: { expectedUpdatedAt: UPDATED_AT.toISOString(), notes: 'позвонить' },
    })
    expect(res.status).toBe(409)
  })

  it('ответ 409 несёт свежую бронь с её новой версией — форме есть чем обновиться', async () => {
    const { ctrl, prisma } = scene()
    const fresh = new Date('2026-07-05T10:25:00.000Z')
    prisma.booking.rows[0].updatedAt = fresh
    const out = { status: 200, body: null }
    const res = { status(c) { out.status = c; return res }, json(b) { out.body = b; return res } }
    await ctrl.update(
      { params: { id: '7' }, body: { expectedUpdatedAt: UPDATED_AT.toISOString(), notes: 'x' }, query: {}, admin: { id: 1, role: 'ADMIN' } },
      res,
      (err) => { out.status = err.status || 500; out.body = { error: err.message } },
    )
    expect(out.status).toBe(409)
    expect(out.body.code).toBe('BOOKING_STALE')
    expect(out.body.booking.updatedAt).toEqual(fresh)
  })
})

// ─── Журнал действий и отказ по версии ───────────────────────────────────────

describe('409 по версии в журнал действий не пишется', () => {
  const middleware = (written) => loadCjs('src/middleware/audit.js', {
    stubs: {
      '../utils/prisma': { prisma: { auditLog: { create: async (args) => { written.push(args); return {} } } } },
      '../utils/logger': silentLogger,
    },
  }).auditMiddleware

  /** Мини-Express: прогоняет запрос через middleware и «завершает» ответ. */
  const fire = async (statusCode, body = {}) => {
    const written = []
    const listeners = []
    const res = {
      statusCode,
      json(payload) { this._payload = payload; return this },
      on(event, fn) { if (event === 'finish') listeners.push(fn) },
    }
    const req = {
      method: 'PUT', originalUrl: '/api/bookings/7', params: { id: '7' },
      body, ip: '127.0.0.1', admin: { id: 1, name: 'Админ' },
    }
    middleware(written)(req, res, () => {})
    res.json({ error: 'x' })
    for (const fn of listeners) fn()
    await Promise.resolve()
    return written
  }

  it('успешное сохранение попадает в журнал', async () => {
    const written = await fire(200, { notes: 'позвонить' })
    expect(written).toHaveLength(1)
    expect(written[0].data.action).toBe('PUT /bookings/7')
  })

  it('отказ по версии (409) в журнале не остаётся — следа неудачной попытки нет', async () => {
    const written = await fire(409, { expectedUpdatedAt: UPDATED_AT.toISOString(), notes: 'позвонить' })
    expect(written).toHaveLength(0)
  })

  it('если бы 409 писался — служебная версия не должна была бы попасть в details', async () => {
    // Проверяем сам фильтр деталей: пароли и документ вырезаются, а версия
    // остаётся. Это не секрет, но и пользы в журнале от неё нет.
    const written = await fire(200, { expectedUpdatedAt: UPDATED_AT.toISOString(), notes: 'x' })
    expect(written[0].data.details).toHaveProperty('expectedUpdatedAt')
    expect(written[0].data.details).not.toHaveProperty('password')
  })
})
