import { describe, it, expect, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'
import { createFakePrisma } from './helpers/fakePrisma.js'

/**
 * Отзыв сессий через версию токена (Admin.tokenVersion ↔ claim `tv`).
 *
 * Две вещи с разной ценой ошибки:
 *  1) отозванный токен обязан упираться в 401 и в REST, и в handshake сокета —
 *     иначе смена пароля после утечки ничего не даёт;
 *  2) ЖИВЫЕ сессии не должны рваться от самого обновления программы: токены,
 *     выпущенные до появления поля, claim'а не несут и читаются как версия 0.
 */

process.env.JWT_SECRET = 'test-secret'

const sign = (claims) => jwt.sign(claims, process.env.JWT_SECRET, { expiresIn: '1h' })

function adminRow(overrides = {}) {
  return {
    id: 1, username: 'admin', password: 'x', name: 'Главный администратор',
    role: 'SUPER_ADMIN', isActive: true, tokenVersion: 0, ...overrides,
  }
}

function mockRes() {
  const res = { statusCode: 200, body: null }
  res.status = (c) => { res.statusCode = c; return res }
  res.json = (b) => { res.body = b; return res }
  return res
}

const rethrow = (e) => { throw e }

// ————————————————————————————————————————————————————————————————
// middleware/auth.js
// ————————————————————————————————————————————————————————————————
function loadAuth(prisma) {
  return loadCjs('src/middleware/auth.js', {
    stubs: { '../utils/prisma': { prisma }, '../utils/logger': silentLogger },
  })
}

async function runAuth(authenticate, token) {
  const req = { headers: { authorization: `Bearer ${token}` } }
  const res = mockRes()
  let nextCalled = false
  await authenticate(req, res, () => { nextCalled = true })
  return { req, res, nextCalled }
}

describe('middleware/auth — версия сессии', () => {
  it('токен с актуальной версией проходит, а tokenVersion в req.admin не утекает', async () => {
    const { prisma } = createFakePrisma({ admin: [adminRow({ tokenVersion: 3 })] })
    const { authenticate } = loadAuth(prisma)
    const { req, res, nextCalled } = await runAuth(authenticate, sign({ id: 1, role: 'SUPER_ADMIN', tv: 3 }))
    expect(nextCalled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(req.admin).toEqual({
      id: 1, username: 'admin', name: 'Главный администратор', role: 'SUPER_ADMIN', isActive: true,
    })
  })

  it('токен без claim tv (выпущен до обновления) проходит при версии 0 — обновление никого не разлогинивает', async () => {
    const { prisma } = createFakePrisma({ admin: [adminRow()] })
    const { authenticate } = loadAuth(prisma)
    const { nextCalled } = await runAuth(authenticate, sign({ id: 1, role: 'SUPER_ADMIN' }))
    expect(nextCalled).toBe(true)
  })

  it('отозванный токен (версия в базе выше) — 401 с внятным текстом', async () => {
    const { prisma } = createFakePrisma({ admin: [adminRow({ tokenVersion: 1 })] })
    const { authenticate } = loadAuth(prisma)
    const { res, nextCalled } = await runAuth(authenticate, sign({ id: 1, role: 'SUPER_ADMIN', tv: 0 }))
    expect(nextCalled).toBe(false)
    expect(res.statusCode).toBe(401)
    expect(res.body.error).toBe('Сессия завершена, войдите заново')
  })

  it('старый токен без tv после первого отзыва тоже не проходит', async () => {
    const { prisma } = createFakePrisma({ admin: [adminRow({ tokenVersion: 1 })] })
    const { authenticate } = loadAuth(prisma)
    const { res } = await runAuth(authenticate, sign({ id: 1, role: 'SUPER_ADMIN' }))
    expect(res.statusCode).toBe(401)
  })

  it('деактивация по-прежнему важнее версии', async () => {
    const { prisma } = createFakePrisma({ admin: [adminRow({ isActive: false })] })
    const { authenticate } = loadAuth(prisma)
    const { res } = await runAuth(authenticate, sign({ id: 1, role: 'SUPER_ADMIN', tv: 0 }))
    expect(res.statusCode).toBe(401)
    expect(res.body.error).toMatch(/деактивирован/)
  })
})

// ————————————————————————————————————————————————————————————————
// utils/sessions.js
// ————————————————————————————————————————————————————————————————
function loadSessions(prisma, disconnectAdmin = vi.fn()) {
  const lib = loadCjs('src/utils/sessions.js', {
    stubs: {
      './prisma': { prisma },
      './logger': silentLogger,
      '../socket/socketManager': { disconnectAdmin },
    },
  })
  return { ...lib, disconnectAdmin }
}

describe('utils/sessions.revokeSessions', () => {
  it('поднимает версию, пишет data той же строкой и рвёт сокеты с причиной', async () => {
    const { prisma, calls } = createFakePrisma({ admin: [adminRow({ tokenVersion: 2 })] })
    const { revokeSessions, disconnectAdmin } = loadSessions(prisma)

    const admin = await revokeSessions(1, { reason: 'password_changed', data: { password: 'new-hash' } })

    expect(admin.tokenVersion).toBe(3)
    expect(prisma.admin.rows[0]).toMatchObject({ tokenVersion: 3, password: 'new-hash' })
    expect(disconnectAdmin).toHaveBeenCalledWith(1, 'password_changed')
    // Хеш и версия — одна запись, а не две, между которыми можно успеть войти
    expect(calls.filter((c) => c.model === 'admin' && c.op === 'update')).toHaveLength(1)
  })

  it('без аргументов — причина session_revoked, других полей не трогает', async () => {
    const { prisma } = createFakePrisma({ admin: [adminRow({ password: 'keep' })] })
    const { revokeSessions, disconnectAdmin } = loadSessions(prisma)
    await revokeSessions(1)
    expect(prisma.admin.rows[0]).toMatchObject({ tokenVersion: 1, password: 'keep' })
    expect(disconnectAdmin).toHaveBeenCalledWith(1, 'session_revoked')
  })

  it('сбой сокета запрос не роняет — версия в базе уже поднята, REST закрыт', async () => {
    const { prisma } = createFakePrisma({ admin: [adminRow()] })
    const { revokeSessions } = loadSessions(prisma, vi.fn(() => { throw new Error('io down') }))
    await expect(revokeSessions(1)).resolves.toMatchObject({ tokenVersion: 1 })
  })
})

// ————————————————————————————————————————————————————————————————
// authController.js
// ————————————————————————————————————————————————————————————————
function loadAuthController(prisma, revokeSessions = vi.fn(async () => adminRow({ tokenVersion: 1 }))) {
  const lib = loadCjs('src/controllers/authController.js', {
    stubs: { '../utils/prisma': { prisma }, '../utils/sessions': { revokeSessions } },
  })
  return { ...lib, revokeSessions }
}

describe('authController', () => {
  it('login кладёт версию сессии в токен', async () => {
    const hash = bcrypt.hashSync('secret-1', 4)
    const { prisma } = createFakePrisma({ admin: [adminRow({ password: hash, tokenVersion: 5 })] })
    const { login } = loadAuthController(prisma)
    const res = mockRes()
    await login({ body: { username: 'admin', password: 'secret-1' } }, res, rethrow)
    expect(res.statusCode).toBe(200)
    expect(jwt.verify(res.body.token, process.env.JWT_SECRET)).toMatchObject({ id: 1, role: 'SUPER_ADMIN', tv: 5 })
  })

  it('logout отзывает все сессии учётной записи, а не просто отвечает «ок»', async () => {
    const { prisma } = createFakePrisma({ admin: [adminRow()] })
    const { logout, revokeSessions } = loadAuthController(prisma)
    const res = mockRes()
    await logout({ admin: { id: 1 } }, res, rethrow)
    expect(revokeSessions).toHaveBeenCalledWith(1, { reason: 'session_revoked' })
    expect(res.statusCode).toBe(200)
  })

  it('changePassword: неверный текущий пароль — 400, сессии не трогаются', async () => {
    const { prisma } = createFakePrisma({ admin: [adminRow({ password: bcrypt.hashSync('old-pass-1', 4) })] })
    const { changePassword, revokeSessions } = loadAuthController(prisma)
    const res = mockRes()
    await changePassword({ admin: { id: 1 }, body: { currentPassword: 'wrong', newPassword: 'new-pass-12' } }, res, rethrow)
    expect(res.statusCode).toBe(400)
    expect(revokeSessions).not.toHaveBeenCalled()
  })

  it('changePassword: новый хеш и отзыв сессий — одной записью', async () => {
    const { prisma } = createFakePrisma({ admin: [adminRow({ password: bcrypt.hashSync('old-pass-1', 4) })] })
    const { changePassword, revokeSessions } = loadAuthController(prisma)
    const res = mockRes()
    await changePassword({ admin: { id: 1 }, body: { currentPassword: 'old-pass-1', newPassword: 'new-pass-12' } }, res, rethrow)
    expect(res.statusCode).toBe(200)
    expect(revokeSessions).toHaveBeenCalledTimes(1)
    const [id, opts] = revokeSessions.mock.calls[0]
    expect(id).toBe(1)
    expect(opts.reason).toBe('password_changed')
    expect(bcrypt.compareSync('new-pass-12', opts.data.password)).toBe(true)
  })
})

describe('setupController.signToken — та же версия сессии, что у authController', () => {
  it('claim tv берётся из tokenVersion', () => {
    const { __signToken } = loadCjs('src/controllers/setupController.js', {
      stubs: { '../utils/prisma': { prisma: {} } },
      append: 'module.exports.__signToken = signToken',
    })
    const claims = jwt.verify(__signToken({ id: 7, role: 'SUPER_ADMIN', tokenVersion: 2 }), process.env.JWT_SECRET)
    expect(claims).toMatchObject({ id: 7, role: 'SUPER_ADMIN', tv: 2 })
  })
})

// ————————————————————————————————————————————————————————————————
// userController.setPassword
// ————————————————————————————————————————————————————————————————
describe('userController.setPassword', () => {
  it('сброс пароля сотруднику отзывает его сессии, хеш уходит той же записью', async () => {
    const { prisma } = createFakePrisma({ admin: [adminRow({ id: 5, username: 'nurlan', role: 'STAFF' })] })
    const revokeSessions = vi.fn(async () => ({}))
    const { setPassword } = loadCjs('src/controllers/userController.js', {
      stubs: {
        '../utils/prisma': { prisma },
        '../utils/sessions': { revokeSessions },
        '../socket/socketManager': { disconnectAdmin: vi.fn() },
        '../utils/logger': silentLogger,
        '../middleware/errorHandler': { createError: (m, s) => Object.assign(new Error(m), { status: s }) },
      },
    })
    const res = mockRes()
    await setPassword({ params: { id: '5' }, body: { password: 'new-pass-12' }, admin: { id: 1 } }, res, rethrow)
    expect(res.statusCode).toBe(200)
    expect(revokeSessions).toHaveBeenCalledTimes(1)
    const [id, opts] = revokeSessions.mock.calls[0]
    expect(id).toBe(5)
    expect(opts.reason).toBe('password_changed')
    expect(bcrypt.compareSync('new-pass-12', opts.data.password)).toBe(true)
  })
})

// ————————————————————————————————————————————————————————————————
// socketManager.js — handshake, отзыв, перепроверка
// ————————————————————————————————————————————————————————————————
function loadSocketManager(prisma, { append = '' } = {}) {
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
    append,
  })
  lib.initSocket({})
  return { ...lib, state }
}

function fakeSocket(token) {
  const s = { handshake: { auth: { token } }, emitted: [], disconnected: false, listeners: {} }
  s.emit = (ev, p) => { s.emitted.push([ev, p]) }
  s.on = (ev, fn) => { s.listeners[ev] = fn }
  s.join = () => {}
  // socket.io зовёт обработчик 'disconnect' и при разрыве с сервера — как и настоящий
  s.disconnect = () => { s.disconnected = true; s.listeners.disconnect?.() }
  return s
}

const handshake = (state, socket) => new Promise((resolve) => state.middlewares[0](socket, resolve))

async function connect(state, socket) {
  const err = await handshake(state, socket)
  if (err) throw err
  state.handlers.connection(socket)
}

describe('socketManager — версия сессии', () => {
  it('отозванный токен не открывает сокет', async () => {
    const { prisma } = createFakePrisma({ admin: [adminRow({ tokenVersion: 1 })] })
    const { state } = loadSocketManager(prisma)
    const err = await handshake(state, fakeSocket(sign({ id: 1, role: 'SUPER_ADMIN', tv: 0 })))
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('Session revoked')
  })

  it('токен без tv при версии 0 открывает сокет и запоминает версию', async () => {
    const { prisma } = createFakePrisma({ admin: [adminRow()] })
    const { state } = loadSocketManager(prisma)
    const socket = fakeSocket(sign({ id: 1, role: 'SUPER_ADMIN' }))
    expect(await handshake(state, socket)).toBeUndefined()
    expect(socket.tokenVersion).toBe(0)
    expect(socket.admin).toMatchObject({ id: 1, role: 'SUPER_ADMIN' })
  })

  it('disconnectAdmin сообщает причину и рвёт все сокеты сотрудника', async () => {
    const { prisma } = createFakePrisma({ admin: [adminRow()] })
    const { state, disconnectAdmin } = loadSocketManager(prisma)
    const a = fakeSocket(sign({ id: 1, role: 'SUPER_ADMIN', tv: 0 }))
    const b = fakeSocket(sign({ id: 1, role: 'SUPER_ADMIN', tv: 0 }))
    await connect(state, a)
    await connect(state, b)

    expect(disconnectAdmin(1, 'password_changed')).toBe(2)
    for (const s of [a, b]) {
      expect(s.emitted).toEqual([['auth:revoked', { reason: 'password_changed' }]])
      expect(s.disconnected).toBe(true)
    }
    // Соединений больше нет — повторный вызов ничего не находит
    expect(disconnectAdmin(1, 'password_changed')).toBe(0)
  })

  it('перепроверка рвёт сокеты, чью версию подняли мимо API, и не трогает актуальные', async () => {
    const { prisma } = createFakePrisma({ admin: [adminRow({ id: 1 }), adminRow({ id: 2, username: 'b' })] })
    const { state, __recheck } = loadSocketManager(prisma, {
      append: 'module.exports.__recheck = recheckConnectedAdmins',
    })
    const stale = fakeSocket(sign({ id: 1, role: 'SUPER_ADMIN', tv: 0 }))
    const fresh = fakeSocket(sign({ id: 2, role: 'SUPER_ADMIN', tv: 0 }))
    await connect(state, stale)
    await connect(state, fresh)

    prisma.admin.rows[0].tokenVersion = 1   // «правкой в базе»
    await __recheck()

    expect(stale.emitted).toEqual([['auth:revoked', { reason: 'session_revoked' }]])
    expect(stale.disconnected).toBe(true)
    expect(fresh.emitted).toEqual([])
    expect(fresh.disconnected).toBe(false)
  })
})
