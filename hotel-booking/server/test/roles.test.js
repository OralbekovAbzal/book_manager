import { describe, it, expect } from 'vitest'
import { loadCjs } from './helpers/loadCjs.js'

/**
 * Волна 5b, пункт 1: роли осталось две — SUPER_ADMIN и ADMIN.
 *
 * Решение (`docs/decisions/interface.md`, 2026-09-08): отличать «стойку» от
 * «администратора» оказалось нечем — рабочие места делают одно и то же, а половина
 * проверок STAFF держалась только с одной стороны (`moneyKnownIssues` про правку
 * строк закрытой брони — ровно эта дыра).
 *
 * Значение `STAFF` из enum схемы НЕ удалено намеренно (миграция enum в Postgres
 * дорога и бессмысленна), поэтому запрет держится ровно в одном месте — на
 * валидации роутов. Если она разойдётся со схемой, роль вернётся тихо: база примет
 * `STAFF`, а половина проверок прав его не узнает. Отсюда и тесты: прогоняем
 * НАСТОЯЩИЕ правила через `express-validator`, как в `hotelRequisites.test.js`,
 * а не сверяем константу с константой.
 *
 * Два роута, а не один: `/api/users` заводит сотрудников в работающей программе,
 * `/api/setup/complete` — мастер первого запуска, и он ПУБЛИЧНЫЙ (без токена).
 * Забыть про второй легче всего, а стоит это учётки с непонятными правами на
 * свежей установке у клиента.
 */

const validate = loadCjs('src/middleware/validate.js')

const authStub = {
  authenticate: (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
}

/** Правила роутов не экспортируются — достаём их дописанным экспортом, файл не трогая. */
function loadUserRules() {
  return loadCjs('src/routes/users.js', {
    append: 'module.exports.__test = { ROLES, createRules, updateRules }',
    stubs: {
      '../controllers/userController': { list: () => {}, create: () => {}, update: () => {}, setPassword: () => {} },
      '../middleware/auth': authStub,
      '../middleware/validate': validate,
    },
  }).__test
}

function loadSetupRules() {
  return loadCjs('src/routes/setup.js', {
    append: 'module.exports.__test = { STAFF_ROLES, completeRules }',
    stubs: {
      '../controllers/setupController': { status: () => {}, complete: () => {} },
      '../middleware/validate': validate,
    },
  }).__test
}

/**
 * Прогон тела через правила роута и `middleware/validate` — тот же путь, что у
 * настоящего запроса. Возвращает 400 с полями-виновниками либо `null`, если тело прошло.
 */
async function check(rules, body, params = {}) {
  const req = { body: JSON.parse(JSON.stringify(body)), params, query: {}, headers: {}, cookies: {} }
  for (const rule of rules) await rule.run(req)

  let rejected = null
  const res = {
    status(code) { this.code = code; return this },
    json(payload) { rejected = { status: this.code, body: payload }; return this },
  }
  let passed = false
  validate.validate(req, res, () => { passed = true })
  return passed ? null : rejected
}

const fields = (res) => (res.body.details || []).map((d) => d.field)
const messages = (res) => (res.body.details || []).map((d) => d.message).join(' | ')

const GOOD_PASSWORD = 'Zima2026god'

const NEW_USER = { username: 'reception', name: 'Стойка', password: GOOD_PASSWORD }

// ─── /api/users ──────────────────────────────────────────────────────────────

describe('создание пользователя: роль STAFF больше не проходит', () => {
  it('POST /users с role STAFF отвергается на валидации, а не тихо создаёт учётку', async () => {
    const { createRules } = loadUserRules()

    const res = await check(createRules, { ...NEW_USER, role: 'STAFF' })

    expect(res.status).toBe(400)
    expect(fields(res)).toContain('role')
    // Текст обязан назвать допустимые роли: администратор увидит его в форме
    expect(messages(res)).toContain('ADMIN')
    expect(messages(res)).not.toContain('STAFF')
  })

  it('ADMIN и SUPER_ADMIN проходят — запрет не задел живые роли', async () => {
    const { createRules } = loadUserRules()

    expect(await check(createRules, { ...NEW_USER, role: 'ADMIN' })).toBeNull()
    expect(await check(createRules, { ...NEW_USER, role: 'SUPER_ADMIN' })).toBeNull()
  })

  it('смена роли на STAFF у существующего пользователя — тоже 400', async () => {
    // Отдельный набор правил (`updateRules`) со своим `optional()`: запрет на
    // создание ничего не говорит про PUT, а понизить админа до STAFF значило бы
    // вернуть роль через чёрный ход.
    const { updateRules } = loadUserRules()

    const res = await check(updateRules, { role: 'STAFF' }, { id: '5' })

    expect(res.status).toBe(400)
    expect(fields(res)).toContain('role')
  })

  it('PUT без роли проходит: правка имени не обязана называть роль', async () => {
    const { updateRules } = loadUserRules()

    expect(await check(updateRules, { name: 'Новое имя' }, { id: '5' })).toBeNull()
  })

  it('роль вообще не из словаря отвергается так же, как STAFF', async () => {
    // Сторож на «а не пустили ли мы любую строку»: 400 должен приходить из
    // `isIn(ROLES)`, а не из того, что STAFF где-то отдельно перечислен.
    const { createRules } = loadUserRules()

    const res = await check(createRules, { ...NEW_USER, role: 'MANAGER' })
    expect(res.status).toBe(400)
    expect(fields(res)).toContain('role')
  })

  it('список ролей роута не содержит STAFF', async () => {
    const { ROLES } = loadUserRules()
    expect(ROLES).toEqual(['SUPER_ADMIN', 'ADMIN'])
  })
})

// ─── /api/setup/complete (мастер первого запуска, БЕЗ токена) ────────────────

const SETUP_BODY = {
  hotel: { name: 'Туран' },
  mainAdmin: { username: 'director', name: 'Директор', password: GOOD_PASSWORD },
  users: [{ username: 'reception', name: 'Стойка', password: GOOD_PASSWORD, role: 'ADMIN' }],
}

describe('мастер первого запуска заводит только ADMIN', () => {
  it('сотрудник с role STAFF в мастере — 400', async () => {
    const { completeRules } = loadSetupRules()
    const body = { ...SETUP_BODY, users: [{ ...SETUP_BODY.users[0], role: 'STAFF' }] }

    const res = await check(completeRules, body)

    expect(res.status).toBe(400)
    expect(fields(res)).toContain('users[0].role')
  })

  it('SUPER_ADMIN в мастере тоже нельзя: главный администратор там ровно один', async () => {
    // Не «заодно», а по смыслу мастера: главный задаётся полем `mainAdmin`,
    // и второй SUPER_ADMIN из списка сотрудников — это тихое повышение прав
    // на свежей установке через ПУБЛИЧНЫЙ эндпоинт.
    const { completeRules } = loadSetupRules()
    const body = { ...SETUP_BODY, users: [{ ...SETUP_BODY.users[0], role: 'SUPER_ADMIN' }] }

    const res = await check(completeRules, body)

    expect(res.status).toBe(400)
    expect(fields(res)).toContain('users[0].role')
  })

  it('ADMIN проходит — мастер по-прежнему умеет заводить сотрудников', async () => {
    const { completeRules } = loadSetupRules()
    expect(await check(completeRules, SETUP_BODY)).toBeNull()
  })

  it('один STAFF среди нескольких сотрудников роняет весь мастер, а не проходит третьим', async () => {
    const { completeRules } = loadSetupRules()
    const body = {
      ...SETUP_BODY,
      users: [
        { username: 'admin1', name: 'Первый', password: GOOD_PASSWORD, role: 'ADMIN' },
        { username: 'staff1', name: 'Второй', password: GOOD_PASSWORD, role: 'STAFF' },
      ],
    }

    const res = await check(completeRules, body)

    expect(res.status).toBe(400)
    expect(fields(res)).toEqual(['users[1].role'])
  })
})
