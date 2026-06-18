const router = require('express').Router()
const { query } = require('express-validator')
const ctrl = require('../controllers/occupancyController')
const optimizeCtrl = require('../controllers/optimizeController')
const { authenticate } = require('../middleware/auth')
const { validate } = require('../middleware/validate')

router.use(authenticate)

router.get(
  '/grid',
  [query('dateFrom').optional().isDate(), query('dateTo').optional().isDate()],
  validate,
  ctrl.grid
)
router.get('/stats', query('date').optional().isDate(), validate, ctrl.stats)
router.get('/today', ctrl.today)
router.get('/availability', ctrl.roomAvailability)

// optimize и applyOptimization читают тело — нужен express.json (он подключён глобально)
router.post('/optimize', optimizeCtrl.optimize)
router.post('/optimize/apply', optimizeCtrl.applyOptimization)

module.exports = router
