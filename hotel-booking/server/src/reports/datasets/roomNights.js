const { prisma } = require('../../utils/prisma')
const { isoDate, isoMonth, weekdayName, toUTCDate, eachNight, daysBetween } = require('../dateUtils')
const { createError } = require('../../middleware/errorHandler')

/**
 * Датасет «Номеро-ночи»: одна строка = (номер, ночь).
 *
 * Разворачиваем брони в ночи намеренно: загрузка по дням, по категориям и по
 * корпусам — это один и тот же куб с разной группировкой, а не три отчёта.
 *
 * Три взаимоисключающих состояния ночи:
 *   sold    — занята гостем;
 *   blocked — ремонт (source = 'ремонт'): номер занят, но это не продажа;
 *   free    — свободна.
 * Доступный фонд = всё минус ремонт, поэтому загрузка = sold / available.
 */

const MAX_DAYS = 400

const STATE_OPTIONS = [
  { value: 'sold', label: 'Продано' },
  { value: 'blocked', label: 'Ремонт' },
  { value: 'free', label: 'Свободно' },
]

const fields = {
  date:        { label: 'Дата',        type: 'date',  groupable: true },
  month:       { label: 'Месяц',       type: 'month', groupable: true },
  weekday:     { label: 'День недели', type: 'text',  groupable: true },
  roomNumber:  { label: 'Номер',       type: 'text',  groupable: true },
  building:    { label: 'Корпус',      type: 'text',  groupable: true, optionsFrom: 'buildings' },
  floor:       { label: 'Этаж',        type: 'int',   groupable: true, optionsFrom: 'floors' },
  categoryName:{ label: 'Категория',   type: 'text',  groupable: true, optionsFrom: 'categories' },
  capacity:    { label: 'Вместимость', type: 'text',  groupable: true },
  state:       { label: 'Состояние',   type: 'text',  groupable: true, options: STATE_OPTIONS },
  guestName:   { label: 'Гость',       type: 'text' },
  source:      { label: 'Источник',    type: 'text',  groupable: true, optionsFrom: 'sources' },
  partnerName: { label: 'Партнёр',     type: 'text',  groupable: true, optionsFrom: 'partners' },
  bookingId:   { label: '№ брони',     type: 'int' },
  isSold:      { label: 'Продано (0/1)',     type: 'int', synthetic: true },
  isBlocked:   { label: 'Ремонт (0/1)',      type: 'int', synthetic: true },
  isFree:      { label: 'Свободно (0/1)',    type: 'int', synthetic: true },
  isAvailable: { label: 'Доступно (0/1)',    type: 'int', synthetic: true },
  count:       { label: 'Всего ночей', type: 'int', synthetic: true },
}

const metrics = {
  sold:      { label: 'Продано, ночей',   expr: 'sum(isSold)',      type: 'int' },
  blocked:   { label: 'Ремонт, ночей',    expr: 'sum(isBlocked)',   type: 'int' },
  free:      { label: 'Свободно, ночей',  expr: 'sum(isFree)',      type: 'int' },
  available: { label: 'Доступно, ночей',  expr: 'sum(isAvailable)', type: 'int',
               description: 'Все ночи минус ремонт' },
  occupancy: { label: 'Загрузка, %',      expr: 'sum(isSold) / sum(isAvailable) * 100', type: 'percent', decimals: 1,
               description: 'Продано / доступно. Ремонт не входит в доступный фонд' },
  blockedShare: { label: 'Доля ремонта, %', expr: 'sum(isBlocked) / count() * 100', type: 'percent', decimals: 1 },
  rooms:     { label: 'Номеров',          expr: 'countDistinct(roomNumber)', type: 'int' },
  nightsTotal: { label: 'Всего ночей',    expr: 'count()',          type: 'int' },
}

async function load({ params }) {
  const from = toUTCDate(params.period && params.period.from)
  const to = toUTCDate(params.period && params.period.to)
  const span = daysBetween(from, to)
  if (span <= 0) throw createError('Период пуст: дата «по» должна быть позже даты «с»', 400)
  if (span > MAX_DAYS) {
    throw createError(`Слишком длинный период: ${span} дн. Максимум ${MAX_DAYS} дн.`, 400)
  }

  const [rooms, bookings] = await Promise.all([
    prisma.room.findMany({
      where: { isActive: true },
      select: {
        id: true, number: true, building: true, floor: true, capacity: true,
        category: { select: { name: true } },
      },
      orderBy: [{ building: 'asc' }, { floor: 'asc' }, { number: 'asc' }],
    }),
    prisma.booking.findMany({
      where: {
        status: { notIn: ['CANCELLED', 'NO_SHOW'] },
        checkIn: { lt: to },
        checkOut: { gt: from },
      },
      select: {
        id: true, roomId: true, guestName: true, source: true, checkIn: true, checkOut: true,
        partner: { select: { name: true } },
      },
    }),
  ])

  // roomId → { 'YYYY-MM-DD': бронь }. Раскладываем брони по ночам один раз,
  // иначе на каждую клетку пришлось бы искать по всему списку.
  const byRoom = new Map()
  for (const b of bookings) {
    let nights = byRoom.get(b.roomId)
    if (!nights) { nights = new Map(); byRoom.set(b.roomId, nights) }
    eachNight(b.checkIn, b.checkOut, (d) => {
      if (d < from || d >= to) return
      nights.set(isoDate(d), b)
    })
  }

  const rows = []
  for (const room of rooms) {
    const nights = byRoom.get(room.id)
    eachNight(from, to, (d) => {
      const key = isoDate(d)
      const b = nights ? nights.get(key) : null
      const blocked = !!b && b.source === 'ремонт'
      const sold = !!b && !blocked
      rows.push({
        date: key,
        month: isoMonth(d),
        weekday: weekdayName(d),
        roomNumber: room.number,
        building: room.building,
        floor: room.floor,
        categoryName: room.category.name,
        capacity: room.capacity || '',
        state: blocked ? 'blocked' : sold ? 'sold' : 'free',
        guestName: sold ? b.guestName : '',
        source: (b && b.source) || '',
        partnerName: (b && b.partner && b.partner.name) || '',
        bookingId: b ? b.id : null,
        isSold: sold ? 1 : 0,
        isBlocked: blocked ? 1 : 0,
        isFree: b ? 0 : 1,
        isAvailable: blocked ? 0 : 1,
        count: 1,
      })
    })
  }
  return rows
}

module.exports = {
  id: 'roomNights',
  requiresPeriod: true,
  label: 'Номеро-ночи',
  description: 'Одна строка — номер за одну ночь. Ремонт не входит в доступный фонд.',
  fields,
  metrics,
  load,
  MAX_DAYS,
}
