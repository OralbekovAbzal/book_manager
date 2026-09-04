const bcrypt = require('bcryptjs')
const { prisma } = require('../utils/prisma')
const { createError } = require('../middleware/errorHandler')
const { disconnectAdmin } = require('../socket/socketManager')
const logger = require('../utils/logger')

// Учётные записи сотрудников — только SUPER_ADMIN (см. routes/users.js).
// Удаления нет: на сотруднике висят брони/смены/снапшоты, поэтому только isActive=false.

const PUBLIC_FIELDS = { id: true, username: true, name: true, role: true, isActive: true, createdAt: true }

// GET /api/users
async function list(_req, res, next) {
  try {
    const data = await prisma.admin.findMany({ select: PUBLIC_FIELDS, orderBy: { id: 'asc' } })
    res.json({ data })
  } catch (err) {
    next(err)
  }
}

// POST /api/users
async function create(req, res, next) {
  try {
    const { username, name, password, role } = req.body
    const data = await prisma.admin.create({
      data: { username, name, role, isActive: true, password: await bcrypt.hash(password, 12) },
      select: PUBLIC_FIELDS,
    })
    res.status(201).json({ data })
  } catch (err) {
    next(err)  // P2002 (дубль логина) → 409 в errorHandler
  }
}

// PUT /api/users/:id  { name?, role?, isActive? }
async function update(req, res, next) {
  try {
    const id = parseInt(req.params.id)
    const existing = await prisma.admin.findUnique({ where: { id }, select: PUBLIC_FIELDS })
    if (!existing) return next(createError('Пользователь не найден', 404))

    const { name, role, isActive } = req.body
    const data = {
      ...(name !== undefined && { name }),
      ...(role !== undefined && { role }),
      ...(isActive !== undefined && { isActive }),
    }
    if (!Object.keys(data).length) return res.json({ data: existing })

    if (id === req.admin.id && data.isActive === false) {
      return next(createError('Нельзя деактивировать самого себя', 400))
    }

    // В системе всегда должен оставаться хотя бы один активный главный администратор.
    const losesSuper = existing.role === 'SUPER_ADMIN' && existing.isActive &&
      ((data.role !== undefined && data.role !== 'SUPER_ADMIN') || data.isActive === false)
    if (losesSuper) {
      const others = await prisma.admin.count({
        where: { role: 'SUPER_ADMIN', isActive: true, NOT: { id } },
      })
      if (others === 0) {
        return next(createError('Нельзя снять роль или деактивировать последнего главного администратора', 400))
      }
    }

    const updated = await prisma.admin.update({ where: { id }, data, select: PUBLIC_FIELDS })

    // Деактивация должна отбирать и realtime, а не только REST: открытый сокет
    // живёт до истечения токена (8 ч) и всё это время получает обновления сетки.
    // Сбой сокета не должен ронять сам запрос — учётка уже отключена в базе.
    if (data.isActive === false) {
      try { disconnectAdmin(id) } catch (err) { logger.error(`Не удалось разорвать сокеты сотрудника ${id}: ${err.message}`) }
    }

    res.json({ data: updated })
  } catch (err) {
    next(err)
  }
}

// PATCH /api/users/:id/password  { password }
async function setPassword(req, res, next) {
  try {
    const id = parseInt(req.params.id)
    const existing = await prisma.admin.findUnique({ where: { id }, select: { id: true } })
    if (!existing) return next(createError('Пользователь не найден', 404))

    await prisma.admin.update({
      where: { id },
      data: { password: await bcrypt.hash(req.body.password, 12) },
    })
    res.json({ message: 'Пароль изменён' })
  } catch (err) {
    next(err)
  }
}

module.exports = { list, create, update, setPassword }
