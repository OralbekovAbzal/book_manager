const { prisma } = require('../utils/prisma')
const { createError } = require('../middleware/errorHandler')
const { getCurrentBusinessDate } = require('../utils/businessDate')
const { checkRoomsAvailability, parseFlags } = require('../utils/availability')

// Кэш сетки: инвалидируется при любом изменении брони
const gridCache = new Map()
const CACHE_TTL = 30_000 // 30 секунд

function getCacheKey(params) {
  return JSON.stringify(params)
}

function invalidateGridCache() {
  gridCache.clear()
}

/**
 * GET /api/occupancy/grid
 * Возвращает данные для сетки: категории → номера → брони в диапазоне дат.
 * Оптимизирован для 200 номеров: 2 запроса к БД (номера + брони).
 */
async function grid(req, res, next) {
  try {
    const {
      dateFrom,
      dateTo,
      building,
      categoryId,
      floor,
      capacity,
      features,
      guestSearch,
    } = req.query

    // По умолчанию: -3 дня от рабочего дня + 30 дней вперёд.
    // "Рабочий день" — это текущая смена в БД, а не дата устройства.
    const today = await getCurrentBusinessDate()

    const from = dateFrom
      ? new Date(dateFrom)
      : new Date(today.getTime() - 3 * 86400_000)

    const to = dateTo
      ? new Date(dateTo)
      : new Date(today.getTime() + 30 * 86400_000)

    if (to <= from) return next(createError('dateTo должен быть позже dateFrom', 400))

    const searchNormalized = guestSearch ? String(guestSearch).trim() : ''

    const cacheKey = getCacheKey({ from, to, building, categoryId, floor, capacity, features, guestSearch: searchNormalized })
    const cached = gridCache.get(cacheKey)
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      return res.json(cached.data)
    }

    // Фильтр номеров
    const roomWhere = { isActive: true }
    if (building) roomWhere.building = building
    if (categoryId) roomWhere.categoryId = parseInt(categoryId)
    if (floor) roomWhere.floor = parseInt(floor)
    if (capacity) roomWhere.capacity = capacity
    if (features) roomWhere.features = { has: features }   // номер должен иметь эту особенность

    // Если задан поиск по гостю — сначала ищем все брони (любые даты)
    // с совпадением, и сужаем выборку номеров до тех, где такие брони есть.
    if (searchNormalized) {
      const digits = searchNormalized.replace(/\D/g, '')
      let matchingBookings
      if (digits.length >= 3) {
        // Есть хотя бы 3 цифры — ищем и по телефону, сравнивая только цифры:
        // «+7 (701) 123-45-67» в базе находится по «7011234567». Тегированный
        // $queryRaw биндит параметры, строковой склейки SQL нет.
        const namePattern = `%${searchNormalized}%`
        const phonePattern = `%${digits}%`
        matchingBookings = await prisma.$queryRaw`
          SELECT DISTINCT "roomId" FROM "Booking"
          WHERE status <> 'CANCELLED'
            AND ("guestName" ILIKE ${namePattern}
              OR regexp_replace(coalesce("guestPhone", ''), '[^0-9]', '', 'g') LIKE ${phonePattern})`
      } else {
        matchingBookings = await prisma.booking.findMany({
          where: {
            status: { notIn: ['CANCELLED'] },
            guestName: { contains: searchNormalized, mode: 'insensitive' },
          },
          select: { roomId: true },
          distinct: ['roomId'],
        })
      }
      const matchingRoomIds = matchingBookings.map(b => b.roomId)
      // Пересечение с уже наложенными фильтрами
      roomWhere.id = { in: matchingRoomIds }
    }

    // 1. Все подходящие номера
    const rooms = await prisma.room.findMany({
      where: roomWhere,
      select: {
        id: true,
        number: true,
        building: true,
        floor: true,
        features: true,
        category: { select: { id: true, name: true, color: true } },
      },
      orderBy: [{ building: 'asc' }, { floor: 'asc' }, { number: 'asc' }],
    })

    const roomIds = rooms.map((r) => r.id)

    // 2. Все брони в диапазоне дат для этих номеров (исключаем отменённые)
    const bookings = await prisma.booking.findMany({
      where: {
        roomId: { in: roomIds },
        status: { notIn: ['CANCELLED'] },
        checkIn: { lt: to },
        checkOut: { gt: from },
      },
      select: {
        id: true,
        roomId: true,
        guestName: true,
        guestPhone: true,
        checkIn: true,
        checkOut: true,
        status: true,
        source: true,
        notes: true,
        flags: true,
        partnerId: true,
        partner: { select: { id: true, name: true, color: true } },
        // Гости и деньги нужны модалке редактирования/просмотра: без них форма
        // подставляла нули и затирала данные брони при сохранении из сетки.
        adultsWithMeals: true,
        childrenWithMeals: true,
        adultsNoMeals: true,
        childrenNoMeals: true,
        extraBedsWithMeals: true,
        extraBedsNoMeals: true,
        disabledAdults: true,
        disabledChildren: true,
        discountPercent: true,
        prepaymentPercent: true,
        totalAmount: true,
        prepaidAmount: true,
        paidAmount: true,
      },
      orderBy: { checkIn: 'asc' },
    })

    // 2b. Все аллокации пересекающиеся с диапазоном
    const allotments = await prisma.allotment.findMany({
      where: {
        roomId: { in: roomIds },
        dateFrom: { lt: to },
        dateTo:   { gt: from },
      },
      select: {
        id: true,
        roomId: true,
        dateFrom: true,
        dateTo: true,
        partner: { select: { id: true, name: true, color: true } },
        releases: { select: { id: true, dateFrom: true, dateTo: true, reason: true } },
      },
    })

    const allotmentsByRoom = new Map()
    for (const a of allotments) {
      if (!allotmentsByRoom.has(a.roomId)) allotmentsByRoom.set(a.roomId, [])
      allotmentsByRoom.get(a.roomId).push(a)
    }

    // Группируем брони по roomId
    const bookingsByRoom = new Map()
    for (const b of bookings) {
      if (!bookingsByRoom.has(b.roomId)) bookingsByRoom.set(b.roomId, [])
      bookingsByRoom.get(b.roomId).push(b)
    }

    // Группируем номера по категориям
    const categoriesMap = new Map()
    for (const room of rooms) {
      const cat = room.category
      if (!categoriesMap.has(cat.id)) {
        categoriesMap.set(cat.id, { id: cat.id, name: cat.name, color: cat.color, rooms: [] })
      }
      categoriesMap.get(cat.id).rooms.push({
        id: room.id,
        number: room.number,
        building: room.building,
        floor: room.floor,
        features: room.features,
        bookings: bookingsByRoom.get(room.id) || [],
        allotments: allotmentsByRoom.get(room.id) || [],
      })
    }

    const data = {
      dateFrom: from.toISOString().slice(0, 10),
      dateTo: to.toISOString().slice(0, 10),
      today: today.toISOString().slice(0, 10),
      totalRooms: rooms.length,
      categories: [...categoriesMap.values()],
    }

    gridCache.set(cacheKey, { ts: Date.now(), data })
    res.json(data)
  } catch (err) {
    next(err)
  }
}

/**
 * GET /api/occupancy/stats?date=YYYY-MM-DD
 * Статистика загруженности на конкретную дату.
 */
async function stats(req, res, next) {
  try {
    const _d = req.query.date ? new Date(req.query.date) : new Date()
    const date = new Date(Date.UTC(_d.getUTCFullYear(), _d.getUTCMonth(), _d.getUTCDate()))
    const nextDay = new Date(date.getTime() + 86400_000)

    const [totalRooms, occupied, checkIns, checkOuts] = await prisma.$transaction([
      prisma.room.count({ where: { isActive: true } }),
      prisma.booking.count({
        where: {
          status: { in: ['CONFIRMED', 'CHECKED_IN'] },
          checkIn: { lt: nextDay },
          checkOut: { gt: date },
        },
      }),
      prisma.booking.count({
        where: {
          status: { in: ['CONFIRMED', 'CHECKED_IN'] },
          checkIn: { gte: date, lt: nextDay },
        },
      }),
      prisma.booking.count({
        where: {
          status: { in: ['CHECKED_IN', 'CONFIRMED'] },
          checkOut: { gte: date, lt: nextDay },
        },
      }),
    ])

    res.json({
      date: date.toISOString().slice(0, 10),
      totalRooms,
      occupied,
      free: totalRooms - occupied,
      occupancyRate: totalRooms > 0 ? Math.round((occupied / totalRooms) * 100) : 0,
      checkIns,
      checkOuts,
    })
  } catch (err) {
    next(err)
  }
}

/**
 * GET /api/occupancy/today
 * Все события сегодня: заезды, выезды, просроченные.
 */
async function today(req, res, next) {
  try {
    const now = await getCurrentBusinessDate()
    const tomorrow = new Date(now.getTime() + 86400_000)

    const ROOM_SELECT = {
      select: {
        id: true,
        number: true,
        building: true,
        category: { select: { name: true, color: true } },
      },
    }

    const [arrivals, departures, pendingCheckins, pendingCheckouts] = await prisma.$transaction([
      // Заезжают сегодня
      prisma.booking.findMany({
        where: { checkIn: { gte: now, lt: tomorrow }, status: 'CONFIRMED' },
        select: { id: true, guestName: true, guestPhone: true, checkIn: true, checkOut: true, room: ROOM_SELECT },
        orderBy: { checkIn: 'asc' },
      }),
      // Выезжают сегодня
      prisma.booking.findMany({
        where: { checkOut: { gte: now, lt: tomorrow }, status: 'CHECKED_IN' },
        select: { id: true, guestName: true, guestPhone: true, checkIn: true, checkOut: true, room: ROOM_SELECT },
        orderBy: { checkOut: 'asc' },
      }),
      // Не заехали (checkIn был раньше сегодня, статус CONFIRMED)
      prisma.booking.findMany({
        where: { checkIn: { lt: now }, status: 'CONFIRMED' },
        select: { id: true, guestName: true, guestPhone: true, checkIn: true, checkOut: true, room: ROOM_SELECT },
        orderBy: { checkIn: 'asc' },
      }),
      // Не выехали (checkOut был раньше сегодня, статус CHECKED_IN)
      prisma.booking.findMany({
        where: { checkOut: { lt: now }, status: 'CHECKED_IN' },
        select: { id: true, guestName: true, guestPhone: true, checkIn: true, checkOut: true, room: ROOM_SELECT },
        orderBy: { checkOut: 'asc' },
      }),
    ])

    res.json({
      date: now.toISOString().slice(0, 10),
      arrivals,
      departures,
      pendingCheckins,
      pendingCheckouts,
      counts: {
        arrivals: arrivals.length,
        departures: departures.length,
        pendingCheckins: pendingCheckins.length,
        pendingCheckouts: pendingCheckouts.length,
      },
    })
  } catch (err) {
    next(err)
  }
}

/**
 * GET /api/occupancy/availability?checkIn=YYYY-MM-DD&checkOut=YYYY-MM-DD&excludeBookingId=N
 *   &flags=late-out,deep-clean&partnerId=N
 * Возвращает доступность всех активных номеров на заданный период.
 *
 * «Свободно» считает общая утилита utils/availability — те же три проверки, что
 * при создании брони: пересечения, буферы меток и квоты партнёров. Раньше здесь
 * смотрелись только пересечения (да ещё и по другому набору статусов), поэтому
 * форма брони показывала номер свободным, а сохранение отвечало 409.
 */
async function roomAvailability(req, res, next) {
  try {
    const { checkIn, checkOut, excludeBookingId, partnerId } = req.query

    if (!checkIn || !checkOut || checkOut <= checkIn) {
      return res.json({ availability: {} })
    }

    const rooms = await prisma.room.findMany({
      where: { isActive: true },
      select: { id: true },
    })

    const roomIds = rooms.map(r => r.id)
    const checked = await checkRoomsAvailability({
      roomIds,
      checkIn,
      checkOut,
      flags: parseFlags(req.query.flags),
      partnerId: partnerId ? parseInt(partnerId) : null,
      excludeBookingId: excludeBookingId ? parseInt(excludeBookingId) : null,
    })

    // Форма брони понимает только 'free' | 'occupied' — форму ответа не меняем,
    // причину отдаём отдельным полем, чтобы старый клиент продолжал работать.
    const availability = {}
    const reasons = {}
    for (const roomId of roomIds) {
      const st = checked.get(roomId)
      availability[roomId] = st.available ? 'free' : 'occupied'
      if (!st.available) reasons[roomId] = { reason: st.reason, text: st.message }
    }

    res.json({ availability, reasons })
  } catch (err) {
    next(err)
  }
}

module.exports = { grid, stats, today, roomAvailability, invalidateGridCache }
