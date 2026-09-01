const { prisma } = require('../utils/prisma')
const { createError } = require('../middleware/errorHandler')

// Группы фиксированы (пресет, а не настройка) — клиент только заполняет записи.
// Значение вне списка не отклоняем, но приводим к дефолту, чтобы группировка
// на экране не разъезжалась из-за опечатки.
const GROUPS = ['Экстренные', 'Сотрудники', 'Службы отеля', 'Подрядчики', 'Прочее']
const DEFAULT_GROUP = 'Службы отеля'

function normalizeGroup(g) {
  const v = (g || '').trim()
  return GROUPS.includes(v) ? v : DEFAULT_GROUP
}

/** Телефоны приходят массивом или одной строкой; чистим пустые и дубли. */
function normalizePhones(input) {
  const arr = Array.isArray(input) ? input : (input ? [input] : [])
  const seen = new Set()
  const out = []
  for (const p of arr) {
    const v = String(p ?? '').trim()
    if (!v || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out.slice(0, 5)
}

function buildData(body) {
  const { name, role, group, phones, email, notes, isPinned, order, isActive } = body
  return {
    name: name.trim(),
    role: role?.trim() || null,
    group: normalizeGroup(group),
    phones: normalizePhones(phones),
    email: email?.trim() || null,
    notes: notes?.trim() || null,
    ...(isPinned !== undefined && { isPinned: !!isPinned }),
    ...(order !== undefined && { order: parseInt(order) || 0 }),
    ...(isActive !== undefined && { isActive: !!isActive }),
  }
}

// GET /api/contacts
async function list(_req, res, next) {
  try {
    const contacts = await prisma.contact.findMany({
      where: { isActive: true },
      orderBy: [{ isPinned: 'desc' }, { order: 'asc' }, { name: 'asc' }],
    })
    res.json({ data: contacts })
  } catch (err) {
    next(err)
  }
}

// POST /api/contacts
async function create(req, res, next) {
  try {
    if (!req.body?.name?.trim()) return next(createError('Укажите имя или название', 400))

    const contact = await prisma.contact.create({ data: buildData(req.body) })
    res.status(201).json({ data: contact })
  } catch (err) {
    next(err)
  }
}

// PUT /api/contacts/:id
async function update(req, res, next) {
  try {
    const id = parseInt(req.params.id)
    const existing = await prisma.contact.findUnique({ where: { id } })
    if (!existing) return next(createError('Контакт не найден', 404))
    if (!req.body?.name?.trim()) return next(createError('Укажите имя или название', 400))

    const contact = await prisma.contact.update({ where: { id }, data: buildData(req.body) })
    res.json({ data: contact })
  } catch (err) {
    next(err)
  }
}

// DELETE /api/contacts/:id — мягкое удаление, чтобы запись можно было вернуть
async function remove(req, res, next) {
  try {
    const id = parseInt(req.params.id)
    const existing = await prisma.contact.findUnique({ where: { id } })
    if (!existing) return next(createError('Контакт не найден', 404))

    await prisma.contact.update({ where: { id }, data: { isActive: false } })
    res.json({ data: { deleted: true } })
  } catch (err) {
    next(err)
  }
}

module.exports = { list, create, update, remove, GROUPS }
