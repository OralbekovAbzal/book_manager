const router = require('express').Router()
const ctrl = require('../controllers/hotelController')
const { authenticate, requireRole } = require('../middleware/auth')

router.use(authenticate)

router.get('/', ctrl.get)
router.put('/', requireRole('SUPER_ADMIN', 'ADMIN'), ctrl.update)

module.exports = router
