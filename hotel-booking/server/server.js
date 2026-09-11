// Force UTC timezone BEFORE any date operations or requires.
// Without this, Prisma reads @db.Date as local-midnight which in UTC+5
// serialises one day behind (2026-05-20 → "2026-05-19T19:00:00Z").
process.env.TZ = 'UTC'

require('dotenv').config()
const http = require('http')
const app = require('./src/app')
const { initSocket } = require('./src/socket/socketManager')
const { startBackupScheduler } = require('./src/utils/backup')
const { startAuditRetention } = require('./src/utils/auditRetention')
const { prisma } = require('./src/utils/prisma')
const logger = require('./src/utils/logger')
const { ensureIdentity, getIdentity } = require('./src/utils/instanceIdentity')
const { startResponder } = require('./src/discovery/udpResponder')
const { version: APP_VERSION } = require('./package.json')

const PORT = process.env.PORT || 3001
const HOST = process.env.HOST || '0.0.0.0'

const server = http.createServer(app)

initSocket(server)

/** Ответчик поиска хоста в сети; null — не поднимался (см. DISCOVERY_PORT ниже). */
let responder = null

/**
 * Название отеля для ответа на поиск. Кэш на минуту: ответчик дёргает его на
 * каждый адресный запрос сторожа с любого рабочего места, а меняется название
 * раз в жизни — ходить за ним в базу каждый раз значит платить запросом за
 * чужой UDP-пакет. Ошибка базы — не беда: ответим без названия.
 */
const HOTEL_NAME_TTL_MS = 60 * 1000
// Кэшируем ОБЕЩАНИЕ, а не значение: широковещательный запрос приходит по одной
// датаграмме на каждый сетевой интерфейс хоста, то есть два-три раза подряд в
// одну миллисекунду. С кэшем значения второй запрос заставал бы первый поход в
// базу незавершённым и уходил бы без названия (ловили на живой проверке).
let hotelNamePromise = null
let hotelNameAt = 0
function getHotelName() {
  // Окно считается от попытки, а не от удачи: при лежащей базе иначе каждый
  // запрос сторожа добавлял бы ей ещё один заведомо неудачный.
  if (hotelNamePromise && Date.now() - hotelNameAt < HOTEL_NAME_TTL_MS) return hotelNamePromise
  hotelNameAt = Date.now()
  hotelNamePromise = prisma.hotelSettings
    .findUnique({ where: { id: 1 }, select: { name: true } })
    .then((row) => row?.name || null)
    .catch(() => null)   // база лежит — отвечаем без названия, поиск хоста это переживёт
  return hotelNamePromise
}

server.listen(PORT, HOST, async () => {
  logger.info(`Server running on http://${HOST}:${PORT}`)
  startBackupScheduler()
  // Чистка журнала действий — после копий: расписание 03:30 намеренно стоит
  // за ночной копией в 03:00 (D1-007).
  startAuditRetention(prisma)

  // Личность установки (по ней рабочие места находят свой хост). Старт сервера
  // от неё не зависит: не получилось — сеть просто не найдёт хост автоматически,
  // а адрес всегда можно вписать руками. Ронять из-за этого отель нельзя.
  // Если база лежала на старте (надзор Electron поднимает сервер раньше, чем
  // Postgres очнётся после сбоя), одной попытки мало: на свежей установке личность
  // не появилась бы до перезапуска. Пробуем раз в минуту, пока не получится.
  const IDENTITY_RETRY_MS = 60 * 1000
  const identityAttempt = async () => {
    try {
      if (await ensureIdentity(prisma)) return
      logger.warn('instance: личность установки не записана — повторю через минуту')
    } catch (err) {
      logger.warn(`instance: личность установки недоступна (${err && err.message}) — повторю через минуту`)
    }
    setTimeout(identityAttempt, IDENTITY_RETRY_MS).unref()
  }
  await identityAttempt()

  // Ответчик включается ТОЛЬКО по явному DISCOVERY_PORT — его задаёт Electron в
  // режиме хоста. В dev и на рабочем месте-клиенте лишний слушающий UDP-порт
  // никому не нужен.
  if (process.env.DISCOVERY_PORT) {
    try {
      responder = startResponder({
        port: Number(process.env.DISCOVERY_PORT),
        // Не «личность на момент старта», а живая: у неё свой кэш с TTL, и после
        // восстановления копии ответчик подхватит новую личность сам.
        getIdentity: () => getIdentity(prisma),
        getHotelName,
        serverPort: Number(PORT),
        version: APP_VERSION,
        logger,
      })
      logger.info(`Поиск хоста в сети: UDP ${process.env.DISCOVERY_PORT}`)
    } catch (err) {
      logger.warn(`discovery: ответчик не запущен: ${err && err.message}`)
    }
  }
})

server.on('error', (err) => {
  // Занятый порт — не «ошибка сервера», а конфликт с другой программой, и
  // перезапускать нас бесполезно: порт от этого не освободится. Отдельный код
  // выхода 3 нужен надзору Electron, чтобы не уйти в цикл перезапусков, а
  // показать человеку, что порт занят.
  if (err && err.code === 'EADDRINUSE') {
    logger.error(`Порт ${PORT} занят другой программой`)
    process.exit(3)
  }
  logger.error('Server error:', err)
  process.exit(1)
})

// Штатная остановка (Electron гасит сервер при выходе, в терминале — Ctrl+C).
// Единственное, что здесь нужно сделать руками, — отпустить UDP-порт: сокет
// живёт вне http-сервера, и без close() он держал бы порт до конца процесса.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    try { responder?.close() } catch { /* уже закрыт */ }
    process.exit(0)
  })
}

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', reason)
})

// Необработанное исключение (D8-006). Без этого обработчика Node печатает стек
// и умирает мгновенно — а сервер запущен дочерним процессом Electron, и его
// stderr идёт в host-debug.log. Поэтому сначала пишем стек НАПРЯМУЮ в stderr
// (winston при полном диске сам может не записаться), потом пробуем в журнал, и
// только затем выходим с задержкой: без неё асинхронная запись файла не успеет,
// и причина падения не попадёт никуда. Выход обязателен — процесс после
// необработанного исключения в неизвестном состоянии, надзор Electron поднимет
// сервер заново.
process.on('uncaughtException', (err) => {
  try {
    process.stderr.write(`[uncaughtException] ${(err && (err.stack || err.message)) || String(err)}\n`)
  } catch { /* stderr тоже может быть недоступен */ }
  try { logger.error('Uncaught exception:', err) } catch { /* журнал недоступен */ }
  setTimeout(() => process.exit(1), 500)
})
