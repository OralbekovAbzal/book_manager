const logger = require('./logger')

/**
 * Местная зона отеля — для КАЛЕНДАРНЫХ дней, посчитанных от моментов времени
 * (`createdAt`, `paidAt`, `voidedAt`).
 *
 * Зачем отдельный модуль. Сервер всегда живёт в UTC (`server.js`, `TZ: 'UTC'`
 * в `electron/main.js`), поэтому `getFullYear()`/`getDate()` в процессе — это
 * UTC-календарь. Для отеля в UTC+5/+6 всё, что сделано с полуночи до пяти утра,
 * по такому календарю уезжает на вчера: бронь, заведённая 1 сентября в 01:20,
 * попадала в «Дату создания 31 августа», хотя соседняя колонка «Создана»
 * показывала местное «01.09 01:20». Отсюда — Intl с явной зоной.
 *
 * Чем это НЕ является:
 *  - не заменяет бизнес-дату (`utils/businessDate.js`): смена — это решение
 *    администратора, а не календарь. Деньги считаются по смене;
 *  - не трогает поля `@db.Date` (`checkIn`, `checkOut`, `businessDate`, `date`):
 *    они и так хранятся UTC-полуночью, и для них верен `reports/dateUtils.js`.
 *
 * Зона берётся из `HOTEL_TZ`, иначе из `BACKUP_TZ` (его Electron ставит равным
 * зоне хоста — см. `spawnServer`), иначе Алматы.
 */

const DEFAULT_TZ = 'Asia/Almaty'

// Про мусорную зону предупреждаем один раз на значение: `hotelTz()` зовётся
// на каждую строку отчёта, и без этого лог заполнился бы одной строкой.
const warned = new Set()

function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/**
 * Текущая зона отеля. Читает env при каждом вызове — так её можно подменить
 * в тестах и в консоли, не перезагружая модуль.
 */
function hotelTz() {
  const tz = process.env.HOTEL_TZ || process.env.BACKUP_TZ || DEFAULT_TZ
  if (isValidTimeZone(tz)) return tz
  if (!warned.has(tz)) {
    warned.add(tz)
    logger.warn(`hotelTz: unknown time zone "${tz}", falling back to UTC`)
  }
  return 'UTC'
}

// Кэш форматтеров: Intl.DateTimeFormat стоит дорого, а зон в проекте одна-две.
const dayFormatters = new Map()
const partFormatters = new Map()

function dayFormatter(tz) {
  let f = dayFormatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    })
    dayFormatters.set(tz, f)
  }
  return f
}

function partFormatter(tz) {
  let f = partFormatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    partFormatters.set(tz, f)
  }
  return f
}

function toDate(value) {
  if (value === null || value === undefined || value === '') return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Момент времени → 'YYYY-MM-DD' календарного дня в зоне отеля. */
function localDateISO(date, tz = hotelTz()) {
  const d = toDate(date)
  if (!d) return null
  // en-CA даёт ровно ISO-порядок «2026-09-02» — разбирать нечего.
  return dayFormatter(tz).format(d)
}

/** Смещение зоны в конкретный момент, в миллисекундах (восток — плюс). */
function offsetAt(ms, tz) {
  const parts = partFormatter(tz).formatToParts(new Date(ms))
  const p = {}
  for (const { type, value } of parts) p[type] = value
  const asUTC = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour), Number(p.minute), Number(p.second),
  )
  return asUTC - ms
}

/** 'YYYY-MM-DD' (или Date) → {y, mo, d} календарного дня. null на мусоре. */
function calendarParts(value, tz) {
  if (value === null || value === undefined || value === '') return null
  const src = value instanceof Date ? localDateISO(value, tz) : String(value)
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(src || '')
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  // Date.UTC сам «донормализует» 2026-13-45 в другой день — для отчёта это
  // молчаливо неверная дата, поэтому такое считаем мусором.
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  const utc = Date.UTC(y, mo - 1, d)
  if (Number.isNaN(utc) || new Date(utc).getUTCDate() !== d) return null
  return { y, mo, d, utc }
}

/**
 * 'YYYY-MM-DD' → Date момента, когда в зоне отеля наступила полночь этого дня.
 *
 * Смещение зависит от самого момента (переход на летнее время), поэтому берём
 * его дважды: первое приближение по UTC-полуночи, второе — уже по найденному
 * моменту. Второй проход и есть обработка края перевода часов.
 */
function localDayStartUTC(iso, tz = hotelTz()) {
  const p = calendarParts(iso, tz)
  if (!p) return null
  let t = p.utc - offsetAt(p.utc, tz)
  t = p.utc - offsetAt(t, tz)
  // Полуночный перевод часов (Чили, Куба): местной 00:00 в этот день не
  // существует, и второй проход даёт ещё 23:00 предыдущего дня. Двигаемся
  // вперёд по часу, пока момент не окажется внутри нужного календарного дня —
  // первый существующий момент суток и есть их начало (находка тестов волны 9).
  for (let i = 0; i < 3 && localDateISO(new Date(t), tz) < iso; i++) t += 3600000
  return new Date(t)
}

const DAY_MS = 86400000

/**
 * Полуоткрытый диапазон моментов для календарных дней [fromISO, toISO]
 * включительно по обоим концам: `{ gte, lt }` — прямо в `where` Prisma.
 * Открытый конец (null) просто не даёт своего ключа.
 */
function localDayRangeUTC(fromISO, toISO, tz = hotelTz()) {
  const out = {}
  const gte = localDayStartUTC(fromISO, tz)
  if (gte) out.gte = gte

  const to = calendarParts(toISO, tz)
  if (to) {
    // Верхняя граница — полночь СЛЕДУЮЩЕГО дня: день `to` входит целиком.
    // Следующий день берём по календарю (UTC-полночь + сутки), а не как
    // «начало дня + 24 часа»: в сутки с переводом часов их 23 или 25.
    const nextIso = new Date(to.utc + DAY_MS).toISOString().slice(0, 10)
    const lt = localDayStartUTC(nextIso, tz)
    if (lt) out.lt = lt
  }
  return out
}

/** Сегодняшний календарный день в зоне отеля, 'YYYY-MM-DD'. */
function todayLocalISO(tz = hotelTz(), now = new Date()) {
  return localDateISO(now, tz)
}

module.exports = { hotelTz, DEFAULT_TZ, localDateISO, localDayStartUTC, localDayRangeUTC, todayLocalISO }
