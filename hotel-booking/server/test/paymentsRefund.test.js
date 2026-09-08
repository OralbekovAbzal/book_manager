import { describe, it, expect } from 'vitest'
import {
  makeStack, run, booking, room, charge, payment, d, BUSINESS_DATE,
} from './helpers/bookingStack.js'

/**
 * Волна 5a: «свободный» возврат убран (решение владельца 2026-09-08, аудит D2-001).
 *
 * Раньше `POST /payments` с `kind: 'refund'` создавал возврат без исходного платежа
 * и без лимита — кнопка рядом с «Принять» рисовала в кассе минус при нулевом приходе.
 * Теперь возврат делается только по конкретной записи журнала (`/payments/:id/refund`),
 * и там уже есть проверка остатка.
 *
 * Второй блок — экран «кто должен»: отменённые брони с незакрытыми деньгами обязаны
 * быть видны (невозвращённая предоплата или удержание), а отменённые «в ноль» — нет.
 */

function payScene({ bookings, charges = [], payments = [] } = {}) {
  return makeStack({
    rooms: [room({ id: 101 })],
    bookings,
    charges,
    payments,
  })
}

describe('POST /payments — возврат без исходного платежа запрещён', () => {
  it('kind: refund отвечает 400 и записи в журнале не появляется', async () => {
    const st = payScene({
      bookings: [booking({ id: 7, totalAmount: 100000, paidAmount: 50000 })],
      payments: [payment({ id: 1, bookingId: 7, amount: 50000 })],
    })

    const r = await run(st.payCtrl.create, {
      body: { bookingId: 7, amount: 10000, kind: 'refund', method: 'cash' },
    })

    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/только по конкретному платежу/)
    expect(st.prisma.payment.rows).toHaveLength(1)
    expect(st.prisma.booking.rows[0].paidAmount).toBe(50000)
  })

  it('отказ наступает раньше проверки суммы и способа — мусорный возврат тоже не пройдёт', async () => {
    const st = payScene({ bookings: [booking({ id: 7 })] })
    const r = await run(st.payCtrl.create, {
      body: { bookingId: 7, amount: -1, kind: 'refund', method: 'биткоин' },
    })

    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/только по конкретному платежу/)
    expect(st.prisma.payment.rows).toEqual([])
  })

  it('обычный приём оплаты работает и пересчитывает принятое', async () => {
    const st = payScene({
      bookings: [booking({ id: 7, totalAmount: 100000 })],
      charges: [charge({ id: 1, bookingId: 7, amount: 100000, unitPrice: 100000, date: d('2026-07-10') })],
    })

    const r = await run(st.payCtrl.create, { body: { bookingId: 7, amount: 30000, method: 'card' } })

    expect(r.status).toBe(201)
    expect(r.body.data.summary).toMatchObject({ charged: 100000, paid: 30000, due: 70000 })
    expect(st.prisma.booking.rows[0].paidAmount).toBe(30000)
  })
})

describe('POST /payments/:id/refund — возврат по платежу с лимитом остатка', () => {
  function withPayment() {
    return payScene({
      bookings: [booking({ id: 7, totalAmount: 100000, paidAmount: 50000 })],
      charges: [charge({ id: 1, bookingId: 7, amount: 100000, unitPrice: 100000, date: d('2026-07-10') })],
      payments: [payment({ id: 1, bookingId: 7, amount: 50000 })],
    })
  }

  it('возврат части уменьшает принятое', async () => {
    const st = withPayment()
    const r = await run(st.payCtrl.refund, { params: { id: '1' }, body: { amount: 20000 } })

    expect(r.status).toBe(201)
    expect(r.body.data.payment).toMatchObject({ kind: 'refund', amount: 20000, refundOfId: 1 })
    expect(st.prisma.booking.rows[0].paidAmount).toBe(30000)
  })

  it('остаток считается по уже возвращённому: второй возврат ровно на остаток проходит, третий — 400', async () => {
    const st = withPayment()
    await run(st.payCtrl.refund, { params: { id: '1' }, body: { amount: 20000 } })

    const rest = await run(st.payCtrl.refund, { params: { id: '1' }, body: { amount: 30000 } })
    expect(rest.status).toBe(201)
    expect(st.prisma.booking.rows[0].paidAmount).toBe(0)

    const extra = await run(st.payCtrl.refund, { params: { id: '1' }, body: { amount: 1 } })
    expect(extra.status).toBe(400)
    expect(extra.body.error).toMatch(/уже возвращена вся сумма/)
    expect(st.prisma.payment.rows.filter((p) => p.kind === 'refund')).toHaveLength(2)
  })

  it('вернуть больше принятого нельзя, в тексте — доступный остаток', async () => {
    const st = withPayment()
    const r = await run(st.payCtrl.refund, { params: { id: '1' }, body: { amount: 50001 } })

    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/доступно 50000/)
    expect(st.prisma.payment.rows).toHaveLength(1)
  })

  it('возврат по возврату не делается', async () => {
    const st = withPayment()
    await run(st.payCtrl.refund, { params: { id: '1' }, body: { amount: 10000 } })
    const refundId = st.prisma.payment.rows.find((p) => p.kind === 'refund').id

    const r = await run(st.payCtrl.refund, { params: { id: String(refundId) }, body: {} })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/Нельзя вернуть возврат/)
  })
})

describe('GET /payments/debts — отменённые с незакрытыми деньгами видны', () => {
  /**
   * 41 — живая бронь с долгом, 42 — отменённая с невозвращённой предоплатой,
   * 43 — отменённая начисто (её в списке быть не должно),
   * 44 — отменённая с удержанием по ручной строке.
   */
  function debtsScene() {
    return payScene({
      bookings: [
        booking({ id: 41, status: 'CONFIRMED', checkIn: d('2026-07-10'), checkOut: d('2026-07-13'), totalAmount: 100000, paidAmount: 30000 }),
        booking({ id: 42, status: 'CANCELLED', checkIn: d('2026-07-11'), checkOut: d('2026-07-14'), totalAmount: 0, paidAmount: 20000 }),
        booking({ id: 43, status: 'CANCELLED', checkIn: d('2026-07-12'), checkOut: d('2026-07-15'), totalAmount: 0, paidAmount: 0 }),
        booking({ id: 44, status: 'CANCELLED', checkIn: d('2026-07-13'), checkOut: d('2026-07-16'), totalAmount: 15000, paidAmount: 0 }),
      ],
      charges: [
        charge({ id: 1, bookingId: 41, amount: 100000, unitPrice: 100000, date: d('2026-07-10') }),
        charge({
          id: 2, bookingId: 44, kind: 'extra', label: 'Удержание за отмену',
          amount: 15000, unitPrice: 15000, source: 'manual', reason: 'политика отмены',
        }),
      ],
      payments: [
        payment({ id: 1, bookingId: 41, amount: 30000 }),
        payment({ id: 2, bookingId: 42, amount: 20000 }),
      ],
    })
  }

  it('в списке живой долг, невозвращённая предоплата и удержание — но не пустая отмена', async () => {
    const st = debtsScene()
    const r = await run(st.payCtrl.debts, { query: {} })

    expect(r.status).toBe(200)
    expect(r.body.data.businessDate.getTime()).toBe(BUSINESS_DATE.getTime())
    expect(r.body.data.bookings.map((b) => b.id)).toEqual([41, 42, 44])
  })

  it('у отменённой с предоплатой долг отрицательный — это «к возврату»', async () => {
    const st = debtsScene()
    const r = await run(st.payCtrl.debts, { query: {} })
    const row = r.body.data.bookings.find((b) => b.id === 42)

    expect(row).toMatchObject({ status: 'CANCELLED', charged: 0, paid: 20000, due: -20000 })
  })

  it('у отменённой с удержанием долг положительный', async () => {
    const st = debtsScene()
    const r = await run(st.payCtrl.debts, { query: {} })
    const row = r.body.data.bookings.find((b) => b.id === 44)

    expect(row).toMatchObject({ status: 'CANCELLED', charged: 15000, paid: 0, due: 15000 })
  })

  it('каждая строка несёт статус — иначе отменённую не отличить от живой', async () => {
    const st = debtsScene()
    const r = await run(st.payCtrl.debts, { query: {} })

    for (const row of r.body.data.bookings) expect(typeof row.status).toBe('string')
    expect(r.body.data.bookings.filter((b) => b.status === 'CANCELLED')).toHaveLength(2)
  })

  it('отменённая, выехавшая раньше окна days, в рабочий список не попадает', async () => {
    const st = debtsScene()
    // days=1 → окно с 9 июля; двигаем отменённую 42 в далёкое прошлое
    st.prisma.booking.rows.find((b) => b.id === 42).checkOut = d('2026-05-01')
    const r = await run(st.payCtrl.debts, { query: { days: '1' } })

    expect(r.body.data.bookings.map((b) => b.id)).toEqual([41, 44])
  })
})
