const { prisma } = require('./prisma')
const { getFlagEffectsMap, maxBufferDays, bufferConflictAmong } = require('./flagEffects')
const { findAllotmentConflictsBulk, allotmentConflictMessage } = require('./allotment')

const DAY = 86400000
const ACTIVE = ['CONFIRMED', 'CHECKED_IN']

/**
 * ЕДИНОЕ определение «номер свободен» для экранов подбора.
 *
 * Раньше «свободно» считалось тремя разными способами: `roomController.availability`
 * и `occupancyController.roomAvailability` смотрели только на прямые пересечения,
 * а `bookingController.create` — ещё и на буферы меток, и на квоты партнёров.
 * Из-за этого подбор красил номер зелёным, а сохранение возвращало 409.
 *
 * Здесь повторены ровно те же три проверки и в том же порядке, что в create:
 *   1) прямое пересечение (даты полуоткрытые: выезд в день заезда — не пересечение);
 *   2) буфер меток (turnaround) у соседей и у самой брони;
 *   3) квота партнёра (не жёсткий запрет — при создании снимается подтверждением
 *      allowAllotmentOverride, но показывать такой номер «свободным» нельзя).
 *
 * ВАЖНО: `bookingController` пока зовёт свои проверки напрямую (он у другого
 * агента) — это копия его логики, а не общий вызов. Следующий шаг — перевести
 * create/update/move на эту утилиту, иначе две реализации снова разъедутся.
 *
 * Дешевизна: на весь список номеров ровно ДВА запроса — брони (одним окном по
 * датам) и квоты. Раньше проверка буфера читала все активные брони номера,
 * то есть на подборе это был бы запрос на номер и без окна по датам.
 */

/** Дата → UTC-полночь (в базе `@db.Date` лежит так же). */
function toUTC(value) {
  const x = new Date(value)
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()))
}

/**
 * @param {object} p
 * @param {number[]} p.roomIds        номера, которые проверяем
 * @param {string|Date} p.checkIn
 * @param {string|Date} p.checkOut
 * @param {number|null} [p.excludeBookingId] редактируемая бронь — сама себе не мешает
 * @param {string[]} [p.flags]        метки БУДУЩЕЙ брони (нужны для буферов и исключений)
 * @param {number|null} [p.partnerId] бронь партнёра в его же квоту конфликтом не считается
 * @returns {Promise<Map<number, {available: boolean, reason: string|null, conflict: object|null, message: string|null}>>}
 */
async function checkRoomsAvailability({
  roomIds, checkIn, checkOut, excludeBookingId = null, flags = [], partnerId = null,
}) {
  const from = toUTC(checkIn)
  const to = toUTC(checkOut)
  const ids = [...new Set((roomIds || []).map((r) => parseInt(r)).filter(Number.isInteger))]

  const result = new Map()
  const free = () => ({ available: true, reason: null, conflict: null, message: null })
  for (const id of ids) result.set(id, free())
  if (!ids.length || !(to > from)) return result

  const effMap = await getFlagEffectsMap()
  const maxBuf = maxBufferDays(effMap)

  // Одним запросом — и пересечения, и соседи для буферов. Окно шире периода
  // ровно на самый длинный буфер словаря: дальше конфликтовать нечему.
  const where = {
    roomId: { in: ids },
    status: { in: ACTIVE },
    checkIn: { lt: new Date(to.getTime() + maxBuf * DAY) },
    checkOut: { gt: new Date(from.getTime() - maxBuf * DAY) },
  }
  if (excludeBookingId) where.id = { not: parseInt(excludeBookingId) }

  const neighbors = await prisma.booking.findMany({
    where,
    select: { id: true, roomId: true, guestName: true, checkIn: true, checkOut: true, flags: true },
  })

  const byRoom = new Map()
  for (const b of neighbors) {
    if (!byRoom.has(b.roomId)) byRoom.set(b.roomId, [])
    byRoom.get(b.roomId).push(b)
  }

  for (const [roomId, list] of byRoom.entries()) {
    // 1. Прямое пересечение
    const overlap = list.find((b) => new Date(b.checkIn) < to && new Date(b.checkOut) > from)
    if (overlap) {
      result.set(roomId, {
        available: false,
        reason: 'overlap',
        conflict: { bookingId: overlap.id, guestName: overlap.guestName, checkIn: overlap.checkIn, checkOut: overlap.checkOut },
        message: 'Номер занят на выбранные даты',
      })
      continue
    }

    // 2. Буфер меток (turnaround)
    if (!maxBuf) continue
    const buf = bufferConflictAmong(list, { checkIn: from, checkOut: to, flags }, effMap)
    if (buf) {
      result.set(roomId, {
        available: false,
        reason: 'buffer',
        conflict: { bookingId: buf.booking.id, guestName: buf.booking.guestName, checkIn: buf.booking.checkIn, checkOut: buf.booking.checkOut },
        message: `Нужен зазор минимум ${buf.required} дн. рядом с бронью «${buf.booking.guestName}» (метка с буфером)`,
      })
    }
  }

  // 3. Квоты партнёров — только для тех номеров, что ещё считаются свободными
  const stillFree = ids.filter((id) => result.get(id).available)
  if (stillFree.length) {
    const quota = await findAllotmentConflictsBulk({ roomIds: stillFree, checkIn: from, checkOut: to, partnerId })
    for (const [roomId, hit] of quota.entries()) {
      result.set(roomId, {
        available: false,
        reason: 'allotment',
        conflict: { partnerName: hit.partnerName, dateFrom: hit.dateFrom, dateTo: hit.dateTo },
        message: allotmentConflictMessage(hit),
      })
    }
  }

  return result
}

/** 'a,b' | ['a','b'] → ['a','b'] — метки приходят из query-строки. */
function parseFlags(raw) {
  if (Array.isArray(raw)) return raw.map(String)
  if (typeof raw === 'string' && raw.trim()) return raw.split(',').map((s) => s.trim()).filter(Boolean)
  return []
}

module.exports = { checkRoomsAvailability, parseFlags }
