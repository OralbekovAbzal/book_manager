const { prisma } = require('../utils/prisma')
const { createError } = require('../middleware/errorHandler')
const { emitBookingEvent } = require('../socket/socketManager')
const { getCurrentBusinessDate, ensureCurrentShift } = require('../utils/businessDate')
const {
  toUTCDate, dateKey, nightsOf, sumCharges, recalcBookingTotals, pinLegacyTotal,
  planCancelCharges, planEarlyCheckout, loadStayContext,
} = require('../utils/charges')
const { round2, chargedOf, bookingMoney } = require('../utils/bookingMoney')
const bookingCtrl = require('./bookingController')
const paymentCtrl = require('./paymentController')

/**
 * Расчёт с гостем: отмена или ранний выезд + штраф + возврат — ОДНИМ действием.
 *
 * Зачем эндпоинт, если всё это уже есть по отдельности. Слова владельца:
 * «чтобы можно было сразу сделать возврат, не лезть в кассу: калькулятор показывает,
 * сколько к возврату, админ может менять данные — какую часть вернуть и сколько штраф».
 * Раньше администратор должен был отменить бронь, посмотреть переплату в «Кассе»,
 * найти нужный приём оплаты в журнале и вернуть по нему — четыре экрана и место,
 * где сумма легко расходится с решением, о котором договорились с гостем.
 *
 * Два эндпоинта:
 *   • `POST /bookings/:id/settlement/preview` — «сколько выйдет»: НИЧЕГО не пишет и
 *     не рассылает событий. Строки после действия считает тем же планом
 *     (`planCancelCharges` / `planEarlyCheckout`), что и само действие, — два разных
 *     вычисления «сколько к возврату» разошлись бы на тенге.
 *   • `POST /bookings/:id/settlement` — одна транзакция: действие → штраф → возврат.
 *     Порядок обязателен: лимит возврата считается от счёта УЖЕ со штрафом, иначе
 *     удержание можно было бы вернуть гостю тем же нажатием.
 *
 * Штраф — обычная ручная строка (`source='manual'` + причина), как решено в
 * `docs/decisions/data-and-money.md`: отдельной настройки «штраф за отмену» нет,
 * потому что ситуации разные, а запись о решении администратора нужна всегда.
 */

const ACTIONS = ['cancel', 'checkout', 'none']
const DEFAULT_REFUND_COMMENT = 'Возврат при отмене/раннем выезде'
const DEFAULT_PENALTY_LABEL = 'Удержание'

// ─── План счёта ──────────────────────────────────────────────────────────────

/** Строка счёта в форме ответа (та же, что у `POST /bookings/preview`). */
function asRow(r, source) {
  return {
    kind: r.kind,
    label: r.label,
    quantity: r.quantity,
    unitPrice: r.unitPrice,
    amount: r.amount,
    date: r.date ? dateKey(r.date) : null,
    source: source || r.source || 'auto',
  }
}

/**
 * Порядок как в сохранённом счёте (`loadCharges`): по дате, строки без даты — в конец
 * (NULLS LAST). Уже существующие строки идут перед новыми: у новых ещё нет id.
 */
function orderRows(keep, create) {
  return [
    ...keep.map((r) => asRow(r, r.source)),
    ...create.map((r) => asRow(r, 'auto')),
  ]
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const ad = a.row.date || '9999-99-99'
      const bd = b.row.date || '9999-99-99'
      return ad === bd ? a.i - b.i : (ad < bd ? -1 : 1)
    })
    .map((x) => x.row)
}

/**
 * Каким станет счёт после действия. Ничего не пишет — только считает.
 *
 * @returns {{ rows: Array, statusAfter: string, nights: {planned:number, stayed:number, removed:number} }}
 */
async function planSettlement(booking, action, businessDate, client = prisma) {
  const charges = await client.bookingCharge.findMany({
    where: { bookingId: booking.id },
    orderBy: [{ date: 'asc' }, { id: 'asc' }],
  })
  const planned = nightsOf(booking.checkIn, booking.checkOut).length

  if (action === 'cancel') {
    const plan = planCancelCharges(charges)
    return {
      rows: orderRows(plan.keep, plan.create),
      statusAfter: 'CANCELLED',
      // Отмена — это «гость не жил»: снятых ночей нет, есть несостоявшиеся
      nights: { planned, stayed: 0, removed: 0 },
    }
  }

  if (action === 'checkout') {
    // Выезд день-в-день с заездом — это отмена (гость не ночевал), см. applyCheckOut
    if (businessDate.getTime() === bookingCtrl.bookingDayUTC(booking.checkIn).getTime()) {
      const plan = planCancelCharges(charges)
      return {
        rows: orderRows(plan.keep, plan.create),
        statusAfter: 'CANCELLED',
        nights: { planned, stayed: 0, removed: planned },
      }
    }
    // Выезд в срок (или позже) — счёт не меняется вовсе
    if (businessDate.getTime() >= toUTCDate(booking.checkOut).getTime()) {
      return {
        rows: orderRows(charges, []),
        statusAfter: 'CHECKED_OUT',
        nights: { planned, stayed: planned, removed: 0 },
      }
    }
    const ctx = await loadStayContext(booking, businessDate, client)
    const plan = planEarlyCheckout({ booking, charges, newCheckOut: businessDate, ...ctx })
    const stayed = nightsOf(booking.checkIn, businessDate).length
    return {
      rows: orderRows(plan.keep, plan.create),
      statusAfter: 'CHECKED_OUT',
      nights: { planned, stayed, removed: planned - stayed },
    }
  }

  // 'none' — счёт как есть: переплата по живой брони возвращается без смены статуса
  return {
    rows: orderRows(charges, []),
    statusAfter: booking.status,
    nights: { planned, stayed: planned, removed: 0 },
  }
}

/**
 * «Начислено» по плану. Строк нет вовсе — берём кэш `Booking.totalAmount` по тому же
 * правилу, что касса и отчёты (`chargedOf`): у 107 старых броней строк начислений не
 * было никогда, и без этого калькулятор показал бы всю их оплату «к возврату».
 */
function chargedOfPlan(rows, booking, statusAfter) {
  if (rows.length > 0) return sumCharges(rows)
  return Math.round(chargedOf({
    chargesTotal: 0,
    hasCharges: false,
    totalAmount: booking.totalAmount,
    status: statusAfter,
  }))
}

/**
 * Приёмы оплаты, по которым ещё есть что возвращать.
 * `refundable` — сумма приёма минус уже возвращённое по нему: возврат кладётся
 * только на конкретный платёж и только в пределах его остатка (решение владельца
 * 2026-09-08, «свободных» возвратов больше нет).
 */
async function refundablePayments(bookingId, client = prisma) {
  const [received, refunds] = await Promise.all([
    client.payment.findMany({
      where: { bookingId, kind: 'payment', voidedAt: null },
      orderBy: [{ paidAt: 'desc' }, { id: 'desc' }],
    }),
    client.payment.findMany({
      where: { bookingId, kind: 'refund', voidedAt: null },
      select: { refundOfId: true, amount: true },
    }),
  ])

  const returned = new Map()
  for (const r of refunds) {
    if (r.refundOfId == null) continue
    returned.set(r.refundOfId, round2((returned.get(r.refundOfId) || 0) + r.amount))
  }
  return received.map((p) => ({ ...p, refundable: round2(p.amount - (returned.get(p.id) || 0)) }))
}

// ─── POST /api/bookings/:id/settlement/preview ───────────────────────────────

async function preview(req, res, next) {
  try {
    const id = parseInt(req.params.id)
    const action = req.body?.action
    if (!ACTIONS.includes(action)) return next(createError('Неизвестное действие расчёта', 400))

    const booking = await prisma.booking.findUnique({ where: { id } })
    if (!booking) return next(createError('Бронь не найдена', 404))

    const businessDate = await getCurrentBusinessDate()
    // Предпросмотр обязан отказывать там же, где откажет сохранение: иначе он
    // обещал бы расчёт, который подтверждение отклонит, — а сумму администратор
    // гостю уже назвал. Гейты те же и с той же ролью, что в `settle`.
    if (action === 'cancel') {
      const denied = bookingCtrl.cancelGuard(booking, req.admin?.role)
      if (denied) return next(denied)
    }
    if (action === 'checkout') {
      const denied = bookingCtrl.checkOutGuard(booking, businessDate)
      if (denied) return next(denied)
    }

    const plan = await planSettlement(booking, action, businessDate)
    const charged = chargedOfPlan(plan.rows, booking, plan.statusAfter)
    const money = await bookingMoney(id)
    const paid = money.paid

    res.json({
      data: {
        action,
        status: booking.status,
        charged,
        paid,
        /// Переплата: столько можно отдать гостю
        toReturn: round2(Math.max(0, paid - charged)),
        /// Недоплата: столько ещё нужно принять
        due: round2(Math.max(0, charged - paid)),
        nights: plan.nights,
        rows: plan.rows,
        payments: (await refundablePayments(id)).map((p) => ({
          id: p.id,
          paidAt: p.paidAt,
          method: p.method,
          amount: round2(p.amount),
          refundable: p.refundable,
        })),
      },
    })
  } catch (err) {
    next(err)
  }
}

// ─── POST /api/bookings/:id/settlement ───────────────────────────────────────

async function settle(req, res, next) {
  try {
    const id = parseInt(req.params.id)
    const action = req.body?.action
    if (!ACTIONS.includes(action)) return next(createError('Неизвестное действие расчёта', 400))

    const booking = await prisma.booking.findUnique({ where: { id } })
    if (!booking) return next(createError('Бронь не найдена', 404))

    const businessDate = await getCurrentBusinessDate()
    // Те же проверки, что у обычных «Отменить» и «Выезд» — код общий, а не копия
    if (action === 'cancel') {
      const denied = bookingCtrl.cancelGuard(booking, req.admin?.role)
      if (denied) return next(denied)
    }
    if (action === 'checkout') {
      const denied = bookingCtrl.checkOutGuard(booking, businessDate)
      if (denied) return next(denied)
    }

    // Деньги в тенге целые (как все строки начислений), возврат — с двумя знаками,
    // как в журнале платежей.
    const penaltyAmount = Math.round(Number(req.body?.penalty?.amount) || 0)
    const penaltyReason = String(req.body?.penalty?.reason || '').trim()
    const refundAmount = round2(req.body?.refund?.amount)
    if (penaltyAmount < 0 || refundAmount < 0) {
      return next(createError('Сумма не может быть отрицательной', 400))
    }

    const refundMethod = paymentCtrl.METHODS.includes(req.body?.refund?.method)
      ? req.body.refund.method
      : null
    const refundComment = String(req.body?.refund?.comment || '').trim() || DEFAULT_REFUND_COMMENT

    // Смена нужна только под возврат: платёж вне смены не попадёт ни в один отчёт
    // по кассе. Берём ДО транзакции — как в paymentController.
    const shift = refundAmount > 0 ? await ensureCurrentShift(req.admin.id) : null

    const result = await prisma.$transaction(async (tx) => {
      // (а) само действие
      let event = null
      if (action === 'cancel') {
        await bookingCtrl.applyCancel(tx, booking)
        event = 'booking:cancelled'
      } else if (action === 'checkout') {
        event = await bookingCtrl.applyCheckOut(tx, booking, businessDate, req.admin.id)
      }

      // (б) штраф — ручной строкой: отдельной настройки «штраф за отмену» нет,
      // а решение администратора обязано остаться записанным (с причиной и автором).
      let penalty = null
      if (penaltyAmount > 0) {
        // Счёт брони без строк держится на кэше `totalAmount` — фиксируем его строкой,
        // иначе пересчёт ниже приравняет весь счёт к штрафу (см. `pinLegacyTotal`).
        await pinLegacyTotal(id, { client: tx, adminId: req.admin.id })
        penalty = await tx.bookingCharge.create({
          data: {
            bookingId: id,
            kind: 'extra',
            label: penaltyReason ? `Штраф: ${penaltyReason}` : DEFAULT_PENALTY_LABEL,
            quantity: 1,
            unitPrice: penaltyAmount,
            amount: penaltyAmount,
            date: null,
            source: 'manual',
            reason: penaltyReason || DEFAULT_PENALTY_LABEL,
            createdById: req.admin.id,
          },
        })
        await recalcBookingTotals(id, { client: tx })
      }

      // (в) возврат — не больше переплаты по счёту, УЖЕ включающему штраф
      const refunds = []
      if (refundAmount > 0) {
        const money = await bookingMoney(id, tx)
        const limit = round2(money.paid - money.charged)
        if (refundAmount > limit) {
          throw createError(`Вернуть можно не больше ${Math.max(0, limit)}`, 400)
        }

        // Раскладываем от НОВЫХ приёмов к старым: свежий платёж чаще всего и есть тот,
        // который отменяют, а старая предоплата обычно уже закрыта услугами.
        const sources = await refundablePayments(id, tx)
        let left = refundAmount
        for (const source of sources) {
          if (left <= 0) break
          if (source.refundable <= 0) continue
          const part = round2(Math.min(source.refundable, left))
          const created = await tx.payment.create({
            data: {
              bookingId: id,
              kind: 'refund',
              amount: part,
              method: refundMethod || source.method,
              adminId: req.admin.id,
              adminName: req.admin.name,
              shiftId: shift.id,
              businessDate: shift.date,
              comment: refundComment,
              refundOfId: source.id,
            },
            include: paymentCtrl.PAYMENT_INCLUDE,
          })
          refunds.push(created)
          left = round2(left - part)
        }
        if (left > 0) {
          // Переплата есть, а разложить её не на что: приёмы уже возвращены целиком
          // (или пришли не через журнал). Молча вернуть меньше запрошенного нельзя —
          // администратор отдал бы гостю не ту сумму.
          throw createError(`Вернуть можно не больше ${round2(refundAmount - left)}`, 400)
        }
        await paymentCtrl.recalcBookingPaid(id, tx)
      }

      return { event, penalty, refunds }
    })

    const fresh = await prisma.booking.findUnique({ where: { id }, select: bookingCtrl.BOOKING_SELECT })

    // События — те же, что у обычных «Отменить»/«Выезд», плюс общий booking:updated
    // с новыми деньгами: второе рабочее место иначе покажет старый долг.
    if (result.event === 'booking:cancelled') {
      emitBookingEvent('booking:cancelled', { bookingId: id, roomId: fresh?.room?.id })
    } else if (result.event === 'booking:checkout') {
      emitBookingEvent('booking:checkout', { booking: fresh })
    }
    await paymentCtrl.notifyBookingMoneyChanged(id)

    res.json({
      data: {
        booking: fresh,
        summary: await bookingMoney(id),
        refunds: result.refunds,
        penalty: result.penalty,
      },
    })
  } catch (err) {
    next(err)
  }
}

module.exports = { preview, settle, ACTIONS, planSettlement, refundablePayments }
