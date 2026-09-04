const { prisma } = require('../utils/prisma')
const { checkRoomsAvailability, parseFlags } = require('../utils/availability')
const { createError } = require('../middleware/errorHandler')
// Сетка /api/occupancy/grid кэшируется на 30 с — после правки номеров сбрасываем кэш,
// иначе новые/переименованные/скрытые номера появляются в сетке с задержкой.
const { invalidateGridCache } = require('./occupancyController')

const ROOM_SELECT = {
  id: true,
  number: true,
  building: true,
  floor: true,
  features: true,
  capacity: true,
  isActive: true,
  createdAt: true,
  category: { select: { id: true, name: true, color: true } },
}

// GET /api/rooms
async function list(req, res, next) {
  try {
    const { categoryId, building, floor, isActive } = req.query

    const where = {}
    if (categoryId) where.categoryId = parseInt(categoryId)
    if (building) where.building = building
    if (floor) where.floor = parseInt(floor)
    if (isActive !== undefined) where.isActive = isActive !== 'false'

    const rooms = await prisma.room.findMany({
      where,
      select: ROOM_SELECT,
      orderBy: [{ building: 'asc' }, { floor: 'asc' }, { number: 'asc' }],
    })

    res.json({ data: rooms })
  } catch (err) {
    next(err)
  }
}

// GET /api/rooms/availability?checkIn=&checkOut=&categoryId=&building=&flags=&partnerId=&excludeBookingId=
// «Свободно» здесь считает общая утилита utils/availability — те же три проверки,
// что при создании брони (пересечения, буферы меток, квоты партнёров). Раньше тут
// смотрелись только пересечения, и подбор показывал зелёным номер, который
// сохранение отбивало 409.
async function availability(req, res, next) {
  try {
    const { checkIn, checkOut, categoryId, building, floor, partnerId, excludeBookingId } = req.query

    if (!checkIn || !checkOut) {
      return next(createError('checkIn и checkOut обязательны', 400))
    }
    if (new Date(checkOut) <= new Date(checkIn)) {
      return next(createError('checkOut должен быть позже checkIn', 400))
    }

    const where = { isActive: true }
    if (categoryId) where.categoryId = parseInt(categoryId)
    if (building) where.building = building
    if (floor) where.floor = parseInt(floor)

    const rooms = await prisma.room.findMany({
      where,
      select: { ...ROOM_SELECT },
      orderBy: [{ building: 'asc' }, { floor: 'asc' }, { number: 'asc' }],
    })

    const roomIds = rooms.map((r) => r.id)
    const checked = await checkRoomsAvailability({
      roomIds,
      checkIn,
      checkOut,
      flags: parseFlags(req.query.flags),
      partnerId: partnerId ? parseInt(partnerId) : null,
      excludeBookingId: excludeBookingId ? parseInt(excludeBookingId) : null,
    })

    const result = rooms.map((room) => {
      const st = checked.get(room.id)
      return {
        ...room,
        available: st.available,
        conflict: st.conflict,
        // Почему занято: overlap | buffer | allotment — чтобы экран подбора мог
        // объяснить причину, а не просто покрасить номер красным.
        reason: st.reason,
        reasonText: st.message,
      }
    })

    res.json({ data: result })
  } catch (err) {
    next(err)
  }
}

// POST /api/rooms
async function create(req, res, next) {
  try {
    const { number, categoryId, building, floor, features, capacity } = req.body

    const room = await prisma.room.create({
      data: {
        number: number.trim().toUpperCase(),
        categoryId: parseInt(categoryId),
        building: building.trim().toUpperCase(),
        floor: parseInt(floor),
        features: features || [],
        capacity: capacity || '',
      },
      select: ROOM_SELECT,
    })

    invalidateGridCache()
    res.status(201).json({ data: room })
  } catch (err) {
    next(err)
  }
}

// PUT /api/rooms/:id
async function update(req, res, next) {
  try {
    const id = parseInt(req.params.id)
    const { number, categoryId, building, floor, features, capacity, isActive } = req.body

    const room = await prisma.room.update({
      where: { id },
      data: {
        ...(number !== undefined && { number: number.trim().toUpperCase() }),
        ...(categoryId !== undefined && { categoryId: parseInt(categoryId) }),
        ...(building !== undefined && { building: building.trim().toUpperCase() }),
        ...(floor !== undefined && { floor: parseInt(floor) }),
        ...(features !== undefined && { features }),
        ...(capacity !== undefined && { capacity }),
        ...(isActive !== undefined && { isActive }),
      },
      select: ROOM_SELECT,
    })

    invalidateGridCache()
    res.json({ data: room })
  } catch (err) {
    next(err)
  }
}

// DELETE /api/rooms/:id — деактивация (не удаление)
async function deactivate(req, res, next) {
  try {
    const id = parseInt(req.params.id)

    // Нельзя деактивировать если есть активные брони
    const activeBooking = await prisma.booking.findFirst({
      where: { roomId: id, status: { in: ['CONFIRMED', 'CHECKED_IN'] } },
    })
    if (activeBooking) {
      return next(createError('Нельзя деактивировать номер с активными бронями', 400))
    }

    const room = await prisma.room.update({
      where: { id },
      data: { isActive: false },
      select: ROOM_SELECT,
    })

    invalidateGridCache()
    res.json({ data: room })
  } catch (err) {
    next(err)
  }
}

module.exports = { list, availability, create, update, deactivate }
