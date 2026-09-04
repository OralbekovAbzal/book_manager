const { Server } = require('socket.io')
const jwt = require('jsonwebtoken')
const logger = require('../utils/logger')
const { corsOrigin } = require('../utils/corsOrigin')

let io

function initSocket(server) {
  io = new Server(server, {
    cors: {
      origin: corsOrigin,
      credentials: true,
    },
  })

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token
    if (!token) return next(new Error('Unauthorized'))
    try {
      socket.admin = jwt.verify(token, process.env.JWT_SECRET)
      next()
    } catch {
      next(new Error('Invalid token'))
    }
  })

  io.on('connection', (socket) => {
    logger.info(`Socket connected: admin ${socket.admin.id}`)
    socket.join('bookings')

    socket.on('disconnect', () => {
      logger.info(`Socket disconnected: admin ${socket.admin.id}`)
    })
  })

  return io
}

function getIO() {
  if (!io) throw new Error('Socket.io not initialized')
  return io
}

const EVENT_LABELS = {
  'booking:created':   'Создание брони',
  'booking:updated':   'Изменение брони',
  'booking:cancelled': 'Удаление брони',
  'booking:checkin':   'Заезд гостя',
  'booking:checkout':  'Выезд гостя',
}

/**
 * Приводит payload к единой форме { booking, ... } с гарантированным booking.roomId.
 * Клиент деструктурирует ({ booking }) и вставляет бронь в строку по booking.roomId —
 * «голая» бронь без обёртки или бронь без roomId на втором рабочем месте терялась.
 */
function normalizeBookingPayload(data) {
  if (!data || typeof data !== 'object') return data
  let payload = data
  // Бронь передали без обёртки (есть id и guestName) — оборачиваем
  if (payload.booking === undefined && payload.id != null && payload.guestName != null) {
    payload = { booking: payload }
  }
  const b = payload.booking
  if (b && typeof b === 'object' && b.roomId == null && b.room?.id != null) {
    payload = { ...payload, booking: { ...b, roomId: b.room.id } }
  }
  return payload
}

function emitBookingEvent(event, data) {
  // Инвалидируем кэш сетки при любом изменении брони
  const { invalidateGridCache } = require('../controllers/occupancyController')
  invalidateGridCache()

  // Автоснимок состояния (дебаунс внутри — несколько событий схлопываются в один снимок)
  try {
    const { scheduleAuto } = require('../utils/snapshot')
    scheduleAuto(EVENT_LABELS[event] || 'Изменение брони')
  } catch { /* snapshot недоступен — не критично */ }

  getIO().to('bookings').emit(event, normalizeBookingPayload(data))
}

/** Смена рабочего дня — остальные рабочие места перецентрируют сетку на новую дату. */
function emitShiftChanged(shift) {
  getIO().to('bookings').emit('shift:changed', { shift: { id: shift.id, date: shift.date } })
}

/** Список отчётов изменился (создан/изменён/удалён/импортирован) — остальные рабочие места перечитывают его. */
function emitReportsChanged() {
  getIO().to('bookings').emit('reports:changed', {})
}

module.exports = { initSocket, getIO, emitBookingEvent, emitShiftChanged, emitReportsChanged }
