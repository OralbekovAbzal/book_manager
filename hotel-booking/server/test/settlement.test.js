import { describe, it, expect } from 'vitest'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'
import {
  makeSettlementStack, writeOps, dbSnapshot,
  run, booking, room, rate, service, charge, payment, chargesOf, totalOf, d,
} from './helpers/settlementStack.js'

/**
 * Шаг 5a-2, половина вторая: `POST /bookings/:id/settlement` — одно подтверждение
 * вместо четырёх экранов (отменить → посмотреть переплату в кассе → найти приём
 * оплаты → вернуть по нему).
 *
 * Порядок внутри транзакции — не деталь реализации, а деньги:
 *   действие → штраф → возврат. Лимит возврата считается от счёта УЖЕ со штрафом,
 *   иначе удержание можно было бы вернуть гостю тем же нажатием.
 *
 * Возврат кладётся ТОЛЬКО на конкретные приёмы оплаты и только в пределах их
 * остатка (решение владельца 2026-09-08: «свободных» возвратов больше нет),
 * раскладка — от новых приёмов к старым.
 */

const settle = (st, body, id = 7) => run(st.settlement.settle, { params: { id: String(id) }, body })

/**
 * Бронь 10→13 июля, 3 авто-ночи по 30 000. Два приёма оплаты — 30 000 (5 июля)
 * и 20 000 (8 июля), — и по НОВОМУ из них 5 000 уже возвращали.
 * Принято: 30 000 + 20 000 − 5 000 = 45 000.
 */
function twoPaymentsOnePartlyRefunded(over = {}) {
  return makeSettlementStack({
    rooms: [room({ id: 101 })],
    bookings: [booking({ id: 7, status: 'CONFIRMED', totalAmount: 90000, paidAmount: 45000, ...over.bookingOver })],
    charges: [
      charge({ id: 1, bookingId: 7, date: d('2026-07-10'), amount: 30000, unitPrice: 30000 }),
      charge({ id: 2, bookingId: 7, date: d('2026-07-11'), amount: 30000, unitPrice: 30000 }),
      charge({ id: 3, bookingId: 7, date: d('2026-07-12'), amount: 30000, unitPrice: 30000 }),
    ],
    payments: [
      payment({ id: 1, bookingId: 7, amount: 30000, method: 'cash', paidAt: new Date('2026-07-05T10:00:00Z') }),
      payment({ id: 2, bookingId: 7, amount: 20000, method: 'card', paidAt: new Date('2026-07-08T10:00:00Z') }),
      payment({
        id: 3, bookingId: 7, kind: 'refund', amount: 5000, method: 'card',
        refundOfId: 2, paidAt: new Date('2026-07-09T10:00:00Z'),
      }),
    ],
  })
}

describe('settle cancel — отмена + штраф + возврат одной операцией', () => {
  /** Отмена с удержанием 10 000 и возвратом 35 000 (весь остаток переплаты). */
  async function cancelWithPenaltyAndRefund() {
    const st = twoPaymentsOnePartlyRefunded()
    const r = await settle(st, {
      action: 'cancel',
      penalty: { amount: 10000, reason: 'поздняя отмена' },
      refund: { amount: 35000, comment: 'вернули гостю' },
    })
    return { st, r }
  }

  it('статус становится CANCELLED, автоматические строки сняты', async () => {
    const { st, r } = await cancelWithPenaltyAndRefund()

    expect(r.status).toBe(200)
    expect(r.body.data.booking.status).toBe('CANCELLED')
    expect(chargesOf(st.prisma, 7).filter((c) => c.source === 'auto')).toEqual([])
  })

  it('штраф записан ОДНОЙ ручной строкой с причиной и автором', async () => {
    const { st, r } = await cancelWithPenaltyAndRefund()

    const rows = chargesOf(st.prisma, 7)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      bookingId: 7,
      kind: 'extra',
      label: 'Штраф: поздняя отмена',
      quantity: 1,
      unitPrice: 10000,
      amount: 10000,
      date: null,
      source: 'manual',
      reason: 'поздняя отмена',
      createdById: 1,
    })
    expect(r.body.data.penalty).toMatchObject({ label: 'Штраф: поздняя отмена', amount: 10000 })
    expect(totalOf(st.prisma, 7)).toBe(10000)
  })

  it('штраф без причины называется «Удержание», а не пустой строкой', async () => {
    const st = twoPaymentsOnePartlyRefunded()

    await settle(st, { action: 'cancel', penalty: { amount: 7000 } })

    expect(chargesOf(st.prisma, 7)[0]).toMatchObject({ label: 'Удержание', reason: 'Удержание', amount: 7000 })
  })

  it('возврат разложен от НОВОГО приёма к старому и только в пределах остатка каждого', async () => {
    const { st, r } = await cancelWithPenaltyAndRefund()

    // У приёма №2 (8 июля, 20 000) остаток 15 000 — 5 000 уже возвращали.
    // Остаток 20 000 добирается со старого приёма №1.
    expect(r.body.data.refunds.map((p) => ({ refundOfId: p.refundOfId, amount: p.amount, method: p.method })))
      .toEqual([
        { refundOfId: 2, amount: 15000, method: 'card' },
        { refundOfId: 1, amount: 20000, method: 'cash' },
      ])
  })

  it('возвраты сохранены записями журнала: вид, смена, автор, комментарий', async () => {
    const { st } = await cancelWithPenaltyAndRefund()

    const created = st.prisma.payment.rows.filter((p) => p.id > 3)
    expect(created).toHaveLength(2)
    for (const p of created) {
      expect(p).toMatchObject({
        bookingId: 7, kind: 'refund', adminId: 1, adminName: 'Админ',
        shiftId: 1, comment: 'вернули гостю',
      })
      expect(p.refundOfId).not.toBeNull()
    }
  })

  it('способ возврата по умолчанию — способ исходного приёма, но его можно задать явно', async () => {
    const st = twoPaymentsOnePartlyRefunded()

    const r = await settle(st, { action: 'cancel', refund: { amount: 20000, method: 'transfer' } })

    expect(r.body.data.refunds.map((p) => p.method)).toEqual(['transfer', 'transfer'])
  })

  it('сводка сходится: начислено = штраф, принято = оплата минус возвраты, долг = 0', async () => {
    const { st, r } = await cancelWithPenaltyAndRefund()

    expect(r.body.data.summary).toMatchObject({ charged: 10000, paid: 10000, due: 0 })
    expect(st.prisma.booking.rows[0].paidAmount).toBe(10000)
    expect(st.prisma.booking.rows[0].totalAmount).toBe(10000)
  })

  it('события: booking:cancelled и следом booking:updated с новыми деньгами', async () => {
    const { st } = await cancelWithPenaltyAndRefund()

    expect(st.emitted.map((e) => e.event)).toEqual(['booking:cancelled', 'booking:updated'])
    expect(st.emitted[0].payload).toEqual({ bookingId: 7, roomId: 101 })
    expect(st.emitted[1].payload.booking).toMatchObject({ id: 7, status: 'CANCELLED', paidAmount: 10000 })
  })

  it('приёмы одного дня различаются по номеру: возврат начинается с последнего', async () => {
    const sameDay = new Date('2026-07-08T10:00:00Z')
    const st = makeSettlementStack({
      rooms: [room({ id: 101 })],
      bookings: [booking({ id: 7, status: 'CONFIRMED', totalAmount: 0, paidAmount: 50000 })],
      payments: [
        payment({ id: 1, bookingId: 7, amount: 30000, method: 'cash', paidAt: sameDay }),
        payment({ id: 2, bookingId: 7, amount: 20000, method: 'card', paidAt: sameDay }),
      ],
    })

    const r = await settle(st, { action: 'cancel', refund: { amount: 25000 } })

    expect(r.body.data.refunds.map((p) => ({ refundOfId: p.refundOfId, amount: p.amount })))
      .toEqual([{ refundOfId: 2, amount: 20000 }, { refundOfId: 1, amount: 5000 }])
  })

  it('сумма из предпросмотра проходит сохранение ровно и закрывает бронь в ноль', async () => {
    const st = twoPaymentsOnePartlyRefunded()
    const preview = await run(st.settlement.preview, { params: { id: '7' }, body: { action: 'cancel' } })

    const r = await settle(st, { action: 'cancel', refund: { amount: preview.body.data.toReturn } })

    expect(preview.body.data.toReturn).toBe(45000)
    expect(r.status).toBe(200)
    expect(r.body.data.summary).toMatchObject({ charged: 0, paid: 0, due: 0 })
  })

  it('ручная строка, заведённая раньше, отменой не стирается', async () => {
    const st = makeSettlementStack({
      rooms: [room({ id: 101 })],
      bookings: [booking({ id: 7, status: 'CONFIRMED', totalAmount: 34000, paidAmount: 0 })],
      charges: [
        charge({ id: 1, bookingId: 7, date: d('2026-07-10'), amount: 30000, unitPrice: 30000 }),
        charge({
          id: 2, bookingId: 7, kind: 'extra', label: 'Мини-бар', quantity: 1, unitPrice: 4000,
          amount: 4000, source: 'manual', reason: 'выпито из мини-бара',
        }),
      ],
    })

    await settle(st, { action: 'cancel', penalty: { amount: 5000, reason: 'позднее аннулирование' } })

    expect(chargesOf(st.prisma, 7).map((c) => c.label)).toEqual(['Мини-бар', 'Штраф: позднее аннулирование'])
    expect(totalOf(st.prisma, 7)).toBe(9000)
  })
})

describe('settle — лимит возврата', () => {
  it('вернуть больше переплаты нельзя: 400 с суммой, и ничего не записано', async () => {
    const st = makeSettlementStack({
      rooms: [room({ id: 101 })],
      bookings: [booking({ id: 7, status: 'CONFIRMED', totalAmount: 90000, paidAmount: 100000 })],
      charges: [charge({ id: 1, bookingId: 7, date: d('2026-07-10'), amount: 90000, unitPrice: 90000 })],
      payments: [payment({ id: 1, bookingId: 7, amount: 100000, method: 'cash' })],
    })
    const before = dbSnapshot(st.prisma)

    // Переплата 10 000, просят 20 000
    const r = await settle(st, { action: 'none', refund: { amount: 20000 } })

    expect(r.status).toBe(400)
    expect(r.body.error).toBe('Вернуть можно не больше 10000')
    expect(dbSnapshot(st.prisma)).toBe(before)
    expect(writeOps(st.calls)).toEqual([])
    expect(st.emitted).toEqual([])
  })

  it('штраф уменьшает лимит: удержание нельзя вернуть тем же нажатием', async () => {
    const st = twoPaymentsOnePartlyRefunded()

    // Отмена обнуляет счёт (принято 45 000), штраф 10 000 → вернуть можно 35 000
    const r = await settle(st, {
      action: 'cancel',
      penalty: { amount: 10000, reason: 'поздняя отмена' },
      refund: { amount: 40000 },
    })

    expect(r.status).toBe(400)
    expect(r.body.error).toBe('Вернуть можно не больше 35000')
    // Возвратов не появилось. Откат статуса и штрафа — работа транзакции Postgres:
    // `$transaction` стенда её не моделирует, поэтому здесь проверяется то, что
    // проверяемо, — журнал платежей не тронут.
    expect(st.prisma.payment.rows.filter((p) => p.id > 3)).toEqual([])
  })

  it('возврат ровно по лимиту проходит, на тенге больше — уже нет', async () => {
    const exact = await settle(twoPaymentsOnePartlyRefunded(), {
      action: 'cancel', penalty: { amount: 10000, reason: 'поздняя отмена' }, refund: { amount: 35000 },
    })
    expect(exact.status).toBe(200)

    const over = await settle(twoPaymentsOnePartlyRefunded(), {
      action: 'cancel', penalty: { amount: 10000, reason: 'поздняя отмена' }, refund: { amount: 35001 },
    })
    expect(over.status).toBe(400)
    expect(over.body.error).toBe('Вернуть можно не больше 35000')
  })

  it('долг вместо переплаты: вернуть нельзя ничего', async () => {
    const st = twoPaymentsOnePartlyRefunded()

    const r = await settle(st, { action: 'none', refund: { amount: 1000 } })

    expect(r.status).toBe(400)
    expect(r.body.error).toBe('Вернуть можно не больше 0')
    expect(st.prisma.payment.rows).toHaveLength(3)
  })

  it('отрицательные суммы отсекаются до всякой записи', async () => {
    const st = twoPaymentsOnePartlyRefunded()
    const before = dbSnapshot(st.prisma)

    const r = await settle(st, { action: 'cancel', penalty: { amount: -5000, reason: 'ой' } })

    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/отрицательной/)
    expect(dbSnapshot(st.prisma)).toBe(before)
  })
})

describe('settle checkout — ранний выезд с удержанием', () => {
  const BREAKFAST = service({ id: 1, name: 'Завтрак', price: 3500, unit: 'per_person_night' })
  const RAISED = ['2026-07-10', '2026-07-11', '2026-07-12'].map((iso) => rate(iso, { adultPrice: 20000 }))

  /** Заселён 10-го на 3 ночи, уезжает 12-го: прожиты ночи 10 и 11. Оплачено 103 500. */
  function leavingEarly() {
    return makeSettlementStack({
      businessDate: d('2026-07-12'),
      rates: RAISED,
      services: [BREAKFAST],
      rooms: [room({ id: 101 })],
      bookingServices: [{ id: 1, bookingId: 7, serviceId: 1, adults: 2, children: 0, quantity: 1 }],
      bookings: [booking({
        id: 7, status: 'CHECKED_IN', checkIn: d('2026-07-10'), checkOut: d('2026-07-13'),
        discountPercent: 10, totalAmount: 103500, prepaidAmount: 51750, paidAmount: 103500,
      })],
      charges: [
        charge({ id: 1, bookingId: 7, date: d('2026-07-10'), amount: 30000, unitPrice: 30000 }),
        charge({ id: 2, bookingId: 7, date: d('2026-07-11'), amount: 30000, unitPrice: 30000 }),
        charge({ id: 3, bookingId: 7, date: d('2026-07-12'), amount: 30000, unitPrice: 30000 }),
        charge({ id: 4, bookingId: 7, kind: 'meal', label: 'Завтрак', quantity: 6, unitPrice: 3500, amount: 21000 }),
        charge({ id: 5, bookingId: 7, kind: 'discount', label: 'Скидка 10%', quantity: 1, unitPrice: -11500, amount: -11500 }),
      ],
      payments: [payment({ id: 1, bookingId: 7, amount: 103500, method: 'card' })],
    })
  }

  it('в счёте остаются прожитые ночи, пересчитанное питание и строка штрафа', async () => {
    const st = leavingEarly()

    const r = await settle(st, {
      action: 'checkout',
      penalty: { amount: 5000, reason: 'досрочный отъезд' },
      refund: { amount: 28300 },
    })

    expect(r.status).toBe(200)
    const rows = chargesOf(st.prisma, 7)
    expect(rows.filter((c) => c.kind === 'stay').map((c) => c.amount)).toEqual([30000, 30000])
    expect(rows.find((c) => c.kind === 'meal')).toMatchObject({ quantity: 4, amount: 14000 })
    expect(rows.find((c) => c.kind === 'discount').amount).toBe(-7400)  // 10 % от 74 000
    expect(rows.find((c) => c.source === 'manual')).toMatchObject({ label: 'Штраф: досрочный отъезд', amount: 5000 })
    // 60 000 + 14 000 − 7 400 + 5 000
    expect(totalOf(st.prisma, 7)).toBe(71600)
  })

  it('статус закрыт, дата выезда сдвинута на рабочую дату, деньги сходятся', async () => {
    const st = leavingEarly()

    const r = await settle(st, {
      action: 'checkout',
      penalty: { amount: 5000, reason: 'досрочный отъезд' },
      refund: { amount: 31900 },
    })

    const saved = st.prisma.booking.rows.find((b) => b.id === 7)
    expect(saved.status).toBe('CHECKED_OUT')
    expect(saved.checkOut.getTime()).toBe(d('2026-07-12').getTime())
    expect(saved.actualCheckOutAt).toBeInstanceOf(Date)
    expect(r.body.data.summary).toMatchObject({ charged: 71600, paid: 71600, due: 0 })
  })

  it('событие booking:checkout со свежей бронью, следом booking:updated', async () => {
    const st = leavingEarly()

    await settle(st, { action: 'checkout', penalty: { amount: 5000, reason: 'досрочный отъезд' } })

    expect(st.emitted.map((e) => e.event)).toEqual(['booking:checkout', 'booking:updated'])
    expect(st.emitted[0].payload.booking).toMatchObject({ id: 7, status: 'CHECKED_OUT', totalAmount: 71600 })
  })

  it('сумма к возврату из предпросмотра выезда сходится с сохранением до тенге', async () => {
    const st = leavingEarly()
    const preview = await run(st.settlement.preview, { params: { id: '7' }, body: { action: 'checkout' } })

    const r = await settle(st, { action: 'checkout', refund: { amount: preview.body.data.toReturn } })

    // 60 000 (две ночи) + 14 000 (завтраки) − 7 400 (скидка) = 66 600 из оплаченных 103 500
    expect(preview.body.data.toReturn).toBe(36900)
    expect(r.status).toBe(200)
    expect(r.body.data.summary).toMatchObject({ charged: 66600, paid: 66600, due: 0 })
  })

  it('выезд в день заезда закрывает бронь ОТМЕНОЙ — гость не ночевал', async () => {
    const st = makeSettlementStack({
      businessDate: d('2026-07-10'),
      rooms: [room({ id: 101 })],
      bookings: [booking({
        id: 7, status: 'CHECKED_IN', checkIn: d('2026-07-10'), checkOut: d('2026-07-13'),
        totalAmount: 90000, paidAmount: 30000, notes: 'приехал ночью',
      })],
      charges: [charge({ id: 1, bookingId: 7, date: d('2026-07-10'), amount: 90000, unitPrice: 90000 })],
      payments: [payment({ id: 1, bookingId: 7, amount: 30000, method: 'cash' })],
    })

    const r = await settle(st, { action: 'checkout', refund: { amount: 30000 } })

    expect(r.status).toBe(200)
    const saved = st.prisma.booking.rows.find((b) => b.id === 7)
    expect(saved.status).toBe('CANCELLED')
    expect(saved.notes).toContain('гость не ночевал')
    expect(chargesOf(st.prisma, 7)).toEqual([])
    expect(st.emitted.map((e) => e.event)).toEqual(['booking:cancelled', 'booking:updated'])
    expect(r.body.data.summary).toMatchObject({ charged: 0, paid: 0, due: 0 })
  })
})

describe('settle none — возврат переплаты по живой брони', () => {
  function overpaid() {
    return makeSettlementStack({
      rooms: [room({ id: 101 })],
      bookings: [booking({ id: 7, status: 'CONFIRMED', totalAmount: 30000, paidAmount: 50000 })],
      charges: [charge({ id: 1, bookingId: 7, date: d('2026-07-10'), amount: 30000, unitPrice: 30000 })],
      payments: [payment({ id: 1, bookingId: 7, amount: 50000, method: 'cash' })],
    })
  }

  it('переплата возвращается, статус и строки счёта не трогаются', async () => {
    const st = overpaid()

    const r = await settle(st, { action: 'none', refund: { amount: 20000 } })

    expect(r.status).toBe(200)
    expect(st.prisma.booking.rows[0].status).toBe('CONFIRMED')
    expect(chargesOf(st.prisma, 7).map((c) => c.id)).toEqual([1])
    expect(r.body.data.refunds).toHaveLength(1)
    expect(r.body.data.refunds[0]).toMatchObject({ refundOfId: 1, amount: 20000, kind: 'refund' })
    expect(r.body.data.summary).toMatchObject({ charged: 30000, paid: 30000, due: 0 })
    expect(r.body.data.penalty).toBeNull()
  })

  it('комментарий по умолчанию объясняет происхождение возврата', async () => {
    const st = overpaid()
    await settle(st, { action: 'none', refund: { amount: 5000 } })
    expect(st.prisma.payment.rows[1].comment).toBe('Возврат при отмене/раннем выезде')
  })

  it('нулевой штраф и отсутствие возврата не создают ни строк, ни платежей', async () => {
    const st = overpaid()
    const before = dbSnapshot(st.prisma)

    const r = await settle(st, { action: 'none', penalty: { amount: 0, reason: 'передумали' } })

    expect(r.status).toBe(200)
    expect(r.body.data.penalty).toBeNull()
    expect(r.body.data.refunds).toEqual([])
    expect(dbSnapshot(st.prisma)).toBe(before)
    // Единственное следствие — общее обновление денег на втором рабочем месте
    expect(st.emitted.map((e) => e.event)).toEqual(['booking:updated'])
  })
})

describe('settle — гейты статусов те же, что у обычных «Отменить» и «Выезд»', () => {
  const closed = (status) => makeSettlementStack({
    rooms: [room({ id: 101 })],
    bookings: [booking({ id: 7, status, totalAmount: 90000, paidAmount: 90000 })],
    payments: [payment({ id: 1, bookingId: 7, amount: 90000 })],
  })

  it('отмена уже отменённой — «Бронь уже отменена»', async () => {
    const st = closed('CANCELLED')

    const r = await settle(st, { action: 'cancel', refund: { amount: 90000 } })

    expect(r.status).toBe(400)
    expect(r.body.error).toBe('Бронь уже отменена')
    expect(st.prisma.payment.rows).toHaveLength(1)
    expect(st.emitted).toEqual([])
  })

  it('отмена закрытой — «Нельзя отменить закрытую бронь», строка штрафа не заводится', async () => {
    const st = makeSettlementStack({
      rooms: [room({ id: 101 })],
      bookings: [booking({ id: 7, status: 'CHECKED_OUT', totalAmount: 90000, paidAmount: 90000 })],
      charges: [charge({ id: 1, bookingId: 7, date: d('2026-07-10'), amount: 90000, unitPrice: 90000 })],
      payments: [payment({ id: 1, bookingId: 7, amount: 90000 })],
    })
    const before = dbSnapshot(st.prisma)

    const r = await settle(st, { action: 'cancel', penalty: { amount: 5000, reason: 'штраф' } })

    expect(r.status).toBe(400)
    expect(r.body.error).toBe('Нельзя отменить закрытую бронь')
    expect(dbSnapshot(st.prisma)).toBe(before)
    expect(st.emitted).toEqual([])
  })

  it('выезд по не заселённой брони — 400 со статусом в тексте', async () => {
    const st = closed('CONFIRMED')

    const r = await settle(st, { action: 'checkout' })

    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/Нельзя отметить выезд.*CONFIRMED/)
  })

  it('«none» по отменённой брони разрешён — так возвращают неотработанную предоплату', async () => {
    const st = closed('CANCELLED')

    const r = await settle(st, { action: 'none', refund: { amount: 90000 } })

    // У отменённой брони без строк начислено = 0, значит вся оплата — переплата
    expect(r.status).toBe(200)
    expect(r.body.data.summary).toMatchObject({ charged: 0, paid: 0 })
  })

  it('неизвестное действие — 400 до всякой записи', async () => {
    const st = closed('CONFIRMED')

    const r = await settle(st, { action: 'refund' })

    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/Неизвестное действие/)
    expect(st.calls).toEqual([])
  })

  it('брони нет — 404', async () => {
    const st = closed('CONFIRMED')
    const r = await settle(st, { action: 'cancel' }, 999)
    expect(r.status).toBe(404)
  })
})

describe('журнал действий: предпросмотр расчёта игнорируется, подтверждение — нет', () => {
  const { isTracked } = loadCjs('src/middleware/audit.js', {
    append: 'module.exports.__test = { isTracked };',
    stubs: { '../utils/prisma': { prisma: {} }, '../utils/logger': silentLogger },
  }).__test

  it('/bookings/7/settlement/preview в журнал не идёт — диалог зовёт его на каждую цифру', () => {
    expect(isTracked('POST', '/bookings/7/settlement/preview')).toBe(false)
    expect(isTracked('POST', '/bookings/7/settlement/preview/')).toBe(false)
  })

  it('/bookings/7/settlement отслеживается — это деньги и смена статуса', () => {
    expect(isTracked('POST', '/bookings/7/settlement')).toBe(true)
  })

  it('исключение адресное: похожие пути по-прежнему журналируются', () => {
    expect(isTracked('POST', '/bookings/7/settlement/previewX')).toBe(true)
    expect(isTracked('POST', '/bookings/settlement/preview')).toBe(true)
  })
})

describe('штраф на брони без строк начислений не теряет её прежний итог', () => {
  /**
   * Найдено тестом 08.09, починено в тот же день (`utils/charges.js: pinLegacyTotal`).
   *
   * Было: после строки штрафа зовётся `recalcBookingTotals` в СТРОГОМ режиме, то есть
   * `Booking.totalAmount` переписывается суммой строк. У брони, у которой строк нет
   * вовсе (в рабочей базе таких 107, см. NOTES — их итог посчитан когда-то вручную),
   * строка после этого ровно одна — сам штраф: начислено становилось 5 000 вместо
   * 105 000, и та же транзакция отдавала гостю деньги за прожитые ночи. Предпросмотр
   * при этом показывал `toReturn: 0` — то самое расхождение предпросмотра и сохранения,
   * ради устранения которого модуль и писался.
   *
   * Стало: перед первой ручной строкой прежний итог фиксируется строкой
   * «Проживание · по прежнему расчёту» — счёт становится списком, ничего не теряя.
   */
  function oldBookingWithoutCharges() {
    return makeSettlementStack({
      rooms: [room({ id: 101 })],
      bookings: [booking({ id: 7, status: 'CONFIRMED', totalAmount: 100000, paidAmount: 100000 })],
      payments: [payment({ id: 1, bookingId: 7, amount: 100000, method: 'cash' })],
    })
  }

  it('предпросмотр по такой брони честно говорит: возвращать нечего', async () => {
    const st = oldBookingWithoutCharges()

    const data = (await run(st.settlement.preview, { params: { id: '7' }, body: { action: 'none' } })).body.data

    expect(data).toMatchObject({ charged: 100000, paid: 100000, toReturn: 0 })
  })

  it('штраф не открывает возврат оплаты за прожитые ночи', async () => {
    const st = oldBookingWithoutCharges()

    const r = await settle(st, {
      action: 'none',
      penalty: { amount: 5000, reason: 'порча имущества' },
      refund: { amount: 95000 },
    })

    expect(r.status).toBe(400)
  })

  it('прежний итог зафиксирован строкой, а счёт вырос на штраф', async () => {
    const st = oldBookingWithoutCharges()

    const r = await settle(st, { action: 'none', penalty: { amount: 5000, reason: 'порча имущества' } })

    expect(r.status).toBe(200)
    const rows = chargesOf(st.prisma, 7)
    expect(rows.map((c) => ({ label: c.label, amount: c.amount, source: c.source, date: c.date }))).toEqual([
      { label: 'Проживание · по прежнему расчёту', amount: 100000, source: 'manual', date: null },
      { label: 'Штраф: порча имущества', amount: 5000, source: 'manual', date: null },
    ])
    expect(totalOf(st.prisma, 7)).toBe(105000)
    expect(r.body.data.summary).toMatchObject({ charged: 105000, paid: 100000, due: 5000 })
  })

  it('итог 0 (отель без календаря цен) не фиксируется: штраф и есть весь счёт', async () => {
    const st = makeSettlementStack({
      rooms: [room({ id: 101 })],
      bookings: [booking({ id: 7, status: 'CONFIRMED', totalAmount: 0, paidAmount: 0 })],
    })

    await settle(st, { action: 'none', penalty: { amount: 5000, reason: 'порча имущества' } })

    expect(chargesOf(st.prisma, 7).map((c) => c.label)).toEqual(['Штраф: порча имущества'])
    expect(totalOf(st.prisma, 7)).toBe(5000)
  })
})
