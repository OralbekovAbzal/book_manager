const { prisma } = require('../utils/prisma')
const { createError } = require('../middleware/errorHandler')
const { invalidateFlagCache } = require('../utils/flagEffects')

// Готовая библиотека меток с эффектами, которые понимает оптимизатор.
// Словарь эффектов: pin (не двигать), lockFloor (только свой этаж),
// requireFeature (номер обязан иметь особенность), bufferAfter/Before (зазор),
// bufferAfterExceptFlag (зазор после снимается, если у следующей брони есть метка с этим code).
const LIBRARY = [
  { code: 'only_room',      label: 'Только этот номер',   color: '#ef4444', order: 0, effects: { pin: true } },
  { code: 'only_floor',     label: 'Только этот этаж',     color: '#f59e0b', order: 1, effects: { lockFloor: true } },
  { code: 'only_single',    label: 'Только односпальные',  color: '#8b5cf6', order: 2, effects: { requireFeature: 'Односпальная кровать' } },
  { code: 'only_double',    label: 'Только двуспальные',   color: '#6366f1', order: 3, effects: { requireFeature: 'Двуспальная кровать' } },
  { code: 'early_checkout', label: 'Выезд до 17:00',       color: '#06b6d4', order: 4, effects: { bufferAfter: 1, bufferAfterExceptFlag: 'late_checkin' } },
  { code: 'late_checkout',  label: 'Выезд после 17:00',    color: '#0ea5e9', order: 5, effects: { bufferAfter: 1 } },
  { code: 'late_checkin',   label: 'Заезд после 17:00',    color: '#22c55e', order: 6, effects: null },
  { code: 'debt',           label: 'Долг',                 color: '#dc2626', order: 7, effects: null },
]

const SELECT = { id: true, code: true, label: true, color: true, effects: true, order: true }

function genCode(label) {
  const base = String(label || 'flag').toLowerCase().replace(/[^a-zа-я0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 24)
  return `${base || 'flag'}_${Date.now().toString(36)}`
}

async function ensureSeeded() {
  // Сеется один раз (по «маяку» only_room). Существующие старые метки с теми же
  // code (early_checkout/late_checkout/debt) обновляются до канона; пользовательские —
  // не трогаются. После засева пользователь может редактировать их свободно.
  const sentinel = await prisma.bookingFlag.findUnique({ where: { code: 'only_room' } })
  if (sentinel) return
  for (const f of LIBRARY) {
    await prisma.bookingFlag.upsert({
      where: { code: f.code },
      create: f,
      update: { label: f.label, effects: f.effects, color: f.color },
    })
  }
  invalidateFlagCache()
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
  if (effects.lockFloor) out.lockFloor = true
  if (typeof effects.requireFeature === 'string' && effects.requireFeature.trim()) out.requireFeature = effects.requireFeature.trim()
  if (typeof effects.bufferAfterExceptFlag === 'string' && effects.bufferAfterExceptFlag.trim()) out.bufferAfterExceptFlag = effects.bufferAfterExceptFlag.trim()
  return Object.keys(out).length ? out : null
}

module.exports = { list, create, update, remove }
