const router = require('express').Router()
const { body, param } = require('express-validator')
const ctrl = require('../controllers/userController')
const { authenticate, requireRole } = require('../middleware/auth')
const { validate } = require('../middleware/validate')

// Учётные записи сотрудников: только главный администратор.
// Подключается в app.js: app.use('/api/users', apiLimiter, userRoutes)
router.use(authenticate, requireRole('SUPER_ADMIN'))

const ROLES = ['SUPER_ADMIN', 'ADMIN', 'STAFF']
const USERNAME_RE = /^[a-z0-9._-]+$/
const ROLE_MSG = "Роль: 'SUPER_ADMIN', 'ADMIN' или 'STAFF'"

const idRule = param('id').isInt().withMessage('Некорректный id пользователя')

const createRules = [
  body('username')
    .isString().withMessage('Логин обязателен').bail()
    .trim().toLowerCase()
    .isLength({ min: 3, max: 30 }).withMessage('Логин: от 3 до 30 символов').bail()
    .matches(USERNAME_RE).withMessage('Логин: только латиница, цифры и символы . _ -'),
  body('name')
    .isString().withMessage('Имя обязательно').bail()
    .trim()
    .isLength({ min: 1, max: 100 }).withMessage('Имя: от 1 до 100 символов'),
  body('password')
    .isString().withMessage('Пароль обязателен').bail()
    .isLength({ min: 8 }).withMessage('Пароль: минимум 8 символов'),
  body('role').isIn(ROLES).withMessage(ROLE_MSG),
]

const updateRules = [
  idRule,
  body('name').optional()
    .isString().withMessage('Имя: строка').bail()
    .trim()
    .isLength({ min: 1, max: 100 }).withMessage('Имя: от 1 до 100 символов'),
  body('role').optional().isIn(ROLES).withMessage(ROLE_MSG),
  body('isActive').optional().isBoolean().withMessage('isActive: true или false').toBoolean(),
]

const passwordRules = [
  idRule,
  body('password')
    .isString().withMessage('Пароль обязателен').bail()
    .isLength({ min: 8 }).withMessage('Пароль: минимум 8 символов'),
]

router.get('/', ctrl.list)
router.post('/', createRules, validate, ctrl.create)
router.put('/:id', updateRules, validate, ctrl.update)
router.patch('/:id/password', passwordRules, validate, ctrl.setPassword)

module.exports = router
