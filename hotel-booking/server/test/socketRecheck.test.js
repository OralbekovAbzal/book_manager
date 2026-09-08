import { describe, it, expect, vi, afterEach } from 'vitest'
import jwt from 'jsonwebtoken'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'
import { createFakePrisma } from './helpers/fakePrisma.js'

/**
 * Пятиминутная перепроверка подключённых сокетов — вторая линия обороны (D1-005).
 *
 * Первая линия — персональный таймер на момент истечения токена — проверена в
 * `socketExpiry.test.js`. Но таймер не срабатывает в трёх случаях, и все три
 * встречаются у стойки чаще, чем кажется:
 *
 *  1. **Ноутбук уснул.** `setTimeout` в спящем процессе не «догоняет» реальное
 *     время: проснулись через три часа — таймер, поставленный на два, выстрелит
 *     ещё через час. Всё это время сокет получает сетку по истёкшему токену,
 *     тогда как REST этому же человеку уже отвечает 401.
 *  2. **Срок больше 24 дней.** `setTimeout` не умеет задержки больше 2^31−1 мс
 *     и выстрелил бы НЕМЕДЛЕННО — поэтому такой таймер намеренно не ставится
 *     вовсе, и единственная защита у долгого токена — эта перепроверка.
 *  3. **Часы перевели** (или сервер поднялся с неверным временем и синхронизировался).
 *
 * Обратная сторона у той же перепроверки: она НЕ должна рвать соединения по
 * поводу и без. Токен без срока (такие выпускались до `expiresIn`) — не повод,
 * сбой базы — тоже: минутная недоступность Postgres не должна выкидывать всю
 * смену на экран входа.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret'

const adminRow = (over = {}) => ({
  id: 1, username: 'admin', name: 'Администратор', password: 'x',
  role: 'SUPER_ADMIN', isActive: true, tokenVersion: 0, ...over,
})

const sign = (payload, opts) => jwt.sign(payload, process.env.JWT_SECRET, opts)

function loadSocketManager(prisma) {
  const state = { middlewares: [], handlers: {} }
  class FakeServer {
    use(fn) { state.middlewares.push(fn) }
    on(event, fn) { state.handlers[event] = fn }
    to() { return { emit() {} } }
  }
  const lib = loadCjs('src/socket/socketManager.js', {
    stubs: {
      'socket.io': { Server: FakeServer },
      '../utils/prisma': { prisma },
      '../utils/logger': silentLogger,
      '../utils/corsOrigin': { corsOrigin: '*' },
    },
    // Перепроверка модулем не экспортируется — она внутренняя, её зовёт setInterval.
    append: 'module.exports.__recheck = recheckConnectedAdmins\nmodule.exports.__RECHECK_MS = RECHECK_MS',
  })
  lib.initSocket({})
  return { ...lib, state }
}

function fakeSocket(token) {
  const s = { handshake: { auth: { token } }, emitted: [], disconnected: false, listeners: {} }
  s.emit = (ev, p) => { s.emitted.push([ev, p]) }
  s.on = (ev, fn) => { s.listeners[ev] = fn }
  s.join = () => {}
  // Как настоящий socket.io: разрыв поднимает 'disconnect' один раз
  s.disconnect = () => {
    s.disconnected = true
    const fn = s.listeners.disconnect
    s.listeners.disconnect = null
    fn?.()
  }
  return s
}

async function connect(state, socket) {
  const err = await new Promise((resolve) => state.middlewares[0](socket, resolve))
  if (err) throw err
  state.handlers.connection(socket)
  return socket
}

const reasonsOf = (s) => s.emitted.map(([ev, p]) => `${ev}:${p.reason}`)

afterEach(() => { vi.useRealTimers() })

describe('перепроверка сокетов — истёкший токен', () => {
  it('процесс спал: таймер не выстрелил, но перепроверка рвёт соединение с истёкшим токеном', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-08T08:00:00.000Z'))
    const { prisma } = createFakePrisma({ admin: [adminRow()] })
    const { state, __recheck } = loadSocketManager(prisma)
    const socket = await connect(state, fakeSocket(sign({ id: 1, tv: 0 }, { expiresIn: '1h' })))

    // Часы уехали вперёд, таймеры при этом НЕ выполнялись — ровно как после сна
    vi.setSystemTime(new Date('2026-09-08T12:00:00.000Z'))
    await __recheck()

    expect(socket.disconnected).toBe(true)
    expect(reasonsOf(socket)).toEqual(['auth:revoked:token_expired'])
  })

  it('токен длиннее 24 дней: персонального таймера нет вовсе, ловит только перепроверка', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-08T08:00:00.000Z'))
    const { prisma } = createFakePrisma({ admin: [adminRow()] })
    const { state, __recheck } = loadSocketManager(prisma)
    const timersBefore = vi.getTimerCount()   // пятиминутная перепроверка уже заведена
    const socket = await connect(state, fakeSocket(sign({ id: 1, tv: 0 }, { expiresIn: '30d' })))

    // setTimeout с задержкой больше 2^31−1 мс сработал бы сразу — такого таймера быть не должно
    expect(vi.getTimerCount()).toBe(timersBefore)

    vi.setSystemTime(new Date('2026-10-10T08:00:00.000Z'))
    await __recheck()
    expect(reasonsOf(socket)).toEqual(['auth:revoked:token_expired'])
  })

  it('до истечения перепроверка соединение не трогает', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-08T08:00:00.000Z'))
    const { prisma } = createFakePrisma({ admin: [adminRow()] })
    const { state, __recheck } = loadSocketManager(prisma)
    const socket = await connect(state, fakeSocket(sign({ id: 1, tv: 0 }, { expiresIn: '8h' })))

    vi.setSystemTime(new Date('2026-09-08T15:59:00.000Z'))
    await __recheck()
    expect(socket.disconnected).toBe(false)
    expect(socket.emitted).toEqual([])
  })

  it('токен без срока (выпущен до expiresIn) перепроверкой не рвётся даже через год', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-08T08:00:00.000Z'))
    const { prisma } = createFakePrisma({ admin: [adminRow()] })
    const { state, __recheck } = loadSocketManager(prisma)
    const timersBefore = vi.getTimerCount()
    const socket = await connect(state, fakeSocket(sign({ id: 1, tv: 0 })))

    expect(socket.tokenExp).toBeNull()
    expect(vi.getTimerCount()).toBe(timersBefore)

    vi.setSystemTime(new Date('2027-09-08T08:00:00.000Z'))
    await __recheck()
    expect(socket.disconnected).toBe(false)
  })
})

describe('перепроверка сокетов — что она делает сама по себе', () => {
  it('заводится по таймеру: выключенный в базе сотрудник теряет сокет через пять минут, без единого запроса от него', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-08T08:00:00.000Z'))
    const { prisma } = createFakePrisma({ admin: [adminRow()] })
    const { state, __RECHECK_MS } = loadSocketManager(prisma)
    const socket = await connect(state, fakeSocket(sign({ id: 1, tv: 0 }, { expiresIn: '8h' })))

    prisma.admin.rows[0].isActive = false      // «правкой в базе», мимо API
    await vi.advanceTimersByTimeAsync(__RECHECK_MS + 1000)

    expect(socket.disconnected).toBe(true)
    expect(reasonsOf(socket)).toEqual(['auth:revoked:account_disabled'])
  })

  it('учётку удалили целиком — сокет тоже рвётся, а не остаётся жить', async () => {
    const { prisma } = createFakePrisma({ admin: [adminRow()] })
    const { state, __recheck } = loadSocketManager(prisma)
    const socket = await connect(state, fakeSocket(sign({ id: 1, tv: 0 }, { expiresIn: '8h' })))

    prisma.admin.rows.length = 0
    await __recheck()
    expect(reasonsOf(socket)).toEqual(['auth:revoked:account_disabled'])
  })

  it('база недоступна — живые соединения остаются, смену на экран входа не выкидываем', async () => {
    const prisma = { admin: { findUnique: async () => adminRow(), findMany: async () => { throw new Error('connection refused') } } }
    const { state, __recheck } = loadSocketManager(prisma)
    const socket = await connect(state, fakeSocket(sign({ id: 1, tv: 0 }, { expiresIn: '8h' })))

    await expect(__recheck()).resolves.toBeUndefined()
    expect(socket.disconnected).toBe(false)
    expect(socket.emitted).toEqual([])
  })

  it('ушедший клиент в перепроверке не участвует — мёртвых сокетов в учёте не остаётся', async () => {
    const { prisma } = createFakePrisma({ admin: [adminRow()] })
    const { state, __recheck } = loadSocketManager(prisma)
    const socket = await connect(state, fakeSocket(sign({ id: 1, tv: 0 }, { expiresIn: '8h' })))

    socket.listeners.disconnect()            // клиент закрыл ноутбук
    prisma.admin.rows[0].isActive = false
    await __recheck()

    expect(socket.emitted).toEqual([])       // разрывать некого — сокета в учёте нет
  })

  it('никто не подключён — перепроверка не ходит в базу вовсе', async () => {
    const findMany = vi.fn(async () => [])
    const prisma = { admin: { findUnique: async () => adminRow(), findMany } }
    const { __recheck } = loadSocketManager(prisma)
    await __recheck()
    expect(findMany).not.toHaveBeenCalled()
  })

  it('одна учётка, два рабочих места: истёкший рвётся, свежий остаётся', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-08T08:00:00.000Z'))
    const { prisma } = createFakePrisma({ admin: [adminRow()] })
    const { state, __recheck } = loadSocketManager(prisma)
    const old = await connect(state, fakeSocket(sign({ id: 1, tv: 0 }, { expiresIn: '1h' })))

    vi.setSystemTime(new Date('2026-09-08T10:00:00.000Z'))
    const fresh = await connect(state, fakeSocket(sign({ id: 1, tv: 0 }, { expiresIn: '8h' })))
    await __recheck()

    expect(reasonsOf(old)).toEqual(['auth:revoked:token_expired'])
    expect(fresh.disconnected).toBe(false)
  })
})

/**
 * Сокет и REST должны говорить об одном и том же токене одно и то же.
 * Здесь проверяется только сторона сокета: истёкший токен не открывает
 * соединение заново — иначе разрыв по сроку ничего бы не давал, клиент
 * переподключался бы тем же токеном по кругу.
 */
describe('handshake — истёкший токен не открывает новое соединение', () => {
  it('после разрыва по сроку тот же токен в handshake получает отказ', async () => {
    const { prisma } = createFakePrisma({ admin: [adminRow()] })
    const { state } = loadSocketManager(prisma)
    const expired = sign({ id: 1, tv: 0 }, { expiresIn: '-1h' })
    const err = await new Promise((resolve) => state.middlewares[0](fakeSocket(expired), resolve))
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('Invalid token')
  })

  it('сбой базы в handshake — «сервер недоступен», а не «неверный токен»', async () => {
    const prisma = { admin: { findUnique: async () => { throw new Error('connection refused') }, findMany: async () => [] } }
    const { state } = loadSocketManager(prisma)
    const err = await new Promise((resolve) => state.middlewares[0](fakeSocket(sign({ id: 1, tv: 0 }, { expiresIn: '8h' })), resolve))
    expect(err.message).toBe('Server unavailable')
  })
})
