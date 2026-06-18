const { prisma } = require('./prisma')

/**
 * Device/server calendar day as UTC midnight.
 * ONLY used as a one-time seed when no shift exists yet — never to advance the day.
 */
function todayUTC() {
  const d = new Date()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

/**
 * The current business/working date is the date of the most recent Shift.
 * It changes ONLY when an admin presses "Следующий день" (POST /api/shifts/next-day).
 * It is NOT derived from the device clock, so the day never advances on its own.
 */
async function getCurrentShift() {
  return prisma.shift.findFirst({ orderBy: { date: 'desc' } })
}

/**
 * Current business date as a UTC Date.
 * Falls back to the device day only if no shift has ever been created.
 */
async function getCurrentBusinessDate() {
  const shift = await getCurrentShift()
  return shift ? new Date(shift.date) : todayUTC()
}

/**
 * Ensure at least one shift exists. Bootstraps with the device day the very
 * first time (seed). Returns the current shift. Requires an adminId to seed.
 */
async function ensureCurrentShift(adminId) {
  let shift = await getCurrentShift()
  if (!shift) {
    shift = await prisma.shift.create({ data: { date: todayUTC(), createdById: adminId } })
  }
  return shift
}

module.exports = { todayUTC, getCurrentShift, getCurrentBusinessDate, ensureCurrentShift }
