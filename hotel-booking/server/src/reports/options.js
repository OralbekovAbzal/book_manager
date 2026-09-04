const { prisma } = require('../utils/prisma')

/**
 * Динамические списки значений для параметров отчёта (`optionsFrom` в определении).
 *
 * Определение хранит только ИМЯ источника, а не сами корпуса и категории:
 * иначе импортированный от другого отеля отчёт тащил бы за собой чужие справочники.
 */

const SOURCES = {
  async buildings() {
    const rows = await prisma.room.findMany({
      where: { isActive: true },
      distinct: ['building'],
      select: { building: true },
      orderBy: { building: 'asc' },
    })
    return rows.map((r) => ({ value: r.building, label: r.building }))
  },

  async categories() {
    const rows = await prisma.category.findMany({ select: { name: true }, orderBy: { name: 'asc' } })
    return rows.map((r) => ({ value: r.name, label: r.name }))
  },

  async partners() {
    const rows = await prisma.partner.findMany({
      where: { isActive: true },
      select: { name: true },
      orderBy: { name: 'asc' },
    })
    return rows.map((r) => ({ value: r.name, label: r.name }))
  },

  async sources() {
    // Источник — свободная строка в брони, поэтому список берём из фактических
    // значений, а не из справочника: его нет.
    const rows = await prisma.booking.findMany({
      distinct: ['source'],
      select: { source: true },
      orderBy: { source: 'asc' },
    })
    return rows
      .map((r) => r.source)
      .filter((s) => s !== null && s !== '')
      .map((s) => ({ value: s, label: s }))
  },

  async admins() {
    const rows = await prisma.admin.findMany({
      where: { isActive: true },
      select: { name: true },
      orderBy: { name: 'asc' },
    })
    return rows.map((r) => ({ value: r.name, label: r.name }))
  },

  async floors() {
    const rows = await prisma.room.findMany({
      where: { isActive: true },
      distinct: ['floor'],
      select: { floor: true },
      orderBy: { floor: 'asc' },
    })
    return rows.map((r) => ({ value: r.floor, label: String(r.floor) }))
  },
}

/** Подставляет options во все параметры определения, у которых есть optionsFrom. */
async function resolveOptions(definition) {
  const params = definition.params || []
  const needed = [...new Set(params.map((p) => p.optionsFrom).filter((n) => n && SOURCES[n]))]
  if (!needed.length) return definition

  const loaded = {}
  await Promise.all(needed.map(async (name) => { loaded[name] = await SOURCES[name]() }))

  return Object.assign({}, definition, {
    params: params.map((p) => (p.optionsFrom && loaded[p.optionsFrom]
      ? Object.assign({}, p, { options: loaded[p.optionsFrom] })
      : p)),
  })
}

module.exports = { SOURCES, resolveOptions }
