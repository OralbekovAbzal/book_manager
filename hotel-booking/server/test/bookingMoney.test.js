import { describe, it, expect } from 'vitest'
import { loadCjs } from './helpers/loadCjs.js'

/**
 * Деньги брони: начислено / принято / долг.
 *
 * Это ЕДИНСТВЕННОЕ определение долга в программе — им пользуются и сводка брони,
 * и экран «кто сколько должен», и отчёт «Долги». Тест сторожит именно то, из-за
 * чего суммы разъезжаются: запасной `totalAmount` у броней без строк начислений,
 * знак возврата и невидимость отменённых платежей.
 */

const {
  round2, signedPayment, chargedOf, loadBookingMoney, bookingMoney,
} = loadCjs('src/utils/bookingMoney.js', { stubs: { './prisma': { prisma: {} } } })

/** Мини-клиент: только те два запроса, которые делает модуль. */
function client({ bookings = [], charges = [], payments = [] } = {}) {
  const inList = (v, where) => where.bookingId.in.includes(v)
  return {
    booking: {
      async findUnique({ where }) {
        return bookings.find((b) => b.id === where.id) || null
      },
    },
    bookingCharge: {
      async groupBy({ where }) {
        const byId = new Map()
        for (const c of charges.filter((c) => inList(c.bookingId, where))) {
          const cur = byId.get(c.bookingId) || { bookingId: c.bookingId, _sum: { amount: 0 }, _count: { _all: 0 } }
          cur._sum.amount += c.amount
          cur._count._all += 1
          byId.set(c.bookingId, cur)
        }
        return [...byId.values()]
      },
    },
    payment: {
      async findMany({ where }) {
        return payments.filter((p) => inList(p.bookingId, where))
      },
    },
  }
}

const pay = (bookingId, amount, extra = {}) => ({ bookingId, kind: 'payment', amount, voidedAt: null, ...extra })

describe('слагаемые', () => {
  it('возврат уходит в минус, отменённый платёж не считается вовсе', () => {
    expect(signedPayment(pay(1, 5000))).toBe(5000)
    expect(signedPayment(pay(1, 5000, { kind: 'refund' }))).toBe(-5000)
    expect(signedPayment(pay(1, 5000, { voidedAt: new Date() }))).toBe(0)
    // Отменённый возврат — тоже ноль, а не «плюс пять тысяч»
    expect(signedPayment(pay(1, 5000, { kind: 'refund', voidedAt: new Date() }))).toBe(0)
  })

  it('без строк начислений «начислено» берётся из итога брони', () => {
    expect(chargedOf({ chargesTotal: 0, hasCharges: false, totalAmount: 100000 })).toBe(100000)
    // Строки есть и дают ноль (скидка съела счёт) — это НЕ повод брать totalAmount
    expect(chargedOf({ chargesTotal: 0, hasCharges: true, totalAmount: 100000 })).toBe(0)
    expect(chargedOf({ chargesTotal: 117000, hasCharges: true, totalAmount: 999 })).toBe(117000)
  })

  it('копейки не копятся', () => {
    expect(round2(0.1 + 0.2)).toBe(0.3)
  })
})

describe('деньги брони', () => {
  it('строки начислений важнее кэша totalAmount', async () => {
    const c = client({
      bookings: [{ id: 1, totalAmount: 999, prepaidAmount: 0, paidAmount: 0, guestName: 'Г' }],
      charges: [
        { bookingId: 1, amount: 32000 }, { bookingId: 1, amount: 32000 },
        { bookingId: 1, amount: 32000 }, { bookingId: 1, amount: 21000 },
      ],
    })
    const m = await bookingMoney(1, c)
    expect(m.charged).toBe(117000)
    expect(m.chargesFromRows).toBe(true)
    expect(m.totalAmount).toBe(999)
    expect(m.due).toBe(117000)
  })

  it('107 старых броней без строк: долг считается от totalAmount, а не от оплаты со знаком минус', async () => {
    const c = client({
      bookings: [{ id: 2, totalAmount: 100000, prepaidAmount: 0, paidAmount: 40000, guestName: 'Г' }],
      payments: [pay(2, 40000)],
    })
    const m = await bookingMoney(2, c)
    expect(m.chargesFromRows).toBe(false)
    expect(m.charged).toBe(100000)
    expect(m.paid).toBe(40000)
    expect(m.due).toBe(60000)
  })

  it('переплата — отрицательный долг, а не ноль', async () => {
    const c = client({
      bookings: [{ id: 3, totalAmount: 0, prepaidAmount: 0, paidAmount: 150000, guestName: 'Г' }],
      payments: [pay(3, 150000)],
    })
    expect((await bookingMoney(3, c)).due).toBe(-150000)
  })

  it('возврат и отмена: в зачёт идёт только живой платёж', async () => {
    const c = client({
      bookings: [{ id: 4, totalAmount: 200000, prepaidAmount: 0, paidAmount: 0, guestName: 'Г' }],
      payments: [
        pay(4, 500000, { voidedAt: new Date() }),                       // ошибка кассира
        pay(4, 500000, { kind: 'refund', voidedAt: new Date() }),       // и её возврат — тоже отменён
        pay(4, 150000),                                                 // настоящий приём
        pay(4, 50000, { kind: 'refund' }),                              // настоящий возврат
      ],
    })
    const m = await bookingMoney(4, c)
    expect(m.paid).toBe(100000)
    expect(m.due).toBe(100000)
  })

  it('несуществующая бронь — null, а не ноль', async () => {
    expect(await bookingMoney(777, client({}))).toBeNull()
  })

  it('групповой расчёт даёт то же, что поштучный, и не теряет брони без денег', async () => {
    const bookings = [
      { id: 1, totalAmount: 100000, prepaidAmount: 0, paidAmount: 0, guestName: 'A' },
      { id: 2, totalAmount: 0, prepaidAmount: 0, paidAmount: 0, guestName: 'Б' },
      { id: 3, totalAmount: 50000, prepaidAmount: 0, paidAmount: 0, guestName: 'В' },
    ]
    const c = client({
      bookings,
      charges: [{ bookingId: 3, amount: 60000 }],
      payments: [pay(1, 30000), pay(3, 60000)],
    })
    const map = await loadBookingMoney(bookings, c)
    expect(map.size).toBe(3)
    expect(map.get(1).due).toBe(70000)
    expect(map.get(2).due).toBe(0)          // ни строк, ни платежей — ноль, а не пропуск
    expect(map.get(3).charged).toBe(60000)  // строки перевесили totalAmount = 50000
    expect(map.get(3).due).toBe(0)
    for (const b of bookings) {
      expect(map.get(b.id).due).toBe((await bookingMoney(b.id, c)).due)
    }
  })

  it('пустой список не ходит в базу', async () => {
    const c = client({})
    c.bookingCharge.groupBy = () => { throw new Error('лишний запрос к базе') }
    c.payment.findMany = () => { throw new Error('лишний запрос к базе') }
    expect((await loadBookingMoney([], c)).size).toBe(0)
  })
})
