const router = require('express').Router()
const { authenticate, requireRole } = require('../middleware/auth')
const { prisma } = require('../utils/prisma')
const {
  createBackup, restoreBackup, describeRestore, listBackupFiles, lastBackupLog,
} = require('../utils/backup')

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

// GET /api/system/backups/:fileName/impact — что восстановление вернёт и что потеряет.
// Ничего не меняет: нужен окну подтверждения, чтобы «сколько денег исчезнет»
// спрашивали ДО восстановления, а не узнавали после (как у снимков).
router.get('/backups/:fileName/impact', requireRole('SUPER_ADMIN', 'ADMIN'), async (req, res, next) => {
  try {
    res.json({ data: await describeRestore(req.params.fileName) })
  } catch (err) {
    next(err)
  }
})

// POST /api/system/backup/restore { fileName, allowDataLoss? } — заменяет ВСЕ данные
// содержимым файла (перед этим делается обычная копия текущего состояния)
// → { restored: { Booking: n, ... }, safetyBackup, version, lostPayments, emptiedTables }
//
// `allowDataLoss` — осознанное согласие на потерю того, чего в файле нет: платежей
// и целых таблиц (файл старого формата не содержит ни кассы, ни услуг вовсе).
// Без него такое восстановление отвечает 409 и не трогает ни базу, ни папку копий.
// `allowMoneyLoss` принимается синонимом — так называется тот же флаг у снимков.
//
// «ВСЕ данные» — кроме снимков: точки отката (`Snapshot`) в копию не пишутся и
// при восстановлении не очищаются, поэтому после него ими можно вернуться к
// состоянию ДО восстановления. Почему так — у EXCLUDED_MODELS в utils/backup.js.
router.post('/backup/restore', requireRole('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const allowDataLoss = req.body?.allowDataLoss === true || req.body?.allowMoneyLoss === true
    const result = await restoreBackup(req.body?.fileName, req.admin.id, { allowDataLoss })
    res.json(result)
  } catch (err) {
    // Сводку последствий отдаём вместе с отказом — окну подтверждения не нужно
    // ходить за ней вторым запросом
    if (err.impact) return res.status(err.status || 409).json({ error: err.message, impact: err.impact })
    next(err)
  }
})

module.exports = router
