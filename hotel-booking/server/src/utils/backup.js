const { exec } = require('child_process')
const path = require('path')
const fs = require('fs')
const cron = require('node-cron')
const { prisma } = require('./prisma')
const logger = require('./logger')

const BACKUP_PATH = process.env.BACKUP_PATH || path.join(process.cwd(), 'backups')
const KEEP_DAYS = parseInt(process.env.BACKUP_KEEP_DAYS || '30', 10)

async function createBackup() {
  if (!fs.existsSync(BACKUP_PATH)) {
    fs.mkdirSync(BACKUP_PATH, { recursive: true })
  }

  const date = new Date().toISOString().slice(0, 10)
  const filename = `backup_${date}_${Date.now()}.sql`
  const filePath = path.join(BACKUP_PATH, filename)

  const dbUrl = new URL(process.env.DATABASE_URL)
  const env = {
    ...process.env,
    PGPASSWORD: dbUrl.password,
  }

  const cmd = `pg_dump -h ${dbUrl.hostname} -p ${dbUrl.port || 5432} -U ${dbUrl.username} -d ${dbUrl.pathname.slice(1)} -f "${filePath}"`

  return new Promise((resolve, reject) => {
    exec(cmd, { env }, async (err) => {
      if (err) {
        await prisma.backupLog.create({
          data: { path: filePath, size: 0, success: false, error: err.message },
        })
        logger.error('Backup failed:', err.message)
        return reject(err)
      }

      const size = fs.statSync(filePath).size
      await prisma.backupLog.create({ data: { path: filePath, size, success: true } })
      logger.info(`Backup created: ${filename} (${size} bytes)`)

      await pruneOldBackups()
      resolve({ path: filePath, size, filename })
    })
  })
}

async function pruneOldBackups() {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - KEEP_DAYS)

  const files = fs.readdirSync(BACKUP_PATH)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => ({ name: f, time: fs.statSync(path.join(BACKUP_PATH, f)).mtimeMs }))
    .sort((a, b) => a.time - b.time)

  const toDelete = files.filter((f) => f.time < cutoff.getTime())
  for (const file of toDelete) {
    fs.unlinkSync(path.join(BACKUP_PATH, file.name))
    logger.info(`Old backup deleted: ${file.name}`)
  }
}

function startBackupScheduler() {
  cron.schedule('0 3 * * *', async () => {
    logger.info('Starting scheduled backup...')
    try {
      await createBackup()
    } catch (err) {
      logger.error('Scheduled backup error:', err)
    }
  })
  logger.info('Backup scheduler started (daily at 03:00)')
}

module.exports = { createBackup, startBackupScheduler }
