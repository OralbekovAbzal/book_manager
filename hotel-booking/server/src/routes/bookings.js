const router = require('express').Router()
const { body, query, param } = require('express-validator')
const ctrl = require('../controllers/bookingController')
const { authenticate, requireRole } = require('../middleware/auth')
const { validate } = require('../middleware/validate')

router.use(authenticate)

const SOURCES = ['телефон', 'стойка', 'онлайн', 'Каспи', 'ремонт', null]

// Счётчики гостей, проценты, суммы, метки, смена, статус — общие для POST и PUT.
// express-validator 7 приводит значение к строке перед isInt/isFloat, поэтому числа из JSON
// проходят проверку; мусор ("abc", -3, 150%) отсекается здесь, а не падает в Prisma с 500.
const GUEST_COUNTERS = [
  'adultsWithMeals', 'childrenWithMeals', 'adultsNoMeals', 'childrenNoMeals',
  'extraBedsWithMeals', 'extraBedsNoMeals', 'disabledAdults', 'disabledChildren',
]
const bookingNumericRules = [
  body(GUEST_COUNTERS).optional({ nullable: true }).isInt({ min: 0, max: 99 })
    .withMessage('Количество гостей должно быть целым числом от 0 до 99'),
  body(['discountPercent', 'prepaymentPercent']).optional().isFloat({ min: 0, max: 100 })
    .withMessage('Процент должен быть числом от 0 до 100'),
  body(['totalAmount', 'prepaidAmount', 'paidAmount']).optional().isFloat({ min: 0 })
    .withMessage('Сумма должна быть неотрицательным числом'),
  body('flags').optional().isArray().withMessage('flags должен быть массивом строк'),
  body('flags.*').isString().isLength({ max: 60 }).withMessage('Метка — строка до 60 символов'),
  body('shiftId').optional({ nullable: true }).isInt({ min: 1 }).withMessage('shiftId должен быть целым числом'),
  body('status').optional().isIn(['CONFIRMED', 'CHECKED_IN']).withMessage('Недопустимый статус'),
  // Осознанное подтверждение продажи номера из квоты партнёра (409 ALLOTMENT_CONFLICT)
  body('allowAllotmentOverride').optional().isBoolean().withMessage('allowAllotmentOverride — да/нет'),
  // Явное «Пересчитать по тарифу»: пересобрать автоматические строки начислений
  body('recalcCharges').optional().isBoolean().withMessage('recalcCharges — да/нет'),
]

const bookingBodyRules = [
  body('roomId').isInt({ min: 1 }).withMessage('roomId обязателен').toInt(),
  body('guestName').trim().notEmpty().withMessage('Имя гостя обязательно').isLength({ max: 100 }),
  body('guestPhone').optional({ nullable: true }).trim().isLength({ max: 30 }),
  body('checkIn').isDate().withMessage('checkIn обязателен (YYYY-MM-DD)'),
  body('checkOut').isDate().withMessage('checkOut обязателен (YYYY-MM-DD)'),
  body('source').optional({ nullable: true }).isIn(SOURCES).withMessage('Недопустимый источник брони'),
  body('notes').optional({ nullable: true }).isLength({ max: 1000 }),
  ...bookingNumericRules,
]

// PUT — все поля необязательные, но если пришли — проверяются так же, как при создании
const bookingUpdateRules = [
  body('roomId').optional().isInt({ min: 1 }).withMessage('roomId должен быть целым числом').toInt(),
  body('guestName').optional().trim().notEmpty().withMessage('Имя гостя не может быть пустым').isLength({ max: 100 }),
  body('guestPhone').optional({ nullable: true }).trim().isLength({ max: 30 }),
  body('checkIn').optional().isDate().withMessage('checkIn в формате YYYY-MM-DD'),
  body('checkOut').optional().isDate().withMessage('checkOut в формате YYYY-MM-DD'),
  body('source').optional({ nullable: true }).isIn(SOURCES).withMessage('Недопустимый источник брони'),
  body('notes').optional({ nullable: true }).isLength({ max: 1000 }),
  ...bookingNumericRules,
]

const availabilityRules = [
  body('roomId').isInt({ min: 1 }).withMessage('roomId обязателен'),
  body('checkIn').isDate().withMessage('checkIn обязателен (YYYY-MM-DD)'),
  body('checkOut').isDate().withMessage('checkOut обязателен (YYYY-MM-DD)'),
  body('excludeBookingId').optional({ nullable: true }).isInt().withMessage('excludeBookingId должен быть целым числом'),
]

const listRules = [
  query('dateFrom').optional().isDate(),
  query('dateTo').optional().isDate(),
  query('roomId').optional().isInt(),
  query('status').optional().isIn(['CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'CANCELLED', 'NO_SHOW']),
  query('categoryId').optional().isInt(),
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 500 }),
]

router.get('/', listRules, validate, ctrl.list)
router.post('/check-availability', availabilityRules, validate, ctrl.checkAvailability)
router.post('/', bookingBodyRules, validate, ctrl.create)
router.get('/:id', param('id').isInt(), validate, ctrl.getOne)
router.put('/:id', param('id').isInt(), bookingUpdateRules, validate, ctrl.update)
router.delete('/:id', param('id').isInt(), validate, ctrl.cancel)
router.patch('/:id/checkin', param('id').isInt(), validate, ctrl.checkIn)
router.patch('/:id/checkout', param('id').isInt(), validate, ctrl.checkOut)
router.post('/:id/move',
  param('id').isInt(),
  body('newRoomId').isInt({ min: 1 }),
  body('moveDate').isDate(),
  validate, ctrl.move)

// ─── Начисления брони ────────────────────────────────────────────────────────
// Итог брони = сумма строк. Ручная строка обязана нести причину: именно она
// превращает уступку «беру полсуток» из устной договорённости в запись.

const CHARGE_KINDS = ['stay', 'meal', 'extra', 'discount']

const chargeMoneyRules = [
  body('quantity').optional().isFloat({ min: 0 }).withMessage('Количество — неотрицательное число'),
  body('unitPrice').optional().isFloat({ min: -100000000, max: 100000000 }).withMessage('Цена должна быть числом'),
  body('date').optional({ nullable: true }).isDate().withMessage('Дата начисления в формате YYYY-MM-DD'),
  body('reason').trim().notEmpty().withMessage('Укажите причину — без неё строка не сохраняется')
    .isLength({ max: 300 }).withMessage('Причина — до 300 символов'),
]

const chargeCreateRules = [
  body('kind').isIn(CHARGE_KINDS).withMessage('Недопустимый вид начисления'),
  body('label').trim().notEmpty().withMessage('Укажите название строки').isLength({ max: 200 }),
  ...chargeMoneyRules,
]

const chargeUpdateRules = [
  body('kind').optional().isIn(CHARGE_KINDS).withMessage('Недопустимый вид начисления'),
  body('label').optional().trim().notEmpty().withMessage('Название строки не может быть пустым').isLength({ max: 200 }),
  ...chargeMoneyRules,
]

router.get('/:id/charges', param('id').isInt(), validate, ctrl.listCharges)
router.post('/:id/charges/rebuild', param('id').isInt(), validate, ctrl.rebuildCharges)
router.post('/:id/charges', param('id').isInt(), chargeCreateRules, validate, ctrl.addCharge)
router.put('/:id/charges/:chargeId',
  param('id').isInt(), param('chargeId').isInt(), chargeUpdateRules, validate, ctrl.updateCharge)
router.delete('/:id/charges/:chargeId',
  param('id').isInt(), param('chargeId').isInt(), validate, ctrl.removeCharge)

module.exports = router
