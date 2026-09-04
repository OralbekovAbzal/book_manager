const router = require('express').Router()
const ctrl = require('../controllers/rateController')
const { authenticate, requireRole } = require('../middleware/auth')

router.use(authenticate)

const canEdit = requireRole('SUPER_ADMIN', 'ADMIN')

// Смотреть цены может любой вошедший — они нужны для расчёта брони.
router.get('/', ctrl.list)

// Заполнение диапазоном (сезон) и очистка диапазона.
router.put('/', canEdit, ctrl.applyRange)
router.delete('/', canEdit, ctrl.clearRange)

// Произвольный набор ячеек — для выделения мышью в календаре.
router.post('/cells', canEdit, ctrl.applyCells)
router.delete('/cells', canEdit, ctrl.clearCells)

module.exports = router
