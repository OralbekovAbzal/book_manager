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

/**
 * Сворачивает эффекты всех меток брони в буферы + признак pin.
 *
 * Буфер «после» НЕЛЬЗЯ сворачивать в одно число вместе с исключением:
 * исключение (`bufferAfterExceptFlag`) принадлежит СВОЕЙ метке, а не брони целиком.
 * Раньше здесь копился один общий `exceptAfterFlag` от любой метки, у которой он есть,
 * и снимал ОБЩИЙ максимум буфера: «генеральная уборка» с зазором в двое суток
 * обнулялась меткой «заезд после 17:00», к уборке отношения не имеющей.
 * Поэтому храним СПИСОК правил `afterRules: [{ days, exceptFlag }]` — по одному
 * на каждую метку с буфером, — а максимум считаем уже с учётом меток соседа
 * (см. afterWithException). `after` остаётся «сырым» максимумом для тех мест,
 * где нужен буфер без оглядки на соседа (метрики, показ требуемого зазора).
 */
function bookingBuffers(flagCodes, effMap) {
  let after = 0, before = 0, pin = false
  const afterRules = []
  for (const c of flagCodes || []) {
    const e = effMap[c]
    if (!e) continue
    const days = Number(e.bufferAfter) || 0
    if (days > 0) {
      after = Math.max(after, days)
      afterRules.push({ days, exceptFlag: e.bufferAfterExceptFlag || null })
    }
    if (e.bufferBefore) before = Math.max(before, Number(e.bufferBefore) || 0)
    if (e.pin) pin = true
  }
  return { after, before, pin, afterRules }
}

/**
 * Буфер «после» с учётом исключений: у каждой метки своё правило, снимается
 * только то, чей `exceptFlag` есть у СЛЕДУЮЩЕЙ брони. Из оставшихся берём максимум.
 */
function afterWithException(buf, laterFlagCodes) {
  const rules = buf?.afterRules
  // Свёртки без списка правил (упрощённые объекты в вызывающем коде) — как раньше
  if (!Array.isArray(rules)) return buf?.after || 0
  const later = laterFlagCodes || []
  let max = 0
  for (const r of rules) {
    if (r.exceptFlag && later.includes(r.exceptFlag)) continue
    if (r.days > max) max = r.days
  }
  return max
}

/** Самый длинный буфер во всём словаре эффектов — ширина окна поиска соседей. */
function maxBufferDays(effMap) {
  let max = 0
  for (const e of Object.values(effMap || {})) {
    max = Math.max(max, Number(e.bufferAfter) || 0, Number(e.bufferBefore) || 0)
  }
  return max
}

/** Есть ли среди меток вообще какие-то буферы (чтобы не делать лишних проверок). */
function hasAnyBuffer(effMap) {
  return maxBufferDays(effMap) > 0
}

/**
 * Ищет конфликт по буферу среди УЖЕ ПРОЧИТАННЫХ соседей (чистая функция).
 * Отдельно от findBufferConflict, потому что подбор номеров (utils/availability.js)
 * читает соседей по всем номерам одним запросом и переиспользует эту логику.
 * @returns {object|null} { booking, required, gapDays } или null
 */
function bufferConflictAmong(neighbors, { checkIn, checkOut, flags = [] }, effMap) {
  const newIn = new Date(checkIn).getTime()
  const newOut = new Date(checkOut).getTime()
  const newBuf = bookingBuffers(flags, effMap)

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

/**
 * Ищет конфликт по буферу (turnaround) рядом с новой/изменяемой бронью.
 * Прямые пересечения проверяются отдельно (findOverlap) — здесь только зазоры.
 * @returns {object|null} { booking, required, gapDays } или null
 */
async function findBufferConflict({ roomId, checkIn, checkOut, flags = [], excludeBookingId = null }, effMap) {
  const maxBuf = maxBufferDays(effMap)
  if (!maxBuf) return null  // буферов нет — проверять нечего

  const newIn = new Date(checkIn).getTime()
  const newOut = new Date(checkOut).getTime()

  const where = { roomId, status: { in: ACTIVE } }
  if (excludeBookingId) where.id = { not: excludeBookingId }
  // Окно по датам: буфер шире самого длинного в словаре быть не может, поэтому
  // соседи за его пределами конфликтовать не способны. Без окна читались ВСЕ
  // активные брони номера — лишнее чтение на каждое создание/правку брони и,
  // тем более, на подбор по всем номерам сразу.
  // Границы строгие: ровно maxBuf дней зазора — это уже достаточный зазор.
  where.checkOut = { gt: new Date(newIn - maxBuf * DAY) }
  where.checkIn = { lt: new Date(newOut + maxBuf * DAY) }

  const neighbors = await prisma.booking.findMany({
    where,
    select: { id: true, guestName: true, checkIn: true, checkOut: true, flags: true },
  })

  return bufferConflictAmong(neighbors, { checkIn, checkOut, flags }, effMap)
}

module.exports = {
  getFlagEffectsMap, invalidateFlagCache, bookingBuffers, afterWithException,
  maxBufferDays, hasAnyBuffer, bufferConflictAmong, findBufferConflict,
}
