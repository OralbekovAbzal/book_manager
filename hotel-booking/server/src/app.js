const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const { rateLimit } = require('express-rate-limit')

const authRoutes = require('./routes/auth')
const bookingRoutes = require('./routes/bookings')
const roomRoutes = require('./routes/rooms')
const categoryRoutes = require('./routes/categories')
const occupancyRoutes = require('./routes/occupancy')
const reportRoutes = require('./routes/reports')
const systemRoutes = require('./routes/system')
const licenseRoutes = require('./routes/license')
const shiftRoutes = require('./routes/shifts')
const auditRoutes = require('./routes/audit')
const partnerRoutes = require('./routes/partners')
const allotmentRoutes = require('./routes/allotments')
const snapshotRoutes = require('./routes/snapshots')
const bookingFlagRoutes = require('./routes/bookingFlags')
const contactRoutes = require('./routes/contacts')
const roomFundRoutes = require('./routes/roomFund')
const guestRoutes = require('./routes/guests')
const hotelRoutes = require('./routes/hotel')
const rateRoutes = require('./routes/rates')
const serviceRoutes = require('./routes/services')
const paymentRoutes = require('./routes/payments')
const setupRoutes = require('./routes/setup')
const userRoutes = require('./routes/users')

const { errorHandler } = require('./middleware/errorHandler')
const { auditMiddleware } = require('./middleware/audit')
const logger = require('./utils/logger')

const app = express()

app.use(helmet())

// CORS под desktop/LAN-модель (детали и обоснование — в utils/corsOrigin.js).
const { corsOrigin } = require('./utils/corsOrigin')
app.use(cors({ origin: corsOrigin, credentials: true }))
// Перенос на новый ноутбук: файл копии приходит целым JSON-документом (сотня
// броней с платежами — единицы-десятки мегабайт), поэтому у ЭТОГО пути свой
// парсер и свой лимит. Он обязан стоять ДО общего `express.json({ limit: '1mb' })`:
// иначе тело прочитал бы тот и отказал по лимиту раньше, чем дело дойдёт до роута.
// `type: () => true` — содержимое файла шлют и как application/json, и как text/plain.
app.use('/api/system/backup/upload', express.json({ limit: '200mb', type: () => true }))
// Ошибки этого парсера переводим на человеческий здесь же: до errorHandler они
// доедут как SyntaxError без объяснения, что именно не так с файлом.
app.use('/api/system/backup/upload', (err, _req, res, next) => {
  if (!err) return next()
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Файл копии слишком большой (максимум 200 МБ)' })
  }
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'Это не файл резервной копии Qonaq' })
  }
  return next(err)
})

app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: true }))

app.use((req, _res, next) => {
  logger.info(`${req.method} ${req.url}`)
  next()
})

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 20 : 500,
  message: { error: 'Слишком много попыток входа. Попробуйте через 15 минут.' },
})

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 500 : 10000,
})

// Гейт обслуживания: ДО журнала и роутов. Если обслуживание кончилось раньше даты
// выпуска этой сборки — всё, кроме health/license/login, отвечает 402 (middleware/license.js).
const { maintenanceGate } = require('./middleware/license')
app.use(maintenanceGate)

// Журнал действий: ДО роутов, чтобы перехватить ответ любого из них (см. middleware/audit.js)
app.use('/api', auditMiddleware)

app.use('/api/auth', authLimiter, authRoutes)
app.use('/api/bookings', apiLimiter, bookingRoutes)
app.use('/api/rooms', apiLimiter, roomRoutes)
app.use('/api/categories', apiLimiter, categoryRoutes)
app.use('/api/occupancy', apiLimiter, occupancyRoutes)
app.use('/api/reports', apiLimiter, reportRoutes)
app.use('/api/system', apiLimiter, systemRoutes)
app.use('/api/license', apiLimiter, licenseRoutes)
app.use('/api/shifts', apiLimiter, shiftRoutes)
app.use('/api/audit', apiLimiter, auditRoutes)
app.use('/api/partners', apiLimiter, partnerRoutes)
app.use('/api/allotments', apiLimiter, allotmentRoutes)
app.use('/api/snapshots', apiLimiter, snapshotRoutes)
app.use('/api/booking-flags', apiLimiter, bookingFlagRoutes)
app.use('/api/contacts', apiLimiter, contactRoutes)
app.use('/api/room-fund', apiLimiter, roomFundRoutes)
app.use('/api/guests', apiLimiter, guestRoutes)
app.use('/api/hotel', apiLimiter, hotelRoutes)
app.use('/api/rates', apiLimiter, rateRoutes)
app.use('/api/services', apiLimiter, serviceRoutes)
app.use('/api/payments', apiLimiter, paymentRoutes)
// Мастер первичной настройки — публичный (без authenticate), см. routes/setup.js.
app.use('/api/setup', apiLimiter, setupRoutes)
app.use('/api/users', apiLimiter, userRoutes)

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

app.use(errorHandler)

module.exports = app
