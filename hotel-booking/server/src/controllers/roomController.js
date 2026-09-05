const { prisma } = require('../utils/prisma')
const { checkRoomsAvailability, parseFlags } = require('../utils/availability')
const { createError } = require('../middleware/errorHandler')
const { getRoomLimit, roomLimitMessage } = require('../utils/license')
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

/**
 * Ступень тарифа — это максимум АКТИВНЫХ номеров, и проверяется она только
 * в момент, когда номер становится активным (создание или включение обратно).
 *
 * Почему не «привести базу в соответствие»: у клиента может оказаться номеров
 * больше, чем в ключе (перешёл со старшей ступени, ошиблись при выпуске,
 * ключ ещё не продлён). Отключать чужие номера — это стереть работу отеля
 * за оператора. Поэтому существующие не трогаем никогда, отказываем только
 * в добавлении сверх лимита.
 */
async function roomLimitViolation() {
  const limit = await getRoomLimit()
  if (limit === null) return null // ключа нет или он не читается — ограничения нет
  const used = await prisma.room.count({ where: { isActive: true } })
  if (used < limit) return null
  return { error: roomLimitMessage(limit), code: 'LICENSE_ROOM_LIMIT', limit, used }
}

// POST /api/rooms
async function create(req, res, next) {
  try {
    const { number, categoryId, building, floor, features, capacity } = req.body

    const blocked = await roomLimitViolation()
    if (blocked) return res.status(403).json(blocked)

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

    // Включение отключённого номера — это то же добавление в счёт лимита.
    // Иначе обойти ступень тарифа можно было бы «выключил — включил».
    if (isActive === true) {
      const current = await prisma.room.findUnique({ where: { id }, select: { isActive: true } })
      if (current && !current.isActive) {
        const blocked = await roomLimitViolation()
        if (blocked) return res.status(403).json(blocked)
      }
    }

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
