import { parseISO, addDays, format, differenceInCalendarDays } from 'date-fns'
import type { PricingConfig } from '../store/useSettingsStore'

export interface CalcInput {
  checkIn: string   // YYYY-MM-DD
  checkOut: string  // YYYY-MM-DD
  categoryName: string  // room category name (will be matched case-insensitively)
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

export interface CalcResult {
  nights: number
  total: number            // before discount
  totalAfterDiscount: number
  prepaidAmount: number
  remaining: number
  breakdown: BreakdownLine[]
}

export interface BreakdownLine {
  label: string
  nights: number
  amount: number
}

function getPeriodId(date: Date, periods: PricingConfig['periods']): string | null {
  const mmdd = format(date, 'MM-dd')
  for (const p of periods) {
    if (mmdd >= p.start && mmdd <= p.end) return p.id
  }
  return null
}

export function calculate(input: CalcInput, pricing: PricingConfig): CalcResult {
  const { checkIn, checkOut } = input
  if (!checkIn || !checkOut || checkOut <= checkIn) {
    return { nights: 0, total: 0, totalAfterDiscount: 0, prepaidAmount: 0, remaining: 0, breakdown: [] }
  }

  const nights = differenceInCalendarDays(parseISO(checkOut), parseISO(checkIn))

  // Find category rates (case-insensitive match)
  const catKey = Object.keys(pricing.categoryRates).find(
    k => k.toLowerCase() === input.categoryName.toLowerCase()
  )
  const rates = catKey ? pricing.categoryRates[catKey] : null

  // Group nights by period
  const nightsByPeriod: Record<string, number> = {}
  for (let i = 0; i < nights; i++) {
    const date = addDays(parseISO(checkIn), i)
    const pid = getPeriodId(date, pricing.periods)
    const key = pid ?? 'default'
    nightsByPeriod[key] = (nightsByPeriod[key] || 0) + 1
  }

  // Default rate (if no period match or no config)
  const defaultAdultRate = rates ? (Object.values(rates.adultRates)[0] ?? 0) : 0
  const defaultChildRate = rates ? (Object.values(rates.childRates)[0] ?? 0) : 0
  const defaultExtraRate = rates ? (Object.values(rates.extraBedRates)[0] ?? 0) : 0

  const breakdown: BreakdownLine[] = []
  let total = 0

  for (const [pid, n] of Object.entries(nightsByPeriod)) {
    const adultRate = rates?.adultRates[pid] ?? defaultAdultRate
    const childRate = rates?.childRates[pid] ?? defaultChildRate
    const extraRate = rates?.extraBedRates[pid] ?? defaultExtraRate
    const noMealDisc = pricing.noMealDiscount

    const lineAdultMeal = adultRate * input.adultsWithMeals * n
    const lineChildMeal = childRate * input.childrenWithMeals * n
    const lineAdultNoMeal = (adultRate - noMealDisc) * input.adultsNoMeals * n
    const lineChildNoMeal = (childRate - noMealDisc) * input.childrenNoMeals * n
    const lineExtraMeal = extraRate * input.extraBedsWithMeals * n
    const lineExtraNoMeal = (extraRate - noMealDisc) * input.extraBedsNoMeals * n

    const disabledDisc = (rates?.disabledDiscount ?? pricing.disabledDiscountDefault)
    const lineDisabled = -disabledDisc * (input.disabledAdults + input.disabledChildren) * n

    const lineTotal = lineAdultMeal + lineChildMeal + lineAdultNoMeal + lineChildNoMeal + lineExtraMeal + lineExtraNoMeal + lineDisabled

    if (lineTotal !== 0) {
      const period = pricing.periods.find(p => p.id === pid)
      breakdown.push({
        label: period ? period.name : `${n} ночей`,
        nights: n,
        amount: lineTotal,
      })
    }
    total += lineTotal
  }

  const totalAfterDiscount = total * (1 - input.discountPercent / 100)
  const prepaidAmount = totalAfterDiscount * (input.prepaymentPercent / 100)
  const remaining = totalAfterDiscount - prepaidAmount

  return { nights, total, totalAfterDiscount, prepaidAmount, remaining, breakdown }
}
