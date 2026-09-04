const router = require('express').Router()
const { authenticate, requireRole } = require('../middleware/auth')
const { prisma } = require('../utils/prisma')
const { createBackup, restoreBackup, listBackupFiles, lastBackupLog } = require('../utils/backup')

router.use(authenticate)

router.get('/status', async (_req, res, next) => {
  try {
    await prisma.$queryRaw`SELECT 1`
    res.json({ server: 'ok', db: 'ok', timestamp: new Date().toISOString() })
  } catch (err) {
    next(err)
  }
})

// GET /api/system/backups — последняя запись журнала копий + файлы в папке
// → { data: { last: BackupLog|null, files: [{ name, size, createdAt }] } }
router.get('/backups', requireRole('SUPER_ADMIN', 'ADMIN'), async (_req, res, next) => {
  try {
    const last = await lastBackupLog()
    res.json({ data: { last, files: listBackupFiles() } })
  } catch (err) {
    next(err)
  }
})

// POST /api/system/backup — копия сейчас → { filename, path, size, createdAt }
router.post('/backup', requireRole('SUPER_ADMIN', 'ADMIN'), async (_req, res, next) => {
  try {
    const result = await createBackup()
    res.json(result)
  } catch (err) {
    next(err)
  }
})

// POST /api/system/backup/restore { fileName } — заменяет ВСЕ данные содержимым файла
// (перед этим делается обычная копия текущего состояния) → { restored: { Booking: n, ... } }
router.post('/backup/restore', requireRole('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const result = await restoreBackup(req.body?.fileName, req.admin.id)
    res.json(result)
  } catch (err) {
    next(err)
  }
})

module.exports = router
