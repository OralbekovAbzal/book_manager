const router = require('express').Router()
const { body } = require('express-validator')
const { login, logout, me, changePassword } = require('../controllers/authController')
const { authenticate } = require('../middleware/auth')
const { validate } = require('../middleware/validate')

const loginRules = [
  body('username').trim().notEmpty().withMessage('Логин обязателен'),
  body('password').notEmpty().withMessage('Пароль обязателен'),
]

const changePasswordRules = [
  body('currentPassword').notEmpty().withMessage('Текущий пароль обязателен'),
  body('newPassword')
    .isLength({ min: 6 })
    .withMessage('Новый пароль минимум 6 символов'),
]

router.post('/login', loginRules, validate, login)
router.post('/logout', authenticate, logout)
router.get('/me', authenticate, me)
router.post('/change-password', authenticate, changePasswordRules, validate, changePassword)

module.exports = router
