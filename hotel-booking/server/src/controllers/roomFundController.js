const { prisma } = require('../utils/prisma')
const { createError } = require('../middleware/errorHandler')
// Сетка кэшируется на 30 с. Переименование корпуса/особенности переписывает
// строки Room (см. renameInRooms), поэтому кэш надо сбросить — иначе сетка
// какое-то время показывает старое название.
const { invalidateGridCache } = require('./occupancyController')

/**
 * Справочники номерного фонда: корпуса, особенности, вместимости.
 *
 * Раньше все три жили в localStorage клиента и на двух рабочих местах молча
 * разъезжались. Здесь — источник истины; подробности связи с `Room` (почему без
 * внешних ключей и чем за это платим) — в комментарии к моделям в schema.prisma.
 *
 * Коротко, потому что от этого зависит каждая функция ниже:
 *   Room.building  = НАЗВАНИЕ корпуса      → ключ связи Building.name
 *   Room.features  = массив НАЗВАНИЙ       → ключ связи RoomFeature.name
 *   Room.capacity  = КОД вместимости       → ключ связи RoomCapacity.code
 */

const BUILDING_SELECT = { id: true, code: true, name: true, description: true, order: true, isActive: true }
const FEATURE_SELECT = { id: true, code: true, name: true, emoji: true, order: true, isActive: true }
const CAPACITY_SELECT = { id: true, code: true, label: true, value: true, order: true, isActive: true }

// Стандартный набор для ПУСТОГО справочника — тот же, что засеян миграцией
// (см. migrations/…_room_fund_directories). Здесь он повторён, потому что
// миграция отрабатывает один раз: если справочник опустеет позже (восстановление
// из старой копии, ручная чистка), пользователь останется без выпадающих списков.
// Корпусов в наборе нет — у каждого отеля они свои.
const DEFAULT_FEATURES = [
  { code: 'balcony', name: 'Балкон', emoji: '🪟', order: 0 },
  { code: 'sea_view', name: 'Вид на море', emoji: '🌊', order: 1 },
  { code: 'jacuzzi', name: 'Джакузи', emoji: '🛁', order: 2 },
  // Односпальной кровати нет в ROOM_FUND_DEFAULTS клиента, но она нужна:
  // метка only_single (bookingFlagController.LIBRARY) требует именно эту особенность.
  { code: 'single_bed', name: 'Односпальная кровать', emoji: '🛌', order: 3 },
  { code: 'double_bed', name: 'Двуспальная кровать', emoji: '🛏', order: 4 },
  { code: 'ac', name: 'Кондиционер', emoji: '❄️', order: 5 },
  { code: 'fridge', name: 'Холодильник', emoji: '🧊', order: 6 },
  { code: 'safe', name: 'Сейф', emoji: '🔒', order: 7 },
]

const DEFAULT_CAPACITIES = [
  { code: 'single', label: 'Одноместный', value: 1, order: 0 },
  { code: 'double', label: 'Двухместный', value: 2, order: 1 },
  { code: 'triple', label: 'Трёхместный', value: 3, order: 2 },
  { code: 'quad', label: 'Четырёхместный', value: 4, order: 3 },
]

// ─── Общие мелочи ─────────────────────────────────────────────────────────────

/**
 * Название корпуса приводим к ВЕРХНЕМУ регистру ровно так же, как это делает
 * roomController (`building.trim().toUpperCase()`). Иначе справочник напишет
 * «Корпус Б», номер — «КОРПУС Б», и фильтр по корпусу (точное сравнение строк)
 * не найдёт ни одного номера.
 */
function normalizeBuildingName(name) {
  return String(name ?? '').trim().toUpperCase()
}

/**
 * Ключ сравнения названий при импорте.
 *
 * Кроме регистра гасит ЛАТИНСКИЕ БУКВЫ-ДВОЙНИКИ. Это не теория: в рабочей базе
 * корпус записан как «КОРПУС A» с ЛАТИНСКОЙ A, а тот же корпус в localStorage
 * набран с русской раскладки — «Корпус А». Для строкового сравнения это разные
 * названия, и импорт завёл бы второй корпус, визуально неотличимый от первого,
 * а номера остались бы у первого. Сливаем их: два корпуса, различающиеся только
 * раскладкой, — это всегда один корпус.
 */
const LOOKALIKE = { a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у' }

function matchKey(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[abcehkmoptxy]/g, (ch) => LOOKALIKE[ch])
}

function slugify(value, fallback) {
  const base = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-zа-яё0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
  return base || fallback
}

/**
 * Код — внутренний идентификатор, пользователь его не видит и не вводит.
 * Собираем из названия (чтобы в Prisma Studio было читаемо), а при занятом
 * коде дописываем метку времени — как genCode() у меток броней.
 */
async function uniqueCode(delegate, desired, fallback) {
  const base = slugify(desired, fallback)
  const taken = await delegate.findUnique({ where: { code: base }, select: { id: true } })
  return taken ? `${base}_${Date.now().toString(36)}` : base
}

/** Сколько номеров реально пользуется записью справочника. */
async function usage() {
  const rooms = await prisma.room.findMany({ select: { building: true, features: true, capacity: true } })
  const buildings = new Map()
  const features = new Map()
  const capacities = new Map()
  const bump = (map, key) => {
    if (!key) return
    map.set(key, (map.get(key) || 0) + 1)
  }
  for (const r of rooms) {
    bump(buildings, r.building)
    bump(capacities, r.capacity)
    for (const f of r.features || []) bump(features, f)
  }
  return { buildings, features, capacities }
}

/**
 * Засев стандартного набора, если справочник ПУСТ. По образцу ensureSeeded()
 * у меток броней: повторный вызов безопасен, скрытые пользователем записи
 * не воскрешает (таблица уже не пуста — засев не идёт).
 */
let seedChecked = false
async function ensureSeeded() {
  if (seedChecked) return
  const [features, capacities] = await Promise.all([
    prisma.roomFeature.count(),
    prisma.roomCapacity.count(),
  ])
  if (features === 0) await prisma.roomFeature.createMany({ data: DEFAULT_FEATURES, skipDuplicates: true })
  if (capacities === 0) await prisma.roomCapacity.createMany({ data: DEFAULT_CAPACITIES, skipDuplicates: true })
  seedChecked = true
}

/** Уникальный code/name — это ошибка пользователя, а не сбой: отвечаем 409. */
function conflict(err, message) {
  return err?.code === 'P2002' ? createError(message, 409) : err
}

function wantsHidden(req) {
  return req.query.includeHidden === 'true' || req.query.includeHidden === '1'
}

function activeWhere(req) {
  return wantsHidden(req) ? {} : { isActive: true }
}

/** Добавляет к записям счётчик «стоит у N номеров» — по нему интерфейс решает,
 *  можно ли предлагать удаление насовсем или только «скрыть». */
function withUsage(items, map, key) {
  return items.map((it) => ({ ...it, usedByRooms: map.get(it[key]) || 0 }))
}

// ─── Чтение ───────────────────────────────────────────────────────────────────

/** GET /api/room-fund — все три справочника одним запросом (их всегда нужно три). */
async function all(req, res, next) {
  try {
    await ensureSeeded()
    const where = activeWhere(req)
    const [buildings, features, capacities, used] = await Promise.all([
      prisma.building.findMany({ where, orderBy: [{ order: 'asc' }, { name: 'asc' }], select: BUILDING_SELECT }),
      prisma.roomFeature.findMany({ where, orderBy: [{ order: 'asc' }, { name: 'asc' }], select: FEATURE_SELECT }),
      prisma.roomCapacity.findMany({ where, orderBy: [{ order: 'asc' }, { value: 'asc' }], select: CAPACITY_SELECT }),
      usage(),
    ])
    res.json({
      data: {
        buildings: withUsage(buildings, used.buildings, 'name'),
        features: withUsage(features, used.features, 'name'),
        capacities: withUsage(capacities, used.capacities, 'code'),
      },
    })
  } catch (err) {
    next(err)
  }
}

async function listBuildings(req, res, next) {
  try {
    await ensureSeeded()
    const [items, used] = await Promise.all([
      prisma.building.findMany({ where: activeWhere(req), orderBy: [{ order: 'asc' }, { name: 'asc' }], select: BUILDING_SELECT }),
      usage(),
    ])
    res.json({ data: withUsage(items, used.buildings, 'name') })
  } catch (err) {
    next(err)
  }
}

async function listFeatures(req, res, next) {
  try {
    await ensureSeeded()
    const [items, used] = await Promise.all([
      prisma.roomFeature.findMany({ where: activeWhere(req), orderBy: [{ order: 'asc' }, { name: 'asc' }], select: FEATURE_SELECT }),
      usage(),
    ])
    res.json({ data: withUsage(items, used.features, 'name') })
  } catch (err) {
    next(err)
  }
}

async function listCapacities(req, res, next) {
  try {
    await ensureSeeded()
    const [items, used] = await Promise.all([
      prisma.roomCapacity.findMany({ where: activeWhere(req), orderBy: [{ order: 'asc' }, { value: 'asc' }], select: CAPACITY_SELECT }),
      usage(),
    ])
    res.json({ data: withUsage(items, used.capacities, 'code') })
  } catch (err) {
    next(err)
  }
}

// ─── Переименование: справочник и номера правятся ВМЕСТЕ ──────────────────────

/**
 * Корпус и особенность связаны с номерами по НАЗВАНИЮ, поэтому переименование
 * в справочнике без правки номеров тихо рвёт связь: номера остаются со старым
 * названием и выпадают из фильтра. Поэтому переименовываем в одной транзакции
 * с номерами.
 *
 * Это не «лишняя» работа сверх справочника, а плата за отсутствие внешнего
 * ключа (см. комментарий к моделям в schema.prisma). Когда связь станет FK,
 * этот код уйдёт.
 */
async function renameBuildingInRooms(tx, oldName, newName) {
  if (oldName === newName) return 0
  const { count } = await tx.room.updateMany({ where: { building: oldName }, data: { building: newName } })
  return count
}

async function renameFeatureInRooms(tx, oldName, newName) {
  if (oldName === newName) return 0
  // Особенность лежит ЭЛЕМЕНТОМ массива — updateMany так не умеет, поэтому
  // array_replace. Затрагивает только строки, где старое название реально есть.
  return tx.$executeRaw`
    UPDATE "Room"
    SET "features" = array_replace("features", ${oldName}, ${newName})
    WHERE ${oldName} = ANY("features")
  `
}

// ─── Корпуса ──────────────────────────────────────────────────────────────────

// POST /api/room-fund/buildings  { name, description?, order?, code? }
async function createBuilding(req, res, next) {
  try {
    const name = normalizeBuildingName(req.body?.name)
    if (!name) return next(createError('Введите название корпуса', 400))

    const item = await prisma.building.create({
      data: {
        code: await uniqueCode(prisma.building, req.body?.code || name, 'building'),
        name,
        description: req.body?.description?.trim() || null,
        order: Number.isFinite(req.body?.order) ? req.body.order : 0,
        isActive: true,
      },
      select: BUILDING_SELECT,
    })
    res.status(201).json({ data: item })
  } catch (err) {
    next(conflict(err, 'Корпус с таким названием уже есть'))
  }
}

// PUT /api/room-fund/buildings/:id  { name?, description?, order?, isActive? }
async function updateBuilding(req, res, next) {
  try {
    const id = parseInt(req.params.id)
    const existing = await prisma.building.findUnique({ where: { id } })
    if (!existing) return next(createError('Корпус не найден', 404))

    const { name, description, order, isActive } = req.body || {}
    const nextName = name !== undefined ? normalizeBuildingName(name) : existing.name
    if (!nextName) return next(createError('Введите название корпуса', 400))

    const result = await prisma.$transaction(async (tx) => {
      const item = await tx.building.update({
        where: { id },
        data: {
          name: nextName,
          ...(description !== undefined && { description: description?.trim() || null }),
          ...(order !== undefined && { order: parseInt(order) || 0 }),
          ...(isActive !== undefined && { isActive: !!isActive }),
        },
        select: BUILDING_SELECT,
      })
      const renamedRooms = await renameBuildingInRooms(tx, existing.name, nextName)
      return { item, renamedRooms }
    })

    if (result.renamedRooms > 0) invalidateGridCache()
    res.json({ data: result.item, renamedRooms: result.renamedRooms })
  } catch (err) {
    next(conflict(err, 'Корпус с таким названием уже есть'))
  }
}

// ─── Особенности ──────────────────────────────────────────────────────────────

// POST /api/room-fund/features  { name, emoji?, order?, code? }
async function createFeature(req, res, next) {
  try {
    const name = String(req.body?.name ?? '').trim()
    if (!name) return next(createError('Введите название особенности', 400))

    const item = await prisma.roomFeature.create({
      data: {
        code: await uniqueCode(prisma.roomFeature, req.body?.code || name, 'feature'),
        name,
        emoji: req.body?.emoji?.trim() || null,
        order: Number.isFinite(req.body?.order) ? req.body.order : 0,
        isActive: true,
      },
      select: FEATURE_SELECT,
    })
    res.status(201).json({ data: item })
  } catch (err) {
    next(conflict(err, 'Особенность с таким названием уже есть'))
  }
}

// PUT /api/room-fund/features/:id  { name?, emoji?, order?, isActive? }
async function updateFeature(req, res, next) {
  try {
    const id = parseInt(req.params.id)
    const existing = await prisma.roomFeature.findUnique({ where: { id } })
    if (!existing) return next(createError('Особенность не найдена', 404))

    const { name, emoji, order, isActive } = req.body || {}
    const nextName = name !== undefined ? String(name).trim() : existing.name
    if (!nextName) return next(createError('Введите название особенности', 400))

    const result = await prisma.$transaction(async (tx) => {
      const item = await tx.roomFeature.update({
        where: { id },
        data: {
          name: nextName,
          ...(emoji !== undefined && { emoji: emoji?.trim() || null }),
          ...(order !== undefined && { order: parseInt(order) || 0 }),
          ...(isActive !== undefined && { isActive: !!isActive }),
        },
        select: FEATURE_SELECT,
      })
      const renamedRooms = await renameFeatureInRooms(tx, existing.name, nextName)
      return { item, renamedRooms }
    })

    if (result.renamedRooms > 0) invalidateGridCache()
    res.json({ data: result.item, renamedRooms: result.renamedRooms })
  } catch (err) {
    next(conflict(err, 'Особенность с таким названием уже есть'))
  }
}

// ─── Вместимости ──────────────────────────────────────────────────────────────

// POST /api/room-fund/capacities  { label, value, order?, code? }
async function createCapacity(req, res, next) {
  try {
    const label = String(req.body?.label ?? '').trim()
    if (!label) return next(createError('Введите название типа вместимости', 400))
    const value = normalizeCapacityValue(req.body?.value)

    const item = await prisma.roomCapacity.create({
      data: {
        code: await uniqueCode(prisma.roomCapacity, req.body?.code || label, 'capacity'),
        label,
        value,
        order: Number.isFinite(req.body?.order) ? req.body.order : 0,
        isActive: true,
      },
      select: CAPACITY_SELECT,
    })
    res.status(201).json({ data: item })
  } catch (err) {
    next(conflict(err, 'Такой тип вместимости уже есть'))
  }
}

// PUT /api/room-fund/capacities/:id  { label?, value?, order?, isActive? }
// Переименование здесь безопасно: номера ссылаются на КОД, а не на label.
async function updateCapacity(req, res, next) {
  try {
    const id = parseInt(req.params.id)
    const existing = await prisma.roomCapacity.findUnique({ where: { id } })
    if (!existing) return next(createError('Тип вместимости не найден', 404))

    const { label, value, order, isActive } = req.body || {}
    const nextLabel = label !== undefined ? String(label).trim() : existing.label
    if (!nextLabel) return next(createError('Введите название типа вместимости', 400))

    const item = await prisma.roomCapacity.update({
      where: { id },
      data: {
        label: nextLabel,
        ...(value !== undefined && { value: normalizeCapacityValue(value) }),
        ...(order !== undefined && { order: parseInt(order) || 0 }),
        ...(isActive !== undefined && { isActive: !!isActive }),
      },
      select: CAPACITY_SELECT,
    })
    res.json({ data: item })
  } catch (err) {
    next(conflict(err, 'Такой тип вместимости уже есть'))
  }
}

/** 0 — «мест неизвестно» (так засеяны коды, расшифровки которых не было). */
function normalizeCapacityValue(value) {
  const n = parseInt(value)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.min(n, 99)
}

// ─── Удаление = скрытие ───────────────────────────────────────────────────────

/**
 * DELETE /api/room-fund/<вид>/:id[?purge=true]
 *
 * По умолчанию НЕ удаляет, а скрывает (isActive = false) — правило из NOTES
 * («заменить „удалить“ на „скрыть/показать“»). Причина простая: справочник
 * связан с номерами строкой, а не внешним ключом, и удалённая особенность
 * не исчезнет из Room.features — она просто перестанет быть в списке, и
 * номер начнёт показывать особенность, которой «нет».
 *
 * `?purge=true` удаляет строку насовсем, но только если ею НЕ пользуется
 * ни один номер — опечатку («Балкноы») надо чем-то убирать, иначе список
 * скрытых копит мусор навсегда. Занятую запись purge не трогает: отвечает 409
 * и говорит, сколько номеров её держат.
 *
 * Вернуть скрытую запись: PUT с { isActive: true }.
 */
function makeRemover({ delegate, usageKey, matchField, notFound, busy }) {
  return async function remove(req, res, next) {
    try {
      const id = parseInt(req.params.id)
      const existing = await delegate().findUnique({ where: { id } })
      if (!existing) return next(createError(notFound, 404))

      const used = (await usage())[usageKey].get(existing[matchField]) || 0
      const purge = req.query.purge === 'true' || req.query.purge === '1'

      if (purge) {
        if (used > 0) return next(createError(`${busy}: ${used}. Запись можно скрыть, но не удалить.`, 409))
        await delegate().delete({ where: { id } })
        return res.json({ data: { deleted: true, purged: true, usedByRooms: 0 } })
      }

      await delegate().update({ where: { id }, data: { isActive: false } })
      res.json({ data: { deleted: true, hidden: true, usedByRooms: used } })
    } catch (err) {
      next(err)
    }
  }
}

const removeBuilding = makeRemover({
  delegate: () => prisma.building,
  usageKey: 'buildings',
  matchField: 'name',
  notFound: 'Корпус не найден',
  busy: 'Корпус стоит у номеров',
})

const removeFeature = makeRemover({
  delegate: () => prisma.roomFeature,
  usageKey: 'features',
  matchField: 'name',
  notFound: 'Особенность не найдена',
  busy: 'Особенность стоит у номеров',
})

const removeCapacity = makeRemover({
  delegate: () => prisma.roomCapacity,
  usageKey: 'capacities',
  matchField: 'code',
  notFound: 'Тип вместимости не найден',
  busy: 'Вместимость стоит у номеров',
})

// ─── Разовый импорт того, что осталось в localStorage ─────────────────────────

/**
 * POST /api/room-fund/import
 *
 * Клиент на первом запуске после обновления заливает сюда свой localStorage —
 * тот самый справочник, который до сих пор жил только на этой машине.
 * Два свойства, ради которых эндпоинт вообще отдельный:
 *
 * 1. ИДЕМПОТЕНТНОСТЬ. Заливка повторяется с каждой машины и после каждой
 *    переустановки. Совпадение ищем по тому же ключу, по которому со
 *    справочником связаны номера: корпус и особенность — по НАЗВАНИЮ
 *    (без учёта регистра), вместимость — по КОДУ. Поэтому вторая машина
 *    с тем же «Корпусом Б» не создаёт второй строки.
 *
 * 2. ИМПОРТ ТОЛЬКО ДОБАВЛЯЕТ. Он не удаляет, не скрывает и не перезаписывает
 *    непустые значения — заполняет только пустые (описание корпуса, значок
 *    особенности, «мест» у вместимости). Причина: заливки приходят с разных
 *    машин в разное время, и localStorage второго ноутбука почти наверняка
 *    старее того, что администратор уже поправил на сервере. Импорт, который
 *    «выигрывает», молча откатил бы правку.
 *
 *    Единственное исключение — подпись вместимости вида «Вместимость <код>».
 *    Это не данные, а заглушка, которую поставила миграция для кода, чья
 *    расшифровка осталась как раз в localStorage. Её импорт вправе заменить.
 */
function placeholderCapacityLabel(code) {
  return `Вместимость ${code}`
}

async function importFund(req, res, next) {
  try {
    const body = req.body || {}
    const result = {
      buildings: await importBuildings(Array.isArray(body.buildings) ? body.buildings : []),
      features: await importFeatures(Array.isArray(body.features) ? body.features : []),
      capacities: await importCapacities(Array.isArray(body.capacities) ? body.capacities : []),
    }
    res.json({ data: result })
  } catch (err) {
    next(err)
  }
}

async function importBuildings(items) {
  const stat = { created: 0, updated: 0, skipped: 0 }
  if (!items.length) return stat

  const existing = await prisma.building.findMany()
  const byName = new Map(existing.map((b) => [matchKey(b.name), b]))
  const byCode = new Map(existing.map((b) => [b.code, b]))
  let order = Math.max(0, ...existing.map((b) => b.order))

  for (const raw of items) {
    const name = normalizeBuildingName(raw?.name)
    if (!name) { stat.skipped++; continue }
    const description = String(raw?.description ?? '').trim() || null
    const found = byName.get(matchKey(name)) || byCode.get(String(raw?.id ?? ''))

    if (found) {
      // Дополняем только пустое. Описание, уже введённое на сервере, чужой
      // localStorage перебить не может.
      if (description && !found.description) {
        await prisma.building.update({ where: { id: found.id }, data: { description } })
        stat.updated++
      } else {
        stat.skipped++
      }
      continue
    }

    const created = await prisma.building.create({
      data: {
        code: await uniqueCode(prisma.building, raw?.id || name, 'building'),
        name,
        description,
        order: ++order,
      },
    })
    byName.set(matchKey(name), created)
    byCode.set(created.code, created)
    stat.created++
  }
  return stat
}

async function importFeatures(items) {
  const stat = { created: 0, updated: 0, skipped: 0 }
  if (!items.length) return stat

  const existing = await prisma.roomFeature.findMany()
  const byName = new Map(existing.map((f) => [matchKey(f.name), f]))
  const byCode = new Map(existing.map((f) => [f.code, f]))
  let order = Math.max(0, ...existing.map((f) => f.order))

  for (const raw of items) {
    const name = String(raw?.name ?? '').trim()
    if (!name) { stat.skipped++; continue }
    const emoji = String(raw?.emoji ?? '').trim() || null
    const found = byName.get(matchKey(name)) || byCode.get(String(raw?.id ?? ''))

    if (found) {
      if (emoji && !found.emoji) {
        await prisma.roomFeature.update({ where: { id: found.id }, data: { emoji } })
        stat.updated++
      } else {
        stat.skipped++
      }
      continue
    }

    const created = await prisma.roomFeature.create({
      data: {
        code: await uniqueCode(prisma.roomFeature, raw?.id || name, 'feature'),
        name,
        emoji,
        order: ++order,
      },
    })
    byName.set(matchKey(name), created)
    byCode.set(created.code, created)
    stat.created++
  }
  return stat
}

async function importCapacities(items) {
  const stat = { created: 0, updated: 0, skipped: 0 }
  if (!items.length) return stat

  const existing = await prisma.roomCapacity.findMany()
  const byCode = new Map(existing.map((c) => [c.code, c]))
  const byLabel = new Map(existing.map((c) => [matchKey(c.label), c]))
  let order = Math.max(0, ...existing.map((c) => c.order))

  for (const raw of items) {
    const label = String(raw?.label ?? '').trim()
    const code = String(raw?.id ?? '').trim()
    if (!label) { stat.skipped++; continue }
    const value = normalizeCapacityValue(raw?.value)
    // Ключ связи с номерами — код, поэтому он важнее подписи.
    const found = (code && byCode.get(code)) || byLabel.get(matchKey(label))

    if (found) {
      const data = {}
      // Заглушку миграции («Вместимость <код>») заменяем: это не данные,
      // а признак того, что расшифровки не было.
      if (found.label === placeholderCapacityLabel(found.code) && label !== found.label) data.label = label
      if (value > 0 && found.value === 0) data.value = value
      if (Object.keys(data).length) {
        await prisma.roomCapacity.update({ where: { id: found.id }, data })
        stat.updated++
      } else {
        stat.skipped++
      }
      continue
    }

    const created = await prisma.roomCapacity.create({
      data: {
        code: await uniqueCode(prisma.roomCapacity, code || label, 'capacity'),
        label,
        value,
        order: ++order,
      },
    })
    byCode.set(created.code, created)
    byLabel.set(matchKey(created.label), created)
    stat.created++
  }
  return stat
}

module.exports = {
  all,
  listBuildings,
  listFeatures,
  listCapacities,
  createBuilding,
  updateBuilding,
  removeBuilding,
  createFeature,
  updateFeature,
  removeFeature,
  createCapacity,
  updateCapacity,
  removeCapacity,
  importFund,
  // для тестов
  ensureSeeded,
  DEFAULT_FEATURES,
  DEFAULT_CAPACITIES,
  normalizeBuildingName,
  slugify,
  matchKey,
  normalizeCapacityValue,
  placeholderCapacityLabel,
}
