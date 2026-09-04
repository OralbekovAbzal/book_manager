const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const { prisma } = require('../utils/prisma')

// Мастер первичной настройки («Шаг 2 из 2» после окна настроек Electron).
// Эндпоинты публичные (без authenticate): при свежей установке в базе ещё нет
// ни одной настоящей учётной записи — входить некому. Защита от повторного
// прогона — HotelSettings.setupCompletedAt: после завершения POST /complete → 403.

// Тот же токен, что выдаёт authController.signToken (claims { id, role }).
// Продублировано, чтобы не трогать authController.
function signToken(admin) {
  return jwt.sign(
    { id: admin.id, role: admin.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  )
}

/** needsSetup = строки HotelSettings нет вообще || setupCompletedAt IS NULL. */
async function getSetupState() {
  const s = await prisma.hotelSettings.findUnique({
    where: { id: 1 },
    select: { name: true, setupCompletedAt: true },
  })
  return { needsSetup: !s || !s.setupCompletedAt, hotelName: s ? s.name : null }
}

// Формат ошибок — как в middleware/validate.js
function validationError(res, field, message) {
  return res.status(400).json({ error: 'Ошибка валидации', details: [{ field, message }] })
}

function fieldName(index) {
  return index === 0 ? 'mainAdmin.username' : `users[${index - 1}].username`
}

// GET /api/setup/status
async function status(_req, res, next) {
  try {
    const { needsSetup, hotelName } = await getSetupState()
    res.json({ needsSetup, hotelName })
  } catch (err) {
    next(err)
  }
}

// POST /api/setup/complete
// Тело: { hotel: { name, city? }, mainAdmin: { username, name, password }, users?: [{ username, name, password, role }] }
// Ответ 201: { token, admin } — авто-вход главного администратора после мастера.
async function complete(req, res, next) {
  try {
    const { needsSetup } = await getSetupState()
    if (!needsSetup) return res.status(403).json({ error: 'Настройка уже выполнена' })

    const { hotel, mainAdmin } = req.body
    const users = Array.isArray(req.body.users) ? req.body.users : []
    const all = [mainAdmin, ...users]

    // Логины уникальны внутри запроса (валидатор уже привёл их к нижнему регистру).
    const seen = new Set()
    for (let i = 0; i < all.length; i++) {
      if (seen.has(all[i].username)) {
        return validationError(res, fieldName(i), `Логин «${all[i].username}» повторяется`)
      }
      seen.add(all[i].username)
    }

    // Существующий SUPER_ADMIN с минимальным id (сид создаёт admin/admin123) — переименовываем
    // его, а не заводим вторую запись: на нём могут висеть брони и смены.
    const existingSuper = await prisma.admin.findFirst({
      where: { role: 'SUPER_ADMIN' },
      orderBy: { id: 'asc' },
    })

    // Логины уникальны в базе (кроме переименовываемой записи).
    const taken = await prisma.admin.findMany({
      where: {
        username: { in: [...seen] },
        ...(existingSuper ? { NOT: { id: existingSuper.id } } : {}),
      },
      select: { username: true },
    })
    if (taken.length) {
      const busy = new Set(taken.map((t) => t.username))
      const idx = all.findIndex((u) => busy.has(u.username))
      return validationError(res, fieldName(idx), `Логин «${all[idx].username}» уже занят`)
    }

    // bcrypt(12) ~ 250 мс на пароль — считаем ДО транзакции, чтобы не упереться в её таймаут.
    const mainData = {
      username: mainAdmin.username,
      name: mainAdmin.name,
      password: await bcrypt.hash(mainAdmin.password, 12),
      role: 'SUPER_ADMIN',
      isActive: true,
    }
    const userRows = []
    for (const u of users) {
      userRows.push({
        username: u.username,
        name: u.name,
        password: await bcrypt.hash(u.password, 12),
        role: u.role,
        isActive: true,
      })
    }
    const hotelData = {
      name: hotel.name,
      city: hotel.city || null,
      setupCompletedAt: new Date(),
    }

    const admin = await prisma.$transaction(async (tx) => {
      const main = existingSuper
        ? await tx.admin.update({ where: { id: existingSuper.id }, data: mainData })
        : await tx.admin.create({ data: mainData })
      if (userRows.length) await tx.admin.createMany({ data: userRows })
      await tx.hotelSettings.upsert({
        where: { id: 1 },
        create: { id: 1, ...hotelData },
        update: hotelData,
      })
      return main
    })

    res.status(201).json({
      token: signToken(admin),
      admin: { id: admin.id, username: admin.username, name: admin.name, role: admin.role },
    })
  } catch (err) {
    next(err)  // P2002 (гонка по логину) → 409 в errorHandler
  }
}

module.exports = { status, complete, getSetupState }
