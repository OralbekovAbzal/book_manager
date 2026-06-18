const { Server } = require('socket.io')
const jwt = require('jsonwebtoken')
const logger = require('../utils/logger')

let io

function initSocket(server) {
  io = new Server(server, {
    cors: {
      origin: process.env.CLIENT_ORIGIN || ['http://localhost:5173', 'http://localhost:3000'],
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

function emitBookingEvent(event, data) {
  // Инвалидируем кэш сетки при любом изменении брони
  const { invalidateGridCache } = require('../controllers/occupancyController')
  invalidateGridCache()

  // Автоснимок состояния (дебаунс внутри — несколько событий схлопываются в один снимок)
  try {
    const { scheduleAuto } = require('../utils/snapshot')
    scheduleAuto(EVENT_LABELS[event] || 'Изменение брони')
  } catch { /* snapshot недоступен — не критично */ }

  getIO().to('bookings').emit(event, data)
}

module.exports = { initSocket, getIO, emitBookingEvent }
