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
