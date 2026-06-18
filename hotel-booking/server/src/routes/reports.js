const router = require('express').Router()
const { query } = require('express-validator')
const ctrl = require('../controllers/reportController')
const { authenticate, requireRole } = require('../middleware/auth')
const { validate } = require('../middleware/validate')

router.use(authenticate)

const dateRangeRules = [
  query('dateFrom').isDate().withMessage('dateFrom обязателен (YYYY-MM-DD)'),
  query('dateTo').isDate().withMessage('dateTo обязателен (YYYY-MM-DD)'),
]

router.get('/occupancy', dateRangeRules, validate, ctrl.occupancy)
router.get('/bookings', dateRangeRules, validate, ctrl.bookings)
router.get('/revenue', (_req, res) => res.json({ message: 'TODO: revenue report' }))
router.get('/export', (_req, res) => res.status(501).json({ message: 'TODO: Excel export' }))

module.exports = router
