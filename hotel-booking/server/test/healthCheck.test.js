import { describe, it, expect, afterEach, vi } from 'vitest'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'

/**
 * Волна «Упаковка» — `server/src/utils/healthCheck.js`.
 *
 * Зачем это вообще: встроенный Postgres может УПАСТЬ во время работы
 * (D8-002). Сейчас программа этого не замечает — запросы висят, окно не
 * закрывается, человек видит зависший интерфейс без объяснений. Проверка
 * состояния базы должна отвечать всегда и быстро, и «не отвечает» для неё —
 * такой же нормальный ответ, как «в порядке».
 *
 * Отсюда две границы с ценой ошибки:
 *  1. **Проверка не имеет права зависнуть вместе с базой.** Упавший Postgres
 *     чаще не отказывает, а молчит: TCP-соединение принято, ответа нет.
 *     Без своего таймаута индикатор здоровья зависнет ровно там же, где и всё
 *     остальное, и станет бесполезен.
 *  2. **Таймер обязан сниматься при успехе.** Проверка вызывается по
 *     расписанию; забытый таймер на каждый вызов — это удержанный event loop
 *     и незакрывающееся окно при выходе (ровно вторая половина D8-002).
 *
 * Живая база не нужна: `prisma` подставляется вручную — здесь важен не SQL,
 * а поведение вокруг ожидания.
 */

const loadHealth = () => loadCjs('src/utils/healthCheck.js', {
  stubs: { '../utils/logger': silentLogger, './logger': silentLogger },
})

/** База отвечает мгновенно. */
const alivePrisma = () => {
  const calls = []
  return { calls, $queryRaw: (...args) => { calls.push(args); return Promise.resolve([{ '?column?': 1 }]) } }
}

/** База принимает запрос и молчит — так выглядит упавший Postgres. */
const silentPrisma = () => ({ $queryRaw: () => new Promise(() => {}) })

/** База отказывает сразу — соединение потеряно. */
const brokenPrisma = (code = 'P1001') => ({
  $queryRaw: () => Promise.reject(Object.assign(new Error('Can\'t reach database server'), { code })),
})

afterEach(() => {
  vi.useRealTimers()
})

describe('healthCheck — состояние базы', () => {
  it('отвечающая база — «ok», и проверка действительно ходит запросом', async () => {
    const { checkDb } = loadHealth()
    const prisma = alivePrisma()

    await expect(checkDb(prisma)).resolves.toBe('ok')
    expect(prisma.calls.length).toBe(1)
  })

  it('отказ соединения — «down», а не выброшенное исключение', async () => {
    const { checkDb } = loadHealth()

    await expect(checkDb(brokenPrisma(), { timeoutMs: 50 })).resolves.toBe('down')
  })

  it('молчащая база — «down» по своему таймауту, проверка не виснет вместе с ней', async () => {
    const { checkDb } = loadHealth()
    const started = Date.now()

    await expect(checkDb(silentPrisma(), { timeoutMs: 20 })).resolves.toBe('down')

    // Уложились в свой таймаут, а не в умолчание в 2 секунды.
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('удачная проверка не оставляет висящий таймер', async () => {
    vi.useFakeTimers()
    const { checkDb } = loadHealth()

    await expect(checkDb(alivePrisma(), { timeoutMs: 3000 })).resolves.toBe('ok')

    expect(vi.getTimerCount()).toBe(0)
  })

  it('неудачная проверка тоже не оставляет висящий таймер', async () => {
    vi.useFakeTimers()
    const { checkDb } = loadHealth()

    await expect(checkDb(brokenPrisma(), { timeoutMs: 3000 })).resolves.toBe('down')

    expect(vi.getTimerCount()).toBe(0)
  })

  it('умолчание — две секунды: раньше срока ответа нет, после срока «down»', async () => {
    vi.useFakeTimers()
    const { checkDb } = loadHealth()

    let settled = null
    const p = checkDb(silentPrisma()).then((v) => { settled = v })

    await vi.advanceTimersByTimeAsync(1900)
    expect(settled).toBeNull()

    await vi.advanceTimersByTimeAsync(200)
    await p
    expect(settled).toBe('down')
  })
})
