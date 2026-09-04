const router = require('express').Router()
const { authenticate, requireRole } = require('../middleware/auth')
const { prisma } = require('../utils/prisma')

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

// GET /api/audit?period=today|week|month|shift&shiftId=123
router.get('/', async (req, res, next) => {
  try {
    const { period, shiftId } = req.query
    const now = new Date()

    let dateFrom
    if (period === 'today') {
      dateFrom = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    } else if (period === 'week') {
      dateFrom = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    } else if (period === 'month') {
      dateFrom = new Date(now.getFullYear(), now.getMonth(), 1)
    }

    const where = {
      status: { not: 'CANCELLED' },
    }

    if (shiftId) {
      where.shiftId = parseInt(shiftId)
    } else if (dateFrom) {
      where.createdAt = { gte: dateFrom }
    }

    const [bookings, counts] = await Promise.all([
      prisma.booking.aggregate({
        where,
        _sum: { totalAmount: true, prepaidAmount: true, paidAmount: true },
        _count: { id: true },
      }),
      prisma.booking.groupBy({
        by: ['status'],
        where,
        _count: { id: true },
        _sum: { totalAmount: true },
      }),
    ])

    res.json({
      data: {
        totalAmount: bookings._sum.totalAmount || 0,
        totalPrepaid: bookings._sum.prepaidAmount || 0,
        totalPaid: bookings._sum.paidAmount || 0,
        totalDebt: (bookings._sum.totalAmount || 0) - (bookings._sum.paidAmount || 0),
        bookingCount: bookings._count.id,
        byStatus: counts,
      }
    })
  } catch (err) { next(err) }
})

module.exports = router
