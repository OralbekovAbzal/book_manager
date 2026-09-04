const { prisma } = require('../utils/prisma')
const { createError } = require('../middleware/errorHandler')

// Больше двух лет за один заход — почти наверняка опечатка в датах.
const MAX_RANGE_DAYS = 800

const PRICE_FIELDS = ['roomPrice', 'adultPrice', 'childPrice', 'extraBedPrice']

/** 'YYYY-MM-DD' → UTC-полночь. Даты @db.Date хранятся именно так (см. NOTES). */
function toUTCDate(s) {
  const [y, m, d] = String(s).split('-').map(Number)
  if (!y || !m || !d) return null
  return new Date(Date.UTC(y, m - 1, d))
}

function parseRange(dateFrom, dateTo) {
  const from = toUTCDate(dateFrom)
  const to = toUTCDate(dateTo)
  if (!from || !to) return { error: 'Нужны dateFrom и dateTo в формате YYYY-MM-DD' }
  if (to < from) return { error: 'dateTo не может быть раньше dateFrom' }
  const days = Math.round((to - from) / 86400000) + 1
  if (days > MAX_RANGE_DAYS) return { error: `Слишком большой диапазон: ${days} дн. (максимум ${MAX_RANGE_DAYS})` }
  return { from, to, days }
}

/** Цены приходят строками из формы; пустая строка = «не трогать это поле». */
function parsePrices(input = {}) {
  const out = {}
  for (const f of PRICE_FIELDS) {
    const raw = input[f]
    if (raw === undefined || raw === null || raw === '') { out[f] = null; continue }
    const n = Number(raw)
    if (Number.isNaN(n) || n < 0) return { error: `Некорректная цена в поле ${f}` }
    out[f] = n
  }
  return { prices: out }
}

// GET /api/rates?dateFrom=&dateTo=&categoryId=
async function list(req, res, next) {
  try {
    const { dateFrom, dateTo, categoryId } = req.query
    const range = parseRange(dateFrom, dateTo)
    if (range.error) return next(createError(range.error, 400))

    const where = { date: { gte: range.from, lte: range.to } }
    if (categoryId) where.categoryId = parseInt(categoryId)

    const data = await prisma.ratePrice.findMany({
      where,
      orderBy: [{ categoryId: 'asc' }, { date: 'asc' }],
    })
    res.json({ data })
  } catch (err) {
    next(err)
  }
}

/**
 * PUT /api/rates — заполнение календаря диапазоном.
 * body: { categoryIds: [1,2], dateFrom, dateTo, weekdays?: [0..6], prices: {...} }
 *
 * Храним цену по дням, а заполняем диапазонами — иначе завести год означало бы
 * 365 правок. `weekdays` (0=вс … 6=сб) позволяет задать, например, только выходные.
 *
 * Одним SQL-запросом вместо цикла upsert'ов: 4 категории × 180 дней — это 720 строк,
 * циклом получилось бы 720 обращений к БД.
 *
 * COALESCE при конфликте: незаполненное поле НЕ затирает уже заданную цену.
 * Чтобы очистить цены — DELETE на тот же диапазон.
 */
async function applyRange(req, res, next) {
  try {
    const { categoryIds, dateFrom, dateTo, weekdays, prices } = req.body

    if (!Array.isArray(categoryIds) || categoryIds.length === 0) {
      return next(createError('Укажите хотя бы одну категорию', 400))
    }
    const ids = categoryIds.map(Number).filter(n => Number.isInteger(n) && n > 0)
    if (ids.length !== categoryIds.length) return next(createError('Некорректный список категорий', 400))

    const range = parseRange(dateFrom, dateTo)
    if (range.error) return next(createError(range.error, 400))

    const parsed = parsePrices(prices)
    if (parsed.error) return next(createError(parsed.error, 400))
    if (PRICE_FIELDS.every(f => parsed.prices[f] === null)) {
      return next(createError('Не заполнена ни одна цена', 400))
    }

    const days = Array.isArray(weekdays)
      ? weekdays.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6)
      : []

    const { roomPrice, adultPrice, childPrice, extraBedPrice } = parsed.prices

    const affected = await prisma.$executeRaw`
      INSERT INTO "RatePrice"
        ("categoryId", "date", "roomPrice", "adultPrice", "childPrice", "extraBedPrice", "updatedAt")
      SELECT c.id,
             d::date,
             ${roomPrice}::double precision,
             ${adultPrice}::double precision,
             ${childPrice}::double precision,
             ${extraBedPrice}::double precision,
             NOW()
      FROM unnest(${ids}::int[]) AS c(id),
           generate_series(${range.from}::date, ${range.to}::date, interval '1 day') AS d
      WHERE cardinality(${days}::int[]) = 0
         OR EXTRACT(DOW FROM d)::int = ANY(${days}::int[])
      ON CONFLICT ("categoryId", "date") DO UPDATE SET
        "roomPrice"     = COALESCE(EXCLUDED."roomPrice",     "RatePrice"."roomPrice"),
        "adultPrice"    = COALESCE(EXCLUDED."adultPrice",    "RatePrice"."adultPrice"),
        "childPrice"    = COALESCE(EXCLUDED."childPrice",    "RatePrice"."childPrice"),
        "extraBedPrice" = COALESCE(EXCLUDED."extraBedPrice", "RatePrice"."extraBedPrice"),
        "updatedAt"     = NOW()
    `

    res.json({ data: { updated: affected, days: range.days, categories: ids.length } })
  } catch (err) {
    next(err)
  }
}

/**
 * POST /api/rates/cells — цена для произвольного набора ячеек.
 * body: { cells: [{ categoryId, date }], prices: {...} }
 *
 * Нужен для выделения мышью в календаре: выделение может быть какой угодно формы,
 * и в «диапазон дат + дни недели» оно не укладывается.
 * Одним запросом через unnest двух параллельных массивов.
 */
async function applyCells(req, res, next) {
  try {
    const { cells, prices } = req.body
    if (!Array.isArray(cells) || cells.length === 0) {
      return next(createError('Не выбрано ни одной ячейки', 400))
    }
    if (cells.length > 5000) {
      return next(createError('Слишком большое выделение', 400))
    }

    const catIds = []
    const dates = []
    for (const c of cells) {
      const id = Number(c?.categoryId)
      const d = toUTCDate(c?.date)
      if (!Number.isInteger(id) || id <= 0 || !d) {
        return next(createError('Некорректная ячейка в выделении', 400))
      }
      catIds.push(id)
      dates.push(d)
    }

    const parsed = parsePrices(prices)
    if (parsed.error) return next(createError(parsed.error, 400))
    if (PRICE_FIELDS.every(f => parsed.prices[f] === null)) {
      return next(createError('Не заполнена ни одна цена', 400))
    }
    const { roomPrice, adultPrice, childPrice, extraBedPrice } = parsed.prices

    const affected = await prisma.$executeRaw`
      INSERT INTO "RatePrice"
        ("categoryId", "date", "roomPrice", "adultPrice", "childPrice", "extraBedPrice", "updatedAt")
      SELECT t.cat,
             t.d,
             ${roomPrice}::double precision,
             ${adultPrice}::double precision,
             ${childPrice}::double precision,
             ${extraBedPrice}::double precision,
             NOW()
      FROM unnest(${catIds}::int[], ${dates}::date[]) AS t(cat, d)
      ON CONFLICT ("categoryId", "date") DO UPDATE SET
        "roomPrice"     = COALESCE(EXCLUDED."roomPrice",     "RatePrice"."roomPrice"),
        "adultPrice"    = COALESCE(EXCLUDED."adultPrice",    "RatePrice"."adultPrice"),
        "childPrice"    = COALESCE(EXCLUDED."childPrice",    "RatePrice"."childPrice"),
        "extraBedPrice" = COALESCE(EXCLUDED."extraBedPrice", "RatePrice"."extraBedPrice"),
        "updatedAt"     = NOW()
    `
    res.json({ data: { updated: affected } })
  } catch (err) {
    next(err)
  }
}

/** DELETE /api/rates/cells — очистить произвольный набор ячеек. */
async function clearCells(req, res, next) {
  try {
    const { cells } = req.body
    if (!Array.isArray(cells) || cells.length === 0) {
      return next(createError('Не выбрано ни одной ячейки', 400))
    }
    let deleted = 0
    // Группируем по категории, чтобы удалить пачками, а не по одной ячейке.
    const byCat = new Map()
    for (const c of cells) {
      const id = Number(c?.categoryId)
      const d = toUTCDate(c?.date)
      if (!Number.isInteger(id) || !d) continue
      if (!byCat.has(id)) byCat.set(id, [])
      byCat.get(id).push(d)
    }
    for (const [categoryId, list] of byCat) {
      const { count } = await prisma.ratePrice.deleteMany({
        where: { categoryId, date: { in: list } },
      })
      deleted += count
    }
    res.json({ data: { deleted } })
  } catch (err) {
    next(err)
  }
}

// DELETE /api/rates — очистить цены в диапазоне
async function clearRange(req, res, next) {
  try {
    const { categoryIds, dateFrom, dateTo } = req.body
    if (!Array.isArray(categoryIds) || categoryIds.length === 0) {
      return next(createError('Укажите хотя бы одну категорию', 400))
    }
    const range = parseRange(dateFrom, dateTo)
    if (range.error) return next(createError(range.error, 400))

    const { count } = await prisma.ratePrice.deleteMany({
      where: {
        categoryId: { in: categoryIds.map(Number) },
        date: { gte: range.from, lte: range.to },
      },
    })
    res.json({ data: { deleted: count } })
  } catch (err) {
    next(err)
  }
}

module.exports = { list, applyRange, clearRange, applyCells, clearCells }
