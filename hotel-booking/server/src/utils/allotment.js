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

/**
 * Ищет квоту другого партнёра, мешающую этой брони.
 *
 * @returns {Promise<{partnerName: string, dateFrom: Date, dateTo: Date}|null>}
 */
async function findAllotmentConflict({ roomId, checkIn, checkOut, partnerId }) {
  const from = toUTC(checkIn)
  const to = toUTC(checkOut)
  if (!(to > from)) return null

  const allotments = await prisma.allotment.findMany({
    where: { roomId: parseInt(roomId), dateFrom: { lt: to }, dateTo: { gt: from } },
    include: {
      partner: { select: { id: true, name: true } },
      releases: true,
    },
  })

  for (const a of allotments) {
    // Бронь самого партнёра в его же квоту — это и есть её назначение.
    if (partnerId && a.partnerId === parseInt(partnerId)) continue

    const overlapFrom = Math.max(toUTC(a.dateFrom).getTime(), from.getTime())
    const overlapTo = Math.min(toUTC(a.dateTo).getTime(), to.getTime())
    if (!(overlapTo > overlapFrom)) continue

    // Если КАЖДЫЙ день пересечения освобождён релизом — квота не мешает.
    const released = releasedDays(a)
    let blocked = false
    for (let t = overlapFrom; t < overlapTo; t += DAY) {
      if (!released.has(t)) { blocked = true; break }
    }
    if (!blocked) continue

    return {
      partnerName: a.partner?.name ?? 'партнёр',
      dateFrom: a.dateFrom,
      dateTo: a.dateTo,
    }
  }
  return null
}

/** Текст ошибки для 409. */
function allotmentConflictMessage(hit) {
  const fmt = (d) => new Date(d).toLocaleDateString('ru-RU', { timeZone: 'UTC' })
  return `Номер выделен партнёру «${hit.partnerName}» на ${fmt(hit.dateFrom)} — ${fmt(hit.dateTo)}. ` +
    'Освободите период релизом или подтвердите бронирование поверх квоты.'
}

module.exports = { findAllotmentConflict, allotmentConflictMessage }
