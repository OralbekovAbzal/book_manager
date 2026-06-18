const { prisma } = require('../utils/prisma')
const { createError } = require('../middleware/errorHandler')

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
    res.json({ data: category })
  } catch (err) {
    next(err)
  }
}

// DELETE /api/categories/:id
async function remove(req, res, next) {
  try {
    const id = parseInt(req.params.id)
    const roomCount = await prisma.room.count({ where: { categoryId: id, isActive: true } })
    if (roomCount > 0) {
      return next(createError(`Нельзя удалить категорию: в ней ${roomCount} активных номеров`, 400))
    }
    await prisma.category.delete({ where: { id } })
    res.json({ message: 'Категория удалена' })
  } catch (err) {
    next(err)
  }
}

module.exports = { list, create, update, remove }
