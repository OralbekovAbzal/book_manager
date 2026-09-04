const { prisma } = require('./prisma')

const DAY = 86400000

/**
 * Защита квот партнёров.
 *
 * До этого аллотменты были чисто декоративными: они рисовались в сетке, но
 * `bookingController` о них не знал вообще, и прямая бронь в номер, отданный
 * партнёру, создавалась молча. Партнёр приезжал — номер занят.
 *
 * Даты полуоткрытые, как у броней: пересечение это `from < to && to > from`.
 * Релиз временно возвращает часть периода в свободную продажу, поэтому дни,
 * покрытые релизами, конфликтом не считаются.
 */

/** 'YYYY-MM-DD' или Date → UTC-полночь. */
function toUTC(d) {
  const x = new Date(d)
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()))
}

/** Множество дат (в мс), покрытых релизами аллокации. */
function releasedDays(allotment) {
  const set = new Set()
  for (const r of allotment.releases || []) {
    const from = toUTC(r.dateFrom).getTime()
    const to = toUTC(r.dateTo).getTime()
    for (let t = from; t < to; t += DAY) set.add(t)
  }
  return set
}

/** Мешает ли конкретная квота брони в этот период (с учётом релизов). */
function quotaBlocks(a, from, to, partnerId) {
  // Бронь самого партнёра в его же квоту — это и есть её назначение.
  if (partnerId && a.partnerId === parseInt(partnerId)) return false

  const overlapFrom = Math.max(toUTC(a.dateFrom).getTime(), from.getTime())
  const overlapTo = Math.min(toUTC(a.dateTo).getTime(), to.getTime())
  if (!(overlapTo > overlapFrom)) return false

  // Если КАЖДЫЙ день пересечения освобождён релизом — квота не мешает.
  const released = releasedDays(a)
  for (let t = overlapFrom; t < overlapTo; t += DAY) {
    if (!released.has(t)) return true
  }
  return false
}

/**
 * Ищет квоты, мешающие брони, сразу по нескольким номерам — ОДНИМ запросом.
 * Нужно подбору номеров (utils/availability.js): там номеров сотни, и запрос
 * на каждый превратил бы экран подбора в сотню обращений к базе.
 *
 * @returns {Promise<Map<number, {partnerName: string, dateFrom: Date, dateTo: Date}>>}
 */
async function findAllotmentConflictsBulk({ roomIds, checkIn, checkOut, partnerId }) {
  const hits = new Map()
  const from = toUTC(checkIn)
  const to = toUTC(checkOut)
  const ids = (roomIds || []).map((r) => parseInt(r))
  if (!(to > from) || !ids.length) return hits

  const allotments = await prisma.allotment.findMany({
    where: { roomId: { in: ids }, dateFrom: { lt: to }, dateTo: { gt: from } },
    include: {
      partner: { select: { id: true, name: true } },
      releases: true,
    },
  })

  for (const a of allotments) {
    if (hits.has(a.roomId)) continue
    if (!quotaBlocks(a, from, to, partnerId)) continue
    hits.set(a.roomId, {
      partnerName: a.partner?.name ?? 'партнёр',
      dateFrom: a.dateFrom,
      dateTo: a.dateTo,
    })
  }
  return hits
}

/**
 * Ищет квоту другого партнёра, мешающую этой брони.
 *
 * @returns {Promise<{partnerName: string, dateFrom: Date, dateTo: Date}|null>}
 */
async function findAllotmentConflict({ roomId, checkIn, checkOut, partnerId }) {
  const hits = await findAllotmentConflictsBulk({ roomIds: [roomId], checkIn, checkOut, partnerId })
  return hits.get(parseInt(roomId)) ?? null
}

/** Текст ошибки для 409. */
function allotmentConflictMessage(hit) {
  const fmt = (d) => new Date(d).toLocaleDateString('ru-RU', { timeZone: 'UTC' })
  return `Номер выделен партнёру «${hit.partnerName}» на ${fmt(hit.dateFrom)} — ${fmt(hit.dateTo)}. ` +
    'Освободите период релизом или подтвердите бронирование поверх квоты.'
}

module.exports = { findAllotmentConflict, findAllotmentConflictsBulk, allotmentConflictMessage }
