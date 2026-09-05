const { prisma } = require('../../utils/prisma')
const { isoDate, isoMonth, weekdayName, toUTCDate } = require('../dateUtils')
const { round2 } = require('../../utils/bookingMoney')

/**
 * Датасет «Платежи»: одна строка = одна запись журнала кассы (`Payment`).
 *
 * Период и группировка по умолчанию считаются по РАБОЧЕЙ ДАТЕ (дате смены),
 * а не по `paidAt`: касса закрывается по смене, а сутки в отеле не равны
 * календарным (см. `businessDate.js` и `docs/decisions/data-and-money.md`).
 * Календарный момент приёма тоже есть — поля `paidAt` / `paidDate`, — но это
 * ответ на другой вопрос («когда физически принесли деньги»).
 *
 * Отменённые записи (`voidedAt`) в суммы НЕ входят: денежные поля у них равны
 * нулю, а сама строка остаётся и видна через `isVoided` и «Отменено».
 * Так объясняется разрыв в нумерации кассы, а не прячется.
 *
 * Возврат — отдельная строка с положительной `amount` и `kind='refund'`; знак
 * задаётся видом. Поэтому «принято» и «возвращено» видны по отдельности, а
 * «нетто» = принято − возвращено.
 */

const KIND_LABELS = { payment: 'Приём оплаты', refund: 'Возврат' }
const KIND_OPTIONS = Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label }))

const METHOD_LABELS = { cash: 'Наличные', card: 'Карта', transfer: 'Перевод' }
const METHOD_OPTIONS = Object.entries(METHOD_LABELS).map(([value, label]) => ({ value, label }))

const STATUS_LABELS = {
  CONFIRMED: 'Подтверждена',
  CHECKED_IN: 'Заехал',
  CHECKED_OUT: 'Выехал',
  CANCELLED: 'Отменена',
  NO_SHOW: 'Не заехал',
}

const fields = {
  id:            { label: '№ платежа',   type: 'int' },
  bookingId:     { label: '№ брони',     type: 'int' },

  kind:          { label: 'Вид (код)',   type: 'text', groupable: true, options: KIND_OPTIONS },
  kindLabel:     { label: 'Вид операции', type: 'text', groupable: true },
  method:        { label: 'Способ оплаты (код)', type: 'text', groupable: true, options: METHOD_OPTIONS },
  methodLabel:   { label: 'Способ оплаты', type: 'text', groupable: true },

  amount:        { label: 'Сумма записи', type: 'money',
                   description: 'Всегда положительная, в том числе у возврата и у отменённой записи' },

  businessDate:  { label: 'Рабочая дата (смена)', type: 'date', groupable: true,
                   description: 'Дата смены, в которую принят платёж. По ней считается касса и период отчёта' },
  businessMonth: { label: 'Месяц (по смене)', type: 'month', groupable: true },
  weekday:       { label: 'День недели (по смене)', type: 'text', groupable: true },
  shiftId:       { label: '№ смены',     type: 'int',  groupable: true },
  paidAt:        { label: 'Момент приёма', type: 'datetime' },
  paidDate:      { label: 'Календарная дата приёма', type: 'date', groupable: true,
                   description: 'День по часам, а не по смене — может отличаться от рабочей даты' },

  adminName:     { label: 'Кто принял',  type: 'text', groupable: true, optionsFrom: 'admins' },
  comment:       { label: 'Комментарий', type: 'text' },

  isVoided:      { label: 'Отменён',     type: 'bool', groupable: true },
  voidedAt:      { label: 'Когда отменён', type: 'datetime' },
  voidedByName:  { label: 'Кто отменил', type: 'text', groupable: true },
  voidReason:    { label: 'Причина отмены', type: 'text' },
  refundOfId:    { label: '№ исходного платежа', type: 'int' },

  guestName:     { label: 'Гость',       type: 'text', groupable: true },
  guestPhone:    { label: 'Телефон',     type: 'text' },
  roomNumber:    { label: 'Номер',       type: 'text', groupable: true },
  building:      { label: 'Корпус',      type: 'text', groupable: true, optionsFrom: 'buildings' },
  categoryName:  { label: 'Категория',   type: 'text', groupable: true, optionsFrom: 'categories' },
  checkIn:       { label: 'Заезд',       type: 'date', groupable: true },
  checkOut:      { label: 'Выезд',       type: 'date', groupable: true },
  bookingStatus: { label: 'Статус брони', type: 'text', groupable: true },
  partnerName:   { label: 'Партнёр',     type: 'text', groupable: true, optionsFrom: 'partners' },

  // Служебные суммы: отменённые записи везде дают 0, поэтому любая выборка
  // (с отменёнными или без) считает одинаково правильные деньги.
  receivedAmount:  { label: 'Принято (0/сумма)',    type: 'money', synthetic: true },
  refundedAmount:  { label: 'Возвращено (0/сумма)', type: 'money', synthetic: true },
  netAmount:       { label: 'Нетто (±сумма)',       type: 'money', synthetic: true },
  voidedAmount:    { label: 'Отменено (0/сумма)',   type: 'money', synthetic: true },
  cashAmount:      { label: 'Наличные, нетто',      type: 'money', synthetic: true },
  cardAmount:      { label: 'Карта, нетто',         type: 'money', synthetic: true },
  transferAmount:  { label: 'Перевод, нетто',       type: 'money', synthetic: true },
  count:           { label: 'Записей',              type: 'int',   synthetic: true },
}

const metrics = {
  received:  { label: 'Принято',    expr: 'sum(receivedAmount)', type: 'money', decimals: 0 },
  refunded:  { label: 'Возвращено', expr: 'sum(refundedAmount)', type: 'money', decimals: 0 },
  net:       { label: 'Нетто',      expr: 'sum(netAmount)',      type: 'money', decimals: 0,
               description: 'Принято минус возвращено; отменённые не считаются' },
  cash:      { label: 'Наличные',   expr: 'sum(cashAmount)',     type: 'money', decimals: 0 },
  card:      { label: 'Карта',      expr: 'sum(cardAmount)',     type: 'money', decimals: 0 },
  transfer:  { label: 'Перевод',    expr: 'sum(transferAmount)', type: 'money', decimals: 0 },
  operations: { label: 'Операций',  expr: 'countIf(isVoided = false)', type: 'int',
                description: 'Без отменённых записей' },
  bookings:  { label: 'Броней',     expr: 'countDistinct(bookingId)', type: 'int' },
  voidedCount:  { label: 'Отменено записей', expr: 'countIf(isVoided = true)', type: 'int' },
  voidedAmount: { label: 'Отменено, сумма',  expr: 'sum(voidedAmount)', type: 'money', decimals: 0 },
  avgPayment: { label: 'Средний платёж', expr: 'sum(receivedAmount) / countIf(kind = \'payment\' and isVoided = false)', type: 'money', decimals: 0 },
}

async function load({ params }) {
  const from = toUTCDate(params.period && params.period.from)
  const to = toUTCDate(params.period && params.period.to)

  // Период по рабочей дате. Платёж без смены (данные из старых выгрузок)
  // отбираем по календарному моменту приёма — иначе он не попал бы никуда.
  const rows = await prisma.payment.findMany({
    where: {
      OR: [
        { businessDate: { gte: from, lt: to } },
        { businessDate: null, paidAt: { gte: from, lt: to } },
      ],
    },
    select: {
      id: true, bookingId: true, kind: true, amount: true, method: true,
      adminName: true, shiftId: true, businessDate: true, paidAt: true,
      comment: true, refundOfId: true, voidedAt: true, voidReason: true,
      voidedBy: { select: { name: true } },
      booking: {
        select: {
          guestName: true, guestPhone: true, checkIn: true, checkOut: true, status: true,
          room: { select: { number: true, building: true, category: { select: { name: true } } } },
          partner: { select: { name: true } },
        },
      },
    },
    orderBy: [{ businessDate: 'asc' }, { paidAt: 'asc' }, { id: 'asc' }],
  })

  return rows.map((p) => {
    const b = p.booking
    const voided = !!p.voidedAt
    const cashDate = p.businessDate || p.paidAt
    const received = !voided && p.kind === 'payment' ? round2(p.amount) : 0
    const refunded = !voided && p.kind === 'refund' ? round2(p.amount) : 0
    const net = round2(received - refunded)
    return {
      id: p.id,
      bookingId: p.bookingId,
      kind: p.kind,
      kindLabel: KIND_LABELS[p.kind] || p.kind,
      method: p.method,
      methodLabel: METHOD_LABELS[p.method] || p.method,
      amount: round2(p.amount),
      businessDate: isoDate(cashDate),
      businessMonth: isoMonth(cashDate),
      weekday: weekdayName(cashDate),
      shiftId: p.shiftId,
      paidAt: p.paidAt,
      paidDate: isoDate(p.paidAt),
      adminName: p.adminName,
      comment: p.comment || '',
      isVoided: voided,
      voidedAt: p.voidedAt,
      voidedByName: (p.voidedBy && p.voidedBy.name) || '',
      voidReason: p.voidReason || '',
      refundOfId: p.refundOfId,
      guestName: b.guestName,
      guestPhone: b.guestPhone || '',
      roomNumber: b.room.number,
      building: b.room.building,
      categoryName: b.room.category.name,
      checkIn: isoDate(b.checkIn),
      checkOut: isoDate(b.checkOut),
      bookingStatus: STATUS_LABELS[b.status] || b.status,
      partnerName: (b.partner && b.partner.name) || '',
      receivedAmount: received,
      refundedAmount: refunded,
      netAmount: net,
      voidedAmount: voided ? round2(p.amount) : 0,
      cashAmount: p.method === 'cash' ? net : 0,
      cardAmount: p.method === 'card' ? net : 0,
      transferAmount: p.method === 'transfer' ? net : 0,
      count: 1,
    }
  })
}

module.exports = {
  id: 'payments',
  requiresPeriod: true,
  label: 'Платежи (касса)',
  description: 'Одна строка — приём оплаты или возврат. Период и день считаются по рабочей дате (смене), '
    + 'а не по часам. Отменённые записи видны, но в суммы не входят.',
  fields,
  metrics,
  load,
  KIND_LABELS,
  METHOD_LABELS,
}
