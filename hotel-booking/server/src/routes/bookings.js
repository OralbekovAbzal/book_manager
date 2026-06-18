const router = require('express').Router()
const { body, query, param } = require('express-validator')
const ctrl = require('../controllers/bookingController')
const { authenticate, requireRole } = require('../middleware/auth')
const { validate } = require('../middleware/validate')

router.use(authenticate)

const bookingBodyRules = [
  body('roomId').isInt({ min: 1 }).withMessage('roomId обязателен'),
  body('guestName').trim().notEmpty().withMessage('Имя гостя обязательно').isLength({ max: 100 }),
  body('guestPhone').optional({ nullable: true }).trim().isLength({ max: 30 }),
  body('checkIn').isDate().withMessage('checkIn обязателен (YYYY-MM-DD)'),
  body('checkOut').isDate().withMessage('checkOut обязателен (YYYY-MM-DD)'),
  body('source').optional({ nullable: true }).isIn(['телефон', 'стойка', 'онлайн', 'Каспи', 'ремонт', null]),
  body('notes').optional({ nullable: true }).isLength({ max: 1000 }),
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
router.post('/check-availability', ctrl.checkAvailability)
router.post('/', bookingBodyRules, validate, ctrl.create)
router.get('/:id', param('id').isInt(), validate, ctrl.getOne)
router.put('/:id', param('id').isInt(), validate, ctrl.update)
router.delete('/:id', param('id').isInt(), validate, ctrl.cancel)
router.patch('/:id/checkin', param('id').isInt(), validate, ctrl.checkIn)
router.patch('/:id/checkout', param('id').isInt(), validate, ctrl.checkOut)
router.post('/:id/move',
  param('id').isInt(),
  body('newRoomId').isInt({ min: 1 }),
  body('moveDate').isDate(),
  validate, ctrl.move)

module.exports = router
