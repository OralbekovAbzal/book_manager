const { getDataset } = require('./datasets')
const { createError } = require('../middleware/errorHandler')
const { isoDate, toUTCDate, DAY } = require('./dateUtils')
const { parse, evaluate, analyze, inferType, ExprError, truthy } = require('./expr')

/**
 * Движок отчётов: исполняет ОПРЕДЕЛЕНИЕ (данные), а не написанный руками отчёт.
 *
 * Зачем так: редактор и конструктор отчётов правят это же определение, а импорт —
 * просто загрузка чужого JSON. Определение НЕ содержит SQL и не может его задать:
 * оно лишь выбирает поля датасета, операции из списков ниже и формулы на
 * собственном языке (expr.js) без eval. Поэтому чужой файл не опаснее набора
 * настроек.
 *
 * Порядок: параметры -> загрузка датасета -> фильтры -> группировка -> колонки ->
 * сортировка -> итоги.
 */

const MAX_ROWS = 5000
const MAX_ROWS_EXPORT = 50000
const NUMERIC_TYPES = new Set(['int', 'number', 'money', 'percent'])

// --- Параметры --------------------------------------------------------------

/** Пресеты периода считаются от бизнес-даты (даты смены), а не от часов машины. */
function resolvePreset(preset, today) {
  const t = toUTCDate(today) || toUTCDate(new Date())
  const y = t.getUTCFullYear()
  const m = t.getUTCMonth()
  const mk = (yy, mm, dd) => new Date(Date.UTC(yy, mm, dd))
  switch (preset) {
    case 'today':        return { from: t, to: new Date(t.getTime() + DAY) }
    case 'last7':        return { from: new Date(t.getTime() - 6 * DAY), to: new Date(t.getTime() + DAY) }
    case 'last30':       return { from: new Date(t.getTime() - 29 * DAY), to: new Date(t.getTime() + DAY) }
    case 'currentMonth': return { from: mk(y, m, 1), to: mk(y, m + 1, 1) }
    case 'prevMonth':    return { from: mk(y, m - 1, 1), to: mk(y, m, 1) }
    case 'currentYear':  return { from: mk(y, 0, 1), to: mk(y + 1, 0, 1) }
    case 'prevYear':     return { from: mk(y - 1, 0, 1), to: mk(y, 0, 1) }
    default:             return { from: mk(y, m, 1), to: mk(y, m + 1, 1) }
  }
}

/**
 * Приводит параметры от клиента к тому, что объявлено в определении.
 * Период приходит включительным ("с 1 по 30"), внутри работаем полуинтервалом
 * [from, to) — иначе последний день теряется.
 */
function normalizeParams(definition, raw = {}, ctx = {}) {
  const out = {}
  for (const def of definition.params || []) {
    const value = raw[def.key]
    const empty = value === undefined || value === null || value === ''

    if (def.type === 'dateRange') {
      let from = toUTCDate(value && value.from)
      let to = toUTCDate(value && value.to)
      if (from && to) {
        to = new Date(to.getTime() + DAY)
      } else {
        const preset = (value && value.preset) || (def.default && def.default.preset) || 'currentMonth'
        const p = resolvePreset(preset, ctx.today)
        from = from || p.from
        to = to || p.to
      }
      if (to <= from) {
        throw createError(`Параметр «${def.label || def.key}»: дата «по» должна быть не раньше даты «с»`, 400)
      }
      out[def.key] = { from, to }
      continue
    }

    if (empty) {
      if (def.required) throw createError(`Не задан обязательный параметр «${def.label || def.key}»`, 400)
      out[def.key] = def.default !== undefined ? def.default : null
      continue
    }

    switch (def.type) {
      case 'select':
        if (def.options && !def.options.some((o) => same(o.value, value))) {
          throw createError(`Недопустимое значение параметра «${def.label || def.key}»`, 400)
        }
        out[def.key] = value
        break
      case 'multiselect': {
        const list = Array.isArray(value) ? value : [value]
        if (def.options) {
          for (const v of list) {
            if (!def.options.some((o) => same(o.value, v))) {
              throw createError(`Недопустимое значение параметра «${def.label || def.key}»`, 400)
            }
          }
        }
        out[def.key] = list
        break
      }
      case 'number': {
        const n = Number(value)
        if (Number.isNaN(n)) throw createError(`Параметр «${def.label || def.key}» должен быть числом`, 400)
        out[def.key] = n
        break
      }
      case 'boolean':
        out[def.key] = value === true || value === 'true'
        break
      default:
        out[def.key] = String(value)
    }
  }
  return out
}

// --- Фильтры ----------------------------------------------------------------

/**
 * Сравнение «по смыслу»: параметр из формы приходит строкой («2»), а поле
 * датасета может быть числом (этаж 2). Строгое === развело бы их в разные
 * стороны, и фильтр по этажу молча возвращал бы пустоту.
 */
const same = (v, t) => v === t || (v !== null && v !== undefined && t !== null && t !== undefined && String(v) === String(t))
const inList = (v, t) => Array.isArray(t) && t.some((x) => same(v, x))

const NO_VALUE_OPS = new Set(['isTrue', 'isFalse', 'notEmpty'])

const OPS = {
  eq:       (v, t) => same(v, t),
  neq:      (v, t) => !same(v, t),
  in:       (v, t) => inList(v, t),
  notIn:    (v, t) => Array.isArray(t) && !inList(v, t),
  contains: (v, t) => String(v === null || v === undefined ? '' : v).toLowerCase().includes(String(t === null || t === undefined ? '' : t).toLowerCase()),
  gt:       (v, t) => Number(v) > Number(t),
  gte:      (v, t) => Number(v) >= Number(t),
  lt:       (v, t) => Number(v) < Number(t),
  lte:      (v, t) => Number(v) <= Number(t),
  isTrue:   (v) => v === true || v === 1,
  isFalse:  (v) => v === false || v === 0,
  notEmpty: (v) => v !== null && v !== undefined && v !== '',
  hasAny:   (v, t) => Array.isArray(v) && Array.isArray(t) && v.some((x) => inList(x, t)),
}

/**
 * Фильтр бывает трёх видов:
 *  - по полю с операцией и значением-константой (`value`);
 *  - по полю с операцией и значением из параметра (`param`) — пустой параметр
 *    значит «фильтр не применяется», так один отчёт работает и «по всем
 *    корпусам», и «по корпусу А»;
 *  - формула-условие (`expr`): `totalAmount - paidAmount > 0`.
 *
 * `when: { param, eq }` — применить фильтр только при таком значении параметра.
 * Нужно для переключателей вида «ремонт: исключить / только / вместе».
 */
function buildFilters(definition, dataset, params) {
  const paramGet = (name) => params[name]
  const active = []
  for (const f of definition.filters || []) {
    if (f.when && f.when.param !== undefined && !same(params[f.when.param], f.when.eq)) continue

    if (f.expr) {
      // Формула фильтра приходит из определения (в том числе импортированного):
      // её ошибка — ошибка определения (400), а не сервера.
      let ast
      try {
        ast = parse(f.expr)
      } catch (err) {
        if (err instanceof ExprError || err instanceof RangeError) {
          throw createError(`Отчёт «${definition.id}»: формула фильтра: ${err.message}`, 400)
        }
        throw err
      }
      active.push({ ast, expr: f.expr, negate: !!f.negate, paramGet })
      continue
    }

    if (!dataset.fields[f.field]) {
      throw createError(`Отчёт «${definition.id}»: неизвестное поле фильтра «${f.field}»`, 400)
    }
    const op = OPS[f.op]
    if (!op) throw createError(`Отчёт «${definition.id}»: неизвестная операция «${f.op}»`, 400)

    let target = f.value
    if (f.param !== undefined && f.param !== null && f.param !== '') {
      target = params[f.param]
      const isEmpty = target === null || target === undefined || target === ''
        || (Array.isArray(target) && target.length === 0)
      if (isEmpty) continue
    } else if (!NO_VALUE_OPS.has(f.op) && (target === undefined || target === '' || (Array.isArray(target) && !target.length))) {
      // Константа ещё не введена (конструктор только что добавил фильтр) —
      // это «фильтр не настроен», а не «поле равно пустой строке».
      continue
    }
    active.push({ field: f.field, op, target, negate: !!f.negate })
  }
  return active
}

function applyFilters(rows, filters) {
  if (!filters.length) return rows
  return rows.filter((row) => filters.every((f) => {
    let ok
    if (f.ast) {
      try {
        ok = truthy(evaluate(f.ast, { get: (n) => row[n], param: f.paramGet, rows: null }))
      } catch (err) {
        throw createError(`Условие «${f.expr}»: ${err.message}`, 400)
      }
    } else {
      ok = f.op(row[f.field], f.target)
    }
    return f.negate ? !ok : ok
  }))
}

// --- Группировка и агрегаты -------------------------------------------------

function resolveGroupBy(definition, dataset, params) {
  let spec = definition.groupBy
  if (!spec) return []
  if (!Array.isArray(spec)) {
    if (spec.param) {
      const v = params[spec.param]
      spec = v ? (Array.isArray(v) ? v : [v]) : []
    } else {
      spec = []
    }
  }
  const list = spec.filter(Boolean)
  for (const key of list) {
    const field = dataset.fields[key]
    if (!field) throw createError(`Неизвестное поле группировки «${key}»`, 400)
    if (!field.groupable) throw createError(`По полю «${field.label}» группировать нельзя`, 400)
  }
  return list
}

const AGGS = {
  sum:   (rows, a) => rows.reduce((s, r) => s + (Number(r[a.field]) || 0), 0),
  count: (rows) => rows.length,
  countDistinct: (rows, a) => new Set(rows.map((r) => r[a.field])).size,
  min:   (rows, a) => rows.reduce((m, r) => (m === null || r[a.field] < m ? r[a.field] : m), null),
  max:   (rows, a) => rows.reduce((m, r) => (m === null || r[a.field] > m ? r[a.field] : m), null),
  avg:   (rows, a) => (rows.length ? AGGS.sum(rows, a) / rows.length : 0),
  first: (rows, a) => (rows.length ? rows[0][a.field] : null),
  /**
   * Доля a/b. Считается ОТ СУММ, а не как среднее долей: у номеров разное число
   * доступных ночей, и среднее процентов даёт неверную загрузку.
   */
  ratio: (rows, a) => {
    const num = AGGS.sum(rows, { field: a.field })
    const den = AGGS.sum(rows, { field: a.of })
    if (!den) return null
    return (num / den) * (a.scale || 1)
  },
}

function roundTo(value, decimals) {
  if (typeof value !== 'number' || !Number.isFinite(value) || decimals === undefined || decimals === null) return value
  const k = 10 ** decimals
  return Math.round(value * k) / k
}

function computeAgg(rows, agg) {
  const fn = AGGS[agg.fn]
  if (!fn) throw createError(`Неизвестный агрегат «${agg.fn}»`, 400)
  return roundTo(fn(rows, agg), agg.decimals)
}

/**
 * Тип колонки, если в определении он не задан. Конструктор оставляет тип
 * «авто» в большинстве случаев, поэтому вывод должен быть предсказуемым:
 * количество — целое, доля ×100 — процент, формула — число, остальное — как
 * у исходного поля.
 */
function deriveType(dataset, field, agg, expr) {
  // `inferType` рекурсивен по дереву: на формуле из старой базы он мог бросить
  // RangeError мимо всех try — и колонка отвечала 500 вместо «формула сложная».
  if (expr) {
    try {
      return inferType(expr)
    } catch (err) {
      if (err instanceof ExprError || err instanceof RangeError) {
        throw createError(`Формула колонки: ${err.message}`, 400)
      }
      throw err
    }
  }
  if (agg) {
    if (agg.fn === 'count' || agg.fn === 'countDistinct') return 'int'
    if (agg.fn === 'ratio') return agg.scale === 100 ? 'percent' : 'number'
    if (agg.fn === 'avg') return 'number'
    const src = dataset.fields[agg.field]
    return (src && src.type) || 'number'
  }
  const src = field && dataset.fields[field]
  return (src && src.type) || 'text'
}

/** '$group' -> первое поле группировки, '$group.1' -> второе. */
function resolveFieldRef(ref, groupBy) {
  if (typeof ref !== 'string' || !ref.startsWith('$group')) return ref
  const idx = ref === '$group' ? 0 : Number(ref.split('.')[1] || 0)
  return groupBy[idx] || null
}

function buildColumns(definition, dataset, groupBy) {
  return (definition.columns || []).map((col) => {
    const field = resolveFieldRef(col.field, groupBy)
    const agg = col.agg
      ? Object.assign({}, col.agg, {
          field: resolveFieldRef(col.agg.field, groupBy),
          of: resolveFieldRef(col.agg.of, groupBy),
        })
      : null

    // Готовый показатель датасета — это именованная формула с типом и подписью
    let metric = null
    if (col.metric) {
      metric = dataset.metrics && dataset.metrics[col.metric]
      if (!metric) throw createError(`Неизвестный показатель «${col.metric}»`, 400)
    }
    const expr = metric ? metric.expr : col.expr
    let ast = null
    let usesAgg = false
    if (expr) {
      try {
        ast = parse(expr)
        usesAgg = analyze(expr).usesAgg
      } catch (err) {
        throw createError(`Формула колонки «${col.title || col.key}»: ${err.message}`, 400)
      }
    }

    let title = col.title
    if (!title && col.titleFrom) {
      const src = resolveFieldRef(col.titleFrom, groupBy)
      title = (dataset.fields[src] && dataset.fields[src].label) || src
    }
    if (!title && metric) title = metric.label
    if (!title && field) title = (dataset.fields[field] && dataset.fields[field].label) || field
    if (!title && agg) {
      const src = dataset.fields[agg.field]
      title = src ? src.label : agg.fn
    }

    const type = col.type || (metric && metric.type) || deriveType(dataset, field, agg, ast ? expr : null)
    const decimals = col.decimals !== undefined ? col.decimals : (metric ? metric.decimals : undefined)
    return {
      key: col.key,
      title: title || col.key,
      type,
      align: col.align || (NUMERIC_TYPES.has(type) ? 'right' : 'left'),
      width: col.width,
      field,
      agg,
      ast,
      expr,
      usesAgg,
      decimals,
      noTotal: col.total === false,
    }
  })
}

function groupRows(rows, groupBy) {
  const map = new Map()
  for (const row of rows) {
    const key = groupBy.map((g) => String(row[g] === null || row[g] === undefined ? '' : row[g])).join(' ')
    let bucket = map.get(key)
    if (!bucket) {
      bucket = { keyValues: groupBy.map((g) => row[g]), rows: [] }
      map.set(key, bucket)
    }
    bucket.rows.push(row)
  }
  return [...map.values()]
}

function sortRows(rows, definition, columns) {
  const spec = definition.sort
  if (!Array.isArray(spec) || !spec.length) return rows
  const known = new Set(columns.map((c) => c.key))
  return [...rows].sort((a, b) => {
    for (const s of spec) {
      if (!known.has(s.key)) continue
      const av = a[s.key]
      const bv = b[s.key]
      if (av === bv) continue
      if (av === null || av === undefined) return 1
      if (bv === null || bv === undefined) return -1
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv), 'ru')
      return s.dir === 'desc' ? -cmp : cmp
    }
    return 0
  })
}

/** Ошибка формулы во время счёта — это ошибка определения (400), а не сервера. */
function evalColumn(col, ctx) {
  try {
    return roundTo(evaluate(col.ast, ctx), col.decimals)
  } catch (err) {
    if (err instanceof ExprError) throw createError(`Формула колонки «${col.title}»: ${err.message}`, 400)
    // Переполнение стека на глубокой формуле — тоже ошибка определения:
    // 500 «Внутренняя ошибка сервера» здесь ничего не объясняет пользователю.
    if (err instanceof RangeError) throw createError(`Формула колонки «${col.title}»: формула слишком сложная`, 400)
    throw err
  }
}

// --- Запуск -----------------------------------------------------------------

/**
 * @param {object} definition определение отчёта
 * @param {object} rawParams  параметры от клиента
 * @param {object} ctx        { today: бизнес-дата, forExport: boolean }
 */
async function runReport(definition, rawParams, ctx = {}) {
  const dataset = getDataset(definition.dataset)
  if (!dataset) throw createError(`Неизвестный источник данных «${definition.dataset}»`, 400)

  const params = normalizeParams(definition, rawParams, ctx)
  const paramGet = (name) => params[name]
  const groupBy = resolveGroupBy(definition, dataset, params)
  const columns = buildColumns(definition, dataset, groupBy)
  const filters = buildFilters(definition, dataset, params)

  const sourceRows = applyFilters(await dataset.load({ params, definition }), filters)

  // Расчётные колонки без группировки — это «сводка»: одна строка по всем
  // отобранным данным (сколько всего броней, средняя длина проживания…).
  const aggregated = groupBy.length > 0 || columns.some((c) => c.agg || c.usesAgg)

  let rows
  if (aggregated) {
    rows = groupRows(sourceRows, groupBy).map((bucket) => {
      const out = {}
      // Имя в формуле: уже посчитанная колонка -> поле группировки -> поле первой
      // строки группы (как и у обычных колонок-полей в сгруппированном отчёте).
      const evalCtx = {
        get: (n) => {
          if (n in out) return out[n]
          const gi = groupBy.indexOf(n)
          if (gi >= 0) return bucket.keyValues[gi]
          return bucket.rows.length ? bucket.rows[0][n] : undefined
        },
        param: paramGet,
        rows: bucket.rows,
      }
      for (const col of columns) {
        if (col.ast) {
          out[col.key] = evalColumn(col, evalCtx)
        } else if (col.agg) {
          out[col.key] = computeAgg(bucket.rows, col.agg)
        } else if (col.field) {
          const gi = groupBy.indexOf(col.field)
          if (gi >= 0) out[col.key] = bucket.keyValues[gi]
          else out[col.key] = bucket.rows.length ? bucket.rows[0][col.field] : null
        } else {
          out[col.key] = null
        }
      }
      return out
    })
  } else {
    rows = sourceRows.map((row) => {
      const out = {}
      const evalCtx = { get: (n) => (row[n] !== undefined ? row[n] : out[n]), param: paramGet, rows: null }
      for (const col of columns) {
        if (col.ast) out[col.key] = evalColumn(col, evalCtx)
        else out[col.key] = col.field ? (row[col.field] === undefined ? null : row[col.field]) : null
      }
      return out
    })
  }

  rows = sortRows(rows, definition, columns)

  // Итоги считаются по ВСЕМ отобранным строкам, а не по видимой странице,
  // и формулы/доли — заново от всех строк, а не суммой колонки. Поэтому
  // «Итого» по загрузке — это загрузка за период, а не сумма процентов.
  // У сводки из одной строки итог повторял бы её же — не считаем.
  const totals = {}
  const wantTotals = !aggregated || groupBy.length > 0
  if (wantTotals) {
    const totalsCtx = { get: (n) => totals[n], param: paramGet, rows: sourceRows }
    for (const col of columns) {
      if (col.noTotal) continue
      if (col.ast) {
        if (aggregated) {
          totals[col.key] = evalColumn(col, totalsCtx)
        } else if (NUMERIC_TYPES.has(col.type)) {
          // Сумма только по настоящим числам: формула с типом «число» может
          // вернуть текст, и тогда «Итого: 0» врёт. Хвост float-мусора срезаем.
          const values = rows.map((r) => r[col.key]).filter((v) => v !== null && v !== undefined)
          if (values.length && values.every((v) => typeof v === 'number')) {
            const sum = values.reduce((s, v) => s + v, 0)
            totals[col.key] = col.decimals !== undefined ? roundTo(sum, col.decimals) : Math.round(sum * 1e9) / 1e9
          }
        }
      } else if (col.agg) {
        totals[col.key] = computeAgg(sourceRows, col.agg)
      } else if (!aggregated && ['int', 'number', 'money'].includes(col.type)) {
        totals[col.key] = AGGS.sum(sourceRows, { field: col.field })
      }
    }
  }

  const limit = ctx.forExport ? MAX_ROWS_EXPORT : (definition.limit || MAX_ROWS)
  const truncated = rows.length > limit

  const outParams = Object.assign({}, params)
  if (params.period) {
    // Наружу отдаём период в том же включительном виде, в каком его задали.
    outParams.period = {
      from: isoDate(params.period.from),
      to: isoDate(new Date(params.period.to.getTime() - DAY)),
    }
  }

  return {
    report: { id: definition.id, title: definition.title, dataset: dataset.id },
    params: outParams,
    groupBy,
    columns: columns.map((c) => ({ key: c.key, title: c.title, type: c.type, align: c.align, width: c.width })),
    rows: truncated ? rows.slice(0, limit) : rows,
    totals,
    meta: {
      rowCount: rows.length,
      sourceRowCount: sourceRows.length,
      truncated,
      limit,
      generatedAt: new Date().toISOString(),
    },
  }
}

module.exports = {
  runReport,
  normalizeParams,
  resolvePreset,
  resolveGroupBy,
  OPS,
  AGGS,
  MAX_ROWS,
  MAX_ROWS_EXPORT,
}
