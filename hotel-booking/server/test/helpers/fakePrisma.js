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
  return { prisma, calls }
}

/** '2026-07-10' → Date UTC-полночь. Так же, как даты `@db.Date` лежат в базе. */
export function d(iso) {
  const [y, m, day] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, day))
}
