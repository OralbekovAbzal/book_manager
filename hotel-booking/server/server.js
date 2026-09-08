// Force UTC timezone BEFORE any date operations or requires.
// Without this, Prisma reads @db.Date as local-midnight which in UTC+5
// serialises one day behind (2026-05-20 → "2026-05-19T19:00:00Z").
process.env.TZ = 'UTC'

require('dotenv').config()
const http = require('http')
const app = require('./src/app')
const { initSocket } = require('./src/socket/socketManager')
const { startBackupScheduler } = require('./src/utils/backup')
const logger = require('./src/utils/logger')

const PORT = process.env.PORT || 3001
const HOST = process.env.HOST || '0.0.0.0'

const server = http.createServer(app)

initSocket(server)

server.listen(PORT, HOST, () => {
  logger.info(`Server running on http://${HOST}:${PORT}`)
  startBackupScheduler()
})

server.on('error', (err) => {
  logger.error('Server error:', err)
  process.exit(1)
})

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
