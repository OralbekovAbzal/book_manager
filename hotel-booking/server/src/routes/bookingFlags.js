const router = require('express').Router()
const { authenticate, requireRole } = require('../middleware/auth')
const ctrl = require('../controllers/bookingFlagController')

router.use(authenticate)

router.get('/', ctrl.list)
router.post('/', requireRole('SUPER_ADMIN', 'ADMIN'), ctrl.create)
router.put('/:code', requireRole('SUPER_ADMIN', 'ADMIN'), ctrl.update)
router.delete('/:code', requireRole('SUPER_ADMIN', 'ADMIN'), ctrl.remove)

module.exports = router
