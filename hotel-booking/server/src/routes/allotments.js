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

// Releases — управление через аллокацию
router.post('/:id/releases',
  requireRole('SUPER_ADMIN', 'ADMIN'),
  param('id').isInt(), validate, ctrl.createRelease,
)
router.delete('/releases/:id',
  requireRole('SUPER_ADMIN', 'ADMIN'),
  param('id').isInt(), validate, ctrl.removeRelease,
)

module.exports = router
