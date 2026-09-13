const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const { prisma } = require('../utils/prisma')
const { revokeSessions } = require('../utils/sessions')

// `tv` — версия сессии (Admin.tokenVersion): middleware/auth.js и handshake
// сокета сверяют её с базой, несовпадение — 401. Та же функция продублирована
// в setupController.signToken — claims менять в обоих местах.
function signToken(admin) {
  return jwt.sign(
    { id: admin.id, role: admin.role, tv: admin.tokenVersion ?? 0 },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  )
}

async function login(req, res, next) {
  try {
    const { username, password } = req.body

    // Регистр логина не должен решать, пустят человека или нет (S13-007).
    // Точное совпадение — обычный путь (учётки создаются в нижнем регистре);
    // поиск без учёта регистра нужен старым базам, где логин мог сохраниться
    // как `Admin` или `Aigerim`, — иначе починка входа сломала бы вход им.
    const normalized = (typeof username === 'string' ? username : '').trim().toLowerCase()
    const admin = await prisma.admin.findUnique({ where: { username: normalized } })
      || await prisma.admin.findFirst({
        where: { username: { equals: normalized, mode: 'insensitive' } },
        orderBy: { id: 'asc' },
      })
    if (!admin || !admin.isActive) {
      return res.status(401).json({ error: 'Неверный логин или пароль' })
    }

    const valid = await bcrypt.compare(password, admin.password)
    if (!valid) {
      return res.status(401).json({ error: 'Неверный логин или пароль' })
    }

    const token = signToken(admin)
    res.json({
      token,
      admin: { id: admin.id, username: admin.username, name: admin.name, role: admin.role },
    })
  } catch (err) {
    next(err)
  }
}

// Выход — это отзыв ВСЕХ сессий учётной записи, а не только этой вкладки:
// скопированный или оставленный на другом ноутбуке токен после выхода тоже
// перестаёт работать. Раньше ответ был stateless, а токен жил до 8 ч.
async function logout(req, res, next) {
  try {
    await revokeSessions(req.admin.id, { reason: 'session_revoked' })
    res.json({ message: 'Выход выполнен' })
  } catch (err) {
    next(err)
  }
}

async function me(req, res) {
  res.json({ admin: req.admin })
}

async function changePassword(req, res, next) {
  try {
    const { currentPassword, newPassword } = req.body

    const admin = await prisma.admin.findUnique({ where: { id: req.admin.id } })
    const valid = await bcrypt.compare(currentPassword, admin.password)
    if (!valid) {
      return res.status(400).json({ error: 'Неверный текущий пароль' })
    }

    const hash = await bcrypt.hash(newPassword, 12)
    // Смена пароля обязана убивать чужие сессии — иначе после утечки она
    // бессмысленна. Своя уходит вместе с ними: вызывающий входит заново
    // с новым паролем (клиент получает auth:revoked по сокету).
    await revokeSessions(req.admin.id, { reason: 'password_changed', data: { password: hash } })

    res.json({ message: 'Пароль изменён, войдите заново' })
  } catch (err) {
    next(err)
  }
}

module.exports = { login, logout, me, changePassword }
