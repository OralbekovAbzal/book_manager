const { prisma } = require('../utils/prisma')
const { createError } = require('../middleware/errorHandler')

const PRICING_BASES = ['room', 'person']

/** Настройки объекта — всегда одна строка (id = 1). Создаём при первом обращении. */
async function getSettings() {
  const existing = await prisma.hotelSettings.findUnique({ where: { id: 1 } })
  if (existing) return existing
  return prisma.hotelSettings.create({ data: { id: 1 } })
}

// GET /api/hotel
async function get(_req, res, next) {
  try {
    res.json({ data: await getSettings() })
  } catch (err) {
    next(err)
  }
}

// PUT /api/hotel
async function update(req, res, next) {
  try {
    const { name, city, currency, pricingBase, lateArrivalHour } = req.body

    if (pricingBase !== undefined && !PRICING_BASES.includes(pricingBase)) {
      return next(createError("pricingBase должен быть 'room' или 'person'", 400))
    }
    if (lateArrivalHour !== undefined && lateArrivalHour !== null) {
      const h = parseInt(lateArrivalHour)
      if (Number.isNaN(h) || h < 0 || h > 23) {
        return next(createError('Час позднего заезда — целое число от 0 до 23', 400))
      }
    }

    await getSettings()  // гарантируем, что строка есть
    const data = await prisma.hotelSettings.update({
      where: { id: 1 },
      data: {
        ...(name !== undefined && { name: String(name).trim() || 'Отель' }),
        ...(city !== undefined && { city: city?.trim() || null }),
        ...(currency !== undefined && { currency: String(currency).trim() || 'KZT' }),
        ...(pricingBase !== undefined && { pricingBase }),
        ...(lateArrivalHour !== undefined && {
          lateArrivalHour: lateArrivalHour === null ? null : parseInt(lateArrivalHour),
        }),
      },
    })
    res.json({ data })
  } catch (err) {
    next(err)
  }
}

module.exports = { get, update, getSettings }
