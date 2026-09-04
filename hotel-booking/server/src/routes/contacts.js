const router = require('express').Router()
const { body, param } = require('express-validator')
const ctrl = require('../controllers/contactController')
const { authenticate, requireRole } = require('../middleware/auth')
const { validate } = require('../middleware/validate')

router.use(authenticate)

const contactRules = [
  body('name').trim().notEmpty().withMessage('Имя обязательно').isLength({ max: 100 }),
  body('role').optional({ nullable: true }).trim().isLength({ max: 80 }),
  body('group').optional({ nullable: true }).trim().isLength({ max: 40 }),
  body('phones').optional().isArray({ max: 5 }),
  body('email').optional({ nullable: true }).trim().isLength({ max: 120 }),
  body('notes').optional({ nullable: true }).isLength({ max: 500 }),
]

// Читают все, правят администраторы.
// '/defaults' — ДО '/:id', иначе слово попадёт в параметр id (как в routes/services.js).
router.post('/defaults', requireRole('SUPER_ADMIN', 'ADMIN'), ctrl.createDefaults)

router.get('/', ctrl.list)
router.post('/', requireRole('SUPER_ADMIN', 'ADMIN'), contactRules, validate, ctrl.create)
router.put('/:id', requireRole('SUPER_ADMIN', 'ADMIN'), param('id').isInt(), contactRules, validate, ctrl.update)
router.delete('/:id', requireRole('SUPER_ADMIN', 'ADMIN'), param('id').isInt(), validate, ctrl.remove)

module.exports = router
