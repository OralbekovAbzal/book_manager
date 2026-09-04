import { describe, it, expect } from 'vitest'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'

/**
 * Журнал действий: какие пути в него попадают, что уходит в детали и как
 * определяется номер объекта. Сам middleware в базу здесь не пишет —
 * проверяются его чистые функции.
 */
const EXPOSE = 'module.exports.__test = { isTracked, extractId, sanitizeBody };'

const { isTracked, extractId, sanitizeBody } = loadCjs('src/middleware/audit.js', {
  append: EXPOSE,
  stubs: { '../utils/prisma': { prisma: {} }, '../utils/logger': silentLogger },
}).__test

describe('isTracked — что попадает в журнал', () => {
  it('деньги журналируются: приём, возврат и отмена платежа', () => {
    expect(isTracked('POST', '/payments')).toBe(true)
    expect(isTracked('POST', '/payments/6/refund')).toBe(true)
    expect(isTracked('POST', '/payments/6/void')).toBe(true)
  })

  it('чтение кассы в журнал не идёт — утонет в рабочих запросах', () => {
    expect(isTracked('GET', '/payments')).toBe(false)
    expect(isTracked('GET', '/payments/shift/3/summary')).toBe(false)
  })

  it('похожий по началу путь не считается платежом', () => {
    expect(isTracked('POST', '/paymentsomething')).toBe(false)
  })

  it('брони журналируются, а проверка доступности — нет (ничего не меняет)', () => {
    expect(isTracked('POST', '/bookings')).toBe(true)
    expect(isTracked('POST', '/bookings/check-availability')).toBe(false)
  })

  it('запуск и выгрузка отчёта в журнал не идут, а правка определения — идёт', () => {
    expect(isTracked('POST', '/reports/5/run')).toBe(false)
    expect(isTracked('PUT', '/reports/5')).toBe(true)
  })
})

describe('extractId — номер объекта', () => {
  it('берётся из пути', () => {
    expect(extractId('/payments/6/void', {}, null)).toBe(6)
  })

  it('у созданной сущности — из ответа', () => {
    expect(extractId('/rooms', {}, { data: { id: 12 } })).toBe(12)
  })

  it('ответ со сводкой: сущность лежит уровнем глубже — POST /payments', () => {
    const body = { data: { payment: { id: 6, amount: 1 }, summary: { total: 100 } } }
    expect(extractId('/payments', {}, body)).toBe(6)
  })

  it('номера нет — null, а не выдуманное значение', () => {
    expect(extractId('/payments', {}, { data: { summary: { total: 100 } } })).toBeNull()
  })
})

describe('sanitizeBody — что уходит в детали', () => {
  it('пароли вырезаются на любой глубине', () => {
    const clean = sanitizeBody({ username: 'ivan', password: 'secret', nested: { newPassword: 'x', keep: 1 } })
    expect(clean).toEqual({ username: 'ivan', nested: { keep: 1 } })
  })

  it('поля платежа сохраняются как есть — секретов в них нет', () => {
    const body = { bookingId: 151, amount: 1, kind: 'payment', method: 'cash', comment: 'наличные' }
    expect(sanitizeBody(body)).toEqual(body)
  })

  it('пустое тело деталями не считается', () => {
    expect(sanitizeBody({})).toBeUndefined()
  })
})
