const router = require('express').Router()
const { query } = require('express-validator')
const ctrl = require('../controllers/occupancyController')
const optimizeCtrl = require('../controllers/optimizeController')
const { authenticate, requireRole } = require('../middleware/auth')
const { validate } = require('../middleware/validate')
const { requireFeature } = require('../utils/features')

router.use(authenticate)

router.get(
  '/grid',
  [
    query('dateFrom').optional().isDate(),
    query('dateTo').optional().isDate(),
    // parseInt('abc') → NaN в where → Prisma падал с 500
    query('floor').optional().isInt().withMessage('floor должен быть целым числом'),
    query('categoryId').optional().isInt().withMessage('categoryId должен быть целым числом'),
  ],
  validate,
  ctrl.grid
)
router.get('/stats', query('date').optional().isDate(), validate, ctrl.stats)
router.get('/today', ctrl.today)
router.get(
  '/availability',
  [
    query(['checkIn', 'checkOut']).isDate().withMessage('Дата должна быть в формате YYYY-MM-DD'),
    query('excludeBookingId').optional().isInt().withMessage('excludeBookingId должен быть целым числом'),
    // Метки будущей брони и её партнёр влияют на «свободно» так же, как при
    // создании: буфер меток и квота партнёра. Оба параметра необязательные.
    query('flags').optional().isString(),
    query('partnerId').optional().isInt(),
  ],
  validate,
  ctrl.roomAvailability
)

// optimize и applyOptimization читают тело — нужен express.json (он подключён глобально).
// Оптимизатор в 1.0 закрыт (utils/features.js): без FEATURE_PREVIEW оба пути отвечают 404.
router.post('/optimize', requireFeature('optimizer'), optimizeCtrl.optimize)
router.post('/optimize/apply', requireFeature('optimizer'), requireRole('SUPER_ADMIN', 'ADMIN'), optimizeCtrl.applyOptimization)

module.exports = router
