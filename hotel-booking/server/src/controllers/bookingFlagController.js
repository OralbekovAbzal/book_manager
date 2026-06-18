const { prisma } = require('../utils/prisma')
const { createError } = require('../middleware/errorHandler')
const { invalidateFlagCache } = require('../utils/flagEffects')

// Дефолтные метки — сеются при первом обращении, если таблица пуста
const DEFAULTS = [
  { code: 'early_checkout', label: 'Выезд до 17:00',  effects: null, order: 0 },
  { code: 'late_checkout',  label: 'Выезд после 17:00', effects: { bufferAfter: 1 }, order: 1 },
  { code: 'debt',           label: 'Долг / не оплатил', effects: null, order: 2 },
]

const SELECT = { id: true, code: true, label: true, color: true, effects: true, order: true }

function genCode(label) {
  const base = String(label || 'flag').toLowerCase().replace(/[^a-zа-я0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 24)
  return `${base || 'flag'}_${Date.now().toString(36)}`
}

async function ensureSeeded() {
  const count = await prisma.bookingFlag.count()
  if (count === 0) {
    await prisma.bookingFlag.createMany({ data: DEFAULTS })
    invalidateFlagCache()
  }
}

// GET /api/booking-flags
async function list(_req, res, next) {
  try {
    await ensureSeeded()
    const flags = await prisma.bookingFlag.findMany({ orderBy: [{ order: 'asc' }, { id: 'asc' }], select: SELECT })
    res.json({ data: flags })
  } catch (err) { next(err) }
}

// POST /api/booking-flags  { label, color?, effects?, order? }
async function create(req, res, next) {
  try {
    const { label, color, effects, order } = req.body
    if (!label || !label.trim()) return next(createError('Введите название метки', 400))
    const flag = await prisma.bookingFlag.create({
      data: {
        code: genCode(label),
        label: label.trim(),
        color: color || null,
        effects: normalizeEffects(effects),
        order: Number.isFinite(order) ? order : 0,
      },
      select: SELECT,
    })
    invalidateFlagCache()
    res.status(201).json({ data: flag })
  } catch (err) { next(err) }
}

// PUT /api/booking-flags/:code
async function update(req, res, next) {
  try {
    const { code } = req.params
    const { label, color, effects, order } = req.body
    const existing = await prisma.bookingFlag.findUnique({ where: { code } })
    if (!existing) return next(createError('Метка не найдена', 404))
    const flag = await prisma.bookingFlag.update({
      where: { code },
      data: {
        ...(label !== undefined && { label: label.trim() }),
        ...(color !== undefined && { color: color || null }),
        ...(effects !== undefined && { effects: normalizeEffects(effects) }),
        ...(order !== undefined && { order }),
      },
      select: SELECT,
    })
    invalidateFlagCache()
    res.json({ data: flag })
  } catch (err) { next(err) }
}

// DELETE /api/booking-flags/:code
async function remove(req, res, next) {
  try {
    const { code } = req.params
    await prisma.bookingFlag.delete({ where: { code } })
    invalidateFlagCache()
    res.json({ data: { deleted: true } })
  } catch (err) {
    if (err.code === 'P2025') return next(createError('Метка не найдена', 404))
    next(err)
  }
}

/** Оставляем только валидные эффекты, пустые — в null. */
function normalizeEffects(effects) {
  if (!effects || typeof effects !== 'object') return null
  const out = {}
  if (effects.bufferAfter > 0) out.bufferAfter = Number(effects.bufferAfter)
  if (effects.bufferBefore > 0) out.bufferBefore = Number(effects.bufferBefore)
  if (effects.pin) out.pin = true
  return Object.keys(out).length ? out : null
}

module.exports = { list, create, update, remove }
