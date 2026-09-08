import { describe, it, expect, vi, afterEach } from 'vitest'
import jwt from 'jsonwebtoken'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'

/**
 * Сокет не должен жить дольше токена (D1-007).
 *
 * Handshake проверяет токен один раз, на подключении. Дальше сокет висит
 * сутками и получает рассылку сетки — с именами и телефонами гостей — даже
 * когда токен, по которому его пустили, давно истёк: REST такому сотруднику
 * уже отвечает 401, а realtime продолжает работать.
 *
 * Лечится таймером на момент истечения, и вся арифметика — в `msUntilExpiry`.
 * Её главная ловушка: `exp` в JWT — в СЕКУНДАХ (RFC 7519), а таймеры в
 * миллисекундах. Забытое умножение на 1000 даёт срок в тысячу раз короче:
 * сокет будет рваться через три секунды вместо восьми часов, и клиент уйдёт
 * в бесконечное переподключение. Обратная ошибка (сравнить секунды с
 * `Date.now()`) даёт срок в прошлом — разрыв сразу после подключения.
 *
 * Модуль тянет socket.io, Prisma и логгер — грузим его через loadCjs с
 * заглушками: живой базы и живого сервера здесь не нужно.
 */

const { msUntilExpiry } = loadCjs('src/socket/socketManager.js', {
  stubs: {
    'socket.io': { Server: class {} },
    '../utils/prisma': { prisma: {} },
    '../utils/logger': silentLogger,
  },
})

const SEC = 1000

afterEach(() => { vi.useRealTimers() })

describe('msUntilExpiry — сколько сокету осталось жить', () => {
  it('exp в секундах переводится в миллисекунды, а не сравнивается напрямую', () => {
    const exp = 1_800_000_000            // ≈ 15.01.2027, секунды эпохи
    const now = exp * 1000 - 5 * SEC     // пять секунд до истечения
    expect(msUntilExpiry({ exp }, now)).toBe(5 * SEC)
  })

  it('токен на час даёт около часа, а не около секунды', () => {
    const now = Date.now()
    const exp = Math.floor(now / 1000) + 3600
    const ms = msUntilExpiry({ exp }, now)
    expect(ms).toBeGreaterThan(3_599 * SEC)
    expect(ms).toBeLessThanOrEqual(3_600 * SEC)
  })

  it('момент истечения ровно сейчас — ноль, а не отрицательное и не null', () => {
    const exp = 1_800_000_000
    expect(msUntilExpiry({ exp }, exp * 1000)).toBe(0)
  })

  it('истёкший токен даёт отрицательное — разрывать надо немедленно', () => {
    const exp = 1_800_000_000
    expect(msUntilExpiry({ exp }, exp * 1000 + 90 * SEC)).toBe(-90 * SEC)
  })

  it('настоящий токен jsonwebtoken: срок совпадает с выданным', () => {
    const token = jwt.sign({ id: 1 }, 'test-secret', { expiresIn: '8h' })
    const payload = jwt.verify(token, 'test-secret')
    const ms = msUntilExpiry(payload, payload.iat * 1000)
    expect(ms).toBe(8 * 3600 * SEC)
  })

  it('без `now` берётся текущее время', () => {
    const exp = Math.floor(Date.now() / 1000) + 60
    const ms = msUntilExpiry({ exp })
    expect(ms).toBeGreaterThan(58 * SEC)
    expect(ms).toBeLessThanOrEqual(60 * SEC)
  })

  it('токена без срока таймером не рвём — null, а не «истёк в 1970»', () => {
    expect(msUntilExpiry({ id: 1 }, 1_800_000_000_000)).toBeNull()
    expect(msUntilExpiry({ exp: undefined }, 1_800_000_000_000)).toBeNull()
    expect(msUntilExpiry({ exp: null }, 1_800_000_000_000)).toBeNull()
  })

  it('exp не число (строка, NaN) — null', () => {
    expect(msUntilExpiry({ exp: '1800000000' }, 0)).toBeNull()
    expect(msUntilExpiry({ exp: NaN }, 0)).toBeNull()
  })

  it('payload не объект — null, а не исключение в обработчике подключения', () => {
    expect(msUntilExpiry(null, 0)).toBeNull()
    expect(msUntilExpiry(undefined, 0)).toBeNull()
    expect(msUntilExpiry('token', 0)).toBeNull()
  })
})

/**
 * Вторая половина: сама развязка. Чистая арифметика ничего не защищает, пока
 * по ней не рвётся соединение, — поэтому здесь поднимается настоящий
 * `initSocket` с подставным socket.io и через него прогоняется живой сокет.
 *
 * Обратная опасность у этой же развязки: таймер на КАЖДОМ соединении. Клиент
 * стойки за смену переподключается десятки раз (сон ноутбука, потеря Wi-Fi), и
 * не снятый при разрыве таймер остаётся висеть на восемь часов вместе со
 * ссылкой на мёртвый сокет. Поэтому проверяются обе стороны: рвём вовремя и
 * не оставляем мусора после ухода клиента.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret'

const ADMIN = { id: 1, username: 'admin', name: 'Главный администратор', role: 'ADMIN', isActive: true, tokenVersion: 0 }

function loadSocketManager() {
  const created = {}
  class FakeServer {
    constructor(_server, opts) {
      this.opts = opts
      this.mw = []
      this.handlers = {}
      created.io = this
    }
    use(fn) { this.mw.push(fn) }
    on(ev, fn) { this.handlers[ev] = fn }
    to() { return { emit() {} } }
  }
  const prisma = {
    admin: {
      findUnique: async () => ({ ...ADMIN }),
      findMany: async () => [{ ...ADMIN }],
    },
  }
  const mod = loadCjs('src/socket/socketManager.js', {
    stubs: {
      'socket.io': { Server: FakeServer },
      '../utils/prisma': { prisma },
      '../utils/logger': silentLogger,
    },
  })
  mod.initSocket({})
  return created.io
}

function fakeSocket(token) {
  const handlers = {}
  return {
    handshake: { auth: { token } },
    emitted: [],
    disconnects: [],
    emit(ev, data) { this.emitted.push([ev, data]) },
    // Как настоящий socket.io: разрыв поднимает событие 'disconnect', на котором
    // модуль снимает таймер и убирает сокет из учёта. Без этого фейк «залипал» бы
    // в списке подключённых и ловил второй разрыв от пятиминутной перепроверки.
    disconnect(close) {
      this.disconnects.push(close)
      const fn = handlers.disconnect
      handlers.disconnect = null
      fn?.()
    },
    join() {},
    on(ev, fn) { handlers[ev] = fn },
    fire(ev) { const fn = handlers[ev]; handlers[ev] = null; fn?.() },
  }
}

/** Проводит сокет через handshake и обработчик connection, как настоящий io. */
async function connect(io, token) {
  const socket = fakeSocket(token)
  await new Promise((resolve, reject) => {
    io.mw[0](socket, (err) => (err ? reject(err) : resolve()))
  })
  io.handlers.connection(socket)
  return socket
}

describe('соединение не переживает токен (D1-007)', () => {
  it('токен истёк — сокет разорван с причиной, а не продолжает получать сетку', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-08T12:00:00.000Z'))
    const io = loadSocketManager()
    const socket = await connect(io, jwt.sign({ id: 1, tv: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' }))

    await vi.advanceTimersByTimeAsync(3_500 * SEC)
    expect(socket.disconnects).toHaveLength(0)   // до срока рвать нечего

    await vi.advanceTimersByTimeAsync(200 * SEC) // час прошёл
    expect(socket.disconnects).toEqual([true])
    expect(socket.emitted).toContainEqual(['auth:revoked', { reason: 'token_expired' }])
  })

  it('клиент ушёл раньше срока — таймер снят, мёртвый сокет не «разрывают» повторно', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-08T12:00:00.000Z'))
    const io = loadSocketManager()
    const socket = await connect(io, jwt.sign({ id: 1, tv: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' }))

    socket.fire('disconnect')
    await vi.advanceTimersByTimeAsync(2 * 3600 * SEC)
    expect(socket.disconnects).toHaveLength(0)
    expect(socket.emitted).toHaveLength(0)
  })
})
