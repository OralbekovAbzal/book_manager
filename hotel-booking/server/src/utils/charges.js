const { prisma } = require('./prisma')

/**
 * Генератор строк начислений (`BookingCharge`).
 *
 * Смысл модели (NOTES, «Ценообразование: бронь — это СУММА СТРОК»): тариф не считает
 * итог, он ПОРОЖДАЕТ строки. Итог брони = сумма строк, `Booking.totalAmount` — лишь её
 * кэш. Администратор может строку поправить, удалить или добавить свою
 * (`source='manual'` + обязательная `reason`), и тогда уступка «заехал в час ночи,
 * беру полсуток» остаётся внутри системы, а не в уме у администратора.
 *
 * Поэтому пересборка трогает ТОЛЬКО строки с `source='auto'`: ручные правки
 * переживают смену дат, тарифа и любой пересчёт.
 *
 * Те же правила продублированы в `client/src/utils/calculator.ts` (предпросмотр
 * в форме брони). Правишь здесь — правь и там.
 */

const DAY = 86400000

/** 'YYYY-MM-DD' | Date → UTC-полночь. Даты @db.Date хранятся именно так (см. NOTES). */
function toUTCDate(v) {
  const d = new Date(v)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

function dateKey(v) {
  return toUTCDate(v).toISOString().slice(0, 10)
}

/** Ночи брони — полуоткрытый интервал [checkIn, checkOut). */
function nightsOf(checkIn, checkOut) {
  const from = toUTCDate(checkIn).getTime()
  const to = toUTCDate(checkOut).getTime()
  const out = []
  for (let t = from; t < to; t += DAY) out.push(new Date(t))
  return out
}

function guestCounts(b) {
  return {
    adults: (b.adultsWithMeals || 0) + (b.adultsNoMeals || 0),
    children: (b.childrenWithMeals || 0) + (b.childrenNoMeals || 0),
    extraBeds: (b.extraBedsWithMeals || 0) + (b.extraBedsNoMeals || 0),
    // Питание начисляем только тем, кто «с питанием». Доп. место с питанием —
    // это тоже едок, поэтому идёт по взрослой цене (как и в старом калькуляторе,
    // где доп. место было отдельным слагаемым, а не частью счётчика взрослых).
    mealAdults: (b.adultsWithMeals || 0) + (b.extraBedsWithMeals || 0),
    mealChildren: b.childrenWithMeals || 0,
  }
}

function guestLabel({ adults, children, extraBeds }) {
  const parts = []
  if (adults) parts.push(`${adults} взр.`)
  if (children) parts.push(`${children} дет.`)
  if (extraBeds) parts.push(`${extraBeds} доп.`)
  return parts.join(' + ')
}

/**
 * Цена одной ночи проживания.
 * @returns {{ amount: number, missing: boolean }} missing — нужное поле цены не заполнено
 */
function priceNight(rate, pricingBase, counts) {
  if (!rate) return { amount: 0, missing: true }

  let amount = 0
  let missing = false
  const take = (value, qty) => {
    if (qty <= 0) return
    if (value === null || value === undefined) { missing = true; return }
    amount += value * qty
  }

  if (pricingBase === 'room') {
    if (rate.roomPrice === null || rate.roomPrice === undefined) missing = true
    else amount += rate.roomPrice
    take(rate.extraBedPrice, counts.extraBeds)
  } else {
    take(rate.adultPrice, counts.adults)
    take(rate.childPrice, counts.children)
    take(rate.extraBedPrice, counts.extraBeds)
  }

  return { amount, missing }
}

/** Название услуги для сравнения с ручными строками — регистр и пробелы не считаем. */
function normLabel(s) {
  return String(s || '').trim().toLowerCase()
}

/**
 * Собирает строки начислений по брони. Чистая функция — всё нужное передаётся снаружи,
 * чтобы её можно было прогнать без базы.
 *
 * Проживание — ПОСУТОЧНО (одна строка на ночь): именно так уступка «полсуток за
 * поздний заезд» правится в одной конкретной ночи, и так же строится отчёт по дням.
 * Услуги — одной строкой на услугу: «убрать обед» должно быть одним действием,
 * а не удалением семи строк.
 *
 * `manualCharges` — уже существующие ручные строки. Они здесь не для того, чтобы их
 * пересоздать, а чтобы НЕ создать дубль: если администратор поправил ночь «полсуток»,
 * автоматическая строка на ту же дату не нужна — иначе ночь начислится дважды.
 */
function buildAutoCharges({ booking, pricingBase, ratesByDate, services, manualCharges = [] }) {
  const nights = nightsOf(booking.checkIn, booking.checkOut)
  if (nights.length === 0) return []

  // Проживание сопоставляем по дате (на дату ровно одна строка), услуги — по названию.
  const manualStayDates = new Set(
    manualCharges.filter(c => c.kind === 'stay' && c.date).map(c => dateKey(c.date)),
  )
  const manualLabels = new Set(
    manualCharges.filter(c => c.kind !== 'stay').map(c => normLabel(c.label)),
  )

  const counts = guestCounts(booking)
  const rows = []
  const label = guestLabel(counts)

  // ── Проживание ──
  for (const night of nights) {
    const key = dateKey(night)
    if (manualStayDates.has(key)) continue  // ночь уже посчитана вручную
    const { amount } = priceNight(ratesByDate[key], pricingBase, counts)
    const value = Math.round(amount)
    if (value === 0) continue  // нет цены на эту ночь — строку не выдумываем, ноль это не цена
    rows.push({
      kind: 'stay',
      label: pricingBase === 'room' ? 'Проживание · номер' : `Проживание · ${label || 'без гостей'}`,
      quantity: 1,
      unitPrice: value,
      amount: value,
      date: night,
    })
  }

  // ── Услуги (питание и прочее) ──
  // Названия держим короткими и стабильными («Завтрак», «Завтрак (дети)»): количество
  // видно в самой строке (кол-во × цена), а стабильное название позволяет узнать
  // услугу после пересборки и не задвоить её ручную правку.
  const nightCount = nights.length
  for (const s of services || []) {
    if (!s.isActive) continue
    const isMeal = s.kind === 'meal'
    const adults = isMeal ? counts.mealAdults : counts.adults + counts.extraBeds
    const children = isMeal ? counts.mealChildren : counts.children
    // childPrice = null означает «считать по взрослой цене»
    const splitChildren = s.childPrice !== null && s.childPrice !== undefined && children > 0
    const adultHeads = splitChildren ? adults : adults + children

    const push = (text, quantity, unitPrice) => {
      if (quantity <= 0 || !unitPrice || unitPrice <= 0) return
      if (manualLabels.has(normLabel(text))) return  // эту строку администратор уже ведёт сам
      rows.push({
        kind: isMeal ? 'meal' : 'extra',
        label: text,
        quantity,
        unitPrice,
        amount: Math.round(quantity * unitPrice),
        date: null,
      })
    }

    const childLabel = `${s.name} (дети)`
    switch (s.unit) {
      case 'per_person_night':
        push(s.name, adultHeads * nightCount, s.price)
        if (splitChildren) push(childLabel, children * nightCount, s.childPrice)
        break
      case 'per_night':
        push(s.name, nightCount, s.price)
        break
      case 'per_person':
        push(s.name, adultHeads, s.price)
        if (splitChildren) push(childLabel, children, s.childPrice)
        break
      case 'per_booking':
      default:
        push(s.name, 1, s.price)
        break
    }
  }

  // ── Скидка процентом ──
  // Считаем от всего счёта, включая ручные строки: «скидка 10%» — это 10% с того,
  // что гость реально должен, а не с той части, которую посчитал тариф.
  const pct = booking.discountPercent || 0
  if (pct > 0) {
    const manualBase = manualCharges
      .filter(c => c.kind !== 'discount')
      .reduce((sum, c) => sum + (c.amount || 0), 0)
    const subtotal = rows.reduce((sum, r) => sum + r.amount, 0) + manualBase
    const value = Math.round(subtotal * pct / 100)
    if (value > 0) {
      rows.push({
        kind: 'discount',
        label: `Скидка ${pct}%`,
        quantity: 1,
        unitPrice: -value,
        amount: -value,
        date: null,
      })
    }
  }

  return rows
}

/** Тариф, услуги и настройки объекта, нужные для генерации. */
async function loadChargeContext(booking, client = prisma) {
  const [hotel, rates, services] = await Promise.all([
    client.hotelSettings.findUnique({ where: { id: 1 } }),
    booking.room?.categoryId
      ? client.ratePrice.findMany({
        where: {
          categoryId: booking.room.categoryId,
          date: { gte: toUTCDate(booking.checkIn), lt: toUTCDate(booking.checkOut) },
        },
      })
      : Promise.resolve([]),
    client.service.findMany({ where: { isActive: true, includedByDefault: true }, orderBy: { order: 'asc' } }),
  ])

  const ratesByDate = {}
  for (const r of rates) ratesByDate[dateKey(r.date)] = r

  return { pricingBase: hotel?.pricingBase || 'person', ratesByDate, services }
}

function sumCharges(charges) {
  return Math.round(charges.reduce((sum, c) => sum + (c.amount || 0), 0))
}

/**
 * Пересчитывает `Booking.totalAmount` как сумму строк (и предоплату — от процента).
 *
 * `keepIfEmpty`: если строк нет вообще (тариф на эти даты не заполнен), сумму брони
 * не обнуляем — иначе создание брони в отеле без прайса молча стирало бы деньги,
 * посчитанные вручную. При явных операциях со строками режим строгий.
 */
async function recalcBookingTotals(bookingId, { client = prisma, keepIfEmpty = false } = {}) {
  const charges = await client.bookingCharge.findMany({ where: { bookingId } })
  if (charges.length === 0 && keepIfEmpty) return null

  const total = sumCharges(charges)
  const booking = await client.booking.findUnique({
    where: { id: bookingId },
    select: { prepaymentPercent: true },
  })
  const prepaid = Math.round(total * ((booking?.prepaymentPercent || 0) / 100))

  await client.booking.update({
    where: { id: bookingId },
    data: { totalAmount: total, prepaidAmount: prepaid },
  })
  return { total, prepaidAmount: prepaid, count: charges.length }
}

/**
 * Пересобирает автоматические строки брони. Ручные (`source='manual'`) не трогает.
 * @returns {{ created: number, total: number|null }}
 */
async function rebuildAutoCharges(bookingId, { adminId = null, client = prisma, keepIfEmpty = false } = {}) {
  const booking = await client.booking.findUnique({
    where: { id: bookingId },
    include: { room: { select: { categoryId: true } } },
  })
  if (!booking) return { created: 0, total: null }

  const ctx = await loadChargeContext(booking, client)
  const manualCharges = await client.bookingCharge.findMany({ where: { bookingId, source: 'manual' } })
  const rows = buildAutoCharges({ booking, ...ctx, manualCharges })

  await client.bookingCharge.deleteMany({ where: { bookingId, source: 'auto' } })
  if (rows.length > 0) {
    await client.bookingCharge.createMany({
      data: rows.map(r => ({ ...r, bookingId, source: 'auto', createdById: adminId })),
    })
  }

  const totals = await recalcBookingTotals(bookingId, { client, keepIfEmpty })
  return { created: rows.length, total: totals ? totals.total : null }
}

/**
 * Изменились ли входы, от которых зависят автоматические строки.
 * Правка заметки или телефона не должна переоценивать бронь по сегодняшнему тарифу —
 * та же защита, что и ключом пересчёта на клиенте.
 */
const CHARGE_INPUT_FIELDS = [
  'roomId', 'checkIn', 'checkOut',
  'adultsWithMeals', 'childrenWithMeals', 'adultsNoMeals', 'childrenNoMeals',
  'extraBedsWithMeals', 'extraBedsNoMeals', 'discountPercent',
]

function chargeInputsChanged(before, after) {
  return CHARGE_INPUT_FIELDS.some((f) => {
    const a = before[f]
    const b = after[f]
    if (a instanceof Date || b instanceof Date) {
      return new Date(a).getTime() !== new Date(b).getTime()
    }
    return (a ?? null) !== (b ?? null)
  })
}

module.exports = {
  toUTCDate,
  dateKey,
  nightsOf,
  buildAutoCharges,
  loadChargeContext,
  rebuildAutoCharges,
  recalcBookingTotals,
  sumCharges,
  chargeInputsChanged,
  CHARGE_INPUT_FIELDS,
}
