const router = require('express').Router()
const { body } = require('express-validator')
const ctrl = require('../controllers/setupController')
const { validate } = require('../middleware/validate')
const { passwordRule } = require('../utils/passwordPolicy')

// Публичные эндпоинты мастера первичной настройки — БЕЗ authenticate (см. контроллер).
// Подключается в app.js: app.use('/api/setup', apiLimiter, setupRoutes)

const USERNAME_RE = /^[a-z0-9._-]+$/
const STAFF_ROLES = ['ADMIN', 'STAFF']

function usernameRule(field) {
  return body(field)
    .isString().withMessage('Логин обязателен').bail()
    .trim().toLowerCase()
    .isLength({ min: 3, max: 30 }).withMessage('Логин: от 3 до 30 символов').bail()
    .matches(USERNAME_RE).withMessage('Логин: только латиница, цифры и символы . _ -')
}
function nameRule(field, label) {
  return body(field)
    .isString().withMessage(`${label}: укажите имя`).bail()
    .trim()
    .isLength({ min: 1, max: 100 }).withMessage(`${label}: имя от 1 до 100 символов`)
}
// Парольная политика — общая для всех мест, где задаётся пароль (utils/passwordPolicy.js)
const passwordFor = (field) => passwordRule(body, field)

const completeRules = [
  body('hotel').isObject().withMessage('Укажите данные отеля'),
  body('hotel.name')
    .isString().withMessage('Название отеля обязательно').bail()
    .trim()
    .isLength({ min: 1, max: 100 }).withMessage('Название отеля: от 1 до 100 символов'),
  body('hotel.city')
    .optional({ values: 'falsy' })
    .isString().withMessage('Город: строка').bail()
    .trim()
    .isLength({ max: 100 }).withMessage('Город: до 100 символов'),

  body('mainAdmin').isObject().withMessage('Укажите данные главного администратора'),
  usernameRule('mainAdmin.username'),
  nameRule('mainAdmin.name', 'Главный администратор'),
  passwordFor('mainAdmin.password'),

  body('users').optional().isArray({ max: 50 }).withMessage('Сотрудники: список не более 50 записей'),
  usernameRule('users.*.username'),
  nameRule('users.*.name', 'Сотрудник'),
  passwordFor('users.*.password'),
  body('users.*.role').isIn(STAFF_ROLES).withMessage("Роль сотрудника: 'ADMIN' или 'STAFF'"),
]

router.get('/status', ctrl.status)
router.post('/complete', completeRules, validate, ctrl.complete)

module.exports = router
