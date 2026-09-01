const { prisma } = require('./prisma')

const DAY = 86400000
const ACTIVE = ['CONFIRMED', 'CHECKED_IN']

// Небольшой кэш, чтобы не дёргать БД на каждую бронь/оптимизацию
let _cache = null
let _ts = 0
const TTL = 10000

/** Карта эффектов меток: { code: { bufferAfter, bufferBefore, pin } } */
async function getFlagEffectsMap() {
  if (_cache && Date.now() - _ts < TTL) return _cache
  const flags = await prisma.bookingFlag.findMany({ select: { code: true, effects: true } })
  const map = {}
  for (const f of flags) if (f.effects) map[f.code] = f.effects
  _cache = map
  _ts = Date.now()
  return map
}

function invalidateFlagCache() { _cache = null; _ts = 0 }

/** Сворачивает эффекты всех меток брони в буферы + признак pin + исключение буфера. */
function bookingBuffers(flagCodes, effMap) {
  let after = 0, before = 0, pin = false, exceptAfterFlag = null
  for (const c of flagCodes || []) {
    const e = effMap[c]
    if (!e) continue
    if (e.bufferAfter) after = Math.max(after, Number(e.bufferAfter) || 0)
    if (e.bufferBefore) before = Math.max(before, Number(e.bufferBefore) || 0)
    if (e.pin) pin = true
    if (e.bufferAfterExceptFlag) exceptAfterFlag = e.bufferAfterExceptFlag
  }
  return { after, before, pin, exceptAfterFlag }
}

/** Буфер «после» с учётом исключения: снимается, если у СЛЕДУЮЩЕЙ брони есть метка-исключение. */
function afterWithException(buf, laterFlagCodes) {
  if (buf.after && buf.exceptAfterFlag && (laterFlagCodes || []).includes(buf.exceptAfterFlag)) return 0
  return buf.after
}

/** Есть ли среди меток вообще какие-то буферы (чтобы не делать лишних проверок). */
function hasAnyBuffer(effMap) {
  return Object.values(effMap).some(e => (e.bufferAfter || 0) > 0 || (e.bufferBefore || 0) > 0)
}

/**
 * Ищет конфликт по буферу (turnaround) рядом с новой/изменяемой бронью.
 * Прямые пересечения проверяются отдельно (findOverlap) — здесь только зазоры.
 * @returns {object|null} { booking, required, gapDays } или null
 */
async function findBufferConflict({ roomId, checkIn, checkOut, flags = [], excludeBookingId = null }, effMap) {
  if (!hasAnyBuffer(effMap)) return null  // буферов нет — проверять нечего

  const newIn = new Date(checkIn).getTime()
  const newOut = new Date(checkOut).getTime()
  const newBuf = bookingBuffers(flags, effMap)

  const where = { roomId, status: { in: ACTIVE } }
  if (excludeBookingId) where.id = { not: excludeBookingId }

  const neighbors = await prisma.booking.findMany({
    where,
    select: { id: true, guestName: true, checkIn: true, checkOut: true, flags: true },
  })

  for (const e of neighbors) {
    const eIn = new Date(e.checkIn).getTime()
    const eOut = new Date(e.checkOut).getTime()
    if (newIn < eOut && eIn < newOut) continue // прямое пересечение — не наш случай

    const eBuf = bookingBuffers(e.flags, effMap)
    let gapDays, required
    if (eOut <= newIn) {                 // существующая раньше новой → буфер «после» у существующей
      gapDays = (newIn - eOut) / DAY
      required = Math.max(afterWithException(eBuf, flags), newBuf.before)
    } else {                             // новая раньше существующей → буфер «после» у новой
      gapDays = (eIn - newOut) / DAY
      required = Math.max(afterWithException(newBuf, e.flags), eBuf.before)
    }
    if (gapDays < required) return { booking: e, required, gapDays }
  }
  return null
}

module.exports = { getFlagEffectsMap, invalidateFlagCache, bookingBuffers, hasAnyBuffer, findBufferConflict }
