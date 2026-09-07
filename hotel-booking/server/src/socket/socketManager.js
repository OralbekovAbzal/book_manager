const { Server } = require('socket.io')
const jwt = require('jsonwebtoken')
const { prisma } = require('../utils/prisma')
const logger = require('../utils/logger')
const { corsOrigin } = require('../utils/corsOrigin')

let io

/** Открытые сокеты по сотрудникам: adminId → Set<socket>. Нужен, чтобы разорвать
 *  соединения деактивированного сотрудника, не дожидаясь истечения его токена. */
const socketsByAdmin = new Map()

/** Как часто перепроверять активность уже подключённых (страховка на случай,
 *  если сотрудника выключили мимо API — например, правкой в базе). */
const RECHECK_MS = 5 * 60 * 1000

function trackSocket(socket) {
  const id = socket.admin.id
  if (!socketsByAdmin.has(id)) socketsByAdmin.set(id, new Set())
  socketsByAdmin.get(id).add(socket)
}

function untrackSocket(socket) {
  const id = socket.admin?.id
  const set = socketsByAdmin.get(id)
  if (!set) return
  set.delete(socket)
  if (!set.size) socketsByAdmin.delete(id)
}

/**
 * Рвёт все соединения сотрудника. Вызывается при деактивации: REST он теряет
 * сразу (middleware/auth ходит в базу на каждом запросе), а сокет без этого
 * продолжал бы слать обновления сетки до истечения токена — до восьми часов.
 * Клиент после разрыва попробует переподключиться и получит отказ в handshake.
 */
function dropSocket(socket, reason) {
  // Сообщаем причину до разрыва: клиент показывает её на экране входа
  try { socket.emit('auth:revoked', { reason }) } catch { /* сокет уже мёртв */ }
  socket.disconnect(true)
}

function disconnectAdmin(adminId, reason = 'account_disabled') {
  const set = socketsByAdmin.get(Number(adminId))
  if (!set || !set.size) return 0
  const n = set.size
  for (const socket of [...set]) dropSocket(socket, reason)
  logger.info(`Socket: разорвано ${n} соединение(й) сотрудника ${adminId} (${reason})`)
  return n
}

/** Периодическая перепроверка подключённых — один запрос на всех: учётку
 *  выключили или версию сессии подняли мимо API (правкой в базе). */
async function recheckConnectedAdmins() {
  const ids = [...socketsByAdmin.keys()]
  if (!ids.length) return
  try {
    const admins = await prisma.admin.findMany({
      where: { id: { in: ids } },
      select: { id: true, isActive: true, tokenVersion: true },
    })
    const byId = new Map(admins.map((a) => [a.id, a]))
    for (const id of ids) {
      const a = byId.get(id)
      if (!a || !a.isActive) { disconnectAdmin(id); continue }
      for (const socket of [...(socketsByAdmin.get(id) || [])]) {
        if (socket.tokenVersion !== a.tokenVersion) dropSocket(socket, 'session_revoked')
      }
    }
  } catch (err) {
    // Сбой базы не должен рвать живые соединения — просто ждём следующего круга
    logger.error(`Socket: перепроверка активности не удалась — ${err.message}`)
  }
}

function initSocket(server) {
  io = new Server(server, {
    cors: {
      origin: corsOrigin,
      credentials: true,
    },
  })

  // Handshake проверяет ровно то же, что REST (middleware/auth.js): подпись токена
  // И актуальное состояние учётной записи. Одного jwt.verify мало — деактивированный
  // сотрудник по старому токену продолжал получать realtime.
  // В базу ходим ТОЛЬКО здесь, на установке соединения, а не на каждое сообщение.
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token
    if (!token) return next(new Error('Unauthorized'))

    let payload
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET)
    } catch {
      return next(new Error('Invalid token'))
    }

    let admin
    try {
      admin = await prisma.admin.findUnique({
        where: { id: payload.id },
        select: { id: true, username: true, name: true, role: true, isActive: true, tokenVersion: true },
      })
    } catch (err) {
      // Сбой базы — не «неверный токен»: клиент сам переподключится позже.
      logger.error(`Socket handshake: ошибка запроса к базе — ${err.message}`)
      return next(new Error('Server unavailable'))
    }

    if (!admin || !admin.isActive) return next(new Error('Unauthorized'))
    // Та же проверка версии сессии, что в middleware/auth.js: отозванный
    // токен не должен открыть сокет и получать обновления сетки.
    if ((payload.tv ?? 0) !== admin.tokenVersion) return next(new Error('Session revoked'))

    socket.admin = { id: admin.id, username: admin.username, name: admin.name, role: admin.role }
    socket.tokenVersion = admin.tokenVersion
    next()
  })

  io.on('connection', (socket) => {
    logger.info(`Socket connected: admin ${socket.admin.id}`)
    trackSocket(socket)
    socket.join('bookings')

    socket.on('disconnect', () => {
      untrackSocket(socket)
      logger.info(`Socket disconnected: admin ${socket.admin.id}`)
    })
  })

  // Страховка: сотрудника могли выключить мимо API. unref, чтобы таймер
  // не держал процесс живым при остановке сервера.
  const timer = setInterval(recheckConnectedAdmins, RECHECK_MS)
  if (typeof timer.unref === 'function') timer.unref()

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

module.exports = {
  initSocket, getIO, emitBookingEvent, emitShiftChanged, emitReportsChanged,
  disconnectAdmin,
}
