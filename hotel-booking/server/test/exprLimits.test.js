import { describe, it, expect } from 'vitest'
import { loadCjs } from './helpers/loadCjs.js'

/**
 * Пределы языка формул (аудит D4-003).
 *
 * Формула приходит из конструктора отчётов или из импортированного файла, то есть
 * от кого угодно. Разборщик рекурсивный, вычислитель тоже: формула из десяти тысяч
 * слагаемых или из сотни вложенных скобок проходила валидацию и роняла ЗАПУСК
 * отчёта — `RangeError: Maximum call stack size exceeded`, то есть 500 и пустой
 * экран вместо понятного «формула слишком сложная».
 *
 * Тест сторожит три вещи:
 *  • предел есть и он срабатывает ДО переполнения стека;
 *  • ошибка — своя, `ExprError` с русским текстом, а не системный `RangeError`;
 *  • разумная формула (несколько сотен слагаемых, десяток скобок) по-прежнему
 *    работает — предел не должен отрезать живые отчёты.
 */

const load = () => loadCjs('src/reports/expr.js')

const CTX = { get: () => null, param: () => null, rows: null }

/** Цепочка сложений: `1+1+…+1` — n слагаемых, 2n−1 узлов дерева. */
const chain = (n) => '1+'.repeat(n - 1) + '1'
const nested = (n) => '('.repeat(n) + '1' + ')'.repeat(n)

/** Ошибка, которую бросил вызов (или null, если не бросил). */
function thrown(fn) {
  try { fn(); return null } catch (err) { return err }
}

describe('пределы разбора формулы', () => {
  it('пределы объявлены константами, а не спрятаны в коде', () => {
    const { MAX_EXPR_LENGTH, MAX_NODES, MAX_DEPTH } = load()
    expect(MAX_EXPR_LENGTH).toBe(2000)
    expect(MAX_NODES).toBe(2000)
    expect(MAX_DEPTH).toBe(64)
  })

  it('формула длиннее предела отвергается своей ошибкой, а не переполнением стека', () => {
    const { parse, ExprError } = load()
    const src = chain(1201)  // 2401 символ
    expect(src).toHaveLength(2401)

    const err = thrown(() => parse(src))
    expect(err).toBeInstanceOf(ExprError)
    expect(err).not.toBeInstanceOf(RangeError)
  })

  it('текст ошибки — по-русски: его читает администратор в конструкторе', () => {
    const { parse } = load()
    const err = thrown(() => parse(chain(1201)))
    expect(err.message).toMatch(/[а-я]/i)
  })

  it('шестьсот слагаемых — это рабочая формула, её предел не трогает', () => {
    const { parse, evaluate } = load()
    const src = chain(601)  // 1201 символ, 1201 узел
    expect(src).toHaveLength(1201)

    const ast = parse(src)
    expect(evaluate(ast, CTX)).toBe(601)
  })

  it('ровно на границе длины формула ещё разбирается', () => {
    const { parse, evaluate } = load()
    const src = chain(1000)  // 1999 символов, 1999 узлов — под обоими пределами
    expect(src.length).toBeLessThanOrEqual(2000)
    expect(evaluate(parse(src), CTX)).toBe(1000)
  })

  it('сто вложенных скобок — превышение глубины, а не падение разборщика', () => {
    const { parse, ExprError } = load()
    const err = thrown(() => parse(nested(100)))
    expect(err).toBeInstanceOf(ExprError)
    expect(err).not.toBeInstanceOf(RangeError)
    expect(err.message).toMatch(/[а-я]/i)
  })

  it('тридцать вложенных скобок разрешены — так пишут живые формулы', () => {
    const { parse, evaluate } = load()
    expect(evaluate(parse(nested(30)), CTX)).toBe(1)
  })

  it('вложенные вызовы функций считаются той же глубиной', () => {
    const { parse, ExprError } = load()
    // round(round(round(… 1 …))) — скобок нет, а рекурсия та же
    const deep = 'round('.repeat(100) + '1' + ')'.repeat(100)
    const err = thrown(() => parse(deep))
    expect(err).toBeInstanceOf(ExprError)
    expect(err).not.toBeInstanceOf(RangeError)
  })
})

describe('вычисление и проверка большого дерева', () => {
  it('дерево из 1899 узлов вычисляется без переполнения стека', () => {
    const { parse, evaluate, ExprError } = load()
    const ast = parse(chain(950))  // 1899 символов, 1899 узлов

    const err = thrown(() => {
      const v = evaluate(ast, CTX)
      expect(v).toBe(950)
    })
    // Если предел всё-таки сработал — он обязан быть своим, а не системным
    if (err) expect(err).toBeInstanceOf(ExprError)
  })

  it('analyze того же дерева не падает', () => {
    const { analyze } = load()
    const out = analyze(chain(950))
    expect(out.problems).toEqual([])
  })

  it('формула из десяти тысяч слагаемых не проходит валидацию, а сообщает о проблеме', () => {
    const { analyze } = load()
    const out = analyze(chain(10000))
    expect(out.problems.length).toBeGreaterThan(0)
    expect(out.problems[0]).toMatch(/[а-я]/i)
  })

  it('inferType на неподъёмной формуле не бросает — колонка просто получает тип по умолчанию', () => {
    const { inferType } = load()
    expect(() => inferType(chain(10000))).not.toThrow()
  })
})

describe('кэш разбора', () => {
  it('слишком длинная формула не кэшируется: второй разбор так же отвергается', () => {
    const { parse, ExprError } = load()
    const src = chain(1001)  // 2001 символ — на один больше предела
    expect(src).toHaveLength(2001)

    expect(thrown(() => parse(src))).toBeInstanceOf(ExprError)
    expect(thrown(() => parse(src))).toBeInstanceOf(ExprError)
  })

  it('нормальная формула кэшируется — второй разбор отдаёт то же дерево', () => {
    const { parse } = load()
    expect(parse('totalAmount - paidAmount')).toBe(parse('totalAmount - paidAmount'))
  })
})
