const { daysBetween, toUTCDate } = require('./dateUtils')

/**
 * Язык формул для отчётов. Свой разборщик и вычислитель, никакого eval:
 * формула приходит из конструктора или из импортированного файла, то есть
 * от кого угодно, и не должна уметь ничего, кроме арифметики над строкой.
 *
 *   sum(isSold) / sum(isAvailable) * 100      — загрузка (в сгруппированном отчёте)
 *   totalAmount - paidAmount                   — остаток (по строке)
 *   countIf(status = 'CANCELLED') / count()    — доля отмен
 *   if(nights >= 7, 'долгий', 'короткий')      — текст по условию
 *   totalAmount * (1 - @discount / 100)        — @имя — параметр отчёта
 *
 * Имена — это поля источника данных, ключи уже посчитанных колонок и параметры.
 * Агрегаты (sum, count, avg…) считают по строкам группы; внутри агрегата имена
 * ссылаются на поля строки. Null в арифметике даёт null, деление на ноль — null.
 */

class ExprError extends Error {
  constructor(message, pos) {
    super(pos !== undefined ? `${message} (позиция ${pos + 1})` : message)
    this.pos = pos
  }
}

// --- Токены -------------------------------------------------------------------

const KEYWORDS = new Set(['and', 'or', 'not'])
const TWO_CHAR = { '<=': '<=', '>=': '>=', '!=': '!=', '<>': '!=', '==': '=', '&&': 'and', '||': 'or' }

function tokenize(src) {
  const s = String(src)
  const tokens = []
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (/\s/.test(ch)) { i++; continue }

    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(s[i + 1] || ''))) {
      let j = i
      while (j < s.length && /[0-9.]/.test(s[j])) j++
      const v = Number(s.slice(i, j))
      if (Number.isNaN(v)) throw new ExprError(`не число «${s.slice(i, j)}»`, i)
      tokens.push({ t: 'num', v, pos: i })
      i = j
      continue
    }

    if (ch === "'" || ch === '"') {
      let j = i + 1
      let out = ''
      while (j < s.length && s[j] !== ch) {
        if (s[j] === '\\' && j + 1 < s.length) { out += s[j + 1]; j += 2 } else { out += s[j]; j++ }
      }
      if (j >= s.length) throw new ExprError('незакрытая строка', i)
      tokens.push({ t: 'str', v: out, pos: i })
      i = j + 1
      continue
    }

    if (ch === '@') {
      let j = i + 1
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++
      if (j === i + 1) throw new ExprError('после @ ожидается имя параметра', i)
      tokens.push({ t: 'param', v: s.slice(i + 1, j), pos: i })
      i = j
      continue
    }

    if (/[A-Za-z_$]/.test(ch)) {
      let j = i
      while (j < s.length && /[A-Za-z0-9_$.]/.test(s[j])) j++
      const word = s.slice(i, j)
      const lower = word.toLowerCase()
      if (KEYWORDS.has(lower)) tokens.push({ t: 'op', v: lower, pos: i })
      else tokens.push({ t: 'id', v: word, pos: i })
      i = j
      continue
    }

    const two = s.slice(i, i + 2)
    if (TWO_CHAR[two]) { tokens.push({ t: 'op', v: TWO_CHAR[two], pos: i }); i += 2; continue }
    if ('+-*/%()<>=,'.includes(ch)) { tokens.push({ t: 'op', v: ch, pos: i }); i++; continue }
    if (ch === '!') { tokens.push({ t: 'op', v: 'not', pos: i }); i++; continue }
    throw new ExprError(`неожиданный символ «${ch}»`, i)
  }
  tokens.push({ t: 'eof', pos: s.length })
  return tokens
}

// --- Разбор -------------------------------------------------------------------

class Parser {
  constructor(tokens) { this.toks = tokens; this.i = 0 }
  peek() { return this.toks[this.i] }
  next() { return this.toks[this.i++] }
  isOp(v) { const t = this.peek(); return t.t === 'op' && t.v === v }
  expect(v) {
    if (!this.isOp(v)) throw new ExprError(`ожидается «${v}»`, this.peek().pos)
    this.next()
  }

  parse() {
    if (this.peek().t === 'eof') throw new ExprError('пустая формула')
    const e = this.or()
    if (this.peek().t !== 'eof') throw new ExprError('лишний текст после выражения', this.peek().pos)
    return e
  }

  or() {
    let l = this.and()
    while (this.isOp('or')) { this.next(); l = { t: 'bin', op: 'or', l, r: this.and() } }
    return l
  }

  and() {
    let l = this.not()
    while (this.isOp('and')) { this.next(); l = { t: 'bin', op: 'and', l, r: this.not() } }
    return l
  }

  not() {
    if (this.isOp('not')) { this.next(); return { t: 'un', op: 'not', e: this.not() } }
    return this.cmp()
  }

  cmp() {
    let l = this.add()
    while (['=', '!=', '<', '<=', '>', '>='].some((o) => this.isOp(o))) {
      const op = this.next().v
      l = { t: 'bin', op, l, r: this.add() }
    }
    return l
  }

  add() {
    let l = this.mul()
    while (this.isOp('+') || this.isOp('-')) { const op = this.next().v; l = { t: 'bin', op, l, r: this.mul() } }
    return l
  }

  mul() {
    let l = this.unary()
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) { const op = this.next().v; l = { t: 'bin', op, l, r: this.unary() } }
    return l
  }

  unary() {
    if (this.isOp('-')) { this.next(); return { t: 'un', op: 'neg', e: this.unary() } }
    if (this.isOp('+')) { this.next(); return this.unary() }
    return this.primary()
  }

  primary() {
    const t = this.next()
    if (t.t === 'num') return { t: 'num', v: t.v }
    if (t.t === 'str') return { t: 'str', v: t.v }
    if (t.t === 'param') return { t: 'param', name: t.v, pos: t.pos }
    if (t.t === 'id') {
      const lower = t.v.toLowerCase()
      if (lower === 'true') return { t: 'num', v: true }
      if (lower === 'false') return { t: 'num', v: false }
      if (lower === 'null') return { t: 'num', v: null }
      if (this.isOp('(')) {
        this.next()
        const args = []
        if (!this.isOp(')')) {
          args.push(this.or())
          while (this.isOp(',')) { this.next(); args.push(this.or()) }
        }
        this.expect(')')
        return { t: 'call', name: t.v, args, pos: t.pos }
      }
      return { t: 'id', name: t.v, pos: t.pos }
    }
    if (t.t === 'op' && t.v === '(') {
      const e = this.or()
      this.expect(')')
      return e
    }
    throw new ExprError(t.t === 'eof' ? 'выражение оборвано' : `неожиданный «${t.v}»`, t.pos)
  }
}

const cache = new Map()

function parse(src) {
  const key = String(src)
  let ast = cache.get(key)
  if (!ast) {
    ast = new Parser(tokenize(key)).parse()
    if (cache.size > 500) cache.clear()
    cache.set(key, ast)
  }
  return ast
}

// --- Функции ------------------------------------------------------------------

const isNil = (v) => v === null || v === undefined || v === ''
const num = (v) => {
  if (isNil(v)) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  const n = Number(v)
  return Number.isNaN(n) ? null : n
}
const nums = (list) => list.map(num).filter((n) => n !== null)
const truthy = (v) => !(v === null || v === undefined || v === false || v === 0 || v === '')
const same = (a, b) => a === b || (!isNil(a) && !isNil(b) && String(a) === String(b))
const isoPart = (d, i) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || '')); return m ? Number(m[i]) : null }

/** Скалярные функции: аргументы уже вычислены. */
const SCALARS = {
  round: (x, n = 0) => { const v = num(x); if (v === null) return null; const k = 10 ** (num(n) || 0); return Math.round(v * k) / k },
  abs: (x) => { const v = num(x); return v === null ? null : Math.abs(v) },
  floor: (x) => { const v = num(x); return v === null ? null : Math.floor(v) },
  ceil: (x) => { const v = num(x); return v === null ? null : Math.ceil(v) },
  min: (...a) => { const l = nums(a); return l.length ? Math.min(...l) : null },
  max: (...a) => { const l = nums(a); return l.length ? Math.max(...l) : null },
  if: (c, a, b) => (truthy(c) ? a : (b === undefined ? null : b)),
  coalesce: (...a) => { const v = a.find((x) => !isNil(x)); return v === undefined ? null : v },
  len: (s) => (isNil(s) ? 0 : Array.isArray(s) ? s.length : String(s).length),
  lower: (s) => (isNil(s) ? '' : String(s).toLowerCase()),
  upper: (s) => (isNil(s) ? '' : String(s).toUpperCase()),
  concat: (...a) => a.map((v) => (isNil(v) ? '' : String(v))).join(''),
  num: (v) => num(v),
  str: (v) => (isNil(v) ? '' : String(v)),
  contains: (s, sub) => String(isNil(s) ? '' : s).toLowerCase().includes(String(isNil(sub) ? '' : sub).toLowerCase()),
  has: (list, v) => Array.isArray(list) && list.some((x) => same(x, v)),
  days: (a, b) => (toUTCDate(a) && toUTCDate(b) ? daysBetween(a, b) : null),
  year: (d) => isoPart(d, 1),
  month: (d) => isoPart(d, 2),
  day: (d) => isoPart(d, 3),
  weekday: (d) => { const x = toUTCDate(d); return x ? x.getUTCDay() : null },
}

/**
 * Агрегаты: получают значения выражения по каждой строке группы.
 * `count()` без аргумента — число строк; с аргументом — сколько непустых.
 */
const AGGREGATES = {
  sum: (vals) => nums(vals).reduce((s, v) => s + v, 0),
  avg: (vals) => { const l = nums(vals); return l.length ? l.reduce((s, v) => s + v, 0) / l.length : null },
  count: (vals, hasArg, rows) => (hasArg ? vals.filter((v) => !isNil(v)).length : rows.length),
  countDistinct: (vals) => new Set(vals.filter((v) => !isNil(v)).map((v) => String(v))).size,
  countIf: (conds) => conds.filter(truthy).length,
  sumIf: (vals, _h, _rows, conds) => nums(vals.filter((_, i) => truthy(conds[i]))).reduce((s, v) => s + v, 0),
  minOf: (vals) => { const l = nums(vals); return l.length ? Math.min(...l) : null },
  maxOf: (vals) => { const l = nums(vals); return l.length ? Math.max(...l) : null },
  first: (vals) => { const v = vals.find((x) => !isNil(x)); return v === undefined ? null : v },
}

/** Число аргументов: [min, max]. Проверяется при валидации, чтобы ошибка была до запуска. */
const ARITY = {
  round: [1, 2], abs: [1, 1], floor: [1, 1], ceil: [1, 1], min: [1, Infinity], max: [1, Infinity],
  if: [2, 3], coalesce: [1, Infinity], len: [1, 1], lower: [1, 1], upper: [1, 1], concat: [1, Infinity],
  num: [1, 1], str: [1, 1], contains: [2, 2], has: [2, 2], days: [2, 2], year: [1, 1], month: [1, 1], day: [1, 1], weekday: [1, 1],
  sum: [1, 1], avg: [1, 1], count: [0, 1], countDistinct: [1, 1], countIf: [1, 1], sumIf: [2, 2],
  minOf: [1, 1], maxOf: [1, 1], first: [1, 1],
}

// --- Вычисление ---------------------------------------------------------------

function arith(op, a, b) {
  if (op === '+' && (typeof a === 'string' || typeof b === 'string') && (num(a) === null || num(b) === null)) {
    return SCALARS.concat(a, b)
  }
  const x = num(a)
  const y = num(b)
  if (x === null || y === null) return null
  switch (op) {
    case '+': return x + y
    case '-': return x - y
    case '*': return x * y
    case '/': return y === 0 ? null : x / y
    case '%': return y === 0 ? null : x % y
    default: return null
  }
}

function compare(op, a, b) {
  if (op === '=') return same(a, b)
  if (op === '!=') return !same(a, b)
  if (isNil(a) || isNil(b)) return false
  const x = num(a)
  const y = num(b)
  const c = x !== null && y !== null ? x - y : String(a).localeCompare(String(b), 'ru')
  switch (op) {
    case '<': return c < 0
    case '<=': return c <= 0
    case '>': return c > 0
    case '>=': return c >= 0
    default: return false
  }
}

/**
 * @param ast  разобранная формула
 * @param ctx  { get(name), param(name), rows: строки группы | null }
 *             rows === null означает «строчный контекст»: агрегаты запрещены.
 */
function evaluate(ast, ctx) {
  switch (ast.t) {
    case 'num':
    case 'str':
      return ast.v
    case 'id': {
      const v = ctx.get(ast.name)
      return v === undefined ? null : v
    }
    case 'param': {
      const v = ctx.param ? ctx.param(ast.name) : undefined
      return v === undefined ? null : v
    }
    case 'un': {
      const v = evaluate(ast.e, ctx)
      if (ast.op === 'not') return !truthy(v)
      const n = num(v)
      return n === null ? null : -n
    }
    case 'bin': {
      if (ast.op === 'and') return truthy(evaluate(ast.l, ctx)) ? truthy(evaluate(ast.r, ctx)) : false
      if (ast.op === 'or') return truthy(evaluate(ast.l, ctx)) ? true : truthy(evaluate(ast.r, ctx))
      const a = evaluate(ast.l, ctx)
      const b = evaluate(ast.r, ctx)
      if ('+-*/%'.includes(ast.op)) return arith(ast.op, a, b)
      return compare(ast.op, a, b)
    }
    case 'call': {
      const agg = AGGREGATES[ast.name]
      if (agg) {
        if (!ctx.rows) throw new ExprError(`«${ast.name}» — агрегат, здесь нельзя`, ast.pos)
        const rowCtx = (row) => ({ get: (n) => (row[n] === undefined ? ctx.get(n) : row[n]), param: ctx.param, rows: null })
        const arg = ast.args[0]
        const vals = arg ? ctx.rows.map((row) => evaluate(arg, rowCtx(row))) : []
        const conds = ast.args[1] ? ctx.rows.map((row) => evaluate(ast.args[1], rowCtx(row))) : []
        return agg(vals, ast.args.length > 0, ctx.rows, conds)
      }
      const fn = SCALARS[ast.name]
      if (!fn) throw new ExprError(`неизвестная функция «${ast.name}»`, ast.pos)
      return fn(...ast.args.map((a) => evaluate(a, ctx)))
    }
    default:
      return null
  }
}

// --- Проверка без вычисления --------------------------------------------------

/**
 * Что формула использует и где ошибается. Нужна валидации определения:
 * незнакомое имя должно ловиться при сохранении и в конструкторе, а не
 * возвращать молча null в готовом отчёте.
 *
 * @returns { idents: Set (вне агрегатов), aggIdents: Set (внутри), params: Set,
 *            usesAgg: boolean, problems: string[] }
 */
function analyze(src) {
  const out = { idents: new Set(), aggIdents: new Set(), params: new Set(), usesAgg: false, problems: [] }
  let ast
  try {
    ast = parse(src)
  } catch (err) {
    out.problems.push(err.message)
    return out
  }
  const walk = (node, inAgg) => {
    switch (node.t) {
      case 'id': (inAgg ? out.aggIdents : out.idents).add(node.name); break
      case 'param': out.params.add(node.name); break
      case 'un': walk(node.e, inAgg); break
      case 'bin': walk(node.l, inAgg); walk(node.r, inAgg); break
      case 'call': {
        const isAgg = !!AGGREGATES[node.name]
        if (!isAgg && !SCALARS[node.name]) out.problems.push(`неизвестная функция «${node.name}»`)
        if (isAgg && inAgg) out.problems.push(`агрегат внутри агрегата: «${node.name}»`)
        if (isAgg) out.usesAgg = true
        const ar = ARITY[node.name]
        if (ar && (node.args.length < ar[0] || node.args.length > ar[1])) {
          out.problems.push(`«${node.name}»: ожидается ${ar[0] === ar[1] ? ar[0] : `от ${ar[0]} до ${ar[1] === Infinity ? '∞' : ar[1]}`} аргум.`)
        }
        node.args.forEach((a) => walk(a, inAgg || isAgg))
        break
      }
      default: break
    }
  }
  walk(ast, false)
  return out
}

const TEXT_FUNCS = new Set(['concat', 'str', 'lower', 'upper'])
const BOOL_FUNCS = new Set(['contains', 'has'])

/**
 * Какого рода значение даёт формула — чтобы колонка «if(nights >= 7, 'долгий',
 * 'короткий')» не считалась числом и не получала «Итого: 0».
 * Эвристика по корню дерева: строгая типизация тут не нужна, нужно угадать
 * очевидное; пользователь всегда может задать тип колонки явно.
 */
function inferType(src) {
  let ast
  try { ast = parse(src) } catch { return 'number' }
  const kind = (node) => {
    switch (node.t) {
      case 'str': return 'text'
      case 'num': return typeof node.v === 'boolean' ? 'bool' : 'number'
      case 'bin':
        if (['=', '!=', '<', '<=', '>', '>=', 'and', 'or'].includes(node.op)) return 'bool'
        if (node.op === '+') { const l = kind(node.l); const r = kind(node.r); return l === 'text' || r === 'text' ? 'text' : 'number' }
        return 'number'
      case 'un': return node.op === 'not' ? 'bool' : 'number'
      case 'call':
        if (TEXT_FUNCS.has(node.name)) return 'text'
        if (BOOL_FUNCS.has(node.name)) return 'bool'
        if (node.name === 'if') {
          const a = node.args[1] ? kind(node.args[1]) : 'number'
          const b = node.args[2] ? kind(node.args[2]) : a
          return a === b ? a : (a === 'text' || b === 'text' ? 'text' : 'number')
        }
        if (node.name === 'coalesce') return node.args.length ? kind(node.args[0]) : 'number'
        if (node.name === 'first') return 'number'
        return 'number'
      default: return 'number'
    }
  }
  return kind(ast)
}

/** Справочник функций для конструктора (подписи и сигнатуры). */
const FUNCTIONS = [
  { name: 'sum', sig: 'sum(x)', label: 'Сумма по группе', agg: true },
  { name: 'count', sig: 'count()', label: 'Число строк в группе', agg: true },
  { name: 'countDistinct', sig: 'countDistinct(x)', label: 'Уникальных значений', agg: true },
  { name: 'countIf', sig: 'countIf(условие)', label: 'Строк, где условие верно', agg: true },
  { name: 'sumIf', sig: 'sumIf(x, условие)', label: 'Сумма x, где условие верно', agg: true },
  { name: 'avg', sig: 'avg(x)', label: 'Среднее по группе', agg: true },
  { name: 'minOf', sig: 'minOf(x)', label: 'Минимум по группе', agg: true },
  { name: 'maxOf', sig: 'maxOf(x)', label: 'Максимум по группе', agg: true },
  { name: 'first', sig: 'first(x)', label: 'Первое непустое в группе', agg: true },
  { name: 'round', sig: 'round(x, знаков)', label: 'Округлить' },
  { name: 'if', sig: 'if(условие, да, нет)', label: 'Если' },
  { name: 'coalesce', sig: 'coalesce(a, b, …)', label: 'Первое непустое' },
  { name: 'min', sig: 'min(a, b, …)', label: 'Меньшее из' },
  { name: 'max', sig: 'max(a, b, …)', label: 'Большее из' },
  { name: 'abs', sig: 'abs(x)', label: 'Модуль' },
  { name: 'floor', sig: 'floor(x)', label: 'Вниз до целого' },
  { name: 'ceil', sig: 'ceil(x)', label: 'Вверх до целого' },
  { name: 'concat', sig: 'concat(a, b, …)', label: 'Склеить текст' },
  { name: 'contains', sig: 'contains(текст, часть)', label: 'Содержит текст' },
  { name: 'has', sig: 'has(список, x)', label: 'Список содержит' },
  { name: 'len', sig: 'len(x)', label: 'Длина' },
  { name: 'lower', sig: 'lower(x)', label: 'Строчными' },
  { name: 'upper', sig: 'upper(x)', label: 'Прописными' },
  { name: 'days', sig: 'days(от, до)', label: 'Дней между датами' },
  { name: 'year', sig: 'year(дата)', label: 'Год' },
  { name: 'month', sig: 'month(дата)', label: 'Месяц (1–12)' },
  { name: 'day', sig: 'day(дата)', label: 'День месяца' },
  { name: 'weekday', sig: 'weekday(дата)', label: 'День недели (0=вс)' },
  { name: 'num', sig: 'num(x)', label: 'В число' },
  { name: 'str', sig: 'str(x)', label: 'В текст' },
]

module.exports = { parse, evaluate, analyze, inferType, ExprError, FUNCTIONS, SCALARS, AGGREGATES, truthy }
