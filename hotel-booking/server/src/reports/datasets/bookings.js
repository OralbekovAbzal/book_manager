const { prisma } = require('../../utils/prisma')
const { isoDate, isoMonth, daysBetween, weekdayName, toUTCDate } = require('../dateUtils')
const { loadBookingMoney } = require('../../utils/bookingMoney')

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
  // Деньги брони. `charged`/`paidNet`/`debtAmount` считаются тем же кодом, что
  // и экран «кто сколько должен» (`utils/bookingMoney.js`) — иначе отчёт о
  // долгах и стойка называли бы разные суммы.
  charged:       { label: 'Начислено',   type: 'money',
                   description: 'Сумма строк начислений; если строк нет — сохранённый итог брони' },
  chargesFromRows: { label: 'Начислено строками', type: 'bool', groupable: true,
                   description: 'Нет — у брони нет строк начислений, сумма взята из итога брони' },
  paidNet:       { label: 'Принято',     type: 'money',
                   description: 'Сумма платежей журнала: возврат минусом, отменённые не в счёт' },
  debtAmount:    { label: 'Долг',        type: 'money',
                   description: 'Начислено − принято. Минус означает переплату' },
  totalAmount:   { label: 'Сумма брони (итог)', type: 'money' },
  prepaidAmount: { label: 'Предоплата',  type: 'money' },
  paidAmount:    { label: 'Оплачено (поле брони)', type: 'money',
                   description: 'Кэш суммы платежей. У старых броней заполнен вручную и может отличаться от журнала' },
  discountPercent:{ label: 'Скидка, %',  type: 'number' },
  createdByName: { label: 'Кто создал',  type: 'text', groupable: true, optionsFrom: 'admins' },
  createdAt:     { label: 'Создана',     type: 'datetime' },
  createdDate:   { label: 'Дата создания', type: 'date', groupable: true },
  notes:         { label: 'Примечание',  type: 'text' },
  // Цепочка после переезда: продолжение остаётся строкой реестра (гость жил в этом
  // номере эти ночи), но деньги у него нулевые — они на голове счёта. Поэтому
  // агрегаты «Броней», «Средний чек», «Доля отмен» считаются по головам: иначе
  // переезд задирал бы число броней и вдвое занижал средний чек.
  isContinuation:{ label: 'Продолжение счёта', type: 'bool', groupable: true,
                   description: 'Да — вторая (или следующая) часть брони после переезда; деньги на голове счёта' },
  accountOf:     { label: 'Счёт брони',  type: 'text',
                   description: 'Номер брони-головы, если это продолжение после переезда' },
  count:         { label: 'Броней',      type: 'int', synthetic: true },
}

const metrics = {
  // Счётчики броней — по головам: продолжение после переезда это часть той же
  // брони, и считать его отдельной значит завысить число броней и вдвое занизить
  // средний чек (деньги цепочки лежат на голове, у продолжения нули).
  count:        { label: 'Броней',                 expr: 'countIf(isContinuation = false)', type: 'int',
                  description: 'Продолжения после переезда не считаются: это части одной брони' },
  nights:       { label: 'Ночей',                  expr: 'sum(nights)',                type: 'int' },
  avgNights:    { label: 'Средняя длина, ночей',   expr: 'avg(nights)',                type: 'number', decimals: 1 },
  guests:       { label: 'Гостей',                 expr: 'sum(guests)',                type: 'int' },
  uniqueGuests: { label: 'Уникальных гостей',      expr: 'countDistinct(guestName)',   type: 'int' },
  revenue:      { label: 'Сумма броней',           expr: 'sum(totalAmount)',           type: 'money', decimals: 0 },
  charged:      { label: 'Начислено',              expr: 'sum(charged)',               type: 'money', decimals: 0 },
  paid:         { label: 'Принято',                expr: 'sum(paidNet)',               type: 'money', decimals: 0 },
  debt:         { label: 'Долг',                   expr: 'sum(debtAmount)',            type: 'money', decimals: 0,
                  description: 'Начислено минус принято по всем броням группы' },
  debtOnly:     { label: 'Долг (без переплат)',    expr: 'sumIf(debtAmount, debtAmount > 0)', type: 'money', decimals: 0,
                  description: 'Переплаты не гасят чужой долг' },
  debtors:      { label: 'Должников',              expr: 'countIf(debtAmount > 0)',    type: 'int' },
  avgCheck:     { label: 'Средний чек',            expr: 'sum(totalAmount) / countIf(isContinuation = false)', type: 'money', decimals: 0 },
  cancelled:    { label: 'Отменено',               expr: "countIf(status = 'CANCELLED' and isContinuation = false)", type: 'int' },
  cancelRate:   { label: 'Доля отмен, %',          expr: "countIf(status = 'CANCELLED' and isContinuation = false) / countIf(isContinuation = false) * 100", type: 'percent', decimals: 1,
                  description: 'Считайте с включёнными отменёнными бронями' },
  noShowRate:   { label: 'Доля незаездов, %',      expr: "countIf(status = 'NO_SHOW' and isContinuation = false) / countIf(isContinuation = false) * 100", type: 'percent', decimals: 1 },
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
      // Голова счёта: по ней `loadBookingMoney` берёт деньги цепочки, а реестр
      // помечает продолжение и не считает его отдельной бронью
      accountBookingId: true,
      createdAt: true,
      room: { select: { number: true, building: true, floor: true, capacity: true, features: true, category: { select: { name: true } } } },
      partner: { select: { name: true, commissionPercent: true } },
      createdBy: { select: { name: true } },
    },
    orderBy: [{ checkIn: 'asc' }, { id: 'asc' }],
  })

  // Начислено / принято / долг — одним групповым запросом на всю выборку,
  // а не по запросу на бронь: отчёт за год это сотни строк.
  const money = await loadBookingMoney(rows)

  // Деньги цепочки лежат на голове, и `loadBookingMoney` отдаёт их КАЖДОМУ отрезку —
  // это верно для формы брони («сколько должен гость»), но не для реестра: там
  // `sum(charged)` сложил бы один и тот же счёт по разу на каждый переезд. Поэтому
  // в отчётах у продолжения деньги нулевые, а «чей это счёт» видно в `accountOf`.
  const ZERO_MONEY = { charged: 0, chargesFromRows: true, paid: 0, due: 0 }

  return rows.map((b) => {
    const m = b.accountBookingId != null ? ZERO_MONEY : money.get(b.id)
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
      charged: m.charged,
      chargesFromRows: m.chargesFromRows,
      paidNet: m.paid,
      debtAmount: m.due,
      totalAmount: b.totalAmount,
      prepaidAmount: b.prepaidAmount,
      paidAmount: b.paidAmount,
      discountPercent: b.discountPercent,
      createdByName: (b.createdBy && b.createdBy.name) || '',
      createdAt: b.createdAt,
      createdDate: isoDate(b.createdAt),
      notes: b.notes || '',
      isContinuation: b.accountBookingId != null,
      accountOf: b.accountBookingId != null ? `№${b.accountBookingId}` : '',
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
