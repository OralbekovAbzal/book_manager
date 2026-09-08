const { hotelTz, localDateISO, localDayStartUTC } = require('./hotelTz')

/**
 * Нижняя граница периода окна «Аудит» по МЕСТНЫМ суткам отеля.
 *
 * Было `new Date(now.getFullYear(), now.getMonth(), now.getDate())` — календарь
 * процесса. В упаковке сервер стартует с `TZ=UTC`, поэтому с полуночи до пяти утра
 * по Алматы «Сегодня» показывало вчерашний день, а «Месяц» первого числа —
 * прошлый месяц (аудит D6-003).
 *
 * Границы по `createdAt` — это моменты времени, поэтому возвращаем Date, а не дату.
 * `to` у окна нет: верхняя граница всегда «сейчас».
 *
 * @param {string} period 'today' | 'week' | 'month' (иначе — без границы)
 * @param {Date}   now    момент отсчёта
 * @param {string} tz     зона отеля
 * @returns {{ from: Date|null }}
 */
function auditPeriodRange(period, now = new Date(), tz = hotelTz()) {
  const todayISO = localDateISO(now, tz)
  const [y, m, d] = todayISO.split('-').map(Number)

  if (period === 'today') {
    return { from: localDayStartUTC(todayISO, tz) }
  }
  if (period === 'week') {
    // «7 дней» на экране — это семь МЕСТНЫХ суток вместе с сегодняшними, а не
    // 168 часов назад: иначе утренняя бронь недельной давности то попадала в
    // период, то нет, в зависимости от часа открытия окна.
    const from = new Date(Date.UTC(y, m - 1, d - 6)).toISOString().slice(0, 10)
    return { from: localDayStartUTC(from, tz) }
  }
  if (period === 'month') {
    return { from: localDayStartUTC(`${todayISO.slice(0, 7)}-01`, tz) }
  }
  return { from: null }
}

module.exports = { auditPeriodRange }
