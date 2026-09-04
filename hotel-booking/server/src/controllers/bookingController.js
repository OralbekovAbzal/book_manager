const { prisma } = require('../utils/prisma')
const { findOverlap } = require('../utils/overlap')
const { emitBookingEvent } = require('../socket/socketManager')
const { createError } = require('../middleware/errorHandler')
const { ensureCurrentShift, getCurrentBusinessDate } = require('../utils/businessDate')
const { getFlagEffectsMap, findBufferConflict } = require('../utils/flagEffects')
const { findAllotmentConflict, allotmentConflictMessage } = require('../utils/allotment')
const {
  rebuildAutoCharges, recalcBookingTotals, chargeInputsChanged, toUTCDate,
  replaceBookingServices, defaultServiceLinks, serviceLinksChanged, normalizeServiceLinks,
} = require('../utils/charges')

/**
 * Услуги из тела запроса должны существовать в справочнике.
 * Без этой проверки несуществующий serviceId падал бы внутри транзакции в FK-ошибку,
 * и клиент получил бы про «номер, категория, партнёр или смена» — сообщение не о том.
 * @returns {Promise<string|null>} текст ошибки или null
 */
async function findUnknownServices(services) {
  const ids = normalizeServiceLinks(services).map(s => s.serviceId)
  if (ids.length === 0) return null
  const found = await prisma.service.findMany({ where: { id: { in: ids } }, select: { id: true } })
  const known = new Set(found.map(s => s.id))
  const missing = ids.filter(id => !known.has(id))
  return missing.length > 0 ? `Услуга не найдена (id ${missing.join(', ')})` : null
}

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

// Питание и услуги в сетку не нужны — там рисуются полоски, а не счёт. Поэтому
// они отдельным «подробным» select'ом: BOOKING_SELECT уходит в каждое socket-событие
// и в список до 500 броней, и лишний join там стоил бы дороже, чем приносил.
const BOOKING_DETAIL_SELECT = {
  ...BOOKING_SELECT,
  services: {
    select: {
      id: true,
      serviceId: true,
      adults: true,
      children: true,
      quantity: true,
      service: {
        select: {
          id: true, code: true, name: true, price: true, childPrice: true,
          unit: true, kind: true, isActive: true,
        },
      },
    },
    orderBy: { id: 'asc' },
  },
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
    // Форма брони открывается именно отсюда — ей нужны питание и услуги целиком
    const booking = await prisma.booking.findUnique({
      where: { id: parseInt(req.params.id) },
      select: BOOKING_DETAIL_SELECT,
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
      services,
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

    if (services !== undefined) {
      const badService = await findUnknownServices(services)
      if (badService) return next(createError(badService, 400))
    }

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

    // Квота партнёра. Не запрет намертво: отель вправе продать выделенный номер,
    // но это должно быть осознанным решением, а не молчаливым — иначе партнёр
    // приезжает к занятому номеру. Подтверждение приходит как allowAllotmentOverride.
    if (!req.body.allowAllotmentOverride) {
      // NB: partnerId в create/update из тела НЕ разбирается (бронь партнёру
      // здесь не назначается) — берём напрямую, чтобы не ловить ReferenceError.
      const allotHit = await findAllotmentConflict({
        roomId, checkIn, checkOut, partnerId: req.body.partnerId,
      })
      if (allotHit) {
        return res.status(409).json({
          error: allotmentConflictMessage(allotHit),
          code: 'ALLOTMENT_CONFLICT',
        })
      }
    }

    // Смену определяем ДО транзакции: ensureCurrentShift может создать строку сам,
    // и внутри транзакции это было бы лишней записью в общий счётчик.
    const resolvedShiftId = await resolveShiftId(shiftId, req.admin.id)

    // Бронь и её начисления создаём одной транзакцией: бронь без строк — это бронь
    // с нулевой суммой, и такую «полупустую» запись пришлось бы чинить руками.
    const booking = await prisma.$transaction(async (tx) => {
      const created = await tx.booking.create({
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
          shiftId: resolvedShiftId,
          adminId: req.admin.id,
        },
        select: { id: true, adultsWithMeals: true, childrenWithMeals: true, adultsNoMeals: true,
          childrenNoMeals: true, extraBedsWithMeals: true, extraBedsNoMeals: true },
      })

      // Питание и услуги — до генерации начислений: генератор читает именно их.
      // Клиент не прислал набор (старый клиент, служебный вызов) — подставляем
      // услуги «включены в тариф», чтобы бронь не оказалась молча без завтрака.
      const links = services !== undefined ? services : await defaultServiceLinks(created, tx)
      await replaceBookingServices(created.id, links, tx)

      // keepIfEmpty: тариф на эти даты может быть не заполнен — тогда строк нет,
      // и сумму, посчитанную администратором вручную, мы не обнуляем.
      await rebuildAutoCharges(created.id, { adminId: req.admin.id, client: tx, keepIfEmpty: true })

      return tx.booking.findUnique({ where: { id: created.id }, select: BOOKING_SELECT })
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
      services,
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

    if (!req.body.allowAllotmentOverride) {
      const allotHitU = await findAllotmentConflict({
        roomId: newRoomId,
        checkIn: newCheckIn,
        checkOut: newCheckOut,
        partnerId: req.body.partnerId !== undefined ? req.body.partnerId : existing.partnerId,
      })
      if (allotHitU) {
        return res.status(409).json({
          error: allotmentConflictMessage(allotHitU),
          code: 'ALLOTMENT_CONFLICT',
        })
      }
    }

    // Пересобирать автоматические строки нужно только если изменились входы тарифа
    // (номер, даты, гости, скидка) или администратор явно нажал «Пересчитать».
    // Иначе правка заметки молча переоценила бы бронь по сегодняшнему календарю цен.
    const nextInputs = {
      roomId: newRoomId,
      checkIn: newCheckIn,
      checkOut: newCheckOut,
      adultsWithMeals: adultsWithMeals ?? existing.adultsWithMeals,
      childrenWithMeals: childrenWithMeals ?? existing.childrenWithMeals,
      adultsNoMeals: adultsNoMeals ?? existing.adultsNoMeals,
      childrenNoMeals: childrenNoMeals ?? existing.childrenNoMeals,
      extraBedsWithMeals: extraBedsWithMeals ?? existing.extraBedsWithMeals,
      extraBedsNoMeals: extraBedsNoMeals ?? existing.extraBedsNoMeals,
      discountPercent: discountPercent ?? existing.discountPercent,
    }
    // Питание и услуги — такой же вход тарифа, как даты и гости: сняли обед —
    // строку начисления надо убрать. Поле не прислали — набор не трогаем вообще
    // (частичный PUT из другого экрана не должен обнулять питание).
    if (services !== undefined) {
      const badService = await findUnknownServices(services)
      if (badService) return next(createError(badService, 400))
    }
    const existingLinks = services !== undefined
      ? await prisma.bookingService.findMany({ where: { bookingId: id } })
      : []
    const servicesChanged = services !== undefined && serviceLinksChanged(existingLinks, services)

    const needsRebuild = req.body.recalcCharges === true
      || servicesChanged
      || chargeInputsChanged(existing, nextInputs)

    const booking = await prisma.$transaction(async (tx) => {
      const updated = await tx.booking.update({
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

      // Переписываем только при реальном изменении: иначе каждое сохранение брони
      // пересоздавало бы строки (новые id, новая дата создания) без всякой причины.
      if (servicesChanged) await replaceBookingServices(id, services, tx)

      if (!needsRebuild) return updated

      await rebuildAutoCharges(id, { adminId: req.admin.id, client: tx, keepIfEmpty: true })
      return tx.booking.findUnique({ where: { id }, select: BOOKING_SELECT })
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

    // Выезд день-в-день с заездом: гость не ночевал.
    // Раньше здесь было `booking.delete` — запись физически исчезала из базы вместе
    // с историей, аудитом и деньгами, хотя обычная отмена принципиально ничего не
    // удаляет. Теперь отменяем, как везде: номер освобождается (CANCELLED выведен
    // из-под ограничения booking_no_overlap), а факт остаётся в базе.
    if (todayUTC.getTime() === checkInUTC.getTime()) {
      const booking = await prisma.booking.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          notes: appendNote(existing.notes, 'Выезд в день заезда — гость не ночевал'),
        },
        select: BOOKING_SELECT,
      })
      emitBookingEvent('booking:cancelled', { bookingId: id, roomId: booking.room.id })
      return res.json({ data: booking })
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

    if (!req.body.allowAllotmentOverride) {
      const allotHitM = await findAllotmentConflict({
        roomId: newRoomId,
        checkIn: moveDateD,
        checkOut: existing.checkOut,
        partnerId: existing.partnerId,
      })
      if (allotHitM) {
        return res.status(409).json({
          error: allotmentConflictMessage(allotHitM),
          code: 'ALLOTMENT_CONFLICT',
        })
      }
    }

    // Деньги делим пропорционально ночам. Раньше вторая часть получала нули, а
    // первая сохраняла полную сумму за весь исходный срок: итог по брони переставал
    // соответствовать её датам, и оплата выглядела как несуществующая на новой части.
    // Остаток отдаём второй части, чтобы сумма частей ТОЧНО равнялась исходной
    // и округление не съедало тенге.
    const DAY_MS = 86400000
    const nightsAll = Math.max(1, Math.round((existing.checkOut - existing.checkIn) / DAY_MS))
    const nightsFirst = Math.max(0, Math.round((moveDateD - existing.checkIn) / DAY_MS))
    const splitFirst = (value) => Math.round((value || 0) * nightsFirst / nightsAll)
    const money = {
      total: splitFirst(existing.totalAmount),
      prepaid: splitFirst(existing.prepaidAmount),
      paid: splitFirst(existing.paidAmount),
    }

    const result = await prisma.$transaction(async (tx) => {
      // 1. Закрыть оригинальную бронь датой переезда
      const updatedOriginal = await tx.booking.update({
        where: { id },
        data: {
          checkOut: moveDateD,
          status: 'CHECKED_OUT',
          totalAmount: money.total,
          prepaidAmount: money.prepaid,
          paidAmount: money.paid,
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
          totalAmount: (existing.totalAmount || 0) - money.total,
          prepaidAmount: (existing.prepaidAmount || 0) - money.prepaid,
          paidAmount: (existing.paidAmount || 0) - money.paid,
          flags: existing.flags,
          partnerId: existing.partnerId,
          // В модели Booking поле называется adminId (relation createdBy) — createdById Prisma отклонял → 500
          adminId: req.admin.id,
          shiftId: existing.shiftId,
        },
        select: BOOKING_SELECT,
      })

      // Питание и услуги переезжают вместе с гостем: он продолжает жить и продолжает
      // завтракать. Копируем, а не переносим — у первой части остались свои ночи,
      // и её начисления должны пересобираться по тому же набору.
      const links = await tx.bookingService.findMany({ where: { bookingId: id } })
      if (links.length > 0) {
        await tx.bookingService.createMany({
          data: links.map(l => ({
            bookingId: created.id,
            serviceId: l.serviceId,
            adults: l.adults,
            children: l.children,
            quantity: l.quantity,
          })),
          skipDuplicates: true,
        })
      }

      // Начисления делим по датам, а не пропорцией: посуточные строки проживания
      // сами знают, к какой ночи относятся. Услуги и скидки остаются на исходной
      // брони — делить их «на глаз» значит выдумывать деньги.
      // Если строк нет вообще (старая бронь до перехода на начисления), остаётся
      // пропорциональный расчёт выше.
      const charges = await tx.bookingCharge.findMany({ where: { bookingId: id } })
      if (charges.length > 0) {
        const moving = charges.filter(c => c.kind === 'stay' && c.date && c.date >= moveDateD)
        if (moving.length > 0) {
          await tx.bookingCharge.updateMany({
            where: { id: { in: moving.map(c => c.id) } },
            data: { bookingId: created.id },
          })
        }
        // paidAmount не трогаем: это реально принятые деньги, их делит пропорция выше.
        await recalcBookingTotals(id, { client: tx })
        await recalcBookingTotals(created.id, { client: tx, keepIfEmpty: true })

        return {
          original: await tx.booking.findUnique({ where: { id }, select: BOOKING_SELECT }),
          created: await tx.booking.findUnique({ where: { id: created.id }, select: BOOKING_SELECT }),
        }
      }

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

// ─── Начисления брони (BookingCharge) ────────────────────────────────────────
//
// Итог брони = СУММА СТРОК (NOTES, 2026-09-02). Тариф порождает строки
// (source='auto'), администратор правит их и добавляет свои (source='manual'
// + обязательная причина). `Booking.totalAmount` — кэш суммы, пересчитывается
// после КАЖДОЙ операции со строками, иначе деньги в программе разойдутся с кассой.

const CHARGE_KINDS = ['stay', 'meal', 'extra', 'discount']

const CHARGE_SELECT = {
  id: true,
  bookingId: true,
  kind: true,
  label: true,
  quantity: true,
  unitPrice: true,
  amount: true,
  date: true,
  source: true,
  reason: true,
  createdById: true,
  createdBy: { select: { id: true, name: true } },
  createdAt: true,
  updatedAt: true,
}

/** Строки по дате (посуточное проживание), затем услуги и скидки (date = null → NULLS LAST). */
function loadCharges(bookingId, client = prisma) {
  return client.bookingCharge.findMany({
    where: { bookingId },
    select: CHARGE_SELECT,
    orderBy: [{ date: 'asc' }, { id: 'asc' }],
  })
}

/** Общий ответ всех операций со строками: строки, их сумма и свежая бронь. */
async function respondWithCharges(bookingId, res, { emit = true } = {}) {
  const [charges, booking] = await Promise.all([
    loadCharges(bookingId),
    prisma.booking.findUnique({ where: { id: bookingId }, select: BOOKING_SELECT }),
  ])
  if (emit && booking) emitBookingEvent('booking:updated', { booking })
  res.json({
    data: charges,
    total: charges.reduce((s, c) => s + (c.amount || 0), 0),
    booking,
  })
}

/** Бронь под правку начислений: отменённую не трогаем, у закрытой деньги править можно. */
async function loadBookingForCharges(id, next) {
  const booking = await prisma.booking.findUnique({ where: { id }, select: { id: true, status: true } })
  if (!booking) { next(createError('Бронь не найдена', 404)); return null }
  if (booking.status === 'CANCELLED') {
    next(createError('Нельзя менять начисления отменённой брони', 400))
    return null
  }
  return booking
}

/** amount храним посчитанным (см. схему). Скидка не может быть плюсом — иначе «скидка» увеличит счёт. */
function normalizeCharge(kind, quantity, unitPrice) {
  const q = Number(quantity)
  let u = Number(unitPrice)
  if (kind === 'discount') u = -Math.abs(u)
  return { quantity: q, unitPrice: u, amount: Math.round(q * u) }
}

// GET /api/bookings/:id/charges
async function listCharges(req, res, next) {
  try {
    const id = parseInt(req.params.id)
    const exists = await prisma.booking.findUnique({ where: { id }, select: { id: true } })
    if (!exists) return next(createError('Бронь не найдена', 404))
    await respondWithCharges(id, res, { emit: false })
  } catch (err) {
    next(err)
  }
}

// POST /api/bookings/:id/charges — ручная строка (обязательно с причиной)
async function addCharge(req, res, next) {
  try {
    const id = parseInt(req.params.id)
    const booking = await loadBookingForCharges(id, next)
    if (!booking) return

    const { kind, label, quantity = 1, unitPrice = 0, date, reason } = req.body
    if (!CHARGE_KINDS.includes(kind)) return next(createError('Недопустимый вид начисления', 400))
    if (!reason || !String(reason).trim()) {
      return next(createError('Укажите причину — ручная строка без причины не сохраняется', 400))
    }

    const money = normalizeCharge(kind, quantity, unitPrice)
    if (!Number.isFinite(money.amount)) return next(createError('Некорректная сумма', 400))

    await prisma.$transaction(async (tx) => {
      await tx.bookingCharge.create({
        data: {
          bookingId: id,
          kind,
          label: String(label).trim(),
          ...money,
          date: date ? toUTCDate(date) : null,
          source: 'manual',
          reason: String(reason).trim(),
          createdById: req.admin.id,
        },
      })
      await recalcBookingTotals(id, { client: tx })
    })

    await respondWithCharges(id, res)
  } catch (err) {
    next(err)
  }
}

// PUT /api/bookings/:id/charges/:chargeId
// Правка автоматической строки делает её ручной: это уже решение администратора,
// и оно должно пережить пересборку по тарифу (иначе «полсуток» молча вернутся в сутки).
async function updateCharge(req, res, next) {
  try {
    const id = parseInt(req.params.id)
    const chargeId = parseInt(req.params.chargeId)
    const booking = await loadBookingForCharges(id, next)
    if (!booking) return

    const existing = await prisma.bookingCharge.findUnique({ where: { id: chargeId } })
    if (!existing || existing.bookingId !== id) return next(createError('Строка начисления не найдена', 404))

    const { label, quantity, unitPrice, date, reason, kind } = req.body
    if (kind !== undefined && !CHARGE_KINDS.includes(kind)) {
      return next(createError('Недопустимый вид начисления', 400))
    }
    if (!reason || !String(reason).trim()) {
      return next(createError('Укажите причину правки — без неё изменение не сохраняется', 400))
    }

    const nextKind = kind ?? existing.kind
    const money = normalizeCharge(
      nextKind,
      quantity !== undefined ? quantity : existing.quantity,
      unitPrice !== undefined ? unitPrice : existing.unitPrice,
    )
    if (!Number.isFinite(money.amount)) return next(createError('Некорректная сумма', 400))

    await prisma.$transaction(async (tx) => {
      await tx.bookingCharge.update({
        where: { id: chargeId },
        data: {
          kind: nextKind,
          ...(label !== undefined && { label: String(label).trim() }),
          ...money,
          ...(date !== undefined && { date: date ? toUTCDate(date) : null }),
          source: 'manual',
          reason: String(reason).trim(),
          createdById: req.admin.id,
        },
      })
      await recalcBookingTotals(id, { client: tx })
    })

    await respondWithCharges(id, res)
  } catch (err) {
    next(err)
  }
}

// DELETE /api/bookings/:id/charges/:chargeId
async function removeCharge(req, res, next) {
  try {
    const id = parseInt(req.params.id)
    const chargeId = parseInt(req.params.chargeId)
    const booking = await loadBookingForCharges(id, next)
    if (!booking) return

    const existing = await prisma.bookingCharge.findUnique({ where: { id: chargeId } })
    if (!existing || existing.bookingId !== id) return next(createError('Строка начисления не найдена', 404))

    await prisma.$transaction(async (tx) => {
      await tx.bookingCharge.delete({ where: { id: chargeId } })
      await recalcBookingTotals(id, { client: tx })
    })

    await respondWithCharges(id, res)
  } catch (err) {
    next(err)
  }
}

// POST /api/bookings/:id/charges/rebuild — пересобрать автоматические строки по тарифу.
// Ручные строки остаются. Удалённые автоматические (например, снятый обед) вернутся —
// это осознанное действие администратора, а не фон.
async function rebuildCharges(req, res, next) {
  try {
    const id = parseInt(req.params.id)
    const booking = await loadBookingForCharges(id, next)
    if (!booking) return

    await prisma.$transaction(async (tx) => {
      await rebuildAutoCharges(id, { adminId: req.admin.id, client: tx })
    })

    await respondWithCharges(id, res)
  } catch (err) {
    next(err)
  }
}

// BOOKING_SELECT экспортируется для optimizeController — payload socket-событий должен быть единым
module.exports = {
  list, getOne, create, update, cancel, checkIn, checkOut, checkAvailability, move,
  listCharges, addCharge, updateCharge, removeCharge, rebuildCharges,
  BOOKING_SELECT,
}
