const router = require('express').Router()
const ctrl = require('../controllers/reportController')
const { authenticate, requireRole } = require('../middleware/auth')

router.use(authenticate)

// Собирать, править и удалять отчёты может администратор; смотреть и выгружать —
// все. Настройка доступа к каждому отчёту по отдельности — следующий шаг.
const editors = requireRole('ADMIN', 'SUPER_ADMIN')

// Фиксированные пути объявлены до /:id — иначе их перехватит параметрический маршрут.
router.get('/', ctrl.list)
router.get('/datasets', ctrl.datasets)
router.get('/meta', editors, ctrl.meta)
router.post('/validate', editors, ctrl.validate)
router.post('/preview', editors, ctrl.preview)
router.post('/import', editors, ctrl.importJson)
router.post('/', editors, ctrl.create)

router.get('/:id', ctrl.get)
router.get('/:id/definition', ctrl.definition)
router.post('/:id/run', ctrl.run)
router.post('/:id/export', ctrl.exportFile)
router.put('/:id', editors, ctrl.update)
router.delete('/:id', editors, ctrl.remove)

module.exports = router
