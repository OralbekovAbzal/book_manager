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
