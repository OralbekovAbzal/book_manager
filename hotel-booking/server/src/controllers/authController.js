const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const { prisma } = require('../utils/prisma')

function signToken(admin) {
  return jwt.sign(
    { id: admin.id, role: admin.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  )
}

async function login(req, res, next) {
  try {
    const { username, password } = req.body

    const admin = await prisma.admin.findUnique({ where: { username } })
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

async function logout(_req, res) {
  // JWT stateless — клиент просто удаляет токен
  res.json({ message: 'Выход выполнен' })
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
    await prisma.admin.update({ where: { id: req.admin.id }, data: { password: hash } })

    res.json({ message: 'Пароль изменён' })
  } catch (err) {
    next(err)
  }
}

module.exports = { login, logout, me, changePassword }
