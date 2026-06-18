const router = require('express').Router()
const { authenticate } = require('../middleware/auth')
const ctrl = require('../controllers/shiftController')

router.use(authenticate)

router.get('/', ctrl.list)
router.get('/current', ctrl.current)
router.post('/next-day', ctrl.nextDay)

module.exports = router
