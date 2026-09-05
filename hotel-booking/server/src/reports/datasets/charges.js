const { prisma } = require('../../utils/prisma')
const { isoDate, isoMonth, daysBetween, weekdayName, toUTCDate } = require('../dateUtils')

/**
 * Датасет «Начисления»: одна строка = одна строка счёта (`BookingCharge`).
 *
 * Почему выручка считается отсюда, а не из `Booking.totalAmount`: начисления —
 * источник истины по деньгам, а `totalAmount` лишь кэш их суммы (см.
 * `docs/decisions/data-and-money.md`). Только здесь видно, СКОЛЬКО заработано
 * на проживании, а сколько на завтраках, и только здесь скидка — отдельная
 * строка со своим знаком, а не растворённый в итоге процент.
 *
 * Разложение по видам сделано служебными полями `stayAmount`/`mealAmount`/
 * `extraAmount`/`discountAmount` (сумма строки или 0) — тот же приём, что
 * `isSold`/`isAvailable` в «Номеро-ночах»: одна группировка, четыре колонки
 * через `sum()`, а не четыре отчёта. Итог = сумма всех четырёх, потому что
 * скидка лежит в строке отрицательной.
 */

const KIND_LABELS = {
  stay: 'Проживание',
  meal: 'Питание',
  extra: 'Услуги',
  discount: 'Скидки',
}
const KIND_OPTIONS = Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label }))

const STATUS_LABELS = {
  CONFIRMED: 'Подтверждена',
  CHECKED_IN: 'Заехал',
  CHECKED_OUT: 'Выехал',
  CANCELLED: 'Отменена',
  NO_SHOW: 'Не заехал',
}
const STATUS_OPTIONS = Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }))

const SOURCE_LABELS = { auto: 'Тариф', manual: 'Правка вручную' }
const SOURCE_OPTIONS = Object.entries(SOURCE_LABELS).map(([value, label]) => ({ value, label }))

const fields = {
  id:            { label: '№ начисления', type: 'int' },
  bookingId:     { label: '№ брони',      type: 'int' },

  kind:          { label: 'Вид (код)',    type: 'text', groupable: true, options: KIND_OPTIONS },
  kindLabel:     { label: 'Вид начисления', type: 'text', groupable: true },
  label:         { label: 'Название строки', type: 'text', groupable: true },
  quantity:      { label: 'Количество',   type: 'number' },
  unitPrice:     { label: 'Цена за единицу', type: 'money' },
  amount:        { label: 'Сумма',        type: 'money',
                   description: 'Скидки лежат отрицательными — сумма всех строк и есть итог счёта' },

  // Дата ночи есть только у проживания: услуги и скидки начисляются на бронь
  // целиком. Поэтому у отчёта две даты, и период считается по второй.
  date:          { label: 'Дата ночи',    type: 'date',  groupable: true,
                   description: 'Только у проживания; у услуг и скидок пусто' },
  periodDate:    { label: 'Дата начисления (услуги — по заезду)', type: 'date', groupable: true,
                   description: 'Дата ночи, а у строк без даты (услуги, скидки) — дата заезда брони. По ней считается период отчёта' },
  month:         { label: 'Месяц начисления', type: 'month', groupable: true },
  weekday:       { label: 'День недели',  type: 'text',  groupable: true },

  chargeSource:  { label: 'Откуда строка (код)', type: 'text', groupable: true, options: SOURCE_OPTIONS },
  chargeSourceLabel: { label: 'Откуда строка', type: 'text', groupable: true },
  reason:        { label: 'Причина правки', type: 'text' },
  createdByName: { label: 'Кто добавил',  type: 'text', groupable: true, optionsFrom: 'admins' },
  createdDate:   { label: 'Дата добавления', type: 'date', groupable: true },

  roomNumber:    { label: 'Номер',        type: 'text', groupable: true },
  building:      { label: 'Корпус',       type: 'text', groupable: true, optionsFrom: 'buildings' },
  floor:         { label: 'Этаж',         type: 'int',  groupable: true, optionsFrom: 'floors' },
  categoryName:  { label: 'Категория',    type: 'text', groupable: true, optionsFrom: 'categories' },
  capacity:      { label: 'Вместимость номера', type: 'text', groupable: true },

  guestName:     { label: 'Гость',        type: 'text', groupable: true },
  guestPhone:    { label: 'Телефон',      type: 'text' },
  checkIn:       { label: 'Заезд',        type: 'date', groupable: true },
  checkOut:      { label: 'Выезд',        type: 'date', groupable: true },
  checkInMonth:  { label: 'Месяц заезда', type: 'month', groupable: true },
  nights:        { label: 'Ночей в брони', type: 'int' },
  status:        { label: 'Статус брони (код)', type: 'text', groupable: true, options: STATUS_OPTIONS },
  statusLabel:   { label: 'Статус брони', type: 'text', groupable: true },
  bookingSource: { label: 'Источник брони', type: 'text', groupable: true, optionsFrom: 'sources' },
  partnerName:   { label: 'Партнёр',      type: 'text', groupable: true, optionsFrom: 'partners' },
  isMaintenance: { label: 'Ремонт',       type: 'bool', groupable: true },

  stayAmount:     { label: 'Проживание, сумма (0/сумма)', type: 'money', synthetic: true },
  mealAmount:     { label: 'Питание, сумма (0/сумма)',    type: 'money', synthetic: true },
  extraAmount:    { label: 'Услуги, сумма (0/сумма)',     type: 'money', synthetic: true },
  discountAmount: { label: 'Скидки, сумма (0/сумма)',     type: 'money', synthetic: true },
  count:          { label: 'Строк',       type: 'int', synthetic: true },
}

const metrics = {
  stay:      { label: 'Проживание', expr: 'sum(stayAmount)',     type: 'money', decimals: 0 },
  meal:      { label: 'Питание',    expr: 'sum(mealAmount)',     type: 'money', decimals: 0 },
  extra:     { label: 'Услуги',     expr: 'sum(extraAmount)',    type: 'money', decimals: 0 },
  discount:  { label: 'Скидки',     expr: 'sum(discountAmount)', type: 'money', decimals: 0,
               description: 'Отрицательная величина: скидка уменьшает счёт' },
  total:     { label: 'Итого начислено', expr: 'sum(amount)',    type: 'money', decimals: 0,
               description: 'Проживание + питание + услуги + скидки' },
  lines:     { label: 'Строк',      expr: 'count()',             type: 'int' },
  bookings:  { label: 'Броней',     expr: 'countDistinct(bookingId)', type: 'int' },
  avgPerBooking: { label: 'В среднем на бронь', expr: 'sum(amount) / countDistinct(bookingId)', type: 'money', decimals: 0 },
  nights:    { label: 'Ночей продано', expr: 'countIf(kind = \'stay\')', type: 'int',
               description: 'Строк проживания: одна строка — одна ночь' },
  avgNight:  { label: 'Средняя цена ночи', expr: 'sum(stayAmount) / countIf(kind = \'stay\')', type: 'money', decimals: 0 },
  manualShare: { label: 'Доля ручных правок, %', expr: "countIf(chargeSource = 'manual') / count() * 100", type: 'percent', decimals: 1 },
}

async function load({ params }) {
  const from = toUTCDate(params.period && params.period.from)
  const to = toUTCDate(params.period && params.period.to)

  // Период по дате строки; у строк без даты (услуги, скидки) — по заезду брони.
  // Иначе завтраки и скидки не попали бы ни в один месяц вообще.
  const rows = await prisma.bookingCharge.findMany({
    where: {
      OR: [
        { date: { gte: from, lt: to } },
        { date: null, booking: { checkIn: { gte: from, lt: to } } },
      ],
    },
    select: {
      id: true, bookingId: true, kind: true, label: true, quantity: true,
      unitPrice: true, amount: true, date: true, source: true, reason: true,
      createdAt: true,
      createdBy: { select: { name: true } },
      booking: {
        select: {
          guestName: true, guestPhone: true, checkIn: true, checkOut: true,
          status: true, source: true,
          room: {
            select: {
              number: true, building: true, floor: true, capacity: true,
              category: { select: { name: true } },
            },
          },
          partner: { select: { name: true } },
        },
      },
    },
    orderBy: [{ date: 'asc' }, { id: 'asc' }],
  })

  return rows.map((c) => {
    const b = c.booking
    const periodDate = c.date || b.checkIn
    const amount = c.amount
    return {
      id: c.id,
      bookingId: c.bookingId,
      kind: c.kind,
      kindLabel: KIND_LABELS[c.kind] || c.kind,
      label: c.label,
      quantity: c.quantity,
      unitPrice: c.unitPrice,
      amount,
      date: isoDate(c.date),
      periodDate: isoDate(periodDate),
      month: isoMonth(periodDate),
      weekday: weekdayName(periodDate),
      chargeSource: c.source,
      chargeSourceLabel: SOURCE_LABELS[c.source] || c.source,
      reason: c.reason || '',
      createdByName: (c.createdBy && c.createdBy.name) || '',
      createdDate: isoDate(c.createdAt),
      roomNumber: b.room.number,
      building: b.room.building,
      floor: b.room.floor,
      categoryName: b.room.category.name,
      capacity: b.room.capacity || '',
      guestName: b.guestName,
      guestPhone: b.guestPhone || '',
      checkIn: isoDate(b.checkIn),
      checkOut: isoDate(b.checkOut),
      checkInMonth: isoMonth(b.checkIn),
      nights: daysBetween(b.checkIn, b.checkOut),
      status: b.status,
      statusLabel: STATUS_LABELS[b.status] || b.status,
      bookingSource: b.source || '',
      partnerName: (b.partner && b.partner.name) || '',
      isMaintenance: b.source === 'ремонт',
      stayAmount: c.kind === 'stay' ? amount : 0,
      mealAmount: c.kind === 'meal' ? amount : 0,
      extraAmount: c.kind === 'extra' ? amount : 0,
      discountAmount: c.kind === 'discount' ? amount : 0,
      count: 1,
    }
  })
}

module.exports = {
  id: 'charges',
  requiresPeriod: true,
  label: 'Начисления',
  description: 'Одна строка — одно начисление по брони (ночь проживания, услуга, скидка). '
    + 'Период считается по дате строки, а у услуг и скидок — по дате заезда брони.',
  fields,
  metrics,
  load,
  KIND_LABELS,
  STATUS_LABELS,
}
