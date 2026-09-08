const router = require('express').Router()
const { authenticate, requireRole } = require('../middleware/auth')
const { prisma } = require('../utils/prisma')
const { hotelTz } = require('../utils/hotelTz')
const { auditPeriodRange } = require('../utils/auditPeriod')

router.use(authenticate)

// Граница периода из query: 'YYYY-MM-DD' — календарный день (UTC), иначе — ISO-момент
// (клиент шлёт границы местных суток как ISO). Возвращает { at, dayOnly } или null.
function parseBoundary(value) {
  if (!value) return null
  const s = String(value)
  const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(s)
  const at = new Date(dayOnly ? `${s}T00:00:00.000Z` : s)
  return Number.isNaN(at.getTime()) ? null : { at, dayOnly }
}

// GET /api/audit/log?limit=100&adminId=&dateFrom=&dateTo= — журнал действий, новые сверху
router.get('/log', requireRole('SUPER_ADMIN', 'ADMIN'), async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500)
    const where = {}
    const adminId = parseInt(req.query.adminId, 10)
    if (Number.isInteger(adminId)) where.adminId = adminId

    const from = parseBoundary(req.query.dateFrom)
    const to = parseBoundary(req.query.dateTo)
    if (from || to) {
      where.createdAt = {}
      if (from) where.createdAt.gte = from.at
      // День указан целиком → включительно (до следующей полуночи)
      if (to) {
        if (to.dayOnly) where.createdAt.lt = new Date(to.at.getTime() + 86400_000)
        else where.createdAt.lte = to.at
      }
    }

    const data = await prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit })
    res.json({ data })
  } catch (err) { next(err) }
})

/**
 * GET /api/audit?period=today|week|month|shift&shiftId=123 — сколько броней ЗАВЕДЕНО.
 *
 * Денег здесь больше нет (аудит D6-003). Суммы `Booking.totalAmount/paidAmount`
 * выводились под подписями «Выручка / Оплачено / Задолженность», но считались
 * по броням, СОЗДАННЫМ в период, — независимо от дат проживания, включая брони на
 * следующий год. Ни с кассой смены, ни с отчётом «Выручка» это не сходилось и
 * сойтись не могло. Деньги теперь спрашивают у отчётов, где у них есть период
 * проживания и датасет начислений; здесь остаётся то, ради чего окно и открывают, —
 * счётчики заведённых броней.
 *
 * Периоды — по МЕСТНЫМ суткам отеля, а не по календарю процесса: сервер живёт
 * в UTC, и «Сегодня» с полуночи до пяти утра по Алматы показывало вчерашний день.
 */
router.get('/', async (req, res, next) => {
  try {
    const { period, shiftId } = req.query
    const tz = hotelTz()
    const { from } = auditPeriodRange(period, new Date(), tz)

    const where = {
      status: { not: 'CANCELLED' },
    }

    let byShift = false
    if (shiftId !== undefined && shiftId !== '') {
      const id = Number(shiftId)
      if (!Number.isInteger(id) || id < 0) return res.status(400).json({ error: 'shiftId: целое число' })
      where.shiftId = id
      byShift = true
    } else if (from) {
      where.createdAt = { gte: from }
    }

    const [bookings, counts] = await Promise.all([
      prisma.booking.aggregate({
        where,
        _count: { id: true },
      }),
      prisma.booking.groupBy({
        by: ['status'],
        where,
        _count: { id: true },
      }),
    ])

    res.json({
      data: {
        bookingCount: bookings._count.id,
        byStatus: counts,
        // Границу отдаём явно: экран обязан иметь возможность подписать, за какой
        // именно отрезок показаны числа. `to` всегда «сейчас», поэтому null.
        // По смене период не применялся — и подписывать цифры смены месяцем нельзя.
        period: { from: !byShift && from ? from.toISOString() : null, to: null, tz },
      }
    })
  } catch (err) { next(err) }
})

module.exports = router
