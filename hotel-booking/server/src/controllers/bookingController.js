const { prisma } = require('../utils/prisma')
const { findOverlap } = require('../utils/overlap')
const { emitBookingEvent } = require('../socket/socketManager')
const { createError } = require('../middleware/errorHandler')
const { ensureCurrentShift, getCurrentBusinessDate } = require('../utils/businessDate')
const { getFlagEffectsMap, findBufferConflict } = require('../utils/flagEffects')

/** Resolve the shift id for a new booking — the current business day (manual-only). */
async function resolveShiftId(explicitShiftId, adminId) {
  if (explicitShiftId) return parseInt(explicitShiftId)
  const shift = await ensureCurrentShift(adminId)
  return shift.id
}

const BOOKING_SELECT = {
  id: true,
  guestName: true,
  guestPhone: true,
  checkIn: true,
  checkOut: true,
  status: true,
  source: true,
  notes: true,
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
  flags: true,
  // roomId нужен клиенту сетки: по нему socket-событие вставляет бронь в строку номера
  roomId: true,
  partnerId: true,
  partner: { select: { id: true, name: true, color: true } },
  shiftId: true,
  createdAt: true,
  updatedAt: true,
  room: {
    select: { id: true, number: true, building: true, floor: true, category: { select: { id: true, name: true, color: true } } },
  },
  createdBy: { select: { id: true, name: true } },
}

// GET /api/bookings
async function list(req, res, next) {
  try {
    const { dateFrom, dateTo, roomId, status, categoryId, page = 1, limit = 200 } = req.query

    const where = {}

    if (dateFrom || dateTo) {
      where.AND = []
      if (dateFrom) where.AND.push({ checkOut: { gt: new Date(dateFrom) } })
      if (dateTo) where.AND.push({ checkIn: { lt: new Date(dateTo) } })
    }
    if (roomId) where.roomId = parseInt(roomId)
    if (status) where.status = status
    if (categoryId) where.room = { categoryId: parseInt(categoryId) }

    const [bookings, total] = await prisma.$transaction([
      prisma.booking.findMany({
        where,
        select: BOOKING_SELECT,
        orderBy: { checkIn: 'asc' },
        skip: (parseInt(page) - 1) * parseInt(limit),
        take: parseInt(limit),
      }),
      prisma.booking.count({ where }),
    ])

    res.json({ data: bookings, total, page: parseInt(page), limit: parseInt(limit) })
  } catch (err) {
    next(err)
  }
}

// GET /api/bookings/:id
async function getOne(req, res, next) {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: parseInt(req.params.id) },
      select: BOOKING_SELECT,
    })
    if (!booking) return next(createError('Бронь не найдена', 404))
    res.json({ data: booking })
  } catch (err) {
    next(err)
  }
}

// POST /api/bookings
async function create(req, res, next) {
  try {
    const {
      roomId, guestName, guestPhone, checkIn, checkOut, source, notes, status,
      adultsWithMeals, childrenWithMeals, adultsNoMeals, childrenNoMeals,
      extraBedsWithMeals, extraBedsNoMeals, disabledAdults, disabledChildren,
      discountPercent, prepaymentPercent, totalAmount, prepaidAmount, paidAmount, flags, shiftId,
    } = req.body

    // Проверка: минимум 1 ночь
    if (new Date(checkOut) <= new Date(checkIn)) {
      return next(createError('Дата выезда должна быть позже даты заезда', 400))
    }

    // Запрет броней и заездов задним числом (только ремонт разрешён).
    // Сравниваем с датой рабочей смены, а не с датой устройства — чтобы можно
    // было вносить исторические данные на дату открытой смены.
    const businessDate = await getCurrentBusinessDate()
    if (new Date(checkIn) < businessDate && source !== 'ремонт') {
      return next(createError('Нельзя создавать бронь на прошедшие даты. Только ремонт допускается задним числом.', 400))
    }

    // Допустимые начальные статусы
    const allowedStatuses = ['CONFIRMED', 'CHECKED_IN']
    let initialStatus = allowedStatuses.includes(status) ? status : 'CONFIRMED'

    // Нельзя сразу пометить «заехал», если дата заезда ещё впереди (смена не дошла).
    // Ремонт «заехавшим» быть не может в принципе.
    if (initialStatus === 'CHECKED_IN') {
      const checkInUTC = new Date(checkIn)
      if (source === 'ремонт' || businessDate.getTime() < checkInUTC.getTime()) {
        initialStatus = 'CONFIRMED'
      }
    }

    // Проверка номера
    const room = await prisma.room.findUnique({ where: { id: roomId } })
    if (!room || !room.isActive) return next(createError('Номер не найден или деактивирован', 404))

    // Проверка пересечений
    const conflict = await findOverlap({ roomId, checkIn, checkOut })
    if (conflict) {
      return res.status(409).json({
        error: 'Номер занят на выбранные даты',
        conflict: {
          bookingId: conflict.id,
          guestName: conflict.guestName,
          checkIn: conflict.checkIn,
          checkOut: conflict.checkOut,
        },
      })
    }

    // Проверка буфера (turnaround) от эффектов меток — напр. «поздний выезд» → нельзя день-в-день
    const effMap = await getFlagEffectsMap()
    const bufHit = await findBufferConflict({ roomId, checkIn, checkOut, flags: flags || [] }, effMap)
    if (bufHit) {
      return res.status(409).json({
        error: `Нужен зазор минимум ${bufHit.required} дн. рядом с бронью «${bufHit.booking.guestName}» (метка с буфером). Выберите другие даты или номер.`,
      })
    }

    const booking = await prisma.booking.create({
      data: {
        roomId,
        guestName: guestName.trim(),
        guestPhone: guestPhone?.trim() || null,
        checkIn: new Date(checkIn),
        checkOut: new Date(checkOut),
        status: initialStatus,
        source: source || null,
        notes: notes?.trim() || null,
        adultsWithMeals: adultsWithMeals ?? 0,
        childrenWithMeals: childrenWithMeals ?? 0,
        adultsNoMeals: adultsNoMeals ?? 0,
        childrenNoMeals: childrenNoMeals ?? 0,
        extraBedsWithMeals: extraBedsWithMeals ?? 0,
        extraBedsNoMeals: extraBedsNoMeals ?? 0,
        disabledAdults: disabledAdults ?? 0,
        disabledChildren: disabledChildren ?? 0,
        discountPercent: discountPercent ?? 0,
        prepaymentPercent: prepaymentPercent ?? 50,
        totalAmount: totalAmount ?? 0,
        prepaidAmount: prepaidAmount ?? 0,
        paidAmount: paidAmount ?? 0,
        flags: Array.isArray(flags) ? flags : [],
        shiftId: await resolveShiftId(shiftId, req.admin.id),
        adminId: req.admin.id,
      },
      select: BOOKING_SELECT,
    })

    emitBookingEvent('booking:created', { booking })
    res.status(201).json({ data: booking })
  } catch (err) {
    next(err)
  }
}

// PUT /api/bookings/:id
async function update(req, res, next) {
  try {
    const id = parseInt(req.params.id)
    const {
      roomId, guestName, guestPhone, checkIn, checkOut, source, notes,
      adultsWithMeals, childrenWithMeals, adultsNoMeals, childrenNoMeals,
      extraBedsWithMeals, extraBedsNoMeals, disabledAdults, disabledChildren,
      discountPercent, prepaymentPercent, totalAmount, prepaidAmount, paidAmount, flags, shiftId,
    } = req.body

    const existing = await prisma.booking.findUnique({ where: { id } })
    if (!existing) return next(createError('Бронь не найдена', 404))

    if (['CHECKED_OUT', 'CANCELLED'].includes(existing.status)) {
      return next(createError('Нельзя редактировать закрытую бронь', 400))
    }

    const newRoomId = roomId ?? existing.roomId
    const newCheckIn = checkIn ? new Date(checkIn) : existing.checkIn
    const newCheckOut = checkOut ? new Date(checkOut) : existing.checkOut

    // У заселившегося гостя дата заезда зафиксирована
    if (existing.status === 'CHECKED_IN' && newCheckIn.getTime() !== existing.checkIn.getTime()) {
      return next(createError('Нельзя изменить дату заезда у заселившегося гостя', 400))
    }

    // Для смены номера у CHECKED_IN — использовать endpoint /:id/move
    if (existing.status === 'CHECKED_IN' && newRoomId !== existing.roomId) {
      return next(createError('Для переезда заселившегося гостя используйте операцию «Переезд»', 400))
    }

    // У заселённого гостя выезд можно двигать только вперёд от текущей рабочей даты:
    // выезд «сегодня/вчера» освобождает номер в сетке, хотя гость ещё живёт → номер
    // продадут второй раз. Фактический выезд оформляется кнопкой «Выезд» (checkOut).
    if (existing.status === 'CHECKED_IN' && newCheckOut.getTime() !== existing.checkOut.getTime()) {
      const businessDate = await getCurrentBusinessDate()
      const newCoUTC = new Date(Date.UTC(newCheckOut.getUTCFullYear(), newCheckOut.getUTCMonth(), newCheckOut.getUTCDate()))
      if (newCoUTC.getTime() <= businessDate.getTime()) {
        return next(createError('У заселённого гостя дата выезда не может быть раньше завтрашнего рабочего дня. Для выезда используйте кнопку «Выезд»', 400))
      }
    }

    // Проверка нового номера (как в create): несуществующий roomId раньше падал в FK-ошибку с 500
    if (newRoomId !== existing.roomId) {
      const room = await prisma.room.findUnique({ where: { id: newRoomId } })
      if (!room || !room.isActive) return next(createError('Номер не найден или деактивирован', 404))
    }

    // Запрет переноса заезда на прошедшую дату (как в create). Только ремонт — задним числом.
    if (newCheckIn.getTime() !== existing.checkIn.getTime() && existing.source !== 'ремонт') {
      const businessDate = await getCurrentBusinessDate()
      const newCiUTC = new Date(Date.UTC(newCheckIn.getUTCFullYear(), newCheckIn.getUTCMonth(), newCheckIn.getUTCDate()))
      if (newCiUTC.getTime() < businessDate.getTime()) {
        return next(createError('Нельзя перенести заезд на прошедшую дату.', 400))
      }
    }

    if (newCheckOut <= newCheckIn) {
      return next(createError('Дата выезда должна быть позже даты заезда', 400))
    }

    // Проверка пересечений (исключаем саму бронь)
    const conflict = await findOverlap({
      roomId: newRoomId,
      checkIn: newCheckIn,
      checkOut: newCheckOut,
      excludeBookingId: id,
    })
    if (conflict) {
      return res.status(409).json({
        error: 'Номер занят на выбранные даты',
        conflict: {
          bookingId: conflict.id,
          guestName: conflict.guestName,
          checkIn: conflict.checkIn,
          checkOut: conflict.checkOut,
        },
      })
    }

    // Буфер (turnaround) от меток — учитываем итоговые метки брони
    const effMapU = await getFlagEffectsMap()
    const bufHitU = await findBufferConflict({
      roomId: newRoomId,
      checkIn: newCheckIn,
      checkOut: newCheckOut,
      flags: flags ?? existing.flags ?? [],
      excludeBookingId: id,
    }, effMapU)
    if (bufHitU) {
      return res.status(409).json({
        error: `Нужен зазор минимум ${bufHitU.required} дн. рядом с бронью «${bufHitU.booking.guestName}» (метка с буфером). Выберите другие даты или номер.`,
      })
    }

    const booking = await prisma.booking.update({
      where: { id },
      data: {
        roomId: newRoomId,
        guestName: guestName?.trim() ?? existing.guestName,
        guestPhone: guestPhone !== undefined ? guestPhone?.trim() || null : existing.guestPhone,
        checkIn: newCheckIn,
        checkOut: newCheckOut,
        source: source !== undefined ? source : existing.source,
        notes: notes !== undefined ? notes?.trim() || null : existing.notes,
        ...(adultsWithMeals !== undefined && { adultsWithMeals }),
        ...(childrenWithMeals !== undefined && { childrenWithMeals }),
        ...(adultsNoMeals !== undefined && { adultsNoMeals }),
        ...(childrenNoMeals !== undefined && { childrenNoMeals }),
        ...(extraBedsWithMeals !== undefined && { extraBedsWithMeals }),
        ...(extraBedsNoMeals !== undefined && { extraBedsNoMeals }),
        ...(disabledAdults !== undefined && { disabledAdults }),
        ...(disabledChildren !== undefined && { disabledChildren }),
        ...(discountPercent !== undefined && { discountPercent }),
        ...(prepaymentPercent !== undefined && { prepaymentPercent }),
        ...(totalAmount !== undefined && { totalAmount }),
        ...(prepaidAmount !== undefined && { prepaidAmount }),
        ...(paidAmount !== undefined && { paidAmount }),
        ...(flags !== undefined && { flags: Array.isArray(flags) ? flags : [] }),
        ...(shiftId !== undefined && { shiftId: shiftId ? parseInt(shiftId) : null }),
      },
      select: BOOKING_SELECT,
    })

    emitBookingEvent('booking:updated', { booking })
    res.json({ data: booking })
  } catch (err) {
    next(err)
  }
}

// DELETE /api/bookings/:id — отмена (не удаление из БД)
async function cancel(req, res, next) {
  try {
    const id = parseInt(req.params.id)

    const existing = await prisma.booking.findUnique({ where: { id } })
    if (!existing) return next(createError('Бронь не найдена', 404))

    if (existing.status === 'CANCELLED') {
      return next(createError('Бронь уже отменена', 400))
    }
    if (existing.status === 'CHECKED_OUT') {
      return next(createError('Нельзя отменить закрытую бронь', 400))
    }
    // Отмена живущего гостя — операция с последствиями для расчётов, только администраторам
    if (existing.status === 'CHECKED_IN' && !['SUPER_ADMIN', 'ADMIN'].includes(req.admin?.role)) {
      return next(createError('Отменить заселённого гостя может только администратор', 403))
    }

    const booking = await prisma.booking.update({
      where: { id },
      data: { status: 'CANCELLED' },
      select: BOOKING_SELECT,
    })

    emitBookingEvent('booking:cancelled', { bookingId: id, roomId: booking.room.id })
    res.json({ data: booking })
  } catch (err) {
    next(err)
  }
}

// PATCH /api/bookings/:id/checkin
async function checkIn(req, res, next) {
  try {
    const id = parseInt(req.params.id)

    const existing = await prisma.booking.findUnique({ where: { id } })
    if (!existing) return next(createError('Бронь не найдена', 404))
    if (existing.status !== 'CONFIRMED') {
      return next(createError(`Нельзя отметить заезд: статус "${existing.status}"`, 400))
    }
    // Ремонт — это блок номера, а не гость; «заезд» к нему бессмыслен.
    if (existing.source === 'ремонт') {
      return next(createError('Нельзя отметить заезд для ремонтного блока', 400))
    }

    // Заезд нельзя отметить раньше даты заезда брони (сверяем с датой смены, не с устройством).
    // Поздний заезд (смена уже прошла дату заезда) разрешён — гость мог приехать позже.
    const businessDate = await getCurrentBusinessDate()
    const checkInUTC = new Date(Date.UTC(
      existing.checkIn.getUTCFullYear(),
      existing.checkIn.getUTCMonth(),
      existing.checkIn.getUTCDate(),
    ))
    if (businessDate.getTime() < checkInUTC.getTime()) {
      return next(createError('Нельзя отметить заезд раньше даты заезда брони. Сначала перейдите к дню заезда.', 400))
    }

    const booking = await prisma.booking.update({
      where: { id },
      data: { status: 'CHECKED_IN' },
      select: BOOKING_SELECT,
    })

    emitBookingEvent('booking:checkin', { booking })
    res.json({ data: booking })
  } catch (err) {
    next(err)
  }
}

// PATCH /api/bookings/:id/checkout
// Если гость выезжает раньше времени — обновляем checkOut на сегодняшнюю дату
async function checkOut(req, res, next) {
  try {
    const id = parseInt(req.params.id)

    const existing = await prisma.booking.findUnique({ where: { id } })
    if (!existing) return next(createError('Бронь не найдена', 404))
    if (existing.status !== 'CHECKED_IN') {
      return next(createError(`Нельзя отметить выезд: статус "${existing.status}"`, 400))
    }

    const todayUTC = await getCurrentBusinessDate()
    const checkInUTC = new Date(Date.UTC(
      existing.checkIn.getUTCFullYear(),
      existing.checkIn.getUTCMonth(),
      existing.checkIn.getUTCDate(),
    ))

    // Рабочая дата раньше заезда (бронь заселена «в будущее») — выезд оформить нельзя,
    // иначе checkOut ушёл бы раньше checkIn
    if (todayUTC.getTime() < checkInUTC.getTime()) {
      return next(createError('Рабочая дата раньше даты заезда — выезд невозможен', 400))
    }

    // Выезд день-в-день с заездом — гость не ночевал, просто удаляем запись
    if (todayUTC.getTime() === checkInUTC.getTime()) {
      await prisma.booking.delete({ where: { id } })
      emitBookingEvent('booking:cancelled', { bookingId: id, roomId: existing.roomId })
      return res.json({ data: { deleted: true } })
    }

    const data = { status: 'CHECKED_OUT' }
    // Ранний выезд — фиксируем фактическую дату выезда (сегодня)
    if (todayUTC < existing.checkOut) {
      data.checkOut = todayUTC
    }

    const booking = await prisma.booking.update({
      where: { id },
      data,
      select: BOOKING_SELECT,
    })

    emitBookingEvent('booking:checkout', { booking })
    res.json({ data: booking })
  } catch (err) {
    next(err)
  }
}

// POST /api/bookings/:id/move — переезд гостя в другой номер
// Body: { newRoomId, moveDate }
// Если moveDate == checkIn → просто меняем roomId (без сплита)
// Иначе → закрываем оригинал (CHECKED_OUT, checkOut=moveDate) и создаём новую (CHECKED_IN) в новом номере
async function move(req, res, next) {
  try {
    const id = parseInt(req.params.id)
    const { newRoomId, moveDate } = req.body

    if (!newRoomId || !moveDate) {
      return next(createError('newRoomId и moveDate обязательны', 400))
    }

    const existing = await prisma.booking.findUnique({
      where: { id },
      include: { room: true },
    })
    if (!existing) return next(createError('Бронь не найдена', 404))
    if (existing.status !== 'CHECKED_IN') {
      return next(createError('Переезд возможен только для заселившихся гостей', 400))
    }

    const moveDateD = new Date(moveDate)
    if (moveDateD < existing.checkIn) {
      return next(createError('Дата переезда не может быть раньше даты заезда', 400))
    }
    if (moveDateD >= existing.checkOut) {
      return next(createError('Дата переезда должна быть до даты выезда', 400))
    }
    // Переезд «в будущее» невозможен: гость физически переезжает не позже текущей смены
    const businessDate = await getCurrentBusinessDate()
    if (moveDateD.getTime() > businessDate.getTime()) {
      return next(createError('Дата переезда не может быть позже текущего рабочего дня', 400))
    }

    const targetRoom = await prisma.room.findUnique({ where: { id: parseInt(newRoomId) } })
    if (!targetRoom) return next(createError('Целевой номер не найден', 404))
    if (!targetRoom.isActive) return next(createError('Целевой номер деактивирован', 404))
    if (targetRoom.id === existing.roomId && moveDateD.getTime() === existing.checkIn.getTime()) {
      return next(createError('Тот же номер и та же дата — переезд не требуется', 400))
    }

    // Same-day move — только меняем roomId, без сплита
    if (moveDateD.getTime() === existing.checkIn.getTime()) {
      const conflict = await findOverlap({
        roomId: parseInt(newRoomId),
        checkIn: existing.checkIn.toISOString().slice(0, 10),
        checkOut: existing.checkOut.toISOString().slice(0, 10),
        excludeBookingId: id,
      })
      if (conflict) {
        return next(createError(`Целевой номер занят (${conflict.guestName})`, 409))
      }

      const updated = await prisma.booking.update({
        where: { id },
        data: { roomId: parseInt(newRoomId) },
        select: BOOKING_SELECT,
      })

      emitBookingEvent('booking:updated', { booking: updated })
      return res.json({ data: { original: updated, created: null } })
    }

    // Сплит — проверяем доступность целевого номера для [moveDate, checkOut)
    const conflict = await findOverlap({
      roomId: parseInt(newRoomId),
      checkIn: moveDate,
      checkOut: existing.checkOut.toISOString().slice(0, 10),
      excludeBookingId: null,
    })
    if (conflict) {
      return next(createError(`Целевой номер занят (${conflict.guestName})`, 409))
    }

    const result = await prisma.$transaction(async (tx) => {
      // 1. Закрыть оригинальную бронь датой переезда
      const updatedOriginal = await tx.booking.update({
        where: { id },
        data: {
          checkOut: moveDateD,
          status: 'CHECKED_OUT',
          notes: appendNote(existing.notes, `Переезд в №${targetRoom.number} (${moveDate})`),
        },
        select: BOOKING_SELECT,
      })

      // 2. Создать новую в целевом номере (метки и партнёр переезжают вместе с гостем)
      const created = await tx.booking.create({
        data: {
          roomId: parseInt(newRoomId),
          guestName: existing.guestName,
          guestPhone: existing.guestPhone,
          checkIn: moveDateD,
          checkOut: existing.checkOut,
          status: 'CHECKED_IN',
          source: existing.source,
          notes: `Переезд из №${existing.room.number} (${moveDate})`,
          adultsWithMeals: existing.adultsWithMeals,
          childrenWithMeals: existing.childrenWithMeals,
          adultsNoMeals: existing.adultsNoMeals,
          childrenNoMeals: existing.childrenNoMeals,
          extraBedsWithMeals: existing.extraBedsWithMeals,
          extraBedsNoMeals: existing.extraBedsNoMeals,
          disabledAdults: existing.disabledAdults,
          disabledChildren: existing.disabledChildren,
          discountPercent: existing.discountPercent,
          prepaymentPercent: existing.prepaymentPercent,
          totalAmount: 0,
          prepaidAmount: 0,
          paidAmount: 0,
          flags: existing.flags,
          partnerId: existing.partnerId,
          // В модели Booking поле называется adminId (relation createdBy) — createdById Prisma отклонял → 500
          adminId: req.admin.id,
          shiftId: existing.shiftId,
        },
        select: BOOKING_SELECT,
      })

      return { original: updatedOriginal, created }
    })

    // Клиент ждёт форму { booking } (как у остальных операций) — без обёртки падал с TypeError
    emitBookingEvent('booking:updated', { booking: result.original })
    emitBookingEvent('booking:created', { booking: result.created })
    res.json({ data: result })
  } catch (err) {
    next(err)
  }
}

function appendNote(existing, addition) {
  if (!existing) return addition
  return `${existing}\n${addition}`
}

// POST /api/bookings/check-availability — клиентская проверка пересечений без создания
async function checkAvailability(req, res, next) {
  try {
    const { roomId, checkIn, checkOut, excludeBookingId } = req.body

    if (!roomId || !checkIn || !checkOut) {
      return next(createError('roomId, checkIn, checkOut обязательны', 400))
    }

    const conflict = await findOverlap({
      roomId: parseInt(roomId),
      checkIn,
      checkOut,
      excludeBookingId: excludeBookingId ? parseInt(excludeBookingId) : null,
    })

    res.json({ available: !conflict, conflict: conflict || null })
  } catch (err) {
    next(err)
  }
}

// BOOKING_SELECT экспортируется для optimizeController — payload socket-событий должен быть единым
module.exports = { list, getOne, create, update, cancel, checkIn, checkOut, checkAvailability, move, BOOKING_SELECT }
