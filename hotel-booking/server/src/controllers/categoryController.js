const { prisma } = require('../utils/prisma')
const { createError } = require('../middleware/errorHandler')
// Название/цвет категории входят в ответ сетки (кэш 30 с) — сбрасываем кэш после правок.
const { invalidateGridCache } = require('./occupancyController')

// GET /api/categories
async function list(_req, res, next) {
  try {
    const categories = await prisma.category.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { rooms: { where: { isActive: true } } } } },
    })
    res.json({ data: categories })
  } catch (err) {
    next(err)
  }
}

// POST /api/categories
async function create(req, res, next) {
  try {
    const { name, color, description } = req.body
    const category = await prisma.category.create({
      data: { name: name.trim(), color, description: description?.trim() || null },
    })
    invalidateGridCache()
    res.status(201).json({ data: category })
  } catch (err) {
    next(err)
  }
}

// PUT /api/categories/:id
async function update(req, res, next) {
  try {
    const id = parseInt(req.params.id)
    const { name, color, description } = req.body

    const category = await prisma.category.update({
      where: { id },
      data: {
        ...(name !== undefined && { name: name.trim() }),
        ...(color !== undefined && { color }),
        ...(description !== undefined && { description: description?.trim() || null }),
      },
    })
    invalidateGridCache()
    res.json({ data: category })
  } catch (err) {
    next(err)
  }
}

// DELETE /api/categories/:id
async function remove(req, res, next) {
  try {
    const id = parseInt(req.params.id)
    // Считаем ВСЕ номера категории, включая скрытые (isActive=false): FK Room→Category
    // без каскада, и удаление с одними скрытыми номерами раньше падало с 500.
    const [roomCount, hiddenCount] = await prisma.$transaction([
      prisma.room.count({ where: { categoryId: id } }),
      prisma.room.count({ where: { categoryId: id, isActive: false } }),
    ])
    if (roomCount > 0) {
      return next(createError(
        `Нельзя удалить категорию: в ней ${roomCount} номеров (из них ${hiddenCount} скрытых). Сначала переместите номера в другую категорию`,
        400,
      ))
    }
    await prisma.category.delete({ where: { id } })
    invalidateGridCache()
    res.json({ message: 'Категория удалена' })
  } catch (err) {
    next(err)
  }
}

module.exports = { list, create, update, remove }
