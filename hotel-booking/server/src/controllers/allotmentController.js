const { prisma } = require('../utils/prisma')
const { createError } = require('../middleware/errorHandler')

/**
 * Проверка: на тот же номер не должно быть пересекающейся аллокации
 * (включая текущую аллокацию для другого партнёра).
 * Возвращает конфликтующую аллокацию или null.
 */
async function findConflictingAllotment({ roomId, dateFrom, dateTo, excludeId }) {
  const from = new Date(dateFrom)
  const to   = new Date(dateTo)
  if (to <= from) throw createError('Дата окончания должна быть позже даты начала', 400)

  const conflict = await prisma.allotment.findFirst({
    where: {
      roomId,
      ...(excludeId ? { id: { not: excludeId } } : {}),
      // overlap: a.from < b.to AND a.to > b.from
      dateFrom: { lt: to },
      dateTo:   { gt: from },
    },
    include: {
      partner: { select: { id: true, name: true, color: true } },
      room:    { select: { id: true, number: true } },
    },
  })
  return conflict
}

// GET /api/allotments?partnerId=&roomId=&from=&to=
async function list(req, res, next) {
  try {
    const { partnerId, roomId, from, to } = req.query
    const where = {}
    if (partnerId) where.partnerId = parseInt(partnerId)
    if (roomId)    where.roomId    = parseInt(roomId)
    if (from && to) {
      where.dateFrom = { lt: new Date(to) }
      where.dateTo   = { gt: new Date(from) }
    }

    const allotments = await prisma.allotment.findMany({
      where,
      orderBy: [{ dateFrom: 'asc' }, { roomId: 'asc' }],
      include: {
        partner: { select: { id: true, name: true, color: true } },
        room:    { select: { id: true, number: true, building: true, floor: true } },
        releases: { orderBy: { dateFrom: 'asc' } },
      },
    })
    res.json({ data: allotments })
  } catch (err) {
    next(err)
  }
}

// POST /api/allotments
async function create(req, res, next) {
  try {
    const { partnerId, roomId, dateFrom, dateTo, notes } = req.body
    if (!partnerId || !roomId || !dateFrom || !dateTo) {
      return next(createError('Укажите партнёра, номер и период', 400))
    }

    const pid = parseInt(partnerId)
    const rid = parseInt(roomId)

    // Конфликт с другой аллокацией?
    const conflict = await findConflictingAllotment({ roomId: rid, dateFrom, dateTo })
    if (conflict) {
      return next(createError(
        `На номер №${conflict.room.number} уже есть квота партнёра «${conflict.partner.name}» ` +
        `(${conflict.dateFrom.toISOString().slice(0, 10)} — ${conflict.dateTo.toISOString().slice(0, 10)}). ` +
        `Один номер не может одновременно принадлежать двум партнёрам.`,
        400,
      ))
    }

    const allotment = await prisma.allotment.create({
      data: {
        partnerId: pid,
        roomId: rid,
        dateFrom: new Date(dateFrom),
        dateTo:   new Date(dateTo),
        notes: notes?.trim() || null,
      },
      include: {
        partner: { select: { id: true, name: true, color: true } },
        room:    { select: { id: true, number: true, building: true, floor: true } },
      },
    })

    // Кэш грида
    const { invalidateGridCache } = require('./occupancyController')
    invalidateGridCache()

    res.status(201).json({ data: allotment })
  } catch (err) {
    next(err)
  }
}

// PUT /api/allotments/:id
async function update(req, res, next) {
  try {
    const id = parseInt(req.params.id)
    const { partnerId, roomId, dateFrom, dateTo, notes } = req.body

    const existing = await prisma.allotment.findUnique({ where: { id } })
    if (!existing) return next(createError('Квота не найдена', 404))

    const targetRoomId   = roomId   != null ? parseInt(roomId)   : existing.roomId
    const targetFromStr  = dateFrom || existing.dateFrom.toISOString().slice(0, 10)
    const targetToStr    = dateTo   || existing.dateTo.toISOString().slice(0, 10)

    const conflict = await findConflictingAllotment({
      roomId: targetRoomId,
      dateFrom: targetFromStr,
      dateTo: targetToStr,
      excludeId: id,
    })
    if (conflict) {
      return next(createError(
        `На номер №${conflict.room.number} уже есть квота партнёра «${conflict.partner.name}» в этих датах.`,
        400,
      ))
    }

    const allotment = await prisma.allotment.update({
      where: { id },
      data: {
        ...(partnerId !== undefined && { partnerId: parseInt(partnerId) }),
        ...(roomId    !== undefined && { roomId: parseInt(roomId) }),
        ...(dateFrom  !== undefined && { dateFrom: new Date(dateFrom) }),
        ...(dateTo    !== undefined && { dateTo: new Date(dateTo) }),
        ...(notes     !== undefined && { notes: notes?.trim() || null }),
      },
      include: {
        partner: { select: { id: true, name: true, color: true } },
        room:    { select: { id: true, number: true, building: true, floor: true } },
      },
    })

    const { invalidateGridCache } = require('./occupancyController')
    invalidateGridCache()

    res.json({ data: allotment })
  } catch (err) {
    next(err)
  }
}

// DELETE /api/allotments/:id
async function remove(req, res, next) {
  try {
    const id = parseInt(req.params.id)
    // Releases удалятся каскадно
    await prisma.allotment.delete({ where: { id } })

    const { invalidateGridCache } = require('./occupancyController')
    invalidateGridCache()

    res.json({ message: 'Квота удалена' })
  } catch (err) {
    next(err)
  }
}

// POST /api/allotments/:id/releases
async function createRelease(req, res, next) {
  try {
    const allotmentId = parseInt(req.params.id)
    const { dateFrom, dateTo, reason } = req.body
    if (!dateFrom || !dateTo) return next(createError('Укажите период освобождения', 400))

    const allotment = await prisma.allotment.findUnique({ where: { id: allotmentId } })
    if (!allotment) return next(createError('Квота не найдена', 404))

    const from = new Date(dateFrom)
    const to   = new Date(dateTo)
    if (to <= from) return next(createError('Дата окончания должна быть позже даты начала', 400))
    if (from < allotment.dateFrom || to > allotment.dateTo) {
      return next(createError('Период освобождения должен быть внутри периода квоты', 400))
    }

    const release = await prisma.release.create({
      data: {
        allotmentId,
        dateFrom: from,
        dateTo:   to,
        reason: reason?.trim() || null,
      },
    })

    const { invalidateGridCache } = require('./occupancyController')
    invalidateGridCache()

    res.status(201).json({ data: release })
  } catch (err) {
    next(err)
  }
}

// DELETE /api/releases/:id
async function removeRelease(req, res, next) {
  try {
    const id = parseInt(req.params.id)
    await prisma.release.delete({ where: { id } })

    const { invalidateGridCache } = require('./occupancyController')
    invalidateGridCache()

    res.json({ message: 'Релиз удалён' })
  } catch (err) {
    next(err)
  }
}

module.exports = { list, create, update, remove, createRelease, removeRelease }
