const router = require('express').Router()
const { authenticate } = require('../middleware/auth')
const { prisma } = require('../utils/prisma')

router.use(authenticate)

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
