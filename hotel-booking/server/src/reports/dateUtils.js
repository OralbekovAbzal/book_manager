/**
 * Даты отчётов. Всё считаем в UTC-полночь: Prisma отдаёт @db.Date именно так,
 * а сравнение «в лоб» с локальной датой уехало бы на часовой пояс.
 *
 * Это модуль КАЛЕНДАРНЫХ полей — `checkIn`, `checkOut`, `businessDate`, `date`.
 * Для МОМЕНТОВ времени (`createdAt`, `paidAt`, `voidedAt`) он не годится:
 * UTC-день момента для отеля в UTC+5/+6 — это вчерашний день с полуночи до
 * пяти утра. Календарный день от момента — `utils/hotelTz.js` (`localDateISO`,
 * `localDayRangeUTC`).
 */

/** 'YYYY-MM-DD' | Date → Date (UTC-полночь). Возвращает null на мусоре. */
function toUTCDate(value) {
  if (!value) return null
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()))
  }
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return null
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return Number.isNaN(d.getTime()) ? null : d
}

/** Date → 'YYYY-MM-DD' */
function isoDate(date) {
  if (!date) return null
  const d = toUTCDate(date)
  return d ? d.toISOString().slice(0, 10) : null
}

/** Date → 'YYYY-MM' */
function isoMonth(date) {
  const s = isoDate(date)
  return s ? s.slice(0, 7) : null
}

const DAY = 86400000

/** Число суток между датами (to - from), без учёта времени. */
function daysBetween(from, to) {
  const a = toUTCDate(from)
  const b = toUTCDate(to)
  if (!a || !b) return 0
  return Math.round((b.getTime() - a.getTime()) / DAY)
}

/** Итератор ночей [from, to): последняя ночь — за день до выезда. */
function eachNight(from, to, fn) {
  const a = toUTCDate(from)
  const b = toUTCDate(to)
  if (!a || !b) return
  for (let t = a.getTime(); t < b.getTime(); t += DAY) fn(new Date(t))
}

const WEEKDAYS = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота']

function weekdayName(date) {
  const d = toUTCDate(date)
  return d ? WEEKDAYS[d.getUTCDay()] : null
}

module.exports = { toUTCDate, isoDate, isoMonth, daysBetween, eachNight, weekdayName, DAY }
