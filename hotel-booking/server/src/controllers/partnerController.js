const { prisma } = require('../utils/prisma')
const { createError } = require('../middleware/errorHandler')
// Партнёр (name/color) отдаётся в бронях сетки (кэш 30 с) — сбрасываем кэш после правок.
const { invalidateGridCache } = require('./occupancyController')

// GET /api/partners
async function list(_req, res, next) {
  try {
    const partners = await prisma.partner.findMany({
      orderBy: { name: 'asc' },
      include: {
        _count: { select: { allotments: true, bookings: true } },
      },
    })
    res.json({ data: partners })
  } catch (err) {
    next(err)
  }
}

// POST /api/partners
async function create(req, res, next) {
  try {
    const {
      name, color, defaultCheckInDay, defaultNights,
      commissionPercent, contactPerson, contactPhone, notes,
    } = req.body
    if (!name?.trim()) return next(createError('Укажите название партнёра', 400))

    const partner = await prisma.partner.create({
      data: {
        name: name.trim(),
        color: color || '#6366f1',
        defaultCheckInDay: defaultCheckInDay === undefined ? null
          : (defaultCheckInDay === null ? null : parseInt(defaultCheckInDay)),
        defaultNights: defaultNights ? parseInt(defaultNights) : 7,
        commissionPercent: commissionPercent != null ? parseFloat(commissionPercent) : null,
        contactPerson: contactPerson?.trim() || null,
        contactPhone:  contactPhone?.trim()  || null,
        notes:         notes?.trim()         || null,
      },
    })
    invalidateGridCache()
    res.status(201).json({ data: partner })
  } catch (err) {
    if (err.code === 'P2002') return next(createError('Партнёр с таким именем уже существует', 400))
    next(err)
  }
}

// PUT /api/partners/:id
async function update(req, res, next) {
  try {
    const id = parseInt(req.params.id)
    const {
      name, color, defaultCheckInDay, defaultNights,
      commissionPercent, contactPerson, contactPhone, notes, isActive,
    } = req.body

    const partner = await prisma.partner.update({
      where: { id },
      data: {
        ...(name              !== undefined && { name: name.trim() }),
        ...(color             !== undefined && { color }),
        ...(defaultCheckInDay !== undefined && {
          defaultCheckInDay: defaultCheckInDay === null ? null : parseInt(defaultCheckInDay),
        }),
        ...(defaultNights     !== undefined && { defaultNights: parseInt(defaultNights) }),
        ...(commissionPercent !== undefined && {
          commissionPercent: commissionPercent === null ? null : parseFloat(commissionPercent),
        }),
        ...(contactPerson !== undefined && { contactPerson: contactPerson?.trim() || null }),
        ...(contactPhone  !== undefined && { contactPhone:  contactPhone?.trim()  || null }),
        ...(notes         !== undefined && { notes:         notes?.trim()         || null }),
        ...(isActive      !== undefined && { isActive: !!isActive }),
      },
    })
    invalidateGridCache()
    res.json({ data: partner })
  } catch (err) {
    if (err.code === 'P2002') return next(createError('Партнёр с таким именем уже существует', 400))
    next(err)
  }
}

// DELETE /api/partners/:id
async function remove(req, res, next) {
  try {
    const id = parseInt(req.params.id)

    // Проверяем что нет броней с этим партнёром
    const bookingCount = await prisma.booking.count({
      where: { partnerId: id, status: { notIn: ['CANCELLED', 'CHECKED_OUT'] } },
    })
    if (bookingCount > 0) {
      return next(createError(
        `Нельзя удалить партнёра: ${bookingCount} активных броней. Закройте/отмените их сначала.`,
        400,
      ))
    }

    // Allotments и releases удалятся каскадно
    await prisma.partner.delete({ where: { id } })
    invalidateGridCache()
    res.json({ message: 'Партнёр удалён' })
  } catch (err) {
    next(err)
  }
}

module.exports = { list, create, update, remove }
