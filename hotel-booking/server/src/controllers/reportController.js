const { prisma } = require('../utils/prisma')
const { createError } = require('../middleware/errorHandler')

// GET /api/reports/occupancy?dateFrom=&dateTo=
async function occupancy(req, res, next) {
  try {
    const { dateFrom, dateTo } = req.query
    if (!dateFrom || !dateTo) return next(createError('dateFrom и dateTo обязательны', 400))

    const from = new Date(dateFrom)
    const to = new Date(dateTo)
    const totalDays = Math.ceil((to - from) / 86400_000)

    const rooms = await prisma.room.findMany({
      where: { isActive: true },
      select: {
        id: true,
        number: true,
        building: true,
        floor: true,
        category: { select: { id: true, name: true } },
        bookings: {
          where: {
            status: { notIn: ['CANCELLED', 'NO_SHOW'] },
            checkIn: { lt: to },
            checkOut: { gt: from },
          },
          select: { checkIn: true, checkOut: true, status: true },
        },
      },
      orderBy: [{ building: 'asc' }, { floor: 'asc' }, { number: 'asc' }],
    })

    const data = rooms.map((room) => {
      let occupiedDays = 0
      for (const b of room.bookings) {
        const start = new Date(Math.max(b.checkIn.getTime(), from.getTime()))
        const end = new Date(Math.min(b.checkOut.getTime(), to.getTime()))
        occupiedDays += Math.max(0, Math.ceil((end - start) / 86400_000))
      }
      return {
        roomId: room.id,
        number: room.number,
        building: room.building,
        floor: room.floor,
        category: room.category,
        occupiedDays,
        totalDays,
        occupancyRate: Math.round((occupiedDays / totalDays) * 100),
      }
    })

    const avgOccupancy =
      data.length > 0
        ? Math.round(data.reduce((s, r) => s + r.occupancyRate, 0) / data.length)
        : 0

    res.json({ dateFrom, dateTo, totalDays, avgOccupancy, data })
  } catch (err) {
    next(err)
  }
}

// GET /api/reports/bookings?dateFrom=&dateTo=&status=&categoryId=&building=
async function bookings(req, res, next) {
  try {
    const { dateFrom, dateTo, status, categoryId, building, page = 1, limit = 100 } = req.query
    if (!dateFrom || !dateTo) return next(createError('dateFrom и dateTo обязательны', 400))

    const where = {
      checkIn: { lt: new Date(dateTo) },
      checkOut: { gt: new Date(dateFrom) },
    }
    if (status) where.status = status
    if (categoryId) where.room = { categoryId: parseInt(categoryId) }
    if (building) where.room = { ...where.room, building }

    const [data, total] = await prisma.$transaction([
      prisma.booking.findMany({
        where,
        select: {
          id: true,
          guestName: true,
          guestPhone: true,
          checkIn: true,
          checkOut: true,
          status: true,
          source: true,
          notes: true,
          createdAt: true,
          room: {
            select: {
              number: true,
              building: true,
              floor: true,
              category: { select: { name: true } },
            },
          },
          createdBy: { select: { name: true } },
        },
        orderBy: { checkIn: 'asc' },
        skip: (parseInt(page) - 1) * parseInt(limit),
        take: parseInt(limit),
      }),
      prisma.booking.count({ where }),
    ])

    res.json({ dateFrom, dateTo, total, page: parseInt(page), limit: parseInt(limit), data })
  } catch (err) {
    next(err)
  }
}

module.exports = { occupancy, bookings }
