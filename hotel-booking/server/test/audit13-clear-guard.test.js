/**
 * T13-001 (аудит 2026-09-13, 🔴): `scripts/clear.js` стирал рабочую базу без
 * единой проверки — брал DATABASE_URL из `server/.env`, не печатал имени базы,
 * не спрашивал подтверждения. Одна команда, набранная не в той папке, уносила
 * живые брони; восстановление — только из копии.
 *
 * Здесь проверяется сам предохранитель (чистые функции модуля) и то, что модуль
 * при подключении НИЧЕГО не стирает: `main()` запускается только при прямом
 * запуске файла.
 */
import { describe, it, expect } from 'vitest'
import { loadCjs } from './helpers/loadCjs.js'

const { dbNameFromUrl, isAllowed } = loadCjs('scripts/clear.js')

describe('T13-001 · имя базы из строки подключения', () => {
  it('обычная строка подключения', () => {
    expect(dbNameFromUrl('postgresql://u:p@localhost:5432/hotel_booking')).toBe('hotel_booking')
  })

  it('с параметрами после «?»', () => {
    expect(dbNameFromUrl('postgresql://u:p@localhost:5432/hotel_booking_demo?schema=public'))
      .toBe('hotel_booking_demo')
  })

  it('переменная не задана — пустая строка, а не «undefined»', () => {
    expect(dbNameFromUrl(undefined)).toBe('')
  })
})

describe('T13-001 · какие базы разрешено стирать', () => {
  it('рабочая база разработчика — нет', () => {
    expect(isAllowed('hotel_booking', '')).toBe(false)
  })

  it('демо, клон аудита и тестовая — да', () => {
    expect(isAllowed('hotel_booking_demo', '')).toBe(true)
    expect(isAllowed('hotel_booking_audit', '')).toBe(true)
    expect(isAllowed('hb_test', '')).toBe(true)
  })

  it('рабочую можно только назвав её полным именем: --allow-db=<имя>', () => {
    expect(isAllowed('hotel_booking', 'hotel_booking')).toBe(true)
    // «Почти то же имя» — это другая база
    expect(isAllowed('hotel_booking', 'hotel_bookin')).toBe(false)
    expect(isAllowed('hotel_booking', 'hotel_booking2')).toBe(false)
  })

  it('пустое имя базы не открывает дорогу пустым --allow-db=', () => {
    expect(isAllowed('', '')).toBe(false)
  })
})
