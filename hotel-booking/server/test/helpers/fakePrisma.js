/**
 * Мини-Prisma в памяти.
 *
 * Смысл не в том, чтобы «замокать и вернуть что скажут», а в том, чтобы тесты
 * реально проверяли ЗАПРОС, который строит модуль: границы `lt`/`gt`, фильтр
 * по статусу, исключение самой брони. Поэтому здесь настоящий вычислитель
 * `where` — если модуль перепутает `lt` и `lte`, тест это увидит.
 *
 * Неизвестная операция или обращение к полю, которого нет в фикстуре, —
 * исключение, а не молчаливое «ничего не нашлось».
 */

function isPlainCondition(v) {
  return v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)
}

function cmp(a, b) {
  const x = a instanceof Date ? a.getTime() : a
  const y = b instanceof Date ? b.getTime() : b
  if (x < y) return -1
  if (x > y) return 1
  return 0
}

function eq(a, b) {
  if (a instanceof Date || b instanceof Date) {
    const x = a instanceof Date ? a.getTime() : a
    const y = b instanceof Date ? b.getTime() : b
    return x === y
  }
  return a === b
}

function matchField(key, value, cond) {
  if (cond === null) return value === null || value === undefined
  if (!isPlainCondition(cond)) return eq(value, cond)

  for (const [op, operand] of Object.entries(cond)) {
    switch (op) {
      case 'equals': if (!eq(value, operand)) return false; break
      case 'lt': if (!(cmp(value, operand) < 0)) return false; break
      case 'lte': if (!(cmp(value, operand) <= 0)) return false; break
      case 'gt': if (!(cmp(value, operand) > 0)) return false; break
      case 'gte': if (!(cmp(value, operand) >= 0)) return false; break
      case 'in': if (!operand.some((o) => eq(value, o))) return false; break
      case 'notIn': if (operand.some((o) => eq(value, o))) return false; break
      case 'contains': if (!String(value ?? '').includes(String(operand))) return false; break
      case 'not':
        if (isPlainCondition(operand)) { if (matchField(key, value, operand)) return false }
        else if (eq(value, operand)) return false
        break
      default:
        throw new Error(`fakePrisma: операция where.${key}.${op} не поддерживается — допишите её в helpers/fakePrisma.js`)
    }
  }
  return true
}

function matchWhere(rec, where) {
  for (const [key, cond] of Object.entries(where || {})) {
    if (key === 'AND') { if (!cond.every((w) => matchWhere(rec, w))) return false; continue }
    if (key === 'OR') { if (!cond.some((w) => matchWhere(rec, w))) return false; continue }
    if (key === 'NOT') { if (matchWhere(rec, cond)) return false; continue }
    if (!(key in rec)) {
      throw new Error(`fakePrisma: в фикстуре нет поля «${key}», а запрос по нему фильтрует`)
    }
    if (!matchField(key, rec[key], cond)) return false
  }
  return true
}

function applyOrder(rows, orderBy) {
  if (!orderBy) return rows
  const clauses = Array.isArray(orderBy) ? orderBy : [orderBy]
  return [...rows].sort((a, b) => {
    for (const clause of clauses) {
      for (const [field, dir] of Object.entries(clause)) {
        const c = cmp(a[field], b[field])
        if (c !== 0) return dir === 'desc' ? -c : c
      }
    }
    return 0
  })
}

function project(rec, args) {
  if (args.select) {
    const out = {}
    for (const [k, on] of Object.entries(args.select)) {
      if (!on) continue
      if (!(k in rec)) throw new Error(`fakePrisma: select запрашивает поле «${k}», которого нет в фикстуре`)
      out[k] = rec[k]
    }
    return out
  }
  if (args.include) {
    for (const k of Object.keys(args.include)) {
      if (!(k in rec)) throw new Error(`fakePrisma: include запрашивает связь «${k}», которой нет в фикстуре`)
    }
  }
  return { ...rec }
}

/** `data` записи: обычные значения и атомарный `{ increment: n }` (Admin.tokenVersion). */
function applyData(rec, data) {
  for (const [k, v] of Object.entries(data)) {
    if (isPlainCondition(v) && 'increment' in v) rec[k] = (rec[k] ?? 0) + v.increment
    else rec[k] = v
  }
}

/**
 * Свёртки `_sum` / `_count` над набором строк — общие для groupBy и aggregate.
 * `nullWhenEmpty`: у Prisma `aggregate` по пустой выборке даёт `_sum: { x: null }`,
 * и вызывающий код обязан это пережить (`already._sum.amount || 0`).
 */
function aggregateOf(items, args, { nullWhenEmpty = false } = {}) {
  const out = {}
  if (args._sum) {
    out._sum = {}
    for (const f of Object.keys(args._sum)) {
      out._sum[f] = items.length === 0 && nullWhenEmpty
        ? null
        : items.reduce((s, r) => s + (Number(r[f]) || 0), 0)
    }
  }
  if (args._count) {
    out._count = {}
    for (const f of Object.keys(args._count)) {
      out._count[f] = f === '_all' ? items.length : items.filter((r) => r[f] !== null && r[f] !== undefined).length
    }
  }
  return out
}

function makeModel(name, rows, calls) {
  let seq = rows.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0)
  const select = (args = {}) => applyOrder(rows.filter((r) => matchWhere(r, args.where)), args.orderBy)

  return {
    async findMany(args = {}) {
      calls.push({ model: name, op: 'findMany', args })
      return select(args).map((r) => project(r, args))
    },
    async findFirst(args = {}) {
      calls.push({ model: name, op: 'findFirst', args })
      const hit = select(args)[0]
      return hit ? project(hit, args) : null
    },
    async findUnique(args = {}) {
      calls.push({ model: name, op: 'findUnique', args })
      const hit = rows.find((r) => matchWhere(r, args.where))
      return hit ? project(hit, args) : null
    },
    async count(args = {}) {
      calls.push({ model: name, op: 'count', args })
      return select(args).length
    },
    async create(args) {
      calls.push({ model: name, op: 'create', args })
      const rec = { id: ++seq, ...args.data }
      rows.push(rec)
      return project(rec, args)
    },
    async createMany(args) {
      calls.push({ model: name, op: 'createMany', args })
      const list = Array.isArray(args.data) ? args.data : [args.data]
      let count = 0
      for (const data of list) {
        // skipDuplicates у Prisma пропускает строки, нарушающие УНИКАЛЬНЫЕ поля.
        // В справочниках номерного фонда уникальны id, code и name — их и проверяем.
        const dup = rows.some((r) =>
          (data.id !== undefined && r.id === data.id) ||
          (data.code !== undefined && r.code === data.code) ||
          (data.name !== undefined && r.name === data.name))
        if (dup) {
          if (args.skipDuplicates) continue
          const e = new Error('Unique constraint failed'); e.code = 'P2002'; throw e
        }
        rows.push({ id: ++seq, ...data })
        count++
      }
      return { count }
    },
    async updateMany(args) {
      calls.push({ model: name, op: 'updateMany', args })
      const hits = rows.filter((r) => matchWhere(r, args.where))
      for (const r of hits) applyData(r, args.data)
      return { count: hits.length }
    },
    // Каскадное удаление по условию. Нужно всему, что пересобирает начисления:
    // `deleteMany({ where: { bookingId, source: 'auto' } })` — и если модуль
    // потеряет фильтр по source, ручные строки исчезнут прямо здесь, в тесте.
    async deleteMany(args = {}) {
      calls.push({ model: name, op: 'deleteMany', args })
      const doomed = new Set(rows.filter((r) => matchWhere(r, args.where)))
      const keep = rows.filter((r) => !doomed.has(r))
      rows.length = 0
      rows.push(...keep)
      return { count: doomed.size }
    },
    /**
     * groupBy(by, where, _sum, _count) — так `utils/bookingMoney.js` считает
     * «начислено» сразу по сотне броней. Считаем честно по фикстуре, а не
     * возвращаем заготовку: иначе тест не заметил бы потерянный фильтр.
     */
    async groupBy(args = {}) {
      calls.push({ model: name, op: 'groupBy', args })
      const by = Array.isArray(args.by) ? args.by : [args.by]
      const groups = new Map()
      for (const r of select(args)) {
        const key = by.map((f) => {
          if (!(f in r)) throw new Error(`fakePrisma: groupBy по полю «${f}», которого нет в фикстуре`)
          return String(r[f] instanceof Date ? r[f].getTime() : r[f])
        }).join(' ')
        if (!groups.has(key)) {
          const head = {}
          for (const f of by) head[f] = r[f]
          groups.set(key, { head, items: [] })
        }
        groups.get(key).items.push(r)
      }
      return [...groups.values()].map(({ head, items }) => ({ ...head, ...aggregateOf(items, args) }))
    },
    /** aggregate(_sum/_count) — лимит возврата по платежу считается именно им. */
    async aggregate(args = {}) {
      calls.push({ model: name, op: 'aggregate', args })
      return aggregateOf(select(args), args, { nullWhenEmpty: true })
    },
    async delete(args) {
      calls.push({ model: name, op: 'delete', args })
      const i = rows.findIndex((r) => matchWhere(r, args.where))
      if (i === -1) { const e = new Error('Record to delete does not exist'); e.code = 'P2025'; throw e }
      const [rec] = rows.splice(i, 1)
      return project(rec, args)
    },
    async update(args) {
      calls.push({ model: name, op: 'update', args })
      const rec = rows.find((r) => matchWhere(r, args.where))
      // Prisma на update несуществующей записи бросает P2025 — тест должен видеть то же
      if (!rec) { const e = new Error('Record to update not found'); e.code = 'P2025'; throw e }
      applyData(rec, args.data)
      return project(rec, args)
    },
    get rows() { return rows },
  }
}

/**
 * @param {Record<string, object[]>} data фикстуры по моделям, напр. { booking: [...] }
 * @returns {{ prisma: object, calls: object[] }}
 */
export function createFakePrisma(data = {}) {
  const calls = []
  const prisma = {}
  for (const [model, rows] of Object.entries(data)) {
    prisma[model] = makeModel(model, rows.map((r) => ({ ...r })), calls)
  }
  // Транзакции здесь без отката: проверяем ПОРЯДОК (проверка доступности стоит
  // до записи и получает тот же клиент), а не поведение Postgres при сбое.
  prisma.$transaction = async (arg) => {
    calls.push({ model: '$transaction', op: typeof arg === 'function' ? 'callback' : 'batch' })
    return typeof arg === 'function' ? arg(prisma) : Promise.all(arg)
  }
  return { prisma, calls }
}

/** '2026-07-10' → Date UTC-полночь. Так же, как даты `@db.Date` лежат в базе. */
export function d(iso) {
  const [y, m, day] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, day))
}
