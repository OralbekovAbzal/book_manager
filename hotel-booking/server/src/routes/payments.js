const router = require('express').Router()
const { body, param } = require('express-validator')
const ctrl = require('../controllers/paymentController')
const { authenticate, requireRole } = require('../middleware/auth')
const { validate } = require('../middleware/validate')

router.use(authenticate)

// ВАЖНО: конкретные пути объявлены ДО '/:id', иначе строка 'shift' попадёт
// в параметр id (та же грабля, что с meal-plans в routes/services.js).

// Читать журнал и сводку по кассе может любой вошедший: администратор смены
// должен видеть, что принял он сам и напарник.
router.get('/debts', ctrl.debts)
router.get('/booking/:bookingId', param('bookingId').isInt(), validate, ctrl.listByBooking)
router.get('/shift/current/summary', ctrl.currentShiftSummary)
router.get('/shift/:shiftId/summary', param('shiftId').isInt(), validate, ctrl.shiftSummary)
router.get('/shift/:shiftId', param('shiftId').isInt(), validate, ctrl.listByShift)

// Приём оплаты — это работа стойки, поэтому доступна и STAFF: кто принял,
// записано в самом платеже.
router.post(
  '/',
  [
    body('bookingId').isInt().withMessage('Укажите бронь'),
    body('amount').isFloat({ gt: 0 }).withMessage('Сумма должна быть больше нуля'),
    body('kind').optional().isIn(ctrl.KINDS).withMessage('Неизвестный тип платежа'),
    body('method').optional().isIn(ctrl.METHODS).withMessage('Неизвестный способ оплаты'),
    body('comment').optional({ nullable: true }).isLength({ max: 500 }),
    body('refundOfId').optional({ nullable: true }).isInt(),
  ],
  validate,
  ctrl.create,
)

router.post(
  '/:id/refund',
  [
    param('id').isInt(),
    body('amount').optional({ nullable: true }).isFloat({ gt: 0 }).withMessage('Сумма возврата должна быть больше нуля'),
    body('method').optional().isIn(ctrl.METHODS),
    body('comment').optional({ nullable: true }).isLength({ max: 500 }),
  ],
  validate,
  ctrl.refund,
)

// Отмена ошибочной записи правит уже закрытые цифры кассы — только администраторам.
router.post(
  '/:id/void',
  requireRole('SUPER_ADMIN', 'ADMIN'),
  [param('id').isInt(), body('reason').trim().notEmpty().withMessage('Укажите причину отмены').isLength({ max: 300 })],
  validate,
  ctrl.voidPayment,
)

// DELETE намеренно нет: платёж из журнала не удаляется никогда, только отменяется.

module.exports = router
