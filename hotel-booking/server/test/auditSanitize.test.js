import { describe, it, expect, vi } from 'vitest'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'

/**
 * Документы гостей не должны оседать в журнале действий (D1-005).
 *
 * `AuditLog.details` — это тело запроса как есть. Каждая правка брони
 * складывала туда номер удостоверения, дату рождения и пол, и лежало это
 * вечно, без срока хранения и вне всякой связи с самой бронью: удалили бронь,
 * а её документ остался в журнале. Пароли из деталей вырезались давно —
 * документ ничем не менее чувствителен.
 *
 * Границы: вырезать надо и на верхнем уровне, и во вложенных объектах (форма
 * шлёт правки вложенным `booking`/`data`), при этом не задев то, ради чего
 * журнал и ведут — имя и телефон, по которым администратор узнаёт запись.
 *
 * Проверяется дважды: сама функция и весь путь middleware до `auditLog.create`.
 * Второе нужно потому, что вырезание, до которого не дошёл вызов, ничего не
 * защищает.
 */

// sanitizeBody исторически не экспортируется — достаём её так же, как audit.test.js.
// try/catch: если функцию переименуют, тест упадёт осмысленно, а не «ReferenceError при загрузке».
const EXPOSE = 'try { module.exports.__test = { sanitizeBody } } catch { module.exports.__test = {} }'

function loadAudit(prisma = {}) {
  return loadCjs('src/middleware/audit.js', {
    append: EXPOSE,
    stubs: { '../utils/prisma': { prisma }, '../utils/logger': silentLogger },
  })
}

/** Экспортированная функция важнее вытащенной из недр модуля. */
function sanitizeOf(mod) {
  return mod.sanitizeBody || mod.__test?.sanitizeBody
}

const BODY = {
  guestName: 'Асель',
  guestPhone: '+7 701',
  guestDocNumber: 'N123',
  guestBirthDate: '1990-01-01',
  nested: { guestDocNumber: 'X' },
}

describe('sanitizeBody — документ гостя в детали не попадает', () => {
  it('номер документа и дата рождения вырезаются, имя и телефон остаются', () => {
    const clean = sanitizeOf(loadAudit())(BODY)
    expect(clean.guestName).toBe('Асель')
    expect(clean.guestPhone).toBe('+7 701')
    expect(clean).not.toHaveProperty('guestDocNumber')
    expect(clean).not.toHaveProperty('guestBirthDate')
  })

  it('вложенный объект тоже чистится — форма шлёт правки внутри booking', () => {
    const clean = sanitizeOf(loadAudit())(BODY)
    expect(clean.nested).not.toHaveProperty('guestDocNumber')
  })

  it('все шесть полей документа, а не только номер', () => {
    const clean = sanitizeOf(loadAudit())({
      roomId: 12,
      guestCitizenship: 'KZ', guestDocType: 'passport', guestDocNumber: 'N1',
      guestDocExpiry: '2030-01-01', guestBirthDate: '1990-01-01', guestSex: 'F',
    })
    expect(clean).toEqual({ roomId: 12 })
  })

  it('пароль по-прежнему вырезается на любой глубине', () => {
    const clean = sanitizeOf(loadAudit())({
      username: 'ivan', password: 'secret', nested: { newPassword: 'x', keep: 1 },
    })
    expect(clean).toEqual({ username: 'ivan', nested: { keep: 1 } })
  })

  it('тело из одного документа деталями не считается — пустой объект не пишем', () => {
    expect(sanitizeOf(loadAudit())({ guestDocNumber: 'N1' })).toBeUndefined()
  })

  it('деньги и брони в деталях сохраняются целиком — журнал нужен ради них', () => {
    const body = { bookingId: 151, amount: 40000, kind: 'payment', method: 'cash' }
    expect(sanitizeOf(loadAudit())(body)).toEqual(body)
  })
})

describe('auditMiddleware — что реально уходит в auditLog.create', () => {
  function run(body) {
    const create = vi.fn(() => Promise.resolve({ id: 1 }))
    const { auditMiddleware } = loadAudit({ auditLog: { create } })

    const finish = []
    const res = {
      statusCode: 200,
      on: (ev, fn) => { if (ev === 'finish') finish.push(fn) },
      json: (b) => b,
    }
    const req = {
      method: 'PUT',
      originalUrl: '/api/bookings/151',
      params: { id: '151' },
      body,
      admin: { id: 1, name: 'Главный администратор' },
      ip: '192.168.1.5',
    }

    auditMiddleware(req, res, () => {})
    res.json({ data: { id: 151 } })
    finish.forEach((fn) => fn())
    return create
  }

  it('запись в журнал есть, но документа гостя в ней нет ни на одном уровне', () => {
    const create = run(BODY)
    expect(create).toHaveBeenCalledTimes(1)
    const { details } = create.mock.calls[0][0].data
    expect(details.guestName).toBe('Асель')
    expect(details.guestPhone).toBe('+7 701')
    expect(details).not.toHaveProperty('guestDocNumber')
    expect(details).not.toHaveProperty('guestBirthDate')
    expect(details.nested).not.toHaveProperty('guestDocNumber')
    expect(JSON.stringify(details)).not.toContain('N123')
    expect(JSON.stringify(details)).not.toContain('1990-01-01')
  })

  it('сама запись при этом остаётся полноценной: кто, что и над каким объектом', () => {
    const create = run(BODY)
    expect(create.mock.calls[0][0].data).toMatchObject({
      adminId: 1, action: 'PUT /bookings/151', entity: 'bookings', entityId: 151,
    })
  })
})
