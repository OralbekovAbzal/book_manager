const router = require('express').Router()
const { body } = require('express-validator')
const ctrl = require('../controllers/licenseController')
const { authenticate, requireRole } = require('../middleware/auth')
const { validate } = require('../middleware/validate')

// Здесь раньше жила онлайн-активация через LICENSE_SERVER_URL. Выброшена целиком
// (решение 06.09): программа работает в отеле без интернета, а поднимать и вечно
// держать живым сервер лицензий одному человеку не по силам. Ключ проверяется
// офлайн подписью Ed25519 — см. utils/license.js.

router.use(authenticate)

router.get('/', ctrl.get)
router.post(
  '/',
  requireRole('SUPER_ADMIN'),
  [body('key').isString().trim().notEmpty().withMessage('Введите ключ лицензии')],
  validate,
  ctrl.activate,
)

module.exports = router
