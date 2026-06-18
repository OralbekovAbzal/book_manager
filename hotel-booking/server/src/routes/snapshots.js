const router = require('express').Router()
const { authenticate, requireRole } = require('../middleware/auth')
const { listSnapshots, createSnapshot, restoreSnapshot, deleteSnapshot } = require('../utils/snapshot')

router.use(authenticate)

// GET /api/snapshots — список точек отката (без тяжёлого поля data)
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

// POST /api/snapshots/:id/restore — откат к снимку (создаёт защитный снимок текущего состояния)
router.post('/:id/restore', requireRole('SUPER_ADMIN', 'ADMIN'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10)
    const result = await restoreSnapshot(id, req.admin.id)
    res.json({ data: result })
  } catch (err) { next(err) }
})

// DELETE /api/snapshots/:id
router.delete('/:id', requireRole('SUPER_ADMIN', 'ADMIN'), async (req, res, next) => {
  try {
    await deleteSnapshot(parseInt(req.params.id, 10))
    res.json({ data: { deleted: true } })
  } catch (err) { next(err) }
})

module.exports = router
