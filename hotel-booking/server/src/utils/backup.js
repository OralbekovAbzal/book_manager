const path = require('path')
const fs = require('fs')
const cron = require('node-cron')
const { Prisma } = require('@prisma/client')
const { prisma } = require('./prisma')
const logger = require('./logger')
const { createError } = require('../middleware/errorHandler')

// Резервная копия — полный JSON-дамп всех таблиц средствами Prisma.
// pg_dump не используется: его нет ни на dev-машине, ни в упакованном приложении
// (embedded-postgres поставляется без утилит), из-за чего ночной бэкап месяцами
// молча падал. Формат файла:
//   { version: 1, createdAt, tables: { Category: [...], Admin: [...], ... } }
// Date → ISO-строки (JSON.stringify), при восстановлении — обратно по DMMF.

const BACKUP_PATH = process.env.BACKUP_PATH || path.join(process.cwd(), 'backups')
// Сколько последних файлов хранить — старые удаляются после каждой новой копии
const BACKUP_KEEP = Math.max(1, parseInt(process.env.BACKUP_KEEP || '14', 10) || 14)
// Часовой пояс для метки в имени файла и расписания: сервер живёт в TZ=UTC,
// поэтому без него «03:00» срабатывало в 08:00 по Алматы.
const BACKUP_TZ = validTimeZone(process.env.BACKUP_TZ || 'Asia/Almaty')
const FILE_RE = /^backup_[0-9A-Za-z_-]+\.json$/
const CHUNK = 500 // строк в одном createMany — не упираемся в лимит параметров Postgres

// Порядок вставки — по зависимостям (FK); удаление идёт в обратном порядке.
// BackupLog в дамп не входит: это журнал самих копий.
const TABLES = [
  'Category', 'Admin', 'Partner', 'BookingFlag', 'License', 'Room', 'Shift',
  'Allotment', 'Release', 'Booking', 'Contact', 'HotelSettings', 'RatePrice',
  'Service', 'MealPlan', 'BookingCharge', 'Snapshot', 'AuditLog',
]
// У License и HotelSettings id = 1 без последовательности
const SERIAL_TABLES = TABLES.filter((t) => t !== 'License' && t !== 'HotelSettings')

const modelKey = (name) => name[0].toLowerCase() + name.slice(1)

function validTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz } catch {
    logger.error(`Backup: unknown BACKUP_TZ "${tz}", falling back to UTC`)
    return 'UTC'
  }
}

// Метка «ГГГГ-ММ-ДД_ЧЧ-мм» по местному времени BACKUP_TZ
function localStamp(date) {
  const s = date.toLocaleString('sv-SE', { timeZone: BACKUP_TZ, hour12: false })
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})\D+(\d{2}):(\d{2})/)
  if (!m) return date.toISOString().slice(0, 16).replace('T', '_').replace(':', '-')
  return `${m[1]}-${m[2]}-${m[3]}_${m[4]}-${m[5]}`
}

// Скалярные поля модели по DMMF: какие — даты, какие — JSON (нужно при восстановлении)
function fieldInfo(modelName) {
  const model = Prisma.dmmf.datamodel.models.find((m) => m.name === modelName)
  const known = new Set(), dates = new Set(), jsons = new Set()
  for (const f of model?.fields || []) {
    if (f.kind !== 'scalar' && f.kind !== 'enum') continue
    known.add(f.name)
    if (f.type === 'DateTime') dates.add(f.name)
    if (f.type === 'Json') jsons.add(f.name)
  }
  return { known, dates, jsons }
}

// Модели из TABLES, которые есть в сгенерированном Prisma Client
// (после добавления таблицы в схему клиент могли ещё не перегенерировать)
function presentTables() {
  return TABLES.filter((t) => {
    if (prisma[modelKey(t)]) return true
    logger.warn(`Backup: model ${t} is missing in Prisma Client, skipped`)
    return false
  })
}

// ─── Создание копии ───────────────────────────────────────────────────────────

async function createBackup() {
  fs.mkdirSync(BACKUP_PATH, { recursive: true })
  const now = new Date()
  const stamp = localStamp(now)
  let filename = `backup_${stamp}.json`
  // Две копии в одну минуту (ручная + перед восстановлением) — добавляем секунды,
  // а при совпадении и секунд — порядковый номер, чтобы не перезаписать файл
  const sec = String(now.getUTCSeconds()).padStart(2, '0')
  for (let n = 1; fs.existsSync(path.join(BACKUP_PATH, filename)); n++) {
    filename = `backup_${stamp}-${sec}${n > 1 ? `-${n}` : ''}.json`
  }
  const filePath = path.join(BACKUP_PATH, filename)
  const tmpPath = filePath + '.tmp'

  try {
    const tables = {}
    for (const name of presentTables()) {
      tables[name] = await prisma[modelKey(name)].findMany({ orderBy: { id: 'asc' } })
    }
    // Пишем во временный файл и переименовываем: обрыв на записи не оставит битую копию
    fs.writeFileSync(tmpPath, JSON.stringify({ version: 1, createdAt: now.toISOString(), tables }), 'utf8')
    fs.renameSync(tmpPath, filePath)
    const size = fs.statSync(filePath).size

    await prisma.backupLog.create({ data: { path: filePath, size, success: true } })
    logger.info(`Backup created: ${filename} (${size} bytes)`)
    pruneOldBackups()
    return { filename, path: filePath, size, createdAt: now.toISOString() }
  } catch (err) {
    try { fs.unlinkSync(tmpPath) } catch { /* временного файла может не быть */ }
    const message = String((err && err.message) || err).slice(0, 1000)
    try {
      await prisma.backupLog.create({ data: { path: filePath, size: 0, success: false, error: message } })
    } catch (logErr) {
      logger.error(`Backup log write failed: ${logErr.message}`)
    }
    logger.error(`Backup failed: ${message}`)
    throw err
  }
}

// Файлы копий в BACKUP_PATH, новые сверху
function listBackupFiles() {
  if (!fs.existsSync(BACKUP_PATH)) return []
  return fs.readdirSync(BACKUP_PATH)
    .filter((f) => FILE_RE.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(BACKUP_PATH, f))
      return { name: f, size: st.size, createdAt: st.mtime.toISOString() }
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
}

function pruneOldBackups() {
  try {
    for (const f of listBackupFiles().slice(BACKUP_KEEP)) {
      fs.unlinkSync(path.join(BACKUP_PATH, f.name))
      logger.info(`Old backup deleted: ${f.name}`)
    }
  } catch (err) {
    logger.warn(`Backup prune failed: ${err.message}`)
  }
}

// Последняя запись журнала копий (удачная или нет) — для строки статуса в настройках
function lastBackupLog() {
  return prisma.backupLog.findFirst({ orderBy: { createdAt: 'desc' } })
}

// ─── Восстановление ───────────────────────────────────────────────────────────

// Строки из файла → данные для createMany: ISO → Date, null в Json → DbNull,
// неизвестные колонки (файл из более новой версии) отбрасываются.
function prepareRows(modelName, list) {
  if (!Array.isArray(list)) return []
  const { known, dates, jsons } = fieldInfo(modelName)
  return list.map((row) => {
    const out = {}
    for (const [k, v] of Object.entries(row || {})) {
      if (!known.has(k)) continue
      if (v == null) { out[k] = jsons.has(k) ? Prisma.DbNull : null; continue }
      out[k] = dates.has(k) ? new Date(v) : v
    }
    return out
  })
}

let restoreInProgress = false

async function restoreBackup(fileName, adminId = null) {
  const name = String(fileName || '')
  if (!FILE_RE.test(name) || path.basename(name) !== name) {
    throw createError('Некорректное имя файла копии', 400)
  }
  const filePath = path.join(BACKUP_PATH, name)
  if (!fs.existsSync(filePath)) throw createError('Файл копии не найден', 404)
  if (restoreInProgress) throw createError('Восстановление уже выполняется', 409)

  let dump
  try { dump = JSON.parse(fs.readFileSync(filePath, 'utf8')) } catch {
    throw createError('Файл копии повреждён или не является JSON', 400)
  }
  if (!dump || dump.version !== 1 || !dump.tables || typeof dump.tables !== 'object') {
    throw createError('Неподдерживаемый формат копии', 400)
  }

  restoreInProgress = true
  try {
    // Точка отката: обычная копия текущего состояния
    const safety = await createBackup()
    logger.info(`Restore from ${name} by admin ${adminId}: safety backup ${safety.filename}`)

    const present = presentTables()
    const rowsByTable = {}
    for (const t of present) rowsByTable[t] = prepareRows(t, dump.tables[t])

    const restored = {}
    await prisma.$transaction(async (tx) => {
      // Удаляем в обратном порядке зависимостей, вставляем в прямом; id сохраняются
      for (const t of [...present].reverse()) await tx[modelKey(t)].deleteMany({})
      for (const t of present) {
        const rows = rowsByTable[t]
        for (let i = 0; i < rows.length; i += CHUNK) {
          await tx[modelKey(t)].createMany({ data: rows.slice(i, i + CHUNK) })
        }
        restored[t] = rows.length
      }
      // Последовательности — на MAX(id)+1, иначе новые записи упрутся в занятые id.
      // Имена таблиц — из нашей константы, не из запроса.
      for (const t of SERIAL_TABLES) {
        if (!present.includes(t)) continue
        await tx.$executeRawUnsafe(
          `SELECT setval(pg_get_serial_sequence('"${t}"', 'id'), COALESCE((SELECT MAX(id) FROM "${t}"), 0) + 1, false)`
        )
      }
    }, { timeout: 120_000, maxWait: 10_000 })

    // Сбрасываем кэш сетки и говорим клиентам перезагрузить её
    try {
      const { invalidateGridCache } = require('../controllers/occupancyController')
      invalidateGridCache()
      const { getIO } = require('../socket/socketManager')
      getIO().to('bookings').emit('snapshot:restored', { backup: name })
    } catch { /* сокет/кэш недоступны — не критично */ }

    logger.info(`Backup ${name} restored: ${JSON.stringify(restored)}`)
    return { restored, safetyBackup: safety.filename }
  } finally {
    restoreInProgress = false
  }
}

// ─── Расписание ───────────────────────────────────────────────────────────────

function startBackupScheduler() {
  cron.schedule('0 3 * * *', async () => {
    logger.info('Starting scheduled backup...')
    try {
      await createBackup()
    } catch (err) {
      logger.error(`Scheduled backup error: ${err.message}`)
    }
  }, { timezone: BACKUP_TZ })
  logger.info(`Backup scheduler started (daily at 03:00 ${BACKUP_TZ}, keep last ${BACKUP_KEEP})`)
}

module.exports = { createBackup, restoreBackup, listBackupFiles, lastBackupLog, startBackupScheduler }
