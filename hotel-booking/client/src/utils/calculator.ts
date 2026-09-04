import { parseISO, addDays, format, differenceInCalendarDays } from 'date-fns'
import type { PricingBase, RatePrice, Service } from '../types'

/**
 * Расчёт стоимости брони.
 *
 * Источник цены — календарь `RatePrice` (одна цена на КАЖДУЮ дату), а не «сезоны»
 * из localStorage. Никакого запасного периода больше нет: если на ночь цены нет,
 * это дырка в тарифе, и её видно, а не ноль в итоге.
 *
 * Это ПРЕДПРОСМОТР. Источник истины по деньгам — строки `BookingCharge` на сервере
 * (`server/src/utils/charges.js`), которые генерируются по тем же правилам.
 * Правя правила здесь, правь и там — иначе предпросмотр разойдётся с тем,
 * что запишется в бронь при сохранении.
 */

export interface CalcInput {
  checkIn: string   // YYYY-MM-DD
  checkOut: string  // YYYY-MM-DD
  categoryId: number
  categoryName: string
  adultsWithMeals: number
  childrenWithMeals: number
  adultsNoMeals: number
  childrenNoMeals: number
  extraBedsWithMeals: number
  extraBedsNoMeals: number
  disabledAdults: number
  disabledChildren: number
  discountPercent: number
  prepaymentPercent: number
}

/** Цены и услуги, по которым считаем. Приходят с сервера, а не из localStorage. */
export interface RateContext {
  pricingBase: PricingBase
  /** 'YYYY-MM-DD' → цена этой даты для выбранной категории */
  ratesByDate: Record<string, RatePrice>
  /** Услуги, начисляемые автоматически (includedByDefault) */
  services: Service[]
}

export interface BreakdownLine {
  label: string
  nights: number
  amount: number
  /** 'stay' — проживание, 'meal'/'extra' — услуги */
  kind: 'stay' | 'meal' | 'extra'
  /** Для услуг: сколько единиц и по какой цене (в названии их больше нет) */
  quantity?: number
  unitPrice?: number
}

/** Одна ночь проживания — то, из чего потом складываются строки начислений. */
export interface NightLine {
  date: string
  amount: number
  /** На эту ночь цены нет (нет строки календаря или пусты нужные поля) */
  missing: boolean
}

export interface CalcResult {
  nights: number
  /** Проживание + услуги, до скидки */
  total: number
  totalAfterDiscount: number
  prepaidAmount: number
  remaining: number
  breakdown: BreakdownLine[]
  nightLines: NightLine[]
  /** Ни на одну ночь нет цены — итог не рассчитан (0 — это не цена, а отсутствие тарифа) */
  noRates: boolean
  /** Ночи, для которых цена не задана целиком или частично */
  missingNights: number
  missingDates: string[]
}

export const EMPTY_RATE_CONTEXT: RateContext = {
  pricingBase: 'person',
  ratesByDate: {},
  services: [],
}

/**
 * Ключ входов калькулятора: если он не изменился с момента загрузки брони,
 * итог при сохранении не пересчитываем. Иначе правка заметки молча переоценила бы
 * бронь по текущему тарифу (раньше — по чужому localStorage, теперь — по календарю,
 * который мог измениться уже после заезда гостя).
 */
export function buildCalcKey(input: CalcInput): string {
  return [
    input.checkIn, input.checkOut, input.categoryId,
    input.adultsWithMeals, input.childrenWithMeals, input.adultsNoMeals, input.childrenNoMeals,
    input.extraBedsWithMeals, input.extraBedsNoMeals, input.disabledAdults, input.disabledChildren,
    input.discountPercent, input.prepaymentPercent,
  ].join('|')
}

/** Список дат-ночей брони: [checkIn, checkOut). */
export function nightsOf(checkIn: string, checkOut: string): string[] {
  if (!checkIn || !checkOut || checkOut <= checkIn) return []
  const n = differenceInCalendarDays(parseISO(checkOut), parseISO(checkIn))
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(format(addDays(parseISO(checkIn), i), 'yyyy-MM-dd'))
  return out
}

/** Цена одной ночи. missing — нужное поле цены не заполнено (в итог войдёт неполная сумма). */
function priceNight(
  rate: RatePrice | undefined,
  base: PricingBase,
  counts: { adults: number; children: number; extraBeds: number },
): { amount: number; missing: boolean } {
  if (!rate) return { amount: 0, missing: true }

  let amount = 0
  let missing = false

  const take = (value: number | null | undefined, qty: number) => {
    if (qty <= 0) return
    if (value == null) { missing = true; return }
    amount += value * qty
  }

  if (base === 'room') {
    // Цена за номер целиком: гости на неё не влияют, доп. места — влияют.
    if (rate.roomPrice == null) missing = true
    else amount += rate.roomPrice
    take(rate.extraBedPrice, counts.extraBeds)
  } else {
    take(rate.adultPrice, counts.adults)
    take(rate.childPrice, counts.children)
    take(rate.extraBedPrice, counts.extraBeds)
  }

  return { amount, missing }
}

/** Начисления по услугам — те же правила, что и в server/src/utils/charges.js. */
export function serviceLines(
  input: CalcInput,
  services: Service[],
  nights: number,
): BreakdownLine[] {
  if (nights <= 0) return []

  // Питание считаем по тем, кто «с питанием»; прочие услуги — по всем гостям.
  const mealAdults = input.adultsWithMeals + input.extraBedsWithMeals
  const mealChildren = input.childrenWithMeals
  const allAdults = input.adultsWithMeals + input.adultsNoMeals
    + input.extraBedsWithMeals + input.extraBedsNoMeals
  const allChildren = input.childrenWithMeals + input.childrenNoMeals

  const lines: BreakdownLine[] = []

  for (const s of services) {
    if (!s.isActive) continue
    const kind: 'meal' | 'extra' = s.kind === 'meal' ? 'meal' : 'extra'
    const adults = kind === 'meal' ? mealAdults : allAdults
    const children = kind === 'meal' ? mealChildren : allChildren
    // childPrice = null означает «считать по взрослой цене» — детей вливаем во взрослую строку
    const splitChildren = s.childPrice != null && children > 0
    const adultHeads = splitChildren ? adults : adults + children

    const push = (label: string, qty: number, unit: number) => {
      if (qty <= 0 || unit <= 0) return
      lines.push({ label, nights, amount: Math.round(qty * unit), kind, quantity: qty, unitPrice: unit })
    }

    // Названия — как у генератора начислений: короткие и стабильные
    const childLabel = `${s.name} (дети)`
    switch (s.unit) {
      case 'per_person_night':
        push(s.name, adultHeads * nights, s.price)
        if (splitChildren) push(childLabel, children * nights, s.childPrice!)
        break
      case 'per_night':
        push(s.name, nights, s.price)
        break
      case 'per_person':
        push(s.name, adultHeads, s.price)
        if (splitChildren) push(childLabel, children, s.childPrice!)
        break
      case 'per_booking':
      default:
        push(s.name, 1, s.price)
        break
    }
  }

  return lines
}

export function calculate(input: CalcInput, ctx: RateContext): CalcResult {
  const dates = nightsOf(input.checkIn, input.checkOut)
  const nights = dates.length

  if (nights === 0) {
    return {
      nights: 0, total: 0, totalAfterDiscount: 0, prepaidAmount: 0, remaining: 0,
      breakdown: [], nightLines: [], noRates: false, missingNights: 0, missingDates: [],
    }
  }

  const counts = {
    adults: input.adultsWithMeals + input.adultsNoMeals,
    children: input.childrenWithMeals + input.childrenNoMeals,
    extraBeds: input.extraBedsWithMeals + input.extraBedsNoMeals,
  }
  const hasGuests = counts.adults + counts.children + counts.extraBeds > 0

  const nightLines: NightLine[] = []
  const missingDates: string[] = []
  let stayTotal = 0
  let pricedNights = 0

  for (const date of dates) {
    const { amount, missing } = priceNight(ctx.ratesByDate[date], ctx.pricingBase, counts)
    nightLines.push({ date, amount: Math.round(amount), missing })
    stayTotal += Math.round(amount)
    if (missing) missingDates.push(date)
    else pricedNights++
  }

  const breakdown: BreakdownLine[] = []
  if (stayTotal !== 0) {
    breakdown.push({
      label: ctx.pricingBase === 'room' ? 'Проживание (за номер)' : 'Проживание',
      nights: pricedNights || nights,
      amount: stayTotal,
      kind: 'stay',
    })
  }
  const svc = serviceLines(input, ctx.services, nights)
  breakdown.push(...svc)

  const total = stayTotal + svc.reduce((s, l) => s + l.amount, 0)
  // Скидка округляется отдельной строкой — так же, как её пишет генератор начислений
  // (server/src/utils/charges.js). Иначе предпросмотр расходился бы с итогом на тенге.
  const discount = input.discountPercent > 0 ? Math.round(total * input.discountPercent / 100) : 0
  const totalAfterDiscount = total - discount
  const prepaidAmount = Math.round(totalAfterDiscount * (input.prepaymentPercent / 100))
  const remaining = totalAfterDiscount - prepaidAmount

  return {
    nights,
    total,
    totalAfterDiscount,
    prepaidAmount,
    remaining,
    breakdown,
    nightLines,
    // Тариф отсутствует, если гости есть, а цены нет ни на одну ночь.
    // Ноль при нулевых гостях — это «нечего считать», а не «нет тарифа».
    noRates: hasGuests && pricedNights === 0,
    missingNights: missingDates.length,
    missingDates,
  }
}
