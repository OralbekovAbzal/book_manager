const router = require('express').Router()
const { authenticate, requireRole } = require('../middleware/auth')
const {
  listSnapshots, createSnapshot, describeRestore, restoreSnapshot, deleteSnapshot,
} = require('../utils/snapshot')

router.use(authenticate)

// GET /api/snapshots — список точек отката. Тело снимка (`data`) не отдаём, но
// отдаём `version`: формат 1 денег не хранит, и по списку должно быть видно, что
// откат к такому снимку сотрёт кассу, — ещё до выбора точки отката.
router.get('/', async (_req, res, next) => {
  try {
    res.json({ data: await listSnapshots() })
  } catch (err) { next(err) }
})

// POST /api/snapshots — ручной снимок
router.post('/', async (req, res, next) => {
  try {
    const label = (req.body?.label || '').trim() || 'Ручной снимок'
    const snap = await createSnapshot({ kind: 'manual', label, createdById: req.admin.id })
    res.status(201).json({ data: snap })
  } catch (err) { next(err) }
})

// GET /api/snapshots/:id/impact — что откат вернёт и что потеряет. Ничего не меняет:
// нужен окну подтверждения, чтобы «сколько денег исчезнет» спрашивали ДО отката,
// а не узнавали после.
router.get('/:id/impact', requireRole('SUPER_ADMIN', 'ADMIN'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Некорректный номер снимка' })
    res.json({ data: await describeRestore(id, req.admin.id) })
  } catch (err) { next(err) }
})

// POST /api/snapshots/:id/restore — откат к снимку (создаёт защитный снимок текущего состояния)
//
// Тело: { allowMoneyLoss?: boolean } — осознанное согласие на потерю платежей,
// которых в снимке нет (по образцу `allowAllotmentOverride` в бронях). Без него
// такой откат отвечает 409 и не трогает базу.
router.post('/:id/restore', requireRole('SUPER_ADMIN', 'ADMIN'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10)
    const allowMoneyLoss = req.body?.allowMoneyLoss === true
    const result = await restoreSnapshot(id, req.admin.id, { allowMoneyLoss })
    res.json({ data: result })
  } catch (err) {
    // Сводку последствий отдаём вместе с отказом — окну подтверждения не нужно
    // ходить за ней вторым запросом
    if (err.impact) return res.status(err.status || 409).json({ error: err.message, impact: err.impact })
    next(err)
  }
})

// DELETE /api/snapshots/:id
router.delete('/:id', requireRole('SUPER_ADMIN', 'ADMIN'), async (req, res, next) => {
  try {
    await deleteSnapshot(parseInt(req.params.id, 10))
    res.json({ data: { deleted: true } })
  } catch (err) { next(err) }
})

module.exports = router
