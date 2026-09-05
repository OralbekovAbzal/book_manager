const { prisma } = require('./prisma')

/**
 * Деньги брони: начислено / принято / долг — ОДНО определение на всю программу.
 *
 *   начислено (charged) = сумма строк BookingCharge; строк нет — Booking.totalAmount
 *   принято   (paid)    = сумма НЕотменённых платежей, возврат со знаком минус
 *   долг      (due)     = начислено − принято  (минус = переплата)
 *
 * Почему отдельный модуль. Эти три формулы нужны сразу в трёх местах: сводка
 * брони, экран «кто сколько должен» и отчёт «Долги». Пока они жили копиями в
 * paymentController, в датасете отчётов родилась бы четвёртая — а расхождение
 * в деньгах на тенге замечают позже всего и объясняют дольше всего.
 * Ровно та же история, что была с четырьмя определениями «свободно»
 * (см. NOTES, `utils/availability.js`).
 *
 * `totalAmount` как запасной вариант — не изящество, а факт: у 107 старых броней
 * строк начислений нет вовсе, и без него их долг равнялся бы всей оплате
 * со знаком минус.
 */

/** Деньги — с двумя знаками: копить ошибку double по всей кассе нельзя. */
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100
}

/**
 * Сумма платежа к зачёту: возврат уменьшает принятое, отменённый не считается
 * вовсе. Знак задаётся видом платежа, `amount` в базе всегда положительная.
 */
function signedPayment(p) {
  if (p.voidedAt) return 0
  return p.kind === 'refund' ? -p.amount : p.amount
}

/**
 * Начислено по брони из уже посчитанных слагаемых.
 * @param {{ chargesTotal:number, hasCharges:boolean, totalAmount:number }} src
 */
function chargedOf({ chargesTotal, hasCharges, totalAmount }) {
  return hasCharges ? round2(chargesTotal) : round2(totalAmount)
}

/**
 * Деньги сразу по списку броней — ГРУППОВЫМИ запросами, а не по запросу на бронь:
 * экран долгов и отчёты работают на сотнях броней.
 *
 * @param {Array<{id:number, totalAmount:number}>} bookings уже загруженные брони
 * @returns {Promise<Map<number, {charged:number, chargesTotal:number, chargesFromRows:boolean, paid:number, due:number}>>}
 */
async function loadBookingMoney(bookings, client = prisma) {
  const ids = bookings.map((b) => b.id)
  const out = new Map()
  if (ids.length === 0) return out

  const [chargeRows, paymentRows] = await Promise.all([
    client.bookingCharge.groupBy({
      by: ['bookingId'],
      where: { bookingId: { in: ids } },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    client.payment.findMany({
      where: { bookingId: { in: ids } },
      select: { bookingId: true, kind: true, amount: true, voidedAt: true },
    }),
  ])

  const chargeMap = new Map(chargeRows.map((r) => [r.bookingId, r]))
  const paidMap = new Map()
  for (const p of paymentRows) {
    paidMap.set(p.bookingId, (paidMap.get(p.bookingId) || 0) + signedPayment(p))
  }

  for (const b of bookings) {
    const c = chargeMap.get(b.id)
    const hasCharges = !!c && (c._count ? c._count._all > 0 : true)
    const chargesTotal = round2(c && c._sum ? c._sum.amount || 0 : 0)
    const charged = chargedOf({ chargesTotal, hasCharges, totalAmount: b.totalAmount })
    const paid = round2(paidMap.get(b.id) || 0)
    out.set(b.id, {
      charged,
      chargesTotal,
      /// false — начислений строками ещё нет, «начислено» взято из Booking.totalAmount
      chargesFromRows: hasCharges,
      paid,
      due: round2(charged - paid),
    })
  }
  return out
}

/**
 * Финансовая картина ОДНОЙ брони. Возвращает null, если брони нет.
 * Форма ответа — контракт API оплаты (`summary` в /api/payments/*), менять её
 * нельзя не поправив клиент.
 */
async function bookingMoney(bookingId, client = prisma) {
  const booking = await client.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, guestName: true, totalAmount: true, prepaidAmount: true, paidAmount: true },
  })
  if (!booking) return null

  const money = (await loadBookingMoney([booking], client)).get(booking.id)
  return {
    bookingId,
    /// Сколько должен: сумма строк начислений; без строк — сохранённый итог брони
    charged: money.charged,
    chargesTotal: money.chargesTotal,
    chargesFromRows: money.chargesFromRows,
    totalAmount: round2(booking.totalAmount),
    prepaidAmount: round2(booking.prepaidAmount),
    /// Сколько принято (возвраты вычтены, отменённые не в счёт)
    paid: money.paid,
    /// Долг. Отрицательный — переплата, её видно так же явно, как недоплату
    due: money.due,
  }
}

module.exports = { round2, signedPayment, chargedOf, loadBookingMoney, bookingMoney }
