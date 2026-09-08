const router = require('express').Router()
const { query } = require('express-validator')
const ctrl = require('../controllers/serviceController')
const { authenticate, requireRole } = require('../middleware/auth')
const { validate } = require('../middleware/validate')

router.use(authenticate)

const canEdit = requireRole('SUPER_ADMIN', 'ADMIN')

// Пресеты питания — ДО '/:id', иначе 'meal-plans' попадёт в параметр id.
router.get('/meal-plans', ctrl.listPlans)
router.post('/meal-plans', canEdit, ctrl.createPlan)
router.put('/meal-plans/:id', canEdit, ctrl.updatePlan)
router.delete('/meal-plans/:id', canEdit, ctrl.removePlan)

router.post('/defaults', canEdit, ctrl.createDefaults)

router.get('/', ctrl.list)
router.post('/', canEdit, ctrl.create)
router.put('/:id', canEdit, ctrl.update)
// `force` — подтверждение «удалять вместе со строками в бронях» (D6-005).
// Без него удаление используемой услуги отвечает 409 SERVICE_IN_USE.
router.delete('/:id', canEdit, query('force').optional(), validate, ctrl.remove)

module.exports = router
