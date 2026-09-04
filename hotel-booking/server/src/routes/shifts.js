const router = require('express').Router()
const { authenticate, requireRole } = require('../middleware/auth')
const ctrl = require('../controllers/shiftController')

router.use(authenticate)

router.get('/', ctrl.list)
router.get('/current', ctrl.current)
// Переход на следующий день сдвигает рабочую дату всего отеля — только администраторам
router.post('/next-day', requireRole('SUPER_ADMIN', 'ADMIN'), ctrl.nextDay)

module.exports = router
