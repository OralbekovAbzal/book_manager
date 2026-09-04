const jwt = require('jsonwebtoken')
const { prisma } = require('../utils/prisma')
const logger = require('../utils/logger')

async function authenticate(req, res, next) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Необходима авторизация' })
  }

  const token = header.slice(7)

  // Битый/просроченный токен (JsonWebTokenError, TokenExpiredError) — это 401:
  // клиент по нему стирает токен и уходит на вход.
  let payload
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET)
  } catch {
    return res.status(401).json({ error: 'Недействительный токен' })
  }

  // Ошибка базы — НЕ 401 (раньше любой сбой Postgres разлогинивал всех и клиент
  // уходил в перезагрузку), а 503: токен на клиенте остаётся живым.
  let admin
  try {
    admin = await prisma.admin.findUnique({
      where: { id: payload.id },
      select: { id: true, username: true, name: true, role: true, isActive: true },
    })
  } catch (err) {
    logger.error(`authenticate: ошибка запроса к базе — ${err.message}`)
    return res.status(503).json({ error: 'Сервер временно недоступен, попробуйте через минуту' })
  }

  if (!admin || !admin.isActive) {
    return res.status(401).json({ error: 'Пользователь не найден или деактивирован' })
  }

  req.admin = admin
  next()
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.admin?.role)) {
      return res.status(403).json({ error: 'Недостаточно прав' })
    }
    next()
  }
}

module.exports = { authenticate, requireRole }
