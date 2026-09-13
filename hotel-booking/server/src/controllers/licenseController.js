const { prisma } = require('../utils/prisma')
const { createError } = require('../middleware/errorHandler')
const {
  parseLicenseKey,
  describeLicense,
  loadLicenseRow,
  resetLicenseCache,
  isoToUtcDate,
} = require('../utils/license')
const { getTrialState } = require('../utils/trial')

/**
 * Сколько номеров реально занято лимитом. Считаем АКТИВНЫЕ: ступень тарифа —
 * это «сколько номеров одновременно в работе», а не «сколько строк в таблице».
 * Отключённый корпус не должен требовать доплаты.
 */
function countActiveRooms() {
  return prisma.room.count({ where: { isActive: true } })
}

/** Название объекта из настроек — с ним сверяется «Объект» из ключа (S13-008). */
async function hotelName() {
  const row = await prisma.hotelSettings.findUnique({ where: { id: 1 }, select: { name: true } })
  return row ? row.name : null
}

/** Текст расхождения для человека: оба названия рядом, без жаргона. */
function mismatchWarning(info, name) {
  return `Ключ выписан на «${info.hotel}», а объект называется «${name}»`
}

async function buildResponse(keyString) {
  const name = await hotelName()
  const info = describeLicense(keyString, undefined, name)
  info.roomsUsed = await countActiveRooms()
  // Пробный период имеет смысл только без действующего ключа: с ключом он
  // не считается вовсе, и клиенту нечего про него показывать.
  info.trial = info.state === 'none' || info.state === 'invalid'
    ? await getTrialState()
    : null
  // Ключ на чужой объект принимаем (отказ стоил бы работы отелю, который просто
  // переименовался), но говорим об этом вслух — и при активации, и потом в
  // разделе «Лицензия»: иначе один купленный ключ молча обслуживает соседей.
  if (info.hotelMismatch) info.warning = mismatchWarning(info, name)
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
