/**
 * Регрессионный обзор волны 12 (2026-09-13): что изменилось вокруг записи брони
 * и обработки ошибок.
 *
 *  • `updateMany` вместо `update` в транзакции (S13-004) — вместе с `select`
 *    пропала и ошибка Prisma `P2025`; вместо неё контроллер сам различает
 *    «версия не та» (409) и «строки нет» (404) по `count === 0`.
 *  • `errorHandler`: взаимоблокировка (`P2034`, `40P01`) переводится в 409. Текст
 *    «Номер уже занят на выбранные даты» — только на роутах размещения; на
 *    остальных 409 `CONCURRENT_UPDATE` (починено волной 12b, R13-S-003).
 *  • вход: логин проверяется по `USERNAME_RE`, запасной поиск без учёта регистра
 *    обходится без `ILIKE` (починено волной 12b, R13-S-004).
 *  • `authLimiter` точечно на `/auth/login` и `/auth/change-password` (S13-006).
 *
 * База и живой сервер не участвуют: стенд `helpers/bookingStack.js`, чистый
 * `errorHandler` и `src/app.js` с заглушками вместо гейта, журнала и роутов входа.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { makeStack, run, booking, charge, rate, chargesOf, d } from './helpers/bookingStack.js'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'
import { createFakePrisma } from './helpers/fakePrisma.js'

const VERSION = '2026-07-05T10:00:00.000Z'

function stand() {
  return makeStack({
    rates: ['2026-07-10', '2026-07-11', '2026-07-12'].map((iso) => rate(iso)),
    bookings: [booking({ id: 1, services: [], updatedAt: new Date(VERSION) })],
    charges: [charge({ id: 1, bookingId: 1, date: d('2026-07-10'), amount: 30000, unitPrice: 30000 })],
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// S13-004 · условная запись: что стало с ветками, которые раньше вела Prisma
// ─────────────────────────────────────────────────────────────────────────────

describe('S13-004 · условный UPDATE и его ветки', () => {
  it('старый клиент без expectedUpdatedAt сохраняет по-прежнему (условие только по id)', async () => {
    const { ctrl, calls } = stand()
    const out = await run(ctrl.update, { params: { id: '1' }, body: { guestName: 'Без замка' } })
    expect(out.status).toBe(200)
    const upd = calls.find((c) => c.model === 'booking' && c.op === 'updateMany')
    expect(Object.keys(upd.args.where)).toEqual(['id'])
  })

  /**
   * Раньше эту ветку вела сама Prisma: `update` по исчезнувшей строке бросал
   * `P2025`, и `errorHandler` отвечал 404 «Запись не найдена». Теперь ветку
   * ведёт контроллер — ответ обязан остаться 404, а не превратиться в 409.
   */
  it('строка исчезла между проверкой и записью → 404, а не 409', async () => {
    const { ctrl, prisma } = stand()
    prisma.booking.updateMany = async () => ({ count: 0 })
    const out = await run(ctrl.update, { params: { id: '1' }, body: { guestName: 'Гонка' } })
    expect(out.status).toBe(404)
    expect(out.body.error).toMatch(/не найдена/i)
  })

  it('версия прислана, а строка не изменилась → 409 BOOKING_STALE с текущей бронью', async () => {
    const { ctrl, prisma, emitted } = stand()
    prisma.booking.updateMany = async () => ({ count: 0 })
    const out = await run(ctrl.update, {
      params: { id: '1' },
      body: { guestName: 'Второй', expectedUpdatedAt: VERSION },
    })
    expect(out.status).toBe(409)
    expect(out.body.code).toBe('BOOKING_STALE')
    expect(out.body.booking.id).toBe(1)
    // Отказ не должен выглядеть как изменение брони на других рабочих местах
    expect(emitted).toEqual([])
  })

  it('отказ по замку не трогает начисления', async () => {
    const { ctrl, prisma, calls } = stand()
    prisma.booking.updateMany = async () => ({ count: 0 })
    await run(ctrl.update, {
      params: { id: '1' },
      // Даты меняются, то есть счёт пересобирался бы — если бы дошло до пересборки
      body: { checkIn: '2026-07-11', checkOut: '2026-07-13', expectedUpdatedAt: VERSION },
    })
    expect(chargesOf(prisma, 1).map((c) => c.id)).toEqual([1])
    expect(calls.some((c) => c.model === 'bookingCharge' && c.op === 'deleteMany')).toBe(false)
  })

  it('удачное сохранение по-прежнему отдаёт бронь и событие booking:updated', async () => {
    const { ctrl, emitted } = stand()
    const out = await run(ctrl.update, {
      params: { id: '1' }, body: { guestName: 'Петров', expectedUpdatedAt: VERSION },
    })
    expect(out.status).toBe(200)
    expect(out.body.data.guestName).toBe('Петров')
    // Ответ собирается отдельным findUnique вместо select у update — состав полей не должен меняться
    expect(out.body.data).toHaveProperty('room')
    expect(out.body.data).toHaveProperty('totalAmount')
    expect(emitted.map((e) => e.event)).toEqual(['booking:updated'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// R13-S-003 · 409 «Номер уже занят» шире, чем брони
// ─────────────────────────────────────────────────────────────────────────────

describe('R13-S-003 · взаимоблокировка → 409 про номер', () => {
  const handler = () => loadCjs('src/middleware/errorHandler.js', {
    stubs: { '../utils/logger': silentLogger },
  }).errorHandler

  function call(err, url = '/api/bookings/1') {
    const out = { status: 200, body: null, passed: false }
    const res = {
      status(code) { out.status = code; return res },
      json(payload) { out.body = payload; return res },
    }
    handler()(err, { method: 'PUT', originalUrl: url }, res, () => { out.passed = true })
    return out
  }

  it('пересечение броней по-прежнему 409 с понятным текстом (сторож)', () => {
    const out = call(Object.assign(new Error('conflicting key value violates exclusion constraint "booking_no_overlap"')))
    expect(out.status).toBe(409)
    expect(out.body.error).toMatch(/Номер уже занят/)
  })

  it('взаимоблокировка на бронях — текст про номер и даты', () => {
    const err = Object.assign(new Error('Transaction failed due to a write conflict or a deadlock'), { code: 'P2034' })
    const out = call(err, '/api/bookings/1')
    expect(out.status).toBe(409)
    expect(out.body.error).toMatch(/Номер уже занят на выбранные даты/)
    expect(out.body.code).toBeUndefined()
  })

  it('взаимоблокировка на шахматке — тот же текст (размещение)', () => {
    const err = Object.assign(new Error('40P01 deadlock detected'), { name: 'PrismaClientUnknownRequestError' })
    const out = call(err, '/api/occupancy/grid?from=2026-07-01')
    expect(out.status).toBe(409)
    expect(out.body.error).toMatch(/Номер уже занят на выбранные даты/)
  })

  it('P2034 на возврате платежа не упоминает номер и даты', () => {
    const err = Object.assign(new Error('Transaction failed due to a write conflict or a deadlock'), { code: 'P2034' })
    const out = call(err, '/api/payments/12/void')
    expect(out.status).toBe(409)
    expect(out.body.code).toBe('CONCURRENT_UPDATE')
    expect(out.body.error).toBe('Операция не удалась из-за одновременного изменения данных. Повторите ещё раз.')
    expect(out.body.error).not.toMatch(/Номер/)
  })

  it('взаимоблокировка при восстановлении копии — тоже CONCURRENT_UPDATE', () => {
    const err = Object.assign(new Error('\nInvalid `prisma.payment.deleteMany()` invocation:\n\ndeadlock detected'), {
      name: 'PrismaClientUnknownRequestError',
    })
    const out = call(err, '/api/system/backup/restore')
    expect(out.status).toBe(409)
    expect(out.body.code).toBe('CONCURRENT_UPDATE')
    expect(out.body.error).not.toMatch(/Номер/)
  })

  /**
   * Отказ по exclusion-constraint говорит о номере и датах сам по себе: он
   * приходит только с `booking_no_overlap`, на каком бы роуте ни случился.
   */
  it('пересечение броней вне /api/bookings всё равно называет номер занятым', () => {
    const err = new Error('conflicting key value violates exclusion constraint "booking_no_overlap"')
    const out = call(err, '/api/system/backup/restore')
    expect(out.status).toBe(409)
    expect(out.body.error).toMatch(/Номер уже занят/)
  })

  it('обычная ошибка сервера в 409 не превращается (сторож)', () => {
    const out = call(new Error('ENOSPC: no space left on device'), '/api/system/backup')
    expect(out.status).toBe(500)
    expect(out.body.error).toBe('Внутренняя ошибка сервера')
  })

  it('ошибка с собственным статусом остаётся собой (сторож)', () => {
    const out = call(Object.assign(new Error('Нельзя редактировать закрытую бронь'), { status: 400 }))
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('Нельзя редактировать закрытую бронь')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// R13-S-004 · что уходит в поиск учётки без учёта регистра
// ─────────────────────────────────────────────────────────────────────────────

describe('R13-S-004 · подстановка в поле «Логин»', () => {
  /**
   * До починки `loginRules` проверял только «поле не пустое», и непроверенная
   * строка попадала в `findFirst({ username: { equals, mode: 'insensitive' } })`.
   * Prisma компилирует такой фильтр в `ILIKE`, поэтому `%` находил ПЕРВУЮ учётку
   * отеля (подтверждено на демо-базе: `%` → `aigerim`).
   *
   * Теперь логин обязан пройти `USERNAME_RE` (латиница, цифры, `. _ -`), а
   * запасной поиск без учёта регистра складывает регистр сам, без шаблонов SQL:
   * `_` в логине разрешён, и в `ILIKE` он значил бы «любой символ».
   *
   * Пароль ниже неверный всегда — проверяется поиск учётки, а не вход.
   */
  const HASH = '$2a$04$notarealhashnotarealhashnotarealhashnotarealhash'

  function authStand(admins = [{ username: 'aigerim' }]) {
    const { prisma, calls } = createFakePrisma({
      admin: admins.map((a, i) => ({
        id: i + 1, name: 'Сотрудник', role: 'SUPER_ADMIN',
        isActive: true, tokenVersion: 0, password: HASH, ...a,
      })),
    })
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'audit13b-test-secret'
    const ctrl = loadCjs('src/controllers/authController.js', {
      stubs: { '../utils/prisma': { prisma }, '../utils/sessions': { revokeSessions: async () => ({}) } },
    })
    return { ctrl, calls, prisma }
  }

  /** Логин, введённый в форме → как ответил контроллер и ходил ли он в базу. */
  async function tryLogin(username, admins) {
    const { ctrl, calls } = authStand(admins)
    const out = await run(ctrl.login, { body: { username, password: 'неверный пароль' } })
    return { out, calls }
  }

  for (const bad of ['%', 'a%', '%igerim%', 'aigerim%']) {
    it(`«${bad}» отвергается 401 и до базы не доходит`, async () => {
      const { out, calls } = await tryLogin(bad)
      expect(out.status).toBe(401)
      expect(out.body.error).toBe('Неверный логин или пароль')
      expect(calls.filter((c) => c.model === 'admin')).toEqual([])
    })
  }

  /**
   * `_` — законный символ логина (`admin_2`), поэтому regex его пропускает. Но в
   * `ILIKE` он значит «любой один символ», и `_igerim` нашёл бы `aigerim`:
   * ровно из-за этого запасной поиск переведён на сравнение в памяти.
   */
  it('«_igerim» ищется буквально и `aigerim` не находит', async () => {
    const { out, calls } = await tryLogin('_igerim')
    expect(out.status).toBe(401)
    expect(out.body.error).toBe('Неверный логин или пароль')
    // Запасной поиск читает только id и логины и ничего не подставляет
    const fallback = calls.find((c) => c.model === 'admin' && c.op === 'findMany')
    expect(fallback.args.select).toEqual({ id: true, username: true })
    expect(calls.some((c) => c.model === 'admin' && c.op === 'findFirst')).toBe(false)
  })

  it('кириллица в логине тоже не доходит до базы', async () => {
    const { out, calls } = await tryLogin('айгерим')
    expect(out.status).toBe(401)
    expect(calls.filter((c) => c.model === 'admin')).toEqual([])
  })

  it('AIGERIM — тот же человек: точное совпадение по нижнему регистру', async () => {
    const { out, calls } = await tryLogin('  AIGERIM ')
    // Пароль неверный, но учётка найдена — значит нормализация работает
    expect(out.status).toBe(401)
    const exact = calls.find((c) => c.model === 'admin' && c.op === 'findUnique')
    expect(exact.args.where.username).toBe('aigerim')
  })

  it('старая база с логином `Admin` входит через запасной поиск (сторож)', async () => {
    const { ctrl, prisma } = authStand([{ username: 'Admin' }])
    // bcrypt.compare с настоящим хешем — единственный способ дойти до 200 нельзя,
    // поэтому проверяем, что учётка НАЙДЕНА: иначе isActive не читался бы вовсе
    const spy = []
    const realFindUnique = prisma.admin.findUnique
    prisma.admin.findUnique = async (args) => { spy.push(args); return realFindUnique(args) }
    await run(ctrl.login, { body: { username: 'admin', password: 'неверный' } })
    // Первый findUnique — точный по username (промах), второй — по id найденной строки
    expect(spy.map((a) => Object.keys(a.where)[0])).toEqual(['username', 'id'])
    expect(spy[1].where.id).toBe(1)
  })

  it('`admin_2` не путается с `admin12`', async () => {
    const { ctrl, calls } = authStand([{ username: 'admin12' }, { username: 'admin_2' }])
    await run(ctrl.login, { body: { username: 'admin_2', password: 'неверный' } })
    const exact = calls.find((c) => c.model === 'admin' && c.op === 'findUnique')
    expect(exact.args.where.username).toBe('admin_2')
    // Запасной поиск не понадобился — точное совпадение нашлось
    expect(calls.some((c) => c.model === 'admin' && c.op === 'findMany')).toBe(false)
  })

  it('`admin_2` при отсутствующей учётке не подбирает `admin12` запасным поиском', async () => {
    const { ctrl } = authStand([{ username: 'admin12' }])
    const out = await run(ctrl.login, { body: { username: 'admin_2', password: 'неверный' } })
    expect(out.status).toBe(401)
    expect(out.body.error).toBe('Неверный логин или пароль')
  })

  /**
   * Первая проверка — в `loginRules`. До контроллера такой запрос не доходит
   * вовсе, а ответ не отличается от «неверный пароль»: по разнице ответов иначе
   * было бы видно, из каких символов логины отеля состоят.
   */
  describe('роут /api/auth/login', () => {
    let app
    const seen = []

    beforeAll(() => {
      const routes = loadCjs('src/routes/auth.js', {
        stubs: {
          '../controllers/authController': {
            USERNAME_RE: /^[a-z0-9._-]+$/,
            login: (req, res) => { seen.push(req.body.username); res.json({ ok: true }) },
            logout: (_req, res) => res.json({}),
            me: (_req, res) => res.json({}),
            changePassword: (_req, res) => res.json({}),
          },
          '../middleware/auth': { authenticate: (_req, _res, next) => next() },
        },
      })
      app = express()
      app.use(express.json())
      app.use('/api/auth', routes)
    })

    async function post(body) {
      const server = http.createServer(app)
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        return { status: res.status, body: await res.json() }
      } finally {
        await new Promise((resolve) => server.close(resolve))
      }
    }

    it('`%` в логине — 401 «Неверный логин или пароль», контроллер не вызван', async () => {
      const res = await post({ username: '%', password: 'x' })
      expect(res.status).toBe(401)
      expect(res.body).toEqual({ error: 'Неверный логин или пароль' })
      expect(seen).toEqual([])
    })

    it('пустой логин отвечает тем же 401, без списка полей', async () => {
      const res = await post({ username: '', password: 'x' })
      expect(res.status).toBe(401)
      expect(res.body).toEqual({ error: 'Неверный логин или пароль' })
      expect(res.body.details).toBeUndefined()
    })

    it('нормальный логин доходит до контроллера в нижнем регистре', async () => {
      const res = await post({ username: '  AIGERIM ', password: 'x' })
      expect(res.status).toBe(200)
      expect(seen).toEqual(['aigerim'])
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S13-006 · лимитер входа после переноса
// ─────────────────────────────────────────────────────────────────────────────

describe('S13-006 · что считает лимитер входа', () => {
  let app

  function fakeAuthRoutes() {
    const r = express.Router()
    r.post('/login', (_req, res) => res.status(401).json({ error: 'Неверный логин или пароль' }))
    r.post('/change-password', (_req, res) => res.status(401).json({ error: 'Нет токена' }))
    r.post('/logout', (_req, res) => res.status(401).json({ error: 'Нет токена' }))
    r.get('/me', (_req, res) => res.status(401).json({ error: 'Нет токена' }))
    return r
  }

  beforeAll(() => {
    process.env.LOG_PATH = path.join(os.tmpdir(), 'roomline-audit13b-logs')
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'audit13b-test-secret'
    const was = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'      // потолок входа 20 за 15 минут, как у клиента
    try {
      app = loadCjs('src/app.js', {
        stubs: {
          './middleware/license': { maintenanceGate: (_req, _res, next) => next() },
          './middleware/audit': { auditMiddleware: (_req, _res, next) => next() },
          './utils/logger': silentLogger,
          './routes/auth': fakeAuthRoutes(),
        },
      })
    } finally { process.env.NODE_ENV = was }
  })

  async function withServer(fn) {
    const server = http.createServer(app)
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      return await fn(`http://127.0.0.1:${server.address().port}`)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  }

  it('подбор текущего пароля через смену пароля упирается в лимитер', async () => {
    const status = await withServer(async (base) => {
      let last = 0
      for (let i = 0; i < 21; i++) {
        const res = await fetch(`${base}/api/auth/change-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPassword: `подбор-${i}`, newPassword: 'Demo2026!' }),
        })
        last = res.status
      }
      return last
    })
    expect(status).toBe(429)
  })

  it('выход из программы лимитером входа не считается', async () => {
    const status = await withServer(async (base) => {
      let last = 0
      for (let i = 0; i < 25; i++) {
        const res = await fetch(`${base}/api/auth/logout`, {
          method: 'POST', headers: { Authorization: 'Bearer no-such-token' },
        })
        last = res.status
      }
      return last
    })
    expect(status).not.toBe(429)
  })
})
