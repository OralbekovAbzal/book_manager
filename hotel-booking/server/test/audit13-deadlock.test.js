/**
 * Аудит 2026-09-13, живой стенд: S13-L1 и S13-L2 (см. `docs/audit-2026-09-13/05-live-stand.md`).
 *
 * S13-L1 — в гонке «два места бронируют один номер на одни даты» Postgres иногда
 * выбирает не отказ по ограничению (`23P01`), а взаимоблокировку (`40P01`): обе
 * транзакции ждут друг друга на `booking_no_overlap`. `errorHandler` этот случай не
 * узнавал, и стойка видела «Внутренняя ошибка сервера» вместо «Номер занят».
 *
 * S13-L2 — текст ошибки Prisma начинается с ПУСТОЙ строки, поэтому в журнале
 * оставалось `PrismaClientUnknownRequestError: ` без причины. Именно из-за этого
 * S13-L1 пришлось ловить отдельным диагностическим прогоном.
 *
 * Тексты ошибок ниже — настоящие, снятые со стенда (сокращённые).
 */
import { describe, it, expect } from 'vitest'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'

const { errorHandler } = loadCjs('src/middleware/errorHandler.js', {
  stubs: { '../utils/logger': silentLogger },
})
const { safeError } = loadCjs('src/utils/logSafe.js')

/** Мини-Express: что ответил errorHandler. */
function handle(err) {
  const out = { status: 200, body: null }
  const res = {
    status(code) { out.status = code; return res },
    json(payload) { out.body = payload; return res },
  }
  errorHandler(err, { method: 'POST', originalUrl: '/api/bookings' }, res, () => {})
  return out
}

/** Ошибка коннектора Prisma в том виде, в каком её видит `errorHandler`. */
function prismaUnknown(pgCode, pgMessage) {
  const err = new Error(
    '\nInvalid `prisma.booking.create()` invocation:\n\n\n'
    + 'Error occurred during query execution:\n'
    + 'ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError('
    + `PostgresError { code: "${pgCode}", message: "${pgMessage}", severity: "ERROR", `
    + 'detail: None, column: None, hint: None }), transient: false })',
  )
  err.name = 'PrismaClientUnknownRequestError'
  err.stack = `${err.name}: ${err.message}\n    at Cn.handleRequestError (/app/node_modules/@prisma/client/runtime/library.js:1:1)`
  return err
}

const OCCUPIED = 'Номер уже занят на выбранные даты (одновременное бронирование). Обновите сетку и попробуйте снова.'

describe('S13-L1 · взаимоблокировка при одновременной броне одного номера', () => {
  it('40P01 без кода Prisma — 409 «номер занят», а не 500', () => {
    const out = handle(prismaUnknown('40P01', 'deadlock detected'))
    expect(out.status).toBe(409)
    expect(out.body.error).toBe(OCCUPIED)
  })

  it('Prisma P2034 (write conflict / deadlock) — тот же 409', () => {
    const err = new Error('\nTransaction failed due to a write conflict or a deadlock. Please retry your transaction')
    err.name = 'PrismaClientKnownRequestError'
    err.code = 'P2034'
    const out = handle(err)
    expect(out.status).toBe(409)
    expect(out.body.error).toBe(OCCUPIED)
  })

  it('русский текст сервера («взаимоблокировка») тоже узнаётся', () => {
    const out = handle(prismaUnknown('40P01', 'обнаружена взаимоблокировка'))
    expect(out.status).toBe(409)
  })

  it('прежний случай — отказ по ограничению 23P01 — по-прежнему 409', () => {
    const out = handle(prismaUnknown('23P01', 'conflicting key value violates exclusion constraint "booking_no_overlap"'))
    expect(out.status).toBe(409)
    expect(out.body.error).toBe(OCCUPIED)
  })

  it('посторонняя ошибка базы остаётся 500 без текста наружу', () => {
    const out = handle(prismaUnknown('53300', 'sorry, too many clients already'))
    expect(out.status).toBe(500)
    expect(out.body.error).toBe('Внутренняя ошибка сервера')
  })
})

describe('S13-L2 · причина ошибки Prisma видна в журнале', () => {
  it('пустая первая строка больше не съедает сообщение', () => {
    const { message } = safeError(prismaUnknown('40P01', 'deadlock detected'))
    expect(message).toContain('Invalid `prisma.booking.create()` invocation:')
    expect(message).toContain('pg 40P01')
    expect(message).toContain('deadlock detected')
  })

  it('код Prisma остаётся в квадратных скобках, как раньше', () => {
    const err = new Error('\nTransaction failed due to a write conflict or a deadlock')
    err.name = 'PrismaClientKnownRequestError'
    err.code = 'P2034'
    const { message } = safeError(err)
    expect(message).toContain('[P2034]')
    expect(message).toContain('Transaction failed due to a write conflict')
  })

  it('данные гостя из ошибки валидации в лог не попадают', () => {
    // Настоящая форма PrismaClientValidationError: после первой строки идёт весь
    // объект `data` с ФИО, телефоном и номером документа.
    const err = new Error(
      '\nInvalid `prisma.booking.create()` invocation:\n\n{\n  data: {\n'
      + '    guestName: "Асель Нурлановна",\n    guestPhone: "+77011234567",\n'
      + '    guestDocNumber: "N01234567",\n    checkIn: "не дата"\n  }\n}\n\n'
      + 'Argument `checkIn`: Invalid value provided.',
    )
    err.name = 'PrismaClientValidationError'
    const { message } = safeError(err)
    expect(message).toBe('PrismaClientValidationError: Invalid `prisma.booking.create()` invocation:')
    expect(message).not.toContain('Асель')
    expect(message).not.toContain('77011234567')
    expect(message).not.toContain('N01234567')
  })

  it('`code` услуги из объекта data не выдаётся за код Postgres', () => {
    const err = new Error(
      '\nInvalid `prisma.bookingService.create()` invocation:\n\n{\n  data: {\n'
      + '    code: "brk01",\n    message: "Асель"\n  }\n}',
    )
    err.name = 'PrismaClientValidationError'
    const { message } = safeError(err)
    expect(message).not.toContain('pg brk01')
    expect(message).not.toContain('Асель')
  })

  it('обычная ошибка приложения не меняется', () => {
    const { message } = safeError(Object.assign(new Error('Бронь не найдена'), { status: 404 }))
    expect(message).toBe('Бронь не найдена')
  })
})
