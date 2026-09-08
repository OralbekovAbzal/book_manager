const { prisma } = require('../utils/prisma')
const { createError } = require('../middleware/errorHandler')
const { round2, signedPayment: signed, loadBookingMoney, bookingMoney, resolveAccountId } = require('../utils/bookingMoney')
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
// Окно списка долгов: умолчание, потолок и предел выборки. `take` держим общим
// с ответом — по нему считается признак «список обрезан».
const DEBTS_DEFAULT_DAYS = 30
const DEBTS_MAX_DAYS = 365
const DEBTS_TAKE = 300
const METHODS = ['cash', 'card', 'transfer']
const METHOD_LABELS = { cash: 'Наличные', card: 'Карта', transfer: 'Перевод' }

const PAYMENT_INCLUDE = {
  admin: { select: { id: true, name: true, username: true } },
  voidedBy: { select: { id: true, name: true } },
  booking: { select: { id: true, guestName: true, room: { select: { id: true, number: true } } } },
}

// round2 / signed / bookingMoney живут в `utils/bookingMoney.js`: те же три
// формулы («начислено», «принято», «долг») нужны отчётам, а второе определение
// денег разойдётся с этим на тенге и найдётся не сразу.

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

// ─── Чтение ──────────────────────────────────────────────────────────────────

// GET /api/payments/booking/:bookingId — журнал по брони + сводка денег
async function listByBooking(req, res, next) {
  try {
    const bookingId = parseInt(req.params.bookingId)
    const money = await bookingMoney(bookingId)
    if (!money) return next(createError('Бронь не найдена', 404))

    // Журнал ведётся по СЧЁТУ: у продолжения после переезда своих платежей нет,
    // а стойка открывает журнал из той формы, что перед ней.
    const accountId = money.accountBookingId ?? bookingId
    const payments = await prisma.payment.findMany({
      where: { bookingId: accountId },
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
 * GET /api/payments/debts?q=&days=&all= — «кто сколько должен».
 * Список броней с начислено / принято / долг. Это рабочий экран приёма оплаты:
 * администратор ищет гостя и сразу видит остаток, а не считает его в уме.
 *
 * Берём брони, которые ещё не уехали к рабочей дате (плюс `days` дней назад —
 * выехавшие с долгом не должны исчезать из виду сразу после выезда).
 * Суммы считаются ГРУППОВЫМИ запросами, а не по строке на бронь: иначе экран
 * на сотне броней делал бы сотни запросов к базе.
 */
/**
 * Окно списка долгов: сколько дней после выезда бронь ещё видна в кассе.
 *
 * До этого окно было зашито в 30 дней и никак не показывалось на экране: долг
 * турфирмы за прошлый месяц не находился ни поиском, ни листанием, а «Долг всего»
 * считался по тем же 30 дням (аудит D6-002). Теперь окно можно снять — `days=0`
 * или `all=1`, — и оно возвращается в ответе, чтобы экран мог о нём сказать.
 *
 * @param {{days?: any, all?: any}} query
 * @returns {{ days: number|null }} null — без нижней границы («все долги»)
 */
function debtsWindow({ days, all } = {}) {
  const allRaw = all === undefined || all === null ? '' : String(all).toLowerCase()
  if (all === true || ['1', 'true', 'yes', 'on'].includes(allRaw)) return { days: null }

  if (days === undefined || days === null || days === '') return { days: DEBTS_DEFAULT_DAYS }
  const n = parseInt(days, 10)
  if (!Number.isFinite(n)) return { days: DEBTS_DEFAULT_DAYS }
  // Ноль — это «без границы», а не «только будущие выезды»: просить нулевое окно
  // осмысленно незачем, а «покажи всё» коротким числом просить удобно.
  // Отрицательное — мусор, а не «всё»: окно по умолчанию.
  if (n === 0) return { days: null }
  if (n < 0) return { days: DEBTS_DEFAULT_DAYS }
  return { days: Math.min(n, DEBTS_MAX_DAYS) }
}

async function debts(req, res, next) {
  try {
    const q = (req.query.q || '').trim()
    const { days } = debtsWindow(req.query)

    const businessDate = await getCurrentBusinessDate()

    const where = {
      status: { in: ['CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT'] },
      // days === null — «все долги»: нижней границы по выезду нет вовсе.
      // Без этого турфирма, платящая за прошлый месяц, в кассе не находилась
      // ни поиском, ни листанием (аудит D6-002).
      ...(days !== null && {
        checkOut: { gte: new Date(businessDate.getTime() - days * 24 * 60 * 60 * 1000) },
      }),
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

    const DEBT_SELECT = {
      id: true, guestName: true, guestPhone: true, checkIn: true, checkOut: true,
      status: true, totalAmount: true, prepaidAmount: true, paidAmount: true,
      // Счёт цепочки: продолжения в списке не показываем, но их даты, номера и
      // статус нужны голове — иначе живущий гость выпадет из кассы через `days`
      // дней после переезда (у головы `checkOut` = дата переезда).
      accountBookingId: true,
      room: { select: { id: true, number: true, building: true } },
    }

    // Отменённые берём ОТДЕЛЬНЫМ запросом, а не расширением статусов: их в базе
    // заметно больше живых, и общая выборка с `take` вытеснила бы настоящие долги.
    // Нужны только те, где деньги не закрыты — невозвращённая предоплата или
    // удержание по ручной строке; раньше такая бронь исчезала из виду совсем
    // (аудит D2-006). Фильтр по нулю — ниже, после подсчёта денег.
    const cancelledWhere = { ...where, status: 'CANCELLED' }

    const [active, cancelled] = await Promise.all([
      prisma.booking.findMany({
        where, select: DEBT_SELECT, orderBy: [{ checkIn: 'asc' }, { id: 'asc' }], take: DEBTS_TAKE,
      }),
      prisma.booking.findMany({
        where: cancelledWhere, select: DEBT_SELECT, orderBy: [{ checkIn: 'asc' }, { id: 'asc' }], take: DEBTS_TAKE,
      }),
    ])
    const matched = [...active, ...cancelled]
    // Признак обрезки — по ИСХОДНЫМ выборкам, до сворачивания цепочек и отсева
    // отменённых без денег: иначе 400 должников, свернувшихся в 150 строк, выглядели
    // бы полным списком (находка тестов волны 9).
    const truncated = active.length >= DEBTS_TAKE || cancelled.length >= DEBTS_TAKE
    if (matched.length === 0) return res.json({ data: { businessDate, bookings: [], window: { days, truncated: false } } })

    // ── Цепочка = одна строка ──
    // Совпасть с фильтром (по дате выезда или по номеру) мог любой отрезок, а
    // показать нужно голову: деньги на ней. Поэтому от совпавших поднимаемся к
    // головам и добираем ВСЕ их части.
    const headIds = [...new Set(matched.map((b) => b.accountBookingId ?? b.id))]
    const byId = new Map(matched.map((b) => [b.id, b]))
    const absentHeads = headIds.filter((id) => !byId.has(id))
    const [extraHeads, continuations] = await Promise.all([
      absentHeads.length > 0
        ? prisma.booking.findMany({ where: { id: { in: absentHeads } }, select: DEBT_SELECT })
        : Promise.resolve([]),
      prisma.booking.findMany({
        where: { accountBookingId: { in: headIds } },
        select: DEBT_SELECT,
        orderBy: [{ checkIn: 'asc' }, { id: 'asc' }],
      }),
    ])
    for (const h of extraHeads) byId.set(h.id, h)

    const partsByHead = new Map()
    for (const c of continuations) {
      if (c.status === 'CANCELLED') continue  // переезд отыграли назад — счёту он не отрезок
      if (!partsByHead.has(c.accountBookingId)) partsByHead.set(c.accountBookingId, [])
      partsByHead.get(c.accountBookingId).push(c)
    }

    const heads = headIds.map((id) => byId.get(id)).filter(Boolean)
    if (heads.length === 0) return res.json({ data: { businessDate, bookings: [], window: { days, truncated: false } } })

    const money = await loadBookingMoney(heads)
    const rows = heads
      .map((b) => {
        const m = money.get(b.id)
        const parts = partsByHead.get(b.id) || []
        const last = parts.length > 0 ? parts[parts.length - 1] : null
        return {
          ...b,
          charged: m.charged, chargesFromRows: m.chargesFromRows, paid: m.paid, due: m.due,
          // «12 → 15»: клиент читает `rooms`, если поле есть; `room` оставлен как
          // у головы, чтобы старая разметка и поиск по номеру не сломались.
          ...(parts.length > 0 && {
            rooms: [b.room?.number, ...parts.map((p) => p.room?.number)].filter(Boolean).join(' → '),
            // Срок всей цепочки: заезд первого отрезка → выезд последнего
            checkOut: last.checkOut,
            // Статус текущего отрезка: голова после переезда всегда CHECKED_OUT
            status: last.status,
            segmentIds: [b.id, ...parts.map((p) => p.id)],
          }),
        }
      })
      // Отменённая с закрытыми деньгами в рабочем списке не нужна: она ничего не требует
      .filter((b) => b.status !== 'CANCELLED' || b.paid !== 0 || b.due !== 0)
      .sort((a, b) => (a.checkIn - b.checkIn) || (a.id - b.id))

    res.json({ data: { businessDate, bookings: rows, window: { days, truncated } } })
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
    // «Свободный» возврат отменён (решение владельца 2026-09-08): этот путь не проверял
    // ни наличие исходного платежа, ни лимит остатком, и одной кнопкой рисовал в кассе
    // возврат при нулевом приходе (аудит D2-001). Возврат — только по записи журнала.
    if (kind === 'refund') {
      return next(createError('Возврат — только по конкретному платежу: откройте запись в журнале', 400))
    }
    if (!METHODS.includes(method)) return next(createError('Неизвестный способ оплаты', 400))

    const amount = parseAmount(req.body?.amount)
    if (amount === null) return next(createError('Сумма должна быть больше нуля', 400))

    // Деньги пишутся на СЧЁТ: у гостя, переехавшего в другой номер, счёт один,
    // и оплата, принятая в форме продолжения, обязана попасть на голову цепочки.
    const accountId = await resolveAccountId(id)
    if (accountId === null) return next(createError('Бронь не найдена', 404))

    let refundOf = null
    if (refundOfId != null) {
      refundOf = await prisma.payment.findUnique({ where: { id: parseInt(refundOfId) } })
      if (!refundOf) return next(createError('Исходный платёж не найден', 404))
      if (refundOf.bookingId !== accountId) return next(createError('Исходный платёж относится к другой брони', 400))
    }

    // Смена нужна всегда: платёж вне смены не попадёт ни в один отчёт по кассе.
    const shift = await ensureCurrentShift(req.admin.id)

    const payment = await prisma.$transaction(async (tx) => {
      const created = await tx.payment.create({
        data: {
          bookingId: accountId,
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
      await recalcBookingPaid(accountId, tx)
      return created
    })

    await notifyBookingMoneyChanged(accountId)
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
    // Событие уходит по ВСЕМ отрезкам счёта: деньги лежат на голове, а показывают
    // их обе части цепочки — приняли оплату в продолжении, а долг в шахматке
    // остался бы старым у головы (и наоборот).
    const headId = (await resolveAccountId(bookingId)) ?? bookingId
    const parts = await prisma.booking.findMany({
      where: { accountBookingId: headId }, select: { id: true },
    })
    const ids = [headId, ...parts.map((p) => p.id)]
    for (const id of ids) {
      const booking = await prisma.booking.findUnique({
        where: { id },
        include: { partner: true },
      })
      if (booking) emitBookingEvent('booking:updated', { booking })
    }
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
  // Для settlementController (расчёт с гостем): он пишет возвраты теми же полями
  // и обязан разослать то же событие — второй реализации денег быть не должно
  notifyBookingMoneyChanged,
  PAYMENT_INCLUDE,
  KINDS,
  METHODS,
  METHOD_LABELS,
  // Окно списка долгов — чистая функция: правило «сколько дней видно» проверяется
  // без базы и без запроса (D6-002)
  debtsWindow,
  DEBTS_TAKE,
}
