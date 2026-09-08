/**
 * Срок хранения журнала действий (D1-007).
 *
 * `AuditLog` рос без границы: каждая правка брони откладывала туда тело запроса
 * с именем и телефоном гостя, и таблица за сезон становилась второй базой ПД —
 * попадающей ещё и в каждую резервную копию. Документ гостя из деталей вырезан
 * (`middleware/audit.js`), но остаётся всё прочее, и держать это вечно незачем:
 * журнал нужен, чтобы разобрать спорный случай за смену или за месяц.
 *
 * Год по умолчанию — компромисс: сезон отеля закрывается годовым циклом, а
 * разбирательства старше года не встречаются. `AUDIT_RETENTION_DAYS=0` отключает
 * чистку целиком — для тех, кому журнал нужен как архив.
 */
const logger = require('./logger')

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Удалить записи журнала старше `days` дней.
 *
 * @param {{auditLog: {deleteMany: Function}}} prisma
 * @param {number} days
 * @param {{now?: Date}} [opts]
 * @returns {Promise<{deleted: number, skipped?: boolean}>}
 */
async function purgeOldAuditLogs(prisma, days, { now = new Date() } = {}) {
  const d = Number(days)
  // Не число или 0/отрицательное — «не чистить». Молча ничего не удаляем:
  // ошибиться в переменной окружения проще, чем восстановить журнал.
  if (!Number.isFinite(d) || d <= 0) return { deleted: 0, skipped: true }

  const cutoff = new Date(now.getTime() - d * DAY_MS)
  const res = await prisma.auditLog.deleteMany({ where: { createdAt: { lt: cutoff } } })
  return { deleted: (res && res.count) || 0 }
}

/** Часовой пояс расписания — тот же, что у ночной копии (см. utils/backup.js). */
function scheduleTimeZone() {
  const tz = process.env.BACKUP_TZ || 'Asia/Almaty'
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz } catch {
    logger.error(`Audit retention: unknown BACKUP_TZ "${tz}", falling back to UTC`)
    return 'UTC'
  }
}

/**
 * Запустить чистку журнала: разово через 2 минуты после старта и далее в 03:30.
 *
 * Первый прогон отложен, а не сделан сразу: старт сервера — самый занятой момент
 * (миграции, догоняющая копия, вход стойки), и удаление десятков тысяч строк там
 * ни к чему. 03:30 — ПОСЛЕ ночной копии в 03:00: копия должна успеть забрать
 * журнал в том виде, в каком он был днём, иначе удалённое исчезнет без следа
 * даже из вчерашнего файла.
 *
 * @param {object} prisma
 * @param {{days?: number, cron?: {schedule: Function}}} [opts]
 */
/** Пустая строка в .env — «не задано» (365), а не «0 = хранить вечно». */
function retentionDaysFromEnv(env = process.env) {
  const raw = env.AUDIT_RETENTION_DAYS
  if (raw === undefined || String(raw).trim() === '') return 365
  return Number(raw)
}

function startAuditRetention(prisma, { days = retentionDaysFromEnv(), cron } = {}) {
  const d = Number(days)
  if (!Number.isFinite(d) || d <= 0) {
    logger.info(`Ретеншн журнала отключён (AUDIT_RETENTION_DAYS = ${days})`)
    return null
  }

  const run = async (reason) => {
    try {
      const { deleted } = await purgeOldAuditLogs(prisma, d)
      if (deleted > 0) logger.info(`Журнал действий: удалено ${deleted} записей старше ${d} дн. (${reason})`)
    } catch (err) {
      logger.error(`Audit retention error: ${err && err.message}`)
    }
  }

  const first = setTimeout(() => { run('старт') }, 2 * 60 * 1000)
  first.unref?.()

  const scheduler = cron || require('node-cron')
  const tz = scheduleTimeZone()
  const task = scheduler.schedule('30 3 * * *', () => { run('по расписанию') }, { timezone: tz })
  logger.info(`Ретеншн журнала действий: хранить ${d} дн., чистка ежедневно в 03:30 ${tz}`)
  return { first, task }
}

module.exports = { purgeOldAuditLogs, startAuditRetention }
