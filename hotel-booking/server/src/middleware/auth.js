const jwt = require('jsonwebtoken')
const { prisma } = require('../utils/prisma')

async function authenticate(req, res, next) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Необходима авторизация' })
  }

  const token = header.slice(7)
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET)
    const admin = await prisma.admin.findUnique({
      where: { id: payload.id },
      select: { id: true, username: true, name: true, role: true, isActive: true },
    })

    if (!admin || !admin.isActive) {
      return res.status(401).json({ error: 'Пользователь не найден или деактивирован' })
    }

    req.admin = admin
    next()
  } catch {
    return res.status(401).json({ error: 'Недействительный токен' })
  }
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
