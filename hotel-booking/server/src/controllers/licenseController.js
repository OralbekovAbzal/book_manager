const { prisma } = require('../utils/prisma')
const { createError } = require('../middleware/errorHandler')
const {
  parseLicenseKey,
  describeLicense,
  loadLicenseRow,
  resetLicenseCache,
  isoToUtcDate,
} = require('../utils/license')

/**
 * Сколько номеров реально занято лимитом. Считаем АКТИВНЫЕ: ступень тарифа —
 * это «сколько номеров одновременно в работе», а не «сколько строк в таблице».
 * Отключённый корпус не должен требовать доплаты.
 */
function countActiveRooms() {
  return prisma.room.count({ where: { isActive: true } })
}

async function buildResponse(keyString) {
  const info = describeLicense(keyString)
  info.roomsUsed = await countActiveRooms()
  return info
}

// GET /api/license — любой вошедший
async function get(req, res, next) {
  try {
    const row = await loadLicenseRow()
    res.json(await buildResponse(row ? row.key : null))
  } catch (err) {
    next(err)
  }
}

// POST /api/license { key } — только SUPER_ADMIN
async function activate(req, res, next) {
  try {
    const key = typeof req.body?.key === 'string' ? req.body.key.trim() : ''
    if (!key) return next(createError('Введите ключ лицензии', 400))

    const parsed = parseLicenseKey(key)
    if (!parsed.valid) return next(createError(parsed.message, 400))

    const p = parsed.payload
    await prisma.license.upsert({
      where: { id: 1 },
      // hardwareId остался в схеме от онлайн-модели и намеренно пуст: к железу
      // не привязываемся (замена ноутбука не должна стоить перевыпуска ключа).
      create: { id: 1, key, hardwareId: '', expiresAt: isoToUtcDate(p.maintenanceUntil), isActive: true },
      update: { key, hardwareId: '', expiresAt: isoToUtcDate(p.maintenanceUntil), isActive: true },
    })

    // Кэш сбрасывается ПОСЛЕ записи: иначе параллельный запрос успел бы
    // перечитать старую строку и снова её закэшировать.
    resetLicenseCache()

    res.json(await buildResponse(key))
  } catch (err) {
    next(err)
  }
}

module.exports = { get, activate }
