const { prisma } = require('../utils/prisma')
const { todayUTC } = require('../utils/businessDate')
const { invalidateGridCache } = require('./occupancyController')
const { createSnapshot } = require('../utils/snapshot')

const INCLUDE = {
  createdBy: { select: { id: true, name: true } },
  _count: { select: { bookings: true } },
}

// GET /api/shifts — list all shifts (newest first)
async function list(req, res, next) {
  try {
    const shifts = await prisma.shift.findMany({
      orderBy: { date: 'desc' },
      take: 60,
      include: INCLUDE,
    })
    res.json({ data: shifts })
  } catch (err) { next(err) }
}

// GET /api/shifts/current — return the current business day (latest shift).
// The day NEVER advances automatically; it only changes via POST /next-day.
// On the very first run (no shifts yet) we seed one with the device date.
async function current(req, res, next) {
  try {
    const adminId = req.admin.id

    let shift = await prisma.shift.findFirst({
      orderBy: { date: 'desc' },
      include: INCLUDE,
    })

    if (!shift) {
      shift = await prisma.shift.create({
        data: { date: todayUTC(), createdById: adminId },
        include: INCLUDE,
      })
    }

    res.json({ data: shift })
  } catch (err) { next(err) }
}

// POST /api/shifts/next-day — advance to the next calendar day
async function nextDay(req, res, next) {
  try {
    const adminId = req.admin.id

    // Find the most recent shift
    const latest = await prisma.shift.findFirst({ orderBy: { date: 'desc' } })

    // The "current" working date is either the latest shift's date or today
    const currentDate = latest ? new Date(latest.date) : todayUTC()

    // ── Guard: block if any guests should have checked out but haven't ──────
    // checkOut <= currentDate means the departure date is today or earlier,
    // but the booking is still CHECKED_IN (guest physically in the room).
    const overdue = await prisma.booking.findMany({
      where: {
        checkOut: { lte: currentDate },
        status: 'CHECKED_IN',
      },
      select: {
        id: true,
        guestName: true,
        checkOut: true,
        room: { select: { number: true, building: true } },
      },
      orderBy: { checkOut: 'asc' },
    })

    if (overdue.length > 0) {
      return res.status(409).json({
        error: 'Есть номера с просроченным выездом. Оформите выезд перед переходом на следующий день.',
        overdueCheckouts: overdue,
      })
    }
    // ────────────────────────────────────────────────────────────────────────

    const nextDate = new Date(currentDate.getTime() + 24 * 60 * 60 * 1000)

    // Upsert: create if not exists, do nothing if already exists
    const shift = await prisma.shift.upsert({
      where: { date: nextDate },
      create: { date: nextDate, createdById: adminId },
      update: {},
      include: INCLUDE,
    })

    // Сетка центрируется на рабочем дне — сбрасываем кэш, чтобы линия "сегодня" сдвинулась сразу
    invalidateGridCache()

    // Снимок на старте новой смены — точка отката перед рабочим днём
    try {
      const dateLabel = nextDate.toISOString().slice(0, 10).split('-').reverse().join('.')
      await createSnapshot({ kind: 'shift', label: `Начало смены ${dateLabel}`, createdById: adminId })
    } catch (err) { /* снимок не критичен для перехода смены */ }

    res.status(201).json({ data: shift })
  } catch (err) { next(err) }
}

module.exports = { list, current, nextDay }
