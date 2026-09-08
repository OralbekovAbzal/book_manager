const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const { prisma } = require('../utils/prisma')
const { getSetupState, isSeedOnly, SEED_USERNAME } = require('../utils/setupState')
const logger = require('../utils/logger')

// Мастер первичной настройки («Шаг 2 из 2» после окна настроек Electron).
// Эндпоинты публичные (без authenticate): при свежей установке в базе ещё нет
// ни одной настоящей учётной записи — входить некому.
//
// Защита — НЕ одна отметка HotelSettings.setupCompletedAt (D1-001): решение
// владельца — мастер работает только на нетронутой базе, то есть пока состав
// учёток сидовый. Условие и самолечение потерянной отметки — в utils/setupState.js.

// Тот же токен, что выдаёт authController.signToken (claims { id, role, tv }).
// Продублировано, чтобы не трогать authController.
function signToken(admin) {
  return jwt.sign(
    { id: admin.id, role: admin.role, tv: admin.tokenVersion ?? 0 },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  )
}

// Формат ошибок — как в middleware/validate.js
function validationError(res, field, message) {
  return res.status(400).json({ error: 'Ошибка валидации', details: [{ field, message }] })
}

function fieldName(index) {
  return index === 0 ? 'mainAdmin.username' : `users[${index - 1}].username`
}

/** Отказ «настройка уже выполнена» — из транзакции наружу через catch. */
function setupDone() {
  const err = new Error('Настройка уже выполнена')
  err.status = 409
  err.code = 'SETUP_DONE'
  return err
}

// GET /api/setup/status
async function status(_req, res, next) {
  try {
    // `healed` наружу не отдаём: контракт ответа клиенту не меняется.
    const { needsSetup, hotelName } = await getSetupState(prisma)
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
    // Быстрый отказ до всякой работы; настоящая проверка — внутри транзакции.
    const { needsSetup } = await getSetupState(prisma)
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

    // Логины уникальны в базе. Сидовая учётка исключена: её мы переименовываем,
    // а не считаем занятой (на пройденном гейте другого состава и быть не может).
    const taken = await prisma.admin.findMany({
      where: { username: { in: [...seen] }, NOT: { username: SEED_USERNAME } },
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
      // Строка настроек должна существовать, иначе блокировать нечего и две
      // параллельные отправки мастера обе прошли бы проверку (вторая переписала
      // бы логин и пароль первой). ON CONFLICT DO NOTHING делает вставку точкой
      // сериализации: второй запрос ждёт коммита первого.
      // Колонки — реальные NOT NULL без умолчания у HotelSettings: только updatedAt
      // (createdAt в модели нет, name/currency/pricingBase имеют DEFAULT).
      await tx.$executeRaw`
        INSERT INTO "HotelSettings" (id, name, "updatedAt")
        VALUES (1, ${hotel.name}, now())
        ON CONFLICT (id) DO NOTHING`

      const [row] = await tx.$queryRaw`
        SELECT "setupCompletedAt" FROM "HotelSettings" WHERE id = 1 FOR UPDATE`

      // Состав учёток перечитываем под блокировкой: между быстрым отказом выше и
      // этой строкой мастер мог пройти кто-то другой. Пустая таблица учёток —
      // мастер уместен и при стоящей отметке (войти некому), как в getSetupState.
      const admins = await tx.admin.findMany({ select: { username: true, password: true } })
      if (admins.length > 0) {
        if (row && row.setupCompletedAt) throw setupDone()
        if (!(await isSeedOnly(admins))) throw setupDone()
      }

      // Переименовать разрешено ТОЛЬКО сидовую учётку. Раньше бралcя любой
      // SUPER_ADMIN с минимальным id — так мастер и перехватывал живого владельца.
      const seed = await tx.admin.findUnique({ where: { username: SEED_USERNAME } })
      const main = seed
        ? await tx.admin.update({ where: { id: seed.id }, data: mainData })
        : await tx.admin.create({ data: mainData })

      if (userRows.length) await tx.admin.createMany({ data: userRows })
      await tx.hotelSettings.upsert({
        where: { id: 1 },
        create: { id: 1, ...hotelData },
        update: hotelData,
      })
      return main
    })

    // Единственный след прохождения мастера: req.admin здесь нет, и в журнал
    // действий запись не попадает. Захват программы должен быть виден в логе.
    logger.warn(`setup: мастер первого запуска пройден — отель «${hotel.name}», главный администратор «${admin.username}», ip ${req.ip || '?'}`)

    res.status(201).json({
      token: signToken(admin),
      admin: { id: admin.id, username: admin.username, name: admin.name, role: admin.role },
    })
  } catch (err) {
    if (err && err.status === 409) {
      return res.status(409).json({ error: err.message, code: err.code })
    }
    next(err)  // P2002 (гонка по логину) → 409 в errorHandler
  }
}

// getSetupState переехал в utils/setupState.js; реэкспорт — чтобы не ломать импорты.
module.exports = { status, complete, getSetupState }
