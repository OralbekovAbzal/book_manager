import { describe, it, expect, vi } from 'vitest'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'

/**
 * ПД в логах (D1-004): чего `safeUrl` НЕ закрывает.
 *
 * Волна закрыла строку запроса: `logger.info` в `app.js` и `errorHandler` пишут
 * путь и имена параметров без значений. Это правильная половина работы, но
 * половина: в те же два файла (`combined.log` и `error.log`, а в упаковке ещё и
 * `host-debug.log` через stdout) попадает ТЕКСТ ОШИБКИ. И вот он у Prisma
 * устроен так, что несёт в себе весь объект запроса целиком.
 *
 * Здесь проверяются обе стороны: что `safeUrl` действительно применён к
 * граничным строкам запроса — и что остаётся после него.
 */

const { safeUrl } = loadCjs('src/utils/logSafe.js')

describe('safeUrl — граничные строки запроса', () => {
  it('якорь в значении параметра уходит вместе со значением', () => {
    expect(safeUrl('/api/occupancy/grid?guestSearch=Асель#top')).toBe('/api/occupancy/grid?keys=guestSearch')
  })

  it('повторённый параметр остаётся повторённым — так видно, что клиент прислал два значения', () => {
    expect(safeUrl('/api/bookings?status=ACTIVE&status=CHECKED_IN')).toBe('/api/bookings?keys=status,status')
  })

  it('параметр без «=» — это фильтр, и его имя в логе нужно', () => {
    expect(safeUrl('/api/bookings?onlyDebts')).toBe('/api/bookings?keys=onlyDebts')
  })

  it('пустые пары от «&&» не превращаются в пустые имена', () => {
    expect(safeUrl('/api/bookings?from=2026-07-01&&to=2026-07-10')).toBe('/api/bookings?keys=from,to')
  })

  it('кириллица в пути сохраняется — путь это адрес, а не данные', () => {
    // Коды отчётов и названия у нас латиницей, но путь мы принципиально не режем:
    // «какой эндпоинт звали» — единственная диагностическая ценность строки.
    expect(safeUrl('/api/reports/выручка/run')).toBe('/api/reports/выручка/run')
  })

  it('процентное кодирование в значении не раскрывается обратно', () => {
    const out = safeUrl('/api/guests/lookup?phone=%2B77011234567')
    expect(out).toBe('/api/guests/lookup?keys=phone')
    expect(out).not.toContain('7701')
  })

  it('значение с «?» внутри (вложенный адрес) не даёт второй строки запроса', () => {
    expect(safeUrl('/api/system/backup?path=D:\\копии?x=1')).toBe('/api/system/backup?keys=path')
  })
})

// ————————————————————————————————————————————————————————————————
// errorHandler — что попадает в error.log вместе с ошибкой
// ————————————————————————————————————————————————————————————————

/** Текст настоящей ошибки Prisma 5, снятый с живой базы (booking.create без room). */
const PRISMA_VALIDATION_TEXT = `
Invalid \`prisma.booking.create()\` invocation in
C:\\hotel-booking\\server\\src\\controllers\\bookingController.js:461:38

  458 const booking = await tx.booking.create({
          data: {
            guestName: "Асель Каримова",
            guestPhone: "+77011234567",
            guestDocNumber: "N12345678",
            guestBirthDate: "1990-03-14",
            adultsWithMeals: "два",
          }
        })

Argument \`room\` is missing.`

function loadErrorHandler() {
  const lines = []
  const { errorHandler } = loadCjs('src/middleware/errorHandler.js', {
    stubs: {
      '../utils/logger': { ...silentLogger, error: (msg, meta) => lines.push({ msg, meta }) },
    },
  })
  return { errorHandler, lines }
}

function res() {
  return {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this },
    json(b) { this.body = b; return this },
  }
}

describe('errorHandler — строка запроса в error.log', () => {
  it('в лог уходит путь с именами параметров, а не поиск по имени гостя', () => {
    const { errorHandler, lines } = loadErrorHandler()
    const err = Object.assign(new Error('Некорректная дата'), { status: 400 })
    errorHandler(err, { method: 'GET', originalUrl: '/api/occupancy/grid?guestSearch=Асель&from=2026-07-01' }, res(), null)

    expect(lines).toHaveLength(1)
    expect(lines[0].msg).toBe('GET /api/occupancy/grid?keys=guestSearch,from — Некорректная дата')
    expect(lines[0].msg).not.toContain('Асель')
  })

  it('во вложенном роутере (originalUrl нет) берётся req.url — и тоже без значений', () => {
    const { errorHandler, lines } = loadErrorHandler()
    errorHandler(new Error('boom'), { method: 'POST', url: '/lookup?phone=%2B77011234567' }, res(), null)
    expect(lines[0].msg).toBe('POST /lookup?keys=phone — boom')
  })

  it('текст ошибки клиенту при 500 не раскрывается, а в лог пишется полностью', () => {
    const { errorHandler, lines } = loadErrorHandler()
    const r = res()
    errorHandler(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { method: 'GET', originalUrl: '/api/rooms' }, r, null)
    expect(r.statusCode).toBe(500)
    expect(r.body).toEqual({ error: 'Внутренняя ошибка сервера' })
    expect(lines[0].msg).toContain('ECONNREFUSED')
  })

  /**
   * НАХОДКА (D1-004, остаток). `safeUrl` закрыл строку запроса, но текст ошибки
   * Prisma несёт в себе весь объект `data` — с именем гостя, телефоном, номером
   * документа и датой рождения. Этот текст errorHandler кладёт в `error.log` и
   * `combined.log` (`logger.error`), а `utils/prisma.js` пишет его же через
   * `$on('error')`; в упаковке (`NODE_ENV=production`) уровень `error` проходит
   * и в консоль, то есть в `host-debug.log`.
   *
   * Вход, которым это вызывается на живой системе: любой запрос, где значение
   * не того типа, которого ждёт Prisma, — пустая строка вместо даты, строка
   * вместо числа взрослых, отсутствующая связь. Пользователь получает 400 и
   * ничего не замечает; паспорт гостя остаётся в трёх текстовых файлах, которые
   * целиком пересылают в поддержку.
   *
   * Чинить не здесь: нужно решение, что писать в лог вместо текста Prisma
   * (например, `err.name` + путь + `err.code`, а подробности — только в dev).
   */
  it('текст ошибки Prisma не должен уносить в лог документ и телефон гостя', () => {
    const { errorHandler, lines } = loadErrorHandler()
    const err = Object.assign(new Error(PRISMA_VALIDATION_TEXT), { name: 'PrismaClientValidationError' })
    const r = res()
    errorHandler(err, { method: 'POST', originalUrl: '/api/bookings' }, r, null)

    expect(r.statusCode).toBe(400)                       // клиенту — обезличенный текст
    const written = JSON.stringify(lines[0])
    for (const secret of ['N12345678', '+77011234567', 'Асель Каримова', '1990-03-14']) {
      expect(written).not.toContain(secret)
    }
  })

  it('клиенту при этом уходит обезличенный текст — утечка только в логе', () => {
    const { errorHandler } = loadErrorHandler()
    const err = Object.assign(new Error(PRISMA_VALIDATION_TEXT), { name: 'PrismaClientValidationError' })
    const r = res()
    errorHandler(err, { method: 'POST', originalUrl: '/api/bookings' }, r, null)
    expect(r.statusCode).toBe(400)
    expect(r.body).toEqual({ error: 'Некорректные данные в запросе' })
  })
})

// ————————————————————————————————————————————————————————————————
// Строка запроса в app.js — тот же safeUrl, но на живом middleware
// ————————————————————————————————————————————————————————————————

describe('журнал действий: путь запроса без строки поиска', () => {
  it('action в AuditLog — путь без query, даже когда правку прислали с фильтрами', () => {
    const writes = []
    const { auditMiddleware } = loadCjs('src/middleware/audit.js', {
      stubs: {
        '../utils/prisma': { prisma: { auditLog: { create: async (a) => { writes.push(a.data); return {} } } } },
        '../utils/logger': silentLogger,
      },
    })
    const listeners = {}
    const req = {
      method: 'PUT',
      originalUrl: '/api/bookings/12?guestSearch=Асель',
      params: { id: '12' },
      body: { guestName: 'Асель Каримова' },
      admin: { id: 1, name: 'Стойка' },
      ip: '192.168.1.5',
    }
    const response = { statusCode: 200, json: (b) => b, on: (ev, fn) => { listeners[ev] = fn } }
    auditMiddleware(req, response, () => {})
    listeners.finish()

    expect(writes).toHaveLength(1)
    expect(writes[0].action).toBe('PUT /bookings/12')
    expect(JSON.stringify(writes[0])).not.toContain('guestSearch')
  })
})
