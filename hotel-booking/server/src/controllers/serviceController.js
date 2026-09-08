const { prisma } = require('../utils/prisma')
const { createError } = require('../middleware/errorHandler')

const UNITS = ['per_person_night', 'per_night', 'per_person', 'per_booking']
const KINDS = ['meal', 'extra']

/** Код латиницей: он попадает в MealPlan.serviceCodes и должен быть стабильным. */
function slugify(input, fallback) {
  const map = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
    й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
    у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
    э: 'e', ю: 'yu', я: 'ya',
  }
  const s = String(input || '').toLowerCase().split('').map(ch => map[ch] ?? ch).join('')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return s || fallback
}

function parsePrice(v, field) {
  if (v === undefined || v === null || v === '') return { value: null }
  const n = Number(v)
  if (Number.isNaN(n) || n < 0) return { error: `Некорректная цена в поле ${field}` }
  return { value: n }
}

// ─── Услуги ───────────────────────────────────────────────────────────────────

/** Услуга «используется» = к ней привязаны строки BookingService (`Service.bookings`). */
const SERVICE_COUNT = { select: { bookings: true } }

/** Наружу отдаём число, а не форму Prisma: `_count.bookings` — деталь запроса. */
function withUsage(service) {
  const { _count, ...rest } = service
  return { ...rest, usedInBookings: _count?.bookings ?? 0 }
}

// GET /api/services?kind=meal
async function list(req, res, next) {
  try {
    const where = {}
    if (req.query.kind && KINDS.includes(req.query.kind)) where.kind = req.query.kind
    const rows = await prisma.service.findMany({
      where,
      orderBy: [{ kind: 'asc' }, { order: 'asc' }, { id: 'asc' }],
      // Сколько броней держит эту услугу — чтобы экран мог сказать, что именно
      // исчезнет при удалении (BookingService каскадный, аудит D6-005), а не
      // спрашивать «Удалить „Обед“?» так, будто это строка справочника.
      include: { _count: SERVICE_COUNT },
    })
    res.json({ data: rows.map(withUsage) })
  } catch (err) { next(err) }
}

async function buildServiceData(body, { isCreate }) {
  const { name, code, price, childPrice, unit, kind, includedByDefault, isActive, order } = body

  if (isCreate && !name?.trim()) return { error: 'Укажите название услуги' }
  if (unit !== undefined && !UNITS.includes(unit)) return { error: 'Некорректная единица начисления' }
  if (kind !== undefined && !KINDS.includes(kind)) return { error: "kind должен быть 'meal' или 'extra'" }

  const p = parsePrice(price, 'price')
  if (p.error) return { error: p.error }
  const cp = parsePrice(childPrice, 'childPrice')
  if (cp.error) return { error: cp.error }

  const data = {
    ...(name !== undefined && { name: name.trim() }),
    ...(price !== undefined && { price: p.value ?? 0 }),
    // Пустое поле детской цены = «как у взрослых», поэтому именно null, а не 0.
    ...(childPrice !== undefined && { childPrice: cp.value }),
    ...(unit !== undefined && { unit }),
    ...(kind !== undefined && { kind }),
    ...(includedByDefault !== undefined && { includedByDefault: !!includedByDefault }),
    ...(isActive !== undefined && { isActive: !!isActive }),
    ...(order !== undefined && { order: parseInt(order) || 0 }),
  }
  if (isCreate) data.code = slugify(code || name, `service_${Date.now()}`)
  return { data }
}

// POST /api/services
async function create(req, res, next) {
  try {
    const built = await buildServiceData(req.body, { isCreate: true })
    if (built.error) return next(createError(built.error, 400))
    const service = await prisma.service.create({ data: built.data })
    // Экран кладёт ответ прямо в список рядом со строками из list — счётчик
    // обязан быть в той же форме, иначе строка после правки его теряет.
    res.status(201).json({ data: { ...service, usedInBookings: 0 } })
  } catch (err) {
    if (err.code === 'P2002') return next(createError('Услуга с таким кодом уже существует', 400))
    next(err)
  }
}

// PUT /api/services/:id
async function update(req, res, next) {
  try {
    const id = parseInt(req.params.id)
    const existing = await prisma.service.findUnique({ where: { id } })
    if (!existing) return next(createError('Услуга не найдена', 404))

    const built = await buildServiceData(req.body, { isCreate: false })
    if (built.error) return next(createError(built.error, 400))

    const service = await prisma.service.update({
      where: { id }, data: built.data, include: { _count: SERVICE_COUNT },
    })
    res.json({ data: withUsage(service) })
  } catch (err) { next(err) }
}

/** `force=1|true` в query — «да, знаю про брони, удаляй». */
function isForced(raw) {
  if (raw === undefined || raw === null) return false
  return ['1', 'true', 'yes', 'on', ''].includes(String(raw).toLowerCase())
}

// DELETE /api/services/:id?force=1
async function remove(req, res, next) {
  try {
    const id = parseInt(req.params.id)
    const existing = await prisma.service.findUnique({
      where: { id },
      include: { _count: SERVICE_COUNT },
    })
    if (!existing) return next(createError('Услуга не найдена', 404))

    // Удаление услуги каскадом уносит `BookingService` ВСЕХ броней — историю
    // «завтрак у сорока гостей» (аудит D6-005). Первый вызов на используемой
    // услуге отказывает и называет число: почти всегда администратор хотел не
    // этого, а выключателя «Доступна для добавления в бронь» (isActive).
    const usedInBookings = existing._count?.bookings ?? 0
    if (!isForced(req.query.force) && usedInBookings > 0) {
      return res.status(409).json({
        error: 'Услуга используется в бронях',
        code: 'SERVICE_IN_USE',
        usedInBookings,
      })
    }

    // Убираем код из пресетов питания, иначе пресет ссылался бы в пустоту.
    const plans = await prisma.mealPlan.findMany()
    for (const p of plans) {
      if (p.serviceCodes.includes(existing.code)) {
        await prisma.mealPlan.update({
          where: { id: p.id },
          data: { serviceCodes: p.serviceCodes.filter(c => c !== existing.code) },
        })
      }
    }
    await prisma.service.delete({ where: { id } })
    res.json({ data: { deleted: true } })
  } catch (err) { next(err) }
}

// ─── Пресеты питания ──────────────────────────────────────────────────────────

// GET /api/services/meal-plans
async function listPlans(_req, res, next) {
  try {
    const data = await prisma.mealPlan.findMany({ orderBy: [{ order: 'asc' }, { id: 'asc' }] })
    res.json({ data })
  } catch (err) { next(err) }
}

// POST /api/services/meal-plans
async function createPlan(req, res, next) {
  try {
    const { name, code, serviceCodes, order } = req.body
    if (!name?.trim()) return next(createError('Укажите название пресета', 400))
    const plan = await prisma.mealPlan.create({
      data: {
        code: slugify(code || name, `plan_${Date.now()}`),
        name: name.trim(),
        serviceCodes: Array.isArray(serviceCodes) ? serviceCodes.map(String) : [],
        order: parseInt(order) || 0,
      },
    })
    res.status(201).json({ data: plan })
  } catch (err) {
    if (err.code === 'P2002') return next(createError('Пресет с таким кодом уже существует', 400))
    next(err)
  }
}

// PUT /api/services/meal-plans/:id
async function updatePlan(req, res, next) {
  try {
    const id = parseInt(req.params.id)
    const existing = await prisma.mealPlan.findUnique({ where: { id } })
    if (!existing) return next(createError('Пресет не найден', 404))

    const { name, serviceCodes, order } = req.body
    const plan = await prisma.mealPlan.update({
      where: { id },
      data: {
        ...(name !== undefined && { name: String(name).trim() || existing.name }),
        ...(serviceCodes !== undefined && {
          serviceCodes: Array.isArray(serviceCodes) ? serviceCodes.map(String) : [],
        }),
        ...(order !== undefined && { order: parseInt(order) || 0 }),
      },
    })
    res.json({ data: plan })
  } catch (err) { next(err) }
}

// DELETE /api/services/meal-plans/:id
async function removePlan(req, res, next) {
  try {
    const id = parseInt(req.params.id)
    const existing = await prisma.mealPlan.findUnique({ where: { id } })
    if (!existing) return next(createError('Пресет не найден', 404))
    await prisma.mealPlan.delete({ where: { id } })
    res.json({ data: { deleted: true } })
  } catch (err) { next(err) }
}

// ─── Набор по умолчанию ───────────────────────────────────────────────────────

/**
 * POST /api/services/defaults — создать стандартный набор питания.
 * «Пресеты вместо настройки»: пустой экран заставляет клиента придумывать всё
 * с нуля, а завтрак/обед/ужин одинаковы почти везде. Уже существующие коды
 * не трогаем, так что повторный вызов безопасен.
 */
async function createDefaults(_req, res, next) {
  try {
    const meals = [
      { code: 'breakfast', name: 'Завтрак', order: 1 },
      { code: 'lunch', name: 'Обед', order: 2 },
      { code: 'dinner', name: 'Ужин', order: 3 },
    ]
    for (const m of meals) {
      const exists = await prisma.service.findUnique({ where: { code: m.code } })
      if (!exists) {
        await prisma.service.create({
          data: { ...m, kind: 'meal', unit: 'per_person_night', price: 0 },
        })
      }
    }

    const plans = [
      { code: 'no_meals', name: 'Без питания', serviceCodes: [], order: 1 },
      { code: 'bb', name: 'Только завтрак', serviceCodes: ['breakfast'], order: 2 },
      { code: 'hb', name: 'Полупансион', serviceCodes: ['breakfast', 'dinner'], order: 3 },
      { code: 'fb', name: 'Полный пансион', serviceCodes: ['breakfast', 'lunch', 'dinner'], order: 4 },
    ]
    for (const p of plans) {
      const exists = await prisma.mealPlan.findUnique({ where: { code: p.code } })
      if (!exists) await prisma.mealPlan.create({ data: p })
    }

    res.json({ data: { ok: true } })
  } catch (err) { next(err) }
}

module.exports = {
  list, create, update, remove,
  listPlans, createPlan, updatePlan, removePlan,
  createDefaults,
}
