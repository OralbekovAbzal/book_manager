const router = require('express').Router()
const { body, param } = require('express-validator')
const ctrl = require('../controllers/roomFundController')
const { authenticate, requireRole } = require('../middleware/auth')
const { validate } = require('../middleware/validate')

// Справочники номерного фонда: корпуса, особенности, вместимости.
// Читают все (списки нужны сетке, фильтрам и форме номера), правят администраторы —
// как у меток броней и контактов.
router.use(authenticate)

const admin = requireRole('SUPER_ADMIN', 'ADMIN')
const idRule = [param('id').isInt().withMessage('Неверный идентификатор')]

const buildingRules = [
  body('name').optional().trim().isLength({ min: 1, max: 60 }).withMessage('Название корпуса — до 60 символов'),
  body('description').optional({ nullable: true }).trim().isLength({ max: 200 }),
]

const featureRules = [
  body('name').optional().trim().isLength({ min: 1, max: 60 }).withMessage('Название особенности — до 60 символов'),
  body('emoji').optional({ nullable: true }).trim().isLength({ max: 8 }),
]

const capacityRules = [
  body('label').optional().trim().isLength({ min: 1, max: 60 }).withMessage('Название — до 60 символов'),
  body('value').optional().isInt({ min: 0, max: 99 }).withMessage('Мест — от 0 до 99'),
]

// Все три справочника одним запросом: интерфейсу они нужны всегда вместе.
// ?includeHidden=true — вместе со скрытыми (для раздела настроек).
router.get('/', ctrl.all)

// Разовая заливка того, что осталось в localStorage. Объявлен ДО '/:вид/:id',
// чтобы слово import не попало в параметр (та же грабля, что в routes/services.js).
// Только администратор: импорт пишет в общий справочник.
router.post('/import', admin, ctrl.importFund)

router.get('/buildings', ctrl.listBuildings)
router.post('/buildings', admin, buildingRules, validate, ctrl.createBuilding)
router.put('/buildings/:id', admin, idRule, buildingRules, validate, ctrl.updateBuilding)
router.delete('/buildings/:id', admin, idRule, validate, ctrl.removeBuilding)

router.get('/features', ctrl.listFeatures)
router.post('/features', admin, featureRules, validate, ctrl.createFeature)
router.put('/features/:id', admin, idRule, featureRules, validate, ctrl.updateFeature)
router.delete('/features/:id', admin, idRule, validate, ctrl.removeFeature)

router.get('/capacities', ctrl.listCapacities)
router.post('/capacities', admin, capacityRules, validate, ctrl.createCapacity)
router.put('/capacities/:id', admin, idRule, capacityRules, validate, ctrl.updateCapacity)
router.delete('/capacities/:id', admin, idRule, validate, ctrl.removeCapacity)

module.exports = router
