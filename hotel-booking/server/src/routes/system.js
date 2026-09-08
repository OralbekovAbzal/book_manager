const crypto = require('crypto')
const router = require('express').Router()
const { authenticate, requireRole } = require('../middleware/auth')
const { prisma } = require('../utils/prisma')
const logger = require('../utils/logger')
const {
  createBackup, restoreBackup, describeRestore, importBackupDump,
  listBackupFiles, lastBackupLog, backupStatus,
} = require('../utils/backup')

// Копия старше этого — повод показать предупреждение в интерфейсе.
// Двое суток: одна пропущенная ночь ещё не беда, две — уже да.
const STALE_HOURS = 48

// ─── Копия при выходе из программы (без JWT) ─────────────────────────────────
//
// Electron перед закрытием гасит сервер и базу, и последняя копия должна успеть
// записаться на флешку. JWT у main-процесса нет и быть не может (он не входит в
// программу), поэтому он ходит с разовым секретом, который сам же выдал серверу
// в env `INTERNAL_TOKEN` при запуске. Границы намеренно узкие: только этот роут,
// только с петли, только при заданном секрете. Не совпало — просто падаем ниже,
// в обычную проверку JWT, как будто заголовка не было.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

function internalTokenMatches(req) {
  const expected = process.env.INTERNAL_TOKEN
  const got = req.get('X-Internal-Token')
  if (!expected || !got) return false
  const a = Buffer.from(String(got))
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

router.post('/backup', async (req, res, next) => {
  if (!internalTokenMatches(req)) return next()
  if (!LOOPBACK.has(req.ip)) {
    logger.warn(`Internal backup token used from non-loopback address ${req.ip}`)
    return next()
  }
  try {
    logger.info('Backup requested by desktop shell (internal token)')
    res.json(await createBackup())
  } catch (err) {
    next(err)
  }
})

router.use(authenticate)

router.get('/status', async (_req, res, next) => {
  try {
    await prisma.$queryRaw`SELECT 1`
    // Состояние копий — без путей: этот роут открыт любому вошедшему, а полный
    // путь к папке (включая имя пользователя Windows) незачем показывать стойке.
    const st = await backupStatus()
    const ageHours = st.lastOkAt
      ? Math.round(((Date.now() - new Date(st.lastOkAt).getTime()) / 3600000) * 10) / 10
      : null
    let warning = 'none'
    if (!st.lastOkAt) warning = 'never'
    else if (ageHours !== null && ageHours > STALE_HOURS) warning = 'stale'
    else if (st.fallbackUsed) warning = 'fallback'

    res.json({
      server: 'ok',
      db: 'ok',
      timestamp: new Date().toISOString(),
      backup: { lastOkAt: st.lastOkAt, ageHours, warning },
    })
  } catch (err) {
    next(err)
  }
})

// GET /api/system/backups — последняя запись журнала копий + файлы в папке
// → { data: { last: BackupLog|null, files: [{ name, size, createdAt, local }], status } }
// `status` — куда пишутся копии и что с последней: раздел «Резервная копия»
// показывает по нему строку «копия сегодня записана локально: флешки нет».
router.get('/backups', requireRole('SUPER_ADMIN', 'ADMIN'), async (_req, res, next) => {
  try {
    const [last, status] = await Promise.all([lastBackupLog(), backupStatus()])
    res.json({ data: { last, files: listBackupFiles(), status } })
  } catch (err) {
    next(err)
  }
})

// POST /api/system/backup — копия сейчас
// → { filename, path, size, createdAt, fallbackUsed, fallbackReason }
router.post('/backup', requireRole('SUPER_ADMIN', 'ADMIN'), async (_req, res, next) => {
  try {
    const result = await createBackup()
    res.json(result)
  } catch (err) {
    next(err)
  }
})

// POST /api/system/backup/upload — файл копии с ДРУГОГО компьютера.
// Тело — содержимое файла как есть (парсер с лимитом 200 МБ подключён в app.js
// ДО общего `express.json({ limit: '1mb' })`), имя файла — в X-File-Name.
// → { data: { fileName, impact } }, где impact — то же, что у /backups/:file/impact.
// Восстановление отдельным шагом: POST /backup/restore { fileName, allowDataLoss }.
router.post('/backup/upload', requireRole('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const { fileName, fallbackUsed } = importBackupDump(req.body, req.get('X-File-Name') || '')
    res.json({ data: { fileName, fallbackUsed, impact: await describeRestore(fileName) } })
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
