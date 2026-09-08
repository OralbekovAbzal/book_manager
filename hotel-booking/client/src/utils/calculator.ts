import { parseISO, addDays, format, differenceInCalendarDays } from 'date-fns'

/**
 * Здесь БОЛЬШЕ НЕ СЧИТАЮТ ДЕНЬГИ.
 *
 * До волны 5a модуль повторял правила генератора начислений
 * (`server/src/utils/charges.js`): цена ночи, база скидки, округление, предоплата.
 * Две копии одних правил разъезжались ровно там, где это дороже всего — на экране
 * формы одновременно висели 106 000 и 99 900, а в базу записывалось 94 900
 * (аудит D7-009, D5-002). Считать деньги дважды нельзя: побеждает не «правильная»
 * копия, а та, что записала.
 *
 * Теперь суммы приходят из `POST /api/bookings/preview` — того же кода, который
 * выполняет сохранение (`api/bookings.ts: previewBooking`). От калькулятора
 * осталась только арифметика ДАТ: сколько ночей и какие именно. Она нужна форме
 * для подписей и для диалога раннего выезда, к деньгам отношения не имеет.
 */

/** Список дат-ночей брони: [checkIn, checkOut). За день выезда не платят. */
export function nightsOf(checkIn: string, checkOut: string): string[] {
  if (!checkIn || !checkOut || checkOut <= checkIn) return []
  const n = differenceInCalendarDays(parseISO(checkOut), parseISO(checkIn))
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(format(addDays(parseISO(checkIn), i), 'yyyy-MM-dd'))
  return out
}

/** Сколько ночей между двумя датами 'YYYY-MM-DD'. Отрицательных не бывает. */
export function nightsBetween(from: string, to: string): number {
  if (!from || !to || to <= from) return 0
  return differenceInCalendarDays(parseISO(to), parseISO(from))
}
