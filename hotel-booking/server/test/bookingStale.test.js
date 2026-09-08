import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { loadCjs, SERVER_ROOT } from './helpers/loadCjs.js'
import { makeStack, booking, charge, d } from './helpers/bookingStack.js'

/**
 * Одновременная правка одной брони (аудит D7-010).
 *
 * Двое администраторов открыли одну бронь. Первый поменял даты, второй — телефон
 * и сохранил на минуту позже: его форма несла СТАРЫЕ даты, и правка первого
 * молча исчезала. Ни ошибки, ни следа — расхождение замечали через день, когда
 * гость приезжал не в тот номер.
 *
 * Лечится отметкой версии: клиент присылает `expectedUpdatedAt` — время записи,
 * которое он показывает. Разошлось с базой — 409 и просьба перечитать, а не тихая
 * перезапись. Здесь проверяется и сама функция сравнения (границы в миллисекунды
 * и разные типы), и то, что при 409 запись НЕ происходит.
 */

const runReq = (handler, { body = {}, params = {}, query = {}, admin = { id: 1, name: 'Админ', role: 'ADMIN' } } = {}) => {
  const out = { status: 200, body: null }
  const res = {
    status(code) { out.status = code; return res },
    json(payload) { out.body = payload; return res },
  }
  // Свой next вместо helpers/bookingStack.run: тому важен только текст ошибки,
  // а здесь проверяются машиночитаемый `code` и приложенная бронь.
  const next = (err) => {
    out.status = err.status || 500
    out.body = { error: err.message }
    if (err.code) out.body.code = err.code
    if (err.booking) out.body.booking = err.booking
    if (err.data) out.body.data = err.data
    if (!err.status) out.body.stack = err.stack
  }
  return Promise.resolve(handler({ body, params, query, admin }, res, next)).then(() => out)
}

/** `isStale` живёт либо в utils/bookingVersion.js, либо в экспортах контроллера. */
function loadIsStale() {
  const rel = 'src/utils/bookingVersion.js'
  if (fs.existsSync(path.join(SERVER_ROOT, rel))) {
    const mod = loadCjs(rel)
    if (typeof mod.isStale === 'function') return mod.isStale
  }
  const { ctrl } = makeStack()
  if (typeof ctrl.isStale === 'function') return ctrl.isStale
  throw new Error('isStale() нет ни в utils/bookingVersion.js, ни в экспортах bookingController — контракт волны «Отчёты и клиент»')
}

const UPDATED_AT = new Date('2026-07-05T10:20:30.123Z')

const scene = () => makeStack({
  // `services: []` — ответ на 409 отдаёт бронь тем же select, что GET /bookings/:id,
  // а он включает связь услуг; фикстуре стенда её обычно не нужно.
  bookings: [booking({ id: 7, updatedAt: UPDATED_AT, guestPhone: '+77010000001', services: [] })],
  charges: [charge({ id: 1, bookingId: 7, amount: 90000, unitPrice: 90000, date: d('2026-07-10') })],
})

const bookingWrites = (calls) =>
  calls.filter((c) => c.model === 'booking' && ['update', 'updateMany', 'delete', 'create'].includes(c.op))

describe('isStale — сравнение версии брони', () => {
  it('клиент без отметки версии не считается устаревшим: старая форма должна работать', () => {
    const isStale = loadIsStale()
    expect(isStale(undefined, UPDATED_AT)).toBe(false)
    expect(isStale(null, UPDATED_AT)).toBe(false)
  })

  it('один и тот же момент строкой и датой — не устарел', () => {
    const isStale = loadIsStale()
    expect(isStale(UPDATED_AT.toISOString(), UPDATED_AT)).toBe(false)
    expect(isStale(new Date(UPDATED_AT.getTime()), UPDATED_AT)).toBe(false)
  })

  it('разница в одну миллисекунду — уже устарел: между сохранениями проходит меньше секунды', () => {
    const isStale = loadIsStale()
    expect(isStale(new Date(UPDATED_AT.getTime() - 1).toISOString(), UPDATED_AT)).toBe(true)
    expect(isStale(new Date(UPDATED_AT.getTime() + 1).toISOString(), UPDATED_AT)).toBe(true)
  })

  it('невалидная отметка считается устаревшей — сомнение решается в пользу отказа', () => {
    const isStale = loadIsStale()
    expect(isStale('вчера', UPDATED_AT)).toBe(true)
    expect(isStale('2026-13-45T99:99:99Z', UPDATED_AT)).toBe(true)
  })
})

describe('PUT /bookings/:id с разошедшейся версией', () => {
  it('отвечает 409 с кодом BOOKING_STALE и самой бронью', async () => {
    const st = scene()
    const res = await runReq(st.ctrl.update, {
      params: { id: '7' },
      body: {
        expectedUpdatedAt: new Date(UPDATED_AT.getTime() - 1000).toISOString(),
        guestPhone: '+77019999999',
      },
    })

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('BOOKING_STALE')
    expect(res.body.booking.id).toBe(7)
  })

  it('не пишет в базу: телефон в брони остался прежним', async () => {
    const st = scene()
    await runReq(st.ctrl.update, {
      params: { id: '7' },
      body: {
        expectedUpdatedAt: new Date(UPDATED_AT.getTime() - 1000).toISOString(),
        guestPhone: '+77019999999',
      },
    })

    expect(bookingWrites(st.calls)).toEqual([])
    expect(st.prisma.booking.rows[0].guestPhone).toBe('+77010000001')
  })

  it('не рассылает событие по сокету — чужие экраны не должны дёрнуться из-за отказа', async () => {
    const st = scene()
    await runReq(st.ctrl.update, {
      params: { id: '7' },
      body: { expectedUpdatedAt: '2026-07-05T10:20:29.000Z', guestPhone: '+77019999999' },
    })
    expect(st.emitted).toEqual([])
  })

  it('расхождение в одну миллисекунду тоже останавливает сохранение', async () => {
    const st = scene()
    const res = await runReq(st.ctrl.update, {
      params: { id: '7' },
      body: {
        expectedUpdatedAt: new Date(UPDATED_AT.getTime() - 1).toISOString(),
        guestPhone: '+77019999999',
      },
    })
    expect(res.status).toBe(409)
    expect(st.prisma.booking.rows[0].guestPhone).toBe('+77010000001')
  })
})

describe('PUT /bookings/:id с той же версией', () => {
  it('совпавшая отметка пропускает правку', async () => {
    const st = scene()
    const res = await runReq(st.ctrl.update, {
      params: { id: '7' },
      body: { expectedUpdatedAt: UPDATED_AT.toISOString(), guestPhone: '+77019999999' },
    })

    expect(res.status).toBe(200)
    expect(st.prisma.booking.rows[0].guestPhone).toBe('+77019999999')
  })

  it('запрос без отметки версии сохраняет как раньше', async () => {
    const st = scene()
    const res = await runReq(st.ctrl.update, {
      params: { id: '7' },
      body: { guestPhone: '+77019999999' },
    })

    expect(res.status).toBe(200)
    expect(st.prisma.booking.rows[0].guestPhone).toBe('+77019999999')
  })

  it('несуществующая бронь — по-прежнему 404, а не 409', async () => {
    const st = scene()
    const res = await runReq(st.ctrl.update, {
      params: { id: '999' },
      body: { expectedUpdatedAt: UPDATED_AT.toISOString() },
    })
    expect(res.status).toBe(404)
  })
})
