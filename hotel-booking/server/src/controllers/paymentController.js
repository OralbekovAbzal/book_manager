const { prisma } = require('../utils/prisma')
const { createError } = require('../middleware/errorHandler')
const { ensureCurrentShift, getCurrentShift, getCurrentBusinessDate } = require('../utils/businessDate')
const { emitBookingEvent } = require('../socket/socketManager')
const logger = require('../utils/logger')

/**
 * Журнал платежей — вторая половина задачи «суммы в программе сходятся
 * с деньгами на руках».
 *
 *   начисления (BookingCharge) → сколько гость ДОЛЖЕН
 *   платежи    (Payment)       → сколько с него ПРИНЯТО
 *   долг = начислено − принято
 *
 * До этого у брони были три числа без истории (totalAmount / prepaidAmount /
 * paidAmount): по ним нельзя закрыть смену и нельзя сказать, кто принял деньги.
 * Теперь `Booking.paidAmount` — КЭШ суммы платежей, который пересчитывается
 * после каждой операции (recalcBookingPaid).
 *
 * Два разных действия, которые легко перепутать:
 *   • ВОЗВРАТ (kind='refund') — деньги реально отданы гостю. Отдельная строка,
 *     она уменьшает принятую сумму, но и приход, и возврат видны по отдельности.
 *   • ОТМЕНА (void)           — ошибка кассира (не та бронь, не та сумма).
 *     Строка НЕ удаляется, а помечается отменённой: дыра в кассе хуже лишней
 *     строки. Отменённая в суммы не входит, но видна вместе с причиной.
 */

const KINDS = ['payment', 'refund']
const METHODS = ['cash', 'card', 'transfer']
const METHOD_LABELS = { cash: 'Наличные', card: 'Карта', transfer: 'Перевод' }

const PAYMENT_INCLUDE = {
  admin: { select: { id: true, name: true, username: true } },
  voidedBy: { select: { id: true, name: true } },
  booking: { select: { id: true, guestName: true, room: { select: { id: true, number: true } } } },
}

/** Деньги — с двумя знаками: копить ошибку double по всей кассе нельзя. */
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100
}

/** Сумма к зачёту: возврат уменьшает принятое, отменённые не считаются вовсе. */
function signed(p) {
  if (p.voidedAt) return 0
  return p.kind === 'refund' ? -p.amount : p.amount
}

/**
 * Пересчитать `Booking.paidAmount` как сумму НЕотменённых платежей минус возвраты.
 * Единственное место, где это число меняется от платежей — поэтому оно не может
 * разъехаться с журналом.
 */
async function recalcBookingPaid(bookingId, tx = prisma) {
  const rows = await tx.payment.findMany({
    where: { bookingId },
    select: { kind: true, amount: true, voidedAt: true },
  })
  const paid = round2(rows.reduce((sum, p) => sum + signed(p), 0))
  await tx.booking.update({ where: { id: bookingId }, data: { paidAmount: paid } })
  return paid
}

/**
 * Финансовая картина брони.
 * Начислено берём из строк BookingCharge (источник истины по ценообразованию).
 * Пока генератор начислений их не заполняет, строк нет — тогда «начислено»
 * это `totalAmount` брони, иначе долг был бы равен всей оплате со знаком минус.
 */
async function bookingMoney(bookingId, tx = prisma) {
  const booking = await tx.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, guestName: true, totalAmount: true, prepaidAmount: true, paidAmount: true },
  })
  if (!booking) return null

  const charges = await tx.bookingCharge.aggregate({
    where: { bookingId },
    _sum: { amount: true },
    _count: { _all: true },
  })
  const payments = await tx.payment.findMany({
    where: { bookingId },
    select: { kind: true, amount: true, voidedAt: true },
  })

  const chargesTotal = round2(charges._sum.amount || 0)
  const hasCharges = charges._count._all > 0
  const charged = hasCharges ? chargesTotal : round2(booking.totalAmount)
  const paid = round2(payments.reduce((s, p) => s + signed(p), 0))

  return {
    bookingId,
    /// Сколько должен: сумма строк начислений; без строк — сохранённый итог брони
    charged,
    chargesTotal,
    /// false — начислений ещё нет, «начислено» взято из Booking.totalAmount
    chargesFromRows: hasCharges,
    totalAmount: round2(booking.totalAmount),
    prepaidAmount: round2(booking.prepaidAmount),
    /// Сколько принято (возвраты вычтены, отменённые не в счёт)
    paid,
    /// Долг. Отрицательный — переплата, её видно так же явно, как недоплату
    due: round2(charged - paid),
  }
}

// ─── Чтение ──────────────────────────────────────────────────────────────────

// GET /api/payments/booking/:bookingId — журнал по брони + сводка денег
async function listByBooking(req, res, next) {
  try {
    const bookingId = parseInt(req.params.bookingId)
    const money = await bookingMoney(bookingId)
    if (!money) return next(createError('Бронь не найдена', 404))

    const payments = await prisma.payment.findMany({
      where: { bookingId },
      include: PAYMENT_INCLUDE,
      orderBy: [{ paidAt: 'desc' }, { id: 'desc' }],
    })
    res.json({ data: { payments, summary: money } })
  } catch (err) { next(err) }
}

// GET /api/payments/shift/:shiftId — все платежи смены
async function listByShift(req, res, next) {
  try {
    const shiftId = parseInt(req.params.shiftId)
    const shift = await prisma.shift.findUnique({ where: { id: shiftId } })
    if (!shift) return next(createError('Смена не найдена', 404))

    const payments = await prisma.payment.findMany({
      where: { shiftId },
      include: PAYMENT_INCLUDE,
      orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
    })
    res.json({ data: { shift, payments } })
  } catch (err) { next(err) }
}

/**
 * GET /api/payments/shift/:shiftId/summary — отчёт по кассе за смену.
 * Что нужно, чтобы смену реально закрыть:
 *   • по способам оплаты — наличные пересчитывают в ящике, карту и перевод
 *     сверяют с выпиской, поэтому одна итоговая цифра бесполезна;
 *   • приход и возвраты по отдельности — «принято 100 000» при 30 000 возврата
 *     это не то же самое, что «принято 70 000»;
 *   • кто принял — у смены может быть больше одного человека;
 *   • отменённые записи отдельной строкой: в кассу не идут, но объясняют
 *     разрыв в нумерации.
 */
async function shiftSummary(req, res, next) {
  try {
    const shiftId = parseInt(req.params.shiftId)
    const shift = await prisma.shift.findUnique({
      where: { id: shiftId },
      include: { createdBy: { select: { id: true, name: true } } },
    })
    if (!shift) return next(createError('Смена не найдена', 404))

    const payments = await prisma.payment.findMany({
      where: { shiftId },
      include: PAYMENT_INCLUDE,
      orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
    })

    const byMethod = METHODS.map((method) => {
      const rows = payments.filter((p) => p.method === method && !p.voidedAt)
      const received = round2(rows.filter((p) => p.kind === 'payment').reduce((s, p) => s + p.amount, 0))
      const refunded = round2(rows.filter((p) => p.kind === 'refund').reduce((s, p) => s + p.amount, 0))
      return { method, label: METHOD_LABELS[method], received, refunded, net: round2(received - refunded), count: rows.length }
    })

    const byAdminMap = new Map()
    for (const p of payments) {
      if (p.voidedAt) continue
      const key = p.adminId ?? `name:${p.adminName}`
      const cur = byAdminMap.get(key) || { adminId: p.adminId, adminName: p.adminName, received: 0, refunded: 0, count: 0 }
      if (p.kind === 'refund') cur.refunded += p.amount
      else cur.received += p.amount
      cur.count += 1
      byAdminMap.set(key, cur)
    }
    const byAdmin = [...byAdminMap.values()].map((a) => ({
      ...a, received: round2(a.received), refunded: round2(a.refunded), net: round2(a.received - a.refunded),
    }))

    const voided = payments.filter((p) => p.voidedAt)
    const received = round2(byMethod.reduce((s, m) => s + m.received, 0))
    const refunded = round2(byMethod.reduce((s, m) => s + m.refunded, 0))

    res.json({
      data: {
        shift,
        totals: {
          received,
          refunded,
          net: round2(received - refunded),
          count: payments.length - voided.length,
          voidedCount: voided.length,
          voidedAmount: round2(voided.reduce((s, p) => s + p.amount, 0)),
        },
        byMethod,
        byAdmin,
        payments,
      },
    })
  } catch (err) { next(err) }
}

// GET /api/payments/shift/current/summary — касса текущей смены (без знания её id)
async function currentShiftSummary(req, res, next) {
  try {
    const shift = await getCurrentShift()
    if (!shift) return next(createError('Смена ещё не открыта', 404))
    req.params.shiftId = String(shift.id)
    return shiftSummary(req, res, next)
  } catch (err) { next(err) }
}

/**
 * GET /api/payments/debts?q=&days= — «кто сколько должен».
 * Список броней с начислено / принято / долг. Это рабочий экран приёма оплаты:
 * администратор ищет гостя и сразу видит остаток, а не считает его в уме.
 *
 * Берём брони, которые ещё не уехали к рабочей дате (плюс `days` дней назад —
 * выехавшие с долгом не должны исчезать из виду сразу после выезда).
 * Суммы считаются ГРУППОВЫМИ запросами, а не по строке на бронь: иначе экран
 * на сотне броней делал бы сотни запросов к базе.
 */
async function debts(req, res, next) {
  try {
    const q = (req.query.q || '').trim()
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 0), 365)

    const businessDate = await getCurrentBusinessDate()
    const from = new Date(businessDate.getTime() - days * 24 * 60 * 60 * 1000)

    const where = {
      status: { in: ['CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT'] },
      checkOut: { gte: from },
    }
    if (q) {
      // Телефон в базе записан как попало (+7 701…, 8701…, со скобками), поэтому
      // по цифрам искать нельзя без нормализации — здесь простое «содержит».
      where.OR = [
        { guestName: { contains: q, mode: 'insensitive' } },
        { guestPhone: { contains: q } },
        { room: { number: { contains: q, mode: 'insensitive' } } },
      ]
    }

    const bookings = await prisma.booking.findMany({
      where,
      select: {
        id: true, guestName: true, guestPhone: true, checkIn: true, checkOut: true,
        status: true, totalAmount: true, prepaidAmount: true, paidAmount: true,
        room: { select: { id: true, number: true, building: true } },
      },
      orderBy: [{ checkIn: 'asc' }, { id: 'asc' }],
      take: 300,
    })
    const ids = bookings.map((b) => b.id)
    if (ids.length === 0) return res.json({ data: { businessDate, bookings: [] } })

    const chargeRows = await prisma.bookingCharge.groupBy({
      by: ['bookingId'],
      where: { bookingId: { in: ids } },
      _sum: { amount: true },
    })
    const chargeMap = new Map(chargeRows.map((r) => [r.bookingId, round2(r._sum.amount || 0)]))

    const paymentRows = await prisma.payment.findMany({
      where: { bookingId: { in: ids } },
      select: { bookingId: true, kind: true, amount: true, voidedAt: true },
    })
    const paidMap = new Map()
    for (const p of paymentRows) {
      paidMap.set(p.bookingId, (paidMap.get(p.bookingId) || 0) + signed(p))
    }

    const rows = bookings.map((b) => {
      const hasCharges = chargeMap.has(b.id)
      const charged = hasCharges ? chargeMap.get(b.id) : round2(b.totalAmount)
      const paid = round2(paidMap.get(b.id) || 0)
      return { ...b, charged, chargesFromRows: hasCharges, paid, due: round2(charged - paid) }
    })

    res.json({ data: { businessDate, bookings: rows } })
  } catch (err) { next(err) }
}

// ─── Запись ──────────────────────────────────────────────────────────────────

function parseAmount(raw) {
  const amount = round2(raw)
  if (!Number.isFinite(amount) || amount <= 0) return null
  return amount
}

/**
 * POST /api/payments — принять оплату (или провести возврат).
 * body: { bookingId, amount, kind?, method?, comment?, refundOfId? }
 *
 * Смена и рабочая дата проставляются СЕРВЕРОМ из текущей смены, а не приходят
 * с клиента: иначе платёж можно было бы записать в чужой день, и касса
 * закрывалась бы неверно.
 */
async function create(req, res, next) {
  try {
    const { bookingId, kind = 'payment', method = 'cash', comment, refundOfId } = req.body || {}

    const id = parseInt(bookingId)
    if (!Number.isInteger(id)) return next(createError('Укажите бронь', 400))
    if (!KINDS.includes(kind)) return next(createError('Неизвестный тип платежа', 400))
    if (!METHODS.includes(method)) return next(createError('Неизвестный способ оплаты', 400))

    const amount = parseAmount(req.body?.amount)
    if (amount === null) return next(createError('Сумма должна быть больше нуля', 400))

    const booking = await prisma.booking.findUnique({ where: { id }, select: { id: true } })
    if (!booking) return next(createError('Бронь не найдена', 404))

    let refundOf = null
    if (refundOfId != null) {
      refundOf = await prisma.payment.findUnique({ where: { id: parseInt(refundOfId) } })
      if (!refundOf) return next(createError('Исходный платёж не найден', 404))
      if (refundOf.bookingId !== id) return next(createError('Исходный платёж относится к другой брони', 400))
    }

    // Смена нужна всегда: платёж вне смены не попадёт ни в один отчёт по кассе.
    const shift = await ensureCurrentShift(req.admin.id)

    const payment = await prisma.$transaction(async (tx) => {
      const created = await tx.payment.create({
        data: {
          bookingId: id,
          kind,
          amount,
          method,
          adminId: req.admin.id,
          adminName: req.admin.name,
          shiftId: shift.id,
          businessDate: shift.date,
          comment: comment?.trim() || null,
          refundOfId: refundOf ? refundOf.id : null,
        },
        include: PAYMENT_INCLUDE,
      })
      await recalcBookingPaid(id, tx)
      return created
    })

    await notifyBookingMoneyChanged(id)
    res.status(201).json({ data: { payment, summary: await bookingMoney(id) } })
  } catch (err) { next(err) }
}

/**
 * POST /api/payments/:id/refund — возврат по конкретному платежу.
 * body: { amount?, method?, comment? } — по умолчанию возвращается вся сумма
 * тем же способом, каким принимали.
 *
 * Больше, чем принято по этому платежу, вернуть нельзя: это почти всегда
 * опечатка, а не намерение.
 */
async function refund(req, res, next) {
  try {
    const id = parseInt(req.params.id)
    const source = await prisma.payment.findUnique({ where: { id } })
    if (!source) return next(createError('Платёж не найден', 404))
    if (source.kind === 'refund') return next(createError('Нельзя вернуть возврат — проведите новый приём оплаты', 400))
    if (source.voidedAt) return next(createError('Платёж отменён, возврат по нему невозможен', 400))

    const amount = req.body?.amount == null ? round2(source.amount) : parseAmount(req.body.amount)
    if (amount === null) return next(createError('Сумма возврата должна быть больше нуля', 400))

    const already = await prisma.payment.aggregate({
      where: { refundOfId: id, kind: 'refund', voidedAt: null },
      _sum: { amount: true },
    })
    const left = round2(source.amount - (already._sum.amount || 0))
    if (amount > left) {
      return next(createError(
        left <= 0
          ? 'По этому платежу уже возвращена вся сумма'
          : `Больше принятого вернуть нельзя: доступно ${left}`,
        400,
      ))
    }

    const method = req.body?.method && METHODS.includes(req.body.method) ? req.body.method : source.method
    const shift = await ensureCurrentShift(req.admin.id)

    const payment = await prisma.$transaction(async (tx) => {
      const created = await tx.payment.create({
        data: {
          bookingId: source.bookingId,
          kind: 'refund',
          amount,
          method,
          adminId: req.admin.id,
          adminName: req.admin.name,
          shiftId: shift.id,
          businessDate: shift.date,
          comment: req.body?.comment?.trim() || null,
          refundOfId: source.id,
        },
        include: PAYMENT_INCLUDE,
      })
      await recalcBookingPaid(source.bookingId, tx)
      return created
    })

    await notifyBookingMoneyChanged(source.bookingId)
    res.status(201).json({ data: { payment, summary: await bookingMoney(source.bookingId) } })
  } catch (err) { next(err) }
}

/**
 * POST /api/payments/:id/void — отменить ОШИБОЧНУЮ запись.
 * body: { reason } — причина обязательна: отмена денежной строки без объяснения
 * это ровно та «уступка мимо системы», от которой уходим.
 *
 * Запись остаётся в журнале навсегда — удаления платежей в API нет.
 */
async function voidPayment(req, res, next) {
  try {
    const id = parseInt(req.params.id)
    const payment = await prisma.payment.findUnique({ where: { id } })
    if (!payment) return next(createError('Платёж не найден', 404))
    if (payment.voidedAt) return next(createError('Платёж уже отменён', 400))

    const reason = (req.body?.reason || '').trim()
    if (!reason) return next(createError('Укажите причину отмены', 400))

    // Отменять приход, по которому уже сделан возврат, нельзя: возврат повис бы
    // на несуществующей оплате, и касса перестала бы сходиться.
    const refunds = await prisma.payment.count({ where: { refundOfId: id, voidedAt: null } })
    if (refunds > 0) return next(createError('По платежу есть возвраты — сначала отмените их', 400))

    const updated = await prisma.$transaction(async (tx) => {
      const p = await tx.payment.update({
        where: { id },
        data: { voidedAt: new Date(), voidedById: req.admin.id, voidReason: reason },
        include: PAYMENT_INCLUDE,
      })
      await recalcBookingPaid(payment.bookingId, tx)
      return p
    })

    await notifyBookingMoneyChanged(payment.bookingId)
    res.json({ data: { payment: updated, summary: await bookingMoney(payment.bookingId) } })
  } catch (err) { next(err) }
}

/**
 * Оплата изменила `paidAmount` — остальные рабочие места должны увидеть это
 * в шахматке, иначе второй администратор возьмёт деньги повторно.
 * Сбой сокета не должен ронять сам платёж: деньги уже приняты.
 */
async function notifyBookingMoneyChanged(bookingId) {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { partner: true },
    })
    if (booking) emitBookingEvent('booking:updated', { booking })
  } catch (err) {
    logger.warn(`payments: не удалось разослать booking:updated — ${err.message}`)
  }
}

module.exports = {
  listByBooking,
  debts,
  listByShift,
  shiftSummary,
  currentShiftSummary,
  create,
  refund,
  voidPayment,
  recalcBookingPaid,
  bookingMoney,
  KINDS,
  METHODS,
  METHOD_LABELS,
}
