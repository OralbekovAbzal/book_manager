import { differenceInCalendarDays, parseISO, addDays, format } from 'date-fns'
import { STATUS_COLORS, DAY_WIDTH, BLOCK_PADDING } from './constants'
import type { GridBooking } from '../../types'

/** Возвращает имя CSS-переменной для цвета статуса (для theme-aware блоков) */
export function getBookingStatusVar(booking: GridBooking): string {
  if (booking.source === 'ремонт') return '--status-maintenance'

  switch (booking.status) {
    case 'CONFIRMED':   return '--status-confirmed'
    case 'CHECKED_IN':  return '--status-checked-in'
    case 'CHECKED_OUT': return '--status-checked-out'
    case 'NO_SHOW':     return '--status-no-show'
    case 'CANCELLED':   return '--status-no-show'
    default:            return '--status-confirmed'
  }
}

/** Совместимость со старым кодом — возвращает hex-цвет статуса */
export function getBookingColor(booking: GridBooking, _today: string): string {
  if (booking.source === 'ремонт') return STATUS_COLORS.maintenance

  switch (booking.status) {
    case 'CONFIRMED':   return STATUS_COLORS.confirmed
    case 'CHECKED_IN':  return STATUS_COLORS.checkedIn
    case 'CHECKED_OUT': return STATUS_COLORS.checkedOut
    case 'NO_SHOW':     return STATUS_COLORS.noShow
    case 'CANCELLED':   return STATUS_COLORS.noShow
    default:            return STATUS_COLORS.confirmed
  }
}

export function getBookingLabel(booking: GridBooking): string {
  if (booking.source === 'ремонт') return `Ремонт · ${booking.guestName}`
  return booking.guestName
}

/** Позиция и ширина блока относительно начала видимого диапазона.
 *  isPoint = true когда заехал и выехал в один и тот же день (duration = 0):
 *  рендерится как компактный маркер по центру дня. */
export function getBlockGeometry(
  booking: GridBooking,
  dateFrom: string,
  dayWidth = DAY_WIDTH,
  blockPadding = BLOCK_PADDING,
): { left: number; width: number; visible: boolean; isPoint: boolean } {
  const fromDate = parseISO(dateFrom)
  const checkIn  = parseISO(booking.checkIn.slice(0, 10))
  const checkOut = parseISO(booking.checkOut.slice(0, 10))

  const startOffset = differenceInCalendarDays(checkIn, fromDate)
  const duration    = differenceInCalendarDays(checkOut, checkIn)

  // Same-day stay: маленький маркер по центру дня
  if (duration === 0) {
    const pointWidth = Math.min(dayWidth * 0.55, 26)
    const left = startOffset * dayWidth + (dayWidth - pointWidth) / 2
    return { left, width: pointWidth, visible: true, isPoint: true }
  }

  const left  = startOffset * dayWidth + dayWidth / 2
  const width = duration * dayWidth - blockPadding * 2

  return { left, width, visible: width > 0, isPoint: false }
}

/**
 * Дата по x-позиции клика внутри зоны дат — поклеточно: вся ширина колонки дня N
 * относится к дню N (совпадает с заголовком колонки). Используется и для курсора,
 * и для выделения дат под новую бронь — в отличие от рендера уже существующих
 * броней (`getBlockGeometry`), который намеренно рисует блок со сдвигом на полдня
 * (чтобы выезд и заезд в один день стыковались в одной колонке, не наезжая друг на
 * друга). Поэтому созданная бронь визуально «сядет» на полдня позже того, что было
 * подсвечено при протягивании — так же, как выглядят все остальные брони в сетке.
 */
export function dateFromX(x: number, dateFrom: string, dayWidth = DAY_WIDTH): string {
  const dayOffset = Math.floor(x / dayWidth)
  return format(addDays(parseISO(dateFrom), dayOffset), 'yyyy-MM-dd')
}
