const { prisma } = require('../../utils/prisma')
const { isoDate, isoMonth, daysBetween, weekdayName, toUTCDate } = require('../dateUtils')

/**
 * Датасет «Брони»: одна строка = одна бронь.
 *
 * `fields` — не документация, а контракт: из него конструктор отчётов строит
 * списки колонок, фильтров и группировок. Появилось поле — появилось везде.
 *   groupable   — по полю можно группировать;
 *   synthetic   — служебный счётчик (0/1, 1), не показывать как «данные»;
 *   options     — конечный список значений (для фильтра «спросить у пользователя»);
 *   optionsFrom — справочник сервера с тем же смыслом (options.js).
 *
 * `metrics` — готовые показатели: именованные формулы с подписью и типом.
 * Конструктор предлагает их одним кликом; тот, кому мало, пишет формулу сам.
 */

const STATUS_LABELS = {
  CONFIRMED: 'Подтверждена',
  CHECKED_IN: 'Заехал',
  CHECKED_OUT: 'Выехал',
  CANCELLED: 'Отменена',
  NO_SHOW: 'Не заехал',
}
const STATUS_OPTIONS = Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }))

const fields = {
  id:            { label: '№ брони',     type: 'int' },
  roomNumber:    { label: 'Номер',       type: 'text', groupable: true },
  building:      { label: 'Корпус',      type: 'text', groupable: true, optionsFrom: 'buildings' },
  floor:         { label: 'Этаж',        type: 'int',  groupable: true, optionsFrom: 'floors' },
  categoryName:  { label: 'Категория',   type: 'text', groupable: true, optionsFrom: 'categories' },
  capacity:      { label: 'Вместимость номера', type: 'text', groupable: true },
  features:      { label: 'Особенности номера', type: 'list' },
  guestName:     { label: 'Гость',       type: 'text' },
  guestPhone:    { label: 'Телефон',     type: 'text' },
  checkIn:       { label: 'Заезд',       type: 'date', groupable: true },
  checkOut:      { label: 'Выезд',       type: 'date', groupable: true },
  checkInMonth:  { label: 'Месяц заезда',type: 'month', groupable: true },
  checkInWeekday:{ label: 'День недели заезда', type: 'text', groupable: true },
  nights:        { label: 'Ночей',       type: 'int' },
  guests:        { label: 'Гостей',      type: 'int' },
  adults:        { label: 'Взрослых',    type: 'int' },
  children:      { label: 'Детей',       type: 'int' },
  extraBeds:     { label: 'Доп. мест',   type: 'int' },
  roomNights:    { label: 'Номеро-ночей',type: 'int' },
  status:        { label: 'Статус (код)',type: 'text', groupable: true, options: STATUS_OPTIONS },
  statusLabel:   { label: 'Статус',      type: 'text', groupable: true },
  source:        { label: 'Источник',    type: 'text', groupable: true, optionsFrom: 'sources' },
  isMaintenance: { label: 'Ремонт',      type: 'bool', groupable: true },
  partnerName:   { label: 'Партнёр',     type: 'text', groupable: true, optionsFrom: 'partners' },
  partnerCommission: { label: 'Комиссия партнёра, %', type: 'number' },
  flags:         { label: 'Метки',       type: 'list' },
  totalAmount:   { label: 'Сумма',       type: 'money' },
  prepaidAmount: { label: 'Предоплата',  type: 'money' },
  paidAmount:    { label: 'Оплачено',    type: 'money' },
  debtAmount:    { label: 'Остаток',     type: 'money' },
  discountPercent:{ label: 'Скидка, %',  type: 'number' },
  createdByName: { label: 'Кто создал',  type: 'text', groupable: true, optionsFrom: 'admins' },
  createdAt:     { label: 'Создана',     type: 'datetime' },
  createdDate:   { label: 'Дата создания', type: 'date', groupable: true },
  notes:         { label: 'Примечание',  type: 'text' },
  count:         { label: 'Броней',      type: 'int', synthetic: true },
}

const metrics = {
  count:        { label: 'Броней',                 expr: 'count()',                    type: 'int' },
  nights:       { label: 'Ночей',                  expr: 'sum(nights)',                type: 'int' },
  avgNights:    { label: 'Средняя длина, ночей',   expr: 'avg(nights)',                type: 'number', decimals: 1 },
  guests:       { label: 'Гостей',                 expr: 'sum(guests)',                type: 'int' },
  uniqueGuests: { label: 'Уникальных гостей',      expr: 'countDistinct(guestName)',   type: 'int' },
  revenue:      { label: 'Сумма броней',           expr: 'sum(totalAmount)',           type: 'money' },
  paid:         { label: 'Оплачено',               expr: 'sum(paidAmount)',            type: 'money' },
  debt:         { label: 'Остаток к оплате',       expr: 'sum(debtAmount)',            type: 'money' },
  avgCheck:     { label: 'Средний чек',            expr: 'sum(totalAmount) / count()', type: 'money', decimals: 0 },
  cancelled:    { label: 'Отменено',               expr: "countIf(status = 'CANCELLED')", type: 'int' },
  cancelRate:   { label: 'Доля отмен, %',          expr: "countIf(status = 'CANCELLED') / count() * 100", type: 'percent', decimals: 1,
                  description: 'Считайте с включёнными отменёнными бронями' },
  noShowRate:   { label: 'Доля незаездов, %',      expr: "countIf(status = 'NO_SHOW') / count() * 100", type: 'percent', decimals: 1 },
}

/**
 * Как период пересекается с бронью. Три режима дают разные ответы на разные
 * вопросы, поэтому это параметр отчёта, а не выбор за пользователя.
 *  overlap — бронь задевает период (кто жил);
 *  checkIn — заезды за период;
 *  checkOut — выезды за период;
 *  created — брони, созданные за период.
 */
function periodWhere(mode, from, to) {
  if (mode === 'checkIn') return { checkIn: { gte: from, lt: to } }
  if (mode === 'checkOut') return { checkOut: { gte: from, lt: to } }
  if (mode === 'created') return { createdAt: { gte: from, lt: to } }
  return { checkIn: { lt: to }, checkOut: { gt: from } }
}

async function load({ params }) {
  const from = toUTCDate(params.period && params.period.from)
  const to = toUTCDate(params.period && params.period.to)
  const where = periodWhere(params.periodMode, from, to)

  // Отменённые нужны в реестре (их отдельно считают), поэтому не режем здесь —
  // за отбор статусов отвечают фильтры определения.
  const rows = await prisma.booking.findMany({
    where,
    select: {
      id: true, guestName: true, guestPhone: true, checkIn: true, checkOut: true,
      status: true, source: true, notes: true, flags: true,
      adultsWithMeals: true, childrenWithMeals: true, adultsNoMeals: true, childrenNoMeals: true,
      extraBedsWithMeals: true, extraBedsNoMeals: true, disabledAdults: true, disabledChildren: true,
      discountPercent: true, totalAmount: true, prepaidAmount: true, paidAmount: true,
      createdAt: true,
      room: { select: { number: true, building: true, floor: true, capacity: true, features: true, category: { select: { name: true } } } },
      partner: { select: { name: true, commissionPercent: true } },
      createdBy: { select: { name: true } },
    },
    orderBy: [{ checkIn: 'asc' }, { id: 'asc' }],
  })

  return rows.map((b) => {
    const adults = b.adultsWithMeals + b.adultsNoMeals + b.disabledAdults
    const children = b.childrenWithMeals + b.childrenNoMeals + b.disabledChildren
    const extraBeds = b.extraBedsWithMeals + b.extraBedsNoMeals
    const nights = daysBetween(b.checkIn, b.checkOut)
    return {
      id: b.id,
      roomNumber: b.room.number,
      building: b.room.building,
      floor: b.room.floor,
      categoryName: b.room.category.name,
      capacity: b.room.capacity || '',
      features: b.room.features || [],
      guestName: b.guestName,
      guestPhone: b.guestPhone || '',
      checkIn: isoDate(b.checkIn),
      checkOut: isoDate(b.checkOut),
      checkInMonth: isoMonth(b.checkIn),
      checkInWeekday: weekdayName(b.checkIn),
      nights,
      guests: adults + children + extraBeds,
      adults,
      children,
      extraBeds,
      roomNights: nights,
      status: b.status,
      statusLabel: STATUS_LABELS[b.status] || b.status,
      source: b.source || '',
      isMaintenance: b.source === 'ремонт',
      partnerName: (b.partner && b.partner.name) || '',
      partnerCommission: b.partner && b.partner.commissionPercent !== null ? b.partner.commissionPercent : null,
      flags: b.flags || [],
      totalAmount: b.totalAmount,
      prepaidAmount: b.prepaidAmount,
      paidAmount: b.paidAmount,
      debtAmount: Math.max(0, b.totalAmount - b.paidAmount),
      discountPercent: b.discountPercent,
      createdByName: (b.createdBy && b.createdBy.name) || '',
      createdAt: b.createdAt,
      createdDate: isoDate(b.createdAt),
      notes: b.notes || '',
      count: 1,
    }
  })
}

module.exports = {
  id: 'bookings',
  requiresPeriod: true,
  label: 'Брони',
  description: 'Одна строка — одна бронь. Период задаётся по проживанию, заезду, выезду или дате создания.',
  fields,
  metrics,
  load,
  STATUS_LABELS,
}
