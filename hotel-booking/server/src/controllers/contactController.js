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

// ─── Стандартный набор ────────────────────────────────────────────────────────

/**
 * POST /api/contacts/defaults — экстренные службы одной кнопкой.
 *
 * Тот же приём «пресеты вместо настройки», что и у питания
 * (`serviceController.createDefaults`): пустой справочник на свежей установке
 * выглядит недоделанным, а эти четыре номера одинаковы для любого отеля
 * в стране. Сантехника, прачечную и такси владелец впишет сам — их в набор
 * не кладём, они у всех разные.
 */
const DEFAULT_CONTACTS = [
  { name: 'Скорая помощь', phones: ['103'], order: 1 },
  { name: 'Пожарная служба', phones: ['101'], order: 2 },
  { name: 'Полиция', phones: ['102'], order: 3 },
  { name: 'Аварийная газовая служба', phones: ['104'], order: 4 },
]

async function createDefaults(_req, res, next) {
  try {
    // Уникального кода у контакта нет, поэтому идемпотентность — по имени
    // в группе «Экстренные». Ищем среди ВСЕХ записей, включая удалённые:
    // удаление здесь мягкое (isActive = false), и создать вторую «Скорую»
    // поверх скрытой первой значило бы копить мусор в таблице.
    const existing = await prisma.contact.findMany({
      where: { group: 'Экстренные' },
      select: { id: true, name: true, isActive: true },
      orderBy: { id: 'asc' },
    })
    // Одноимённых записей может быть несколько (накопились за время работы).
    // Активная всегда важнее скрытой, иначе каждый вызов «восстанавливал» бы
    // очередной дубль — и кнопка перестала бы быть идемпотентной.
    const byName = new Map()
    for (const c of existing) {
      const key = c.name.trim().toLowerCase()
      const prev = byName.get(key)
      if (!prev || (!prev.isActive && c.isActive)) byName.set(key, c)
    }

    let created = 0
    let restored = 0
    let skipped = 0

    for (const preset of DEFAULT_CONTACTS) {
      const found = byName.get(preset.name.toLowerCase())
      if (found?.isActive) { skipped++; continue }

      if (found) {
        // Запись есть, но скрыта — возвращаем её, а не плодим дубль.
        await prisma.contact.update({
          where: { id: found.id },
          data: { isActive: true, phones: preset.phones, order: preset.order },
        })
        restored++
      } else {
        await prisma.contact.create({
          data: {
            name: preset.name,
            role: 'Экстренная служба',
            group: 'Экстренные',
            phones: preset.phones,
            order: preset.order,
          },
        })
        created++
      }
    }

    res.json({ data: { created, restored, skipped } })
  } catch (err) {
    next(err)
  }
}

module.exports = { list, create, update, remove, createDefaults, GROUPS }
