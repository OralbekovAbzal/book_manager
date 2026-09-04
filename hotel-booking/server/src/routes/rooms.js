const router = require('express').Router()
const { body, query, param } = require('express-validator')
const ctrl = require('../controllers/roomController')
const { authenticate, requireRole } = require('../middleware/auth')
const { validate } = require('../middleware/validate')

router.use(authenticate)

const createRules = [
  body('number').trim().notEmpty().withMessage('Номер комнаты обязателен'),
  body('categoryId').isInt({ min: 1 }).withMessage('categoryId обязателен'),
  body('building').trim().notEmpty().withMessage('Корпус обязателен'),
  body('floor').isInt({ min: 1, max: 50 }).withMessage('Этаж обязателен'),
  body('features').optional().isArray(),
]

router.get('/', ctrl.list)
router.get(
  '/availability',
  [
    query(['checkIn', 'checkOut']).isDate(),
    // Метки будущей брони и её партнёр влияют на «свободно» так же, как при
    // создании: буфер меток и квота партнёра. Оба параметра необязательные.
    query('flags').optional().isString(),
    query('partnerId').optional().isInt(),
    query('excludeBookingId').optional().isInt(),
  ],
  validate,
  ctrl.availability,
)
router.post('/', requireRole('SUPER_ADMIN', 'ADMIN'), createRules, validate, ctrl.create)
router.put('/:id', requireRole('SUPER_ADMIN', 'ADMIN'), param('id').isInt(), validate, ctrl.update)
router.delete('/:id', requireRole('SUPER_ADMIN', 'ADMIN'), param('id').isInt(), validate, ctrl.deactivate)

module.exports = router
