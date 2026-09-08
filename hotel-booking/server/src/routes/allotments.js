const router = require('express').Router()
const { param } = require('express-validator')
const ctrl = require('../controllers/allotmentController')
const { authenticate, requireRole } = require('../middleware/auth')
const { validate } = require('../middleware/validate')

router.use(authenticate)

router.get('/', ctrl.list)
router.post('/', requireRole('SUPER_ADMIN', 'ADMIN'), ctrl.create)
router.put('/:id', requireRole('SUPER_ADMIN', 'ADMIN'), param('id').isInt(), validate, ctrl.update)
router.delete('/:id', requireRole('SUPER_ADMIN', 'ADMIN'), param('id').isInt(), validate, ctrl.remove)

// Роутов релизов больше нет — см. комментарий в allotmentController.js

module.exports = router
