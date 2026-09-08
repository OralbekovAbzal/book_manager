const { PrismaClient } = require('@prisma/client')
const logger = require('./logger')

const prisma = new PrismaClient({
  log: [
    { level: 'warn', emit: 'event' },
    { level: 'error', emit: 'event' },
  ],
})

// Только первая строка: тексты Prisma повторяют объект `data` запроса целиком,
// а в нём — ФИО, телефон и документ гостя (см. utils/logSafe.safeError).
const firstLine = (m) => String(m == null ? '' : m).split(/\r?\n/, 1)[0].slice(0, 300)
prisma.$on('warn', (e) => logger.warn(firstLine(e.message)))
prisma.$on('error', (e) => logger.error(firstLine(e.message)))

module.exports = { prisma }
