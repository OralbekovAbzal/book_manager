const router = require('express').Router()
const { body, param } = require('express-validator')
const ctrl = require('../controllers/categoryController')
const { authenticate, requireRole } = require('../middleware/auth')
const { validate } = require('../middleware/validate')

router.use(authenticate)

const categoryRules = [
  body('name').trim().notEmpty().withMessage('Название обязательно').isLength({ max: 50 }),
  body('color').matches(/^#[0-9A-Fa-f]{6}$/).withMessage('Цвет должен быть в формате #RRGGBB'),
  body('description').optional({ nullable: true }).isLength({ max: 200 }),
]

router.get('/', ctrl.list)
router.post('/', requireRole('SUPER_ADMIN', 'ADMIN'), categoryRules, validate, ctrl.create)
router.put('/:id', requireRole('SUPER_ADMIN', 'ADMIN'), param('id').isInt(), validate, ctrl.update)
router.delete('/:id', requireRole('SUPER_ADMIN'), param('id').isInt(), validate, ctrl.remove)

module.exports = router
