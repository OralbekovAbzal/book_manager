const router = require('express').Router()
const ctrl = require('../controllers/guestController')
const { authenticate } = require('../middleware/auth')

router.use(authenticate)

// Книга собирается из броней и ничего не меняет — только чтение, доступно всем ролям.
router.get('/', ctrl.list)

module.exports = router
