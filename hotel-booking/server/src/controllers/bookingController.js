const { prisma } = require('../utils/prisma')
const { checkRoomsAvailability } = require('../utils/availability')
const { emitBookingEvent } = require('../socket/socketManager')
const { createError } = require('../middleware/errorHandler')
const { ensureCurrentShift, getCurrentBusinessDate } = require('../utils/businessDate')
const {
  rebuildAutoCharges, recalcBookingTotals, chargeInputsChanged, toUTCDate, dateKey,
  replaceBookingServices, defaultServiceLinks, serviceLinksChanged, normalizeServiceLinks,
  buildAutoChargesDetailed, loadRateContext, sumCharges,
  dropAutoChargesOnCancel, trimChargesToCheckOut, pinLegacyTotal,
  loadChainSegments, loadSegmentRates, rebuildChainCharges, segmentsToPrice,
} = require('../utils/charges')
const { isStale } = require('../utils/bookingVersion')

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

/**
 * «Свободен ли номер» — ОДНА проверка на весь контроллер (`utils/availability.js`).
 *
 * До этого create/update/move звали findOverlap + findBufferConflict +
 * findAllotmentConflict каждый по-своему, а экраны подбора — утилиту: одно и то же
 * правило жило в двух местах и при первой же правке разошлось бы. Теперь правило
 * одно, а контроллеры отличаются только тем, что делают с отказом.
 *
 * @param {object} p поля как у checkRoomsAvailability + allowAllotmentOverride и client
 * @returns {Promise<null|{reason: string, conflict: object|null, message: string}>}
 *          null — номер свободен; иначе причина отказа
 */
async function findRoomBlock({
  roomId, checkIn, checkOut, excludeBookingId = null, flags = [], partnerId = null,
  allowAllotmentOverride = false, client,
}) {
  const checked = await checkRoomsAvailability({
    roomIds: [roomId], checkIn, checkOut, excludeBookingId, flags, partnerId, client,
  })
  const hit = checked.get(parseInt(roomId))
  if (!hit || hit.available) return null
  // Квота — не запрет намертво: отель вправе продать выделенный номер, но осознанно.
  // Подтверждение снимает ТОЛЬКО причину квоты: пересечение и буфер им не обходятся.
  if (hit.reason === 'allotment' && allowAllotmentOverride) return null
  return hit
}

/**
 * Действует ли ранее данное подтверждение «продать поверх квоты».
 *
 * Флаг `Booking.allotmentOverride` привязан к КОНКРЕТНОМУ размещению: подтверждали
 * продажу этого номера на эти даты, а не право игнорировать любые квоты. Сменился
 * номер или даты — вопрос задаётся заново (решение 2026-09-08,
 * `docs/decisions/bookings.md`). Без флага бронь в квотном номере получала 409 при
 * КАЖДОМ сохранении и становилась нередактируемой (аудит D3-003, D7-005).
 */
function keepsAllotmentOverride(existing, { roomId, checkIn, checkOut }) {
  if (!existing?.allotmentOverride) return false
  const sameDay = (a, b) => new Date(a).getTime() === new Date(b).getTime()
  return parseInt(roomId) === existing.roomId
    && sameDay(checkIn, existing.checkIn)
    && sameDay(checkOut, existing.checkOut)
}

/**
 * 409 в той форме, которую клиент ждёт с волны 1 (форма ответа НЕ менялась при
 * переводе на общую утилиту): у пересечения — объект `conflict`, у квоты — `code`,
 * по которому модалка показывает подтверждение вместо красной ошибки.
 */
function respondRoomBlocked(res, block) {
  if (block.reason === 'overlap') {
    return res.status(409).json({ error: block.message, conflict: block.conflict })
  }
  if (block.reason === 'allotment') {
    return res.status(409).json({ error: block.message, code: 'ALLOTMENT_CONFLICT' })
  }
  // Буфер: утилита даёт саму причину, «что делать» дописывает контроллер — на экране
  // подбора этот совет неуместен, а в форме брони он был в тексте изначально.
  return res.status(409).json({ error: `${block.message}. Выберите другие даты или номер.` })
}

/**
 * Отказ в переезде. Окно переезда показывает ТОЛЬКО текст (`data.error`), поэтому
 * формулировка про пересечение остаётся своей — «целевой номер занят (имя)», как
 * до перевода на общую утилиту. `code` у квоты сохраняем: сейчас его никто не читает,
 * но он пригодится, когда в переезде появится подтверждение поверх квоты.
 */
function respondMoveBlocked(res, block) {
  if (block.reason === 'overlap') {
    return res.status(409).json({ error: `Целевой номер занят (${block.conflict.guestName})` })
  }
  if (block.reason === 'allotment') {
    return res.status(409).json({ error: block.message, code: 'ALLOTMENT_CONFLICT' })
  }
  return res.status(409).json({ error: block.message })
}

// ─── Документ гостя ──────────────────────────────────────────────────────────
//
// Шесть полей документа ходят всегда вместе — при создании, при правке, при
// переезде и при подстановке из прошлого визита. Список поэтому ОДИН и живёт
// в utils/guestDocFields.js: дописать седьмое поле в схему и забыть про него
// было бы очень легко, а читателей у списка теперь двое — этот контроллер
// (пишет поля) и сокет (обязан их вырезать из broadcast'а).
const { GUEST_DOC_FIELDS } = require('../utils/guestDocFields')
// Эти два — @db.Date: из формы приходят строкой «ГГГГ-ММ-ДД», Prisma ждёт Date.
const GUEST_DOC_DATE_FIELDS = ['guestDocExpiry', 'guestBirthDate']

/**
 * Значение одного поля документа из тела запроса.
 * Пустая строка из формы — это «поле не заполнено», а не значение: очищенный
 * `<input>` присылает '', и записать её в базу значило бы завести гостя с
 * гражданством «» — оно не равно null и портит и выборки, и подстановку.
 */
function guestDocValue(field, raw) {
  if (raw === null || raw === undefined) return null
  const s = String(raw).trim()
  if (!s) return null
  // new Date('ГГГГ-ММ-ДД') — это UTC-полночь, ровно то, что хранит @db.Date
  // (см. правило про даты в NOTES.md). Формат проверен в routes/bookings.js.
  return GUEST_DOC_DATE_FIELDS.includes(field) ? new Date(s) : s
}

/** Полный набор для create: чего не прислали — того у гостя нет, пишем null. */
function guestDocCreateData(body) {
  const data = {}
  for (const f of GUEST_DOC_FIELDS) data[f] = guestDocValue(f, body[f])
  return data
}

/**
 * Частичный PUT: поля, которых В ТЕЛЕ НЕТ, не трогаем вовсе.
 * Это не мелочь — бронь сохраняется не только из карточки заселения: сдвиг дат
 * из шахматки или правка заметки отправляют своё подмножество полей, и
 * «отсутствует = очистить» стёрло бы паспорт молча. Явный null (стереть) от
 * отсутствия поля отличается, как и у guestPhone/notes рядом.
 */
function guestDocUpdateData(body) {
  const data = {}
  for (const f of GUEST_DOC_FIELDS) {
    if (body[f] !== undefined) data[f] = guestDocValue(f, body[f])
  }
  return data
}

/**
 * Переезд: документ едет вместе с гостем. Это тот же человек в другом номере —
 * оставить вторую часть без паспорта значило бы «кто жил в 12-м после переезда»
 * ответить уже нельзя, а ради этого вопроса поля и заводились.
 */
function guestDocCopy(existing) {
  const data = {}
  for (const f of GUEST_DOC_FIELDS) data[f] = existing[f] ?? null
  return data
}

const BOOKING_SELECT = {
  id: true,
  guestName: true,
  guestPhone: true,
  // Документ гостя. В общем select, а не в «подробном»: карточка просмотра брони
  // и форма заселения читают тот же payload, что уходит в socket-события, и без
  // этих полей второе рабочее место показывало бы бронь без паспорта до перезагрузки.
  guestCitizenship: true,
  guestDocType: true,
  guestDocNumber: true,
  guestDocExpiry: true,
  guestBirthDate: true,
  guestSex: true,
  checkIn: true,
  checkOut: true,
  // Фактические моменты заезда/выезда — настоящие timestamp'ы (не @db.Date):
  // checkIn/checkOut это ПЛАН по суткам отеля, а эти два — когда гость реально
  // пришёл и ушёл. Держим их в общем select, иначе поля не уйдут ни в REST-ответ,
  // ни в socket-события (payload у них один и тот же).
  actualCheckInAt: true,
  actualCheckOutAt: true,
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
  // ─── Счёт цепочки (волна 5b) ───
  // `accountBookingId` непусто = это продолжение после переезда, деньги на голове.
  // Клиенту нужны обе стороны связи: у продолжения — плашка «Счёт брони №N»,
  // у головы — список её частей для строки «номера 12 → 15» и значка в шахматке.
  accountBookingId: true,
  account: { select: { id: true, room: { select: { number: true } } } },
  continuations: {
    select: {
      id: true, roomId: true, room: { select: { number: true } },
      checkIn: true, checkOut: true, status: true,
    },
    orderBy: { checkIn: 'asc' },
  },
  // «Продана поверх квоты партнёра» — вопрос уже задан и подтверждён
  allotmentOverride: true,
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

/**
 * Разослать `booking:updated` по ВСЕМ отрезкам счёта.
 *
 * Деньги цепочки живут на голове, а на экране их показывают все её части: приняли
 * оплату в форме продолжения — полоса «Начислено/Долг» обязана обновиться и у головы,
 * и наоборот. `skip` — записи, событие по которым уже отправлено вызывающим.
 * Сбой сокета не должен ронять саму операцию: деньги уже записаны.
 */
async function emitChainUpdated(anyBookingId, skip = []) {
  try {
    const headId = await resolveAccountId(anyBookingId)
    if (headId === null) return
    const parts = await prisma.booking.findMany({
      where: { accountBookingId: headId }, select: { id: true },
    })
    const skipSet = new Set(skip.map((x) => parseInt(x)))
    for (const partId of [headId, ...parts.map((p) => p.id)]) {
      if (skipSet.has(partId)) continue
      const booking = await prisma.booking.findUnique({ where: { id: partId }, select: BOOKING_SELECT })
      if (booking) emitBookingEvent('booking:updated', { booking })
    }
  } catch { /* сокет не инициализирован либо цепочка исчезла — операция уже выполнена */ }
}

/**
 * Голова счёта брони: она сама либо бронь, на которую указывает `accountBookingId`.
 * Считается своим запросом, а не через `utils/bookingMoney`, чтобы контроллер броней
 * не зависел от денежного модуля ради одного `select` из двух колонок.
 */
async function resolveAccountId(bookingId, client = prisma) {
  const b = await client.booking.findUnique({
    where: { id: parseInt(bookingId) },
    select: { id: true, accountBookingId: true },
  })
  return b ? (b.accountBookingId ?? b.id) : null
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
      discountPercent, prepaymentPercent, flags, shiftId,
      services,
    } = req.body
    // totalAmount / prepaidAmount / paidAmount из тела НЕ читаются намеренно (волна 5a):
    // итог брони — только сумма строк начислений (recalcBookingTotals), принято —
    // только журнал платежей (recalcBookingPaid). Присланные клиентом числа раньше
    // писались как есть и расходились со строками (аудит D2-005, D2-007).

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

    // Свободен ли номер: пересечение → буфер метки → квота партнёра, одной проверкой.
    // NB: partnerId в create/update из тела НЕ разбирается (бронь партнёру здесь
    // не назначается) — берём напрямую из req.body, чтобы не ловить ReferenceError.
    const block = await findRoomBlock({
      roomId, checkIn, checkOut,
      flags: flags || [],
      partnerId: req.body.partnerId,
      allowAllotmentOverride: req.body.allowAllotmentOverride,
    })
    if (block) return respondRoomBlocked(res, block)

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
          // Документ чаще всего пустой: бронь по телефону заводят до приезда,
          // паспорт появляется на стойке при заселении. Но если стойка заводит
          // бронь уже с гостем перед стойкой — записать его можно сразу.
          ...guestDocCreateData(req.body),
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
          totalAmount: 0,
          prepaidAmount: 0,
          paidAmount: 0,
          // Гость «с улицы»: бронь заводят в момент, когда он уже стоит у стойки,
          // поэтому фактический заезд и есть сейчас. Через кнопку «Заезд» время
          // ставилось, а через walk-in из шахматки терялось (аудит D7-004).
          ...(initialStatus === 'CHECKED_IN' && { actualCheckInAt: new Date() }),
          flags: Array.isArray(flags) ? flags : [],
          // Продали поверх квоты — запоминаем ответ администратора, чтобы не
          // спрашивать снова при каждой правке брони (см. keepsAllotmentOverride)
          allotmentOverride: req.body.allowAllotmentOverride === true,
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
      discountPercent, prepaymentPercent, flags, shiftId,
      services, actualCheckInAt, actualCheckOutAt,
    } = req.body
    // totalAmount / prepaidAmount / paidAmount из тела игнорируются — см. комментарий
    // в create(). Правила валидации в routes оставлены: старый клиент может их слать,
    // и отвечать ему 400 незачем — поля просто не влияют на запись.

    const existing = await prisma.booking.findUnique({ where: { id } })
    if (!existing) return next(createError('Бронь не найдена', 404))

    // Замок версии — ДО любой проверки: если бронь изменилась на другом рабочем
    // месте, спорить об остальном уже незачем. Отдаём текущую бронь целиком
    // (как GET /bookings/:id), чтобы форма показала, что именно изменилось.
    //
    // Это только быстрый отказ. Настоящий замок — в самой записи ниже
    // (`updatedAt` в условии UPDATE, S13-004): между этой проверкой и записью
    // лежат ещё несколько обращений к базе, и соседнее рабочее место успевало
    // сохранить своё в этом окне — тогда 409 не получал никто, а правка первого
    // исчезала молча. Ровно тот случай, ради которого замок и делался (D5-004).
    if (isStale(req.body.expectedUpdatedAt, existing.updatedAt)) {
      return respondStale(res, id)
    }
    const expectedVersion = parseExpectedVersion(req.body.expectedUpdatedAt)

    if (['CHECKED_OUT', 'CANCELLED'].includes(existing.status)) {
      return next(createError('Нельзя редактировать закрытую бронь', 400))
    }

    // Фактические заезд/выезд ставит система в момент операции — это свидетельство
    // о произошедшем, а не поле формы. Правка задним числом иногда нужна (стойка
    // отметила заезд через час), но это уже исправление истории → только администратор.
    // Молча игнорировать попытку нельзя: STAFF решил бы, что время сохранено.
    const editsActualTimes = actualCheckInAt !== undefined || actualCheckOutAt !== undefined
    if (editsActualTimes && !['SUPER_ADMIN', 'ADMIN'].includes(req.admin?.role)) {
      return next(createError('Изменить фактическое время заезда/выезда может только администратор', 403))
    }

    // Сверяем ИТОГОВУЮ пару (новое значение либо уже записанное): прислали один
    // actualCheckOutAt — он всё равно не должен оказаться раньше сохранённого заезда.
    const nextActualIn = actualCheckInAt !== undefined
      ? (actualCheckInAt ? new Date(actualCheckInAt) : null)
      : existing.actualCheckInAt
    const nextActualOut = actualCheckOutAt !== undefined
      ? (actualCheckOutAt ? new Date(actualCheckOutAt) : null)
      : existing.actualCheckOutAt
    if (nextActualIn && nextActualOut && nextActualOut.getTime() < nextActualIn.getTime()) {
      return next(createError('Фактический выезд не может быть раньше фактического заезда', 400))
    }

    const newRoomId = roomId ?? existing.roomId
    const newCheckIn = checkIn ? new Date(checkIn) : existing.checkIn
    const newCheckOut = checkOut ? new Date(checkOut) : existing.checkOut

    // У заселившегося гостя дата заезда зафиксирована
    if (existing.status === 'CHECKED_IN' && newCheckIn.getTime() !== existing.checkIn.getTime()) {
      return next(createError('Нельзя изменить дату заезда у заселившегося гостя', 400))
    }

    // Смена номера у заселившегося гостя через форму — это перенос брони ЦЕЛИКОМ
    // от даты заезда (решение владельца 2026-09-08): «поменял номер в форме — бронь
    // целиком в новом номере, если он свободен». Переезд с разломом на дате — только
    // перетаскиванием в шахматке или через «Переселить…» (POST /:id/move). Доступность
    // нового номера на весь срок уже проверена выше (findRoomBlock с excludeBookingId),
    // смена категории переоценивает ночи через chargeInputsChanged (roomId в списке).

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

    // Подтверждение поверх квоты: новое из тела либо ранее данное, если размещение
    // не менялось. При смене номера или дат флаг гаснет — вопрос будет задан заново.
    const keptOverride = keepsAllotmentOverride(existing, {
      roomId: newRoomId, checkIn: newCheckIn, checkOut: newCheckOut,
    })
    const nextOverride = req.body.allowAllotmentOverride === true || keptOverride

    // Та же проверка, что при создании: сама бронь себе не мешает (excludeBookingId),
    // а буфер считается по ИТОГОВЫМ меткам — тем, с которыми бронь останется после правки.
    const blockU = await findRoomBlock({
      roomId: newRoomId,
      checkIn: newCheckIn,
      checkOut: newCheckOut,
      excludeBookingId: id,
      flags: flags ?? existing.flags ?? [],
      partnerId: req.body.partnerId !== undefined ? req.body.partnerId : existing.partnerId,
      allowAllotmentOverride: nextOverride,
    })
    if (blockU) return respondRoomBlocked(res, blockU)

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

    // Граница «уже прожитого» для пересборки строк (S13-010). Раньше замораживались
    // только ночи продолжения цепочки, а у обычной заселённой брони любая правка
    // (подселили третьего, дали скидку) пересчитывала ВСЕ ночи по сегодняшнему
    // календарю — счёт за прожитое менялся задним числом. Считаем от рабочей даты
    // отеля: ночи до неё гость уже прожил, их цена зафиксирована.
    const frozenBefore = needsRebuild ? await resolveFrozenBefore(existing, newCheckIn) : null

    const booking = await prisma.$transaction(async (tx) => {
      // Сверка версии и запись — ОДНА операция (S13-004): `updatedAt` стоит в
      // условии UPDATE, поэтому в гонке двух рабочих мест изменит строку ровно
      // одно, а второму база вернёт 0 изменённых строк → 409 BOOKING_STALE.
      // Версию не прислали (старый клиент, служебный вызов) — условие только по id.
      const { count } = await tx.booking.updateMany({
        where: expectedVersion ? { id, updatedAt: expectedVersion } : { id },
        data: {
          roomId: newRoomId,
          guestName: guestName?.trim() ?? existing.guestName,
          guestPhone: guestPhone !== undefined ? guestPhone?.trim() || null : existing.guestPhone,
          ...guestDocUpdateData(req.body),
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
          ...(flags !== undefined && { flags: Array.isArray(flags) ? flags : [] }),
          ...(shiftId !== undefined && { shiftId: shiftId ? parseInt(shiftId) : null }),
          ...(actualCheckInAt !== undefined && { actualCheckInAt: nextActualIn }),
          ...(actualCheckOutAt !== undefined && { actualCheckOutAt: nextActualOut }),
          allotmentOverride: nextOverride,
        },
      })
      if (count === 0) throw staleError(expectedVersion ? 'stale' : 'gone')
      const updated = await tx.booking.findUnique({ where: { id }, select: BOOKING_SELECT })

      // Переписываем только при реальном изменении: иначе каждое сохранение брони
      // пересоздавало бы строки (новые id, новая дата создания) без всякой причины.
      if (servicesChanged) await replaceBookingServices(id, services, tx)

      // Все деньги — на голове счёта: правка продолжения после переезда пересобирает
      // цепочку целиком, а не свои несуществующие строки.
      const accountId = existing.accountBookingId ?? id

      if (!needsRebuild) {
        // Процент предоплаты на строки не влияет, но prepaidAmount считается от него.
        // Раньше новое значение присылал клиент; теперь его считает только сервер,
        // и без этого пересчёта «Предоплата» осталась бы от старого процента.
        const pctChanged = prepaymentPercent !== undefined
          && Number(prepaymentPercent) !== Number(existing.prepaymentPercent)
        if (!pctChanged) return updated
        await recalcBookingTotals(accountId, { client: tx, keepIfEmpty: true })
        return tx.booking.findUnique({ where: { id }, select: BOOKING_SELECT })
      }

      // Прожитые ночи не переоцениваем (граница посчитана выше).
      await rebuildChainCharges(accountId, {
        adminId: req.admin.id,
        client: tx,
        keepIfEmpty: true,
        frozenBefore,
      })
      return tx.booking.findUnique({ where: { id }, select: BOOKING_SELECT })
    })

    emitBookingEvent('booking:updated', { booking })
    // Правка продолжения пересобрала счёт головы — её карточка тоже устарела
    if (existing.accountBookingId) await emitChainUpdated(id, [id])
    res.json({ data: booking })
  } catch (err) {
    // Условный UPDATE не нашёл строку: пока шли проверки, бронь либо изменили
    // на другом рабочем месте, либо удалили. Транзакция уже откатилась.
    if (err && err[STALE_MARK] === 'stale') return respondStale(res, parseInt(req.params.id))
    if (err && err[STALE_MARK] === 'gone') return next(createError('Бронь не найдена', 404))
    next(err)
  }
}

// ─── Замок версии брони (D5-004, атомарный с S13-004) ────────────────────────

/** Метка «наша» на ошибке из транзакции: по тексту такие вещи не различают. */
const STALE_MARK = Symbol('bookingStale')

function staleError(kind) {
  const err = new Error(kind === 'stale' ? 'Бронь изменена на другом рабочем месте' : 'Бронь не найдена')
  err[STALE_MARK] = kind
  return err
}

/**
 * Версия для условия UPDATE. `isStale` уже отсеял мусор и отсутствие поля,
 * поэтому здесь остаётся либо корректная дата, либо null («замка нет»).
 */
function parseExpectedVersion(expectedUpdatedAt) {
  if (expectedUpdatedAt === undefined || expectedUpdatedAt === null || expectedUpdatedAt === '') return null
  const d = expectedUpdatedAt instanceof Date ? expectedUpdatedAt : new Date(expectedUpdatedAt)
  return Number.isNaN(d.getTime()) ? null : d
}

/** 409 с ТЕКУЩЕЙ броней: форма покажет, что именно изменилось. */
async function respondStale(res, id) {
  const current = await prisma.booking.findUnique({ where: { id }, select: BOOKING_DETAIL_SELECT })
  return res.status(409).json({
    error: 'Бронь изменена на другом рабочем месте',
    code: 'BOOKING_STALE',
    booking: current,
  })
}

/** Дата брони (@db.Date) как UTC-полночь — в этом виде её сравнивают с рабочей датой. */
function bookingDayUTC(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

/**
 * Граница заморозки прожитых ночей при обычном сохранении брони (S13-010).
 *
 * Ночи СТРОГО РАНЬШЕ неё `rebuildChainCharges` не переоценивает. Берём рабочую
 * дату отеля, а не календарную: сутки в отеле сдвинуты и двигаются только
 * кнопкой «Следующий день» (`utils/businessDate.js`). Ниже заезда самого отрезка
 * граница не опускается — у продолжения цепочки его ночи начинаются с переезда,
 * а у одиночной брони до заезда замораживать нечего.
 *
 * Единственное исключение — заезд подвинули НАЗАД (это разрешено только броням
 * «ремонт»): у появившихся ночей в прошлом строк ещё нет, и заморозка закрыла бы
 * их нулём вместо цены. Такую правку считаем целиком.
 *
 * @param {object} existing бронь до правки
 * @param {Date} newCheckIn дата заезда после правки
 * @returns {Promise<Date|null>} граница или null, если замораживать нечего
 */
async function resolveFrozenBefore(existing, newCheckIn) {
  const checkIn = bookingDayUTC(existing.checkIn)
  if (newCheckIn && bookingDayUTC(newCheckIn).getTime() < checkIn.getTime()) {
    return existing.accountBookingId ? existing.checkIn : null
  }
  const businessDate = await getCurrentBusinessDate()
  const cut = businessDate.getTime() > checkIn.getTime() ? bookingDayUTC(businessDate) : checkIn
  // У головы/одиночной брони граница на дате заезда эквивалентна «ничего не заморожено»
  // (ночей раньше заезда не бывает) — не гоняем лишнюю ветку в rebuildChainCharges.
  if (!existing.accountBookingId && cut.getTime() <= checkIn.getTime()) return null
  return cut
}

/**
 * Можно ли отменить бронь. Вынесено из `cancel`, потому что те же проверки обязан
 * пройти расчёт с гостем (`settlementController`): отмена там — то же действие,
 * а не его копия.
 * @returns {Error|null} готовая ошибка для next() или null
 */
function cancelGuard(existing, role) {
  // Продолжение после переезда отменить нельзя. Отмена значит «гость не жил» —
  // для второго отрезка это ложь, а `dropAutoChargesOnCancel` у брони без своих
  // строк не снял бы ничего: голова продолжала бы начислять непрожитые ночи.
  // Правильный выход из цепочки — выезд (в том числе ранний, через расчёт с гостем).
  if (existing.accountBookingId) {
    return createError('Продолжение брони отменить нельзя — оформите выезд', 400)
  }
  if (existing.status === 'CANCELLED') return createError('Бронь уже отменена', 400)
  if (existing.status === 'CHECKED_OUT') return createError('Нельзя отменить закрытую бронь', 400)
  // Отмена живущего гостя — операция с последствиями для расчётов, только администраторам
  if (existing.status === 'CHECKED_IN' && !['SUPER_ADMIN', 'ADMIN'].includes(role)) {
    return createError('Отменить заселённого гостя может только администратор', 403)
  }
  return null
}

/**
 * Можно ли оформить выезд. Рабочая дата раньше заезда (бронь заселена «в будущее») —
 * выезд оформить нельзя, иначе checkOut ушёл бы раньше checkIn.
 * @returns {Error|null}
 */
function checkOutGuard(existing, businessDate) {
  if (existing.status !== 'CHECKED_IN') {
    return createError(`Нельзя отметить выезд: статус "${existing.status}"`, 400)
  }
  if (businessDate.getTime() < bookingDayUTC(existing.checkIn).getTime()) {
    return createError('Рабочая дата раньше даты заезда — выезд невозможен', 400)
  }
  return null
}

/**
 * Возвращает `BookingService` отменённого продолжения на предыдущий активный отрезок.
 *
 * Набор услуг у счёта ровно один и всегда живёт у ТЕКУЩЕГО отрезка — так его правит
 * стойка и так его читает генератор (`rebuildChainCharges`). Переезд этот набор
 * перевозит; отмена переезда обязана перевезти его обратно, иначе «текущим» станет
 * голова без услуг.
 *
 * Зовётся уже ПОСЛЕ смены статуса на CANCELLED: `loadChainSegments` отменённые
 * продолжения из цепочки выбрасывает, поэтому последний оставшийся отрезок — и есть
 * тот, на котором гость остаётся.
 */
async function returnServicesToPreviousSegment(tx, cancelled) {
  const { segments } = await loadChainSegments(cancelled.accountBookingId, tx)
  if (segments.length === 0) return
  const target = segments[segments.length - 1].booking
  if (target.id === cancelled.id) return  // отрезок ещё числится живым — переносить некуда
  await tx.bookingService.updateMany({
    where: { bookingId: cancelled.id },
    data: { bookingId: target.id },
  })
}

/** Отмена внутри транзакции: статус + обнуление автоматического счёта. */
async function applyCancel(tx, existing, { note = null } = {}) {
  await tx.booking.update({
    where: { id: existing.id },
    data: {
      status: 'CANCELLED',
      ...(note ? { notes: appendNote(existing.notes, note) } : {}),
    },
  })
  if (existing.accountBookingId) {
    // Отменяется ПРОДОЛЖЕНИЕ (сюда попадает только выезд день-в-день с переездом —
    // прямую отмену не пускает cancelGuard). Своих строк у него нет: ночи этого
    // отрезка снимаются со счёта головы пересборкой, а прожитые до переезда
    // остаются замороженными и не переоцениваются.
    //
    // Сначала возвращаем услуги на предыдущий активный отрезок. `move` их не
    // копирует, а ПЕРЕНОСИТ на продолжение, и после его отмены набор услуг счёта
    // остался бы на отменённой записи: генератор берёт услуги у последнего живого
    // отрезка, не нашёл бы их вовсе — и питание за уже прожитые ночи молча
    // исчезло бы со счёта (восстановить его потом было бы нечем, «Пересчитать»
    // вернуло бы ту же сумму без завтраков). Той же транзакцией — иначе счёт
    // пересобрался бы по половине данных.
    await returnServicesToPreviousSegment(tx, existing)
    await rebuildChainCharges(existing.accountBookingId, {
      client: tx, frozenBefore: existing.checkIn,
    })
    return
  }
  await dropAutoChargesOnCancel(existing.id, tx)
}

/**
 * Выезд внутри транзакции. Возвращает, каким событием это закончилось:
 * выезд день-в-день с заездом — это отмена (гость не ночевал), а не выезд.
 * @returns {Promise<'booking:cancelled'|'booking:checkout'>}
 */
async function applyCheckOut(tx, existing, businessDate, adminId) {
  // Выезд день-в-день с заездом: гость не ночевал.
  // Раньше здесь было `booking.delete` — запись физически исчезала из базы вместе
  // с историей, аудитом и деньгами, хотя обычная отмена принципиально ничего не
  // удаляет. Теперь отменяем, как везде: номер освобождается (CANCELLED выведен
  // из-под ограничения booking_no_overlap), а факт остаётся в базе. Счёт при этом
  // обнуляется по правилам отмены — начислять проживание не за что.
  if (businessDate.getTime() === bookingDayUTC(existing.checkIn).getTime()) {
    await applyCancel(tx, existing, { note: 'Выезд в день заезда — гость не ночевал' })
    return 'booking:cancelled'
  }

  // actualCheckOutAt — реальный момент выезда; checkOut остаётся датой суток отеля.
  // Их специально двое: гость, уехавший в 11:40 рабочего дня, и гость, уехавший
  // ночью, дают одну и ту же дату выезда, но разное время освобождения номера.
  const data = { status: 'CHECKED_OUT', actualCheckOutAt: new Date() }
  const early = businessDate < existing.checkOut
  if (early) data.checkOut = businessDate

  await tx.booking.update({ where: { id: existing.id }, data })
  // Бронь с новой датой и старыми начислениями за непрожитые ночи — это ложный долг
  // в кассе и в «Долгах», поэтому пересчёт идёт той же транзакцией.
  if (early) await trimChargesToCheckOut(existing, businessDate, tx, adminId)
  return 'booking:checkout'
}

// DELETE /api/bookings/:id — отмена (не удаление из БД)
async function cancel(req, res, next) {
  try {
    const id = parseInt(req.params.id)

    const existing = await prisma.booking.findUnique({ where: { id } })
    if (!existing) return next(createError('Бронь не найдена', 404))

    const denied = cancelGuard(existing, req.admin?.role)
    if (denied) return next(denied)

    const booking = await prisma.$transaction(async (tx) => {
      await applyCancel(tx, existing)
      return tx.booking.findUnique({ where: { id }, select: BOOKING_SELECT })
    })

    emitBookingEvent('booking:cancelled', { bookingId: id, roomId: booking.room.id })
    res.json({ data: booking })
  } catch (err) {
    next(err)
  }
}

// PATCH /api/bookings/:id/actual-times — правка фактического заезда/выезда
// администратором задним числом (кнопку «Заезд»/«Выезд» нажали позже, чем
// гость реально приехал/уехал). Отдельный узкий эндпоинт, а не общий update():
// общая форма блокирует редактирование ЗАКРЫТОЙ (CHECKED_OUT) брони целиком,
// а фактический выезд обычно и нужно поправить именно ПОСЛЕ того, как бронь
// уже закрыта. Разрешаем и на CANCELLED — отменённая бронь тоже могла успеть
// зафиксировать заезд, который потом захотят поправить.
async function updateActualTimes(req, res, next) {
  try {
    const id = parseInt(req.params.id)
    const { actualCheckInAt, actualCheckOutAt } = req.body

    if (!['SUPER_ADMIN', 'ADMIN'].includes(req.admin?.role)) {
      return next(createError('Изменить фактическое время заезда/выезда может только администратор', 403))
    }

    const existing = await prisma.booking.findUnique({ where: { id } })
    if (!existing) return next(createError('Бронь не найдена', 404))

    const nextIn = actualCheckInAt !== undefined
      ? (actualCheckInAt ? new Date(actualCheckInAt) : null)
      : existing.actualCheckInAt
    const nextOut = actualCheckOutAt !== undefined
      ? (actualCheckOutAt ? new Date(actualCheckOutAt) : null)
      : existing.actualCheckOutAt
    if (nextIn && nextOut && nextOut.getTime() < nextIn.getTime()) {
      return next(createError('Фактический выезд не может быть раньше фактического заезда', 400))
    }

    const data = {}
    if (actualCheckInAt !== undefined) data.actualCheckInAt = nextIn
    if (actualCheckOutAt !== undefined) data.actualCheckOutAt = nextOut

    const booking = await prisma.booking.update({ where: { id }, data, select: BOOKING_SELECT })
    emitBookingEvent('booking:updated', { booking })
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

    // Верхняя граница: заселить бронь, у которой выезд уже прошёл, значит получить
    // CHECKED_IN с выездом в прошлом — «Следующий день» после этого блокируется
    // (просроченный выезд), а «Выезд» закроет бронь вчерашней датой (аудит D3-004).
    // Полуоткрытый интервал: выезд РОВНО в текущий рабочий день — тоже прошлое,
    // ночевать уже негде.
    const checkOutUTC = new Date(Date.UTC(
      existing.checkOut.getUTCFullYear(),
      existing.checkOut.getUTCMonth(),
      existing.checkOut.getUTCDate(),
    ))
    if (checkOutUTC.getTime() <= businessDate.getTime()) {
      return next(createError('Дата выезда уже прошла — измените даты или отмените бронь', 400))
    }

    const booking = await prisma.booking.update({
      where: { id },
      // Момент нажатия кнопки «Заезд» и есть фактический заезд: дата смены может
      // отставать от календаря (поздний заезд оформляют «вчерашним» днём), а здесь
      // нужен реальный час — по нему считают ранние/поздние заезды и разбирают споры.
      data: { status: 'CHECKED_IN', actualCheckInAt: new Date() },
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

    const todayUTC = await getCurrentBusinessDate()
    const denied = checkOutGuard(existing, todayUTC)
    if (denied) return next(denied)

    // Статус, дата выезда и пересчёт счёта — одной транзакцией (см. applyCheckOut)
    const { event, booking } = await prisma.$transaction(async (tx) => {
      const ev = await applyCheckOut(tx, existing, todayUTC, req.admin.id)
      return { event: ev, booking: await tx.booking.findUnique({ where: { id }, select: BOOKING_SELECT }) }
    })

    if (event === 'booking:cancelled') {
      emitBookingEvent('booking:cancelled', { bookingId: id, roomId: booking.room.id })
    } else {
      emitBookingEvent('booking:checkout', { booking })
    }
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

    // Момент переезда берём ОДИН на всю операцию: обе записи (закрываемый оригинал и
    // новая бронь в другом номере) описывают один физический факт, и два разных
    // new Date() внутри транзакции дали бы им разное время с разрывом в миллисекунды.
    const movedAt = new Date()

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

    // Same-day move — только меняем roomId, без сплита. Проверка и запись теперь
    // в одной транзакции; раньше эта ветка обходилась вообще без неё.
    // Честно про гонку: от двойного бронирования по-настоящему страхует
    // exclusion-constraint booking_no_overlap (он проверяет и UPDATE тоже), а у
    // буфера и квоты окно остаётся — при READ COMMITTED транзакция его не
    // закрывает, только сокращает до одного соединения без пауз посередине.
    const headId = existing.accountBookingId ?? existing.id

    if (moveDateD.getTime() === existing.checkIn.getTime()) {
      const outcome = await prisma.$transaction(async (tx) => {
        const block = await findRoomBlock({
          roomId: parseInt(newRoomId),
          checkIn: existing.checkIn,
          checkOut: existing.checkOut,
          excludeBookingId: id,
          // Метки и партнёр переезжают вместе с гостем — по ним и считаем
          flags: existing.flags || [],
          partnerId: existing.partnerId,
          allowAllotmentOverride: req.body.allowAllotmentOverride,
          client: tx,
        })
        if (block) return { block }

        await tx.booking.update({
          where: { id },
          data: {
            roomId: parseInt(newRoomId),
            // Номер сменился — прежнее подтверждение поверх квоты к нему не относится
            allotmentOverride: req.body.allowAllotmentOverride === true,
          },
        })

        // Категория нового номера может отличаться — счёт пересобираем даже без
        // сплита. Прожитые ночи предыдущих отрезков замораживаем по дате заезда
        // этого; у брони без строк прежний итог сначала фиксируется строкой,
        // иначе пересборка переоценила бы её по сегодняшнему календарю.
        await pinLegacyTotal(headId, { client: tx, adminId: req.admin.id })
        await rebuildChainCharges(headId, {
          adminId: req.admin.id, client: tx, keepIfEmpty: true, frozenBefore: existing.checkIn,
        })

        return { updated: await tx.booking.findUnique({ where: { id }, select: BOOKING_SELECT }) }
      })
      if (outcome.block) return respondMoveBlocked(res, outcome.block)

      emitBookingEvent('booking:updated', { booking: outcome.updated })
      await emitChainUpdated(headId, [id])
      return res.json({ data: { original: outcome.updated, created: null } })
    }

    // Деньги НЕ делятся. Переезд создаёт продолжение того же счёта: строки
    // начислений и платежи остаются на голове, у продолжения нули
    // (`docs/decisions/data-and-money.md`, решение 2026-09-08). Прежняя пропорция по
    // ночам оставляла платежи на первой части, не делила питание и скидку и без
    // посуточных строк удваивала начисления (аудит D3-001/002, D7-013).

    const result = await prisma.$transaction(async (tx) => {
      // 0. Свободен ли целевой номер на [moveDate, checkOut). Проверка внутри той же
      // транзакции, что и запись: раньше она шла отдельным запросом до неё.
      // excludeBookingId НЕ ставим намеренно: если целевой номер совпадает с текущим,
      // исходная бронь на этот период ещё активна и должна считаться помехой —
      // «переезд в тот же номер» не операция, а ошибка ввода.
      const block = await findRoomBlock({
        roomId: parseInt(newRoomId),
        checkIn: moveDateD,
        checkOut: existing.checkOut,
        flags: existing.flags || [],
        partnerId: existing.partnerId,
        allowAllotmentOverride: req.body.allowAllotmentOverride,
        client: tx,
      })
      if (block) return { block }

      // 1. Закрыть оригинальную бронь датой переезда
      const updatedOriginal = await tx.booking.update({
        where: { id },
        data: {
          checkOut: moveDateD,
          status: 'CHECKED_OUT',
          // Это НЕ выезд гостя из отеля — он продолжает жить, просто в другом номере.
          // Но запись в этой комнате физически перестала быть активной именно сейчас,
          // а поле про это и есть; оставить его пустым у CHECKED_OUT значило бы
          // потерять момент освобождения номера.
          actualCheckOutAt: movedAt,
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
          ...guestDocCopy(existing),
          checkIn: moveDateD,
          checkOut: existing.checkOut,
          status: 'CHECKED_IN',
          // Гость НЕ заезжает заново — он тот же самый и приехал когда приехал.
          // Поставить сюда момент переезда значило бы стереть настоящий заезд:
          // после переезда «время заезда» стало бы серединой проживания.
          actualCheckInAt: existing.actualCheckInAt,
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
          // Продолжение того же счёта: деньги лежат на голове цепочки, здесь нули.
          // Второй переезд подряд ссылается на ТУ ЖЕ голову, а не на предыдущую часть —
          // счёт у гостя один, сколько бы раз он ни переезжал.
          accountBookingId: headId,
          totalAmount: 0,
          prepaidAmount: 0,
          paidAmount: 0,
          // Подтверждение «поверх квоты» относится к НОВОМУ номеру: если его дали
          // при переезде — запоминаем, иначе продолжение начинает с чистого листа.
          allotmentOverride: req.body.allowAllotmentOverride === true,
          flags: existing.flags,
          partnerId: existing.partnerId,
          // В модели Booking поле называется adminId (relation createdBy) — createdById Prisma отклонял → 500
          adminId: req.admin.id,
          shiftId: existing.shiftId,
        },
        select: BOOKING_SELECT,
      })

      // Питание и услуги ПЕРЕНОСЯТСЯ на продолжение, а не копируются: набор
      // услуг у счёта один, и он всегда у текущего отрезка — именно его форму
      // правит стойка. Копия оставила бы две правды о завтраках, и следующая
      // пересборка выбирала бы из них наугад.
      await tx.bookingService.updateMany({
        where: { bookingId: id },
        data: { bookingId: created.id },
      })

      // Счёт цепочки пересобираем целиком на голове: ночи до переезда — по цене
      // старой категории (заморожены), ночи после — по новой, питание на все ночи.
      // У брони без строк (107 старых, см. NOTES) прежний итог сначала фиксируется
      // строкой, иначе переезд переоценил бы её по сегодняшнему календарю.
      await pinLegacyTotal(headId, { client: tx, adminId: req.admin.id })
      await rebuildChainCharges(headId, {
        adminId: req.admin.id, client: tx, keepIfEmpty: true, frozenBefore: moveDateD,
      })

      return {
        original: await tx.booking.findUnique({ where: { id }, select: BOOKING_SELECT }),
        created: await tx.booking.findUnique({ where: { id: created.id }, select: BOOKING_SELECT }),
        updatedOriginal,
      }
    })

    // Отказ возвращаем из транзакции, а не бросаем: бросок откатил бы и то, чего
    // не было (записей ещё нет), зато потерял бы `code: ALLOTMENT_CONFLICT` —
    // errorHandler кладёт в тело только текст.
    if (result.block) return respondMoveBlocked(res, result.block)

    // Клиент ждёт форму { booking } (как у остальных операций) — без обёртки падал с TypeError
    emitBookingEvent('booking:updated', { booking: result.original })
    emitBookingEvent('booking:created', { booking: result.created })
    // Деньги переехали на голову цепочки: если это второй переезд, голова —
    // третья запись, и без события её полоса «Начислено/Долг» осталась бы старой.
    await emitChainUpdated(headId, [id, result.created.id])
    res.json({ data: { original: result.original, created: result.created } })
  } catch (err) {
    next(err)
  }
}

function appendNote(existing, addition) {
  if (!existing) return addition
  return `${existing}\n${addition}`
}

// POST /api/bookings/check-availability — «свободно ли» до сохранения.
//
// Считает РОВНО то же, что create: пересечение → буфер метки → квота партнёра.
// Раньше здесь смотрели только пересечения — форма писала «номер свободен», а
// сохранение отвечало 409 про буфер или квоту.
async function checkAvailability(req, res, next) {
  try {
    const { roomId, checkIn, checkOut, excludeBookingId, flags, partnerId } = req.body

    if (!roomId || !checkIn || !checkOut) {
      return next(createError('roomId, checkIn, checkOut обязательны', 400))
    }
    // Пустой период create отклоняет 400-й; здесь отвечаем 200, чтобы форма,
    // которая дёргает проверку на каждый ввод даты, не ловила ошибку на полпути.
    if (new Date(checkOut) <= new Date(checkIn)) {
      return res.json({
        available: false, conflict: null, reason: 'range',
        message: 'Дата выезда должна быть позже даты заезда',
      })
    }

    const checked = await checkRoomsAvailability({
      roomIds: [roomId],
      checkIn,
      checkOut,
      excludeBookingId: excludeBookingId ? parseInt(excludeBookingId) : null,
      // Метки будущей брони важны для буфера: у метки бывает исключение
      // («выезд до 17:00» не мешает соседу с «заезд после 17:00»). Форма их пока
      // не присылает — тогда считаем по меткам соседа, как и раньше.
      flags: Array.isArray(flags) ? flags.map(String) : [],
      partnerId: partnerId ?? null,
    })
    // Утилита возвращает Map по номерам; на нечисловой roomId (роут его не пропустит,
    // но контроллер зовут и мимо роута) записи не будет — считаем номер свободным.
    const hit = checked.get(parseInt(roomId))
      ?? { available: true, reason: null, conflict: null, message: null }

    // `conflict` заполняем ТОЛЬКО прямым пересечением — как и раньше. Почему не всем:
    //  - у квоты нет полей guestName/checkIn/checkOut, которые читает форма
    //    (упала бы на conflict.checkIn.slice()), а главное — непустой conflict
    //    блокирует кнопку «Сохранить», и подтвердить продажу поверх квоты стало бы
    //    нечем: подтверждение приходит на 409 ALLOTMENT_CONFLICT при сохранении;
    //  - буфер без меток будущей брони даёт ЛОЖНЫЕ срабатывания: «выезд до 17:00»
    //    у соседа снимается меткой «заезд после 17:00» у новой брони, а форма метки
    //    сюда пока не присылает. Заблокировать по нему сохранение значило бы
    //    запретить бронь, которую create принимает.
    // Причина и текст отданы отдельно (`reason`/`message`): по ним клиент покажет
    // честную подсказку, когда начнёт присылать flags, — старая форма ответа цела.
    const conflict = hit.reason === 'overlap'
      ? { id: hit.conflict.bookingId, ...hit.conflict }
      : null

    res.json({ available: hit.available, conflict, reason: hit.reason, message: hit.message })
  } catch (err) {
    next(err)
  }
}

// POST /api/bookings/preview — сколько будет стоить, ЕЩЁ НЕ СОХРАНЯЯ.
//
// Зачем отдельный эндпоинт. Предпросмотр в форме считался своим кодом
// (`client/src/utils/calculator.ts`), и три числа расходились с сохранённым счётом:
// у клиента была своя база процентной скидки, ручные строки в неё не входили, а
// частичная цена ночи не показывалась вовсе (аудит D7-009, D2-003, D5-002).
// Теперь предпросмотр считает ТОТ ЖЕ код, что и сохранение: `buildAutoCharges`
// + ручные строки + `sumCharges`. Расходиться больше нечему.
//
// Ничего не пишет в базу, поэтому доступен любому вошедшему.
async function preview(req, res, next) {
  try {
    const {
      roomId, checkIn, checkOut, discountPercent, prepaymentPercent, services,
      bookingId, manualCharges,
    } = req.body

    if (!roomId || !checkIn || !checkOut) {
      return next(createError('roomId, checkIn, checkOut обязательны', 400))
    }
    if (new Date(checkOut) <= new Date(checkIn)) {
      return next(createError('Дата выезда должна быть позже даты заезда', 400))
    }

    const room = await prisma.room.findUnique({
      where: { id: parseInt(roomId) },
      // number/category — для подписи «Проживание · №12 Стандарт · 2 взр.» у цепочки
      select: { id: true, number: true, categoryId: true, category: { select: { name: true } } },
    })
    if (!room) return next(createError('Номер не найден', 404))

    // Бронь «на бумаге» — той же формы, что читает генератор из базы.
    const draft = {
      id: bookingId ? parseInt(bookingId) : 0,
      checkIn: toUTCDate(checkIn),
      checkOut: toUTCDate(checkOut),
      adultsWithMeals: intOr0(req.body.adultsWithMeals),
      childrenWithMeals: intOr0(req.body.childrenWithMeals),
      adultsNoMeals: intOr0(req.body.adultsNoMeals),
      childrenNoMeals: intOr0(req.body.childrenNoMeals),
      extraBedsWithMeals: intOr0(req.body.extraBedsWithMeals),
      extraBedsNoMeals: intOr0(req.body.extraBedsNoMeals),
      discountPercent: Number(discountPercent) || 0,
    }

    if (services !== undefined) {
      const badService = await findUnknownServices(services)
      if (badService) return next(createError(badService, 400))
    }

    // Набор услуг — как в create: не прислали → услуги «включены в тариф».
    const links = normalizeServiceLinks(
      services !== undefined ? services : await defaultServiceLinks(draft),
    )
    const serviceRows = links.length > 0
      ? await prisma.service.findMany({ where: { id: { in: links.map(l => l.serviceId) } } })
      : []
    const serviceById = new Map(serviceRows.map(s => [s.id, s]))
    const bookingServices = links.map(l => ({ ...l, service: serviceById.get(l.serviceId) || null }))

    // ── Цепочка «один счёт» ──
    // Предпросмотр показывает ВЕСЬ счёт гостя с подставленными несохранёнными
    // входами того отрезка, который сейчас в форме: иначе стойка видела бы в
    // продолжении «две ночи Комфорта», а в панели начислений — четыре ночи и
    // другой итог. Строки и деньги живут на голове, поэтому и ручные строки
    // берутся у неё, а не у отрезка.
    const chain = bookingId ? await loadChainSegments(parseInt(bookingId), prisma) : null
    const chainId = chain && chain.segments.length > 0 ? chain.headId : (bookingId ? parseInt(bookingId) : null)
    const isChain = !!chain && chain.segments.length > 1

    let segments = null
    if (isChain) {
      segments = chain.segments.map((s) => (s.booking.id === parseInt(bookingId)
        ? {
          booking: { ...s.booking, ...draft, id: s.booking.id },
          categoryId: room.categoryId,
          roomNumber: room.number,
          categoryName: room.category?.name ?? null,
        }
        : s))
      await loadSegmentRates(segments, prisma)
    }

    // Ручные строки: уже сохранённые (по счёту) + ещё не сохранённые из тела.
    // Именно они делают предпросмотр честным: база процентной скидки на сервере
    // включает ручные строки, и без них итог формы был бы больше сохранённого.
    const saved = chainId
      ? await prisma.bookingCharge.findMany({
        where: { bookingId: chainId, source: 'manual' },
        orderBy: { id: 'asc' },
      })
      : []

    // Прожитые ночи предыдущих отрезков не переоцениваем — берём их сохранённые
    // строки как есть (тот же приём «замороженных» ночей, что при пересборке).
    const frozenStay = isChain
      ? await prisma.bookingCharge.findMany({
        where: {
          bookingId: chainId, source: 'auto', kind: 'stay',
          date: { lt: segments[segments.length - 1].booking.checkIn },
        },
        orderBy: { id: 'asc' },
      })
      : []

    const manualList = [...saved, ...frozenStay, ...normalizePreviewManual(manualCharges)]

    // То же правило, что в пересборке (`segmentsToPrice`): если счёт цепочки
    // зафиксировал прежний итог строкой «Проживание · по прежнему расчёту»
    // (`pinLegacyTotal`, 107 старых броней — см. NOTES), она покрывает весь срок до
    // первого переезда, и ночи головы считать заново нельзя. Без этого предпросмотр
    // показывал их ПОВЕРХ зафиксированной суммы: 197 200 в форме против 157 200 в базе.
    const priced = isChain ? segmentsToPrice(segments, saved) : segments

    const rateCtx = await loadRateContext(
      { categoryId: room.categoryId, checkIn: draft.checkIn, checkOut: draft.checkOut },
      prisma,
    )

    const detailed = buildAutoChargesDetailed({
      booking: draft, ...rateCtx, bookingServices, manualCharges: manualList, segments: priced,
    })

    const asRow = (r, source) => ({
      kind: r.kind,
      label: r.label,
      quantity: r.quantity,
      unitPrice: r.unitPrice,
      amount: r.amount,
      date: r.date ? dateKey(r.date) : null,
      source,
    })
    // Порядок как в сохранённом счёте (`loadCharges`): по дате, строки без даты — в конце.
    // Ручные идут перед автоматическими: после пересборки у автоматических новые id.
    const rows = [
      // Замороженные ночи цепочки пришли из базы автоматическими — так их и показываем
      ...manualList.map(r => asRow(r, r.source === 'auto' ? 'auto' : 'manual')),
      ...detailed.rows.map(r => asRow(r, 'auto')),
    ]
      .map((row, i) => ({ row, i }))
      .sort((a, b) => {
        // Строки без даты (услуги, скидка) — в конец: то же, что NULLS LAST в базе
        const ad = a.row.date || '9999-99-99'
        const bd = b.row.date || '9999-99-99'
        return ad === bd ? a.i - b.i : (ad < bd ? -1 : 1)
      })
      .map(x => x.row)

    const total = sumCharges(rows)
    const pct = prepaymentPercent !== undefined && prepaymentPercent !== null
      ? Number(prepaymentPercent) || 0
      : (await previewPrepaymentPercent(bookingId))
    const prepaid = Math.round(total * (pct / 100))

    res.json({
      data: {
        rows,
        total,
        prepaid,
        nights: detailed.nights,
        missingPrices: detailed.missingPrices,
      },
    })
  } catch (err) {
    next(err)
  }
}

function intOr0(v) {
  const n = parseInt(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** Процент предоплаты, если форма его не прислала: у существующей брони — её, иначе 50 (как в create). */
async function previewPrepaymentPercent(bookingId) {
  if (!bookingId) return 50
  const b = await prisma.booking.findUnique({
    where: { id: parseInt(bookingId) },
    select: { prepaymentPercent: true },
  })
  return b?.prepaymentPercent ?? 50
}

/**
 * Ручные строки из тела предпросмотра — их ещё нет в базе, поэтому нормализуем здесь
 * по тем же правилам, что и при сохранении (`normalizeCharge`): скидка не может быть
 * плюсом, суммы — целые.
 */
function normalizePreviewManual(list) {
  if (!Array.isArray(list)) return []
  return list.slice(0, 100).map((raw) => {
    const kind = CHARGE_KINDS.includes(raw?.kind) ? raw.kind : 'extra'
    const quantity = raw?.quantity == null ? 1 : Number(raw.quantity) || 0
    const money = normalizeCharge(kind, quantity, Number(raw?.unitPrice) || 0)
    // Клиент может прислать посчитанный amount (так строка хранится в базе) —
    // тогда верим ему, но знак скидки всё равно приводим.
    const given = raw?.amount == null ? null : Math.round(Number(raw.amount))
    const amount = given !== null && Number.isFinite(given)
      ? (kind === 'discount' ? -Math.abs(given) : given)
      : money.amount
    return {
      kind,
      label: String(raw?.label || '').trim() || 'Ручная строка',
      quantity: money.quantity,
      unitPrice: money.unitPrice,
      amount,
      date: raw?.date ? toUTCDate(raw.date) : null,
    }
  })
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

/**
 * Общий ответ всех операций со строками: строки, их сумма и свежая бронь.
 * `accountId` — голова счёта: строки и итог всегда её, даже если операцию начали
 * из формы продолжения. Событие уходит по ВСЕМ отрезкам цепочки.
 */
async function respondWithCharges(accountId, res, { emit = true } = {}) {
  const [charges, booking] = await Promise.all([
    loadCharges(accountId),
    prisma.booking.findUnique({ where: { id: accountId }, select: BOOKING_SELECT }),
  ])
  if (emit && booking) {
    emitBookingEvent('booking:updated', { booking })
    await emitChainUpdated(accountId, [accountId])
  }
  res.json({
    data: charges,
    total: charges.reduce((s, c) => s + (c.amount || 0), 0),
    booking,
  })
}

/**
 * Бронь под правку начислений: у закрытой деньги править можно, отменённую по-прежнему
 * не пересобираем и не правим построчно.
 *
 * Исключение — ДОБАВЛЕНИЕ ручной строки (`allowClosed`): удержание или штраф за отмену
 * оформляется именно так (решение владельца 2026-09-08). Раньше записать его было
 * некуда — начисления отменённой брони заблокированы целиком (аудит D2-006).
 * Только администратор: это правка денег по закрытой сделке.
 */
async function loadBookingForCharges(id, next, { allowClosed = false, role = null } = {}) {
  const booking = await prisma.booking.findUnique({
    where: { id }, select: { id: true, status: true, accountBookingId: true },
  })
  if (!booking) { next(createError('Бронь не найдена', 404)); return null }
  // Продолжение своих строк не имеет — правим счёт головы. Но и статус смотрим
  // ЕГО: живущий гость в продолжении не должен упираться в «бронь закрыта»
  // только потому, что голова после переезда стала CHECKED_OUT.
  booking.accountId = booking.accountBookingId ?? booking.id
  if (booking.status === 'CANCELLED' && !allowClosed) {
    next(createError('Нельзя менять начисления отменённой брони', 400))
    return null
  }
  const closed = ['CANCELLED', 'CHECKED_OUT'].includes(booking.status)
  if (allowClosed && closed && !['SUPER_ADMIN', 'ADMIN'].includes(role)) {
    next(createError('Добавить строку к закрытой брони может только администратор', 403))
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
    // Строки цепочки лежат на голове: форма продолжения показывает тот же счёт
    const accountId = await resolveAccountId(id)
    if (accountId === null) return next(createError('Бронь не найдена', 404))
    await respondWithCharges(accountId, res, { emit: false })
  } catch (err) {
    next(err)
  }
}

// POST /api/bookings/:id/charges — ручная строка (обязательно с причиной)
async function addCharge(req, res, next) {
  try {
    const id = parseInt(req.params.id)
    // Ручная строка — единственная операция, разрешённая на отменённой брони:
    // штраф или удержание за отмену записывать больше некуда.
    const booking = await loadBookingForCharges(id, next, { allowClosed: true, role: req.admin?.role })
    if (!booking) return

    const { kind, label, quantity = 1, unitPrice = 0, date, reason } = req.body
    if (!CHARGE_KINDS.includes(kind)) return next(createError('Недопустимый вид начисления', 400))
    if (!reason || !String(reason).trim()) {
      return next(createError('Укажите причину — ручная строка без причины не сохраняется', 400))
    }

    const money = normalizeCharge(kind, quantity, unitPrice)
    if (!Number.isFinite(money.amount)) return next(createError('Некорректная сумма', 400))

    await prisma.$transaction(async (tx) => {
      // У брони без строк итог живёт кэшем `totalAmount`: не зафиксировав его строкой,
      // пересчёт ниже приравнял бы весь счёт к этой одной ручной строке.
      await pinLegacyTotal(booking.accountId, { client: tx, adminId: req.admin.id })
      await tx.bookingCharge.create({
        data: {
          bookingId: booking.accountId,
          kind,
          label: String(label).trim(),
          ...money,
          date: date ? toUTCDate(date) : null,
          source: 'manual',
          reason: String(reason).trim(),
          createdById: req.admin.id,
        },
      })
      await recalcBookingTotals(booking.accountId, { client: tx })
    })

    await respondWithCharges(booking.accountId, res)
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
    // Строка принадлежит СЧЁТУ, а не отрезку: из формы продолжения правят те же строки
    if (!existing || existing.bookingId !== booking.accountId) return next(createError('Строка начисления не найдена', 404))

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
      await recalcBookingTotals(booking.accountId, { client: tx })
    })

    await respondWithCharges(booking.accountId, res)
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
    // Строка принадлежит СЧЁТУ, а не отрезку: из формы продолжения правят те же строки
    if (!existing || existing.bookingId !== booking.accountId) return next(createError('Строка начисления не найдена', 404))

    await prisma.$transaction(async (tx) => {
      await tx.bookingCharge.delete({ where: { id: chargeId } })
      await recalcBookingTotals(booking.accountId, { client: tx })
    })

    await respondWithCharges(booking.accountId, res)
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

    // «Пересчитать» на любом отрезке пересобирает ВЕСЬ счёт: посчитать половину
    // цепочки по тарифу, а половину оставить прежней — это разные деньги на экране
    // и в базе. Заморозки нет: администратор нажал кнопку осознанно.
    await prisma.$transaction(async (tx) => {
      await rebuildChainCharges(booking.accountId, { adminId: req.admin.id, client: tx })
    })

    await respondWithCharges(booking.accountId, res)
  } catch (err) {
    next(err)
  }
}

// BOOKING_SELECT экспортируется для optimizeController — payload socket-событий должен быть единым
module.exports = {
  list, getOne, create, update, cancel, checkIn, checkOut, checkAvailability, move,
  updateActualTimes, preview,
  // Для settlementController: отмена и выезд в расчёте с гостем — ТЕ ЖЕ действия,
  // а не их копия (проверки статусов + применение внутри транзакции)
  cancelGuard, checkOutGuard, applyCancel, applyCheckOut, bookingDayUTC,
  listCharges, addCharge, updateCharge, removeCharge, rebuildCharges,
  BOOKING_SELECT,
  // Замок версии (D5-004): само правило — чистая функция в utils/bookingVersion.js,
  // здесь реэкспорт, чтобы его можно было проверять рядом с самим update.
  isStale,
}
