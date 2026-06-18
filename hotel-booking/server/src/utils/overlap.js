const { prisma } = require('./prisma')

const ACTIVE_STATUSES = ['CONFIRMED', 'CHECKED_IN']

/**
 * Проверяет пересечение брони с существующими.
 * Логика: новая бронь пересекается если checkIn < existingCheckOut AND checkOut > existingCheckIn
 * @returns {object|null} конфликтующая бронь или null
 */
async function findOverlap({ roomId, checkIn, checkOut, excludeBookingId = null }) {
  const where = {
    roomId,
    status: { in: ACTIVE_STATUSES },
    checkIn: { lt: new Date(checkOut) },
    checkOut: { gt: new Date(checkIn) },
  }

  if (excludeBookingId) {
    where.id = { not: excludeBookingId }
  }

  return prisma.booking.findFirst({
    where,
    select: {
      id: true,
      guestName: true,
      checkIn: true,
      checkOut: true,
      status: true,
    },
  })
}

/**
 * Проверяет пересечения для нескольких номеров сразу (для клиентской валидации).
 * @returns {Map<roomId, conflict>}
 */
async function findOverlapsBulk({ roomIds, checkIn, checkOut }) {
  const conflicts = await prisma.booking.findMany({
    where: {
      roomId: { in: roomIds },
      status: { in: ACTIVE_STATUSES },
      checkIn: { lt: new Date(checkOut) },
      checkOut: { gt: new Date(checkIn) },
    },
    select: { id: true, roomId: true, guestName: true, checkIn: true, checkOut: true },
  })

  return new Map(conflicts.map((c) => [c.roomId, c]))
}

module.exports = { findOverlap, findOverlapsBulk }
