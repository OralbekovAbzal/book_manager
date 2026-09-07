const { prisma } = require('./prisma')
const { disconnectAdmin } = require('../socket/socketManager')
const logger = require('./logger')

/**
 * Отзыв всех сессий сотрудника: `tokenVersion` растёт на единицу, и токены с
 * прежним claim `tv` перестают проходить middleware/auth.js; открытые сокеты
 * рвутся тут же — иначе рабочее место получало бы сетку до истечения токена.
 *
 * `data` пишется той же строкой (новый хеш пароля): смена пароля и отзыв
 * сессий — одна запись, а не две, между которыми можно успеть войти.
 * Сбой сокета запрос не роняет: версия в базе уже новая, REST закрыт.
 */
async function revokeSessions(adminId, { reason = 'session_revoked', data = {} } = {}) {
  const admin = await prisma.admin.update({
    where: { id: adminId },
    data: { ...data, tokenVersion: { increment: 1 } },
  })
  try {
    disconnectAdmin(adminId, reason)
  } catch (err) {
    logger.error(`Не удалось разорвать сокеты сотрудника ${adminId}: ${err.message}`)
  }
  return admin
}

module.exports = { revokeSessions }
