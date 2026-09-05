const router = require('express').Router()
const { query } = require('express-validator')
const ctrl = require('../controllers/guestController')
const { authenticate } = require('../middleware/auth')
const { validate } = require('../middleware/validate')

router.use(authenticate)

// Подстановка документа из прошлого визита. Объявлена ДО '/', порядок здесь ни на
// что не влияет, но правило проекта — конкретные пути выше параметрических.
// Права не ограничиваем: заселение и есть работа стойки, а кто правил бронь,
// журнал действий пишет и так.
router.get('/lookup',
  query('phone').trim().notEmpty().withMessage('Укажите телефон').bail()
    .isLength({ max: 30 }).withMessage('Телефон — до 30 символов'),
  validate, ctrl.lookup)

// Книга собирается из броней и ничего не меняет — только чтение, доступно всем ролям.
router.get('/', ctrl.list)

module.exports = router
