const fs = require('fs')
const path = require('path')
const { prisma } = require('../utils/prisma')
const { createError } = require('../middleware/errorHandler')
const { getDataset } = require('./datasets')
const { OPS, AGGS } = require('./engine')
const { analyze } = require('./expr')
const { SOURCES } = require('./options')
const { PARAM_TYPES, COLUMN_TYPES } = require('./vocab')
const { translit } = require('./export')

/**
 * Реестр определений отчётов — два источника, один интерфейс.
 *
 *   builtin — файлы `definitions/*.json`: поставляются с приложением, не правятся
 *             (только копируются). Ошибка в них — ошибка сборки, поэтому
 *             проверяются при старте и роняют процесс.
 *   custom  — таблица ReportDefinition: конструктор, редактор, импорт JSON.
 *
 * Движку всё равно, откуда определение; различие нужно только этому файлу —
 * что можно менять и удалять.
 */

const DEFINITIONS_DIR = path.join(__dirname, 'definitions')

// Что из определения сохраняем. Всё остальное (source, editable, createdBy…) —
// служебные поля ответа API, в файл/БД им не место.
const DEFINITION_KEYS = [
  'id', 'version', 'title', 'description', 'icon', 'dataset', 'params', 'filters',
  'groupBy', 'columns', 'sort', 'limit', 'chart', 'totalsLabel',
]

const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i
const PARAM_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/
const NO_VALUE_OPS = new Set(['isTrue', 'isFalse', 'notEmpty'])
const PARAM_TYPE_SET = new Set(PARAM_TYPES.map((t) => t.value))
const COLUMN_TYPE_SET = new Set(COLUMN_TYPES.map((t) => t.value))

let builtins = null

function loadBuiltins() {
  if (builtins) return builtins
  const files = fs.readdirSync(DEFINITIONS_DIR).filter((f) => f.endsWith('.json'))
  builtins = files.map((file) => {
    const raw = JSON.parse(fs.readFileSync(path.join(DEFINITIONS_DIR, file), 'utf8'))
    const problems = validateDefinition(raw)
    if (problems.length) {
      throw new Error(`Определение отчёта ${file} некорректно: ${problems.join('; ')}`)
    }
    return Object.assign({}, raw, { source: 'builtin', editable: false })
  })
  return builtins
}

/** Только содержательные поля определения, без служебных. */
function cleanDefinition(def) {
  const out = {}
  for (const key of DEFINITION_KEYS) {
    if (def[key] !== undefined) out[key] = def[key]
  }
  return out
}

// --- Проверка -----------------------------------------------------------------

/**
 * Полная проверка определения. Возвращает СПИСОК проблем человеческим языком,
 * а не первую попавшуюся: конструктор и импорт показывают их все разом,
 * чтобы файл правили за один заход.
 */
function validateDefinition(def) {
  const problems = []
  if (!def || typeof def !== 'object' || Array.isArray(def)) return ['определение должно быть объектом']

  if (def.id !== undefined && def.id !== null && def.id !== '' && !KEY_RE.test(String(def.id))) {
    problems.push('id: только латиница, цифры, «-» и «_», не длиннее 64 символов')
  }
  if (!def.title || !String(def.title).trim()) problems.push('не задано название отчёта')

  const dataset = getDataset(def.dataset)
  if (!dataset) {
    problems.push(`неизвестный источник данных «${def.dataset || ''}»`)
    return problems
  }
  const fields = dataset.fields
  const isGroupRef = (name) => typeof name === 'string' && name.startsWith('$group')
  const fieldOk = (name) => typeof name === 'string' && (isGroupRef(name) || !!fields[name])

  // Параметры
  if (def.params !== undefined && !Array.isArray(def.params)) problems.push('params должен быть списком')
  const params = Array.isArray(def.params) ? def.params : []
  const paramKeys = new Set()
  params.forEach((p, i) => {
    const at = `параметр №${i + 1}`
    if (!p || typeof p !== 'object') { problems.push(`${at}: не объект`); return }
    const name = p.key ? `параметр «${p.key}»` : at
    if (!p.key || !PARAM_KEY_RE.test(p.key)) {
      problems.push(`${at}: ключ — латиница, цифры и «_», начинается с буквы`)
    } else if (paramKeys.has(p.key)) {
      problems.push(`${name} повторяется`)
    } else {
      paramKeys.add(p.key)
    }
    if (!PARAM_TYPE_SET.has(p.type)) problems.push(`${name}: неизвестный тип «${p.type || ''}»`)
    if (!p.label || !String(p.label).trim()) problems.push(`${name}: нет подписи`)
    if ((p.type === 'select' || p.type === 'multiselect')
      && !p.optionsFrom && !(Array.isArray(p.options) && p.options.length)) {
      problems.push(`${name}: нужен список значений или справочник`)
    }
    if (p.optionsFrom && !SOURCES[p.optionsFrom]) {
      problems.push(`${name}: неизвестный справочник «${p.optionsFrom}»`)
    }
    if (Array.isArray(p.options)) {
      p.options.forEach((o, j) => {
        if (!o || typeof o !== 'object' || o.value === undefined || o.value === '') {
          problems.push(`${name}: значение №${j + 1} пустое`)
        }
      })
    }
  })
  if (dataset.requiresPeriod) {
    const period = params.find((p) => p && p.key === 'period')
    if (!period) problems.push('источник данных требует параметр «period» типа «Период»')
    else if (period.type !== 'dateRange') problems.push('параметр «period» должен быть типа «Период»')
  }

  // Формулы: имена должны быть известны ДО запуска — иначе опечатка в поле
  // молча даст null в готовом отчёте. `allowed` — что можно вне агрегатов.
  const checkExpr = (src, at, { allowed, aggAllowed }) => {
    const a = analyze(src)
    a.problems.forEach((p) => problems.push(`${at}: ${p}`))
    if (a.usesAgg && !aggAllowed) problems.push(`${at}: агрегаты (sum, count…) в условии фильтра нельзя`)
    for (const name of a.idents) {
      if (!allowed.has(name) && !fields[name]) problems.push(`${at}: неизвестное имя «${name}»`)
    }
    for (const name of a.aggIdents) {
      if (!fields[name] && !allowed.has(name)) problems.push(`${at}: неизвестное поле «${name}» внутри агрегата`)
    }
    for (const name of a.params) {
      if (!paramKeys.has(name)) problems.push(`${at}: параметр «@${name}» не объявлен`)
    }
    return a
  }

  // Фильтры
  if (def.filters !== undefined && !Array.isArray(def.filters)) problems.push('filters должен быть списком')
  ;(Array.isArray(def.filters) ? def.filters : []).forEach((f, i) => {
    const at = `фильтр №${i + 1}`
    if (!f || typeof f !== 'object') { problems.push(`${at}: не объект`); return }
    if (f.when && f.when.param !== undefined && !paramKeys.has(f.when.param)) {
      problems.push(`${at}: условие ссылается на параметр «${f.when.param}», которого нет`)
    }
    if (f.expr !== undefined) {
      if (!String(f.expr).trim()) problems.push(`${at}: пустая формула условия`)
      else checkExpr(f.expr, at, { allowed: new Set(), aggAllowed: false })
      return
    }
    if (!f.field || isGroupRef(f.field) || !fields[f.field]) problems.push(`${at}: неизвестное поле «${f.field || ''}»`)
    if (!OPS[f.op]) problems.push(`${at}: неизвестная операция «${f.op || ''}»`)
    if (f.param !== undefined && f.param !== null && f.param !== '' && !paramKeys.has(f.param)) {
      problems.push(`${at}: параметр «${f.param}» не объявлен`)
    }
    const hasParam = f.param !== undefined && f.param !== null && f.param !== ''
    if (!hasParam && f.value === undefined && !NO_VALUE_OPS.has(f.op)) {
      problems.push(`${at}: не задано ни значение, ни параметр`)
    }
  })

  // Группировка
  let groupFields = []
  let grouped = false
  if (def.groupBy !== undefined && def.groupBy !== null) {
    if (Array.isArray(def.groupBy)) {
      groupFields = def.groupBy
      grouped = def.groupBy.length > 0
    } else if (typeof def.groupBy === 'object' && def.groupBy.param) {
      grouped = true
      if (!paramKeys.has(def.groupBy.param)) {
        problems.push(`группировка ссылается на параметр «${def.groupBy.param}», которого нет`)
      } else {
        const p = params.find((x) => x && x.key === def.groupBy.param)
        if (Array.isArray(p.options)) groupFields = p.options.map((o) => o.value)
      }
    } else {
      problems.push('groupBy: список полей или { param }')
    }
  }
  groupFields.forEach((g) => {
    if (!fields[g]) problems.push(`группировка: неизвестное поле «${g}»`)
    else if (!fields[g].groupable) problems.push(`группировка: по полю «${fields[g].label}» группировать нельзя`)
  })

  // Колонки
  const colKeys = new Set()
  if (!Array.isArray(def.columns) || !def.columns.length) problems.push('нет ни одной колонки')
  ;(Array.isArray(def.columns) ? def.columns : []).forEach((c, i) => {
    const at = c && c.title ? `колонка «${c.title}»` : `колонка №${i + 1}`
    if (!c || typeof c !== 'object') { problems.push(`${at}: не объект`); return }
    if (!c.key) problems.push(`${at}: нет ключа`)
    else if (colKeys.has(c.key)) problems.push(`${at}: ключ «${c.key}» повторяется`)
    else colKeys.add(c.key)

    const hasExpr = c.expr !== undefined && c.expr !== null && String(c.expr).trim() !== ''
    if (!c.field && !c.agg && !hasExpr && !c.metric) problems.push(`${at}: не задано ни поле, ни расчёт, ни формула`)
    if (c.field && !fieldOk(c.field)) problems.push(`${at}: неизвестное поле «${c.field}»`)
    if (c.field && isGroupRef(c.field) && !grouped) problems.push(`${at}: колонка «группа» без группировки`)
    if (c.metric && !(dataset.metrics && dataset.metrics[c.metric])) problems.push(`${at}: неизвестный показатель «${c.metric}»`)
    if (hasExpr) {
      // Формула видит колонки, посчитанные ДО неё (порядок колонок — порядок счёта)
      checkExpr(c.expr, at, { allowed: new Set(colKeys), aggAllowed: true })
    }
    if (c.decimals !== undefined && c.decimals !== null && !(Number.isInteger(c.decimals) && c.decimals >= 0 && c.decimals <= 6)) {
      problems.push(`${at}: знаков после запятой — целое от 0 до 6`)
    }
    if (c.agg) {
      if (typeof c.agg !== 'object') problems.push(`${at}: расчёт должен быть объектом`)
      else if (!AGGS[c.agg.fn]) problems.push(`${at}: неизвестный расчёт «${c.agg.fn || ''}»`)
      else {
        if (c.agg.fn !== 'count' && !fieldOk(c.agg.field)) {
          problems.push(`${at}: не задано поле для расчёта`)
        }
        if (c.agg.fn === 'ratio' && !fieldOk(c.agg.of)) {
          problems.push(`${at}: для доли нужно поле «из чего»`)
        }
      }
    }
    if (c.type && !COLUMN_TYPE_SET.has(c.type)) problems.push(`${at}: неизвестный тип «${c.type}»`)
  })

  // Сортировка и лимит
  ;(Array.isArray(def.sort) ? def.sort : []).forEach((s) => {
    if (!s || !colKeys.has(s.key)) problems.push(`сортировка: нет колонки «${s && s.key}»`)
  })
  if (def.limit !== undefined && def.limit !== null && !(Number.isInteger(def.limit) && def.limit > 0)) {
    problems.push('лимит строк: целое число больше нуля')
  }

  return problems
}

function assertValid(def) {
  const problems = validateDefinition(def)
  if (problems.length) {
    const err = createError('Определение отчёта некорректно', 400)
    err.problems = problems
    throw err
  }
}

// --- Чтение -------------------------------------------------------------------

const CUSTOM_INCLUDE = { createdBy: { select: { name: true } } }

function rowToDefinition(row) {
  return Object.assign({}, row.definition, {
    id: row.key,
    title: row.title,
    description: row.description === null ? undefined : row.description,
    source: 'custom',
    editable: true,
    createdBy: row.createdBy ? row.createdBy.name : null,
    updatedAt: row.updatedAt,
  })
}

async function listDefinitions() {
  const rows = await prisma.reportDefinition.findMany({
    orderBy: { title: 'asc' },
    include: CUSTOM_INCLUDE,
  })
  return [...loadBuiltins(), ...rows.map(rowToDefinition)]
}

async function getDefinition(id) {
  const builtin = loadBuiltins().find((d) => d.id === id)
  if (builtin) return builtin
  const row = await prisma.reportDefinition.findUnique({ where: { key: String(id) }, include: CUSTOM_INCLUDE })
  if (!row) throw createError(`Отчёт «${id}» не найден`, 404)
  return rowToDefinition(row)
}

// --- Запись -------------------------------------------------------------------

async function keyExists(key) {
  if (loadBuiltins().some((d) => d.id === key)) return true
  return !!(await prisma.reportDefinition.findUnique({ where: { key }, select: { id: true } }))
}

/**
 * Свободный ключ: из названия транслитом, при совпадении — с номером.
 * Импортированному отчёту так можно менять ключ молча: он всё равно чужой.
 */
async function uniqueKey(preferred, title) {
  const base = (preferred && KEY_RE.test(preferred) ? preferred : translit(title || 'report')).slice(0, 56)
  if (!(await keyExists(base))) return base
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`
    if (!(await keyExists(candidate))) return candidate
  }
  throw createError('Не удалось подобрать свободный ключ отчёта', 500)
}

function rowData(def, adminId) {
  const clean = cleanDefinition(def)
  delete clean.id
  return {
    title: String(def.title).trim(),
    description: def.description ? String(def.description).trim() : null,
    definition: clean,
    createdById: adminId || null,
  }
}

/** Создание из конструктора: явный ключ должен быть свободен, иначе — ошибка. */
async function createDefinition(input, adminId) {
  assertValid(input)
  const wanted = input.id ? String(input.id) : ''
  if (wanted && (await keyExists(wanted))) {
    throw createError(`Отчёт с ключом «${wanted}» уже есть`, 409)
  }
  const key = await uniqueKey(wanted, input.title)
  const row = await prisma.reportDefinition.create({
    data: Object.assign({ key }, rowData(input, adminId)),
    include: CUSTOM_INCLUDE,
  })
  return rowToDefinition(row)
}

/** Импорт JSON: занятый ключ не ошибка — берём следующий свободный и сообщаем. */
async function importDefinition(input, adminId) {
  assertValid(input)
  const wanted = input.id ? String(input.id) : ''
  const key = await uniqueKey(wanted, input.title)
  const row = await prisma.reportDefinition.create({
    data: Object.assign({ key }, rowData(input, adminId)),
    include: CUSTOM_INCLUDE,
  })
  return { definition: rowToDefinition(row), renamed: !!wanted && key !== wanted, requestedId: wanted || null }
}

async function updateDefinition(id, input) {
  if (loadBuiltins().some((d) => d.id === id)) {
    throw createError('Встроенный отчёт изменить нельзя — создайте его копию', 403)
  }
  const existing = await prisma.reportDefinition.findUnique({ where: { key: String(id) } })
  if (!existing) throw createError(`Отчёт «${id}» не найден`, 404)

  // Ключ — это адрес отчёта; при правке он не меняется, что бы ни пришло в id.
  const merged = Object.assign({}, input, { id })
  assertValid(merged)

  const data = rowData(merged, undefined)
  delete data.createdById
  const row = await prisma.reportDefinition.update({
    where: { key: String(id) },
    data,
    include: CUSTOM_INCLUDE,
  })
  return rowToDefinition(row)
}

async function removeDefinition(id) {
  if (loadBuiltins().some((d) => d.id === id)) {
    throw createError('Встроенный отчёт удалить нельзя', 403)
  }
  const existing = await prisma.reportDefinition.findUnique({ where: { key: String(id) } })
  if (!existing) throw createError(`Отчёт «${id}» не найден`, 404)
  await prisma.reportDefinition.delete({ where: { key: String(id) } })
}

module.exports = {
  listDefinitions,
  getDefinition,
  validateDefinition,
  cleanDefinition,
  createDefinition,
  updateDefinition,
  removeDefinition,
  importDefinition,
}
